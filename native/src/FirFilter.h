#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// Long-FIR sample-rate conversion and convolution (HQPlayer-style "level 2").
//
//  - designFirLowpass(): windowed-sinc anti-imaging / anti-aliasing filters
//    (Kaiser, Blackman–Harris, Gaussian), from a few hundred to ~1M taps,
//    linear or minimum phase, optionally apodizing (full attenuation at the
//    source Nyquist).
//  - FftConvolver: uniformly blocked overlap-save FFT convolution (Accelerate
//    vDSP, float64), any kernel length, one kernel per channel.
//  - FirResampler: integer-ratio up/down sampling (×2…×16 or ÷2…÷16) through
//    the convolver, time-aligned (linear-phase group delay trimmed) and exact
//    in length.
//  - loadImpulseResponse(): room-correction FIR from an audio file, resampled
//    to the output rate.
//
// Everything runs on the decode thread (not real-time); designs and impulse
// responses are cached so a track change re-uses them.

enum class FirWindow { Kaiser, BlackmanHarris, Gauss };

struct FirDesign {
    FirWindow window = FirWindow::Kaiser;
    // Taps per polyphase branch, i.e. kernel length / ratio. 32 … 65536.
    unsigned tapsPerPhase = 4096;
    bool minimumPhase = false;
    // Apodizing: the transition band ends exactly at the lower Nyquist, so
    // nothing above it (including the source filter's ringing) passes.
    bool apodizing = true;
    // Cutoff (−6 dB point) as a fraction of the lower Nyquist when not apodizing.
    double cutoff = 1.0;
    // Kaiser stopband attenuation (dB).
    double attenuationDb = 160.0;

    std::string key(unsigned ratio) const;
};

// Highest kernel length minimum-phase design supports (cepstrum FFT memory bound).
constexpr size_t kMaxMinimumPhaseTaps = (size_t{1} << 19) - 1;

// Low-pass prototype for a ratio-`ratio` converter, normalized to unity DC gain.
// Length is ratio · tapsPerPhase + 1 (odd: integer group delay for linear phase).
std::shared_ptr<const std::vector<double>> designFirLowpass(const FirDesign& design, unsigned ratio);

struct FirResponse {
    std::vector<double> frequencies;   // Hz
    std::vector<double> magnitudeDb;   // dB
    std::vector<double> impulse;       // samples around the peak (high rate)
    double impulseSampleRate = 0;
    size_t impulsePeakIndex = 0;       // index of the peak inside `impulse`
    size_t taps = 0;
    double lengthMs = 0;
    double passbandEdgeHz = 0;         // last frequency within 0.1 dB of DC
    double minus3DbHz = 0;
    double attenuationAtNyquistDb = 0; // at the lower Nyquist
    double preRingingMs = 0;           // energy before the peak above −120 dB
};

// Magnitude/impulse summary of a design for a given rate pair (UI preview).
bool analyzeFirDesign(const FirDesign& design, double inputRate, double outputRate,
                      FirResponse& response, std::string& error);

// Spectrum of one kernel at a given FFT size, scaled for FftConvolver.
struct KernelSpectrum {
    size_t length = 0;      // kernel taps
    size_t fftLog2 = 0;
    std::vector<double> re;
    std::vector<double> im;
};

std::shared_ptr<const KernelSpectrum> makeKernelSpectrum(const std::vector<double>& kernel);

// Overlap-save FFT convolution, interleaved float64. Output is the causal
// convolution of the input; it becomes available once a block has filled.
class FftConvolver {
public:
    FftConvolver();
    ~FftConvolver();
    FftConvolver(const FftConvolver&) = delete;
    FftConvolver& operator=(const FftConvolver&) = delete;

    // One spectrum per channel; a single spectrum is shared by all channels.
    // All spectra must have the same FFT size.
    bool configure(std::vector<std::shared_ptr<const KernelSpectrum>> spectra, uint32_t channels,
                   std::string& error);
    // Appends produced frames to `out`.
    void process(const double* in, size_t frames, std::vector<double>& out);
    // Feeds silence until `totalOutputFrames` frames have been produced in total
    // (since configure/reset), then truncates `out` to exactly that.
    void flushTo(size_t totalOutputFrames, std::vector<double>& out);
    void reset();

    size_t kernelLength() const { return kernelLength_; }
    size_t outputFrames() const { return outputFrames_; }
    bool active() const { return channels_ > 0; }

private:
    void processBlock(std::vector<double>& out);

    struct Impl;
    std::unique_ptr<Impl> impl_;
    uint32_t channels_ = 0;
    size_t kernelLength_ = 0;
    size_t fftSize_ = 0;
    size_t blockSize_ = 0;
    size_t filled_ = 0;          // new frames in the current block
    size_t outputFrames_ = 0;
};

// Integer-ratio resampler: ×L (zero-stuff, filter at the output rate) or ÷M
// (filter at the input rate, keep every M-th sample).
class FirResampler {
public:
    // True when outRate/inRate (or inRate/outRate) is an integer 2…16.
    static bool supportsRatio(double inputRate, double outputRate);

    bool configure(const FirDesign& design, double inputRate, double outputRate,
                   uint32_t channels, std::string& error);
    void process(const double* in, size_t frames, std::vector<double>& out);
    void flush(std::vector<double>& out);
    void reset();

    size_t taps() const { return taps_; }
    bool active() const { return channels_ > 0; }

private:
    void emit(std::vector<double>& converted, std::vector<double>& out);

    FftConvolver convolver_;
    uint32_t channels_ = 0;
    unsigned up_ = 1;
    unsigned down_ = 1;
    size_t taps_ = 0;
    size_t delay_ = 0;          // high-rate samples trimmed at the start
    size_t trimmed_ = 0;
    size_t decimationPhase_ = 0;
    size_t inputFrames_ = 0;
    size_t outputFrames_ = 0;
    std::vector<double> staging_;
    std::vector<double> converted_;
};

struct ImpulseResponseInfo {
    uint32_t channels = 0;
    double sampleRate = 0;
    size_t taps = 0;           // at its own rate
    size_t peakIndex = 0;
    double peakDb = 0;
};

// Read a room-correction impulse response (WAV/AIFF/FLAC/CAF), resampled to
// `outputRate`, scaled by `gainDb`. One kernel per channel (mono → shared).
bool loadImpulseResponse(const std::string& path, double outputRate, double gainDb,
                         std::vector<std::shared_ptr<const KernelSpectrum>>& spectra,
                         size_t& peakIndex, ImpulseResponseInfo& info, std::string& error);

// Header-only inspection for the settings UI.
bool inspectImpulseResponse(const std::string& path, ImpulseResponseInfo& info, std::string& error);
