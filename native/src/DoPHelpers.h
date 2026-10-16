#pragma once

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <cstdint>

enum class DoPCapability {
    FallbackPCM = 0,
    DoP64,
    DoP128,
    DoP256,
};

constexpr uint32_t kDoPPrimerFrames = 32;

inline uint32_t dopCarrierRateForDsd(uint32_t dsdSampleRate) {
    if (dsdSampleRate == 0 || dsdSampleRate % 16 != 0) return 0;
    return dsdSampleRate / 16;
}

inline void packDoPStereoFrame(
    const uint8_t* dsdLeft,
    const uint8_t* dsdRight,
    uint8_t* pcmOut,
    bool& markerPhase
) {
    const uint8_t marker = markerPhase ? 0xFAu : 0x05u;

    // 32-bit little-endian integer carrier:
    // [pad][DSD low][DSD high][marker]
    pcmOut[0] = 0x00;
    pcmOut[1] = dsdLeft[1];
    pcmOut[2] = dsdLeft[0];
    pcmOut[3] = marker;

    pcmOut[4] = 0x00;
    pcmOut[5] = dsdRight[1];
    pcmOut[6] = dsdRight[0];
    pcmOut[7] = marker;

    markerPhase = !markerPhase;
}

inline AudioStreamBasicDescription buildDoPASBD(double dsdRate) {
    const uint32_t carrierSampleRate = dopCarrierRateForDsd(static_cast<uint32_t>(dsdRate));
    if (carrierSampleRate != 176400 && carrierSampleRate != 352800 && carrierSampleRate != 705600) {
        return {};
    }

    AudioStreamBasicDescription asbd{};
    asbd.mSampleRate = static_cast<Float64>(carrierSampleRate);
    asbd.mFormatID = kAudioFormatLinearPCM;
    asbd.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    asbd.mBytesPerPacket = 8;
    asbd.mFramesPerPacket = 1;
    asbd.mBytesPerFrame = 8;
    asbd.mChannelsPerFrame = 2;
    asbd.mBitsPerChannel = 32;
    return asbd;
}

inline bool isDoP32CarrierFormat(const AudioStreamBasicDescription& format, uint32_t carrierSampleRate) {
    return format.mFormatID == kAudioFormatLinearPCM &&
           (format.mFormatFlags & kAudioFormatFlagIsFloat) == 0 &&
           (format.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0 &&
           (format.mFormatFlags & kAudioFormatFlagIsPacked) != 0 &&
           (format.mFormatFlags & kAudioFormatFlagIsBigEndian) == 0 &&
           (format.mFormatFlags & kAudioFormatFlagIsAlignedHigh) == 0 &&
           format.mBitsPerChannel == 32 &&
           format.mChannelsPerFrame == 2 &&
           format.mBytesPerFrame == 8 &&
           format.mBytesPerPacket == 8 &&
           format.mFramesPerPacket == 1 &&
           static_cast<uint32_t>(format.mSampleRate) == carrierSampleRate;
}

inline DoPCapability detectDoPCapability(
    bool supports176400Int32Stereo,
    bool supports352800Int32Stereo,
    bool supports705600Int32Stereo
) {
    if (supports705600Int32Stereo) return DoPCapability::DoP256;
    if (supports352800Int32Stereo) return DoPCapability::DoP128;
    if (supports176400Int32Stereo) return DoPCapability::DoP64;
    return DoPCapability::FallbackPCM;
}

