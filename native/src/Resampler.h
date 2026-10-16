#pragma once

#include <CoreAudio/CoreAudioTypes.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "DsdModulator.h"
#include "FirFilter.h"

// Sample-rate conversion and output requantization for the decode thread.
//
// Bit-perfect playback never comes through here: the engine only takes this
// path when the output rate differs from the source, the output has fewer bits
// than the source, de-emphasis is needed, or a room-correction filter is set.
// Sources are decoded to float64, de-emphasized, resampled (FIR / SoX / Apple),
// convolved with the room-correction filter, attenuated by the headroom, run
// through DSP, then quantized to the device format with dither — all in double
// precision.

// Fir: long-FIR resampler for integer ratios, SoX for the rest.
enum class ResamplerEngine { Soxr, Apple, Fir };

// Requantization: plain rounding, TPDF or Gaussian dither, or TPDF dither with
// error-feedback noise shaping of increasing order.
enum class DitherMode { None, Tpdf, Gaussian, NoiseShaped, NoiseShaped5, NoiseShaped9 };

// One SoX filter. `recipe` is SOXR_QQ … SOXR_32_BITQ; zero values in the
// fine-tuning fields keep the recipe's own defaults.
struct SoxrFilterConfig {
    unsigned recipe = 6;              // SOXR_VHQ
    double precision = 0.0;           // bits, 15–33
    double phaseResponse = 50.0;      // 0 = minimum, 50 = linear, 100 = maximum
    double passbandEnd = 0.0;         // fraction of Nyquist, e.g. 0.913
    double stopbandBegin = 0.0;       // fraction of Nyquist, e.g. 1.0
    bool steepFilter = false;
    bool allowAliasing = false;
};

struct ResamplerConfig {
    ResamplerEngine engine = ResamplerEngine::Soxr;

    // Filter for 1x sources (44.1 / 48 kHz) and for hi-res (Nx) sources.
    SoxrFilterConfig filter1x;
    SoxrFilterConfig filterNx;

    // Apple AudioConverter (kAudioConverterSampleRateConverterComplexity_*,
    // kAudioConverterQuality_*).
    uint32_t appleComplexity = 'bats';  // Mastering
    uint32_t appleQuality = 0x7F;

    DitherMode dither = DitherMode::Tpdf;

    // Attenuation applied whenever the float path runs, so inter-sample peaks
    // reconstructed by the resampler do not clip.
    double headroomDb = 0.0;

    // FIR designs for 1x and hi-res sources (engine Fir, integer ratios).
    FirDesign fir1x;
    FirDesign firNx;

    // PCM → DSD modulator (used when a track is played with a DSD output rate).
    ModulatorType modulator = ModulatorType::Order7;

    // Room-correction convolution at the output rate; empty path = off.
    std::string convolutionPath;
    double convolutionGainDb = 0.0;
    bool convolutionCompensateDelay = true;

    static bool isHiRes(double sourceRate) { return sourceRate > 48000.0 + 1.0; }
    const SoxrFilterConfig& filterFor(double sourceRate) const { return isHiRes(sourceRate) ? filterNx : filter1x; }
    const FirDesign& firFor(double sourceRate) const { return isHiRes(sourceRate) ? firNx : fir1x; }
};

// Wraps one libsoxr stream: interleaved float64 in, interleaved float64 out.
class SoxrResampler {
public:
    SoxrResampler() = default;
    ~SoxrResampler();
    SoxrResampler(const SoxrResampler&) = delete;
    SoxrResampler& operator=(const SoxrResampler&) = delete;

    bool configure(const SoxrFilterConfig& filter, double inputRate, double outputRate,
                   uint32_t channels, std::string& error);
    // Appends the resampled frames to `out`.
    void process(const double* in, size_t frames, std::vector<double>& out);
    // End of input: appends whatever is still inside the filter.
    void flush(std::vector<double>& out);
    // Fresh signal (seek) with the same configuration.
    void reset();
    bool active() const { return soxr_ != nullptr; }
    double inputRate() const { return inputRate_; }
    double outputRate() const { return outputRate_; }

private:
    void release();

    void* soxr_ = nullptr;
    uint32_t channels_ = 0;
    double inputRate_ = 0;
    double outputRate_ = 0;
};

// CD pre-emphasis (50/15 µs) inverse: the analog shelf |H| = |1 + jω·15µs| / |1 + jω·50µs|.
// A plain bilinear transform bends the curve near Nyquist (≈1.5 dB off at 10 kHz
// for 44.1 kHz), so the one-pole/one-zero section is fitted to the analog
// magnitude over 100 Hz – 20 kHz instead: ≤0.08 dB error at 44.1 kHz, ≤0.01 dB
// from 88.2 kHz up. DC gain is exactly 0 dB. Fits are cached per sample rate.
class DeemphasisFilter {
public:
    static double analogDb(double frequency) {
        const double w = 2.0 * 3.14159265358979323846 * frequency;
        return 10.0 * std::log10((1.0 + std::pow(w * 15e-6, 2)) / (1.0 + std::pow(w * 50e-6, 2)));
    }

    void configure(double sampleRate, uint32_t channels) {
        channels_ = std::max<uint32_t>(1, std::min<uint32_t>(channels, kMaxChannels));
        const auto [pole, zero] = fittedSection(sampleRate);
        const double gain = (1.0 - pole) / (1.0 - zero);   // unity at DC
        b0_ = gain;
        b1_ = -gain * zero;
        a1_ = -pole;
        reset();
    }

    void reset() { std::memset(state_, 0, sizeof(state_)); }

    // In place, interleaved.
    void process(double* samples, size_t frames) {
        for (size_t f = 0; f < frames; ++f) {
            for (uint32_t ch = 0; ch < channels_; ++ch) {
                double& sample = samples[f * channels_ + ch];
                const double x = sample;
                const double y = b0_ * x + state_[ch];
                state_[ch] = b1_ * x - a1_ * y;
                sample = y;
            }
        }
    }

    // Magnitude response (for tests / UI).
    double gainAt(double frequency, double sampleRate) const {
        const double w = 2.0 * 3.14159265358979323846 * frequency / sampleRate;
        const double nr = b0_ + b1_ * std::cos(w), ni = -b1_ * std::sin(w);
        const double dr = 1.0 + a1_ * std::cos(w), di = -a1_ * std::sin(w);
        return std::sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    }

private:
    static constexpr uint32_t kMaxChannels = 8;

    // Minimax fit of pole/zero (both in [0, 1)) by successive grid refinement.
    static std::pair<double, double> fittedSection(double sampleRate) {
        static std::mutex cacheMutex;
        static std::vector<std::pair<double, std::pair<double, double>>> cache;
        {
            std::lock_guard<std::mutex> lock(cacheMutex);
            for (const auto& entry : cache) if (entry.first == sampleRate) return entry.second;
        }
        constexpr int kPoints = 30;
        const double top = std::min(20000.0, 0.45 * sampleRate);
        double freqs[kPoints], target[kPoints], cosw[kPoints], sinw[kPoints];
        for (int i = 0; i < kPoints; ++i) {
            freqs[i] = 100.0 * std::pow(top / 100.0, static_cast<double>(i) / (kPoints - 1));
            target[i] = analogDb(freqs[i]);
            const double w = 2.0 * 3.14159265358979323846 * freqs[i] / sampleRate;
            cosw[i] = std::cos(w);
            sinw[i] = std::sin(w);
        }
        const auto maxError = [&](double pole, double zero) {
            const double gain = (1.0 - pole) / (1.0 - zero);
            double worst = 0.0;
            for (int i = 0; i < kPoints; ++i) {
                const double nr = 1.0 - zero * cosw[i], ni = zero * sinw[i];
                const double dr = 1.0 - pole * cosw[i], di = pole * sinw[i];
                const double db = 20.0 * std::log10(gain) + 10.0 * std::log10((nr * nr + ni * ni) / (dr * dr + di * di));
                worst = std::max(worst, std::abs(db - target[i]));
            }
            return worst;
        };
        double loP = 0.0, hiP = 0.999, loZ = 0.0, hiZ = 0.999;
        double bestError = 1e9, bestPole = 0.0, bestZero = 0.0;
        for (int round = 0; round < 6; ++round) {
            constexpr int n = 32;
            for (int i = 0; i <= n; ++i) {
                const double pole = loP + (hiP - loP) * i / n;
                for (int j = 0; j <= n; ++j) {
                    const double zero = loZ + (hiZ - loZ) * j / n;
                    const double error = maxError(pole, zero);
                    if (error < bestError) { bestError = error; bestPole = pole; bestZero = zero; }
                }
            }
            const double spanP = (hiP - loP) / 8.0, spanZ = (hiZ - loZ) / 8.0;
            loP = std::max(0.0, bestPole - spanP); hiP = std::min(0.9999, bestPole + spanP);
            loZ = std::max(0.0, bestZero - spanZ); hiZ = std::min(0.9999, bestZero + spanZ);
        }
        const std::pair<double, double> result{bestPole, bestZero};
        std::lock_guard<std::mutex> lock(cacheMutex);
        cache.emplace_back(sampleRate, result);
        return result;
    }

    uint32_t channels_ = 2;
    double b0_ = 1.0, b1_ = 0.0, a1_ = 0.0;
    double state_[kMaxChannels] = {};
};

// Float64 → device PCM with optional dither / noise shaping. One per slot, so
// dither and shaping state never crosses tracks. Also measures the peak level
// and counts samples that had to be clipped.
class OutputQuantizer {
public:
    // `physicalBits`: the DAC's real integer resolution when known (e.g. 24 in a
    // 32-bit container), 0 otherwise.
    void configure(const AudioStreamBasicDescription& format, uint32_t physicalBits, DitherMode mode) {
        format_ = format;
        mode_ = mode;
        const UInt32 flags = format.mFormatFlags;
        isFloat_ = (flags & kAudioFormatFlagIsFloat) != 0;
        channels_ = std::max<uint32_t>(1, format.mChannelsPerFrame);
        bytesPerSample_ = format.mBytesPerFrame / channels_;
        const uint32_t containerBits = bytesPerSample_ * 8;
        const uint32_t validBits = format.mBitsPerChannel > 0
            ? std::min<uint32_t>(format.mBitsPerChannel, containerBits)
            : containerBits;
        const bool alignedHigh = (flags & kAudioFormatFlagIsAlignedHigh) != 0;
        valueBits_ = (validBits == containerBits || alignedHigh) ? containerBits : validBits;
        if (isFloat_) {
            gridBits_ = physicalBits >= 16 && physicalBits <= 24 ? physicalBits : 0;
        } else {
            gridBits_ = physicalBits >= 16 ? std::min(validBits, physicalBits) : validBits;
        }
        // A grid finer than 24 bits is below every DAC's noise floor: no dither.
        ditherActive_ = mode_ != DitherMode::None && gridBits_ > 0 && gridBits_ <= 24;
        fullScale_ = std::ldexp(1.0, static_cast<int>(valueBits_) - 1);
        step_ = gridBits_ > 0 ? std::ldexp(1.0, static_cast<int>(valueBits_) - static_cast<int>(gridBits_)) : 1.0;
        maxValue_ = fullScale_ - step_;
        configureShaping(format.mSampleRate);
        reset();
    }

    void reset() {
        std::memset(errors_, 0, sizeof(errors_));
        hasSpareGaussian_ = false;
    }

    bool ditherActive() const { return ditherActive_; }
    uint32_t ditherBits() const { return ditherActive_ ? gridBits_ : 0; }
    DitherMode mode() const { return mode_; }

    // Peak |sample| and clipped-sample count since the last take (decode thread).
    double takePeak() { const double p = peak_; peak_ = 0.0; return p; }
    uint64_t takeClips() { const uint64_t c = clips_; clips_ = 0; return c; }

    // Writes `frames` frames of `format` into `out` (resized as needed).
    void convert(const double* in, size_t frames, std::vector<uint8_t>& out) {
        out.resize(frames * format_.mBytesPerFrame);
        uint8_t* dst = out.data();

        if (isFloat_) {
            const double levels = gridBits_ > 0 ? std::ldexp(1.0, static_cast<int>(gridBits_) - 1) : 0.0;
            const double floatMax = levels > 0 ? (levels - 1.0) / levels : 1.0;
            for (size_t f = 0; f < frames; ++f) {
                for (uint32_t ch = 0; ch < channels_; ++ch) {
                    double v = measure(in[f * channels_ + ch]);
                    if (ditherActive_) v = quantize(v * levels, ch, -levels, levels * floatMax) / levels;
                    const float out32 = static_cast<float>(v);
                    std::memcpy(dst + (f * channels_ + ch) * 4, &out32, 4);
                }
            }
            return;
        }

        for (size_t f = 0; f < frames; ++f) {
            for (uint32_t ch = 0; ch < channels_; ++ch) {
                const double v = measure(in[f * channels_ + ch]);
                // Value in grid steps: the DAC's own resolution inside the container.
                const double scaled = v * fullScale_ / step_;
                double q;
                if (ditherActive_) {
                    q = quantize(scaled, ch, -fullScale_ / step_, maxValue_ / step_);
                } else {
                    q = std::clamp(std::nearbyint(scaled), -fullScale_ / step_, maxValue_ / step_);
                }
                writeInteger(dst + (f * channels_ + ch) * bytesPerSample_, static_cast<int64_t>(q * step_));
            }
        }
    }

private:
    static constexpr uint32_t kMaxChannels = 8;
    static constexpr size_t kMaxTaps = 9;

    // Error-feedback coefficients h: noise transfer function NTF = 1 − Σ h_k z^-k.
    // At 44.1/48 kHz: psychoacoustic curves (Wannamaker 3-tap E-weighted,
    // Lipshitz 5-tap, improved E-weighted 9-tap, as used by SoX). At higher rates
    // the NTF gets 1/2/3 pairs of zeros spread optimally across 0–21 kHz
    // (Schreier's zero placement), which moves the noise above the audio band.
    void configureShaping(double sampleRate) {
        taps_ = 0;
        std::fill(std::begin(shaping_), std::end(shaping_), 0.0);
        const bool baseRate = sampleRate <= 50000.0;
        auto set = [&](std::initializer_list<double> coefficients) {
            taps_ = 0;
            for (double c : coefficients) shaping_[taps_++] = c;
        };
        switch (mode_) {
            case DitherMode::NoiseShaped:
                if (baseRate) set({1.623, -0.982, 0.109}); else setAudioBandZeros(sampleRate, {0.577});
                break;
            case DitherMode::NoiseShaped5:
                if (baseRate) set({2.033, -2.165, 1.959, -1.590, 0.6149});
                else setAudioBandZeros(sampleRate, {0.340, 0.861});
                break;
            case DitherMode::NoiseShaped9:
                if (baseRate) set({2.847, -4.685, 6.214, -7.184, 6.639, -5.032, 3.263, -1.632, 0.4191});
                else setAudioBandZeros(sampleRate, {0.239, 0.661, 0.935});
                break;
            default:
                break;
        }
    }

    // NTF = Π (1 − 2 cos θ_i z^-1 + z^-2), θ_i = fraction_i · 2π · 21 kHz / fs.
    void setAudioBandZeros(double sampleRate, std::initializer_list<double> fractions) {
        const double bandEdge = 2.0 * 3.14159265358979323846 * 21000.0 / sampleRate;
        double ntf[kMaxTaps + 1] = {1.0};
        size_t order = 0;
        for (double fraction : fractions) {
            const double c = -2.0 * std::cos(fraction * bandEdge);
            double next[kMaxTaps + 1] = {};
            for (size_t i = 0; i <= order; ++i) {
                next[i] += ntf[i];
                next[i + 1] += ntf[i] * c;
                next[i + 2] += ntf[i];
            }
            order += 2;
            std::memcpy(ntf, next, sizeof(ntf));
        }
        taps_ = order;
        for (size_t k = 0; k < order; ++k) shaping_[k] = -ntf[k + 1];
    }

    // Clamp to full scale, tracking the peak and counting clipped samples.
    double measure(double v) {
        const double magnitude = std::fabs(v);
        if (magnitude > peak_) peak_ = magnitude;
        if (magnitude > 1.0) {
            ++clips_;
            return v > 0 ? 1.0 : -1.0;
        }
        return v;
    }

    // Quantize `x` (in grid steps) to an integer with dither, optionally shaping
    // the error spectrum.
    double quantize(double x, uint32_t ch, double minValue, double maxValue) {
        double* e = errors_[std::min<uint32_t>(ch, kMaxChannels - 1)];
        double target = x;
        for (size_t k = 0; k < taps_; ++k) target -= shaping_[k] * e[k];
        const double noise = mode_ == DitherMode::Gaussian ? gaussian() : tpdf();
        const double q = std::clamp(std::floor(target + noise + 0.5), minValue, maxValue);
        if (taps_ > 0) {
            // Clipped samples would feed a huge error back; keep the loop stable.
            const double err = std::clamp(q - target, -4.0, 4.0);
            for (size_t k = taps_ - 1; k > 0; --k) e[k] = e[k - 1];
            e[0] = err;
        }
        return q;
    }

    void writeInteger(uint8_t* sample, int64_t value) const {
        if (bytesPerSample_ == 2) {
            const auto v = static_cast<int16_t>(value);
            std::memcpy(sample, &v, 2);
        } else if (bytesPerSample_ == 3) {
            const auto v = static_cast<int32_t>(value);
            sample[0] = static_cast<uint8_t>(v & 0xFF);
            sample[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
            sample[2] = static_cast<uint8_t>((v >> 16) & 0xFF);
        } else {
            const auto v = static_cast<int32_t>(value);
            std::memcpy(sample, &v, 4);
        }
    }

    uint64_t nextRandom() {
        rng_ ^= rng_ >> 12;
        rng_ ^= rng_ << 25;
        rng_ ^= rng_ >> 27;
        return rng_ * 0x2545F4914F6CDD1Dull;
    }

    double uniform() {
        constexpr double scale = 1.0 / 9007199254740992.0;  // 2^-53
        return static_cast<double>(nextRandom() >> 11) * scale;
    }

    // Triangular PDF in (-1, 1) LSB.
    double tpdf() { return uniform() - uniform(); }

    // Gaussian dither, σ = 0.5 LSB (Box–Muller, pairs cached).
    double gaussian() {
        if (hasSpareGaussian_) {
            hasSpareGaussian_ = false;
            return spareGaussian_;
        }
        const double u1 = std::max(uniform(), 1e-300);
        const double u2 = uniform();
        const double radius = 0.5 * std::sqrt(-2.0 * std::log(u1));
        const double angle = 2.0 * 3.14159265358979323846 * u2;
        spareGaussian_ = radius * std::sin(angle);
        hasSpareGaussian_ = true;
        return radius * std::cos(angle);
    }

    AudioStreamBasicDescription format_{};
    DitherMode mode_ = DitherMode::None;
    bool isFloat_ = false;
    bool ditherActive_ = false;
    uint32_t channels_ = 2;
    uint32_t bytesPerSample_ = 4;
    uint32_t valueBits_ = 32;
    uint32_t gridBits_ = 32;
    double fullScale_ = 2147483648.0;
    double step_ = 1.0;
    double maxValue_ = 2147483647.0;
    double shaping_[kMaxTaps] = {};
    size_t taps_ = 0;
    double errors_[kMaxChannels][kMaxTaps] = {};
    uint64_t rng_ = 0x2545F4914F6CDD1Dull;
    bool hasSpareGaussian_ = false;
    double spareGaussian_ = 0.0;
    double peak_ = 0.0;
    uint64_t clips_ = 0;
};
