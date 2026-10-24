#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// DSD → PCM: the 1-bit stream is decimated to a PCM rate in float64, streaming,
// as the first stage of the engine's processing chain (no intermediate file).
//
//   1. ÷8 straight from the bits: a linear-phase FIR evaluated eight taps at a
//      time through per-byte lookup tables (one table read per byte of history);
//   2. ÷2 stages (Kaiser windowed sinc, vDSP dot products) down to the PCM rate;
//   3. with an ultrasonic filter, a linear-phase low-pass at the PCM rate
//      (−6 dB at the cutoff) for the DSD noise shelf.
//
// Each decimating stage only has to keep aliases out of the final band, so the
// early ones stay short. The last one sets the response — flat to 0.43 × the PCM
// rate and 120 dB down at its Nyquist — unless the ultrasonic filter does, which
// is cheaper at the lowest rate than folded into a decimating stage.
//
// Bits map to ±1, so 100 % modulation is PCM full scale (SACD's 0 dB reference,
// 50 % modulation, lands at −6 dBFS; `gainDb` compensates). Group delay is
// trimmed and the tail flushed, so the PCM is time-aligned with the source and
// exactly bits / ratio frames long.

class DsdDecimator {
public:
    // Stopband attenuation of every stage (dB).
    static constexpr double kAttenuationDb = 120.0;
    // Passband edge without an ultrasonic filter, as a fraction of the PCM rate.
    static constexpr double kPassbandFraction = 0.43;

    // PCM rate a stream at `dsdRate` decodes to: dsdRate / 2^k (k ≥ 3), the lowest
    // such rate at or above `requested`, at most dsdRate / 8. 0 when `dsdRate` has
    // no such rate (not a multiple of 8).
    static uint32_t decodeRate(uint32_t dsdRate, uint32_t requested);

    // `pcmRate` must be dsdRate / 2^k, k ≥ 3. `filterHz` 0 = no ultrasonic filter.
    bool configure(uint32_t dsdRate, uint32_t pcmRate, double filterHz, double gainDb, uint32_t channels,
                   std::string& error);
    void reset();
    // `bytes[ch]` holds `count` bytes of channel ch, the oldest bit in the MSB.
    // Appends interleaved PCM frames to `out`.
    void process(const uint8_t* const* bytes, size_t count, std::vector<double>& out);
    // End of stream: drains the filters until bits / ratio frames have been produced.
    void flush(std::vector<double>& out);

    uint32_t dsdRate() const { return dsdRate_; }
    uint32_t pcmRate() const { return pcmRate_; }
    uint32_t ratio() const { return pcmRate_ > 0 ? dsdRate_ / pcmRate_ : 0; }
    unsigned stageCount() const { return static_cast<unsigned>(stages_.size()) + (channels_ > 0 ? 1 : 0); }
    double filterHz() const { return filterHz_; }
    double gainDb() const { return gainDb_; }
    size_t latencyFrames() const { return latency_; }
    bool active() const { return channels_ > 0; }

private:
    struct FirStage {
        std::vector<double> taps;       // reversed: dotted with the window oldest → newest
        std::vector<double> history;    // per channel: 2 × taps (mirrored ring)
        bool decimate = true;           // ÷2, keeping the even input samples
        size_t position = 0;
        bool emit = true;
    };

    // `bytes` null feeds silence (zero contribution) for flushing.
    void run(const uint8_t* const* bytes, size_t count, std::vector<double>& out);

    uint32_t dsdRate_ = 0;
    uint32_t pcmRate_ = 0;
    uint32_t channels_ = 0;
    double filterHz_ = 0;
    double gainDb_ = 0;
    double gain_ = 1.0;

    // ÷8 stage: groups_ tables of 257 entries (byte value, 256 = silence).
    size_t groups_ = 0;
    std::vector<double> tables_;
    std::vector<uint16_t> byteHistory_;  // per channel: 2 × groups_
    size_t bytePosition_ = 0;

    std::vector<FirStage> stages_;      // after the ÷8 stage
    std::vector<std::vector<double>> scratch_;   // per channel, per block
    std::vector<double> stageOut_;

    size_t latency_ = 0;        // PCM frames trimmed after a reset
    size_t trimmed_ = 0;
    uint64_t inputBytes_ = 0;   // per channel since reset
    uint64_t outputFrames_ = 0; // emitted since reset (after trimming)
};
