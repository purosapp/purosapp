#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// PCM → DSD ("level 3"): 1-bit delta-sigma modulation, sent to the DAC as DoP.
//
// The engine converts the source to an intermediate rate (352.8 kHz) with the
// FIR/SoX resampler and runs DSP there; DsdEncoder then
//   1. interpolates ×8 / ×16 / ×32 to the DSD rate (short polyphase FIR),
//   2. noise-shapes each channel to 1 bit with a high-order delta-sigma loop,
//   3. packs 16 bits per channel into DoP frames (0x05 / 0xFA markers).
//
// Loop filters: noise transfer functions designed here, not copied from any
// product — zeros spread across the audio band with Schreier's optimal
// placement, Butterworth-style poles found by bisection so that the
// out-of-band gain ‖NTF‖∞ meets a target (the usual 1-bit stability rule).

enum class ModulatorType {
    Order5,     // 5th order, ‖NTF‖∞ 1.45 — stable to +1.6 dB over full scale
    Order7,     // 7th order, ‖NTF‖∞ 1.45 — ~11 dB less in-band noise
    // 7th order "extended compensation": an aggressive loop (‖NTF‖∞ 1.6, ~12 dB
    // lower in-band noise again) that hands over to a conservative loop
    // (1.3) with look-ahead, just before loud passages that would destabilize it.
    Order7EC,
};

struct NoiseTransferFunction {
    std::vector<double> b;   // numerator, monic (b[0] = 1)
    std::vector<double> a;   // denominator, monic (a[0] = 1)
    double hInf = 0;         // achieved max |NTF| on the unit circle
};

// NTF for `order` (odd, 3…9) at `sampleRate`, optimized for 0…bandHz.
NoiseTransferFunction designNtf(unsigned order, double sampleRate, double bandHz, double hInf);

// |NTF(e^{jω})| in dB at frequency `hz`.
double ntfMagnitudeDb(const NoiseTransferFunction& ntf, double hz, double sampleRate);

// One channel of 1-bit error-feedback modulation:
//   y = sign(v),  v = x + H(e),  e = y − v,  H = NTF − 1   ⇒   y = x + NTF·e.
class DeltaSigmaModulator {
public:
    // `fallback`: optional conservative NTF used briefly when the loop runs hot.
    void configure(const NoiseTransferFunction& ntf, const NoiseTransferFunction* fallback = nullptr);
    void reset();
    // Writes one bit per input sample into `bits` (MSB first, `bitOffset` running).
    // Input is in DSD units: ±1 = 100 % modulation.
    void process(const double* in, size_t count, size_t stride, uint8_t* bits, size_t& bitOffset);
    uint64_t takeOverloads() { const uint64_t o = overloads_; overloads_ = 0; return o; }
    uint64_t takeHandovers() { const uint64_t h = handovers_; handovers_ = 0; return h; }

private:
    std::vector<double> c_;      // b_k − a_k, k = 1…N
    std::vector<double> a_;      // a_k, k = 1…N
    std::vector<double> safeC_;  // fallback loop (empty → none)
    std::vector<double> safeA_;
    size_t safeRemaining_ = 0;   // samples left on the fallback loop
    std::vector<uint32_t> hotDistance_;
    uint64_t handovers_ = 0;
    std::vector<double> e_;      // past quantization errors (e[n−1] first)
    std::vector<double> w_;      // past loop-filter outputs
    std::vector<double> safeW_;  // the fallback loop's own filter outputs (kept in step)
    size_t order_ = 0;
    double limit_ = 0;           // quantizer input bound before the guard acts
    uint64_t overloads_ = 0;
};

// Short linear-phase polyphase interpolator (×K), interleaved float64.
class PolyphaseInterpolator {
public:
    void configure(unsigned factor, unsigned tapsPerPhase, uint32_t channels);
    void reset();
    // Appends frames × factor output frames.
    void process(const double* in, size_t frames, std::vector<double>& out);

private:
    unsigned factor_ = 1;
    unsigned taps_ = 0;
    uint32_t channels_ = 0;
    std::vector<double> phases_;     // factor × taps, each phase reversed for a forward dot product
    std::vector<double> history_;    // per channel: 2 × taps (mirrored ring)
    size_t position_ = 0;
};

struct DsdEncoderStats {
    double peak = 0;            // highest |input| before scaling (PCM full scale = 1)
    uint64_t overloads = 0;     // modulator guard activations (state reset)
    uint64_t handovers = 0;     // EC switches to the conservative loop
};

class DsdEncoder {
public:
    // Intermediate PCM rate the engine resamples to before encoding.
    static constexpr double kIntermediateRate = 352800.0;

    // `dsdRate`: 2 822 400 (DSD64), 5 644 800 (DSD128) or 11 289 600 (DSD256).
    bool configure(uint32_t dsdRate, ModulatorType type, uint32_t channels, std::string& error);
    void reset();
    // PCM at kIntermediateRate (interleaved, full scale ±1) → DoP frames
    // (8 bytes each: 2 × 32-bit LE words). Leftover bits carry to the next call.
    void encode(const double* in, size_t frames, std::vector<uint8_t>& dop);
    DsdEncoderStats takeStats();

    uint32_t dsdRate() const { return dsdRate_; }
    double carrierRate() const { return dsdRate_ / 16.0; }
    bool active() const { return channels_ > 0; }

private:
    void emitFrames(std::vector<uint8_t>& dop);

    uint32_t dsdRate_ = 0;
    uint32_t channels_ = 0;
    PolyphaseInterpolator interpolator_;
    std::vector<DeltaSigmaModulator> modulators_;
    std::vector<double> scaled_;
    std::vector<double> upsampled_;
    std::vector<std::vector<uint8_t>> bits_;   // per channel, pending bits (MSB first)
    size_t pendingBits_ = 0;
    bool markerPhase_ = false;
    double peak_ = 0;
};
