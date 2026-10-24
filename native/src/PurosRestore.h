#pragma once

#include <Accelerate/Accelerate.h>
#include <AudioToolbox/AudioToolbox.h>
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// Puros Restore — adaptive restoration for perceptually coded (lossy) sources.
//
// Runs on the decode thread, on interleaved float64 PCM. Every buffer is sized in
// configure(); process() and flush() never allocate, lock or block.
//
// Signal flow (STFT: sqrt-Hann, 75 % overlap, ~23 ms frames at any rate):
//   - analysis: a long-term spectrum finds the codec's low-pass cutoff; hole and
//     flicker statistics give an adaptive severity estimate;
//   - artifact reduction: spectral holes below the cutoff are filled with
//     noise at the surrounding level, and flickering "birdie" bins are pulled
//     toward their running level;
//   - HF reconstruction: the octave below the cutoff is transposed up an octave
//     (phase-vocoder harmonic transposition) and scaled so the spectrum
//     continues its slope past the cutoff with a gentle roll-off; only the
//     deficit against what the codec kept is added;
//   - transient restoration (time domain, after the STFT): the STFT latency
//     gives the onset detector a lookahead, so pre-echo just before an attack is
//     attenuated and the attack's top end is lifted slightly.
// Output = delayed dry + mix · (restored − dry), with a delta limiter so the
// restoration itself never creates overs. Nothing claims to recover the
// discarded information: the added content is synthesized to be plausible.

enum class RestoreMode { Off, Manual, Auto };
enum class RestoreProfile { Adaptive, Natural, Detailed };
// Source: on the decoded signal, before resampling and the rest of the DSP chain.
// AfterDsp: after EQ, crossfeed and VST plug-ins, at the output rate.
enum class RestorePosition { Source, AfterDsp };
enum class RestoreSourceClass { Unknown, Lossy, Lossless, Dsd };

struct RestoreConfig {
    RestoreMode mode = RestoreMode::Off;
    RestoreProfile profile = RestoreProfile::Adaptive;
    double strength = 0.3;  // 0–1
    bool artifactReduction = true;
    bool hfReconstruction = true;
    bool transientRestoration = true;
    RestorePosition position = RestorePosition::Source;
};

// Whether restoration runs for a source of this class under `config`.
// Auto only takes confirmed lossy sources; DSD is never touched.
bool restoreEngagesFor(const RestoreConfig& config, RestoreSourceClass sourceClass);

// Source class from the decoder's actual codec (ExtAudioFile data format ID).
// Perceptual codecs are lossy; FLAC and ALAC are lossless. Linear PCM is lossless
// unless the caller's hint says it was decoded from a lossy codec upstream.
// `codecName` receives a display name ("MP3", "AAC", "FLAC", …).
RestoreSourceClass classifyRestoreSource(AudioFormatID formatId, RestoreSourceClass hint, std::string& codecName);

struct RestoreAnalysis {
    double cutoffHz = 0.0;     // detected codec low-pass; 0 = full bandwidth
    double confidence = 0.0;   // 0–1 for the cutoff
    double holeRate = 0.0;     // smoothed share of HF bins that were spectral holes
    double flickerRate = 0.0;  // smoothed share of HF bins flickering frame to frame
    double severity = 0.0;     // 0–1 adaptive estimate of audible coding damage
};

class RestoreProcessor {
public:
    // How a (re)started stream lines up with its input:
    //   Trim  — the first latency() frames are dropped and flush() returns the
    //           tail, so output is sample-aligned with input and the same length
    //           (callers that can change the block length: the float pipeline).
    //   Delay — fixed-length blocks; output is the input delayed by latency()
    //           (a fresh in-place stream: it starts with latency() of silence).
    //   Join  — fixed-length blocks joining a stream already playing: output
    //           starts as the undelayed input and crossfades into the delayed one.
    enum class Start { Trim, Delay, Join };
    static constexpr uint32_t kMaxChannels = 8;

    RestoreProcessor();
    ~RestoreProcessor();
    RestoreProcessor(const RestoreProcessor&) = delete;
    RestoreProcessor& operator=(const RestoreProcessor&) = delete;

    // Allocates everything for this rate / channel count. Not real-time safe.
    bool configure(double sampleRate, uint32_t channels);
    bool isConfiguredFor(double sampleRate, uint32_t channels) const;
    double sampleRate() const { return rate_; }
    uint32_t channels() const { return channels_; }
    size_t latency() const { return latency_; }

    void setConfig(const RestoreConfig& config);
    // Engaged: crossfade (~40 ms) into the restored signal; else into the delayed dry
    // signal, which is then passed through bit for bit.
    void setEngaged(bool engaged, bool immediate);
    bool engaged() const { return mixTarget_ > 0.0; }
    double mix() const { return mix_; }

    void reset(Start start, bool keepAnalysis);
    // In place; returns the frames written (fewer than `frames` while trimming).
    size_t process(double* interleaved, size_t frames);
    // Frames flush() will still produce at the end of the stream.
    size_t pendingTail() const;
    // Drains the latency tail into `out` (resumable); returns the frames written.
    size_t flush(double* out, size_t maxFrames);

    RestoreAnalysis analysis() const;
    // Warm start for a gapless successor: carries the detected cutoff and statistics.
    void seedAnalysis(const RestoreAnalysis& analysis);

private:
    struct PendingOnset {
        int64_t countdown = 0;   // samples until the onset reaches the output
        int64_t updating = 0;    // samples left in which the onset strength may still grow
        double strength = 0.0;   // fast / slow envelope ratio
        double level = 0.0;      // fast envelope at the onset
        double depth = 0.0;      // pre-echo attenuation (linear, 0–1)
        double lift = 0.0;       // attack lift of the high band (linear)
    };

    size_t run(const double* in, double* out, size_t frames);
    void processFrame();
    void analyzeAndRepair();
    void detectCutoff();
    void reconstructHighFrequencies(size_t kMax);
    void updateAmounts(bool immediate);
    void resetSignalState();
    void resetAnalysis();
    size_t binFor(double hz) const;
    double coefFor(double seconds) const;
    uint32_t nextRandom();

    // Format
    double rate_ = 0.0;
    uint32_t channels_ = 0;
    size_t n_ = 0;
    size_t half_ = 0;
    size_t hop_ = 0;
    size_t latency_ = 0;
    vDSP_Length log2n_ = 0;
    FFTSetupD fft_ = nullptr;
    double binHz_ = 0.0;
    double olaScale_ = 0.0;
    double magNorm_ = 0.0;   // packed FFT magnitude → full-scale sine amplitude

    // STFT state (per channel blocks of n_ / hop_ / half_)
    std::vector<double> window_;
    std::vector<double> inFifo_;
    std::vector<double> outAccum_;
    std::vector<double> outFifo_;
    std::vector<double> frame_;
    std::vector<double> re_;
    std::vector<double> im_;
    size_t rover_ = 0;

    // Analysis (linked across channels unless noted)
    std::vector<double> power_;
    std::vector<double> chanPower_;   // per channel
    std::vector<double> smooth_;
    std::vector<double> chanSmooth_;  // per channel
    std::vector<double> prevDb_;
    std::vector<double> flux_;
    std::vector<double> longTerm_;
    std::vector<double> ltDb_;
    std::vector<double> prefixA_;
    std::vector<uint8_t> dipped_;
    std::array<double, 1024> cosTable_{};
    std::array<double, 1024> sinTable_{};
    uint64_t framesAnalyzed_ = 0;
    uint64_t framesSinceReset_ = 0;
    uint64_t longTermFrames_ = 0;
    size_t cutoffBin_ = 0;
    size_t candidateBin_ = 0;
    int candidateCount_ = 0;
    double confidence_ = 0.0;
    double holeRate_ = 0.0;
    double flickerRate_ = 0.0;
    double severity_ = 0.0;
    std::array<double, kMaxChannels> hfRef_{};
    uint32_t rng_ = 0x9E3779B9u;

    // Module amounts (smoothed per frame)
    double artifactAmount_ = 0.0;
    double hfAmount_ = 0.0;
    double transientAmount_ = 0.0;

    // Dry path: interleaved ring of latency_ frames
    std::vector<double> dry_;
    size_t dryPos_ = 0;

    // Transient stage
    double detHpCoef_ = 0.0;
    double detPrevIn_ = 0.0;
    double detPrevOut_ = 0.0;
    double envFast_ = 0.0;
    double envSlow_ = 0.0;
    double fastAttack_ = 0.0, fastRelease_ = 0.0, slowAttack_ = 0.0, slowRelease_ = 0.0;
    int64_t refractory_ = 0;
    std::array<PendingOnset, 8> pending_{};
    size_t pendingCount_ = 0;
    double preGain_ = 1.0;
    double attackEnv_ = 0.0;
    double attackSmooth_ = 0.0;
    double attackDecay_ = 0.0;
    double gainAttackCoef_ = 0.0, gainReleaseCoef_ = 0.0, attackSmoothCoef_ = 0.0;
    int64_t preWindow_ = 0;
    int64_t preReleaseLead_ = 0;
    // Complementary crossover (2nd-order Butterworth low-pass); high = x − low.
    double xb0_ = 0, xb1_ = 0, xb2_ = 0, xa1_ = 0, xa2_ = 0;
    std::array<double, kMaxChannels> xz1_{};
    std::array<double, kMaxChannels> xz2_{};

    // Output
    double mix_ = 0.0;
    double mixTarget_ = 0.0;
    double mixStep_ = 0.0;
    double limGain_ = 1.0;
    double limRelease_ = 0.0;
    Start start_ = Start::Delay;
    size_t trimRemaining_ = 0;
    size_t joinPos_ = 0;
    size_t joinFade_ = 0;
    uint64_t inputFrames_ = 0;
    size_t flushFed_ = 0;  // silent frames fed by flush() so far
    bool spectralFault_ = false;

    RestoreConfig config_;
};
