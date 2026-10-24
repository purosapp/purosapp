#pragma once

#include <atomic>
#include <cmath>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include "PluginRack.h"
#include "PurosRestore.h"

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

struct RestoreStatus {
    RestoreConfig config;
    RestoreSourceClass source = RestoreSourceClass::Unknown;
    RestorePosition position = RestorePosition::Source;  // where this stream's stage runs
    bool inChain = false;    // the stage is running on this stream
    bool engaged = false;    // ...and restoring (else crossfaded to the delayed dry signal)
    double mix = 0.0;
    double sampleRate = 0.0;
    double latencySeconds = 0.0;
    RestoreAnalysis analysis;
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

    // Puros Restore. The configuration is global; the stage itself is per stream:
    // prepareRestoreStage() says where it runs, at what rate, and what the source is.
    // `external`: the float pipeline runs it through runRestoreStage() (sample-aligned,
    // latency trimmed); otherwise process() runs it in place on the output format.
    void setRestoreConfig(const RestoreConfig& config);
    RestoreConfig restoreConfig() const;
    bool restoreWouldEngage(RestoreSourceClass source) const;
    void prepareRestoreStage(bool external, RestorePosition position, double sampleRate, uint32_t channels,
                             RestoreSourceClass source);
    void setRestoreSource(RestoreSourceClass source);
    // Float pipeline: runs the stage if it sits at `position`. While the stage primes
    // `pcm` shrinks; at the end of the stream the delayed tail is appended.
    void runRestoreStage(RestorePosition position, std::vector<double>& pcm, uint32_t channels, bool atEnd);
    // In-place path at end of stream: the stage's delayed tail, through the rest of the
    // chain, in the output format. Returns 0 once nothing is left.
    uint32_t drainRestore(uint8_t* buffer, uint32_t maxFrames, uint32_t numChannels, uint32_t bytesPerSample);
    RestoreStatus restoreStatus() const;
    // Gapless successor: start from the detected cutoff instead of re-learning it.
    void seedRestoreFrom(const DSPPipeline& previous);

    bool hasProfile() const { return !profileBands_.empty(); }
    // True when EQ, crossfeed or an enabled plug-in would change the samples.
    bool isProcessing() const;
    int getFilterCount() const { return static_cast<int>(profileBands_.size()); }

private:
    void processSamples(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                        uint32_t bytesPerSample, bool isFloat, bool clampFloat);
    // mutex_ held. `restore`: run an in-place Restore stage too.
    void processChainLocked(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                            uint32_t bytesPerSample, bool isFloat, bool clampFloat, bool restore);
    void processEqAndPluginsLocked(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                                   uint32_t bytesPerSample, bool isFloat, bool clampFloat, bool processEq);
    void runRestoreInPlaceLocked(uint8_t* buffer, uint32_t numFrames, uint32_t numChannels,
                                 uint32_t bytesPerSample, bool isFloat, bool clampFloat);
    void updateRestoreLocked();
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

    RestoreConfig restoreConfig_;
    RestoreSourceClass restoreSource_ = RestoreSourceClass::Unknown;
    RestorePosition restoreStagePosition_ = RestorePosition::Source;
    bool restoreExternal_ = false;
    double restoreRate_ = 0.0;
    uint32_t restoreChannels_ = 0;
    std::unique_ptr<RestoreProcessor> restore_;
    bool restoreInChain_ = false;
    bool restoreStreamStarted_ = false;  // samples have flowed since the stream (re)started
    std::vector<double> restoreScratch_;
};
