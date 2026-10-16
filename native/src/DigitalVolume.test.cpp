#include "DigitalVolume.h"
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <vector>

namespace {

AudioStreamBasicDescription intFormat(uint32_t bits, uint32_t bytes, bool alignedHigh = false) {
    AudioStreamBasicDescription f{};
    f.mSampleRate = 44100;
    f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    if (alignedHigh) f.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsAlignedHigh;
    f.mChannelsPerFrame = 2;
    f.mBitsPerChannel = bits;
    f.mBytesPerFrame = bytes * 2;
    f.mFramesPerPacket = 1;
    f.mBytesPerPacket = f.mBytesPerFrame;
    return f;
}

AudioBufferList makeList(void* data, uint32_t bytes) {
    AudioBufferList list{};
    list.mNumberBuffers = 1;
    list.mBuffers[0].mNumberChannels = 2;
    list.mBuffers[0].mDataByteSize = bytes;
    list.mBuffers[0].mData = data;
    return list;
}

template <typename T>
void run(DigitalVolume& volume, std::vector<T>& samples, const AudioStreamBasicDescription& format,
         uint32_t physicalBits = 0, bool passthrough = false) {
    auto list = makeList(samples.data(), static_cast<uint32_t>(samples.size() * sizeof(T)));
    volume.process(&list, format, physicalBits, passthrough);
}

}  // namespace

int main() {
    // Unity gain never touches samples — bit-perfect for every container.
    {
        DigitalVolume volume;
        std::vector<int16_t> s16(512);
        std::vector<int32_t> s32(512);
        for (size_t i = 0; i < s16.size(); ++i) {
            s16[i] = static_cast<int16_t>((i * 7919) % 65536 - 32768);
            s32[i] = static_cast<int32_t>(i * 2654435761u);
        }
        const auto ref16 = s16;
        const auto ref32 = s32;
        run(volume, s16, intFormat(16, 2));
        run(volume, s32, intFormat(32, 4), 24);
        assert(s16 == ref16);
        assert(s32 == ref32);

        // Returning to unity after an attenuation also ends with untouched buffers.
        volume.setTarget(0.5);
        run(volume, s16, intFormat(16, 2));
        volume.setTarget(1.0);
        run(volume, s16, intFormat(16, 2));  // ramp back
        s16 = ref16;
        run(volume, s16, intFormat(16, 2));
        assert(s16 == ref16);
    }

    // -6 dB on 16-bit: settled output is half, within dither (±1 LSB), and unbiased.
    {
        DigitalVolume volume;
        volume.setTarget(0.5);
        std::vector<int16_t> ramp(512, 10000);
        run(volume, ramp, intFormat(16, 2));
        assert(std::abs(ramp[0] - 10000) < 60);   // ramp starts near the previous gain
        assert(std::abs(ramp[511] - 5000) <= 1);  // and ends at the target

        double sum = 0;
        for (int pass = 0; pass < 64; ++pass) {
            std::vector<int16_t> s(512, 10001);
            run(volume, s, intFormat(16, 2));
            for (int16_t v : s) {
                assert(std::abs(v - 5000.5) <= 1.5);
                sum += v;
            }
        }
        assert(std::abs(sum / (64 * 512) - 5000.5) < 0.05);
    }

    // Mute is exact digital silence, without dither noise.
    {
        DigitalVolume volume;
        volume.setTarget(0.0);
        std::vector<int16_t> s(512, 12345);
        run(volume, s, intFormat(16, 2));
        run(volume, s, intFormat(16, 2));
        for (int16_t v : s) assert(v == 0);
    }

    // 24-bit DAC in a 32-bit container: requantized to the 24-bit grid, never wraps.
    {
        DigitalVolume volume;
        volume.setTarget(0.25);
        std::vector<int32_t> s(512, INT32_MIN);
        run(volume, s, intFormat(32, 4), 24);
        s.assign(512, INT32_MIN);
        run(volume, s, intFormat(32, 4), 24);
        for (int32_t v : s) {
            assert((v & 0xFF) == 0);
            assert(std::abs(static_cast<double>(v) - INT32_MIN * 0.25) <= 256.0);
        }
        s.assign(512, INT32_MAX);
        run(volume, s, intFormat(32, 4, true), 24);
        for (int32_t v : s) assert(v > 0 && (v & 0xFF) == 0);
    }

    // Packed 24-bit keeps sign.
    {
        DigitalVolume volume;
        volume.setTarget(0.5);
        std::vector<uint8_t> s(6 * 256);
        for (size_t i = 0; i < s.size(); i += 3) { s[i] = 0x00; s[i + 1] = 0x00; s[i + 2] = 0xC0; }  // -4194304
        run(volume, s, intFormat(24, 3));
        for (size_t i = 0; i < s.size(); i += 3) { s[i] = 0x00; s[i + 1] = 0x00; s[i + 2] = 0xC0; }
        run(volume, s, intFormat(24, 3));
        for (size_t i = 0; i < s.size(); i += 3) {
            int32_t v = s[i] | (s[i + 1] << 8) | (s[i + 2] << 16);
            if (v & 0x800000) v |= static_cast<int32_t>(0xFF000000u);
            assert(std::abs(v + 2097152) <= 1);
        }
    }

    // DoP payloads pass through untouched even when attenuated.
    {
        DigitalVolume volume;
        volume.setTarget(0.3);
        std::vector<int32_t> s(512, 0x05AA6900);
        const auto ref = s;
        run(volume, s, intFormat(32, 4), 24, true);
        run(volume, s, intFormat(32, 4), 24, true);
        assert(s == ref);
    }

    // Float output is scaled without requantization.
    {
        DigitalVolume volume;
        volume.setTarget(0.5);
        auto format = intFormat(32, 4);
        format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
        std::vector<float> s(512, 0.8f);
        run(volume, s, format);
        s.assign(512, 0.8f);
        run(volume, s, format);
        for (float v : s) assert(v == 0.4f);

        // Float stream feeding a 24-bit DAC: dithered onto the 24-bit grid, unbiased.
        double sum = 0;
        for (int pass = 0; pass < 64; ++pass) {
            s.assign(512, 0.8f);
            run(volume, s, format, 24);
            for (float v : s) {
                const double steps = v * 8388608.0;
                assert(steps == std::floor(steps));
                assert(std::abs(v - 0.4) <= 1.5 / 8388608.0);
                sum += v;
            }
        }
        assert(std::abs(sum / (64 * 512) - 0.4) < 0.05 / 8388608.0);
    }

    return 0;
}
