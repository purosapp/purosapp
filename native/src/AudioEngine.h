#pragma once

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "DigitalVolume.h"
#include "DoPHelpers.h"
#include "DSPPipeline.h"
#include "Resampler.h"
#include "DsdModulator.h"
#include "VisualizerBuffer.h"

class ScopedDsdHogMode;

// Lock-free single-producer single-consumer ring buffer
class RingBuffer {
public:
    explicit RingBuffer(size_t capacity);
    ~RingBuffer();
    size_t write(const void* data, size_t bytes);
    size_t read(void* data, size_t bytes);
    size_t available() const;
    void reset();

private:
    uint8_t* buffer_;
    size_t capacity_;
    std::atomic<size_t> readPos_{0};
    std::atomic<size_t> writePos_{0};
};

struct SupportedFormat {
    double sampleRate;
    uint32_t bitDepth;
    bool isFloat;
    uint32_t channels;
};

struct AudioDevice {
    AudioDeviceID deviceId;
    std::string name;
    std::string uid;
    std::string routeParentUid;
    uint32_t channels;
    double sampleRate;
    uint32_t transportType = 0;   // kAudioDeviceTransportType* constant
    uint32_t routeDataSourceId = 0;
    bool isRouteEndpoint = false;
    bool isCurrentRoute = false;
    std::vector<SupportedFormat> supportedFormats;
    DoPCapability dopCapability = DoPCapability::FallbackPCM;
    bool hardwareVolume = false;  // DAC exposes a settable output volume control
};

// Output volume control exposed by the device itself (USB Audio Class feature
// unit, interface mixer, etc.). Changing it never touches the PCM samples.
struct HardwareVolumeInfo {
    bool supported = false;
    double scalar = 0.0;          // 0.0–1.0, device-defined taper
    double decibels = 0.0;
    double minDecibels = 0.0;
    double maxDecibels = 0.0;
    bool hasDecibels = false;
    bool muteSupported = false;
    bool muted = false;
};

struct DeviceFormat {
    double sampleRate;
    uint32_t bitDepth;
    uint32_t channels;
};

struct VisualizerSnapshot : VisualizerBuffer::Snapshot {
    float peak = 0.0f;
    float rms = 0.0f;
    bool paused = false;
    bool active = false;
};

// What the decode path does to the active track (for the signal-path UI).
struct ResamplerStatus {
    bool resampling = false;
    std::string engine;        // "fir" | "soxr" | "apple" | "" when the rate is untouched
    double inputRate = 0;
    double outputRate = 0;
    uint32_t ditherBits = 0;   // 0 → no dither applied
    std::string dither;        // "none" | "tpdf" | "gauss" | "shaped" | "shaped5" | "shaped9"
    std::string filter;        // "1x" | "nx" — which SoX filter the source rate selected
    bool deemphasis = false;
    double headroomDb = 0;
    double peakDb = -200;      // highest level before requantization (dBFS)
    uint64_t clippedSamples = 0;
    size_t firTaps = 0;
    size_t convolutionTaps = 0;
    std::string convolutionError;
    uint32_t dsdOutputRate = 0;        // PCM → DSD rate, 0 when not modulating
    std::string modulator;             // "sdm5" | "sdm7" | "sdm7ec"
    uint64_t modulatorOverloads = 0;
};

struct ProcessingStats {
    float speed = 0.0f;
    bool active = false;
};

enum class AudioMode { Closed, Shared, Exclusive };

enum class TrackSourceKind {
    None,
    ExtAudioFile,
    DsdDoP,
    ManualPcm,
};

struct DsdPlaybackState {
    FILE* file = nullptr;
    bool isDsf = false;
    bool bitReverseBytes = false;
    uint32_t channels = 0;
    uint32_t sourceSampleRate = 0;
    uint32_t carrierSampleRate = 0;
    uint64_t totalSamplesPerChannel = 0;
    uint64_t totalDoPFrames = 0;
    uint64_t dataOffset = 0;
    uint64_t dataSize = 0;
    uint32_t dsfBlockSizePerChannel = 0;
    uint64_t bytesConsumedPerChannel = 0;
    size_t dsfBlockByteIndex = 0;
    std::vector<uint8_t> dsfLeftBlock;
    std::vector<uint8_t> dsfRightBlock;
    std::vector<uint8_t> dffInterleavedBuffer;
    size_t dffBufferOffset = 0;
    size_t dffBufferValid = 0;
    bool markerPhase = false;
    uint32_t primerFramesRemaining = 0;
};

struct TrackSlot {
    std::unique_ptr<RingBuffer> ringBuffer;
    ExtAudioFileRef extAudioFile = nullptr;
    std::thread decodeThread;
    DSPPipeline dsp;
    std::atomic<bool> stopDecode{false};
    std::atomic<bool> fileEof{false};
    std::atomic<bool> prepared{false};
    std::atomic<int64_t> framesRead{0};
    std::atomic<int64_t> framesPlayed{0};
    int64_t totalFrames = 0;
    double fileSampleRate = 0;
    std::string filePath;
    AudioStreamBasicDescription renderFormat{};
    TrackSourceKind sourceKind = TrackSourceKind::None;
    DsdPlaybackState dsd;
    bool bypassDsp = false;

    // Resampling / requantization path: the file is decoded to float32 at
    // `decodeRate`, optionally resampled by SoX, run through DSP, then quantized
    // (with dither) to renderFormat. Off for bit-perfect playback.
    bool floatPipeline = false;
    double decodeRate = 0;
    ResamplerEngine srcEngine = ResamplerEngine::Soxr;
    bool rateConverted = false;
    std::unique_ptr<SoxrResampler> resampler;
    OutputQuantizer quantizer;
    DitherMode ditherMode = DitherMode::None;
    bool filterNx = false;
    bool deemphasis = false;
    DeemphasisFilter deemphasisFilter;
    double headroomGain = 1.0;
    double headroomDb = 0.0;
    std::unique_ptr<FirResampler> firResampler;
    std::unique_ptr<FftConvolver> roomConvolver;
    size_t convolutionTaps = 0;
    size_t convolutionTrim = 0;
    size_t convolutionTrimmed = 0;
    size_t convolutionInputFrames = 0;
    std::vector<double> convolutionScratch;
    std::string convolutionError;

    // PCM → DSD: the encoder replaces the quantizer; renderFormat is the DoP carrier.
    std::unique_ptr<DsdEncoder> dsdEncoder;
    bool dopOutput = false;
    ModulatorType modulator = ModulatorType::Order7;
    std::atomic<uint64_t> modulatorOverloads{0};
    std::atomic<uint64_t> clippedSamples{0};
    std::atomic<float> peakLevel{0.0f};
};

class AudioEngine {
public:
    AudioEngine();
    ~AudioEngine();

    std::vector<AudioDevice> listDevices();

    bool openExclusive(const std::string& deviceUid, double sampleRate,
                       uint32_t bitDepth, bool preferNonMixableInteger, std::string& error);
    bool openShared(const std::string& deviceUid, std::string& error);

    // `allowResample`: the caller already opened the output at the format it
    // wants for this track, so a different source rate is resampled instead of
    // reopening the device at the source rate.
    // `deemphasis`: the source carries CD pre-emphasis (50/15 µs) to undo.
    // `dsdOutputRate` > 0: modulate the PCM source to DSD at that rate and send it as DoP.
    bool playFile(const std::string& filePath, bool allowResample, bool deemphasis, uint32_t dsdOutputRate,
                  std::string& error);
    bool startPcmStream(std::string& error);
    bool queueNextFile(const std::string& filePath, bool allowResample, bool deemphasis, uint32_t dsdOutputRate,
                       std::string& error);
    void clearQueuedFile();
    void stopPlayback();
    void pause();
    void resume();
    void seek(double position);

    void write(const void* data, size_t bytes);

    AudioMode getMode() const { return mode_; }
    double getPosition() const;
    double getDuration() const;
    bool isPaused() const { return paused_.load(); }
    bool isTrackEnded() const;
    bool consumeQueuedAdvance();
    VisualizerSnapshot getVisualizerSnapshot() const;
    ProcessingStats getProcessingStats() const;

    // Format queries
    DeviceFormat getCurrentFormat() const;

    // Resampler / dither settings, applied to tracks prepared after the call.
    void setResamplerConfig(const ResamplerConfig& config);
    ResamplerStatus getResamplerStatus() const;

    void setVolume(float gain);   // 0.0–1.0; shared-mode HAL volume, no-op in exclusive mode

    // Exclusive-mode digital (DSP) volume. Linear gain 0.0–1.0 applied in the
    // IOProc so it reacts immediately instead of after the decode ring buffer.
    // At exactly 1.0 samples are left untouched, so output stays bit-perfect.
    void setDigitalVolume(double gain);
    double getDigitalVolume() const { return digitalVolume_.target(); }

    // Device (hardware) volume — keeps the digital stream bit-perfect.
    HardwareVolumeInfo getHardwareVolume(const std::string& deviceUid);
    bool setHardwareVolume(const std::string& deviceUid, double scalar, std::string& error);
    bool setHardwareMute(const std::string& deviceUid, bool muted, std::string& error);

    // Audio Setup: CoreAudio IO buffer options applied when the device opens in
    // exclusive mode (largest size and/or power-of-two rounding).
    void setHardwareBufferOptions(const std::string& deviceUid, bool useMax, bool powerOfTwo);

    // DSP / EQ
    void setEQProfile(const std::vector<EQBand>& bands, double preampGainDb);
    void setCrossfeed(bool enabled, double cutoffFrequency, double feedLevelDb);
    bool setPlugins(const std::vector<PluginSpec>& specs, std::string& error);
    std::vector<PluginParameter> getPluginParameters(size_t index);
    bool setPluginParameter(size_t index, uint32_t id, double value, std::string& error);
    bool openPluginEditor(size_t index,
                          std::function<void(size_t, uint32_t, double)> onChange,
                          std::function<void(size_t)> onDisable,
                          std::string& error);
    void setEQEnabled(bool enabled);
    bool getEQEnabled() const;
    void clearEQProfile();

    void close();

private:
    AudioDeviceID findDeviceByUid(const std::string& uid);
    bool selectOutputDataSource(AudioDeviceID device, const std::string& deviceUid, std::string& error);
    void applyHardwareBufferOptions(AudioDeviceID device, const std::string& deviceUid);
    void restoreHardwareBufferSize();

    // Exclusive mode helpers
    bool disableMixing(AudioDeviceID device, std::string& error);
    void restoreMixing();
    bool hogDevice(AudioDeviceID device, std::string& error);
    void unhogDevice();
    bool setDeviceSampleRate(AudioDeviceID device, double rate);
    bool findBestFormat(AudioDeviceID device, double sampleRate, uint32_t bitDepth,
                        bool preferNonMixableInteger,
                        AudioStreamBasicDescription& outFormat);
    AudioStreamID getOutputStream(AudioDeviceID device);
    bool setStreamFormat(AudioStreamID stream, AudioObjectPropertySelector selector,
                         const AudioStreamBasicDescription& format);
    bool waitForStreamFormat(AudioStreamID stream, AudioObjectPropertySelector selector,
                             const AudioStreamBasicDescription& expected, int timeoutMs, bool rateOnly);
    void restoreOriginalStreamFormats(AudioStreamID stream);
    bool reconfigureExclusive(double sampleRate, uint32_t bitDepth, std::string& error);
    bool setPhysicalFormat(AudioDeviceID device, const AudioStreamBasicDescription& format);
    bool verifyPhysicalFormat(AudioDeviceID device, const AudioStreamBasicDescription& expected);
    void refreshActiveStreamFormats(const AudioStreamBasicDescription* fallback = nullptr);
    bool activateDsdOutputMode(const AudioStreamBasicDescription& requestedFormat, std::string& error);
    void deactivateDsdOutputMode(bool restartIo = true);

    // Audio callbacks (real-time thread — no allocations, no locks)
    static OSStatus exclusiveIOProc(AudioDeviceID device, const AudioTimeStamp* now,
                                    const AudioBufferList* inputData,
                                    const AudioTimeStamp* inputTime,
                                    AudioBufferList* outputData,
                                    const AudioTimeStamp* outputTime, void* clientData);

    static OSStatus sharedRenderCallback(void* inRefCon,
                                         AudioUnitRenderActionFlags* ioActionFlags,
                                         const AudioTimeStamp* inTimeStamp,
                                         UInt32 inBusNumber, UInt32 inNumberFrames,
                                         AudioBufferList* ioData);

    // File decode thread
    bool prepareTrackSlot(int slotIndex, const std::string& filePath, std::string& error,
                          bool allowDeviceReopen, bool allowResample, bool deemphasis, uint32_t dsdOutputRate);
    bool prepareDopOutput(int slotIndex, uint32_t dsdRate, bool allowDeviceReopen,
                          AudioStreamBasicDescription& dopFormatOut, std::string& error);
    bool configureDecodePipeline(TrackSlot& slot, const AudioStreamBasicDescription& sourceFormat,
                                 bool deemphasis, uint32_t dsdOutputRate, std::string& error);
    void applyRoomCorrection(TrackSlot& slot, std::vector<double>& pcm, uint32_t channels, bool atEnd);
    void decodeThreadFunc(int slotIndex);
    void stopDecodeThread(int slotIndex);
    void resetTrackSlot(int slotIndex);
    bool canGaplesslyQueueSourceFormat(const AudioStreamBasicDescription& sourceFormat) const;
    bool tryPromoteQueuedSlot();
    void cleanupRetiredSlot();
    int getInactiveSlotIndex() const;
    TrackSlot* getActiveSlot();
    const TrackSlot* getActiveSlot() const;
    void resetVisualizerState();
    void captureVisualizerSamples(const AudioBufferList* bufferList, const AudioStreamBasicDescription& format);

    // State
    AudioMode mode_ = AudioMode::Closed;
    AudioDeviceID activeDeviceId_ = kAudioObjectUnknown;
    std::string activeDeviceUid_;

    // Exclusive mode
    AudioDeviceIOProcID ioProcId_ = nullptr;
    AudioStreamBasicDescription originalPhysicalFormat_{};
    AudioStreamBasicDescription originalVirtualFormat_{};
    bool formatChanged_ = false;
    pid_t hogPid_ = -1;
    bool mixingDisabled_ = false;
    UInt32 originalMixing_ = 1;

    struct HardwareBufferOptions {
        bool useMax = false;
        bool powerOfTwo = false;
    };
    std::mutex bufferOptionsMutex_;
    std::map<std::string, HardwareBufferOptions> bufferOptions_;
    AudioDeviceID bufferFramesDevice_ = kAudioObjectUnknown;
    UInt32 originalBufferFrames_ = 0;

    // Shared mode
    AudioUnit audioUnit_ = nullptr;

    // Common audio
    AudioStreamBasicDescription outputFormat_{};
    AudioStreamBasicDescription physicalOutputFormat_{};
    AudioStreamBasicDescription virtualOutputFormat_{};
    std::array<TrackSlot, 2> trackSlots_{};
    std::atomic<int> activeSlotIndex_{-1};
    std::atomic<int> queuedSlotIndex_{-1};
    std::atomic<int> retiredSlotIndex_{-1};
    std::atomic<bool> queuedAdvancePending_{false};
    std::atomic<bool> paused_{false};

    std::mutex writeMutex_;

    DSPPipeline dsp_{true};
    std::vector<PluginSpec> pluginSpecs_;
    std::unique_ptr<ScopedDsdHogMode> dsdHogMode_;
    VisualizerBuffer visualizerBuffer_;
    std::atomic<float> visualizerPeak_{0.0f};
    std::atomic<float> visualizerRms_{0.0f};
    std::atomic<float> processingSpeed_{0.0f};
    DigitalVolume digitalVolume_;

    mutable std::mutex resamplerConfigMutex_;
    ResamplerConfig resamplerConfig_;
};
