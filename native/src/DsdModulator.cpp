#include "DsdModulator.h"

#include "DoPHelpers.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstring>
#include <thread>

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr unsigned kMaxOrder = 9;
constexpr unsigned kInterpolatorTaps = 16;
// SACD convention: PCM full scale ↔ 50 % modulation ("0 dB SACD").
constexpr double kDsdScale = 0.5;
// EC: samples to stay on the conservative loop after the last hot input.
constexpr size_t kFallbackHold = 8192;
// EC look-ahead: switch to the conservative loop this many samples before any
// input above kHotLevel (DSD units; 0.32 ≈ −3.9 dBFS PCM) reaches the loop, so
// the aggressive loop never sees a level it cannot handle. (Reacting to the
// quantizer input instead is too late: by then the loop is already diverging.)
constexpr size_t kLookahead = 2048;
constexpr double kHotLevel = 0.32;

// Optimal NTF zero positions as fractions of the band edge (Schreier): the
// roots of the Legendre polynomial of the loop order.
const std::vector<double>& optimalZeroFractions(unsigned order) {
    static const std::vector<double> o3 = {0.774597};
    static const std::vector<double> o5 = {0.538469, 0.906180};
    static const std::vector<double> o7 = {0.405845, 0.741531, 0.949108};
    static const std::vector<double> o9 = {0.324253, 0.613371, 0.836031, 0.968160};
    switch (order) {
        case 3: return o3;
        case 5: return o5;
        case 7: return o7;
        default: return o9;
    }
}

using Complex = std::complex<double>;

// Real coefficients of Π (1 − r_k z^-1).
std::vector<double> polynomialFromRoots(const std::vector<Complex>& roots) {
    std::vector<Complex> poly = {Complex(1.0, 0.0)};
    for (const Complex& r : roots) {
        std::vector<Complex> next(poly.size() + 1, Complex(0.0, 0.0));
        for (size_t i = 0; i < poly.size(); ++i) {
            next[i] += poly[i];
            next[i + 1] -= poly[i] * r;
        }
        poly.swap(next);
    }
    std::vector<double> real(poly.size());
    for (size_t i = 0; i < poly.size(); ++i) real[i] = poly[i].real();
    return real;
}

Complex evaluate(const std::vector<double>& poly, double omega) {
    Complex sum(0.0, 0.0);
    for (size_t k = 0; k < poly.size(); ++k) sum += poly[k] * std::polar(1.0, -omega * static_cast<double>(k));
    return sum;
}

double maxGain(const std::vector<double>& b, const std::vector<double>& a) {
    double peak = 0.0;
    constexpr int kPoints = 512;
    for (int i = 0; i <= kPoints; ++i) {
        const double omega = kPi * static_cast<double>(i) / kPoints;
        peak = std::max(peak, std::abs(evaluate(b, omega) / evaluate(a, omega)));
    }
    return peak;
}

// Digital Butterworth high-pass poles (bilinear, pre-warped), cutoff ωc.
std::vector<Complex> butterworthHighpassPoles(unsigned order, double omegaC) {
    const double warped = std::tan(omegaC / 2.0);
    std::vector<Complex> poles;
    for (unsigned k = 1; k <= order; ++k) {
        const Complex lowpass = std::polar(1.0, kPi * (2.0 * k + order - 1.0) / (2.0 * order));
        const Complex s = warped / lowpass;                   // low-pass → high-pass
        poles.push_back((1.0 + s) / (1.0 - s));              // bilinear
    }
    return poles;
}

}  // namespace

NoiseTransferFunction designNtf(unsigned order, double sampleRate, double bandHz, double hInf) {
    order = std::clamp<unsigned>(order | 1u, 3, kMaxOrder);
    const double bandEdge = 2.0 * kPi * bandHz / sampleRate;

    // Zeros: one at DC, conjugate pairs spread across the band.
    std::vector<Complex> zeros = {Complex(1.0, 0.0)};
    for (double fraction : optimalZeroFractions(order)) {
        zeros.push_back(std::polar(1.0, fraction * bandEdge));
        zeros.push_back(std::polar(1.0, -fraction * bandEdge));
    }

    NoiseTransferFunction ntf;
    ntf.b = polynomialFromRoots(zeros);

    // Poles: the Butterworth cutoff that gives ‖NTF‖∞ = hInf (gain rises with the cutoff).
    double lo = 1e-6, hi = kPi * 0.95;
    for (int iteration = 0; iteration < 48; ++iteration) {
        const double mid = 0.5 * (lo + hi);
        const auto a = polynomialFromRoots(butterworthHighpassPoles(order, mid));
        if (maxGain(ntf.b, a) > hInf) hi = mid; else lo = mid;
    }
    ntf.a = polynomialFromRoots(butterworthHighpassPoles(order, lo));
    ntf.hInf = maxGain(ntf.b, ntf.a);
    return ntf;
}

double ntfMagnitudeDb(const NoiseTransferFunction& ntf, double hz, double sampleRate) {
    const double omega = 2.0 * kPi * hz / sampleRate;
    return 20.0 * std::log10(std::max(std::abs(evaluate(ntf.b, omega) / evaluate(ntf.a, omega)), 1e-300));
}

// ---------------------------------------------------------------------------
// Delta-sigma modulator
// ---------------------------------------------------------------------------

void DeltaSigmaModulator::configure(const NoiseTransferFunction& ntf, const NoiseTransferFunction* fallback) {
    order_ = std::min<size_t>(ntf.a.size() - 1, kMaxOrder);
    const auto split = [&](const NoiseTransferFunction& source, std::vector<double>& c, std::vector<double>& a) {
        c.assign(order_, 0.0);
        a.assign(order_, 0.0);
        for (size_t k = 1; k <= order_ && k < source.a.size(); ++k) {
            c[k - 1] = source.b[k] - source.a[k];
            a[k - 1] = source.a[k];
        }
    };
    split(ntf, c_, a_);
    if (fallback && fallback->a.size() == ntf.a.size()) split(*fallback, safeC_, safeA_);
    else { safeC_.clear(); safeA_.clear(); }
    // Normal operation stays within a few units at full-scale input; runaway grows fast.
    limit_ = 2.0 + static_cast<double>(order_);
    reset();
}

void DeltaSigmaModulator::reset() {
    e_.assign(order_, 0.0);
    w_.assign(order_, 0.0);
    safeW_.assign(order_, 0.0);
    safeRemaining_ = 0;
}

void DeltaSigmaModulator::process(const double* in, size_t count, size_t stride, uint8_t* bits, size_t& bitOffset) {
    // Local copies keep the hot loop in registers / L1.
    double c[kMaxOrder] = {}, a[kMaxOrder] = {}, sc[kMaxOrder] = {}, sa[kMaxOrder] = {};
    double e[kMaxOrder] = {}, w[kMaxOrder] = {}, ws[kMaxOrder] = {};
    const size_t n = order_;
    const bool hasFallback = !safeC_.empty();
    std::copy(c_.begin(), c_.end(), c);
    std::copy(a_.begin(), a_.end(), a);
    if (hasFallback) {
        std::copy(safeC_.begin(), safeC_.end(), sc);
        std::copy(safeA_.begin(), safeA_.end(), sa);
    }
    std::copy(e_.begin(), e_.end(), e);
    std::copy(w_.begin(), w_.end(), w);
    if (hasFallback) std::copy(safeW_.begin(), safeW_.end(), ws);
    size_t safeRemaining = safeRemaining_;

    // Distance (in samples) to the next hot input sample within this block.
    if (hasFallback) {
        hotDistance_.resize(count);
        size_t distance = kLookahead + 1;
        for (size_t i = count; i-- > 0;) {
            distance = std::abs(in[i * stride]) > kHotLevel ? 0 : std::min(distance + 1, kLookahead + 1);
            hotDistance_[i] = static_cast<uint32_t>(distance);
        }
    }

    const auto loop = [&](const double* cc, const double* aa, const double* ww) {
        double sum = 0.0;
        for (size_t k = 0; k < n; ++k) sum += cc[k] * e[k] - aa[k] * ww[k];
        return sum;
    };

    for (size_t i = 0; i < count; ++i) {
        const double x = in[i * stride];
        if (hasFallback && hotDistance_[i] <= kLookahead) {
            if (safeRemaining == 0) ++handovers_;
            safeRemaining = kFallbackHold;
        }
        const bool safe = hasFallback && safeRemaining > 0;
        // With a fallback both loop filters run on the same error sequence all the
        // time, so either can take over with a state that is exactly its own.
        double filtered = loop(c, a, w);
        double filteredSafe = hasFallback ? loop(sc, sa, ws) : 0.0;
        double v = x + (safe ? filteredSafe : filtered);
        if (std::abs(v) > limit_) {
            // Stability guard: the loop is diverging (input too hot for this NTF) — restart it.
            ++overloads_;
            for (size_t k = 0; k < n; ++k) { e[k] = 0.0; w[k] = 0.0; ws[k] = 0.0; }
            filtered = filteredSafe = 0.0;
            v = x;
        }
        if (safeRemaining > 0) --safeRemaining;
        const double y = v >= 0.0 ? 1.0 : -1.0;
        for (size_t k = n - 1; k > 0; --k) { e[k] = e[k - 1]; w[k] = w[k - 1]; ws[k] = ws[k - 1]; }
        e[0] = y - v;
        w[0] = filtered;
        ws[0] = filteredSafe;
        if (y > 0.0) bits[bitOffset >> 3] |= static_cast<uint8_t>(0x80u >> (bitOffset & 7));
        ++bitOffset;
    }

    safeRemaining_ = safeRemaining;
    std::copy(e, e + n, e_.begin());
    std::copy(w, w + n, w_.begin());
    if (hasFallback) std::copy(ws, ws + n, safeW_.begin());
}

// ---------------------------------------------------------------------------
// Polyphase interpolator
// ---------------------------------------------------------------------------

void PolyphaseInterpolator::configure(unsigned factor, unsigned tapsPerPhase, uint32_t channels) {
    factor_ = std::max(1u, factor);
    taps_ = std::max(2u, tapsPerPhase);
    channels_ = channels;
    const size_t length = static_cast<size_t>(factor_) * taps_;
    // Kaiser (β = 8, ≈ −80 dB) windowed sinc; −6 dB at 0.75 × the input Nyquist,
    // flat to ~80 kHz, images of the 352.8 kHz input far into the stopband.
    const double beta = 8.0;
    const auto besselI0 = [](double x) {
        double sum = 1.0, term = 1.0;
        for (int k = 1; k < 200; ++k) {
            term *= (x / (2.0 * k)) * (x / (2.0 * k));
            sum += term;
            if (term < sum * 1e-17) break;
        }
        return sum;
    };
    const double cutoff = 0.75 * kPi / factor_;
    const double center = (static_cast<double>(length) - 1.0) / 2.0;
    std::vector<double> h(length);
    double sum = 0.0;
    for (size_t n = 0; n < length; ++n) {
        const double m = static_cast<double>(n) - center;
        const double r = m / center;
        const double window = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - r * r))) / besselI0(beta);
        const double sinc = std::abs(m) < 1e-12 ? cutoff / kPi : std::sin(cutoff * m) / (kPi * m);
        h[n] = window * sinc;
        sum += h[n];
    }
    // ×factor restores the level lost to zero-stuffing.
    for (double& v : h) v *= static_cast<double>(factor_) / sum;

    phases_.assign(length, 0.0);
    for (unsigned p = 0; p < factor_; ++p) {
        for (unsigned i = 0; i < taps_; ++i) {
            phases_[p * taps_ + i] = h[p + static_cast<size_t>(taps_ - 1 - i) * factor_];
        }
    }
    reset();
}

void PolyphaseInterpolator::reset() {
    history_.assign(static_cast<size_t>(channels_) * taps_ * 2, 0.0);
    position_ = 0;
}

void PolyphaseInterpolator::process(const double* in, size_t frames, std::vector<double>& out) {
    if (channels_ == 0) return;
    const size_t start = out.size();
    out.resize(start + frames * factor_ * channels_);
    double* dst = out.data() + start;
    for (size_t f = 0; f < frames; ++f) {
        for (uint32_t ch = 0; ch < channels_; ++ch) {
            double* hist = history_.data() + static_cast<size_t>(ch) * taps_ * 2;
            const double x = in[f * channels_ + ch];
            hist[position_] = x;
            hist[position_ + taps_] = x;
        }
        position_ = (position_ + 1) % taps_;
        for (uint32_t ch = 0; ch < channels_; ++ch) {
            // Oldest → newest: hist[position_ … position_ + taps − 1].
            const double* window = history_.data() + static_cast<size_t>(ch) * taps_ * 2 + position_;
            for (unsigned p = 0; p < factor_; ++p) {
                const double* coefficients = phases_.data() + static_cast<size_t>(p) * taps_;
                double acc = 0.0;
                for (unsigned i = 0; i < taps_; ++i) acc += coefficients[i] * window[i];
                dst[(f * factor_ + p) * channels_ + ch] = acc;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// DSD encoder (interpolate → modulate → DoP)
// ---------------------------------------------------------------------------

bool DsdEncoder::configure(uint32_t dsdRate, ModulatorType type, uint32_t channels, std::string& error) {
    channels_ = 0;
    const double ratio = dsdRate / kIntermediateRate;
    const unsigned factor = static_cast<unsigned>(std::lround(ratio));
    if ((factor != 8 && factor != 16 && factor != 32) || std::abs(ratio - factor) > 1e-9) {
        error = "Unsupported DSD rate";
        return false;
    }
    if (channels != 2) {
        error = "DoP output needs two channels";
        return false;
    }

    // ‖NTF‖∞ chosen from measured stability with a 1-bit quantizer at 50 % modulation
    // (PCM full scale) plus margin for inter-sample overs.
    const double rate = static_cast<double>(dsdRate);
    const unsigned order = type == ModulatorType::Order5 ? 5 : 7;
    const double hInf = type == ModulatorType::Order7EC ? 1.6 : 1.45;
    const NoiseTransferFunction ntf = designNtf(order, rate, 20000.0, hInf);
    // Conservative loop for EC hand-over: stable well past 60 % modulation.
    const NoiseTransferFunction fallback = designNtf(order, rate, 20000.0, 1.3);

    dsdRate_ = dsdRate;
    interpolator_.configure(factor, kInterpolatorTaps, channels);
    modulators_.assign(channels, DeltaSigmaModulator{});
    for (auto& modulator : modulators_) {
        modulator.configure(ntf, type == ModulatorType::Order7EC ? &fallback : nullptr);
    }
    bits_.assign(channels, std::vector<uint8_t>(4, 0));
    channels_ = channels;
    reset();
    return true;
}

void DsdEncoder::reset() {
    interpolator_.reset();
    for (auto& modulator : modulators_) modulator.reset();
    for (auto& channelBits : bits_) std::fill(channelBits.begin(), channelBits.end(), 0);
    pendingBits_ = 0;
    markerPhase_ = false;
    peak_ = 0;
}

void DsdEncoder::encode(const double* in, size_t frames, std::vector<uint8_t>& dop) {
    if (channels_ == 0 || frames == 0) return;
    scaled_.resize(frames * channels_);
    for (size_t i = 0; i < frames * channels_; ++i) {
        peak_ = std::max(peak_, std::abs(in[i]));
        scaled_[i] = in[i] * kDsdScale;
    }
    upsampled_.clear();
    interpolator_.process(scaled_.data(), frames, upsampled_);
    const size_t samples = upsampled_.size() / channels_;

    const size_t totalBits = pendingBits_ + samples;
    const size_t bytes = (totalBits + 7) / 8 + 2;
    const auto modulateChannel = [&](uint32_t ch) {
        auto& channelBits = bits_[ch];
        // Keep the pending (partial-frame) bits, clear everything after them.
        const size_t keepBytes = (pendingBits_ + 7) / 8;
        channelBits.resize(std::max(channelBits.size(), bytes));
        std::fill(channelBits.begin() + static_cast<ptrdiff_t>(keepBytes), channelBits.end(), 0);
        size_t offset = pendingBits_;
        modulators_[ch].process(upsampled_.data() + ch, samples, channels_, channelBits.data(), offset);
    };
    // The loops are independent per channel and sequential within one: run L and R in parallel
    // for blocks big enough to pay for the thread (DSD128/256 need it on slower Macs).
    if (channels_ == 2 && samples >= 16384) {
        std::thread right(modulateChannel, 1u);
        modulateChannel(0);
        right.join();
    } else {
        for (uint32_t ch = 0; ch < channels_; ++ch) modulateChannel(ch);
    }
    pendingBits_ = totalBits;
    emitFrames(dop);
}

void DsdEncoder::emitFrames(std::vector<uint8_t>& dop) {
    const size_t frames = pendingBits_ / 16;
    const size_t start = dop.size();
    dop.resize(start + frames * 8);
    for (size_t f = 0; f < frames; ++f) {
        packDoPStereoFrame(bits_[0].data() + 2 * f, bits_[1].data() + 2 * f, dop.data() + start + f * 8, markerPhase_);
    }
    // Carry the incomplete frame's bits to the front.
    const size_t remaining = pendingBits_ - frames * 16;
    for (auto& channelBits : bits_) {
        const uint8_t first = channelBits[2 * frames];
        const uint8_t second = channelBits[2 * frames + 1];
        std::fill(channelBits.begin(), channelBits.end(), 0);
        channelBits[0] = first;
        channelBits[1] = second;
    }
    pendingBits_ = remaining;
}

DsdEncoderStats DsdEncoder::takeStats() {
    DsdEncoderStats stats;
    stats.peak = peak_;
    peak_ = 0;
    for (auto& modulator : modulators_) {
        stats.overloads += modulator.takeOverloads();
        stats.handovers += modulator.takeHandovers();
    }
    return stats;
}
