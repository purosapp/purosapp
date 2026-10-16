#include <cassert>
#include <cstdint>

#include "DoPHelpers.h"

int main() {
    {
        uint8_t pcmOut[8]{};
        const uint8_t left[2] = {0x12, 0x34};
        const uint8_t right[2] = {0x56, 0x78};
        bool markerPhase = false;

        packDoPStereoFrame(left, right, pcmOut, markerPhase);

        assert(pcmOut[0] == 0x00);
        assert(pcmOut[1] == 0x34);
        assert(pcmOut[2] == 0x12);
        assert(pcmOut[3] == 0x05);
        assert(pcmOut[4] == 0x00);
        assert(pcmOut[5] == 0x78);
        assert(pcmOut[6] == 0x56);
        assert(pcmOut[7] == 0x05);
        assert(markerPhase);
    }

    {
        uint8_t pcmOut[8]{};
        const uint8_t left[2] = {0xAB, 0xCD};
        const uint8_t right[2] = {0xEF, 0x01};
        bool markerPhase = true;

        packDoPStereoFrame(left, right, pcmOut, markerPhase);

        assert(pcmOut[0] == 0x00);
        assert(pcmOut[1] == 0xCD);
        assert(pcmOut[2] == 0xAB);
        assert(pcmOut[3] == 0xFA);
        assert(pcmOut[4] == 0x00);
        assert(pcmOut[5] == 0x01);
        assert(pcmOut[6] == 0xEF);
        assert(pcmOut[7] == 0xFA);
        assert(!markerPhase);
    }

    {
        const auto asbd64 = buildDoPASBD(2822400.0);
        assert(asbd64.mSampleRate == 176400.0);
        assert(asbd64.mBitsPerChannel == 32);
        assert(asbd64.mChannelsPerFrame == 2);
        assert(asbd64.mBytesPerFrame == 8);
        assert((asbd64.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0);
        assert((asbd64.mFormatFlags & kAudioFormatFlagIsPacked) != 0);
        assert((asbd64.mFormatFlags & kAudioFormatFlagIsBigEndian) == 0);
    }

    {
        const auto asbd256 = buildDoPASBD(11289600.0);
        assert(asbd256.mSampleRate == 705600.0);
        assert(asbd256.mBitsPerChannel == 32);
    }

    {
        const auto invalid = buildDoPASBD(6144000.0);
        assert(invalid.mFormatID == 0);
    }

    return 0;
}
