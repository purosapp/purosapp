// Build & run (from the repo root):
//   xcrun clang++ -std=c++17 -O2 -mmacosx-version-min=12.0 native/src/DsdDecimator.cpp native/src/DsdModulator.cpp \
//     native/src/DsdDecimator.test.cpp -framework Accelerate -o /tmp/dsd-decimator-test && /tmp/dsd-decimator-test
#include "DsdDecimator.h"
#include "DsdModulator.h"

#include <Accelerate/Accelerate.h>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kModulatorRate = 352800.0;

double besselI0(double x) {
    double sum = 1.0, term = 1.0;
    for (int k = 1; k < 300; ++k) {
        term *= (x / (2.0 * k)) * (x / (2.0 * k));
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

struct DsdStream {
    std::vector<uint8_t> left;
    std::vector<uint8_t> right;
};

// Stereo DSD (oldest bit in the MSB) carrying `amplitude`·sin at `freq` (PCM full scale = 50 % modulation).
DsdStream encodeSine(uint32_t dsdRate, double freq, double amplitude, double seconds) {
    const size_t frames = static_cast<size_t>(kModulatorRate * seconds);
    std::vector<double> pcm(frames * 2);
    for (size_t i = 0; i < frames; ++i) {
        pcm[i * 2] = amplitude * std::sin(2.0 * kPi * freq * static_cast<double>(i) / kModulatorRate);
        pcm[i * 2 + 1] = -pcm[i * 2];
    }
    DsdEncoder encoder;
    std::string error;
    const bool ok = encoder.configure(dsdRate, ModulatorType::Order7, 2, error);
    assert(ok);
    std::vector<uint8_t> dop;
    encoder.encode(pcm.data(), frames, dop);
    DsdStream stream;
    // DoP frame: 2 × LE32 words, the older DSD byte in bits 15…8.
    for (size_t f = 0; f + 8 <= dop.size(); f += 8) {
        stream.left.push_back(dop[f + 2]);
        stream.left.push_back(dop[f + 1]);
        stream.right.push_back(dop[f + 6]);
        stream.right.push_back(dop[f + 5]);
    }
    return stream;
}

std::vector<double> decode(const DsdStream& stream, uint32_t dsdRate, uint32_t pcmRate, double filterHz,
                           double gainDb, bool randomBlocks) {
    DsdDecimator decimator;
    std::string error;
    const bool ok = decimator.configure(dsdRate, pcmRate, filterHz, gainDb, 2, error);
    assert(ok);
    std::vector<double> out;
    size_t block = 4096;
    for (size_t pos = 0; pos < stream.left.size();) {
        if (randomBlocks) block = 1 + (pos * 7919) % 5000;
        const size_t count = std::min(block, stream.left.size() - pos);
        const uint8_t* bytes[2] = {stream.left.data() + pos, stream.right.data() + pos};
        decimator.process(bytes, count, out);
        pos += count;
    }
    decimator.flush(out);
    return out;
}

struct Measurement {
    double amplitude;   // of the tone at `freq`
    double snrDb;       // tone vs everything else in 20 Hz … 20 kHz
    double spurDb;      // strongest other bin in 20 Hz … 20 kHz, relative to full scale
};

Measurement measure(const std::vector<double>& pcm, double rate, double freq, size_t channel = 0) {
    const size_t skip = static_cast<size_t>(rate * 0.05);   // past the modulator's start-up
    size_t log2n = 16;
    while ((size_t{1} << log2n) + skip > pcm.size() / 2) --log2n;
    assert(log2n >= 14);
    const size_t n = size_t{1} << log2n;
    std::vector<double> re(n), im(n, 0.0);
    double windowSum = 0, windowSquares = 0;
    for (size_t i = 0; i < n; ++i) {
        const double r = (2.0 * i) / (n - 1) - 1.0;
        const double w = besselI0(20.0 * std::sqrt(std::max(0.0, 1.0 - r * r))) / besselI0(20.0);
        re[i] = pcm[(i + skip) * 2 + channel] * w;
        windowSum += w;
        windowSquares += w * w;
    }
    FFTSetupD setup = vDSP_create_fftsetupD(log2n, kFFTRadix2);
    DSPDoubleSplitComplex split{re.data(), im.data()};
    vDSP_fft_zipD(setup, &split, 1, log2n, kFFTDirection_Forward);
    vDSP_destroy_fftsetupD(setup);
    const double binHz = rate / n;
    const size_t signalBin = static_cast<size_t>(std::llround(freq / binHz));
    double signal = 0, noise = 0, spur = 0;
    for (size_t k = static_cast<size_t>(20 / binHz); k <= static_cast<size_t>(20000 / binHz); ++k) {
        const double p = re[k] * re[k] + im[k] * im[k];
        if (k + 12 >= signalBin && k <= signalBin + 12) {
            signal += p;
        } else {
            noise += p;
            spur = std::max(spur, p);
        }
    }
    const double amplitude = std::sqrt(4.0 * signal / (static_cast<double>(n) * windowSquares));
    // A full-scale sine peaks at (n/2 · Σw / n)² in one bin.
    const double fullScaleBin = (windowSum / 2.0) * (windowSum / 2.0);
    return {amplitude, 10.0 * std::log10(signal / noise), 10.0 * std::log10(spur / fullScaleBin)};
}

}  // namespace

int main() {
    // Rate selection: dsdRate / 2^k at or above the request, at most dsdRate / 8.
    assert(DsdDecimator::decodeRate(2822400, 176400) == 176400);
    assert(DsdDecimator::decodeRate(2822400, 48000) == 88200);
    assert(DsdDecimator::decodeRate(2822400, 384000) == 352800);
    assert(DsdDecimator::decodeRate(11289600, 352800) == 352800);
    assert(DsdDecimator::decodeRate(11289600, 44100) == 44100);
    assert(DsdDecimator::decodeRate(22579200, 96000) == 176400);
    assert(DsdDecimator::decodeRate(3072000, 96000) == 96000);
    assert(DsdDecimator::decodeRate(0, 96000) == 0);

    // Level, in-band SNR and exact length for every DSD rate / PCM rate pair.
    for (uint32_t dsdRate : {2822400u, 5644800u, 11289600u}) {
        const DsdStream stream = encodeSine(dsdRate, 1000.0, 0.5, 0.5);   // 25 % modulation
        for (uint32_t pcmRate : {88200u, 176400u, 352800u}) {
            const auto pcm = decode(stream, dsdRate, pcmRate, 0, 0, false);
            const uint64_t expected = stream.left.size() * 8 / (dsdRate / pcmRate);
            assert(pcm.size() == expected * 2);
            const Measurement m = measure(pcm, pcmRate, 1000.0);
            const Measurement r = measure(pcm, pcmRate, 1000.0, 1);
            std::printf("DSD%u → %.1f kHz: level %.4f, SNR %.1f dB\n", dsdRate / 44100, pcmRate / 1000.0, m.amplitude, m.snrDb);
            assert(std::abs(m.amplitude - 0.25) < 0.0025);
            assert(std::abs(r.amplitude - 0.25) < 0.0025);
            assert(m.snrDb > 110);
        }
    }

    // Block size does not change the result; gain is applied.
    {
        const DsdStream stream = encodeSine(2822400, 3000.0, 0.5, 0.3);
        const auto whole = decode(stream, 2822400, 176400, 0, 0, false);
        const auto chunked = decode(stream, 2822400, 176400, 0, 0, true);
        assert(whole.size() == chunked.size());
        for (size_t i = 0; i < whole.size(); ++i) assert(std::abs(whole[i] - chunked[i]) < 1e-12);
        const auto louder = decode(stream, 2822400, 176400, 0, 6, false);
        assert(std::abs(louder[20000] / whole[20000] - std::pow(10.0, 0.3)) < 1e-9);
    }

    // Time alignment: a DSD step (full negative → full positive) lands at its own time after decimation.
    {
        DsdStream stream;
        stream.left.assign(8192, 0x00);           // −1 …
        stream.left.resize(16384, 0xFF);           // … +1 from byte 8192 on
        stream.right = stream.left;
        for (uint32_t pcmRate : {88200u, 176400u, 352800u}) {
            const auto pcm = decode(stream, 2822400, pcmRate, 0, 0, false);
            // The edge sits between the last −1 bit and the first +1 bit.
            const double stepFrame = (8192.0 * 8.0 - 0.5) / (2822400.0 / pcmRate);
            // Linear-phase filters cross half the step height (0) at the step (interpolated crossing).
            double crossing = 0;
            for (size_t f = 1; f < pcm.size() / 2; ++f) {
                if (f > 100 && pcm[f * 2] > 0.0) {
                    const double a = pcm[(f - 1) * 2], b = pcm[f * 2];
                    crossing = static_cast<double>(f - 1) + (0.0 - a) / (b - a);
                    break;
                }
            }
            std::printf("step at %.3f, half height at frame %.3f (%.1f kHz)\n", stepFrame, crossing, pcmRate / 1000.0);
            assert(std::abs(crossing - stepFrame) < 0.05);
        }
    }

    // Anti-aliasing: a 70 kHz tone must not fold into the audio band at 88.2 kHz.
    {
        const DsdStream stream = encodeSine(2822400, 70000.0, 0.5, 0.5);
        const auto pcm = decode(stream, 2822400, 88200, 0, 0, false);
        const Measurement m = measure(pcm, 88200, 18200.0);
        std::printf("70 kHz tone → 88.2 kHz: alias at 18.2 kHz %.1f dBFS\n", 20.0 * std::log10(std::max(m.amplitude, 1e-12)));
        assert(m.amplitude < 1e-5);   // < −100 dBFS (the modulator's own noise sits around there)
    }

    // Ultrasonic filter: passes 10 kHz, removes a 40 kHz tone at 176.4 kHz.
    {
        const DsdStream low = encodeSine(2822400, 10000.0, 0.5, 0.4);
        const DsdStream high = encodeSine(2822400, 40000.0, 0.5, 0.4);
        DsdDecimator check;
        std::string error;
        assert(check.configure(2822400, 176400, 30000, 0, 2, error) && check.filterHz() == 30000);
        const auto passed = decode(low, 2822400, 176400, 30000, 0, false);
        const auto stopped = decode(high, 2822400, 176400, 30000, 0, false);
        const double passLevel = measure(passed, 176400, 10000.0).amplitude;
        double stopPeak = 0;
        // Away from both ends: the stream starts and stops abruptly mid-sine.
        for (size_t f = 20000; f + 20000 < stopped.size() / 2; ++f) stopPeak = std::max(stopPeak, std::abs(stopped[f * 2]));
        std::printf("30 kHz filter: 10 kHz level %.4f, 40 kHz residual %.1f dBFS\n", passLevel, 20.0 * std::log10(stopPeak));
        assert(std::abs(passLevel - 0.25) < 0.0025);
        assert(stopPeak < 1e-4);
    }

    // Speed: worst cases (long first stage, many stages).
    struct Case { uint32_t dsdRate, pcmRate; double filterHz; };
    for (const Case c : {Case{2822400, 352800, 0}, Case{2822400, 352800, 20000}, Case{11289600, 352800, 0},
                         Case{22579200, 88200, 0}}) {
        const size_t bytes = static_cast<size_t>(c.dsdRate / 8 * 2.0);   // 2 s
        DsdStream stream;
        stream.left.resize(bytes);
        uint64_t seed = 99;
        for (uint8_t& b : stream.left) {
            seed = seed * 6364136223846793005ull + 1442695040888963407ull;
            b = static_cast<uint8_t>(seed >> 56);
        }
        stream.right = stream.left;
        const auto t0 = std::chrono::steady_clock::now();
        const auto pcm = decode(stream, c.dsdRate, c.pcmRate, c.filterHz, 0, false);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        DsdDecimator info;
        std::string error;
        info.configure(c.dsdRate, c.pcmRate, c.filterHz, 0, 2, error);
        std::printf("DSD%u → %.1f kHz%s: %u stages, 2 s stereo in %.0f ms (%.0fx real time)\n", c.dsdRate / 44100,
                    c.pcmRate / 1000.0, c.filterHz > 0 ? " + 20 kHz filter" : "", info.stageCount(), ms, 2000.0 / ms);
        assert(!pcm.empty());
        assert(ms < 2000.0 / 4.0);
    }

    std::puts("DSD decimator tests passed");
    return 0;
}
