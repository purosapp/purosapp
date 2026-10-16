// Build & run (from the repo root, after `node scripts/build-soxr.mjs --install=build/audio/soxr`):
//   clang++ -std=c++17 -O2 -Ibuild/audio/soxr/include native/src/Resampler.cpp native/src/Resampler.test.cpp \
//     build/audio/soxr/lib/libsoxr.0.dylib -Wl,-rpath,build/audio/soxr/lib -o /tmp/resampler-test && /tmp/resampler-test
#include "Resampler.h"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<double> sine(double rate, double freq, size_t frames, uint32_t channels, double amplitude) {
    std::vector<double> out(frames * channels);
    for (size_t i = 0; i < frames; ++i) {
        const double v = amplitude * std::sin(2.0 * kPi * freq * i / rate);
        for (uint32_t ch = 0; ch < channels; ++ch) out[i * channels + ch] = v;
    }
    return out;
}

std::vector<double> resampleAll(const SoxrFilterConfig& config, double inRate, double outRate,
                               const std::vector<double>& in, uint32_t channels) {
    SoxrResampler resampler;
    std::string error;
    const bool ok = resampler.configure(config, inRate, outRate, channels, error);
    assert(ok && error.empty());
    std::vector<double> out;
    const size_t frames = in.size() / channels;
    // Feed in uneven blocks, like the decode thread does at EOF boundaries.
    for (size_t pos = 0; pos < frames;) {
        const size_t block = std::min<size_t>(frames - pos, 1000 + (pos % 777));
        resampler.process(in.data() + pos * channels, block, out);
        pos += block;
    }
    resampler.flush(out);
    return out;
}

// Worst deviation from the ideal sine, skipping the edges where the filter rings.
double maxError(const std::vector<double>& out, double rate, double freq, uint32_t channels, double amplitude) {
    const size_t frames = out.size() / channels;
    double worst = 0;
    for (size_t i = frames / 10; i < frames - frames / 10; ++i) {
        const double ideal = amplitude * std::sin(2.0 * kPi * freq * i / rate);
        worst = std::max(worst, std::abs(out[i * channels] - ideal));
    }
    return worst;
}

AudioStreamBasicDescription intFormat(double rate, uint32_t bits, uint32_t bytes) {
    AudioStreamBasicDescription f{};
    f.mSampleRate = rate;
    f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    f.mChannelsPerFrame = 2;
    f.mBitsPerChannel = bits;
    f.mBytesPerFrame = bytes * 2;
    f.mFramesPerPacket = 1;
    f.mBytesPerPacket = f.mBytesPerFrame;
    return f;
}

// Error power (relative) below `maxHz` via a direct DFT of the quantization error.
double bandErrorPower(const std::vector<double>& error, double rate, double maxHz) {
    const size_t n = error.size();
    const size_t maxBin = static_cast<size_t>(maxHz / rate * n);
    double power = 0;
    for (size_t k = 1; k <= maxBin; ++k) {
        double re = 0, im = 0;
        for (size_t i = 0; i < n; ++i) {
            const double phase = 2.0 * kPi * k * i / n;
            re += error[i] * std::cos(phase);
            im -= error[i] * std::sin(phase);
        }
        power += re * re + im * im;
    }
    return power;
}

// Quantize a quiet 16-bit signal and return the error (in LSB) of channel 0.
std::vector<double> quantizationError(DitherMode mode, double rate, size_t frames) {
    OutputQuantizer quantizer;
    quantizer.configure(intFormat(rate, 16, 2), 0, mode);
    std::vector<double> in(frames * 2);
    for (size_t i = 0; i < frames; ++i) {
        const double v = 0.001 * std::sin(2.0 * kPi * 997.0 * i / rate);
        in[i * 2] = in[i * 2 + 1] = v;
    }
    std::vector<uint8_t> out;
    quantizer.convert(in.data(), frames, out);
    const auto* s = reinterpret_cast<const int16_t*>(out.data());
    std::vector<double> error(frames);
    for (size_t i = 0; i < frames; ++i) error[i] = s[i * 2] - static_cast<double>(in[i * 2]) * 32768.0;
    return error;
}

}  // namespace

int main() {
    const uint32_t channels = 2;

    // 44.1 → 48 kHz, very high quality: length follows the ratio and the output
    // is time-aligned with the input (no filter delay leaks into position).
    {
        SoxrFilterConfig config;
        const auto in = sine(44100, 1000, 44100, channels, 0.5);
        const auto out = resampleAll(config, 44100, 48000, in, channels);
        const size_t frames = out.size() / channels;
        assert(std::abs(static_cast<long>(frames) - 48000) <= 2);
        const double err = maxError(out, 48000, 1000, channels, 0.5);
        std::printf("VHQ 44.1->48 max error %.2e\n", err);
        assert(err < 1e-5);
    }

    // Downsampling 192 → 44.1 with every preset, including a tuned custom filter.
    for (unsigned recipe : {0u, 1u, 2u, 4u, 6u}) {
        SoxrFilterConfig config;
        config.recipe = recipe;
        const auto in = sine(192000, 3000, 192000 / 2, channels, 0.5);
        const auto out = resampleAll(config, 192000, 44100, in, channels);
        const double err = maxError(out, 44100, 3000, channels, 0.5);
        std::printf("recipe %u 192->44.1 max error %.2e\n", recipe, err);
        assert(err < (recipe == 0 ? 2e-2 : 2e-3));
    }
    {
        SoxrFilterConfig config;
        config.recipe = 7;
        config.precision = 32;
        config.passbandEnd = 0.95;
        config.stopbandBegin = 1.0;
        config.steepFilter = true;
        const auto out = resampleAll(config, 88200, 44100, sine(88200, 5000, 88200, channels, 0.5), channels);
        assert(maxError(out, 44100, 5000, channels, 0.5) < 1e-6);
    }
    // Minimum phase and aliasing-allowed filters configure and keep the level.
    {
        SoxrFilterConfig config;
        config.phaseResponse = 0;
        config.allowAliasing = true;
        const auto out = resampleAll(config, 48000, 96000, sine(48000, 1000, 48000, channels, 0.5), channels);
        double peak = 0;
        for (size_t i = out.size() / 4; i < out.size() * 3 / 4; ++i) peak = std::max(peak, std::abs(static_cast<double>(out[i])));
        assert(std::abs(peak - 0.5) < 1e-3);
    }

    // Seek: reset() starts a fresh signal without the previous tail.
    {
        SoxrFilterConfig config;
        SoxrResampler resampler;
        std::string error;
        assert(resampler.configure(config, 44100, 96000, channels, error));
        std::vector<double> out;
        const auto loud = sine(44100, 1000, 4096, channels, 0.9);
        resampler.process(loud.data(), 4096, out);
        resampler.reset();
        out.clear();
        const std::vector<double> silence(4096 * channels, 0.0f);
        resampler.process(silence.data(), 4096, out);
        resampler.flush(out);
        for (float v : out) assert(std::abs(v) < 1e-9f);
    }

    // Quantizer without dither is plain rounding onto the 16-bit grid.
    {
        OutputQuantizer quantizer;
        quantizer.configure(intFormat(44100, 16, 2), 0, DitherMode::None);
        assert(!quantizer.ditherActive());
        const std::vector<double> in = {0.5, -0.5, 1.0, -1.0, 0.0, 0.0};
        std::vector<uint8_t> out;
        quantizer.convert(in.data(), 3, out);
        const auto* s = reinterpret_cast<const int16_t*>(out.data());
        assert(s[0] == 16384 && s[1] == -16384);
        assert(s[2] == 32767 && s[3] == -32768);
        assert(s[4] == 0 && s[5] == 0);
    }

    // TPDF dither: 24 → 16 bit, the average level is preserved and noise stays within ±1 LSB.
    for (DitherMode mode : {DitherMode::Tpdf, DitherMode::NoiseShaped}) {
        OutputQuantizer quantizer;
        quantizer.configure(intFormat(44100, 16, 2), 0, mode);
        assert(quantizer.ditherActive() && quantizer.ditherBits() == 16);
        const float value = 1000.25f / 32768.0f;
        const std::vector<double> in(2 * 20000, value);
        std::vector<uint8_t> out;
        quantizer.convert(in.data(), 20000, out);
        const auto* s = reinterpret_cast<const int16_t*>(out.data());
        double sum = 0;
        for (size_t i = 0; i < 40000; ++i) {
            if (mode == DitherMode::Tpdf) assert(s[i] >= 999 && s[i] <= 1002);
            else assert(s[i] >= 990 && s[i] <= 1010);
            sum += s[i];
        }
        std::printf("dither mode %d mean %.4f\n", static_cast<int>(mode), sum / 40000);
        assert(std::abs(sum / 40000 - 1000.25) < 0.05);
    }

    // 24-bit DAC in a 32-bit container: dither on the 24-bit grid, low byte stays clear.
    {
        OutputQuantizer quantizer;
        quantizer.configure(intFormat(96000, 32, 4), 24, DitherMode::Tpdf);
        assert(quantizer.ditherBits() == 24);
        const std::vector<double> in(2 * 256, 0.123456f);
        std::vector<uint8_t> out;
        quantizer.convert(in.data(), 256, out);
        const auto* s = reinterpret_cast<const int32_t*>(out.data());
        for (size_t i = 0; i < 512; ++i) assert((s[i] & 0xFF) == 0);
    }

    // Full 32-bit integer output needs no dither (float32 has 24 significant bits).
    {
        OutputQuantizer quantizer;
        quantizer.configure(intFormat(48000, 32, 4), 0, DitherMode::Tpdf);
        assert(!quantizer.ditherActive());
    }

    // Noise shaping moves requantization noise out of the audible band: less error
    // power below 4 kHz (44.1k) / 20 kHz (96k) than plain TPDF, for every order.
    {
        const size_t frames = 4096;
        const double tpdf441 = bandErrorPower(quantizationError(DitherMode::Tpdf, 44100, frames), 44100, 4000);
        for (DitherMode mode : {DitherMode::NoiseShaped, DitherMode::NoiseShaped5, DitherMode::NoiseShaped9}) {
            const double shaped = bandErrorPower(quantizationError(mode, 44100, frames), 44100, 4000);
            std::printf("shaping %d @44.1k: LF noise %.1f dB vs TPDF\n", static_cast<int>(mode), 10 * std::log10(shaped / tpdf441));
            assert(shaped < tpdf441 * 0.5);
        }
        const double tpdf96 = bandErrorPower(quantizationError(DitherMode::Tpdf, 96000, frames), 96000, 20000);
        for (DitherMode mode : {DitherMode::NoiseShaped, DitherMode::NoiseShaped5, DitherMode::NoiseShaped9}) {
            const double shaped = bandErrorPower(quantizationError(mode, 96000, frames), 96000, 20000);
            std::printf("shaping %d @96k: audio-band noise %.1f dB vs TPDF\n", static_cast<int>(mode), 10 * std::log10(shaped / tpdf96));
            assert(shaped < tpdf96 * 0.5);
        }
    }

    // Gaussian dither keeps the average level and stays within a few LSB.
    {
        OutputQuantizer quantizer;
        quantizer.configure(intFormat(44100, 16, 2), 0, DitherMode::Gaussian);
        const std::vector<double> in(2 * 40000, 1000.25f / 32768.0f);
        std::vector<uint8_t> out;
        quantizer.convert(in.data(), 40000, out);
        const auto* s = reinterpret_cast<const int16_t*>(out.data());
        double sum = 0;
        for (size_t i = 0; i < 80000; ++i) {
            assert(s[i] >= 997 && s[i] <= 1004);
            sum += s[i];
        }
        assert(std::abs(sum / 80000 - 1000.25) < 0.05);
    }

    // Overs are clipped to full scale, counted, and the peak is reported.
    {
        OutputQuantizer quantizer;
        quantizer.configure(intFormat(48000, 24, 3), 0, DitherMode::None);
        const std::vector<double> in = {0.5, -0.25, 1.2, -1.5, 0.9, 0.1};
        std::vector<uint8_t> out;
        quantizer.convert(in.data(), 3, out);
        assert(quantizer.takeClips() == 2);
        assert(std::abs(quantizer.takePeak() - 1.5) < 1e-12);
        assert(quantizer.takeClips() == 0 && quantizer.takePeak() == 0.0);
        int32_t v = out[6] | (out[7] << 8) | (out[8] << 16);
        assert(v == 0x7FFFFF);
    }

    // De-emphasis: 0 dB at DC, the 50/15 µs curve through the audio band, −10.5 dB shelf.
    for (double rate : {44100.0, 48000.0, 96000.0}) {
        DeemphasisFilter filter;
        filter.configure(rate, 2);
        const auto db = [&](double f) { return 20.0 * std::log10(filter.gainAt(f, rate)); };
        const auto analog = [](double f) { return DeemphasisFilter::analogDb(f); };
        std::printf("de-emphasis @%.0f: 1k %.2f dB (analog %.2f), 10k %.2f dB (analog %.2f)\n",
                    rate, db(1000), analog(1000), db(10000), analog(10000));
        assert(std::abs(db(1.0)) < 0.001);
        for (double f : {100.0, 1000.0, 3183.0, 5000.0, 10000.0, 16000.0, 20000.0}) {
            assert(std::abs(db(f) - analog(f)) < 0.1);
        }
        // Time domain matches the response: a 10 kHz tone comes out ~7.5 dB down.
        std::vector<double> tone(2 * 8192);
        for (size_t i = 0; i < 8192; ++i) tone[i * 2] = tone[i * 2 + 1] = static_cast<float>(0.5 * std::sin(2 * kPi * 10000 * i / rate));
        filter.process(tone.data(), 8192);
        double peak = 0;
        for (size_t i = 4096; i < 8192; ++i) peak = std::max(peak, std::abs(static_cast<double>(tone[i * 2])));
        assert(std::abs(20 * std::log10(peak / 0.5) - db(10000)) < 0.2);
    }

    std::puts("Resampler tests passed");
    return 0;
}
