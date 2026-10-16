#include "FirFilter.h"

#include <Accelerate/Accelerate.h>
#include <AudioToolbox/AudioToolbox.h>
#include <soxr.h>
#include <sys/stat.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <sstream>

namespace {

constexpr double kPi = 3.14159265358979323846;

size_t nextPow2(size_t n) {
    size_t p = 1;
    while (p < n) p <<= 1;
    return p;
}

size_t log2Of(size_t pow2) {
    size_t l = 0;
    while ((size_t{1} << l) < pow2) ++l;
    return l;
}

// One FFT setup sized for the largest transform requested so far; a setup
// serves every smaller size. Older setups stay alive for threads still using them.
FFTSetupD fftSetup(size_t log2n) {
    static std::mutex mutex;
    static FFTSetupD setup = nullptr;
    static size_t setupLog2 = 0;
    std::lock_guard<std::mutex> lock(mutex);
    if (!setup || log2n > setupLog2) {
        setup = vDSP_create_fftsetupD(static_cast<vDSP_Length>(std::max<size_t>(log2n, 12)), kFFTRadix2);
        setupLog2 = std::max<size_t>(log2n, 12);
    }
    return setup;
}

double besselI0(double x) {
    double sum = 1.0, term = 1.0;
    const double half = x / 2.0;
    for (int k = 1; k < 500; ++k) {
        term *= (half / k) * (half / k);
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

double windowFloorDb(const FirDesign& design) {
    switch (design.window) {
        case FirWindow::Kaiser: return -std::clamp(design.attenuationDb, 60.0, 220.0);
        case FirWindow::BlackmanHarris: return -90.0;
        case FirWindow::Gauss: return -120.0;
    }
    return -120.0;
}

std::vector<double> makeWindow(const FirDesign& design, size_t length) {
    std::vector<double> w(length, 1.0);
    if (length < 2) return w;
    const double center = (static_cast<double>(length) - 1.0) / 2.0;
    switch (design.window) {
        case FirWindow::Kaiser: {
            const double a = std::clamp(design.attenuationDb, 60.0, 220.0);
            const double beta = 0.1102 * (a - 8.7);
            const double norm = besselI0(beta);
            for (size_t n = 0; n < length; ++n) {
                const double r = (static_cast<double>(n) - center) / center;
                w[n] = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - r * r))) / norm;
            }
            break;
        }
        case FirWindow::BlackmanHarris: {
            const double m = static_cast<double>(length - 1);
            for (size_t n = 0; n < length; ++n) {
                const double t = 2.0 * kPi * static_cast<double>(n) / m;
                w[n] = 0.35875 - 0.48829 * std::cos(t) + 0.14128 * std::cos(2 * t) - 0.01168 * std::cos(3 * t);
            }
            break;
        }
        case FirWindow::Gauss: {
            constexpr double alpha = 6.0;
            for (size_t n = 0; n < length; ++n) {
                const double r = (static_cast<double>(n) - center) / center;
                w[n] = std::exp(-0.5 * (alpha * r) * (alpha * r));
            }
            break;
        }
    }
    return w;
}

// Windowed sinc with cutoff `wc` (radians/sample), unnormalized.
void fillSinc(std::vector<double>& h, const std::vector<double>& window, double wc) {
    const double center = (static_cast<double>(h.size()) - 1.0) / 2.0;
    for (size_t n = 0; n < h.size(); ++n) {
        const double m = static_cast<double>(n) - center;
        const double sinc = std::abs(m) < 1e-12 ? wc / kPi : std::sin(wc * m) / (kPi * m);
        h[n] = window[n] * sinc;
    }
}

// Complex in-place FFT on split arrays (size 2^log2n).
void complexFft(std::vector<double>& re, std::vector<double>& im, size_t log2n, FFTDirection direction) {
    DSPDoubleSplitComplex split{re.data(), im.data()};
    vDSP_fft_zipD(fftSetup(log2n), &split, 1, static_cast<vDSP_Length>(log2n), direction);
}

// Minimum-phase counterpart with the same magnitude response (real cepstrum folding).
std::vector<double> toMinimumPhase(const std::vector<double>& h) {
    const size_t n = h.size();
    const size_t fft = std::min<size_t>(nextPow2(n) * 8, size_t{1} << 22);
    const size_t log2n = log2Of(fft);
    std::vector<double> re(fft, 0.0), im(fft, 0.0);
    std::copy(h.begin(), h.end(), re.begin());
    complexFft(re, im, log2n, kFFTDirection_Forward);
    for (size_t k = 0; k < fft; ++k) {
        re[k] = std::log(std::max(std::hypot(re[k], im[k]), 1e-20));
        im[k] = 0.0;
    }
    complexFft(re, im, log2n, kFFTDirection_Inverse);   // real cepstrum × fft
    const double scale = 1.0 / static_cast<double>(fft);
    for (size_t k = 0; k < fft; ++k) {
        double c = re[k] * scale;
        if (k == 0 || k == fft / 2) {
            // keep
        } else if (k < fft / 2) {
            c *= 2.0;
        } else {
            c = 0.0;
        }
        re[k] = c;
        im[k] = 0.0;
    }
    complexFft(re, im, log2n, kFFTDirection_Forward);
    for (size_t k = 0; k < fft; ++k) {
        const double magnitude = std::exp(re[k]);
        const double phase = im[k];
        re[k] = magnitude * std::cos(phase);
        im[k] = magnitude * std::sin(phase);
    }
    complexFft(re, im, log2n, kFFTDirection_Inverse);
    std::vector<double> out(n);
    for (size_t k = 0; k < n; ++k) out[k] = re[k] * scale;
    return out;
}

void normalizeDc(std::vector<double>& h) {
    double sum = 0.0;
    for (double v : h) sum += v;
    if (std::abs(sum) > 1e-300) for (double& v : h) v /= sum;
}

std::shared_ptr<const std::vector<double>> designUncached(const FirDesign& design, unsigned ratio) {
    size_t taps = std::clamp<unsigned>(design.tapsPerPhase, 8, 65536);
    if (design.minimumPhase) taps = std::min<size_t>(taps, (kMaxMinimumPhaseTaps - 1) / ratio);
    const size_t length = ratio * taps + 1;
    const double nyquist = kPi / ratio;                  // lower Nyquist at the filter's rate
    const std::vector<double> window = makeWindow(design, length);
    std::vector<double> h(length);

    double wc = std::clamp(design.cutoff, 0.5, 1.2) * nyquist;
    if (design.apodizing) {
        // Largest cutoff whose response is already at the window's floor at Nyquist.
        const double target = std::pow(10.0, (windowFloorDb(design) + 3.0) / 20.0);
        const double center = (static_cast<double>(length) - 1.0) / 2.0;
        std::vector<double> cosNyquist(length);
        for (size_t n = 0; n < length; ++n) cosNyquist[n] = std::cos(nyquist * (static_cast<double>(n) - center));
        double lo = 0.5 * nyquist, hi = nyquist;
        for (int iteration = 0; iteration < 22; ++iteration) {
            const double mid = 0.5 * (lo + hi);
            fillSinc(h, window, mid);
            double dc = 0.0, atNyquist = 0.0;
            for (size_t n = 0; n < length; ++n) {
                dc += h[n];
                atNyquist += h[n] * cosNyquist[n];
            }
            if (std::abs(atNyquist / dc) <= target) lo = mid; else hi = mid;
        }
        wc = lo;
    }
    fillSinc(h, window, wc);
    if (design.minimumPhase) h = toMinimumPhase(h);
    normalizeDc(h);
    return std::make_shared<const std::vector<double>>(std::move(h));
}

}  // namespace

std::string FirDesign::key(unsigned ratio) const {
    std::ostringstream key;
    key << static_cast<int>(window) << '/' << tapsPerPhase << '/' << minimumPhase << '/' << apodizing << '/'
        << cutoff << '/' << attenuationDb << '/' << ratio;
    return key.str();
}

std::shared_ptr<const std::vector<double>> designFirLowpass(const FirDesign& design, unsigned ratio) {
    static std::mutex mutex;
    static std::deque<std::pair<std::string, std::shared_ptr<const std::vector<double>>>> cache;
    ratio = std::clamp<unsigned>(ratio, 1, 16);
    const std::string key = design.key(ratio);
    {
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto& entry : cache) if (entry.first == key) return entry.second;
    }
    auto designed = designUncached(design, ratio);
    std::lock_guard<std::mutex> lock(mutex);
    cache.emplace_back(key, designed);
    while (cache.size() > 8) cache.pop_front();
    return designed;
}

// ---------------------------------------------------------------------------
// Kernel spectra / FFT convolution
// ---------------------------------------------------------------------------

namespace {

size_t convolutionFftSize(size_t kernelLength) {
    size_t fft = nextPow2(std::max<size_t>(kernelLength, 2));
    // Keep the block (fft − N + 1) at least half the kernel, and at least 4096 frames.
    while (fft - kernelLength + 1 < std::max<size_t>(kernelLength / 2, 4096)) fft <<= 1;
    return fft;
}

}  // namespace

std::shared_ptr<const KernelSpectrum> makeKernelSpectrum(const std::vector<double>& kernel) {
    auto spectrum = std::make_shared<KernelSpectrum>();
    const size_t fft = convolutionFftSize(kernel.size());
    spectrum->length = kernel.size();
    spectrum->fftLog2 = log2Of(fft);
    spectrum->re.assign(fft / 2, 0.0);
    spectrum->im.assign(fft / 2, 0.0);
    std::vector<double> padded(fft, 0.0);
    std::copy(kernel.begin(), kernel.end(), padded.begin());
    DSPDoubleSplitComplex split{spectrum->re.data(), spectrum->im.data()};
    vDSP_ctozD(reinterpret_cast<const DSPDoubleComplex*>(padded.data()), 2, &split, 1, fft / 2);
    vDSP_fft_zripD(fftSetup(spectrum->fftLog2), &split, 1, spectrum->fftLog2, kFFTDirection_Forward);
    // Forward (×2 each) and inverse (×fft) scaling folded into the kernel.
    const double scale = 1.0 / (4.0 * static_cast<double>(fft));
    vDSP_vsmulD(spectrum->re.data(), 1, &scale, spectrum->re.data(), 1, fft / 2);
    vDSP_vsmulD(spectrum->im.data(), 1, &scale, spectrum->im.data(), 1, fft / 2);
    return spectrum;
}

struct FftConvolver::Impl {
    std::vector<std::shared_ptr<const KernelSpectrum>> spectra;
    std::vector<std::vector<double>> history;   // per channel: fft samples (N−1 history + block)
    std::vector<double> re, im, time;
};

FftConvolver::FftConvolver() : impl_(std::make_unique<Impl>()) {}
FftConvolver::~FftConvolver() = default;

bool FftConvolver::configure(std::vector<std::shared_ptr<const KernelSpectrum>> spectra, uint32_t channels,
                             std::string& error) {
    channels_ = 0;
    if (spectra.empty() || channels == 0) {
        error = "No convolution kernel";
        return false;
    }
    const size_t log2n = spectra.front()->fftLog2;
    for (const auto& spectrum : spectra) {
        if (!spectrum || spectrum->fftLog2 != log2n) {
            error = "Convolution kernels must share one FFT size";
            return false;
        }
    }
    impl_->spectra = std::move(spectra);
    kernelLength_ = 0;
    for (const auto& spectrum : impl_->spectra) kernelLength_ = std::max(kernelLength_, spectrum->length);
    fftSize_ = size_t{1} << log2n;
    blockSize_ = fftSize_ - kernelLength_ + 1;
    channels_ = channels;
    impl_->history.assign(channels, std::vector<double>(fftSize_, 0.0));
    impl_->re.assign(fftSize_ / 2, 0.0);
    impl_->im.assign(fftSize_ / 2, 0.0);
    impl_->time.assign(fftSize_, 0.0);
    filled_ = 0;
    outputFrames_ = 0;
    fftSetup(log2n);
    return true;
}

void FftConvolver::reset() {
    for (auto& buffer : impl_->history) std::fill(buffer.begin(), buffer.end(), 0.0);
    filled_ = 0;
    outputFrames_ = 0;
}

void FftConvolver::processBlock(std::vector<double>& out) {
    const size_t history = kernelLength_ - 1;
    const size_t half = fftSize_ / 2;
    const size_t log2n = log2Of(fftSize_);
    FFTSetupD setup = fftSetup(log2n);
    const size_t start = out.size();
    out.resize(start + blockSize_ * channels_);

    for (uint32_t ch = 0; ch < channels_; ++ch) {
        auto& buffer = impl_->history[ch];
        const auto& kernel = *impl_->spectra[std::min<size_t>(ch, impl_->spectra.size() - 1)];
        DSPDoubleSplitComplex split{impl_->re.data(), impl_->im.data()};
        vDSP_ctozD(reinterpret_cast<const DSPDoubleComplex*>(buffer.data()), 2, &split, 1, half);
        vDSP_fft_zripD(setup, &split, 1, log2n, kFFTDirection_Forward);
        // Packed format: element 0 holds DC (real) and Nyquist (imag) separately.
        const double dc = impl_->re[0] * kernel.re[0];
        const double nyquist = impl_->im[0] * kernel.im[0];
        DSPDoubleSplitComplex kernelSplit{const_cast<double*>(kernel.re.data()), const_cast<double*>(kernel.im.data())};
        vDSP_zvmulD(&split, 1, &kernelSplit, 1, &split, 1, half, 1);
        impl_->re[0] = dc;
        impl_->im[0] = nyquist;
        vDSP_fft_zripD(setup, &split, 1, log2n, kFFTDirection_Inverse);
        vDSP_ztocD(&split, 1, reinterpret_cast<DSPDoubleComplex*>(impl_->time.data()), 2, half);
        // Valid (non-wrapped) part: the last blockSize_ samples.
        for (size_t i = 0; i < blockSize_; ++i) {
            out[start + i * channels_ + ch] = impl_->time[history + i];
        }
        // The last N−1 inputs become the next block's history.
        if (history > 0) std::memmove(buffer.data(), buffer.data() + blockSize_, history * sizeof(double));
    }
    filled_ = 0;
    outputFrames_ += blockSize_;
}

void FftConvolver::process(const double* in, size_t frames, std::vector<double>& out) {
    if (channels_ == 0) return;
    const size_t history = kernelLength_ - 1;
    size_t offset = 0;
    while (offset < frames) {
        const size_t take = std::min(frames - offset, blockSize_ - filled_);
        for (uint32_t ch = 0; ch < channels_; ++ch) {
            double* dst = impl_->history[ch].data() + history + filled_;
            const double* src = in + offset * channels_ + ch;
            for (size_t i = 0; i < take; ++i) dst[i] = src[i * channels_];
        }
        filled_ += take;
        offset += take;
        if (filled_ == blockSize_) processBlock(out);
    }
}

void FftConvolver::flushTo(size_t totalOutputFrames, std::vector<double>& out) {
    if (channels_ == 0) return;
    const size_t history = kernelLength_ - 1;
    while (outputFrames_ < totalOutputFrames) {
        for (uint32_t ch = 0; ch < channels_; ++ch) {
            double* dst = impl_->history[ch].data() + history + filled_;
            std::fill(dst, dst + (blockSize_ - filled_), 0.0);
        }
        processBlock(out);
    }
    if (outputFrames_ > totalOutputFrames) {
        const size_t excess = outputFrames_ - totalOutputFrames;
        out.resize(out.size() - std::min(out.size(), excess * channels_));
        outputFrames_ = totalOutputFrames;
    }
}

// ---------------------------------------------------------------------------
// Integer-ratio resampler
// ---------------------------------------------------------------------------

namespace {

bool integerRatio(double numerator, double denominator, unsigned& ratio) {
    if (numerator <= 0 || denominator <= 0) return false;
    const double r = numerator / denominator;
    const double rounded = std::round(r);
    if (rounded < 2 || rounded > 16 || std::abs(r - rounded) > 1e-9) return false;
    ratio = static_cast<unsigned>(rounded);
    return true;
}

}  // namespace

bool FirResampler::supportsRatio(double inputRate, double outputRate) {
    unsigned ratio = 0;
    return integerRatio(outputRate, inputRate, ratio) || integerRatio(inputRate, outputRate, ratio);
}

bool FirResampler::configure(const FirDesign& design, double inputRate, double outputRate,
                             uint32_t channels, std::string& error) {
    channels_ = 0;
    unsigned ratio = 0;
    if (integerRatio(outputRate, inputRate, ratio)) {
        up_ = ratio;
        down_ = 1;
    } else if (integerRatio(inputRate, outputRate, ratio)) {
        up_ = 1;
        down_ = ratio;
    } else {
        error = "FIR resampler needs an integer ratio (2–16)";
        return false;
    }
    const auto kernel = designFirLowpass(design, ratio);
    taps_ = kernel->size();
    if (!convolver_.configure({makeKernelSpectrum(*kernel)}, channels, error)) return false;
    delay_ = design.minimumPhase ? 0 : (taps_ - 1) / 2;
    channels_ = channels;
    reset();
    return true;
}

void FirResampler::reset() {
    convolver_.reset();
    trimmed_ = 0;
    decimationPhase_ = 0;
    inputFrames_ = 0;
    outputFrames_ = 0;
}

void FirResampler::emit(std::vector<double>& converted, std::vector<double>& out) {
    const size_t frames = converted.size() / channels_;
    size_t first = 0;
    if (trimmed_ < delay_) {
        first = std::min(frames, delay_ - trimmed_);
        trimmed_ += first;
    }
    if (down_ == 1) {
        out.insert(out.end(), converted.begin() + first * channels_, converted.end());
        outputFrames_ += frames - first;
    } else {
        for (size_t f = first; f < frames; ++f, ++decimationPhase_) {
            if (decimationPhase_ % down_ != 0) continue;
            out.insert(out.end(), converted.begin() + f * channels_, converted.begin() + (f + 1) * channels_);
            ++outputFrames_;
        }
    }
    converted.clear();
}

void FirResampler::process(const double* in, size_t frames, std::vector<double>& out) {
    if (channels_ == 0 || frames == 0) return;
    converted_.clear();
    if (up_ > 1) {
        // Zero-stuffing loses 1/L of the energy; the ×L gain restores unity.
        staging_.assign(frames * up_ * channels_, 0.0);
        const double gain = static_cast<double>(up_);
        for (size_t f = 0; f < frames; ++f) {
            for (uint32_t ch = 0; ch < channels_; ++ch) {
                staging_[(f * up_) * channels_ + ch] = in[f * channels_ + ch] * gain;
            }
        }
        convolver_.process(staging_.data(), frames * up_, converted_);
    } else {
        convolver_.process(in, frames, converted_);
    }
    inputFrames_ += frames;
    emit(converted_, out);
}

void FirResampler::flush(std::vector<double>& out) {
    if (channels_ == 0) return;
    const size_t expected = up_ > 1 ? inputFrames_ * up_ : (inputFrames_ + down_ - 1) / down_;
    const size_t convolvedFrames = delay_ + (up_ > 1 ? inputFrames_ * up_ : inputFrames_);
    converted_.clear();
    convolver_.flushTo(convolvedFrames, converted_);
    emit(converted_, out);
    if (outputFrames_ > expected) {
        out.resize(out.size() - std::min(out.size(), (outputFrames_ - expected) * channels_));
        outputFrames_ = expected;
    }
}

// ---------------------------------------------------------------------------
// Analysis (UI preview)
// ---------------------------------------------------------------------------

bool analyzeFirDesign(const FirDesign& design, double inputRate, double outputRate,
                      FirResponse& response, std::string& error) {
    unsigned ratio = 0;
    if (!integerRatio(outputRate, inputRate, ratio) && !integerRatio(inputRate, outputRate, ratio)) {
        error = "Preview needs an integer ratio (2–16)";
        return false;
    }
    const auto kernel = designFirLowpass(design, ratio);
    const auto& h = *kernel;
    const double highRate = std::max(inputRate, outputRate);
    const double lowNyquist = std::min(inputRate, outputRate) / 2.0;

    response = FirResponse{};
    response.taps = h.size();
    response.lengthMs = 1000.0 * static_cast<double>(h.size()) / highRate;
    response.impulseSampleRate = highRate;

    // Magnitude response from a zero-padded FFT.
    const size_t fft = std::max<size_t>(nextPow2(h.size()) * 2, 65536);
    const size_t log2n = log2Of(fft);
    std::vector<double> re(fft, 0.0), im(fft, 0.0);
    std::copy(h.begin(), h.end(), re.begin());
    complexFft(re, im, log2n, kFFTDirection_Forward);
    const auto magnitudeDbAt = [&](double frequency) {
        const double bin = frequency / highRate * static_cast<double>(fft);
        const size_t k = std::min<size_t>(static_cast<size_t>(std::llround(bin)), fft / 2);
        return 20.0 * std::log10(std::max(std::hypot(re[k], im[k]), 1e-15));
    };
    constexpr size_t kPoints = 1024;
    response.frequencies.resize(kPoints);
    response.magnitudeDb.resize(kPoints);
    for (size_t i = 0; i < kPoints; ++i) {
        const double f = highRate / 2.0 * static_cast<double>(i) / (kPoints - 1);
        response.frequencies[i] = f;
        response.magnitudeDb[i] = magnitudeDbAt(f);
    }
    response.attenuationAtNyquistDb = magnitudeDbAt(lowNyquist);
    const double step = highRate / static_cast<double>(fft);
    for (double f = 0.0; f <= lowNyquist; f += step) {
        if (std::abs(magnitudeDbAt(f)) <= 0.1) response.passbandEdgeHz = f; else break;
    }
    for (double f = 0.0; f <= highRate / 2.0; f += step) {
        if (magnitudeDbAt(f) <= -3.0) { response.minus3DbHz = f; break; }
    }

    // Impulse around the peak.
    size_t peak = 0;
    for (size_t n = 1; n < h.size(); ++n) if (std::abs(h[n]) > std::abs(h[peak])) peak = n;
    const double floor = std::abs(h[peak]) * 1e-6;   // −120 dB
    size_t first = 0;
    while (first < peak && std::abs(h[first]) < floor) ++first;
    response.preRingingMs = 1000.0 * static_cast<double>(peak - first) / highRate;
    const size_t span = static_cast<size_t>(ratio) * 48;
    const size_t begin = peak > span ? peak - span : 0;
    const size_t end = std::min(h.size(), peak + span * 3);
    response.impulse.assign(h.begin() + static_cast<ptrdiff_t>(begin), h.begin() + static_cast<ptrdiff_t>(end));
    response.impulsePeakIndex = peak - begin;
    return true;
}

// ---------------------------------------------------------------------------
// Room-correction impulse responses
// ---------------------------------------------------------------------------

namespace {

bool readAudioFile(const std::string& path, std::vector<double>& interleaved, uint32_t& channels,
                   double& sampleRate, std::string& error) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(
        nullptr, reinterpret_cast<const UInt8*>(path.c_str()), static_cast<CFIndex>(path.size()), false);
    if (!url) {
        error = "Invalid impulse response path";
        return false;
    }
    ExtAudioFileRef file = nullptr;
    OSStatus status = ExtAudioFileOpenURL(url, &file);
    CFRelease(url);
    if (status != noErr || !file) {
        error = "Cannot open impulse response (error " + std::to_string(status) + ")";
        return false;
    }
    AudioStreamBasicDescription source{};
    UInt32 size = sizeof(source);
    ExtAudioFileGetProperty(file, kExtAudioFileProperty_FileDataFormat, &size, &source);
    SInt64 frames = 0;
    size = sizeof(frames);
    ExtAudioFileGetProperty(file, kExtAudioFileProperty_FileLengthFrames, &size, &frames);
    channels = std::max<uint32_t>(1, source.mChannelsPerFrame);
    sampleRate = source.mSampleRate;
    if (frames <= 0 || frames > 8 * 1024 * 1024 || channels > 8) {
        ExtAudioFileDispose(file);
        error = "Impulse response is empty or too long";
        return false;
    }

    AudioStreamBasicDescription client{};
    client.mSampleRate = source.mSampleRate;
    client.mFormatID = kAudioFormatLinearPCM;
    client.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    client.mBitsPerChannel = 64;
    client.mChannelsPerFrame = channels;
    client.mBytesPerFrame = channels * 8;
    client.mFramesPerPacket = 1;
    client.mBytesPerPacket = client.mBytesPerFrame;
    status = ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat, sizeof(client), &client);
    if (status != noErr) {
        ExtAudioFileDispose(file);
        error = "Cannot decode impulse response (error " + std::to_string(status) + ")";
        return false;
    }
    interleaved.assign(static_cast<size_t>(frames) * channels, 0.0);
    size_t read = 0;
    while (read < static_cast<size_t>(frames)) {
        UInt32 chunk = static_cast<UInt32>(std::min<size_t>(65536, static_cast<size_t>(frames) - read));
        AudioBufferList list;
        list.mNumberBuffers = 1;
        list.mBuffers[0].mNumberChannels = channels;
        list.mBuffers[0].mDataByteSize = chunk * channels * 8;
        list.mBuffers[0].mData = interleaved.data() + read * channels;
        if (ExtAudioFileRead(file, &chunk, &list) != noErr || chunk == 0) break;
        read += chunk;
    }
    ExtAudioFileDispose(file);
    interleaved.resize(read * channels);
    if (read == 0) {
        error = "Impulse response has no samples";
        return false;
    }
    return true;
}

struct CachedImpulse {
    std::string key;
    std::vector<std::shared_ptr<const KernelSpectrum>> spectra;
    size_t peakIndex = 0;
    ImpulseResponseInfo info;
};

std::string fileIdentity(const std::string& path) {
    struct stat st{};
    if (stat(path.c_str(), &st) != 0) return path;
    return path + '\0' + std::to_string(st.st_size) + '\0' + std::to_string(st.st_mtimespec.tv_sec) + '.' +
           std::to_string(st.st_mtimespec.tv_nsec);
}

void describe(const std::vector<double>& interleaved, uint32_t channels, double sampleRate, ImpulseResponseInfo& info,
              size_t& peakIndex) {
    info.channels = channels;
    info.sampleRate = sampleRate;
    info.taps = interleaved.size() / channels;
    double peak = 0.0;
    peakIndex = 0;
    for (size_t i = 0; i < info.taps; ++i) {
        const double v = std::abs(interleaved[i * channels]);
        if (v > peak) { peak = v; peakIndex = i; }
    }
    info.peakIndex = peakIndex;
    info.peakDb = peak > 0 ? 20.0 * std::log10(peak) : -200.0;
}

}  // namespace

bool inspectImpulseResponse(const std::string& path, ImpulseResponseInfo& info, std::string& error) {
    std::vector<double> data;
    uint32_t channels = 0;
    double rate = 0;
    if (!readAudioFile(path, data, channels, rate, error)) return false;
    size_t peak = 0;
    describe(data, channels, rate, info, peak);
    return true;
}

bool loadImpulseResponse(const std::string& path, double outputRate, double gainDb,
                         std::vector<std::shared_ptr<const KernelSpectrum>>& spectra,
                         size_t& peakIndex, ImpulseResponseInfo& info, std::string& error) {
    static std::mutex mutex;
    static std::deque<CachedImpulse> cache;
    std::ostringstream keyStream;
    keyStream << fileIdentity(path) << '\0' << outputRate << '\0' << gainDb;
    const std::string key = keyStream.str();
    {
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto& entry : cache) {
            if (entry.key != key) continue;
            spectra = entry.spectra;
            peakIndex = entry.peakIndex;
            info = entry.info;
            return true;
        }
    }

    std::vector<double> data;
    uint32_t channels = 0;
    double rate = 0;
    if (!readAudioFile(path, data, channels, rate, error)) return false;
    describe(data, channels, rate, info, peakIndex);
    const uint32_t used = std::min<uint32_t>(channels, 2);

    // Resample the impulse to the output rate (SoX VHQ) when it was measured at another rate.
    if (std::abs(rate - outputRate) > 1.0) {
        const size_t inFrames = data.size() / channels;
        const size_t outFrames = static_cast<size_t>(std::ceil(static_cast<double>(inFrames) * outputRate / rate)) + 64;
        std::vector<double> resampled(outFrames * channels);
        const soxr_io_spec_t io = soxr_io_spec(SOXR_FLOAT64_I, SOXR_FLOAT64_I);
        const soxr_quality_spec_t quality = soxr_quality_spec(SOXR_VHQ, 0);
        size_t done = 0;
        const soxr_error_t soxrError = soxr_oneshot(rate, outputRate, channels, data.data(), inFrames, nullptr,
                                                    resampled.data(), outFrames, &done, &io, &quality, nullptr);
        if (soxrError) {
            error = std::string("Cannot resample impulse response: ") + soxrError;
            return false;
        }
        resampled.resize(done * channels);
        data.swap(resampled);
        peakIndex = static_cast<size_t>(std::llround(static_cast<double>(peakIndex) * outputRate / rate));
    }

    const double gain = std::pow(10.0, gainDb / 20.0);
    const size_t frames = data.size() / channels;
    spectra.clear();
    for (uint32_t ch = 0; ch < used; ++ch) {
        std::vector<double> kernel(frames);
        for (size_t i = 0; i < frames; ++i) kernel[i] = data[i * channels + ch] * gain;
        spectra.push_back(makeKernelSpectrum(kernel));
    }

    std::lock_guard<std::mutex> lock(mutex);
    cache.push_back({key, spectra, peakIndex, info});
    while (cache.size() > 4) cache.pop_front();
    return true;
}
