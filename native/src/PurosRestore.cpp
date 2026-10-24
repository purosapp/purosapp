#include "PurosRestore.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTiny = 1e-24;
// Levels are in full-scale-sine units: 1.0 = a 0 dBFS sine.
constexpr double kSilentFrame = 1e-9;      // −90 dB: frame too quiet to learn from
constexpr double kHoleThreshold = 0.063;   // −12 dB below the bin's own recent level
constexpr size_t kHoleMinRun = 3;          // codec holes span scale-factor bands, noise dips single bins
constexpr size_t kHoleMaxRun = 64;         // wider drops are the music (a choke, a release)
constexpr double kHoleContrast = 16.0;     // neighbours ≥ 12 dB above the run
constexpr double kHoleFloor = 1e-8;        // −80 dB: below this a "hole" is just quiet
constexpr double kFlickerFluxDb = 10.0;    // mean frame-to-frame change of a flickering bin
constexpr double kOnsetRatio = 2.82;       // +9 dB fast over slow envelope
constexpr double kOnsetFloor = 1e-3;       // −60 dB
constexpr double kCeiling = 1.0;
constexpr double kMaxPreEchoDepth = 0.6;   // −8 dB at full strength
constexpr double kMaxAttackLift = 0.413;   // +3 dB at full strength

double clamp01(double v) { return std::clamp(v, 0.0, 1.0); }

double smoothstep(double v) {
    v = clamp01(v);
    return v * v * (3.0 - 2.0 * v);
}

struct Tuning {
    double hfOffsetDb;
    double hfTiltDbPerKhz;
    double artifact;
    double hf;
    double transient;
    double attackDecaySec;
};

const Tuning& tuningFor(RestoreProfile profile) {
    // Adaptive derives its module amounts from the analysis; the others are fixed.
    static const Tuning adaptive{4.5, -2.0, 0.0, 1.0, 0.0, 0.014};
    static const Tuning natural{7.0, -3.0, 0.6, 0.75, 0.5, 0.010};
    static const Tuning detailed{3.0, -1.2, 1.0, 1.0, 1.0, 0.018};
    switch (profile) {
        case RestoreProfile::Natural: return natural;
        case RestoreProfile::Detailed: return detailed;
        default: return adaptive;
    }
}

}  // namespace

bool restoreEngagesFor(const RestoreConfig& config, RestoreSourceClass sourceClass) {
    if (sourceClass == RestoreSourceClass::Dsd) return false;
    switch (config.mode) {
        case RestoreMode::Manual: return true;
        case RestoreMode::Auto: return sourceClass == RestoreSourceClass::Lossy;
        default: return false;
    }
}

RestoreSourceClass classifyRestoreSource(AudioFormatID formatId, RestoreSourceClass hint, std::string& codecName) {
    switch (formatId) {
        case kAudioFormatMPEGLayer1: codecName = "MP1"; return RestoreSourceClass::Lossy;
        case kAudioFormatMPEGLayer2: codecName = "MP2"; return RestoreSourceClass::Lossy;
        case kAudioFormatMPEGLayer3: codecName = "MP3"; return RestoreSourceClass::Lossy;
        case kAudioFormatMPEG4AAC:
        case kAudioFormatMPEG4AAC_Spatial: codecName = "AAC"; return RestoreSourceClass::Lossy;
        case kAudioFormatMPEG4AAC_HE: codecName = "HE-AAC"; return RestoreSourceClass::Lossy;
        case kAudioFormatMPEG4AAC_HE_V2: codecName = "HE-AAC v2"; return RestoreSourceClass::Lossy;
        case kAudioFormatMPEG4AAC_LD: codecName = "AAC-LD"; return RestoreSourceClass::Lossy;
        case kAudioFormatMPEG4AAC_ELD:
        case kAudioFormatMPEG4AAC_ELD_SBR:
        case kAudioFormatMPEG4AAC_ELD_V2: codecName = "AAC-ELD"; return RestoreSourceClass::Lossy;
        case kAudioFormatMPEGD_USAC: codecName = "USAC"; return RestoreSourceClass::Lossy;
        case kAudioFormatOpus: codecName = "Opus"; return RestoreSourceClass::Lossy;
        case 'vorb': codecName = "Vorbis"; return RestoreSourceClass::Lossy;
        case kAudioFormatAC3:
        case kAudioFormat60958AC3: codecName = "AC-3"; return RestoreSourceClass::Lossy;
        case kAudioFormatEnhancedAC3: codecName = "E-AC-3"; return RestoreSourceClass::Lossy;
        case kAudioFormatAMR:
        case kAudioFormatAMR_WB: codecName = "AMR"; return RestoreSourceClass::Lossy;
        case kAudioFormatiLBC: codecName = "iLBC"; return RestoreSourceClass::Lossy;
        case kAudioFormatMicrosoftGSM: codecName = "GSM"; return RestoreSourceClass::Lossy;
        case kAudioFormatQDesign:
        case kAudioFormatQDesign2: codecName = "QDesign"; return RestoreSourceClass::Lossy;
        case kAudioFormatMACE3:
        case kAudioFormatMACE6: codecName = "MACE"; return RestoreSourceClass::Lossy;
        case kAudioFormatAppleIMA4: codecName = "IMA ADPCM"; return RestoreSourceClass::Lossy;
        case kAudioFormatULaw:
        case kAudioFormatALaw: codecName = "G.711"; return RestoreSourceClass::Lossy;
        case kAudioFormatFLAC: codecName = "FLAC"; return RestoreSourceClass::Lossless;
        case kAudioFormatAppleLossless: codecName = "ALAC"; return RestoreSourceClass::Lossless;
        case kAudioFormatLinearPCM:
            // A PCM container is lossless unless it holds an upstream lossy decode
            // (or a DSD → PCM conversion) that the caller knows about.
            codecName = hint == RestoreSourceClass::Dsd ? "DSD (PCM)" : "PCM";
            return hint == RestoreSourceClass::Lossy || hint == RestoreSourceClass::Dsd
                ? hint
                : RestoreSourceClass::Lossless;
        default: {
            char fourcc[5] = {
                static_cast<char>((formatId >> 24) & 0xFF), static_cast<char>((formatId >> 16) & 0xFF),
                static_cast<char>((formatId >> 8) & 0xFF), static_cast<char>(formatId & 0xFF), 0,
            };
            codecName = fourcc;
            // The decoder did not identify it; only the caller's codec metadata can.
            return hint == RestoreSourceClass::Lossy ? hint : RestoreSourceClass::Unknown;
        }
    }
}

RestoreProcessor::RestoreProcessor() {
    for (size_t i = 0; i < cosTable_.size(); ++i) {
        const double phase = 2.0 * kPi * static_cast<double>(i) / static_cast<double>(cosTable_.size());
        cosTable_[i] = std::cos(phase);
        sinTable_[i] = std::sin(phase);
    }
}

RestoreProcessor::~RestoreProcessor() {
    if (fft_) vDSP_destroy_fftsetupD(fft_);
}

bool RestoreProcessor::isConfiguredFor(double sampleRate, uint32_t channels) const {
    return fft_ && channels_ == channels && std::abs(rate_ - sampleRate) < 0.5;
}

bool RestoreProcessor::configure(double sampleRate, uint32_t channels) {
    if (!(sampleRate >= 8000.0) || sampleRate > 1.6e6 || channels == 0 || channels > kMaxChannels) return false;
    if (isConfiguredFor(sampleRate, channels)) return true;

    // ~23 ms frames at every rate keep the time/frequency trade-off (and the latency) constant.
    const int log2n = std::clamp(static_cast<int>(std::lround(std::log2(sampleRate * 0.0232))), 9, 14);
    FFTSetupD setup = vDSP_create_fftsetupD(static_cast<vDSP_Length>(log2n), kFFTRadix2);
    if (!setup) return false;
    if (fft_) vDSP_destroy_fftsetupD(fft_);
    fft_ = setup;

    rate_ = sampleRate;
    channels_ = channels;
    log2n_ = static_cast<vDSP_Length>(log2n);
    n_ = size_t{1} << log2n;
    half_ = n_ / 2;
    hop_ = n_ / 4;
    latency_ = n_ - 1;
    binHz_ = sampleRate / static_cast<double>(n_);

    window_.assign(n_, 0.0);
    double windowSum = 0.0;
    for (size_t i = 0; i < n_; ++i) {
        window_[i] = std::sqrt(0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(n_)));
        windowSum += window_[i];
    }
    // sqrt-Hann analysis × synthesis is a periodic Hann, which sums to 2 at a quarter-frame
    // hop; vDSP's real FFT round trip scales by 2n.
    olaScale_ = 1.0 / (4.0 * static_cast<double>(n_));
    // A sine's packed (2×) peak bin is amplitude · Σwindow.
    magNorm_ = 1.0 / windowSum;

    const size_t c = channels;
    inFifo_.assign(c * n_, 0.0);
    outAccum_.assign(c * n_, 0.0);
    outFifo_.assign(c * hop_, 0.0);
    frame_.assign(n_, 0.0);
    re_.assign(c * half_, 0.0);
    im_.assign(c * half_, 0.0);
    power_.assign(half_, 0.0);
    chanPower_.assign(c * half_, 0.0);
    smooth_.assign(half_, 0.0);
    chanSmooth_.assign(c * half_, 0.0);
    prevDb_.assign(half_, 0.0);
    flux_.assign(half_, 0.0);
    longTerm_.assign(half_, 0.0);
    ltDb_.assign(half_, 0.0);
    prefixA_.assign(half_ + 1, 0.0);
    dipped_.assign(half_ + 1, 0);
    dry_.assign(latency_ * c, 0.0);

    // Transient detector: 2 kHz high-pass, then fast and slow envelopes.
    const double rc = 1.0 / (2.0 * kPi * 2000.0);
    detHpCoef_ = rc / (rc + 1.0 / sampleRate);
    fastAttack_ = coefFor(0.0002);
    fastRelease_ = coefFor(0.010);
    slowAttack_ = coefFor(0.030);
    slowRelease_ = coefFor(0.250);
    gainAttackCoef_ = coefFor(0.002);
    gainReleaseCoef_ = coefFor(0.0004);
    attackSmoothCoef_ = coefFor(0.0003);
    preWindow_ = std::min<int64_t>(static_cast<int64_t>(latency_) - 1, std::llround(0.012 * sampleRate));
    preReleaseLead_ = std::llround(0.0007 * sampleRate);

    // Crossover for the transient stage: 2 kHz Butterworth low-pass (RBJ cookbook).
    const double w0 = 2.0 * kPi * 2000.0 / sampleRate;
    const double alpha = std::sin(w0) / (2.0 * std::sqrt(0.5));
    const double a0 = 1.0 + alpha;
    xb0_ = (1.0 - std::cos(w0)) * 0.5 / a0;
    xb1_ = (1.0 - std::cos(w0)) / a0;
    xb2_ = xb0_;
    xa1_ = -2.0 * std::cos(w0) / a0;
    xa2_ = (1.0 - alpha) / a0;

    mixStep_ = 1.0 / (0.040 * sampleRate);
    limRelease_ = coefFor(0.005);
    joinFade_ = static_cast<size_t>(std::llround(0.020 * sampleRate));

    setConfig(config_);
    resetAnalysis();
    reset(Start::Delay, true);
    return true;
}

double RestoreProcessor::coefFor(double seconds) const {
    return std::exp(-1.0 / (seconds * rate_));
}

size_t RestoreProcessor::binFor(double hz) const {
    if (binHz_ <= 0) return 0;
    return std::min(half_ - 1, static_cast<size_t>(std::lround(std::max(0.0, hz) / binHz_)));
}

uint32_t RestoreProcessor::nextRandom() {
    rng_ ^= rng_ << 13;
    rng_ ^= rng_ >> 17;
    rng_ ^= rng_ << 5;
    return rng_;
}

void RestoreProcessor::setConfig(const RestoreConfig& config) {
    config_ = config;
    config_.strength = std::isfinite(config.strength) ? clamp01(config.strength) : 0.0;
    if (rate_ > 0) attackDecay_ = coefFor(tuningFor(config_.profile).attackDecaySec);
}

void RestoreProcessor::setEngaged(bool engaged, bool immediate) {
    mixTarget_ = engaged ? 1.0 : 0.0;
    if (immediate) mix_ = mixTarget_;
}

void RestoreProcessor::resetSignalState() {
    std::fill(inFifo_.begin(), inFifo_.end(), 0.0);
    std::fill(outAccum_.begin(), outAccum_.end(), 0.0);
    std::fill(outFifo_.begin(), outFifo_.end(), 0.0);
    std::fill(dry_.begin(), dry_.end(), 0.0);
    std::fill(smooth_.begin(), smooth_.end(), 0.0);
    std::fill(chanSmooth_.begin(), chanSmooth_.end(), 0.0);
    std::fill(prevDb_.begin(), prevDb_.end(), 0.0);
    rover_ = n_ - hop_;
    dryPos_ = 0;
    framesSinceReset_ = 0;
    hfRef_.fill(0.0);
    detPrevIn_ = detPrevOut_ = 0.0;
    envFast_ = envSlow_ = 0.0;
    refractory_ = 0;
    pendingCount_ = 0;
    preGain_ = 1.0;
    attackEnv_ = attackSmooth_ = 0.0;
    xz1_.fill(0.0);
    xz2_.fill(0.0);
    limGain_ = 1.0;
    spectralFault_ = false;
}

void RestoreProcessor::resetAnalysis() {
    std::fill(longTerm_.begin(), longTerm_.end(), 0.0);
    std::fill(flux_.begin(), flux_.end(), 0.0);
    framesAnalyzed_ = 0;
    longTermFrames_ = 0;
    cutoffBin_ = 0;
    candidateBin_ = 0;
    candidateCount_ = 0;
    confidence_ = 0.0;
    holeRate_ = flickerRate_ = severity_ = 0.0;
    updateAmounts(true);
}

void RestoreProcessor::reset(Start start, bool keepAnalysis) {
    resetSignalState();
    if (!keepAnalysis) resetAnalysis();
    start_ = start;
    trimRemaining_ = start == Start::Trim ? latency_ : 0;
    joinPos_ = 0;
    inputFrames_ = 0;
    flushFed_ = 0;
    // Callers choose whether the restored signal is in immediately (setEngaged).
    mix_ = 0.0;
}

size_t RestoreProcessor::process(double* interleaved, size_t frames) {
    if (!fft_ || frames == 0) return frames;
    inputFrames_ += frames;
    return run(interleaved, interleaved, frames);
}

size_t RestoreProcessor::pendingTail() const {
    if (!fft_ || inputFrames_ == 0) return 0;
    // Feeding the remaining silence yields one frame per sample once trimming is done.
    const size_t feed = latency_ - flushFed_;
    const size_t trim = start_ == Start::Trim ? trimRemaining_ : 0;
    return feed > trim ? feed - trim : 0;
}

size_t RestoreProcessor::flush(double* out, size_t maxFrames) {
    if (!fft_ || inputFrames_ == 0) return 0;
    size_t written = 0;
    // Feed silence until the delayed tail is out; resumable across calls.
    while (flushFed_ < latency_ && written < maxFrames) {
        written += run(nullptr, out + written * channels_, 1);
        ++flushFed_;
    }
    return written;
}

RestoreAnalysis RestoreProcessor::analysis() const {
    RestoreAnalysis result;
    result.cutoffHz = cutoffBin_ > 0 ? static_cast<double>(cutoffBin_) * binHz_ : 0.0;
    result.confidence = confidence_;
    result.holeRate = holeRate_;
    result.flickerRate = flickerRate_;
    result.severity = severity_;
    return result;
}

void RestoreProcessor::seedAnalysis(const RestoreAnalysis& analysis) {
    if (!fft_) return;
    if (analysis.cutoffHz > 0 && analysis.cutoffHz < rate_ * 0.5) {
        cutoffBin_ = binFor(analysis.cutoffHz);
        candidateBin_ = cutoffBin_;
        confidence_ = clamp01(analysis.confidence);
    }
    holeRate_ = clamp01(analysis.holeRate);
    flickerRate_ = clamp01(analysis.flickerRate);
    updateAmounts(true);
}

// ---------------------------------------------------------------------------
// Sample loop
// ---------------------------------------------------------------------------

size_t RestoreProcessor::run(const double* in, double* out, size_t frames) {
    const uint32_t channelCount = channels_;
    const size_t fifoStart = n_ - hop_;
    double x[kMaxChannels];
    double wet[kMaxChannels];
    double dry[kMaxChannels];
    double y[kMaxChannels];
    size_t written = 0;

    for (size_t i = 0; i < frames; ++i) {
        // Input: into the STFT FIFO (non-finite samples become silence).
        double mono = 0.0;
        for (uint32_t c = 0; c < channelCount; ++c) {
            double v = in ? in[i * channelCount + c] : 0.0;
            if (!std::isfinite(v)) v = 0.0;
            x[c] = v;
            inFifo_[c * n_ + rover_] = v;
            mono += v;
        }
        if (++rover_ == n_) {
            processFrame();
            rover_ = fifoStart;
        }
        const size_t readIndex = rover_ - fifoStart;

        // Onset detector on the undelayed input: the output lags by latency_, so every
        // onset is known that long before it is heard.
        const double hp = detHpCoef_ * (detPrevOut_ + mono / channelCount - detPrevIn_);
        detPrevIn_ = mono / channelCount;
        detPrevOut_ = hp;
        const double level = std::fabs(hp);
        envFast_ = level + (envFast_ - level) * (level > envFast_ ? fastAttack_ : fastRelease_);
        envSlow_ = level + (envSlow_ - level) * (level > envSlow_ ? slowAttack_ : slowRelease_);
        const double ratio = envFast_ / (envSlow_ + 1e-9);
        if (refractory_ > 0) --refractory_;
        for (size_t p = 0; p < pendingCount_; ++p) {
            PendingOnset& onset = pending_[p];
            if (onset.updating <= 0) continue;
            onset.strength = std::max(onset.strength, ratio);
            onset.level = std::max(onset.level, envFast_);
            if (--onset.updating == 0) {
                // Pre-echo is audible when the attack rises far above what precedes it.
                const double riseDb = 20.0 * std::log10(onset.strength);
                onset.depth = kMaxPreEchoDepth * transientAmount_ * clamp01((riseDb - 12.0) / 18.0);
                onset.lift = kMaxAttackLift * transientAmount_ * clamp01((riseDb - 9.0) / 15.0);
            }
        }
        if (envFast_ > kOnsetFloor && ratio > kOnsetRatio) {
            const int64_t measure = std::llround(0.0015 * rate_);
            if (refractory_ == 0 && pendingCount_ < pending_.size()) {
                pending_[pendingCount_++] = {static_cast<int64_t>(latency_) + 1, measure, ratio, envFast_, 0.0, 0.0};
                refractory_ = std::llround(0.025 * rate_);
            } else if (pendingCount_ > 0) {
                // Far louder (+12 dB) shortly after a trigger: that trigger was this
                // attack's own pre-echo rising out of silence. The attack replaces it.
                PendingOnset& newest = pending_[pendingCount_ - 1];
                if (envFast_ > 4.0 * newest.level &&
                    newest.countdown > static_cast<int64_t>(latency_) - preWindow_) {
                    const double rise = std::max(ratio, envFast_ / newest.level);
                    newest = {static_cast<int64_t>(latency_) + 1, measure, rise, envFast_, 0.0, 0.0};
                    refractory_ = std::llround(0.025 * rate_);
                }
            }
        }

        // High-band gain for the output sample: dip ahead of attacks, lift on them.
        double preTarget = 1.0;
        size_t kept = 0;
        for (size_t p = 0; p < pendingCount_; ++p) {
            PendingOnset onset = pending_[p];
            if (--onset.countdown <= 0) {
                attackEnv_ = std::max(attackEnv_, onset.lift);
                continue;
            }
            if (onset.countdown <= preWindow_ && onset.countdown > preReleaseLead_) {
                preTarget = std::min(preTarget, 1.0 - onset.depth);
            }
            pending_[kept++] = onset;
        }
        pendingCount_ = kept;
        preGain_ = preTarget + (preGain_ - preTarget) * (preTarget < preGain_ ? gainAttackCoef_ : gainReleaseCoef_);
        attackEnv_ *= attackDecay_;
        attackSmooth_ = attackEnv_ + (attackSmooth_ - attackEnv_) * attackSmoothCoef_;
        const double hfGain = preGain_ * (1.0 + attackSmooth_);
        const bool shapeHigh = std::fabs(hfGain - 1.0) > 1e-9;

        for (uint32_t c = 0; c < channelCount; ++c) {
            const double s = outFifo_[c * hop_ + readIndex];
            const double low = xb0_ * s + xz1_[c];
            xz1_[c] = xb1_ * s - xa1_ * low + xz2_[c];
            xz2_[c] = xb2_ * s - xa2_ * low;
            wet[c] = shapeHigh ? low + hfGain * (s - low) : s;
            double& delayed = dry_[dryPos_ * channelCount + c];
            dry[c] = delayed;
            delayed = x[c];
        }
        if (++dryPos_ == latency_) dryPos_ = 0;

        if (mix_ != mixTarget_) {
            mix_ = mix_ < mixTarget_ ? std::min(mixTarget_, mix_ + mixStep_) : std::max(mixTarget_, mix_ - mixStep_);
        }
        limGain_ = 1.0 - (1.0 - limGain_) * limRelease_;
        if (mix_ > 0.0) {
            // Delta limiter: the restoration may not push a sample past full scale
            // (or past the source's own level where the source already exceeds it).
            double allowedScale = 1.0;
            for (uint32_t c = 0; c < channelCount; ++c) {
                const double delta = mix_ * (wet[c] - dry[c]);
                const double ceiling = std::max(kCeiling, std::fabs(dry[c]));
                if (std::fabs(dry[c] + delta) <= ceiling || std::fabs(delta) < kTiny) continue;
                const double room = (dry[c] >= 0.0) == (delta >= 0.0)
                    ? ceiling - std::fabs(dry[c])
                    : ceiling + std::fabs(dry[c]);
                allowedScale = std::min(allowedScale, std::max(0.0, room / std::fabs(delta)));
            }
            if (allowedScale < limGain_) limGain_ = allowedScale;
            for (uint32_t c = 0; c < channelCount; ++c) y[c] = dry[c] + limGain_ * mix_ * (wet[c] - dry[c]);
        } else {
            for (uint32_t c = 0; c < channelCount; ++c) y[c] = dry[c];
        }

        if (start_ == Start::Trim && trimRemaining_ > 0) {
            --trimRemaining_;
            continue;
        }
        if (start_ == Start::Join && joinPos_ < latency_ + joinFade_) {
            if (joinPos_ < latency_) {
                for (uint32_t c = 0; c < channelCount; ++c) y[c] = x[c];
            } else {
                const double a = (static_cast<double>(joinPos_ - latency_) + 0.5) / static_cast<double>(joinFade_);
                const double fadeOut = std::cos(0.5 * kPi * a);
                const double fadeIn = std::sin(0.5 * kPi * a);
                for (uint32_t c = 0; c < channelCount; ++c) y[c] = fadeOut * x[c] + fadeIn * y[c];
            }
            ++joinPos_;
        }
        for (uint32_t c = 0; c < channelCount; ++c) out[written * channelCount + c] = y[c];
        ++written;
    }
    return written;
}

// ---------------------------------------------------------------------------
// STFT frame
// ---------------------------------------------------------------------------

void RestoreProcessor::processFrame() {
    for (uint32_t c = 0; c < channels_; ++c) {
        vDSP_vmulD(&inFifo_[c * n_], 1, window_.data(), 1, frame_.data(), 1, n_);
        DSPDoubleSplitComplex split{&re_[c * half_], &im_[c * half_]};
        vDSP_ctozD(reinterpret_cast<const DSPDoubleComplex*>(frame_.data()), 2, &split, 1, half_);
        vDSP_fft_zripD(fft_, &split, 1, log2n_, kFFTDirection_Forward);
    }

    analyzeAndRepair();

    bool finite = true;
    for (uint32_t c = 0; c < channels_; ++c) {
        DSPDoubleSplitComplex split{&re_[c * half_], &im_[c * half_]};
        vDSP_fft_zripD(fft_, &split, 1, log2n_, kFFTDirection_Inverse);
        vDSP_ztocD(&split, 1, reinterpret_cast<DSPDoubleComplex*>(frame_.data()), 2, half_);
        double* accumulator = &outAccum_[c * n_];
        for (size_t i = 0; i < n_; ++i) accumulator[i] += frame_[i] * window_[i] * olaScale_;
        double* ready = &outFifo_[c * hop_];
        std::memcpy(ready, accumulator, hop_ * sizeof(double));
        std::memmove(accumulator, accumulator + hop_, (n_ - hop_) * sizeof(double));
        std::fill(accumulator + (n_ - hop_), accumulator + n_, 0.0);
        double* fifo = &inFifo_[c * n_];
        std::memmove(fifo, fifo + hop_, (n_ - hop_) * sizeof(double));
        for (size_t i = 0; i < hop_; ++i) finite = finite && std::isfinite(ready[i]);
    }

    if (!finite) {
        // Never let a numerical fault reach the output: drop to the dry signal and start over.
        std::fill(outFifo_.begin(), outFifo_.end(), 0.0);
        std::fill(outAccum_.begin(), outAccum_.end(), 0.0);
        std::fill(smooth_.begin(), smooth_.end(), 0.0);
        std::fill(chanSmooth_.begin(), chanSmooth_.end(), 0.0);
        hfRef_.fill(0.0);
        mix_ = 0.0;
        spectralFault_ = true;
    }
}

void RestoreProcessor::analyzeAndRepair() {
    ++framesAnalyzed_;
    ++framesSinceReset_;
    const double nyquist = rate_ * 0.5;
    const size_t kMax = std::min(half_ - 1, binFor(std::min(nyquist, 24000.0)));
    const double norm2 = magNorm_ * magNorm_;

    for (size_t k = 1; k <= kMax; ++k) {
        double total = 0.0;
        for (uint32_t c = 0; c < channels_; ++c) {
            const double re = re_[c * half_ + k];
            const double im = im_[c * half_ + k];
            const double p = (re * re + im * im) * norm2;
            chanPower_[c * half_ + k] = p;
            total += p;
        }
        power_[k] = total;
    }

    double energy = 0.0;
    for (size_t k = std::max<size_t>(1, binFor(150.0)); k <= kMax; ++k) energy += power_[k];
    if (energy > kSilentFrame) {
        // Running mean at first, then a ~1.5 s exponential average.
        ++longTermFrames_;
        const double alpha = std::max(1.0 / static_cast<double>(longTermFrames_),
                                      1.0 - std::exp(-static_cast<double>(hop_) / (1.5 * rate_)));
        for (size_t k = 1; k <= kMax; ++k) longTerm_[k] += (power_[k] - longTerm_[k]) * alpha;
    }
    if (framesAnalyzed_ % 4 == 0) detectCutoff();
    updateAmounts(false);

    // Artifact reduction region: from 3.2 kHz to just below the codec cutoff.
    const size_t kA = binFor(3200.0);
    const size_t kC = cutoffBin_ > 0
        ? cutoffBin_ - std::min<size_t>(cutoffBin_, 2)
        : std::min(kMax > 9 ? kMax - 9 : 0, binFor(std::min(nyquist * 0.95, 20000.0)));
    const double frameAlpha = 1.0 - std::exp(-static_cast<double>(hop_) / (2.0 * rate_));
    if (kC > kA + 16 && kC < kMax) {
        double smoothBand = 0.0;
        double powerBand = 0.0;
        for (size_t k = kA; k <= kC; ++k) {
            smoothBand += smooth_[k];
            powerBand += power_[k];
        }
        // A broadband rise is an attack, not an artifact: leave the frame alone.
        const bool onset = powerBand > 4.0 * smoothBand;
        const bool primed = framesSinceReset_ > 2;
        const bool repair = artifactAmount_ > 1e-4 && primed && !onset;
        const double fillPower = 0.5 * artifactAmount_;  // −3 dB under the bins' recent level at full strength
        const double fluxAlpha = 1.0 - std::exp(-static_cast<double>(hop_) / (0.08 * rate_));
        size_t holes = 0;
        size_t flickering = 0;

        // A bin is "dipped" when it falls far below its own recent level; holes are
        // runs of dipped bins (the encoder zeroed a band) inside an active region.
        const bool regionActive = powerBand > 0.1 * smoothBand;
        for (size_t k = kA; k <= kC; ++k) {
            const double db = 10.0 * std::log10(power_[k] + 1e-20);
            if (primed) flux_[k] += (std::fabs(db - prevDb_[k]) - flux_[k]) * fluxAlpha;
            prevDb_[k] = db;
            dipped_[k] = regionActive && smooth_[k] > kHoleFloor && power_[k] < smooth_[k] * kHoleThreshold;
        }
        dipped_[kC + 1] = 0;
        for (size_t k = kA; k <= kC;) {
            if (!dipped_[k]) {
                if (flux_[k] > kFlickerFluxDb && power_[k] > smooth_[k]) {
                    // "Birdie": a bin switching on and off frame to frame. Pull its peaks
                    // toward the running level (same gain on every channel).
                    ++flickering;
                    if (repair) {
                        const double a = artifactAmount_ * clamp01((flux_[k] - kFlickerFluxDb) / 10.0);
                        const double gain = std::max(0.25, std::pow(smooth_[k] / power_[k], 0.5 * a));
                        for (uint32_t c = 0; c < channels_; ++c) {
                            re_[c * half_ + k] *= gain;
                            im_[c * half_ + k] *= gain;
                        }
                    }
                }
                ++k;
                continue;
            }
            size_t end = k;
            while (dipped_[end]) ++end;
            const size_t run = end - k;
            // ...and only when the bands on both sides are still well above it in this
            // same frame: a decaying sound drops everywhere at once, a zeroed band alone.
            bool surrounded = false;
            if (run >= kHoleMinRun && run <= kHoleMaxRun) {
                const size_t context = std::max<size_t>(4, run);
                if (k >= kA + context && end + context <= kC + 1) {
                    double inside = 0.0, left = 0.0, right = 0.0;
                    for (size_t j = k; j < end; ++j) inside += power_[j];
                    for (size_t j = k - context; j < k; ++j) left += power_[j];
                    for (size_t j = end; j < end + context; ++j) right += power_[j];
                    inside /= static_cast<double>(run);
                    left /= static_cast<double>(context);
                    right /= static_cast<double>(context);
                    surrounded = std::min(left, right) > kHoleContrast * inside;
                }
            }
            if (surrounded) {
                holes += run;
                // Fill with noise at a fraction of the bins' recent level, one phase for
                // all channels so the fill keeps the local stereo image.
                for (size_t j = k; repair && j < end; ++j) {
                    const uint32_t phase = nextRandom() & 1023u;
                    for (uint32_t c = 0; c < channels_; ++c) {
                        const double target = std::sqrt(chanSmooth_[c * half_ + j] * fillPower);
                        const double current = std::sqrt(chanPower_[c * half_ + j]);
                        if (target <= current) continue;
                        const double add = (target - current) / magNorm_;
                        re_[c * half_ + j] += add * cosTable_[phase];
                        im_[c * half_ + j] += add * sinTable_[phase];
                    }
                }
            }
            k = end;
        }
        if (primed && !onset && smoothBand > kHoleFloor * static_cast<double>(kC - kA)) {
            const double bins = static_cast<double>(kC - kA + 1);
            holeRate_ += (static_cast<double>(holes) / bins - holeRate_) * frameAlpha;
            flickerRate_ += (static_cast<double>(flickering) / bins - flickerRate_) * frameAlpha;
        }
    }

    if (hfAmount_ > 1e-4 && cutoffBin_ > 0) reconstructHighFrequencies(kMax);

    // Short-term reference spectra: quick to rise, slower to fall, so a brief
    // hole does not drag its own reference down.
    const double rise = 1.0 - std::exp(-static_cast<double>(hop_) / (0.020 * rate_));
    const double fall = 1.0 - std::exp(-static_cast<double>(hop_) / (0.120 * rate_));
    for (size_t k = 1; k <= kMax; ++k) {
        smooth_[k] += (power_[k] - smooth_[k]) * (power_[k] > smooth_[k] ? rise : fall);
        for (uint32_t c = 0; c < channels_; ++c) {
            double& s = chanSmooth_[c * half_ + k];
            const double p = chanPower_[c * half_ + k];
            s += (p - s) * (p > s ? rise : fall);
        }
    }
}

void RestoreProcessor::detectCutoff() {
    if (longTermFrames_ < 8) return;
    const double nyquist = rate_ * 0.5;
    const size_t kMax = std::min(half_ - 1, binFor(std::min(nyquist, 24000.0)));
    const size_t width = std::max<size_t>(4, binFor(700.0));
    for (size_t k = 1; k <= kMax; ++k) ltDb_[k] = 10.0 * std::log10(longTerm_[k] + 1e-20);
    prefixA_[0] = 0.0;
    prefixA_[1] = 0.0;
    for (size_t k = 1; k <= kMax; ++k) prefixA_[k + 1] = prefixA_[k] + ltDb_[k];

    // A codec low-pass is a wall: ≥ 18 dB lower within 700 Hz and nothing above it,
    // with real content (above the 16-bit dither floor) below it. Natural roll-offs
    // and lossless masters do not look like that.
    const size_t kLo = std::max(width + 1, binFor(std::max(6000.0, 0.3 * nyquist)));
    const size_t kHigh = std::min(kMax > width ? kMax - width : 0, binFor(std::min(0.985 * nyquist, 21500.0)));
    size_t found = 0;
    for (size_t k = kHigh; k >= kLo && k > 0; --k) {
        const double below = (prefixA_[k] - prefixA_[k - width]) / static_cast<double>(width);
        const double above = (prefixA_[k + width + 1] - prefixA_[k + 1]) / static_cast<double>(width);
        if (below < -115.0 || below - above < 18.0) continue;
        double highest = -400.0;
        for (size_t j = k + width / 2; j <= std::min(kMax, k + 3 * width); ++j) highest = std::max(highest, ltDb_[j]);
        if (highest > below - 15.0) continue;
        // The steepest step near k is the edge.
        double steepest = -1.0;
        size_t edge = k;
        for (size_t j = std::max<size_t>(2, k - width); j + 2 <= std::min(kMax, k + width / 2); ++j) {
            const double step = ltDb_[j - 1] - ltDb_[j + 2];
            if (step > steepest) {
                steepest = step;
                edge = j;
            }
        }
        found = edge;
        break;
    }

    // Soft encoder low-passes (a transition band rather than a wall) move the steepest
    // point around between analyses: accept anything within half the analysis width.
    const size_t tolerance = std::max<size_t>(3, width / 2);
    const auto near = [tolerance](size_t a, size_t b) { return (a > b ? a - b : b - a) <= tolerance; };
    if (found > 0) {
        if (cutoffBin_ > 0 && near(found, cutoffBin_)) {
            confidence_ = std::min(1.0, confidence_ + 0.15);
            candidateCount_ = 0;
            // Follow slowly, so the synthesized band does not wobble.
            cutoffBin_ = (3 * cutoffBin_ + found + 2) / 4;
            return;
        }
        if (near(found, candidateBin_)) {
            ++candidateCount_;
        } else {
            candidateBin_ = found;
            candidateCount_ = 1;
        }
        // A first cutoff is taken quickly; replacing an established one needs more evidence.
        if (candidateCount_ >= (cutoffBin_ == 0 ? 3 : 6)) {
            cutoffBin_ = found;
            confidence_ = 0.4;
            candidateCount_ = 0;
        }
        return;
    }
    confidence_ = std::max(0.0, confidence_ - 0.05);
    if (confidence_ == 0.0) cutoffBin_ = 0;
}

void RestoreProcessor::reconstructHighFrequencies(size_t kMax) {
    const Tuning& tuning = tuningFor(config_.profile);
    const double nyquist = rate_ * 0.5;
    const size_t kc = cutoffBin_;
    const size_t below = std::max<size_t>(4, binFor(1500.0));
    if (kc <= below + 2) return;
    // Up to ~21 kHz, and at most one octave above the cutoff.
    const size_t kTop = std::min({kMax, binFor(std::min(0.96 * nyquist, 21000.0)), 2 * kc - 2});
    if (kTop < kc + 4) return;
    const double amount = hfAmount_ * smoothstep((confidence_ - 0.25) / 0.5);
    if (amount < 1e-4) return;

    const double level = std::pow(10.0, -tuning.hfOffsetDb / 10.0);
    const double fadeInHz = 300.0;
    const size_t fadeOutBins = std::max<size_t>(2, binFor(700.0));
    const double tiltStep = std::pow(10.0, tuning.hfTiltDbPerKhz * binHz_ / 1000.0 / 20.0);
    const double release = 1.0 - std::exp(-static_cast<double>(hop_) / (0.050 * rate_));

    for (uint32_t c = 0; c < channels_; ++c) {
        double* re = &re_[c * half_];
        double* im = &im_[c * half_];
        const double* power = &chanPower_[c * half_];

        // Level just below the cutoff in this frame: the synthesized band follows the music.
        double reference = 0.0;
        for (size_t k = kc - below; k <= kc - 2; ++k) reference += power[k];
        reference /= static_cast<double>(below - 1);
        double& held = hfRef_[c];
        held = reference > held ? reference : held + (reference - held) * release;
        if (held < kSilentFrame) continue;

        // Energy of the octave feeding the first 1.5 kHz above the cutoff.
        double source = 0.0;
        const size_t sourceLo = kc / 2;
        const size_t sourceHi = std::max(sourceLo + 1, (kc + below) / 2);
        for (size_t m = sourceLo; m <= sourceHi; ++m) source += power[m];
        source /= static_cast<double>(sourceHi - sourceLo + 1);
        if (source < 1e-14) continue;

        const double scale = std::sqrt(held * level / source) * amount;
        const double cap = std::sqrt(held) / magNorm_;
        double tilt = 1.0;
        for (size_t k = kc + 1; k <= kTop; ++k) {
            tilt *= tiltStep;
            const size_t m = k >> 1;
            double tr;
            double ti;
            double magnitude;
            if ((k & 1) == 0) {
                // Octave transposition: same magnitude, doubled phase (X²/|X|).
                const double xr = re[m];
                const double xi = im[m];
                magnitude = std::sqrt(xr * xr + xi * xi);
                if (magnitude < kTiny) continue;
                tr = (xr * xr - xi * xi) / magnitude;
                ti = 2.0 * xr * xi / magnitude;
            } else {
                // Between two source bins: phase φm + φm+1, mean magnitude.
                const double r1 = re[m], i1 = im[m], r2 = re[m + 1], i2 = im[m + 1];
                const double m1 = std::sqrt(r1 * r1 + i1 * i1);
                const double m2 = std::sqrt(r2 * r2 + i2 * i2);
                if (m1 < kTiny || m2 < kTiny) continue;
                magnitude = 0.5 * (m1 + m2);
                const double pr = (r1 * r2 - i1 * i2) / (m1 * m2);
                const double pi = (r1 * i2 + i1 * r2) / (m1 * m2);
                tr = pr * magnitude;
                ti = pi * magnitude;
            }
            const double offsetHz = static_cast<double>(k - kc) * binHz_;
            double shape = tilt;
            if (offsetHz < fadeInHz) shape *= 0.5 - 0.5 * std::cos(kPi * offsetHz / fadeInHz);
            if (k + fadeOutBins > kTop) {
                const double t = static_cast<double>(k + fadeOutBins - kTop) / static_cast<double>(fadeOutBins);
                shape *= 0.5 + 0.5 * std::cos(kPi * t);
            }
            // Never above the level at the cutoff: no added brightness, only continuation.
            const double target = std::min(magnitude * scale, cap) * shape;
            const double current = std::sqrt(re[k] * re[k] + im[k] * im[k]);
            if (target <= current) continue;
            const double add = (target - current) / magnitude;
            re[k] += tr * add;
            im[k] += ti * add;
        }
    }
}

void RestoreProcessor::updateAmounts(bool immediate) {
    const Tuning& tuning = tuningFor(config_.profile);
    const double cutoffHz = static_cast<double>(cutoffBin_) * binHz_;
    const double bandwidthLoss = cutoffBin_ > 0 ? clamp01((20000.0 - cutoffHz) / 6000.0) * confidence_ : 0.0;
    const double holes = clamp01(holeRate_ / 0.04);
    const double flicker = clamp01(flickerRate_ / 0.04);
    severity_ = clamp01(0.5 * bandwidthLoss + 0.3 * holes + 0.2 * flicker);

    double artifact = tuning.artifact;
    double hf = tuning.hf;
    double transient = tuning.transient;
    if (config_.profile == RestoreProfile::Adaptive) {
        artifact = 0.35 + 0.65 * std::max(holes, flicker);
        transient = 0.3 + 0.7 * severity_;
    }
    // Spectral modules follow √strength so the 30 % default is already audible but mild.
    const double strength = config_.strength;
    const double artifactTarget = config_.artifactReduction ? artifact * std::sqrt(strength) : 0.0;
    const double hfTarget = config_.hfReconstruction ? hf * std::sqrt(strength) : 0.0;
    const double transientTarget = config_.transientRestoration ? transient * strength : 0.0;
    const double alpha = immediate || rate_ <= 0
        ? 1.0
        : 1.0 - std::exp(-static_cast<double>(hop_) / (0.15 * rate_));
    artifactAmount_ += (artifactTarget - artifactAmount_) * alpha;
    hfAmount_ += (hfTarget - hfAmount_) * alpha;
    transientAmount_ += (transientTarget - transientAmount_) * alpha;
}
