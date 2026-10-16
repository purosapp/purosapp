#include "Resampler.h"

#include <soxr.h>

SoxrResampler::~SoxrResampler() { release(); }

void SoxrResampler::release() {
    if (soxr_) soxr_delete(static_cast<soxr_t>(soxr_));
    soxr_ = nullptr;
}

bool SoxrResampler::configure(const SoxrFilterConfig& config, double inputRate, double outputRate,
                              uint32_t channels, std::string& error) {
    release();
    if (inputRate <= 0 || outputRate <= 0 || channels == 0) {
        error = "Invalid resampler format";
        return false;
    }

    unsigned long recipe = std::min(config.recipe, 7u);
    if (config.phaseResponse <= 0.0) recipe |= SOXR_MINIMUM_PHASE;
    else if (config.phaseResponse < 50.0) recipe |= SOXR_INTERMEDIATE_PHASE;
    if (config.steepFilter) recipe |= SOXR_STEEP_FILTER;

    soxr_quality_spec_t quality = soxr_quality_spec(recipe, 0);
    // Quick (cubic) interpolation has no filter to tune.
    if (config.recipe > 0) {
        if (config.precision > 0) quality.precision = std::clamp(config.precision, 15.0, 33.0);
        quality.phase_response = std::clamp(config.phaseResponse, 0.0, 100.0);
        if (config.passbandEnd > 0) quality.passband_end = std::clamp(config.passbandEnd, 0.5, 0.995);
        if (config.stopbandBegin > 0) {
            quality.stopband_begin = std::max(config.stopbandBegin, quality.passband_end + 0.005);
        }
        // Aliasing allowed: the transition band straddles Nyquist (SoX `rate -a`).
        if (config.allowAliasing) quality.stopband_begin = 2.0 - quality.passband_end;
        if (quality.precision > 20) quality.flags |= SOXR_DOUBLE_PRECISION;
    }

    const soxr_io_spec_t io = soxr_io_spec(SOXR_FLOAT64_I, SOXR_FLOAT64_I);
    const soxr_runtime_spec_t runtime = soxr_runtime_spec(1);
    soxr_error_t soxrError = nullptr;
    soxr_ = soxr_create(inputRate, outputRate, channels, &soxrError, &io, &quality, &runtime);
    if (!soxr_ || soxrError) {
        error = std::string("SoX resampler: ") + soxr_strerror(soxrError);
        release();
        return false;
    }
    channels_ = channels;
    inputRate_ = inputRate;
    outputRate_ = outputRate;
    return true;
}

void SoxrResampler::process(const double* in, size_t frames, std::vector<double>& out) {
    if (!soxr_ || frames == 0) return;
    const double ratio = outputRate_ / inputRate_;
    size_t consumed = 0;
    while (consumed < frames) {
        const size_t capacity = static_cast<size_t>(std::ceil((frames - consumed) * ratio)) + 64;
        const size_t start = out.size();
        out.resize(start + capacity * channels_);
        size_t used = 0;
        size_t produced = 0;
        soxr_process(static_cast<soxr_t>(soxr_), in + consumed * channels_, frames - consumed, &used,
                     out.data() + start, capacity, &produced);
        out.resize(start + produced * channels_);
        consumed += used;
        if (used == 0 && produced == 0) break;
    }
}

void SoxrResampler::flush(std::vector<double>& out) {
    if (!soxr_) return;
    for (;;) {
        const size_t capacity = 4096;
        const size_t start = out.size();
        out.resize(start + capacity * channels_);
        size_t produced = 0;
        soxr_process(static_cast<soxr_t>(soxr_), nullptr, 0, nullptr, out.data() + start, capacity, &produced);
        out.resize(start + produced * channels_);
        if (produced < capacity) break;
    }
}

void SoxrResampler::reset() {
    if (soxr_) soxr_clear(static_cast<soxr_t>(soxr_));
}
