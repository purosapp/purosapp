// Build & run (from the repo root, after `node scripts/build-soxr.mjs --install=build/audio/soxr`):
//   xcrun clang++ -std=c++17 -O2 -mmacosx-version-min=12.0 -Ibuild/audio/soxr/include native/src/FirFilter.cpp \
//     native/src/FirFilter.test.cpp build/audio/soxr/lib/libsoxr.0.dylib -Wl,-rpath,build/audio/soxr/lib \
//     -framework Accelerate -framework AudioToolbox -framework CoreFoundation -o /tmp/fir-test && /tmp/fir-test
#include "FirFilter.h"

#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<double> sine(double rate, double freq, size_t frames, uint32_t channels, double amplitude) {
    std::vector<double> out(frames * channels);
    for (size_t i = 0; i < frames; ++i) {
        const double v = amplitude * std::sin(2.0 * kPi * freq * static_cast<double>(i) / rate);
        for (uint32_t ch = 0; ch < channels; ++ch) out[i * channels + ch] = v;
    }
    return out;
}

double maxSineError(const std::vector<double>& out, double rate, double freq, uint32_t channels, double amplitude) {
    const size_t frames = out.size() / channels;
    double worst = 0;
    for (size_t i = frames / 5; i < frames - frames / 5; ++i) {
        const double ideal = amplitude * std::sin(2.0 * kPi * freq * static_cast<double>(i) / rate);
        worst = std::max(worst, std::abs(out[i * channels] - ideal));
    }
    return worst;
}

std::vector<double> resampleAll(const FirDesign& design, double in, double out, const std::vector<double>& input,
                                uint32_t channels) {
    FirResampler resampler;
    std::string error;
    const bool ok = resampler.configure(design, in, out, channels, error);
    if (!ok) std::printf("configure failed: %s\n", error.c_str());
    assert(ok);
    std::vector<double> result;
    const size_t frames = input.size() / channels;
    for (size_t pos = 0; pos < frames;) {
        const size_t block = std::min<size_t>(frames - pos, 3000 + pos % 1111);
        resampler.process(input.data() + pos * channels, block, result);
        pos += block;
    }
    resampler.flush(result);
    return result;
}

double dtftDb(const std::vector<double>& h, double omega) {
    double re = 0, im = 0;
    for (size_t n = 0; n < h.size(); ++n) {
        re += h[n] * std::cos(omega * static_cast<double>(n));
        im -= h[n] * std::sin(omega * static_cast<double>(n));
    }
    return 20.0 * std::log10(std::max(std::hypot(re, im), 1e-300));
}

void writeWav(const char* path, const std::vector<int16_t>& samples, uint32_t channels, uint32_t rate) {
    FILE* f = std::fopen(path, "wb");
    const uint32_t dataBytes = static_cast<uint32_t>(samples.size() * 2);
    const uint32_t riff = 36 + dataBytes, fmtSize = 16, byteRate = rate * channels * 2;
    const uint16_t pcm = 1, ch = static_cast<uint16_t>(channels), align = static_cast<uint16_t>(channels * 2), bits = 16;
    std::fwrite("RIFF", 1, 4, f); std::fwrite(&riff, 4, 1, f); std::fwrite("WAVEfmt ", 1, 8, f);
    std::fwrite(&fmtSize, 4, 1, f); std::fwrite(&pcm, 2, 1, f); std::fwrite(&ch, 2, 1, f);
    std::fwrite(&rate, 4, 1, f); std::fwrite(&byteRate, 4, 1, f); std::fwrite(&align, 2, 1, f);
    std::fwrite(&bits, 2, 1, f); std::fwrite("data", 1, 4, f); std::fwrite(&dataBytes, 4, 1, f);
    std::fwrite(samples.data(), 2, samples.size(), f);
    std::fclose(f);
}

}  // namespace

int main() {
    std::mt19937 rng(7);
    std::uniform_real_distribution<double> uniform(-1.0, 1.0);

    // FFT convolution equals direct convolution, per channel, across block boundaries.
    for (size_t taps : {size_t{1}, size_t{7}, size_t{513}, size_t{5000}}) {
        std::vector<double> left(taps), right(taps);
        for (auto& v : left) v = uniform(rng);
        for (auto& v : right) v = uniform(rng);
        FftConvolver convolver;
        std::string error;
        assert(convolver.configure({makeKernelSpectrum(left), makeKernelSpectrum(right)}, 2, error));
        const size_t frames = 20000;
        std::vector<double> input(frames * 2);
        for (auto& v : input) v = uniform(rng);
        std::vector<double> output;
        for (size_t pos = 0; pos < frames;) {
            const size_t block = std::min<size_t>(frames - pos, 777);
            convolver.process(input.data() + pos * 2, block, output);
            pos += block;
        }
        convolver.flushTo(frames, output);
        assert(output.size() == frames * 2);
        double worst = 0;
        for (size_t n = 0; n < frames; n += 13) {
            for (uint32_t ch = 0; ch < 2; ++ch) {
                const auto& kernel = ch == 0 ? left : right;
                double expected = 0;
                for (size_t k = 0; k < taps && k <= n; ++k) expected += kernel[k] * input[(n - k) * 2 + ch];
                worst = std::max(worst, std::abs(expected - output[n * 2 + ch]));
            }
        }
        std::printf("convolution %zu taps: max error %.2e\n", taps, worst);
        assert(worst < 1e-9);
    }

    // Designs: unity DC, the window's floor at the lower Nyquist when apodizing.
    for (FirWindow window : {FirWindow::Kaiser, FirWindow::BlackmanHarris, FirWindow::Gauss}) {
        FirDesign design;
        design.window = window;
        design.tapsPerPhase = 512;
        const auto h = designFirLowpass(design, 4);
        double dc = 0;
        for (double v : *h) dc += v;
        assert(std::abs(dc - 1.0) < 1e-12);
        assert(h->size() == 4 * 512 + 1);
        const double atNyquist = dtftDb(*h, kPi / 4);
        const double passband = dtftDb(*h, kPi / 4 * 0.5);
        std::printf("window %d: %.1f dB at Nyquist, %.4f dB at half band\n", static_cast<int>(window), atNyquist, passband);
        assert(atNyquist < -85);
        assert(std::abs(passband) < 0.01);
    }

    // Half-band (non-apodizing) cutoff: −6 dB at Nyquist.
    {
        FirDesign design;
        design.apodizing = false;
        design.tapsPerPhase = 2048;
        const auto h = designFirLowpass(design, 2);
        assert(std::abs(dtftDb(*h, kPi / 2) + 6.02) < 0.1);
    }

    // ×2, ×4 (and ÷4): exact length, time-aligned, tiny error in the passband.
    {
        FirDesign design;
        design.tapsPerPhase = 4096;
        const auto in = sine(44100, 1000, 44100, 2, 0.5);
        const auto up2 = resampleAll(design, 44100, 88200, in, 2);
        assert(up2.size() == 88200 * 2);
        const double e2 = maxSineError(up2, 88200, 1000, 2, 0.5);
        const auto up4 = resampleAll(design, 44100, 176400, in, 2);
        assert(up4.size() == 176400 * 2);
        const double e4 = maxSineError(up4, 176400, 1000, 2, 0.5);
        const auto in192 = sine(192000, 1000, 192000, 2, 0.5);
        const auto down4 = resampleAll(design, 192000, 48000, in192, 2);
        assert(down4.size() == 48000 * 2);
        const double ed = maxSineError(down4, 48000, 1000, 2, 0.5);
        std::printf("x2 error %.2e, x4 error %.2e, /4 error %.2e\n", e2, e4, ed);
        assert(e2 < 1e-6 && e4 < 1e-6 && ed < 1e-6);
    }

    // Minimum phase: same magnitude, energy at the start (no pre-ringing).
    {
        FirDesign linear;
        linear.tapsPerPhase = 1024;
        FirDesign minimum = linear;
        minimum.minimumPhase = true;
        const auto hl = designFirLowpass(linear, 4);
        const auto hm = designFirLowpass(minimum, 4);
        for (double fraction : {0.1, 0.5, 0.9, 0.99}) {
            const double w = kPi / 4 * fraction;
            assert(std::abs(dtftDb(*hl, w) - dtftDb(*hm, w)) < 0.01);
        }
        size_t peak = 0;
        for (size_t n = 1; n < hm->size(); ++n) if (std::abs((*hm)[n]) > std::abs((*hm)[peak])) peak = n;
        std::printf("minimum phase peak at sample %zu of %zu\n", peak, hm->size());
        assert(peak < hm->size() / 50);
        // Minimum-phase output is causal: no group-delay trim, still exact length.
        const auto in = sine(44100, 1000, 22050, 2, 0.5);
        const auto out = resampleAll(minimum, 44100, 176400, in, 2);
        assert(out.size() == 88200 * 2);
    }

    // Analysis for the UI preview.
    {
        FirDesign design;
        design.tapsPerPhase = 8192;
        FirResponse response;
        std::string error;
        assert(analyzeFirDesign(design, 44100, 352800, response, error));
        std::printf("preview: %zu taps, %.1f ms, flat to %.0f Hz, -3 dB at %.0f Hz, %.1f dB at Nyquist, pre-ringing %.2f ms\n",
                    response.taps, response.lengthMs, response.passbandEdgeHz, response.minus3DbHz,
                    response.attenuationAtNyquistDb, response.preRingingMs);
        assert(response.taps == 8 * 8192 + 1);
        assert(response.passbandEdgeHz > 20000 && response.passbandEdgeHz < 22050);
        assert(response.attenuationAtNyquistDb < -140);
        assert(response.frequencies.size() == response.magnitudeDb.size());
    }

    // ~1M taps (65536 per phase × 16): designs once, then runs well above real time.
    {
        FirDesign design;
        design.tapsPerPhase = 65536;
        auto t0 = std::chrono::steady_clock::now();
        const auto h = designFirLowpass(design, 16);
        const double designMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        const auto in = sine(44100, 1000, 44100 * 10, 2, 0.5);
        t0 = std::chrono::steady_clock::now();
        const auto out = resampleAll(design, 44100, 705600, in, 2);
        const double runMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        std::printf("extreme x16: %zu taps, design %.0f ms, 10 s of audio in %.0f ms (%.0fx real time)\n",
                    h->size(), designMs, runMs, 10000.0 / runMs);
        assert(out.size() == 705600 * 10 * 2);
        assert(maxSineError(out, 705600, 1000, 2, 0.5) < 1e-6);
        assert(runMs < 10000.0 / 5.0);
    }

    // Room-correction impulse: mono WAV at 48 kHz, used at 96 kHz with −6 dB gain.
    {
        const char* path = "/tmp/puros-fir-test-ir.wav";
        std::vector<int16_t> ir(4800, 0);
        ir[100] = 16384;            // 0.5 impulse after 100 samples
        ir[101] = -8192;
        writeWav(path, ir, 1, 48000);
        ImpulseResponseInfo info;
        std::string error;
        assert(inspectImpulseResponse(path, info, error));
        assert(info.channels == 1 && info.sampleRate == 48000 && info.taps == 4800 && info.peakIndex == 100);
        std::vector<std::shared_ptr<const KernelSpectrum>> spectra;
        size_t peak = 0;
        assert(loadImpulseResponse(path, 96000, -6.0, spectra, peak, info, error));
        assert(spectra.size() == 1 && peak == 200);
        assert(std::abs(static_cast<double>(spectra[0]->length) - 9600) < 80);
    }

    std::puts("FIR tests passed");
    return 0;
}
