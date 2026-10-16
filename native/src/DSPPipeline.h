#pragma once

#include <atomic>
#include <cmath>
#include <functional>
#include <mutex>
#include <string>
#include <vector>
#include "PluginRack.h"

struct EQBand {
    std::string type;  // "peaking", "lowShelf", "highShelf"
    double freq;       // Hz
    double gain;       // dB
    double q;          // Q factor
};

struct CrossfeedConfig {
    bool enabled = false;
    double cutoffFrequencyHz = 700.0;
    double feedLevelDb = 5.0;
};

struct BiquadFilter {
    double b0 = 1, b1 = 0, b2 = 0;
    double a1 = 0, a2 = 0;
    double z1 = 0, z2 = 0;

    inline double process(double in) {
        double out = b0 * in + z1;
        z1 = b1 * in - a1 * out + z2;
        z2 = b2 * in - a2 * out;
        return out;
    }

    void reset() { z1 = z2 = 0; }
};

class DSPPipeline {
public:
    DSPPipeline() = default;
    explicit DSPPipeline(bool configOnly) : configOnly_(configOnly) {}
    // Process interleaved integer PCM in-place.
    // Called from decode thread — not real-time constrained.
    // When disabled, returns immediately (zero-copy passthrough).
    void process(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                 uint32_t bytesPerSample);

    // Process interleaved float32 in-place regardless of the output format —
    // used by the resampling path, which quantizes (with dither) afterwards.
    void processFloat(float* buffer, uint32_t numFrames, uint32_t numChannels);
    // Interleaved float64 in-place (the resampling path runs in double precision).
    void processDouble(double* buffer, uint32_t numFrames, uint32_t numChannels);

    // Store EQ profile and recalculate biquad coefficients if sample rate known.
    void setProfile(const std::vector<EQBand>& bands, double preampGainDb);
    void setCrossfeed(const CrossfeedConfig& config);

    // Update sample rate — recalculates coefficients from stored profile.
    void setSampleRate(double rate);

    // Inform the pipeline of the actual output format.
    // Must be called whenever the device is opened or its format changes.
    // isFloat = true  → samples in ring buffer are float32 (some DACs in exclusive mode)
    // isFloat = false → samples are signed integer (shared mode is always this)
    void setOutputFormat(bool isFloat, double sampleRate);

    void setEnabled(bool enabled);
    bool isEnabled() const { return enabled_.load(std::memory_order_relaxed); }

    // Reset filter delay lines (call on track change / seek).
    void resetState();

    void clearProfile();

    // Copy the current configuration into another pipeline instance using
    // fresh filter state. Useful when separate decode paths must not share
    // biquad state.
    void copyConfigTo(DSPPipeline& other) const;
    bool setPlugins(const std::vector<PluginSpec>& specs, std::string& error);
    bool setPluginParameter(size_t index, uint32_t id, double value, std::string& error);
    bool openPluginEditor(size_t index, std::function<void(uint32_t, double)> onChange,
                          std::function<void()> onDisable, std::string& error);

    bool hasProfile() const { return !profileBands_.empty(); }
    int getFilterCount() const { return static_cast<int>(profileBands_.size()); }

private:
    void processSamples(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                        uint32_t bytesPerSample, bool isFloat, bool clampFloat);
    BiquadFilter calculateBiquad(const EQBand& band, double sampleRate);
    BiquadFilter calculateLowpass(double cutoffFrequencyHz, double q, double sampleRate);
    void recalculate();  // must be called with mutex_ held

    mutable std::mutex mutex_;
    std::vector<EQBand> profileBands_;
    CrossfeedConfig crossfeedConfig_;
    double preampGainDb_ = 0;
    double preampLinear_ = 1.0;
    double crossfeedStrength_ = 0.0;
    double currentSampleRate_ = 0;
    bool isFloat_ = false;   // true when ring buffer holds float32 (set by setOutputFormat)
    std::atomic<bool> enabled_{false};

    // channels_[ch][filterIdx] — per-channel biquad chain with independent state
    std::vector<std::vector<BiquadFilter>> channels_;
    BiquadFilter crossfeedSideFilter_;
    std::vector<PluginSpec> pluginSpecs_;
    PluginRack plugins_;
    bool configOnly_ = false;
};
