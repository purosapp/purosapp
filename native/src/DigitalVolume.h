#pragma once

#include <CoreAudio/CoreAudioTypes.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

// Exclusive-mode digital (DSP) volume — the "DSP volume" option of a Roon-style
// volume control. Runs on the real-time IO thread: no allocations, no locks.
//
// Gain is computed in double precision, ramped linearly across one callback to
// avoid zipper noise, then requantized with ±1 LSB TPDF dither at the DAC's
// real resolution (e.g. 24 bits inside a 32-bit container). At unity gain the
// buffer is not touched at all, so the output stays bit-perfect.
class DigitalVolume {
public:
    // Any thread.
    void setTarget(double gain) {
        if (!std::isfinite(gain)) return;
        target_.store(std::clamp(gain, 0.0, 1.0), std::memory_order_relaxed);
    }
    double target() const { return target_.load(std::memory_order_relaxed); }

    // IO thread only. `physicalBits` is the DAC's integer resolution (0 when unknown
    // or float); `passthrough` skips sample changes for payloads that must not be
    // scaled, such as DoP.
    void process(AudioBufferList* bufferList, const AudioStreamBasicDescription& format,
                 uint32_t physicalBits, bool passthrough) {
        const double target = target_.load(std::memory_order_relaxed);
        const double start = current_;
        if (start == 1.0 && target == 1.0) return;  // bit-perfect bypass
        current_ = target;

        const UInt32 flags = format.mFormatFlags;
        const bool isFloat = (flags & kAudioFormatFlagIsFloat) != 0;
        const bool isSigned = (flags & kAudioFormatFlagIsSignedInteger) != 0;
        const bool nonInterleaved = (flags & kAudioFormatFlagIsNonInterleaved) != 0;
        if (passthrough || !bufferList || format.mFormatID != kAudioFormatLinearPCM ||
            format.mBytesPerFrame == 0 || format.mChannelsPerFrame == 0 ||
            (flags & kAudioFormatFlagIsBigEndian) != 0 || (!isFloat && !isSigned)) {
            return;
        }

        const uint32_t bytesPerSample = nonInterleaved
            ? format.mBytesPerFrame
            : format.mBytesPerFrame / format.mChannelsPerFrame;
        if (isFloat ? bytesPerSample != 4 : (bytesPerSample < 2 || bytesPerSample > 4)) return;

        // Where the valid bits sit in the container, and how finely the DAC resolves them.
        const uint32_t containerBits = bytesPerSample * 8;
        const uint32_t validBits = format.mBitsPerChannel > 0
            ? std::min<uint32_t>(format.mBitsPerChannel, containerBits)
            : containerBits;
        const bool alignedHigh = (flags & kAudioFormatFlagIsAlignedHigh) != 0;
        const uint32_t valueBits = (validBits == containerBits || alignedHigh) ? containerBits : validBits;
        const uint32_t ditherBits = physicalBits >= 16 ? std::min(validBits, physicalBits) : validBits;
        const double fullScale = std::ldexp(1.0, static_cast<int>(valueBits) - 1);
        const double step = std::ldexp(1.0, static_cast<int>(valueBits) - static_cast<int>(ditherBits));
        const double maxValue = fullScale - step;

        // Float stream into an integer DAC (HAL converts): dither onto the DAC's grid so that
        // conversion is exact. float32 holds 24-bit steps exactly; deeper DACs just get scaled.
        const bool ditherFloat = isFloat && physicalBits >= 16 && physicalBits <= 24;
        const double floatLevels = ditherFloat ? std::ldexp(1.0, static_cast<int>(physicalBits) - 1) : 1.0;
        const double floatMax = (floatLevels - 1.0) / floatLevels;

        for (UInt32 b = 0; b < bufferList->mNumberBuffers; b++) {
            auto& buf = bufferList->mBuffers[b];
            if (!buf.mData || buf.mNumberChannels == 0) continue;
            const uint32_t channels = nonInterleaved ? 1 : buf.mNumberChannels;
            const uint32_t frameBytes = bytesPerSample * channels;
            const uint32_t frames = buf.mDataByteSize / frameBytes;
            auto* data = static_cast<uint8_t*>(buf.mData);
            const double delta = frames > 0 ? (target - start) / frames : 0.0;

            for (uint32_t f = 0; f < frames; f++) {
                const double gain = start + delta * (f + 1);
                uint8_t* frame = data + static_cast<size_t>(f) * frameBytes;
                for (uint32_t ch = 0; ch < channels; ch++) {
                    uint8_t* sample = frame + ch * bytesPerSample;
                    if (isFloat) {
                        float v;
                        std::memcpy(&v, sample, 4);
                        double out = v * gain;
                        if (ditherFloat) {
                            out = gain > 0.0
                                ? std::clamp(std::floor(out * floatLevels + tpdf() + 0.5) / floatLevels, -1.0, floatMax)
                                : 0.0;
                        }
                        v = static_cast<float>(out);
                        std::memcpy(sample, &v, 4);
                        continue;
                    }

                    // Digital silence stays silent — no dither noise when muted.
                    int32_t q = 0;
                    if (gain > 0.0) {
                        const double scaled = readInteger(sample, bytesPerSample) * gain / step + tpdf();
                        q = static_cast<int32_t>(std::clamp(std::floor(scaled + 0.5) * step, -fullScale, maxValue));
                    }
                    writeInteger(sample, bytesPerSample, q);
                }
            }
        }
    }

private:
    static int32_t readInteger(const uint8_t* sample, uint32_t bytesPerSample) {
        if (bytesPerSample == 2) {
            int16_t v;
            std::memcpy(&v, sample, 2);
            return v;
        }
        if (bytesPerSample == 3) {
            int32_t v = sample[0] | (sample[1] << 8) | (sample[2] << 16);
            if (v & 0x800000) v |= static_cast<int32_t>(0xFF000000u);
            return v;
        }
        int32_t v;
        std::memcpy(&v, sample, 4);
        return v;
    }

    static void writeInteger(uint8_t* sample, uint32_t bytesPerSample, int32_t value) {
        if (bytesPerSample == 2) {
            const auto v = static_cast<int16_t>(value);
            std::memcpy(sample, &v, 2);
        } else if (bytesPerSample == 3) {
            sample[0] = static_cast<uint8_t>(value & 0xFF);
            sample[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
            sample[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
        } else {
            std::memcpy(sample, &value, 4);
        }
    }

    // xorshift64* — cheap and good enough for dither.
    uint64_t nextRandom() {
        rng_ ^= rng_ >> 12;
        rng_ ^= rng_ << 25;
        rng_ ^= rng_ >> 27;
        return rng_ * 0x2545F4914F6CDD1Dull;
    }

    // Triangular PDF in (-1, 1) LSB.
    double tpdf() {
        constexpr double scale = 1.0 / 9007199254740992.0;  // 2^-53
        const double a = static_cast<double>(nextRandom() >> 11) * scale;
        const double b = static_cast<double>(nextRandom() >> 11) * scale;
        return a - b;
    }

    std::atomic<double> target_{1.0};
    double current_ = 1.0;
    uint64_t rng_ = 0x9E3779B97F4A7C15ull;
};
