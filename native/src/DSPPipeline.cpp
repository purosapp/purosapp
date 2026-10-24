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

bool DSPPipeline::isProcessing() const {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool eq = enabled_.load(std::memory_order_relaxed) &&
                    (!profileBands_.empty() || crossfeedConfig_.enabled);
    const bool plugins = std::any_of(pluginSpecs_.begin(), pluginSpecs_.end(),
                                     [](const PluginSpec& spec) { return spec.enabled; });
    return eq || plugins;
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
    std::lock_guard<std::mutex> lock(mutex_);
    processChainLocked(buffer, numFrames, numChannels, bytesPerSample, isFloat, clampFloat, true);
}

void DSPPipeline::processChainLocked(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                                     uint32_t bytesPerSample, bool isFloat, bool clampFloat, bool restore) {
    const bool eqEnabled = enabled_.load(std::memory_order_relaxed);
    const bool restoreHere = restore && !restoreExternal_ && restoreInChain_ && restore_ &&
                             numChannels == restoreChannels_;
    if (restore && numFrames > 0) restoreStreamStarted_ = true;
    if (restoreHere && restoreStagePosition_ == RestorePosition::Source) {
        runRestoreInPlaceLocked(buffer, numFrames, numChannels, bytesPerSample, isFloat, clampFloat);
    }

    const bool processEq = eqEnabled && !channels_.empty();
    if (processEq || plugins_.active()) processEqAndPluginsLocked(buffer, numFrames, numChannels, bytesPerSample,
                                                                  isFloat, clampFloat, processEq);

    if (restoreHere && restoreStagePosition_ == RestorePosition::AfterDsp) {
        runRestoreInPlaceLocked(buffer, numFrames, numChannels, bytesPerSample, isFloat, clampFloat);
    }
}

void DSPPipeline::processEqAndPluginsLocked(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                                            uint32_t bytesPerSample, bool isFloat, bool clampFloat,
                                            bool processEq) {
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
    // Seek / restart: the stage starts over on the same source, keeping what it learned.
    restoreInChain_ = false;
    restoreStreamStarted_ = false;
    updateRestoreLocked();
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
    RestoreConfig restoreConfig;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        restoreConfig = restoreConfig_;
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
    {
        // The stage itself is set up per stream by prepareRestoreStage().
        std::lock_guard<std::mutex> lock(other.mutex_);
        other.restoreConfig_ = restoreConfig;
    }
    other.resetState();
}

// ---------------------------------------------------------------------------
// Puros Restore
// ---------------------------------------------------------------------------

void DSPPipeline::setRestoreConfig(const RestoreConfig& config) {
    std::lock_guard<std::mutex> lock(mutex_);
    restoreConfig_ = config;
    updateRestoreLocked();
}

RestoreConfig DSPPipeline::restoreConfig() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return restoreConfig_;
}

bool DSPPipeline::restoreWouldEngage(RestoreSourceClass source) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return restoreEngagesFor(restoreConfig_, source);
}

void DSPPipeline::prepareRestoreStage(bool external, RestorePosition position, double sampleRate,
                                      uint32_t channels, RestoreSourceClass source) {
    std::lock_guard<std::mutex> lock(mutex_);
    restoreExternal_ = external;
    restoreStagePosition_ = position;
    restoreRate_ = sampleRate;
    restoreChannels_ = channels <= RestoreProcessor::kMaxChannels ? channels : 0;
    restoreSource_ = source;
    restoreInChain_ = false;
    restoreStreamStarted_ = false;
    // A new track learns its own cutoff (or is seeded by its gapless predecessor).
    if (restore_) restore_->reset(RestoreProcessor::Start::Delay, false);
    updateRestoreLocked();
}

void DSPPipeline::setRestoreSource(RestoreSourceClass source) {
    std::lock_guard<std::mutex> lock(mutex_);
    restoreSource_ = source;
    updateRestoreLocked();
}

// Decides whether the stage runs on this stream. Never called from a processing
// path: entering the chain may allocate (configure), which only the control side does.
void DSPPipeline::updateRestoreLocked() {
    if (configOnly_) return;
    const bool want = restoreRate_ > 0 && restoreChannels_ > 0 && restoreEngagesFor(restoreConfig_, restoreSource_);
    if (restore_) restore_->setConfig(restoreConfig_);
    if (restoreInChain_) {
        // Already running: crossfade in or out. The latency stays until the stream restarts,
        // so switching never shifts the timeline.
        restore_->setEngaged(want, false);
        return;
    }
    if (!want) return;
    if (!restore_) restore_ = std::make_unique<RestoreProcessor>();
    if (!restore_->configure(restoreRate_, restoreChannels_)) {
        std::fprintf(stderr, "[Puros] Restore unavailable at %.0f Hz / %u ch\n", restoreRate_, restoreChannels_);
        return;
    }
    restore_->setConfig(restoreConfig_);
    restoreScratch_.assign(std::max<size_t>(4096, restore_->latency()) * restoreChannels_, 0.0);
    // The float pipeline can drop the priming frames, so it stays sample-aligned. In place,
    // a fresh stream simply starts delayed; one already playing crossfades into the delay.
    const RestoreProcessor::Start start = restoreExternal_ ? RestoreProcessor::Start::Trim
        : restoreStreamStarted_ ? RestoreProcessor::Start::Join
        : RestoreProcessor::Start::Delay;
    restore_->reset(start, true);
    restore_->setEngaged(true, !restoreStreamStarted_);
    restoreInChain_ = true;
}

void DSPPipeline::runRestoreStage(RestorePosition position, std::vector<double>& pcm, uint32_t channels, bool atEnd) {
    std::lock_guard<std::mutex> lock(mutex_);
    const size_t frames = channels > 0 ? pcm.size() / channels : 0;
    if (!restoreExternal_ || position != restoreStagePosition_ || !restoreInChain_ || !restore_ ||
        channels != restoreChannels_) {
        if (frames > 0) restoreStreamStarted_ = true;
        return;
    }
    if (frames > 0) restoreStreamStarted_ = true;
    size_t produced = restore_->process(pcm.data(), frames);
    if (atEnd) {
        const size_t tail = restore_->pendingTail();
        pcm.resize((produced + tail) * channels);
        produced += restore_->flush(pcm.data() + produced * channels, tail);
    }
    pcm.resize(produced * channels);
}

namespace {

// Exact integer ↔ double for the in-place Restore stage: a bypassed stage hands
// back the identical integers.
inline double restoreRead(const uint8_t* ptr, uint32_t bytesPerSample, bool isFloat) {
    if (isFloat) {
        float f;
        std::memcpy(&f, ptr, 4);
        return f;
    }
    switch (bytesPerSample) {
        case 2: {
            int16_t v;
            std::memcpy(&v, ptr, 2);
            return v / 32768.0;
        }
        case 3: {
            int32_t v = ptr[0] | (ptr[1] << 8) | (ptr[2] << 16);
            if (v & 0x800000) v |= static_cast<int32_t>(0xFF000000u);
            return v / 8388608.0;
        }
        case 4: {
            int32_t v;
            std::memcpy(&v, ptr, 4);
            return v / 2147483648.0;
        }
        default:
            return 0.0;
    }
}

inline void restoreWrite(uint8_t* ptr, double v, uint32_t bytesPerSample, bool isFloat, bool clampFloat) {
    if (isFloat) {
        const float f = static_cast<float>(clampFloat ? std::clamp(v, -1.0, 1.0) : v);
        std::memcpy(ptr, &f, 4);
        return;
    }
    switch (bytesPerSample) {
        case 2: {
            const auto s = static_cast<int16_t>(std::clamp(std::lrint(v * 32768.0), -32768L, 32767L));
            std::memcpy(ptr, &s, 2);
            break;
        }
        case 3: {
            const auto s = static_cast<int32_t>(std::clamp(std::lrint(v * 8388608.0), -8388608L, 8388607L));
            ptr[0] = static_cast<uint8_t>(s & 0xFF);
            ptr[1] = static_cast<uint8_t>((s >> 8) & 0xFF);
            ptr[2] = static_cast<uint8_t>((s >> 16) & 0xFF);
            break;
        }
        case 4: {
            const auto s = static_cast<int32_t>(std::clamp(std::llrint(v * 2147483648.0), -2147483648LL, 2147483647LL));
            std::memcpy(ptr, &s, 4);
            break;
        }
    }
}

}  // namespace

void DSPPipeline::runRestoreInPlaceLocked(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                                          uint32_t bytesPerSample, bool isFloat, bool clampFloat) {
    if (isFloat && bytesPerSample == 8) {
        restore_->process(reinterpret_cast<double*>(buffer), numFrames);
        return;
    }
    if (bytesPerSample < 2 || bytesPerSample > 4 || (isFloat && bytesPerSample != 4)) return;
    const size_t chunk = restoreScratch_.size() / numChannels;
    for (uint32_t offset = 0; offset < numFrames;) {
        const uint32_t count = static_cast<uint32_t>(std::min<size_t>(chunk, numFrames - offset));
        uint8_t* base = buffer + static_cast<size_t>(offset) * numChannels * bytesPerSample;
        const size_t samples = static_cast<size_t>(count) * numChannels;
        for (size_t i = 0; i < samples; ++i) restoreScratch_[i] = restoreRead(base + i * bytesPerSample, bytesPerSample, isFloat);
        // Delay / Join keep the block length.
        restore_->process(restoreScratch_.data(), count);
        for (size_t i = 0; i < samples; ++i) {
            restoreWrite(base + i * bytesPerSample, restoreScratch_[i], bytesPerSample, isFloat, clampFloat);
        }
        offset += count;
    }
}

uint32_t DSPPipeline::drainRestore(uint8_t* buffer, uint32_t maxFrames, uint32_t numChannels, uint32_t bytesPerSample) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (restoreExternal_ || !restoreInChain_ || !restore_ || numChannels != restoreChannels_ || maxFrames == 0) return 0;
    if (bytesPerSample < 2 || bytesPerSample > 4 || (isFloat_ && bytesPerSample != 4)) return 0;
    const size_t capacity = std::min<size_t>(maxFrames, restoreScratch_.size() / numChannels);
    const auto frames = static_cast<uint32_t>(restore_->flush(restoreScratch_.data(), std::min(capacity, restore_->pendingTail())));
    for (size_t i = 0; i < static_cast<size_t>(frames) * numChannels; ++i) {
        restoreWrite(buffer + i * bytesPerSample, restoreScratch_[i], bytesPerSample, isFloat_, true);
    }
    // A stage before EQ still owes its tail the rest of the chain.
    if (frames > 0 && restoreStagePosition_ == RestorePosition::Source) {
        processChainLocked(buffer, frames, numChannels, bytesPerSample, isFloat_, true, false);
    }
    return frames;
}

RestoreStatus DSPPipeline::restoreStatus() const {
    std::lock_guard<std::mutex> lock(mutex_);
    RestoreStatus status;
    status.config = restoreConfig_;
    status.source = restoreSource_;
    status.position = restoreStagePosition_;
    status.sampleRate = restoreRate_;
    status.inChain = restoreInChain_ && restore_;
    if (status.inChain) {
        status.engaged = restore_->engaged();
        status.mix = restore_->mix();
        status.latencySeconds = restore_->sampleRate() > 0 ? restore_->latency() / restore_->sampleRate() : 0.0;
        status.analysis = restore_->analysis();
    }
    return status;
}

void DSPPipeline::seedRestoreFrom(const DSPPipeline& previous) {
    if (&previous == this) return;
    RestoreAnalysis analysis;
    {
        std::lock_guard<std::mutex> lock(previous.mutex_);
        if (!previous.restoreInChain_ || !previous.restore_) return;
        analysis = previous.restore_->analysis();
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (restoreInChain_ && restore_) restore_->seedAnalysis(analysis);
}
