#include "DSPPipeline.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdio>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ---------------------------------------------------------------------------
// Sample conversion — integer PCM ↔ normalized double [-1.0, 1.0]
//
// Double has 53-bit mantissa, so int16/24/32 → double → int round-trip is
// lossless when the value doesn't change.  DSP modifies the value intentionally.
// ---------------------------------------------------------------------------

static inline double readSample(const uint8_t* ptr, uint32_t bytesPerSample) {
    switch (bytesPerSample) {
        case 2: {
            int16_t s;
            std::memcpy(&s, ptr, 2);
            return s / 32768.0;
        }
        case 3: {
            // 24-bit packed little-endian, sign-extend to int32
            int32_t s = ptr[0] | (ptr[1] << 8) | (ptr[2] << 16);
            if (s & 0x800000) s |= static_cast<int32_t>(0xFF000000u);
            return s / 8388608.0;
        }
        case 4: {
            int32_t s;
            std::memcpy(&s, ptr, 4);
            return s / 2147483648.0;
        }
        default:
            return 0.0;
    }
}

static inline void writeSample(uint8_t* ptr, double v, uint32_t bytesPerSample) {
    v = std::clamp(v, -1.0, 1.0);
    switch (bytesPerSample) {
        case 2: {
            auto s = static_cast<int16_t>(std::lrint(v * 32767.0));
            std::memcpy(ptr, &s, 2);
            break;
        }
        case 3: {
            auto s = static_cast<int32_t>(std::lrint(v * 8388607.0));
            ptr[0] = static_cast<uint8_t>(s & 0xFF);
            ptr[1] = static_cast<uint8_t>((s >> 8) & 0xFF);
            ptr[2] = static_cast<uint8_t>((s >> 16) & 0xFF);
            break;
        }
        case 4: {
            auto s = static_cast<int32_t>(std::lrint(v * 2147483647.0));
            std::memcpy(ptr, &s, 4);
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Process — called from decode thread, NOT real-time constrained
// ---------------------------------------------------------------------------

void DSPPipeline::process(uint8_t* buffer, uint32_t numFrames,
                          uint32_t numChannels, uint32_t bytesPerSample) {
    bool isFloat;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        isFloat = isFloat_;
    }
    processSamples(buffer, numFrames, numChannels, bytesPerSample, isFloat, true);
}

void DSPPipeline::processFloat(float* buffer, uint32_t numFrames, uint32_t numChannels) {
    // Overs are left for the quantizer, which clips and counts them.
    processSamples(reinterpret_cast<uint8_t*>(buffer), numFrames, numChannels, 4, true, false);
}

void DSPPipeline::processDouble(double* buffer, uint32_t numFrames, uint32_t numChannels) {
    processSamples(reinterpret_cast<uint8_t*>(buffer), numFrames, numChannels, 8, true, false);
}

void DSPPipeline::processSamples(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                                 uint32_t bytesPerSample, bool isFloat, bool clampFloat) {
    const bool eqEnabled = enabled_.load(std::memory_order_relaxed);

    std::lock_guard<std::mutex> lock(mutex_);
    const bool processEq = eqEnabled && !channels_.empty();
    if (!processEq && !plugins_.active()) return;
    uint32_t stride = bytesPerSample * numChannels;

    if (processEq) for (uint32_t i = 0; i < numFrames; i++) {
        uint8_t* framePtr = buffer + i * stride;
        const auto readNormalizedSample = [&](uint8_t* samplePtr) {
            if (isFloat && bytesPerSample == 8) {
                double d;
                std::memcpy(&d, samplePtr, 8);
                return d;
            }
            if (isFloat) {
                float f;
                std::memcpy(&f, samplePtr, 4);
                return static_cast<double>(f);
            }
            return readSample(samplePtr, bytesPerSample);
        };

        const auto writeNormalizedSample = [&](uint8_t* samplePtr, double sample) {
            if (isFloat && bytesPerSample == 8) {
                std::memcpy(samplePtr, &sample, 8);
                return;
            }
            if (isFloat) {
                float f = static_cast<float>(clampFloat ? std::clamp(sample, -1.0, 1.0) : sample);
                std::memcpy(samplePtr, &f, 4);
            } else {
                writeSample(samplePtr, sample, bytesPerSample);
            }
        };

        if (numChannels >= 2 && channels_.size() >= 2) {
            uint8_t* leftPtr = framePtr;
            uint8_t* rightPtr = framePtr + bytesPerSample;

            double left = readNormalizedSample(leftPtr) * preampLinear_;
            double right = readNormalizedSample(rightPtr) * preampLinear_;

            if (crossfeedConfig_.enabled) {
                const double mid = 0.5 * (left + right);
                const double side = 0.5 * (left - right);
                const double filteredSide = crossfeedSideFilter_.process(side);
                const double blendedSide = side - (crossfeedStrength_ * filteredSide);
                left = mid + blendedSide;
                right = mid - blendedSide;
            }

            for (auto& filter : channels_[0]) {
                left = filter.process(left);
            }
            for (auto& filter : channels_[1]) {
                right = filter.process(right);
            }

            writeNormalizedSample(leftPtr, left);
            writeNormalizedSample(rightPtr, right);

            for (uint32_t ch = 2; ch < numChannels && ch < channels_.size(); ch++) {
                uint8_t* samplePtr = framePtr + ch * bytesPerSample;
                double sample = readNormalizedSample(samplePtr) * preampLinear_;
                for (auto& filter : channels_[ch]) {
                    sample = filter.process(sample);
                }
                writeNormalizedSample(samplePtr, sample);
            }
            continue;
        }

        for (uint32_t ch = 0; ch < numChannels && ch < channels_.size(); ch++) {
            uint8_t* samplePtr = framePtr + ch * bytesPerSample;
            double sample = readNormalizedSample(samplePtr) * preampLinear_;
            for (auto& filter : channels_[ch]) {
                sample = filter.process(sample);
            }
            writeNormalizedSample(samplePtr, sample);
        }
    }
    if (isFloat && bytesPerSample == 8 && plugins_.active()) {
        // VST plug-ins take float32: round-trip through a float buffer.
        std::vector<float> narrow(static_cast<size_t>(numFrames) * numChannels);
        const auto* wide = reinterpret_cast<const double*>(buffer);
        for (size_t i = 0; i < narrow.size(); ++i) narrow[i] = static_cast<float>(wide[i]);
        plugins_.process(reinterpret_cast<uint8_t*>(narrow.data()), numFrames, numChannels, 4, true);
        auto* out = reinterpret_cast<double*>(buffer);
        for (size_t i = 0; i < narrow.size(); ++i) out[i] = narrow[i];
        return;
    }
    plugins_.process(buffer, numFrames, numChannels, bytesPerSample, isFloat);
}

// ---------------------------------------------------------------------------
// Biquad coefficient calculation — Audio EQ Cookbook (Robert Bristow-Johnson)
// ---------------------------------------------------------------------------

BiquadFilter DSPPipeline::calculateBiquad(const EQBand& band, double sampleRate) {
    BiquadFilter f;
    double A     = std::pow(10.0, band.gain / 40.0);
    double w0    = 2.0 * M_PI * band.freq / sampleRate;
    double cosW0 = std::cos(w0);
    double sinW0 = std::sin(w0);
    double alpha = sinW0 / (2.0 * band.q);
    double a0    = 1.0;

    if (band.type == "peaking") {
        f.b0 = 1.0 + alpha * A;
        f.b1 = -2.0 * cosW0;
        f.b2 = 1.0 - alpha * A;
        a0   = 1.0 + alpha / A;
        f.a1 = -2.0 * cosW0;
        f.a2 = 1.0 - alpha / A;

    } else if (band.type == "lowShelf") {
        double sqrtA  = std::sqrt(A);
        double twoSqA = 2.0 * sqrtA * alpha;
        f.b0 =     A * ((A + 1) - (A - 1) * cosW0 + twoSqA);
        f.b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
        f.b2 =     A * ((A + 1) - (A - 1) * cosW0 - twoSqA);
        a0   =          (A + 1) + (A - 1) * cosW0 + twoSqA;
        f.a1 =    -2 * ((A - 1) + (A + 1) * cosW0);
        f.a2 =          (A + 1) + (A - 1) * cosW0 - twoSqA;

    } else if (band.type == "highShelf") {
        double sqrtA  = std::sqrt(A);
        double twoSqA = 2.0 * sqrtA * alpha;
        f.b0 =     A * ((A + 1) + (A - 1) * cosW0 + twoSqA);
        f.b1 =-2 * A * ((A - 1) + (A + 1) * cosW0);
        f.b2 =     A * ((A + 1) + (A - 1) * cosW0 - twoSqA);
        a0   =          (A + 1) - (A - 1) * cosW0 + twoSqA;
        f.a1 =     2 * ((A - 1) - (A + 1) * cosW0);
        f.a2 =          (A + 1) - (A - 1) * cosW0 - twoSqA;
    }

    // Normalize so a0 = 1
    f.b0 /= a0;
    f.b1 /= a0;
    f.b2 /= a0;
    f.a1 /= a0;
    f.a2 /= a0;

    return f;
}

BiquadFilter DSPPipeline::calculateLowpass(double cutoffFrequencyHz, double q, double sampleRate) {
    BiquadFilter f;
    const double clampedCutoff = std::clamp(cutoffFrequencyHz, 20.0, sampleRate * 0.495);
    const double w0 = 2.0 * M_PI * clampedCutoff / sampleRate;
    const double cosW0 = std::cos(w0);
    const double sinW0 = std::sin(w0);
    const double alpha = sinW0 / (2.0 * q);
    const double b0 = (1.0 - cosW0) * 0.5;
    const double b1 = 1.0 - cosW0;
    const double b2 = (1.0 - cosW0) * 0.5;
    const double a0 = 1.0 + alpha;
    const double a1 = -2.0 * cosW0;
    const double a2 = 1.0 - alpha;

    f.b0 = b0 / a0;
    f.b1 = b1 / a0;
    f.b2 = b2 / a0;
    f.a1 = a1 / a0;
    f.a2 = a2 / a0;
    return f;
}

void DSPPipeline::recalculate() {
    // Must be called with mutex_ held
    if (currentSampleRate_ <= 0) {
        channels_.clear();
        crossfeedSideFilter_.reset();
        crossfeedStrength_ = 0.0;
        return;
    }

    const double feedLevelLinear = std::pow(10.0, -crossfeedConfig_.feedLevelDb / 20.0);
    crossfeedStrength_ = crossfeedConfig_.enabled
        ? std::clamp(1.0 - feedLevelLinear, 0.0, 1.0)
        : 0.0;
    crossfeedSideFilter_ = calculateLowpass(
        crossfeedConfig_.cutoffFrequencyHz,
        std::sqrt(0.5),
        currentSampleRate_
    );

    // Create independent filter chains for stereo (2 channels)
    uint32_t numCh = 2;
    channels_.resize(numCh);
    for (uint32_t ch = 0; ch < numCh; ch++) {
        channels_[ch].clear();
        channels_[ch].reserve(profileBands_.size());
        for (const auto& band : profileBands_) {
            channels_[ch].push_back(calculateBiquad(band, currentSampleRate_));
        }
    }
}

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

void DSPPipeline::setProfile(const std::vector<EQBand>& bands, double preampGainDb) {
    std::lock_guard<std::mutex> lock(mutex_);
    profileBands_ = bands;
    preampGainDb_ = preampGainDb;
    preampLinear_ = std::pow(10.0, preampGainDb / 20.0);
    recalculate();
}

void DSPPipeline::setCrossfeed(const CrossfeedConfig& config) {
    std::lock_guard<std::mutex> lock(mutex_);
    crossfeedConfig_ = config;
    recalculate();
}

void DSPPipeline::setSampleRate(double rate) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (std::abs(rate - currentSampleRate_) < 1.0) return;
    currentSampleRate_ = rate;
    recalculate();
    std::string error;
    if (!configOnly_ && !plugins_.configure(pluginSpecs_, rate, error)) {
        std::fprintf(stderr, "VST reconfiguration failed: %s\n", error.c_str());
        plugins_.configure({}, rate, error);
    }
}

void DSPPipeline::setOutputFormat(bool isFloat, double sampleRate) {
    std::lock_guard<std::mutex> lock(mutex_);
    isFloat_ = isFloat;
    if (std::abs(sampleRate - currentSampleRate_) >= 1.0) {
        currentSampleRate_ = sampleRate;
        recalculate();
        std::string error;
        if (!configOnly_ && !plugins_.configure(pluginSpecs_, sampleRate, error)) {
            std::fprintf(stderr, "VST reconfiguration failed: %s\n", error.c_str());
            plugins_.configure({}, sampleRate, error);
        }
    }
}

void DSPPipeline::setEnabled(bool enabled) {
    if (enabled) {
        // Reset delay lines to prevent transients from stale state
        std::lock_guard<std::mutex> lock(mutex_);
        crossfeedSideFilter_.reset();
        for (auto& ch : channels_)
            for (auto& f : ch) f.reset();
    }
    enabled_.store(enabled, std::memory_order_release);
}

void DSPPipeline::resetState() {
    std::lock_guard<std::mutex> lock(mutex_);
    crossfeedSideFilter_.reset();
    for (auto& ch : channels_)
        for (auto& f : ch) f.reset();
    plugins_.reset();
}

bool DSPPipeline::setPlugins(const std::vector<PluginSpec>& specs, std::string& error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!configOnly_ && !plugins_.configure(specs, currentSampleRate_, error)) return false;
    pluginSpecs_ = specs;
    return true;
}

bool DSPPipeline::setPluginParameter(size_t index, uint32_t id, double value, std::string& error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (index >= pluginSpecs_.size() || !std::isfinite(value)) {
        error = "Invalid plug-in parameter";
        return false;
    }
    auto& params = pluginSpecs_[index].parameters;
    auto found = std::find_if(params.begin(), params.end(), [id](const auto& p) { return p.first == id; });
    if (found == params.end()) params.emplace_back(id, value);
    else found->second = value;
    if (!configOnly_) return plugins_.setParameter(index, id, value, error);
    return true;
}

bool DSPPipeline::openPluginEditor(size_t index,
                                   std::function<void(uint32_t, double)> onChange,
                                   std::function<void()> onDisable,
                                   std::string& error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (index >= pluginSpecs_.size() || !pluginSpecs_[index].enabled) {
        error = "Plug-in is not active in this playback slot";
        return false;
    }
    return plugins_.openActiveEditor(index, std::move(onChange), std::move(onDisable), error);
}

void DSPPipeline::clearProfile() {
    std::lock_guard<std::mutex> lock(mutex_);
    profileBands_.clear();
    preampGainDb_ = 0;
    preampLinear_ = 1.0;
    recalculate();
}

void DSPPipeline::copyConfigTo(DSPPipeline& other) const {
    std::vector<EQBand> bands;
    CrossfeedConfig crossfeedConfig;
    double preampGainDb = 0;
    double sampleRate = 0;
    bool isFloat = false;
    bool enabled = false;
    std::vector<PluginSpec> plugins;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        bands = profileBands_;
        crossfeedConfig = crossfeedConfig_;
        preampGainDb = preampGainDb_;
        sampleRate = currentSampleRate_;
        isFloat = isFloat_;
        enabled = enabled_.load(std::memory_order_acquire);
        plugins = pluginSpecs_;
    }

    std::string error;
    other.setPlugins({}, error);
    other.clearProfile();
    other.setOutputFormat(isFloat, sampleRate);
    other.setProfile(bands, preampGainDb);
    other.setCrossfeed(crossfeedConfig);
    other.setEnabled(enabled);
    other.setPlugins(plugins, error);
    other.resetState();
}
