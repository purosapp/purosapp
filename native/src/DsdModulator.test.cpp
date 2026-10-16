// Build & run (from the repo root):
//   xcrun clang++ -std=c++17 -O2 -mmacosx-version-min=12.0 native/src/DsdModulator.cpp native/src/DsdModulator.test.cpp \
//     -framework Accelerate -framework AudioToolbox -o /tmp/dsd-test && /tmp/dsd-test
#include "DsdModulator.h"

#include <Accelerate/Accelerate.h>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<double> sinePcm(double rate, double freq, size_t frames, double amplitude) {
    std::vector<double> pcm(frames * 2);
    for (size_t i = 0; i < frames; ++i) {
        const double v = amplitude * std::sin(2.0 * kPi * freq * static_cast<double>(i) / rate);
        pcm[i * 2] = pcm[i * 2 + 1] = v;
    }
    return pcm;
}

// Left-channel bits (±1) from DoP frames; checks the marker alternation.
std::vector<double> unpackLeft(const std::vector<uint8_t>& dop, bool& markersOk) {
    std::vector<double> bits;
    markersOk = true;
    uint8_t expected = 0x05;
    for (size_t f = 0; f + 8 <= dop.size(); f += 8) {
        if (dop[f + 3] != expected || dop[f + 7] != expected || dop[f] != 0 || dop[f + 4] != 0) markersOk = false;
        expected = expected == 0x05 ? 0xFA : 0x05;
        for (uint8_t byte : {dop[f + 2], dop[f + 1]}) {
            for (int b = 7; b >= 0; --b) bits.push_back(((byte >> b) & 1) ? 1.0 : -1.0);
        }
    }
    return bits;
}

double besselI0(double x) {
    double sum = 1.0, term = 1.0;
    for (int k = 1; k < 300; ++k) {
        term *= (x / (2.0 * k)) * (x / (2.0 * k));
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

// In-band SNR (dB) of a 1-bit stream carrying a sine at `freq`.
struct Spectrum { double snrDb; double amplitude; };
Spectrum measure(const std::vector<double>& bits, double rate, double freq) {
    const size_t log2n = 20, n = size_t{1} << log2n;
    assert(bits.size() >= n + 65536);
    std::vector<double> re(n), im(n, 0.0);
    double windowSquares = 0;
    for (size_t i = 0; i < n; ++i) {
        const double r = (2.0 * i) / (n - 1) - 1.0;
        const double w = besselI0(20.0 * std::sqrt(std::max(0.0, 1.0 - r * r))) / besselI0(20.0);
        re[i] = bits[i + 65536] * w;      // skip the start-up transient
        windowSquares += w * w;
    }
    FFTSetupD setup = vDSP_create_fftsetupD(log2n, kFFTRadix2);
    DSPDoubleSplitComplex split{re.data(), im.data()};
    vDSP_fft_zipD(setup, &split, 1, log2n, kFFTDirection_Forward);
    vDSP_destroy_fftsetupD(setup);
    const double binHz = rate / n;
    const size_t signalBin = static_cast<size_t>(std::llround(freq / binHz));
    double signal = 0, noise = 0;
    for (size_t k = static_cast<size_t>(20 / binHz); k <= static_cast<size_t>(20000 / binHz); ++k) {
        const double p = re[k] * re[k] + im[k] * im[k];
        if (k + 12 >= signalBin && k <= signalBin + 12) signal += p; else noise += p;
    }
    // Parseval: one-sided energy of A·sin is n·A²/4·Σw².
    return {10.0 * std::log10(signal / noise), std::sqrt(4.0 * signal / (static_cast<double>(n) * windowSquares))};
}

std::vector<uint8_t> encodeAll(ModulatorType type, uint32_t dsdRate, const std::vector<double>& pcm, DsdEncoderStats& stats) {
    DsdEncoder encoder;
    std::string error;
    const bool ok = encoder.configure(dsdRate, type, 2, error);
    assert(ok);
    std::vector<uint8_t> dop;
    const size_t frames = pcm.size() / 2;
    for (size_t pos = 0; pos < frames;) {
        const size_t block = std::min<size_t>(frames - pos, 4096 + pos % 333);
        encoder.encode(pcm.data() + pos * 2, block, dop);
        pos += block;
    }
    stats = encoder.takeStats();
    return dop;
}

}  // namespace

int main() {
    // NTF design: target ‖NTF‖∞ met; deep in-band suppression.
    for (unsigned order : {5u, 7u}) {
        for (double rate : {2822400.0, 11289600.0}) {
            const NoiseTransferFunction ntf = designNtf(order, rate, 20000.0, 1.5);
            assert(ntf.b.size() == order + 1 && ntf.a.size() == order + 1);
            assert(ntf.b[0] == 1.0 && ntf.a[0] == 1.0);
            assert(std::abs(ntf.hInf - 1.5) < 0.01);
            std::printf("NTF order %u @%.1f MHz: %.1f dB at 10 kHz, %.1f dB at 20 kHz, %.1f dB at 100 kHz\n", order, rate / 1e6,
                        ntfMagnitudeDb(ntf, 10000, rate), ntfMagnitudeDb(ntf, 20000, rate), ntfMagnitudeDb(ntf, 100000, rate));
            assert(ntfMagnitudeDb(ntf, 10000, rate) < -70);
        }
    }

    // In-band SNR at −6 dBFS, DoP framing, recovered level (PCM −6 dBFS → 25 % modulation).
    const double rate = 352800.0;
    const auto pcm = sinePcm(rate, 1000.0, static_cast<size_t>(rate * 0.5), 0.5);
    for (ModulatorType type : {ModulatorType::Order5, ModulatorType::Order7, ModulatorType::Order7EC}) {
        DsdEncoderStats stats;
        const auto dop = encodeAll(type, 2822400, pcm, stats);
        bool markersOk = false;
        const auto bits = unpackLeft(dop, markersOk);
        assert(markersOk);
        assert(std::abs(static_cast<double>(dop.size() / 8) - pcm.size() / 2 * 8 / 16.0) <= 1);
        const Spectrum s = measure(bits, 2822400.0, 1000.0);
        std::printf("modulator %d DSD64: SNR %.1f dB (20 Hz–20 kHz), level %.4f, overloads %llu\n",
                    static_cast<int>(type), s.snrDb, s.amplitude, static_cast<unsigned long long>(stats.overloads));
        assert(stats.overloads == 0);
        assert(std::abs(s.amplitude - 0.25) < 0.01);
        assert(s.snrDb > (type == ModulatorType::Order5 ? 105 : 125));
    }

    // Full-scale PCM (50 % modulation): stays stable; a hot +3.5 dB input is caught by the guard.
    for (ModulatorType type : {ModulatorType::Order5, ModulatorType::Order7, ModulatorType::Order7EC}) {
        DsdEncoderStats full, hot;
        encodeAll(type, 2822400, sinePcm(rate, 1000.0, static_cast<size_t>(rate * 0.25), 1.0), full);
        const auto dop = encodeAll(type, 2822400, sinePcm(rate, 1000.0, static_cast<size_t>(rate * 0.25), 1.5), hot);
        std::printf("modulator %d: 0 dBFS overloads %llu (handovers %llu), +3.5 dBFS overloads %llu\n", static_cast<int>(type),
                    static_cast<unsigned long long>(full.overloads), static_cast<unsigned long long>(full.handovers),
                    static_cast<unsigned long long>(hot.overloads));
        assert(full.overloads == 0);
        assert(!dop.empty());
    }

    // Music-like material (broadband noise, tones, transients) peaking at 0 dBFS:
    // a plain sine does not stress the loops (or EC hand-overs) like real music does.
    {
        std::vector<double> music(static_cast<size_t>(rate * 1.0) * 2);
        uint64_t seed = 12345;
        double lowpassed = 0.0, peak = 0.0;
        for (size_t i = 0; i < music.size() / 2; ++i) {
            seed = seed * 6364136223846793005ull + 1442695040888963407ull;
            const double white = static_cast<double>(seed >> 11) / 9007199254740992.0 * 2.0 - 1.0;
            lowpassed += 0.2 * (white - lowpassed);                  // ~11 kHz roll-off
            const double t = static_cast<double>(i) / rate;
            const double burst = (i % 35280) < 1500 ? 2.5 : 1.0;    // 10 transients / s
            const double v = burst * (0.5 * lowpassed + 0.25 * std::sin(2 * kPi * 440 * t) + 0.15 * std::sin(2 * kPi * 9300 * t));
            music[i * 2] = v;
            music[i * 2 + 1] = -v;
            peak = std::max(peak, std::abs(v));
        }
        for (double& v : music) v /= peak;                           // 0 dBFS peaks
        for (ModulatorType type : {ModulatorType::Order5, ModulatorType::Order7, ModulatorType::Order7EC}) {
            for (uint32_t dsdRate : {2822400u, 5644800u}) {
                DsdEncoderStats stats;
                encodeAll(type, dsdRate, music, stats);
                std::printf("music-like, modulator %d DSD%u: overloads %llu, handovers %llu\n", static_cast<int>(type),
                            dsdRate / 44100, static_cast<unsigned long long>(stats.overloads),
                            static_cast<unsigned long long>(stats.handovers));
                assert(stats.overloads == 0);
            }
        }
    }

    // DSD128 / DSD256 rates and real-time headroom.
    for (uint32_t dsdRate : {5644800u, 11289600u}) {
        const auto input = sinePcm(rate, 1000.0, static_cast<size_t>(rate * 2.0), 0.5);
        const auto t0 = std::chrono::steady_clock::now();
        DsdEncoderStats stats;
        const auto dop = encodeAll(ModulatorType::Order7, dsdRate, input, stats);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        std::printf("DSD%u: 2 s of stereo audio in %.0f ms (%.1fx real time)\n", dsdRate / 44100, ms, 2000.0 / ms);
        assert(dop.size() / 8 == input.size() / 2 * (dsdRate / 352800) / 16);
        assert(ms < 2000.0 / 1.5);
        if (dsdRate == 11289600) {
            bool markersOk = false;
            const auto bits = unpackLeft(dop, markersOk);
            const Spectrum s = measure(bits, 11289600.0, 1000.0);
            std::printf("DSD256 order 7: SNR %.1f dB\n", s.snrDb);
            assert(markersOk && s.snrDb > 110);
        }
    }

    std::puts("DSD modulator tests passed");
    return 0;
}
