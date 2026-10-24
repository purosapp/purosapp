#include "DsdDecimator.h"

#include <Accelerate/Accelerate.h>
#include <algorithm>
#include <cmath>

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr size_t kTableSize = 257;      // 256 byte values + silence
constexpr uint16_t kSilence = 256;

double besselI0(double x) {
    double sum = 1.0, term = 1.0;
    for (int k = 1; k < 300; ++k) {
        term *= (x / (2.0 * k)) * (x / (2.0 * k));
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

// Kaiser length for a transition from `pass` to `stop` at `rate` (Kaiser's formula).
size_t kaiserLength(double rate, double pass, double stop) {
    const double width = (stop - pass) / rate;
    return static_cast<size_t>(std::ceil((DsdDecimator::kAttenuationDb - 7.95) / (14.36 * width))) + 1;
}

// Kaiser windowed sinc, −6 dB midway between `pass` and `stop`, unity DC gain. `shift`
// (samples, |shift| ≪ length) delays the sinc against the window for a fractional delay.
std::vector<double> kaiserLowpass(size_t length, double rate, double pass, double stop, double shift = 0.0) {
    const double cutoff = 0.5 * (pass + stop) / rate;   // cycles per sample
    const double beta = 0.1102 * (DsdDecimator::kAttenuationDb - 8.7);
    const double center = (static_cast<double>(length) - 1.0) / 2.0;
    const double norm = besselI0(beta);
    std::vector<double> h(length);
    double sum = 0.0;
    for (size_t n = 0; n < length; ++n) {
        const double r = center > 0 ? (static_cast<double>(n) - center) / center : 0.0;
        const double m = static_cast<double>(n) - center - shift;
        const double window = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - r * r))) / norm;
        const double sinc = std::abs(m) < 1e-12 ? 2.0 * cutoff : std::sin(2.0 * kPi * cutoff * m) / (kPi * m);
        h[n] = window * sinc;
        sum += h[n];
    }
    for (double& v : h) v /= sum;
    return h;
}

}  // namespace

uint32_t DsdDecimator::decodeRate(uint32_t dsdRate, uint32_t requested) {
    if (dsdRate == 0 || dsdRate % 8 != 0) return 0;
    uint32_t rate = dsdRate / 8;
    while (rate % 2 == 0 && rate / 2 >= requested) rate /= 2;
    return rate;
}

bool DsdDecimator::configure(uint32_t dsdRate, uint32_t pcmRate, double filterHz, double gainDb, uint32_t channels,
                             std::string& error) {
    channels_ = 0;
    if (channels == 0 || pcmRate == 0 || dsdRate % pcmRate != 0) {
        error = "Unsupported DSD to PCM rate";
        return false;
    }
    const uint32_t ratio = dsdRate / pcmRate;
    if (ratio < 8 || (ratio & (ratio - 1)) != 0) {
        error = "DSD to PCM needs a power-of-two ratio of at least 8";
        return false;
    }

    // Final band: flat to `pass`, fully attenuated from `stop` (at most the PCM Nyquist).
    const double nyquist = pcmRate / 2.0;
    double pass = kPassbandFraction * pcmRate;
    double stop = nyquist;
    filterHz_ = 0;
    if (filterHz > 0) {
        const double filterStop = std::min(filterHz * 1.15, nyquist);
        const double filterPass = std::min(filterHz * 0.85, pass);
        if (filterPass < filterStop && filterHz < nyquist) {
            pass = filterPass;
            stop = filterStop;
            filterHz_ = filterHz;
        }
    }

    unsigned halvingCount = 0;
    for (uint32_t r = ratio / 8; r > 1; r /= 2) ++halvingCount;
    // Decimating stages keep aliases out of [0, stop]; without the ultrasonic filter the
    // last one also sets the final response.
    const bool shaping = filterHz_ > 0;
    const auto stopFor = [&](double outRate, bool last) { return last && !shaping ? stop : outRate - stop; };

    // Plan every stage first: the group delays add up to a fractional number of PCM
    // frames, and the last stage's sinc is shifted by the remainder so that trimming
    // whole frames leaves the output exactly time-aligned.
    struct Plan { double rate; double stop; size_t length; bool decimate; };
    std::vector<Plan> plans;
    const double firstStop = stopFor(dsdRate / 8.0, halvingCount == 0);
    plans.push_back({static_cast<double>(dsdRate), firstStop, (kaiserLength(dsdRate, pass, firstStop) + 7) / 8 * 8, true});
    double rate = dsdRate / 8.0;
    for (unsigned s = 0; s < halvingCount; ++s) {
        const double stageStop = stopFor(rate / 2.0, s + 1 == halvingCount);
        plans.push_back({rate, stageStop, kaiserLength(rate, pass, stageStop) | 1, true});   // odd length
        rate /= 2.0;
    }
    if (shaping) plans.push_back({rate, stop, kaiserLength(rate, pass, stop) | 1, false});

    // ÷8: output m (after byte m) is centred (length/2 − 7.5) bits before the byte boundary 8m;
    // the others are centred (length − 1)/2 input samples back.
    double delaySeconds = (plans[0].length / 2.0 - 7.5) / dsdRate;
    for (size_t p = 1; p < plans.size(); ++p) delaySeconds += (plans[p].length - 1.0) / (2.0 * plans[p].rate);
    latency_ = static_cast<size_t>(std::llround(delaySeconds * pcmRate));
    const double lastShift = (static_cast<double>(latency_) / pcmRate - delaySeconds) * plans.back().rate;

    const auto design = [&](size_t p) {
        std::vector<double> h = kaiserLowpass(plans[p].length, plans[p].rate, pass, plans[p].stop,
                                              p + 1 == plans.size() ? lastShift : 0.0);
        // Convolution order: windows run oldest → newest, so the newest sample meets h[0].
        std::reverse(h.begin(), h.end());
        return h;
    };

    // ÷8 from the bits: one table per eight taps, indexed by the byte (MSB = oldest bit).
    groups_ = plans[0].length / 8;
    const std::vector<double> first = design(0);
    tables_.assign(groups_ * kTableSize, 0.0);
    for (size_t g = 0; g < groups_; ++g) {
        for (unsigned value = 0; value < 256; ++value) {
            double acc = 0.0;
            for (unsigned bit = 0; bit < 8; ++bit) {
                const double sample = ((value >> (7 - bit)) & 1) ? 1.0 : -1.0;
                acc += first[g * 8 + bit] * sample;
            }
            tables_[g * kTableSize + value] = acc;
        }
    }

    stages_.clear();
    for (size_t p = 1; p < plans.size(); ++p) {
        FirStage stage;
        stage.taps = design(p);
        stage.decimate = plans[p].decimate;
        stages_.push_back(std::move(stage));
    }

    dsdRate_ = dsdRate;
    pcmRate_ = pcmRate;
    channels_ = channels;
    gainDb_ = gainDb;
    gain_ = std::pow(10.0, gainDb / 20.0);
    scratch_.assign(channels, {});
    reset();
    return true;
}

void DsdDecimator::reset() {
    byteHistory_.assign(static_cast<size_t>(channels_) * groups_ * 2, kSilence);
    bytePosition_ = 0;
    for (FirStage& stage : stages_) {
        stage.history.assign(static_cast<size_t>(channels_) * stage.taps.size() * 2, 0.0);
        stage.position = 0;
        stage.emit = true;
    }
    trimmed_ = 0;
    inputBytes_ = 0;
    outputFrames_ = 0;
}

void DsdDecimator::process(const uint8_t* const* bytes, size_t count, std::vector<double>& out) {
    if (channels_ == 0 || count == 0) return;
    inputBytes_ += count;
    run(bytes, count, out);
}

void DsdDecimator::flush(std::vector<double>& out) {
    if (channels_ == 0) return;
    const uint64_t target = inputBytes_ * 8 / ratio();
    const size_t start = out.size();
    const uint64_t before = outputFrames_;
    while (outputFrames_ < target) run(nullptr, 1024, out);
    const uint64_t keep = target > before ? target - before : 0;
    out.resize(start + static_cast<size_t>(keep) * channels_);
    outputFrames_ = std::max(before, target);
}

void DsdDecimator::run(const uint8_t* const* bytes, size_t count, std::vector<double>& out) {
    size_t nextBytePosition = bytePosition_;
    std::vector<size_t> nextPositions(stages_.size());
    std::vector<bool> nextEmit(stages_.size());

    for (uint32_t ch = 0; ch < channels_; ++ch) {
        // ÷8: one output per byte, the window read oldest → newest from the mirrored ring.
        std::vector<double>& samples = scratch_[ch];
        samples.resize(count);
        uint16_t* history = byteHistory_.data() + static_cast<size_t>(ch) * groups_ * 2;
        size_t position = bytePosition_;
        for (size_t i = 0; i < count; ++i) {
            const uint16_t value = bytes ? bytes[ch][i] : kSilence;
            history[position] = value;
            history[position + groups_] = value;
            position = position + 1 == groups_ ? 0 : position + 1;
            const uint16_t* window = history + position;
            const double* table = tables_.data();
            // Four partial sums: one running sum would serialize on the add latency.
            double acc0 = 0.0, acc1 = 0.0, acc2 = 0.0, acc3 = 0.0;
            size_t g = 0;
            for (; g + 4 <= groups_; g += 4, table += 4 * kTableSize) {
                acc0 += table[window[g]];
                acc1 += table[kTableSize + window[g + 1]];
                acc2 += table[2 * kTableSize + window[g + 2]];
                acc3 += table[3 * kTableSize + window[g + 3]];
            }
            for (; g < groups_; ++g, table += kTableSize) acc0 += table[window[g]];
            samples[i] = (acc0 + acc1) + (acc2 + acc3);
        }
        nextBytePosition = position;

        // ÷2 stages (keeping the even input samples), then the ultrasonic filter.
        for (size_t s = 0; s < stages_.size(); ++s) {
            FirStage& stage = stages_[s];
            const size_t length = stage.taps.size();
            double* ring = stage.history.data() + static_cast<size_t>(ch) * length * 2;
            size_t pos = stage.position;
            bool emit = stage.emit;
            stageOut_.clear();
            for (const double x : samples) {
                ring[pos] = x;
                ring[pos + length] = x;
                pos = pos + 1 == length ? 0 : pos + 1;
                if (emit) {
                    double y = 0.0;
                    vDSP_dotprD(ring + pos, 1, stage.taps.data(), 1, &y, length);
                    stageOut_.push_back(y);
                }
                if (stage.decimate) emit = !emit;
            }
            samples.swap(stageOut_);
            nextPositions[s] = pos;
            nextEmit[s] = emit;
        }
    }

    // Every channel ran from the same state; advance it once.
    bytePosition_ = nextBytePosition;
    for (size_t s = 0; s < stages_.size(); ++s) {
        stages_[s].position = nextPositions[s];
        stages_[s].emit = nextEmit[s];
    }

    const size_t frames = scratch_[0].size();
    const size_t skip = std::min(latency_ - trimmed_, frames);
    trimmed_ += skip;
    const size_t start = out.size();
    out.resize(start + (frames - skip) * channels_);
    double* dst = out.data() + start;
    for (size_t f = skip; f < frames; ++f) {
        for (uint32_t ch = 0; ch < channels_; ++ch) *dst++ = scratch_[ch][f] * gain_;
    }
    outputFrames_ += frames - skip;
}
