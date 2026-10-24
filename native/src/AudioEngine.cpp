/**
 * CoreAudio audio engine — exclusive (hog) mode + shared mode.
 *
 * Exclusive: kAudioDevicePropertyHogMode + integer PCM + IOProc
 * Shared:    AudioUnit (HALOutput) through system mixer
 * Decode:    ExtAudioFile on background thread → ring buffer → audio callback
 *
 * Key fixes over initial implementation:
 *   - Shared mode queries device format dynamically (not hard-coded 16-bit)
 *   - Exclusive mode doesn't override mSampleRate after format scoring
 *   - Position tracks frames *played* (from callback), not frames *read*
 *   - EOF only fires after ring buffer fully drains
 *   - IOProc/AudioUnit stopped with safety delay before ring buffer dealloc
 *   - Physical format verified after set
 *
 * Reference: MPV ao_coreaudio_exclusive.c
 */

#include "AudioEngine.h"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <set>
#include <string>
#include <thread>
#include <unistd.h>

namespace {

float clampVisualizerSample(float value) {
    return std::max(-1.0f, std::min(1.0f, value));
}

bool isRemoteAudioUrl(const std::string& value) {
    const auto schemeEnd = value.find("://");
    if (schemeEnd == std::string::npos) return false;
    std::string scheme = value.substr(0, schemeEnd);
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return scheme == "http" || scheme == "https";
}

CFURLRef createAudioSourceUrl(const std::string& source) {
    if (isRemoteAudioUrl(source)) {
        CFStringRef sourceString = CFStringCreateWithCString(nullptr, source.c_str(), kCFStringEncodingUTF8);
        if (!sourceString) return nullptr;
        CFURLRef url = CFURLCreateWithString(nullptr, sourceString, nullptr);
        CFRelease(sourceString);
        return url;
    }

    return CFURLCreateFromFileSystemRepresentation(
        nullptr,
        reinterpret_cast<const UInt8*>(source.c_str()),
        source.length(),
        false
    );
}

float decodeLittleEndianInt24(const uint8_t* sample) {
    int32_t value =
        static_cast<int32_t>(sample[0]) |
        (static_cast<int32_t>(sample[1]) << 8) |
        (static_cast<int32_t>(sample[2]) << 16);
    if ((value & 0x00800000) != 0) value |= ~0x00FFFFFF;
    return static_cast<float>(value / 8388608.0);
}

float decodeBigEndianInt24(const uint8_t* sample) {
    int32_t value =
        static_cast<int32_t>(sample[2]) |
        (static_cast<int32_t>(sample[1]) << 8) |
        (static_cast<int32_t>(sample[0]) << 16);
    if ((value & 0x00800000) != 0) value |= ~0x00FFFFFF;
    return static_cast<float>(value / 8388608.0);
}

float decodePcmSample(const uint8_t* sample, uint32_t bytesPerSample, const AudioStreamBasicDescription& format) {
    const bool isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    const bool isSignedInteger = (format.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
    const bool isBigEndian = (format.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0;

    if (isFloat && bytesPerSample == 4) {
        float value = 0.0f;
        if (isBigEndian) {
            const uint32_t bits =
                (static_cast<uint32_t>(sample[0]) << 24) |
                (static_cast<uint32_t>(sample[1]) << 16) |
                (static_cast<uint32_t>(sample[2]) << 8) |
                static_cast<uint32_t>(sample[3]);
            std::memcpy(&value, &bits, sizeof(float));
        } else {
            std::memcpy(&value, sample, sizeof(float));
        }
        return clampVisualizerSample(value);
    }

    if (!isSignedInteger) return 0.0f;

    switch (bytesPerSample) {
        case 2: {
            int16_t value = 0;
            if (isBigEndian) {
                value = static_cast<int16_t>(
                    (static_cast<uint16_t>(sample[0]) << 8) |
                    static_cast<uint16_t>(sample[1])
                );
            } else {
                std::memcpy(&value, sample, sizeof(int16_t));
            }
            return static_cast<float>(value / 32768.0);
        }
        case 3:
            return isBigEndian ? decodeBigEndianInt24(sample) : decodeLittleEndianInt24(sample);
        case 4: {
            int32_t value = 0;
            if (isBigEndian) {
                value =
                    (static_cast<int32_t>(sample[0]) << 24) |
                    (static_cast<int32_t>(sample[1]) << 16) |
                    (static_cast<int32_t>(sample[2]) << 8) |
                    static_cast<int32_t>(sample[3]);
            } else {
                std::memcpy(&value, sample, sizeof(int32_t));
            }
            return static_cast<float>(value / 2147483648.0);
        }
        default:
            return 0.0f;
    }
}

void silenceOutput(AudioBufferList* outputData) {
    if (!outputData) return;
    for (UInt32 i = 0; i < outputData->mNumberBuffers; i++) {
        auto& buffer = outputData->mBuffers[i];
        if (buffer.mData && buffer.mDataByteSize > 0) {
            std::memset(buffer.mData, 0, buffer.mDataByteSize);
        }
    }
}

}  // namespace

static bool audioFormatsEquivalent(const AudioStreamBasicDescription& lhs,
                                   const AudioStreamBasicDescription& rhs) {
    return lhs.mFormatID == rhs.mFormatID &&
           lhs.mFormatFlags == rhs.mFormatFlags &&
           std::abs(lhs.mSampleRate - rhs.mSampleRate) < 1.0 &&
           lhs.mBitsPerChannel == rhs.mBitsPerChannel &&
           lhs.mChannelsPerFrame == rhs.mChannelsPerFrame &&
           lhs.mBytesPerFrame == rhs.mBytesPerFrame &&
           lhs.mBytesPerPacket == rhs.mBytesPerPacket &&
           lhs.mFramesPerPacket == rhs.mFramesPerPacket;
}

class ScopedDsdHogMode {
public:
    ScopedDsdHogMode(AudioDeviceID device, AudioStreamID stream)
        : device_(device), stream_(stream) {}

    bool acquire(std::string* warning = nullptr) {
        if (device_ == kAudioObjectUnknown) return false;

        AudioObjectPropertyAddress mixProp = {kAudioDevicePropertySupportsMixing,
                                              kAudioObjectPropertyScopeGlobal,
                                              kAudioObjectPropertyElementMain};
        if (AudioObjectHasProperty(device_, &mixProp)) {
            Boolean writable = false;
            if (AudioObjectIsPropertySettable(device_, &mixProp, &writable) == noErr && writable) {
                UInt32 size = sizeof(UInt32);
                AudioObjectGetPropertyData(device_, &mixProp, 0, nullptr, &size, &originalMixing_);
                UInt32 mixOff = 0;
                if (AudioObjectSetPropertyData(device_, &mixProp, 0, nullptr, sizeof(UInt32), &mixOff) == noErr) {
                    mixingChanged_ = true;
                }
            }
        }

        pid_t currentHog = -1;
        UInt32 size = sizeof(pid_t);
        const pid_t pid = getpid();
        AudioObjectPropertyAddress hogProp = {kAudioDevicePropertyHogMode,
                                              kAudioObjectPropertyScopeGlobal,
                                              kAudioObjectPropertyElementMain};
        AudioObjectGetPropertyData(device_, &hogProp, 0, nullptr, &size, &currentHog);
        if (currentHog != -1 && currentHog != pid) {
            if (warning) *warning = "DSD hog mode unavailable; continuing in shared hardware access";
            return false;
        }
        if (currentHog == pid) return true;

        if (AudioObjectSetPropertyData(device_, &hogProp, 0, nullptr, size, &pid) != noErr) {
            if (warning) *warning = "Failed to acquire DSD hog mode; continuing without it";
            return false;
        }

        pid_t verifyPid = -1;
        AudioObjectGetPropertyData(device_, &hogProp, 0, nullptr, &size, &verifyPid);
        hogOwned_ = (verifyPid == pid);
        if (!hogOwned_ && warning) {
            *warning = "Device rejected DSD hog mode; continuing without it";
        }
        return hogOwned_;
    }

    bool configureVirtualFormat(const AudioStreamBasicDescription& format, std::string& error) {
        if (stream_ == 0) {
            error = "No output stream available for DoP virtual format";
            return false;
        }

        AudioObjectPropertyAddress virtProp = {kAudioStreamPropertyVirtualFormat,
                                               kAudioObjectPropertyScopeGlobal,
                                               kAudioObjectPropertyElementMain};
        UInt32 size = sizeof(AudioStreamBasicDescription);
        AudioStreamBasicDescription current{};
        if (AudioObjectGetPropertyData(stream_, &virtProp, 0, nullptr, &size, &current) != noErr) {
            error = "Failed to read current virtual format";
            return false;
        }

        if (audioFormatsEquivalent(current, format)) {
            return true;
        }

        if (!savedVirtualFormat_) {
            originalVirtualFormat_ = current;
            savedVirtualFormat_ = true;
        }

        if (AudioObjectSetPropertyData(stream_, &virtProp, 0, nullptr, sizeof(AudioStreamBasicDescription), &format) != noErr) {
            error = "Failed to set DoP virtual format";
            return false;
        }

        size = sizeof(AudioStreamBasicDescription);
        AudioStreamBasicDescription actual{};
        if (AudioObjectGetPropertyData(stream_, &virtProp, 0, nullptr, &size, &actual) != noErr) {
            error = "Failed to verify DoP virtual format";
            return false;
        }

        if (!audioFormatsEquivalent(actual, format)) {
            error = "Device refused integer DoP virtual format";
            if (savedVirtualFormat_) {
                AudioObjectSetPropertyData(stream_, &virtProp, 0, nullptr, sizeof(AudioStreamBasicDescription), &originalVirtualFormat_);
            }
            return false;
        }

        virtualChanged_ = true;
        return true;
    }

    ~ScopedDsdHogMode() {
        if (stream_ != 0 && savedVirtualFormat_ && virtualChanged_) {
            AudioObjectPropertyAddress virtProp = {kAudioStreamPropertyVirtualFormat,
                                                   kAudioObjectPropertyScopeGlobal,
                                                   kAudioObjectPropertyElementMain};
            AudioObjectSetPropertyData(stream_, &virtProp, 0, nullptr, sizeof(AudioStreamBasicDescription), &originalVirtualFormat_);
        }

        if (device_ == kAudioObjectUnknown) return;

        if (hogOwned_) {
            pid_t pid = -1;
            UInt32 size = sizeof(pid_t);
            AudioObjectPropertyAddress hogProp = {kAudioDevicePropertyHogMode,
                                                  kAudioObjectPropertyScopeGlobal,
                                                  kAudioObjectPropertyElementMain};
            AudioObjectSetPropertyData(device_, &hogProp, 0, nullptr, size, &pid);
        }

        if (mixingChanged_) {
            AudioObjectPropertyAddress mixProp = {kAudioDevicePropertySupportsMixing,
                                                  kAudioObjectPropertyScopeGlobal,
                                                  kAudioObjectPropertyElementMain};
            AudioObjectSetPropertyData(device_, &mixProp, 0, nullptr, sizeof(UInt32), &originalMixing_);
        }
    }

private:
    AudioDeviceID device_ = kAudioObjectUnknown;
    AudioStreamID stream_ = 0;
    UInt32 originalMixing_ = 1;
    AudioStreamBasicDescription originalVirtualFormat_{};
    bool mixingChanged_ = false;
    bool hogOwned_ = false;
    bool savedVirtualFormat_ = false;
    bool virtualChanged_ = false;
};

namespace {

struct ParsedDsdHeader {
    bool isDsf = false;
    bool bitReverseBytes = false;
    uint32_t channels = 0;
    uint32_t sampleRate = 0;
    uint64_t totalSamplesPerChannel = 0;
    uint64_t dataOffset = 0;
    uint64_t dataSize = 0;
    uint32_t dsfBlockSizePerChannel = 0;
};

bool readExact(FILE* file, void* dest, size_t bytes) {
    return std::fread(dest, 1, bytes, file) == bytes;
}

uint16_t readBE16(FILE* file) {
    uint8_t buf[2]{};
    if (!readExact(file, buf, sizeof(buf))) return 0;
    return (static_cast<uint16_t>(buf[0]) << 8) |
           static_cast<uint16_t>(buf[1]);
}

uint32_t readBE32(FILE* file) {
    uint8_t buf[4]{};
    if (!readExact(file, buf, sizeof(buf))) return 0;
    return (static_cast<uint32_t>(buf[0]) << 24) |
           (static_cast<uint32_t>(buf[1]) << 16) |
           (static_cast<uint32_t>(buf[2]) << 8) |
           static_cast<uint32_t>(buf[3]);
}

uint64_t readBE64(FILE* file) {
    uint8_t buf[8]{};
    if (!readExact(file, buf, sizeof(buf))) return 0;
    uint64_t value = 0;
    for (uint8_t byte : buf) {
        value = (value << 8) | static_cast<uint64_t>(byte);
    }
    return value;
}

uint32_t readLE32(FILE* file) {
    uint8_t buf[4]{};
    if (!readExact(file, buf, sizeof(buf))) return 0;
    return static_cast<uint32_t>(buf[0]) |
           (static_cast<uint32_t>(buf[1]) << 8) |
           (static_cast<uint32_t>(buf[2]) << 16) |
           (static_cast<uint32_t>(buf[3]) << 24);
}

uint64_t readLE64(FILE* file) {
    uint8_t buf[8]{};
    if (!readExact(file, buf, sizeof(buf))) return 0;
    uint64_t value = 0;
    for (int i = 7; i >= 0; --i) {
        value = (value << 8) | static_cast<uint64_t>(buf[i]);
    }
    return value;
}

bool readFourCC(FILE* file, char out[4]) {
    return readExact(file, out, 4);
}

bool fourCCEquals(const char actual[4], const char expected[4]) {
    return std::memcmp(actual, expected, 4) == 0;
}

uint64_t paddedChunkSize(uint64_t size) {
    return size + (size & 1ULL);
}

uint8_t reverseBitsByte(uint8_t value) {
    value = static_cast<uint8_t>(((value & 0xF0u) >> 4) | ((value & 0x0Fu) << 4));
    value = static_cast<uint8_t>(((value & 0xCCu) >> 2) | ((value & 0x33u) << 2));
    value = static_cast<uint8_t>(((value & 0xAAu) >> 1) | ((value & 0x55u) << 1));
    return value;
}

bool hasFileExtension(const std::string& path, const char* extension) {
    const size_t extLen = std::strlen(extension);
    if (path.size() < extLen) return false;
    const std::string suffix = path.substr(path.size() - extLen);
    return std::equal(suffix.begin(), suffix.end(), extension, [](char a, char b) {
        return static_cast<char>(std::tolower(static_cast<unsigned char>(a))) ==
               static_cast<char>(std::tolower(static_cast<unsigned char>(b)));
    });
}

bool isDsdFilePath(const std::string& path) {
    return hasFileExtension(path, ".dsf") || hasFileExtension(path, ".dff");
}

bool supportsInt32StereoAtRate(const std::vector<SupportedFormat>& formats, double sampleRate) {
    return std::any_of(formats.begin(), formats.end(), [sampleRate](const SupportedFormat& format) {
        return !format.isFloat &&
               format.channels >= 2 &&
               format.bitDepth == 32 &&
               std::abs(format.sampleRate - sampleRate) < 1.0;
    });
}

DoPCapability detectSupportedDoPCapability(const std::vector<SupportedFormat>& formats) {
    return ::detectDoPCapability(
        supportsInt32StereoAtRate(formats, 176400.0),
        supportsInt32StereoAtRate(formats, 352800.0),
        supportsInt32StereoAtRate(formats, 705600.0)
    );
}

bool getAvailableStreamFormats(AudioStreamID stream,
                               AudioObjectPropertySelector selector,
                               std::vector<AudioStreamRangedDescription>& outFormats) {
    AudioObjectPropertyAddress prop = {selector,
                                       kAudioObjectPropertyScopeGlobal,
                                       kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(stream, &prop, 0, nullptr, &size) != noErr || size == 0) {
        return false;
    }

    outFormats.resize(size / sizeof(AudioStreamRangedDescription));
    return AudioObjectGetPropertyData(stream, &prop, 0, nullptr, &size, outFormats.data()) == noErr;
}

bool selectDoPVirtualFormat(AudioStreamID stream, uint32_t carrierSampleRate,
                            AudioStreamBasicDescription& outFormat, std::string* reason = nullptr) {
    std::vector<AudioStreamRangedDescription> formats;
    if (!getAvailableStreamFormats(stream, kAudioStreamPropertyAvailableVirtualFormats, formats)) {
        if (reason) *reason = "No available virtual formats reported by stream";
        return false;
    }

    int bestScore = -1;
    for (const auto& ranged : formats) {
        const auto& format = ranged.mFormat;
        if (!isDoP32CarrierFormat(format, carrierSampleRate)) continue;

        int score = 0;
        if ((format.mFormatFlags & kAudioFormatFlagIsNonMixable) != 0) score += 100;
        if (std::abs(format.mSampleRate - static_cast<double>(carrierSampleRate)) < 1.0) score += 10;

        if (score > bestScore) {
            bestScore = score;
            outFormat = format;
        }
    }

    if (bestScore < 0) {
        if (reason) *reason = "No integer virtual format available for DoP carrier";
        return false;
    }
    return true;
}

bool outputFormatCanRepresentSourcePcm(
    const AudioStreamBasicDescription& outputFormat,
    const AudioStreamBasicDescription& sourceFormat
) {
    if (std::abs(outputFormat.mSampleRate - sourceFormat.mSampleRate) > 1.0) return false;
    if (sourceFormat.mBitsPerChannel == 0) return true;

    const bool outputIsFloat = (outputFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    if (outputIsFloat) {
        // A 32-bit float virtual format is a valid carrier for 24-bit PCM fallback.
        return outputFormat.mBitsPerChannel >= 32;
    }

    return outputFormat.mBitsPerChannel >= sourceFormat.mBitsPerChannel;
}

bool parseDsfHeader(FILE* file, ParsedDsdHeader& header, std::string& error) {
    std::rewind(file);

    char chunkId[4];
    if (!readFourCC(file, chunkId) || !fourCCEquals(chunkId, "DSD ")) {
      error = "Not a DSF file";
      return false;
    }

    const uint64_t fileChunkSize = readLE64(file);
    const uint64_t fileSize = readLE64(file);
    (void)fileChunkSize;
    (void)fileSize;
    readLE64(file); // metadata pointer, not currently used

    bool foundFmt = false;
    bool foundData = false;

    while (std::fseek(file, 0, SEEK_CUR) == 0) {
        if (!readFourCC(file, chunkId)) break;
        const uint64_t chunkSize = readLE64(file);
        const long payloadStart = std::ftell(file);
        if (payloadStart < 0) break;
        const uint64_t payloadSize = chunkSize >= 12 ? (chunkSize - 12) : 0;

        if (fourCCEquals(chunkId, "fmt ")) {
            readLE32(file); // format version
            readLE32(file); // format id
            readLE32(file); // channel type
            header.channels = readLE32(file);
            header.sampleRate = readLE32(file);
            readLE32(file); // bits per sample
            header.totalSamplesPerChannel = readLE64(file);
            header.dsfBlockSizePerChannel = readLE32(file);
            readLE32(file); // reserved
            header.isDsf = true;
            header.bitReverseBytes = true;
            foundFmt = true;
        } else if (fourCCEquals(chunkId, "data")) {
            header.dataOffset = static_cast<uint64_t>(payloadStart);
            header.dataSize = payloadSize;
            foundData = true;
            break;
        }

        const uint64_t nextOffset = static_cast<uint64_t>(payloadStart) + payloadSize;
        if (std::fseek(file, static_cast<long>(nextOffset), SEEK_SET) != 0) break;
    }

    if (!foundFmt || !foundData) {
        error = "Incomplete DSF header";
        return false;
    }
    if (header.channels < 2) {
        error = "Only stereo DSD playback is currently supported";
        return false;
    }
    if (header.dsfBlockSizePerChannel == 0) {
        error = "Invalid DSF block size";
        return false;
    }
    return true;
}

bool parseDffPropChunk(FILE* file, uint64_t propSize, ParsedDsdHeader& header) {
    const long propStart = std::ftell(file);
    if (propStart < 0) return false;
    if (propSize < 4) return false;

    char propType[4];
    if (!readFourCC(file, propType)) return false;
    uint64_t consumed = 4;

    while (consumed + 12 <= propSize) {
        char childId[4];
        if (!readFourCC(file, childId)) return false;
        const uint64_t childSize = readBE64(file);
        consumed += 12;
        const long childPayloadStart = std::ftell(file);
        if (childPayloadStart < 0) return false;

        if (fourCCEquals(childId, "FS  ")) {
            header.sampleRate = readBE32(file);
        } else if (fourCCEquals(childId, "CHNL")) {
            header.channels = readBE16(file);
        }

        const uint64_t padded = paddedChunkSize(childSize);
        consumed += padded;
        const uint64_t nextOffset = static_cast<uint64_t>(childPayloadStart) + padded;
        if (std::fseek(file, static_cast<long>(nextOffset), SEEK_SET) != 0) return false;
    }

    const uint64_t propEnd = static_cast<uint64_t>(propStart) + paddedChunkSize(propSize);
    return std::fseek(file, static_cast<long>(propEnd), SEEK_SET) == 0;
}

bool parseDffHeader(FILE* file, ParsedDsdHeader& header, std::string& error) {
    std::rewind(file);

    char rootId[4];
    if (!readFourCC(file, rootId) || !fourCCEquals(rootId, "FRM8")) {
        error = "Not a DFF file";
        return false;
    }

    const uint64_t formSize = readBE64(file);
    char formType[4];
    if (!readFourCC(file, formType) || !fourCCEquals(formType, "DSD ")) {
        error = "Unsupported DFF form";
        return false;
    }

    const long bodyStart = std::ftell(file);
    if (bodyStart < 0) {
        error = "Invalid DFF header";
        return false;
    }
    const uint64_t formEnd = static_cast<uint64_t>(bodyStart) + (formSize >= 4 ? formSize - 4 : 0);
    bool foundProp = false;
    bool foundData = false;

    while (static_cast<uint64_t>(std::ftell(file)) + 12 <= formEnd) {
        char chunkId[4];
        if (!readFourCC(file, chunkId)) break;
        const uint64_t chunkSize = readBE64(file);
        const long payloadStart = std::ftell(file);
        if (payloadStart < 0) break;

        if (fourCCEquals(chunkId, "PROP")) {
            if (!parseDffPropChunk(file, chunkSize, header)) {
                error = "Failed to parse DFF PROP chunk";
                return false;
            }
            foundProp = true;
            continue;
        }

        if (fourCCEquals(chunkId, "DSD ")) {
            header.isDsf = false;
            header.bitReverseBytes = false;
            header.dataOffset = static_cast<uint64_t>(payloadStart);
            header.dataSize = chunkSize;
            foundData = true;
            break;
        }

        const uint64_t nextOffset = static_cast<uint64_t>(payloadStart) + paddedChunkSize(chunkSize);
        if (std::fseek(file, static_cast<long>(nextOffset), SEEK_SET) != 0) break;
    }

    if (!foundProp || !foundData) {
        error = "Incomplete DFF header";
        return false;
    }
    if (header.channels < 2) {
        error = "Only stereo DSD playback is currently supported";
        return false;
    }
    header.totalSamplesPerChannel = header.channels > 0
        ? ((header.dataSize * 8ULL) / static_cast<uint64_t>(header.channels))
        : 0;
    return true;
}

bool openDsdSourceFile(const std::string& filePath, TrackSlot& slot, std::string& error) {
    FILE* file = std::fopen(filePath.c_str(), "rb");
    if (!file) {
        error = "Failed to open DSD file";
        return false;
    }

    char magic[4];
    if (!readFourCC(file, magic)) {
        std::fclose(file);
        error = "Failed to read DSD file header";
        return false;
    }
    std::rewind(file);

    ParsedDsdHeader header;
    bool ok = false;
    if (fourCCEquals(magic, "DSD ")) {
        ok = parseDsfHeader(file, header, error);
    } else if (fourCCEquals(magic, "FRM8")) {
        ok = parseDffHeader(file, header, error);
    } else {
        error = "Unsupported DSD container";
    }

    if (!ok) {
        std::fclose(file);
        return false;
    }

    if (std::fseek(file, static_cast<long>(header.dataOffset), SEEK_SET) != 0) {
        std::fclose(file);
        error = "Failed to seek to DSD audio data";
        return false;
    }

    slot.dsd.file = file;
    slot.dsd.isDsf = header.isDsf;
    slot.dsd.bitReverseBytes = header.bitReverseBytes;
    slot.dsd.channels = header.channels;
    slot.dsd.sourceSampleRate = header.sampleRate;
    slot.dsd.carrierSampleRate = dopCarrierRateForDsd(header.sampleRate);
    slot.dsd.totalSamplesPerChannel = header.totalSamplesPerChannel;
    slot.dsd.totalDoPFrames = header.totalSamplesPerChannel / 16ULL;
    slot.dsd.dataOffset = header.dataOffset;
    slot.dsd.dataSize = header.dataSize;
    slot.dsd.dsfBlockSizePerChannel = header.dsfBlockSizePerChannel;
    slot.dsd.bytesConsumedPerChannel = 0;
    slot.dsd.dsfBlockByteIndex = 0;
    slot.dsd.markerPhase = false;
    slot.dsd.primerFramesRemaining = kDoPPrimerFrames;
    slot.dsd.dffBufferOffset = 0;
    slot.dsd.dffBufferValid = 0;
    slot.dsd.dffInterleavedBuffer.clear();

    if (header.isDsf) {
        slot.dsd.dsfLeftBlock.resize(header.dsfBlockSizePerChannel);
        slot.dsd.dsfRightBlock.resize(header.dsfBlockSizePerChannel);
    } else {
        // Whole frames (one byte per channel) per read.
        slot.dsd.dffInterleavedBuffer.resize(static_cast<size_t>(header.channels) * 8192);
    }

    return true;
}

uint64_t dsdBytesPerChannel(const TrackSlot& slot) {
    return (slot.dsd.totalSamplesPerChannel + 7ULL) / 8ULL;
}

bool refillDsfBlocks(TrackSlot& slot) {
    if (!slot.dsd.file) return false;
    if (slot.dsd.bytesConsumedPerChannel >= dsdBytesPerChannel(slot)) return false;

    const size_t blockSize = slot.dsd.dsfBlockSizePerChannel;
    const size_t bytesRemainingPerChannel = static_cast<size_t>(
        std::min<uint64_t>(blockSize, dsdBytesPerChannel(slot) - slot.dsd.bytesConsumedPerChannel)
    );
    if (bytesRemainingPerChannel == 0) return false;

    // Blocks are stored full size (the last one zero-padded), one per channel in turn;
    // only the first two channels are played.
    slot.dsd.dsfLeftBlock.resize(blockSize);
    slot.dsd.dsfRightBlock.resize(blockSize);
    if (!readExact(slot.dsd.file, slot.dsd.dsfLeftBlock.data(), blockSize)) return false;
    if (!readExact(slot.dsd.file, slot.dsd.dsfRightBlock.data(), blockSize)) return false;
    if (slot.dsd.channels > 2 &&
        std::fseek(slot.dsd.file, static_cast<long>((slot.dsd.channels - 2) * static_cast<uint64_t>(blockSize)),
                   SEEK_CUR) != 0) {
        return false;
    }

    slot.dsd.dsfLeftBlock.resize(bytesRemainingPerChannel);
    slot.dsd.dsfRightBlock.resize(bytesRemainingPerChannel);
    slot.dsd.dsfBlockByteIndex = 0;
    return true;
}

bool refillDffInterleavedBuffer(TrackSlot& slot) {
    if (!slot.dsd.file) return false;
    const size_t chunkBytes = slot.dsd.dffInterleavedBuffer.size();
    const size_t bytesRead = std::fread(slot.dsd.dffInterleavedBuffer.data(), 1, chunkBytes, slot.dsd.file);
    slot.dsd.dffBufferOffset = 0;
    slot.dsd.dffBufferValid = bytesRead;
    return bytesRead > 0;
}

// DSD → PCM source: up to `maxBytes` bytes per channel of the first two channels,
// oldest bit in the MSB. Returns the bytes read per channel (0 at the end).
size_t readDsdBytes(TrackSlot& slot, size_t maxBytes, uint8_t* left, uint8_t* right) {
    auto& dsd = slot.dsd;
    const uint64_t total = dsdBytesPerChannel(slot);
    size_t count = 0;
    while (count < maxBytes && dsd.bytesConsumedPerChannel < total) {
        if (dsd.isDsf) {
            if (dsd.dsfBlockByteIndex >= dsd.dsfLeftBlock.size() && !refillDsfBlocks(slot)) break;
            const size_t run = std::min({maxBytes - count, dsd.dsfLeftBlock.size() - dsd.dsfBlockByteIndex,
                                         static_cast<size_t>(total - dsd.bytesConsumedPerChannel)});
            const uint8_t* l = dsd.dsfLeftBlock.data() + dsd.dsfBlockByteIndex;
            const uint8_t* r = dsd.dsfRightBlock.data() + dsd.dsfBlockByteIndex;
            for (size_t i = 0; i < run; ++i) {
                left[count + i] = dsd.bitReverseBytes ? reverseBitsByte(l[i]) : l[i];
                right[count + i] = dsd.bitReverseBytes ? reverseBitsByte(r[i]) : r[i];
            }
            dsd.dsfBlockByteIndex += run;
            dsd.bytesConsumedPerChannel += run;
            count += run;
        } else {
            if (dsd.dffBufferOffset + dsd.channels > dsd.dffBufferValid) {
                if (!refillDffInterleavedBuffer(slot) || dsd.dffBufferValid < dsd.channels) break;
            }
            const uint8_t* frame = dsd.dffInterleavedBuffer.data() + dsd.dffBufferOffset;
            left[count] = dsd.bitReverseBytes ? reverseBitsByte(frame[0]) : frame[0];
            right[count] = dsd.bitReverseBytes ? reverseBitsByte(frame[1]) : frame[1];
            dsd.dffBufferOffset += dsd.channels;
            dsd.bytesConsumedPerChannel += 1;
            count += 1;
        }
    }
    return count;
}

// Positions a DSD source `targetBytesPerChannel` into its audio data.
bool positionDsdSource(TrackSlot& slot, uint64_t targetBytesPerChannel) {
    auto& dsd = slot.dsd;
    if (!dsd.file) return false;
    if (targetBytesPerChannel >= dsdBytesPerChannel(slot)) {
        // At (or past) the end: the next read reports end of stream.
        dsd.bytesConsumedPerChannel = dsdBytesPerChannel(slot);
        dsd.dsfLeftBlock.clear();
        dsd.dsfRightBlock.clear();
        dsd.dsfBlockByteIndex = 0;
        dsd.dffBufferOffset = 0;
        dsd.dffBufferValid = 0;
        return true;
    }
    if (dsd.isDsf) {
        const uint64_t blockSize = static_cast<uint64_t>(dsd.dsfBlockSizePerChannel);
        const uint64_t blockIndex = blockSize > 0 ? (targetBytesPerChannel / blockSize) : 0;
        const uint64_t byteInBlock = blockSize > 0 ? (targetBytesPerChannel % blockSize) : 0;
        const uint64_t fileOffset = dsd.dataOffset + (blockIndex * blockSize * static_cast<uint64_t>(dsd.channels));
        if (std::fseek(dsd.file, static_cast<long>(fileOffset), SEEK_SET) != 0) return false;

        dsd.bytesConsumedPerChannel = blockIndex * blockSize;
        dsd.dsfBlockByteIndex = 0;
        dsd.dsfLeftBlock.clear();
        dsd.dsfRightBlock.clear();
        if (!refillDsfBlocks(slot)) return false;
        dsd.dsfBlockByteIndex = static_cast<size_t>(byteInBlock);
        dsd.bytesConsumedPerChannel = targetBytesPerChannel;
    } else {
        const uint64_t fileOffset = dsd.dataOffset + (targetBytesPerChannel * static_cast<uint64_t>(dsd.channels));
        if (std::fseek(dsd.file, static_cast<long>(fileOffset), SEEK_SET) != 0) return false;
        dsd.bytesConsumedPerChannel = targetBytesPerChannel;
        dsd.dffBufferOffset = 0;
        dsd.dffBufferValid = 0;
    }
    return true;
}

bool outputFormatCanCarryDoP(const AudioStreamBasicDescription& format, uint32_t carrierSampleRate, std::string* reason = nullptr) {
    if (isDoP32CarrierFormat(format, carrierSampleRate)) return true;

    if (reason) {
        if (format.mFormatID != kAudioFormatLinearPCM) {
            *reason = "DoP requires linear PCM output";
        } else if ((format.mFormatFlags & kAudioFormatFlagIsFloat) != 0) {
            *reason = "DoP requires integer PCM output";
        } else if ((format.mFormatFlags & kAudioFormatFlagIsSignedInteger) == 0) {
            *reason = "DoP requires signed integer PCM output";
        } else if ((format.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0) {
            *reason = "DoP requires little-endian PCM output";
        } else if ((format.mFormatFlags & kAudioFormatFlagIsAlignedHigh) != 0) {
            *reason = "DoP requires packed 32-bit integer frames";
        } else if (format.mBitsPerChannel != 32 || format.mBytesPerFrame != 8) {
            *reason = "DoP requires stereo 32-bit integer carrier frames";
        } else if (format.mChannelsPerFrame != 2) {
            *reason = "DoP currently supports stereo playback only";
        } else if (std::abs(format.mSampleRate - static_cast<double>(carrierSampleRate)) > 1.0) {
            *reason = "Output sample rate does not match DoP carrier";
        } else {
            *reason = "Unsupported PCM carrier for 32-bit DoP";
        }
    }
    return false;
}

const AudioStreamBasicDescription* selectDoPCarrierFormat(
    const AudioStreamBasicDescription& physicalFormat,
    const AudioStreamBasicDescription& virtualFormat,
    uint32_t carrierSampleRate,
    std::string* reason = nullptr
) {
    std::string virtualReason;
    if (outputFormatCanCarryDoP(virtualFormat, carrierSampleRate, &virtualReason)) {
        return &virtualFormat;
    }

    if (reason) {
        std::string physicalReason;
        if (outputFormatCanCarryDoP(physicalFormat, carrierSampleRate, &physicalReason) &&
            (virtualFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0) {
            *reason = "Device exposes a valid physical carrier, but the active callback stream is float PCM";
        } else if (!virtualReason.empty()) {
            *reason = virtualReason;
        } else if (!physicalReason.empty()) {
            *reason = physicalReason;
        } else {
            *reason = "No valid DoP carrier format available";
        }
    }
    return nullptr;
}

size_t packDopFrames(TrackSlot& slot, const AudioStreamBasicDescription& outputFormat, uint8_t* dest, size_t maxFrames) {
    if (!isDoP32CarrierFormat(outputFormat, slot.dsd.carrierSampleRate)) return 0;

    size_t framesProduced = 0;
    while (framesProduced < maxFrames) {
        uint8_t* frame = dest + (framesProduced * outputFormat.mBytesPerFrame);

        if (slot.dsd.primerFramesRemaining > 0) {
            const uint8_t silentDsd[2] = {0x00, 0x00};
            packDoPStereoFrame(silentDsd, silentDsd, frame, slot.dsd.markerPhase);
            slot.dsd.primerFramesRemaining -= 1;
            framesProduced += 1;
            continue;
        }

        if ((slot.dsd.bytesConsumedPerChannel / 2ULL) >= slot.dsd.totalDoPFrames) break;

        uint8_t leftBytes[2] = {0x00, 0x00};
        uint8_t rightBytes[2] = {0x00, 0x00};

        if (slot.dsd.isDsf) {
            if (slot.dsd.dsfBlockByteIndex + 1 >= slot.dsd.dsfLeftBlock.size()) {
                if (!refillDsfBlocks(slot)) break;
            }

            leftBytes[0] = slot.dsd.dsfLeftBlock[slot.dsd.dsfBlockByteIndex];
            rightBytes[0] = slot.dsd.dsfRightBlock[slot.dsd.dsfBlockByteIndex];
            leftBytes[1] = slot.dsd.dsfLeftBlock[slot.dsd.dsfBlockByteIndex + 1];
            rightBytes[1] = slot.dsd.dsfRightBlock[slot.dsd.dsfBlockByteIndex + 1];
            slot.dsd.dsfBlockByteIndex += 2;
        } else {
            if (slot.dsd.dffBufferOffset + 4 > slot.dsd.dffBufferValid) {
                if (!refillDffInterleavedBuffer(slot)) break;
                if (slot.dsd.dffBufferValid < 4) break;
            }

            leftBytes[0] = slot.dsd.dffInterleavedBuffer[slot.dsd.dffBufferOffset + 0];
            rightBytes[0] = slot.dsd.dffInterleavedBuffer[slot.dsd.dffBufferOffset + 1];
            leftBytes[1] = slot.dsd.dffInterleavedBuffer[slot.dsd.dffBufferOffset + 2];
            rightBytes[1] = slot.dsd.dffInterleavedBuffer[slot.dsd.dffBufferOffset + 3];
            slot.dsd.dffBufferOffset += 4;
        }

        if (slot.dsd.bitReverseBytes) {
            leftBytes[0] = reverseBitsByte(leftBytes[0]);
            leftBytes[1] = reverseBitsByte(leftBytes[1]);
            rightBytes[0] = reverseBitsByte(rightBytes[0]);
            rightBytes[1] = reverseBitsByte(rightBytes[1]);
        }

        packDoPStereoFrame(leftBytes, rightBytes, frame, slot.dsd.markerPhase);
        slot.dsd.bytesConsumedPerChannel += 2;
        framesProduced += 1;
    }

    return framesProduced;
}

} // namespace

// ---------------------------------------------------------------------------
// RingBuffer — SPSC lock-free
// ---------------------------------------------------------------------------

RingBuffer::RingBuffer(size_t capacity)
    : capacity_(capacity), readPos_(0), writePos_(0) {
    buffer_ = new uint8_t[capacity];
    std::memset(buffer_, 0, capacity);
}

RingBuffer::~RingBuffer() { delete[] buffer_; }

size_t RingBuffer::write(const void* data, size_t len) {
    size_t wp = writePos_.load(std::memory_order_relaxed);
    size_t rp = readPos_.load(std::memory_order_acquire);

    size_t free = (rp > wp) ? (rp - wp - 1) : (capacity_ - wp + rp - 1);
    if (len > free) len = free;
    if (len == 0) return 0;

    auto* src = static_cast<const uint8_t*>(data);
    size_t first = std::min(len, capacity_ - wp);
    std::memcpy(buffer_ + wp, src, first);
    if (len > first) std::memcpy(buffer_, src + first, len - first);

    writePos_.store((wp + len) % capacity_, std::memory_order_release);
    return len;
}

size_t RingBuffer::read(void* data, size_t len) {
    size_t rp = readPos_.load(std::memory_order_relaxed);
    size_t wp = writePos_.load(std::memory_order_acquire);

    size_t avail = (wp >= rp) ? (wp - rp) : (capacity_ - rp + wp);
    if (len > avail) len = avail;
    if (len == 0) return 0;

    auto* dst = static_cast<uint8_t*>(data);
    size_t first = std::min(len, capacity_ - rp);
    std::memcpy(dst, buffer_ + rp, first);
    if (len > first) std::memcpy(dst + first, buffer_, len - first);

    readPos_.store((rp + len) % capacity_, std::memory_order_release);
    return len;
}

size_t RingBuffer::available() const {
    size_t rp = readPos_.load(std::memory_order_acquire);
    size_t wp = writePos_.load(std::memory_order_acquire);
    return (wp >= rp) ? (wp - rp) : (capacity_ - rp + wp);
}

void RingBuffer::reset() {
    readPos_.store(0, std::memory_order_release);
    writePos_.store(0, std::memory_order_release);
}

// ---------------------------------------------------------------------------
// AudioEngine
// ---------------------------------------------------------------------------

AudioEngine::AudioEngine() {
    resetVisualizerState();
}

AudioEngine::~AudioEngine() { close(); }

namespace {

constexpr const char* kAirPlayRouteUidPrefix = "airplay-route::";

std::string makeAirPlayRouteUid(const std::string& deviceUid, UInt32 dataSourceId) {
    return std::string(kAirPlayRouteUidPrefix) + deviceUid + "::" + std::to_string(dataSourceId);
}

bool parseAirPlayRouteUid(const std::string& uid, std::string& deviceUid, UInt32& dataSourceId) {
    if (uid.rfind(kAirPlayRouteUidPrefix, 0) != 0) return false;

    const std::string payload = uid.substr(std::strlen(kAirPlayRouteUidPrefix));
    const size_t split = payload.rfind("::");
    if (split == std::string::npos) return false;

    deviceUid = payload.substr(0, split);
    if (deviceUid.empty()) return false;

    try {
        const unsigned long parsed = std::stoul(payload.substr(split + 2));
        dataSourceId = static_cast<UInt32>(parsed);
        return true;
    } catch (...) {
        return false;
    }
}

std::string copyCfString(CFStringRef value) {
    if (!value) return {};
    char buffer[256];
    if (!CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
        return {};
    }
    return buffer;
}

std::string getDataSourceName(AudioDeviceID deviceId, UInt32 dataSourceId) {
    CFStringRef nameRef = nullptr;
    AudioValueTranslation translation{
        &dataSourceId,
        sizeof(dataSourceId),
        &nameRef,
        sizeof(nameRef),
    };
    UInt32 translationSize = sizeof(translation);
    AudioObjectPropertyAddress prop = {
        kAudioDevicePropertyDataSourceNameForIDCFString,
        kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain,
    };
    if (AudioObjectGetPropertyData(deviceId, &prop, 0, nullptr, &translationSize, &translation) != noErr ||
        nameRef == nullptr) {
        return {};
    }

    std::string result = copyCfString(nameRef);
    CFRelease(nameRef);
    return result;
}

std::vector<UInt32> getDeviceDataSources(AudioDeviceID deviceId, AudioObjectPropertyScope scope) {
    AudioObjectPropertyAddress prop = {
        kAudioDevicePropertyDataSources,
        scope,
        kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(deviceId, &prop, 0, nullptr, &size) != noErr ||
        size < sizeof(UInt32)) {
        return {};
    }

    std::vector<UInt32> result(size / sizeof(UInt32));
    if (AudioObjectGetPropertyData(deviceId, &prop, 0, nullptr, &size, result.data()) != noErr) {
        return {};
    }
    return result;
}

std::vector<UInt32> getCurrentDeviceDataSources(AudioDeviceID deviceId, AudioObjectPropertyScope scope) {
    AudioObjectPropertyAddress prop = {
        kAudioDevicePropertyDataSource,
        scope,
        kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(deviceId, &prop, 0, nullptr, &size) != noErr ||
        size < sizeof(UInt32)) {
        return {};
    }

    std::vector<UInt32> result(size / sizeof(UInt32));
    if (AudioObjectGetPropertyData(deviceId, &prop, 0, nullptr, &size, result.data()) != noErr) {
        return {};
    }
    return result;
}

}  // namespace

// ---------------------------------------------------------------------------
// Device enumeration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hardware (device) volume helpers
// ---------------------------------------------------------------------------

static bool isSettableOutputProperty(AudioDeviceID device, AudioObjectPropertySelector selector,
                                     AudioObjectPropertyElement element) {
    AudioObjectPropertyAddress addr{selector, kAudioDevicePropertyScopeOutput, element};
    if (!AudioObjectHasProperty(device, &addr)) return false;
    Boolean settable = false;
    return AudioObjectIsPropertySettable(device, &addr, &settable) == noErr && settable;
}

// Main element when the device has a master control, otherwise the stereo pair
// channels (or every output channel) that carry their own control.
static std::vector<AudioObjectPropertyElement> findOutputControlElements(
    AudioDeviceID device, AudioObjectPropertySelector selector) {
    if (device == kAudioObjectUnknown) return {};
    if (isSettableOutputProperty(device, selector, kAudioObjectPropertyElementMain)) {
        return {kAudioObjectPropertyElementMain};
    }

    std::vector<AudioObjectPropertyElement> candidates;
    UInt32 stereo[2] = {0, 0};
    UInt32 size = sizeof(stereo);
    AudioObjectPropertyAddress stereoAddr{kAudioDevicePropertyPreferredChannelsForStereo,
                                          kAudioDevicePropertyScopeOutput,
                                          kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(device, &stereoAddr, 0, nullptr, &size, stereo) == noErr &&
        stereo[0] > 0 && stereo[1] > 0) {
        candidates = {stereo[0], stereo[1]};
    } else {
        for (AudioObjectPropertyElement ch = 1; ch <= 8; ch++) candidates.push_back(ch);
    }

    std::vector<AudioObjectPropertyElement> elements;
    for (auto element : candidates) {
        if (isSettableOutputProperty(device, selector, element)) elements.push_back(element);
    }
    return elements;
}

static bool readOutputFloat(AudioDeviceID device, AudioObjectPropertySelector selector,
                            AudioObjectPropertyElement element, Float32& value) {
    AudioObjectPropertyAddress addr{selector, kAudioDevicePropertyScopeOutput, element};
    UInt32 size = sizeof(value);
    return AudioObjectGetPropertyData(device, &addr, 0, nullptr, &size, &value) == noErr;
}

std::vector<AudioDevice> AudioEngine::listDevices() {
    std::vector<AudioDevice> result;

    AudioObjectPropertyAddress prop = {kAudioHardwarePropertyDevices,
                                       kAudioObjectPropertyScopeGlobal,
                                       kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &prop, 0, nullptr,
                                        &size) != noErr)
        return result;

    std::vector<AudioDeviceID> devices(size / sizeof(AudioDeviceID));
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &prop, 0, nullptr, &size,
                                    devices.data()) != noErr)
        return result;

    for (AudioDeviceID devId : devices) {
        AudioObjectPropertyAddress streamProp = {kAudioDevicePropertyStreams,
                                                  kAudioObjectPropertyScopeOutput,
                                                  kAudioObjectPropertyElementMain};
        UInt32 streamSize = 0;
        if (AudioObjectGetPropertyDataSize(devId, &streamProp, 0, nullptr, &streamSize) !=
                noErr ||
            streamSize == 0)
            continue;

        AudioDevice dev;
        dev.deviceId = devId;

        // Name
        CFStringRef nameRef = nullptr;
        UInt32 ns = sizeof(CFStringRef);
        AudioObjectPropertyAddress nameProp = {kAudioObjectPropertyName,
                                                kAudioObjectPropertyScopeGlobal,
                                                kAudioObjectPropertyElementMain};
        if (AudioObjectGetPropertyData(devId, &nameProp, 0, nullptr, &ns, &nameRef) ==
                noErr &&
            nameRef) {
            char buf[256];
            CFStringGetCString(nameRef, buf, sizeof(buf), kCFStringEncodingUTF8);
            dev.name = buf;
            CFRelease(nameRef);
        }

        // UID
        CFStringRef uidRef = nullptr;
        UInt32 us = sizeof(CFStringRef);
        AudioObjectPropertyAddress uidProp = {kAudioDevicePropertyDeviceUID,
                                               kAudioObjectPropertyScopeGlobal,
                                               kAudioObjectPropertyElementMain};
        if (AudioObjectGetPropertyData(devId, &uidProp, 0, nullptr, &us, &uidRef) ==
                noErr &&
            uidRef) {
            char buf[256];
            CFStringGetCString(uidRef, buf, sizeof(buf), kCFStringEncodingUTF8);
            dev.uid = buf;
            CFRelease(uidRef);
        }

        // Channel count
        AudioObjectPropertyAddress chanProp = {kAudioDevicePropertyStreamConfiguration,
                                                kAudioObjectPropertyScopeOutput,
                                                kAudioObjectPropertyElementMain};
        UInt32 chanSize = 0;
        if (AudioObjectGetPropertyDataSize(devId, &chanProp, 0, nullptr, &chanSize) ==
                noErr &&
            chanSize > 0) {
            std::vector<uint8_t> chanBuf(chanSize);
            auto* bufList = reinterpret_cast<AudioBufferList*>(chanBuf.data());
            if (AudioObjectGetPropertyData(devId, &chanProp, 0, nullptr, &chanSize,
                                            bufList) == noErr) {
                uint32_t totalCh = 0;
                for (UInt32 i = 0; i < bufList->mNumberBuffers; i++)
                    totalCh += bufList->mBuffers[i].mNumberChannels;
                dev.channels = totalCh;
            }
        }

        // Transport type (Bluetooth, USB, built-in, …)
        {
            UInt32 transport = 0, ts = sizeof(UInt32);
            AudioObjectPropertyAddress transProp = {kAudioDevicePropertyTransportType,
                                                     kAudioObjectPropertyScopeGlobal,
                                                     kAudioObjectPropertyElementMain};
            AudioObjectGetPropertyData(devId, &transProp, 0, nullptr, &ts, &transport);
            dev.transportType = transport;
        }

        // Nominal sample rate
        Float64 rate = 0;
        UInt32 rateSize = sizeof(Float64);
        AudioObjectPropertyAddress rateProp = {kAudioDevicePropertyNominalSampleRate,
                                                kAudioObjectPropertyScopeGlobal,
                                                kAudioObjectPropertyElementMain};
        if (AudioObjectGetPropertyData(devId, &rateProp, 0, nullptr, &rateSize, &rate) ==
            noErr)
            dev.sampleRate = rate;

        // Build full format capability matrix from physical formats
        std::vector<AudioStreamID> streams(streamSize / sizeof(AudioStreamID));
        AudioObjectGetPropertyData(devId, &streamProp, 0, nullptr, &streamSize,
                                    streams.data());

        // Use a set to deduplicate (rate, depth, isFloat, channels) tuples
        struct FmtKey {
            double rate; uint32_t depth; bool isFloat; uint32_t channels;
            bool operator<(const FmtKey& o) const {
                if (rate != o.rate) return rate < o.rate;
                if (depth != o.depth) return depth < o.depth;
                if (isFloat != o.isFloat) return isFloat < o.isFloat;
                return channels < o.channels;
            }
        };
        std::set<FmtKey> seen;

        for (AudioStreamID sid : streams) {
            AudioObjectPropertyAddress fmtProp = {
                kAudioStreamPropertyAvailablePhysicalFormats,
                kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
            UInt32 fmtSize = 0;
            if (AudioObjectGetPropertyDataSize(sid, &fmtProp, 0, nullptr, &fmtSize) !=
                noErr)
                continue;
            std::vector<AudioStreamRangedDescription> fmts(
                fmtSize / sizeof(AudioStreamRangedDescription));
            if (AudioObjectGetPropertyData(sid, &fmtProp, 0, nullptr, &fmtSize,
                                            fmts.data()) != noErr)
                continue;
            for (const auto& f : fmts) {
                if (f.mFormat.mFormatID != kAudioFormatLinearPCM) continue;
                if (f.mFormat.mBitsPerChannel == 0) continue;

                bool isFloat = (f.mFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
                uint32_t ch = f.mFormat.mChannelsPerFrame;

                // If the format has a variable sample rate range, enumerate common rates
                if (f.mFormat.mSampleRate == 0 &&
                    f.mSampleRateRange.mMinimum < f.mSampleRateRange.mMaximum) {
                    static const double commonRates[] = {
                        44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000
                    };
                    for (double r : commonRates) {
                        if (r >= f.mSampleRateRange.mMinimum &&
                            r <= f.mSampleRateRange.mMaximum) {
                            FmtKey key{r, f.mFormat.mBitsPerChannel, isFloat, ch};
                            if (seen.insert(key).second) {
                                dev.supportedFormats.push_back({r, f.mFormat.mBitsPerChannel, isFloat, ch});
                            }
                        }
                    }
                } else {
                    FmtKey key{f.mFormat.mSampleRate, f.mFormat.mBitsPerChannel, isFloat, ch};
                    if (seen.insert(key).second) {
                        dev.supportedFormats.push_back({
                            f.mFormat.mSampleRate, f.mFormat.mBitsPerChannel, isFloat, ch
                        });
                    }
                }
            }
        }

        dev.dopCapability = detectSupportedDoPCapability(dev.supportedFormats);
        dev.hardwareVolume =
            !findOutputControlElements(devId, kAudioDevicePropertyVolumeScalar).empty();

        const bool isAirPlayTransport = dev.transportType == kAudioDeviceTransportTypeAirPlay;
        if (isAirPlayTransport) {
            const auto dataSources = getDeviceDataSources(devId, kAudioDevicePropertyScopeOutput);
            const auto currentDataSources = getCurrentDeviceDataSources(devId, kAudioDevicePropertyScopeOutput);
            const UInt32 currentDataSource = currentDataSources.empty() ? 0 : currentDataSources.front();

            bool addedRouteEndpoint = false;
            for (UInt32 dataSourceId : dataSources) {
                std::string dataSourceName = getDataSourceName(devId, dataSourceId);
                if (dataSourceName.empty()) {
                    dataSourceName = dev.name.empty()
                        ? ("AirPlay Route " + std::to_string(dataSourceId))
                        : (dev.name + " Route " + std::to_string(dataSourceId));
                }

                AudioDevice route = dev;
                route.uid = makeAirPlayRouteUid(dev.uid, dataSourceId);
                route.name = dataSourceName;
                route.routeParentUid = dev.uid;
                route.routeDataSourceId = dataSourceId;
                route.isRouteEndpoint = true;
                route.isCurrentRoute = (currentDataSource != 0 && dataSourceId == currentDataSource);
                result.push_back(std::move(route));
                addedRouteEndpoint = true;
            }

            if (addedRouteEndpoint) {
                continue;
            }
        }

        result.push_back(std::move(dev));
    }

    return result;
}

// ---------------------------------------------------------------------------
// Find device by UID
// ---------------------------------------------------------------------------

AudioDeviceID AudioEngine::findDeviceByUid(const std::string& uid) {
    if (uid == "default" || uid.empty()) {
        AudioDeviceID defaultDev = kAudioObjectUnknown;
        UInt32 size = sizeof(AudioDeviceID);
        AudioObjectPropertyAddress prop = {kAudioHardwarePropertyDefaultOutputDevice,
                                            kAudioObjectPropertyScopeGlobal,
                                            kAudioObjectPropertyElementMain};
        if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &prop, 0, nullptr, &size,
                                        &defaultDev) != noErr)
            return kAudioObjectUnknown;
        return defaultDev;
    }

    std::string baseUid;
    UInt32 dataSourceId = 0;
    if (parseAirPlayRouteUid(uid, baseUid, dataSourceId)) {
        return findDeviceByUid(baseUid);
    }

    auto devices = listDevices();
    for (const auto& dev : devices)
        if (dev.uid == uid) return dev.deviceId;

    return kAudioObjectUnknown;
}

bool AudioEngine::selectOutputDataSource(AudioDeviceID device, const std::string& deviceUid, std::string& error) {
    std::string baseUid;
    UInt32 dataSourceId = 0;
    if (!parseAirPlayRouteUid(deviceUid, baseUid, dataSourceId)) {
        return true;
    }

    AudioObjectPropertyAddress dataSourceProp = {
        kAudioDevicePropertyDataSource,
        kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain,
    };
    if (!AudioObjectHasProperty(device, &dataSourceProp)) {
        error = "Selected AirPlay route does not expose output data sources";
        return false;
    }

    UInt32 dataSourcePropSize = sizeof(UInt32);
    AudioObjectGetPropertyDataSize(device, &dataSourceProp, 0, nullptr, &dataSourcePropSize);
    if (dataSourcePropSize < sizeof(UInt32)) {
        dataSourcePropSize = sizeof(UInt32);
    }

    std::vector<UInt32> desiredDataSources(std::max<UInt32>(1, dataSourcePropSize / sizeof(UInt32)), dataSourceId);
    OSStatus status = AudioObjectSetPropertyData(
        device,
        &dataSourceProp,
        0,
        nullptr,
        static_cast<UInt32>(desiredDataSources.size() * sizeof(UInt32)),
        desiredDataSources.data()
    );
    if (status != noErr) {
        error = "Failed to select AirPlay route (error " + std::to_string(status) + ")";
        return false;
    }

    const auto currentDataSources = getCurrentDeviceDataSources(device, kAudioDevicePropertyScopeOutput);
    if (!currentDataSources.empty() && currentDataSources.front() != dataSourceId) {
        error = "AirPlay route selection did not stick";
        return false;
    }

    return true;
}

// ---------------------------------------------------------------------------
// Disable / restore mixing — MUST be done before hog mode
// ---------------------------------------------------------------------------

bool AudioEngine::disableMixing(AudioDeviceID device, std::string& error) {
    AudioObjectPropertyAddress prop = {kAudioDevicePropertySupportsMixing,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};

    // Check if property exists (not all devices support it)
    if (!AudioObjectHasProperty(device, &prop)) {
        // No mixing property — that's OK, device may be inherently non-mixing
        return true;
    }

    Boolean writable = false;
    if (AudioObjectIsPropertySettable(device, &prop, &writable) != noErr || !writable) {
        // Can't disable mixing — proceed anyway, may still work
        return true;
    }

    // Save original value
    UInt32 size = sizeof(UInt32);
    originalMixing_ = 1;
    AudioObjectGetPropertyData(device, &prop, 0, nullptr, &size, &originalMixing_);

    // Disable mixing
    UInt32 mixOff = 0;
    OSStatus err = AudioObjectSetPropertyData(device, &prop, 0, nullptr, sizeof(UInt32), &mixOff);
    if (err != noErr) {
        error = "Failed to disable mixing (error " + std::to_string(err) + ")";
        return false;
    }

    // Verify
    UInt32 verify = 1;
    AudioObjectGetPropertyData(device, &prop, 0, nullptr, &size, &verify);
    if (verify != 0) {
        error = "Mixing was not disabled (device rejected)";
        return false;
    }

    mixingDisabled_ = true;
    return true;
}

void AudioEngine::restoreMixing() {
    if (!mixingDisabled_ || activeDeviceId_ == kAudioObjectUnknown) return;
    AudioObjectPropertyAddress prop = {kAudioDevicePropertySupportsMixing,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
    if (AudioObjectHasProperty(activeDeviceId_, &prop)) {
        AudioObjectSetPropertyData(activeDeviceId_, &prop, 0, nullptr,
                                    sizeof(UInt32), &originalMixing_);
    }
    mixingDisabled_ = false;
}

// ---------------------------------------------------------------------------
// Hog mode
// ---------------------------------------------------------------------------

bool AudioEngine::hogDevice(AudioDeviceID device, std::string& error) {
    pid_t pid = getpid();
    UInt32 size = sizeof(pid_t);
    AudioObjectPropertyAddress prop = {kAudioDevicePropertyHogMode,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};

    pid_t currentHog = -1;
    AudioObjectGetPropertyData(device, &prop, 0, nullptr, &size, &currentHog);
    if (currentHog != -1 && currentHog != pid) {
        error = "Device is in use by another application (PID " +
                std::to_string(currentHog) + ")";
        return false;
    }

    OSStatus err = AudioObjectSetPropertyData(device, &prop, 0, nullptr, size, &pid);
    if (err != noErr) {
        error = "Failed to acquire exclusive mode (error " + std::to_string(err) + ")";
        return false;
    }

    // Verify hog was actually acquired
    pid_t verifyPid = -1;
    AudioObjectGetPropertyData(device, &prop, 0, nullptr, &size, &verifyPid);
    if (verifyPid != pid) {
        error = "Exclusive mode was not retained by device";
        return false;
    }

    hogPid_ = pid;
    return true;
}

void AudioEngine::unhogDevice() {
    if (activeDeviceId_ == kAudioObjectUnknown || hogPid_ == -1) return;
    pid_t pid = -1;
    UInt32 size = sizeof(pid_t);
    AudioObjectPropertyAddress prop = {kAudioDevicePropertyHogMode,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
    AudioObjectSetPropertyData(activeDeviceId_, &prop, 0, nullptr, size, &pid);
    hogPid_ = -1;
}

// ---------------------------------------------------------------------------
// Sample rate — set and wait with 2-second timeout
// ---------------------------------------------------------------------------

bool AudioEngine::setDeviceSampleRate(AudioDeviceID device, double rate) {
    // Check if already at target rate
    Float64 current = 0;
    UInt32 size = sizeof(Float64);
    AudioObjectPropertyAddress prop = {kAudioDevicePropertyNominalSampleRate,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
    AudioObjectGetPropertyData(device, &prop, 0, nullptr, &size, &current);
    if (std::abs(current - rate) < 1.0) return true;

    Float64 r = rate;
    if (AudioObjectSetPropertyData(device, &prop, 0, nullptr, sizeof(Float64), &r) != noErr)
        return false;

    // Poll for up to 2 seconds
    for (int i = 0; i < 200; i++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        Float64 cur = 0;
        AudioObjectGetPropertyData(device, &prop, 0, nullptr, &size, &cur);
        if (std::abs(cur - rate) < 1.0) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Format negotiation — find best integer PCM format
// FIX: do NOT override mSampleRate after scoring
// ---------------------------------------------------------------------------

bool AudioEngine::findBestFormat(AudioDeviceID device, double sampleRate,
                                  uint32_t bitDepth,
                                  bool preferNonMixableInteger,
                                  AudioStreamBasicDescription& outFormat) {
    AudioObjectPropertyAddress streamProp = {kAudioDevicePropertyStreams,
                                              kAudioObjectPropertyScopeOutput,
                                              kAudioObjectPropertyElementMain};
    UInt32 streamSize = 0;
    if (AudioObjectGetPropertyDataSize(device, &streamProp, 0, nullptr, &streamSize) !=
            noErr ||
        streamSize == 0)
        return false;

    std::vector<AudioStreamID> streams(streamSize / sizeof(AudioStreamID));
    AudioObjectGetPropertyData(device, &streamProp, 0, nullptr, &streamSize,
                                streams.data());

    AudioObjectPropertyAddress fmtProp = {
        kAudioStreamPropertyAvailablePhysicalFormats, kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain};
    UInt32 fmtSize = 0;
    if (AudioObjectGetPropertyDataSize(streams[0], &fmtProp, 0, nullptr, &fmtSize) !=
        noErr)
        return false;

    std::vector<AudioStreamRangedDescription> formats(
        fmtSize / sizeof(AudioStreamRangedDescription));
    AudioObjectGetPropertyData(streams[0], &fmtProp, 0, nullptr, &fmtSize,
                                formats.data());

    int bestScore = -1;
    for (const auto& ranged : formats) {
        const auto& fmt = ranged.mFormat;
        if (fmt.mFormatID != kAudioFormatLinearPCM) continue;

        bool isInteger = !(fmt.mFormatFlags & kAudioFormatFlagIsFloat);
        bool isSignedInteger = (fmt.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
        bool isBigEndian = (fmt.mFormatFlags & kAudioFormatFlagIsBigEndian);
        bool isPacked = (fmt.mFormatFlags & kAudioFormatFlagIsPacked) != 0;

        int score = 0;

        // Sample rate matching — exact match strongly preferred
        if (fmt.mSampleRate == sampleRate)
            score += 100;
        else if (sampleRate >= ranged.mSampleRateRange.mMinimum &&
                 sampleRate <= ranged.mSampleRateRange.mMaximum)
            score += 50;
        else
            continue; // skip formats that can't support our rate at all

        // Bit depth matching
        if (fmt.mBitsPerChannel == bitDepth)
            score += 80;
        else if (fmt.mBitsPerChannel > bitDepth)
            score += 40;

        // Strong preference for integer mode (bit-perfect, NOT float)
        if (isInteger) score += 60;
        if (isSignedInteger) score += 20;
        if (isPacked) score += 10;

        // For DoP we only need the physical stream to be a valid 32-bit integer carrier.
        // Non-mixable matters on the virtual format, not on the physical candidate scoring.
        if (preferNonMixableInteger && isDoP32CarrierFormat(fmt, static_cast<uint32_t>(sampleRate))) {
            score += 120;
        }

        // Prefer native endian (little-endian on Apple Silicon)
        if (!isBigEndian) score += 10;

        if (score > bestScore) {
            bestScore = score;
            outFormat = fmt;
        }
    }

    if (bestScore < 0) return false;

    // FIX: Do NOT override mSampleRate here.
    // The format's mSampleRate is what the device actually supports.
    // We set the device nominal rate separately via setDeviceSampleRate().
    // If the format has a variable rate range, set it to what we want,
    // but ONLY if the format's own rate is 0 (variable) or matches a range.
    if (outFormat.mSampleRate != sampleRate) {
        // The format we found doesn't have an exact rate match,
        // but we scored it because the rate is within its range.
        // Set the desired rate — setDeviceSampleRate() will handle it.
        outFormat.mSampleRate = sampleRate;
    }

    return true;
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

AudioStreamID AudioEngine::getOutputStream(AudioDeviceID device) {
    AudioObjectPropertyAddress prop = {kAudioDevicePropertyStreams,
                                        kAudioObjectPropertyScopeOutput,
                                        kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(device, &prop, 0, nullptr, &size) != noErr || size == 0)
        return 0;
    std::vector<AudioStreamID> streams(size / sizeof(AudioStreamID));
    AudioObjectGetPropertyData(device, &prop, 0, nullptr, &size, streams.data());
    return streams.empty() ? 0 : streams[0];
}

bool AudioEngine::setStreamFormat(AudioStreamID stream,
                                   AudioObjectPropertySelector selector,
                                   const AudioStreamBasicDescription& format) {
    AudioObjectPropertyAddress prop = {selector,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
    OSStatus err = AudioObjectSetPropertyData(
        stream, &prop, 0, nullptr, sizeof(AudioStreamBasicDescription), &format);
    return err == noErr;
}

namespace {

// Wakes a waiter when the HAL reports a property change (format changes are asynchronous).
struct PropertyChangeWaiter {
    std::mutex mutex;
    std::condition_variable changed;
    bool fired = false;
};

OSStatus propertyChangedListener(AudioObjectID, UInt32, const AudioObjectPropertyAddress*, void* clientData) {
    auto* waiter = static_cast<PropertyChangeWaiter*>(clientData);
    {
        std::lock_guard<std::mutex> lock(waiter->mutex);
        waiter->fired = true;
    }
    waiter->changed.notify_all();
    return noErr;
}

bool streamFormatMatches(const AudioStreamBasicDescription& actual,
                         const AudioStreamBasicDescription& expected, bool rateOnly) {
    if (std::abs(actual.mSampleRate - expected.mSampleRate) >= 1.0) return false;
    if (rateOnly) return true;
    const uint32_t carrierRate = static_cast<uint32_t>(std::llround(expected.mSampleRate));
    if (expected.mSampleRate > 0.0 && isDoP32CarrierFormat(expected, carrierRate)) {
        return isDoP32CarrierFormat(actual, carrierRate);
    }
    return actual.mBitsPerChannel == expected.mBitsPerChannel &&
           actual.mChannelsPerFrame == expected.mChannelsPerFrame &&
           actual.mFormatID == expected.mFormatID;
}

}  // namespace

// Waits until the stream property matches `expected` (rate only when `rateOnly`).
// Event-driven like mpv's ca_change_physical_format_sync: returns as soon as the
// HAL reports the change instead of polling on a fixed schedule.
bool AudioEngine::waitForStreamFormat(AudioStreamID stream,
                                       AudioObjectPropertySelector selector,
                                       const AudioStreamBasicDescription& expected,
                                       int timeoutMs, bool rateOnly) {
    AudioObjectPropertyAddress prop = {selector,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
    PropertyChangeWaiter waiter;
    const bool listening =
        AudioObjectAddPropertyListener(stream, &prop, propertyChangedListener, &waiter) == noErr;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);

    bool matched = false;
    for (;;) {
        AudioStreamBasicDescription actual{};
        UInt32 sz = sizeof(actual);
        if (AudioObjectGetPropertyData(stream, &prop, 0, nullptr, &sz, &actual) == noErr &&
            streamFormatMatches(actual, expected, rateOnly)) {
            matched = true;
            break;
        }
        std::unique_lock<std::mutex> lock(waiter.mutex);
        // Without a listener, fall back to short polling.
        const auto wakeAt = listening ? deadline
            : std::min(deadline, std::chrono::steady_clock::now() + std::chrono::milliseconds(10));
        waiter.changed.wait_until(lock, wakeAt, [&] { return waiter.fired; });
        waiter.fired = false;
        if (std::chrono::steady_clock::now() >= deadline) {
            lock.unlock();
            sz = sizeof(actual);
            matched = AudioObjectGetPropertyData(stream, &prop, 0, nullptr, &sz, &actual) == noErr &&
                      streamFormatMatches(actual, expected, rateOnly);
            break;
        }
    }

    if (listening) AudioObjectRemovePropertyListener(stream, &prop, propertyChangedListener, &waiter);
    return matched;
}

// Whether the stream offers `format` as a virtual format (integer virtual
// formats only exist on devices that expose non-mixable output).
static bool streamOffersVirtualFormat(AudioStreamID stream, const AudioStreamBasicDescription& format) {
    AudioObjectPropertyAddress prop = {kAudioStreamPropertyAvailableVirtualFormats,
                                       kAudioObjectPropertyScopeGlobal,
                                       kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(stream, &prop, 0, nullptr, &size) != noErr || size == 0) return false;
    std::vector<AudioStreamRangedDescription> formats(size / sizeof(AudioStreamRangedDescription));
    if (AudioObjectGetPropertyData(stream, &prop, 0, nullptr, &size, formats.data()) != noErr) return false;
    for (const auto& ranged : formats) {
        const auto& candidate = ranged.mFormat;
        const bool rateOk = std::abs(candidate.mSampleRate - format.mSampleRate) < 1.0 ||
            (format.mSampleRate >= ranged.mSampleRateRange.mMinimum &&
             format.mSampleRate <= ranged.mSampleRateRange.mMaximum);
        if (rateOk && candidate.mFormatID == format.mFormatID &&
            candidate.mFormatFlags == format.mFormatFlags &&
            candidate.mBitsPerChannel == format.mBitsPerChannel &&
            candidate.mChannelsPerFrame == format.mChannelsPerFrame) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Set physical + virtual format on device stream
// ---------------------------------------------------------------------------

bool AudioEngine::setPhysicalFormat(AudioDeviceID device,
                                     const AudioStreamBasicDescription& format) {
    AudioStreamID stream = getOutputStream(device);
    if (stream == 0) return false;

    // Save original formats for restore on close
    if (!formatChanged_) {
        UInt32 sz = sizeof(AudioStreamBasicDescription);
        AudioObjectPropertyAddress physProp = {kAudioStreamPropertyPhysicalFormat,
                                                kAudioObjectPropertyScopeGlobal,
                                                kAudioObjectPropertyElementMain};
        AudioObjectGetPropertyData(stream, &physProp, 0, nullptr, &sz, &originalPhysicalFormat_);

        sz = sizeof(AudioStreamBasicDescription);
        AudioObjectPropertyAddress virtProp = {kAudioStreamPropertyVirtualFormat,
                                                kAudioObjectPropertyScopeGlobal,
                                                kAudioObjectPropertyElementMain};
        AudioObjectGetPropertyData(stream, &virtProp, 0, nullptr, &sz, &originalVirtualFormat_);

        formatChanged_ = true;
    }

    // Physical format FIRST (the DAC's real rate/depth). Skip the round trip
    // when it is already in place — a no-op set produces no change notification.
    AudioStreamBasicDescription currentPhysical{};
    UInt32 size = sizeof(currentPhysical);
    AudioObjectPropertyAddress physProp = {kAudioStreamPropertyPhysicalFormat,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
    const bool physicalInPlace =
        AudioObjectGetPropertyData(stream, &physProp, 0, nullptr, &size, &currentPhysical) == noErr &&
        streamFormatMatches(currentPhysical, format, false) &&
        currentPhysical.mFormatFlags == format.mFormatFlags;
    if (!physicalInPlace) {
        if (!setStreamFormat(stream, kAudioStreamPropertyPhysicalFormat, format))
            return false;
        if (!waitForStreamFormat(stream, kAudioStreamPropertyPhysicalFormat, format, 2000, false)) {
            fprintf(stderr, "[Puros] Physical format change not confirmed within 2 s\n");
        }
    }

    // The virtual format is what the IOProc sees. Match it to the physical one only
    // when the device offers that (non-mixable integer output); otherwise the HAL
    // keeps float32 and converts exactly (float32 holds 24-bit samples losslessly).
    // Either way its rate follows the physical format asynchronously — wait for that.
    if (streamOffersVirtualFormat(stream, format) &&
        setStreamFormat(stream, kAudioStreamPropertyVirtualFormat, format)) {
        waitForStreamFormat(stream, kAudioStreamPropertyVirtualFormat, format, 500, false);
    } else {
        waitForStreamFormat(stream, kAudioStreamPropertyVirtualFormat, format, 500, true);
    }

    return true;
}

bool AudioEngine::verifyPhysicalFormat(AudioDeviceID device,
                                        const AudioStreamBasicDescription& expected) {
    AudioStreamID stream = getOutputStream(device);
    if (stream == 0) return false;

    AudioStreamBasicDescription actual{};
    UInt32 sz = sizeof(actual);
    AudioObjectPropertyAddress fmtProp = {kAudioStreamPropertyPhysicalFormat,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
    AudioObjectGetPropertyData(stream, &fmtProp, 0, nullptr, &sz, &actual);

    return actual.mBitsPerChannel == expected.mBitsPerChannel &&
           std::abs(actual.mSampleRate - expected.mSampleRate) < 1.0 &&
           actual.mChannelsPerFrame == expected.mChannelsPerFrame;
}

void AudioEngine::refreshActiveStreamFormats(const AudioStreamBasicDescription* fallback) {
    if (activeDeviceId_ == kAudioObjectUnknown) {
        if (fallback) {
            physicalOutputFormat_ = *fallback;
            virtualOutputFormat_ = *fallback;
            outputFormat_ = *fallback;
        }
        return;
    }

    const AudioStreamID stream = getOutputStream(activeDeviceId_);
    if (stream == 0) {
        if (fallback) {
            physicalOutputFormat_ = *fallback;
            virtualOutputFormat_ = *fallback;
            outputFormat_ = *fallback;
        }
        return;
    }

    AudioStreamBasicDescription physicalFmt{};
    UInt32 size = sizeof(physicalFmt);
    AudioObjectPropertyAddress physProp = {kAudioStreamPropertyPhysicalFormat,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(stream, &physProp, 0, nullptr, &size, &physicalFmt) == noErr &&
        physicalFmt.mBytesPerFrame > 0) {
        physicalOutputFormat_ = physicalFmt;
    } else if (fallback) {
        physicalOutputFormat_ = *fallback;
    }

    AudioStreamBasicDescription virtualFmt{};
    size = sizeof(virtualFmt);
    AudioObjectPropertyAddress virtProp = {kAudioStreamPropertyVirtualFormat,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(stream, &virtProp, 0, nullptr, &size, &virtualFmt) == noErr &&
        virtualFmt.mBytesPerFrame > 0) {
        virtualOutputFormat_ = virtualFmt;
        outputFormat_ = virtualFmt;
    } else if (fallback) {
        virtualOutputFormat_ = *fallback;
        outputFormat_ = *fallback;
    }
}

bool AudioEngine::activateDsdOutputMode(const AudioStreamBasicDescription& requestedFormat, std::string& error) {
    if (activeDeviceId_ == kAudioObjectUnknown) {
        error = "No active device for DSD output";
        return false;
    }

    const AudioStreamID stream = getOutputStream(activeDeviceId_);
    if (stream == 0) {
        error = "No output stream available for DSD output";
        return false;
    }

    AudioStreamBasicDescription dopVirtualFormat{};
    std::string virtualReason;
    if (!selectDoPVirtualFormat(stream, static_cast<uint32_t>(requestedFormat.mSampleRate), dopVirtualFormat, &virtualReason)) {
        error = virtualReason;
        return false;
    }

    dsdHogMode_.reset();
    dsdHogMode_ = std::make_unique<ScopedDsdHogMode>(activeDeviceId_, stream);

    const bool restartIo = (mode_ == AudioMode::Exclusive && ioProcId_ != nullptr);
    if (restartIo) {
        AudioDeviceStop(activeDeviceId_, ioProcId_);
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    std::string dsdHogWarning;
    if (!dsdHogMode_->acquire(&dsdHogWarning) && !dsdHogWarning.empty()) {
        fprintf(stderr, "[Puros] Warning: %s\n", dsdHogWarning.c_str());
    }

    if (!dsdHogMode_->configureVirtualFormat(dopVirtualFormat, error)) {
        dsdHogMode_.reset();
        refreshActiveStreamFormats(&requestedFormat);
        if (restartIo) {
            AudioDeviceStart(activeDeviceId_, ioProcId_);
        }
        return false;
    }

    refreshActiveStreamFormats(&dopVirtualFormat);
    if (restartIo) {
        const OSStatus status = AudioDeviceStart(activeDeviceId_, ioProcId_);
        if (status != noErr) {
            error = "Failed to restart device after DoP virtual format change";
            dsdHogMode_.reset();
            refreshActiveStreamFormats(&requestedFormat);
            return false;
        }
    }
    return true;
}

void AudioEngine::deactivateDsdOutputMode(bool restartIo) {
    if (!dsdHogMode_) return;

    const bool shouldRestart = restartIo && mode_ == AudioMode::Exclusive && ioProcId_ != nullptr &&
                               activeDeviceId_ != kAudioObjectUnknown;
    if (shouldRestart) {
        AudioDeviceStop(activeDeviceId_, ioProcId_);
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    dsdHogMode_.reset();
    refreshActiveStreamFormats();

    if (shouldRestart) {
        AudioDeviceStart(activeDeviceId_, ioProcId_);
    }
}

// ---------------------------------------------------------------------------
// Audio callbacks — real-time thread, no allocations/locks
// FIX: increment framesPlayed_ for accurate position tracking
// ---------------------------------------------------------------------------

OSStatus AudioEngine::exclusiveIOProc(AudioDeviceID, const AudioTimeStamp*,
                                       const AudioBufferList*, const AudioTimeStamp*,
                                       AudioBufferList* outputData, const AudioTimeStamp*,
                                       void* clientData) {
    auto* engine = static_cast<AudioEngine*>(clientData);
    if (engine->paused_.load(std::memory_order_relaxed) || !engine->getActiveSlot()) {
        silenceOutput(outputData);
        const auto& renderFormat = engine->outputFormat_;
        engine->captureVisualizerSamples(outputData, renderFormat);
        return noErr;
    }

    for (UInt32 i = 0; i < outputData->mNumberBuffers; i++) {
        auto& buf = outputData->mBuffers[i];
        size_t written = 0;
        while (written < buf.mDataByteSize) {
            TrackSlot* slot = engine->getActiveSlot();
            if (!slot || !slot->ringBuffer) break;

            size_t got = slot->ringBuffer->read(
                static_cast<uint8_t*>(buf.mData) + written,
                buf.mDataByteSize - written
            );
            written += got;

            const auto& renderFormat =
                slot->renderFormat.mBytesPerFrame > 0 ? slot->renderFormat : engine->outputFormat_;
            if (got > 0 && renderFormat.mBytesPerFrame > 0) {
                slot->framesPlayed.fetch_add(
                    got / renderFormat.mBytesPerFrame,
                    std::memory_order_relaxed
                );
            }

            if (written >= buf.mDataByteSize) break;
            if (!engine->tryPromoteQueuedSlot()) break;
        }

        if (written < buf.mDataByteSize) {
            std::memset(static_cast<uint8_t*>(buf.mData) + written, 0, buf.mDataByteSize - written);
        }
    }
    TrackSlot* slot = engine->getActiveSlot();
    const auto& renderFormat =
        slot && slot->renderFormat.mBytesPerFrame > 0 ? slot->renderFormat : engine->outputFormat_;
    engine->captureVisualizerSamples(outputData, renderFormat);
    // DoP payloads must never be scaled; JS routes DSD through PCM while DSP volume is in use.
    const bool isDoP = slot && (slot->sourceKind == TrackSourceKind::DsdDoP || slot->dopOutput);
    const auto& physical = engine->physicalOutputFormat_;
    const uint32_t physicalBits = (physical.mFormatFlags & kAudioFormatFlagIsFloat) == 0
        ? physical.mBitsPerChannel
        : 0;
    engine->digitalVolume_.process(outputData, renderFormat, physicalBits, isDoP);
    return noErr;
}

OSStatus AudioEngine::sharedRenderCallback(void* inRefCon, AudioUnitRenderActionFlags*,
                                            const AudioTimeStamp*, UInt32, UInt32,
                                            AudioBufferList* ioData) {
    auto* engine = static_cast<AudioEngine*>(inRefCon);
    if (engine->paused_.load(std::memory_order_relaxed) || !engine->getActiveSlot()) {
        silenceOutput(ioData);
        const auto& renderFormat = engine->outputFormat_;
        engine->captureVisualizerSamples(ioData, renderFormat);
        return noErr;
    }

    for (UInt32 i = 0; i < ioData->mNumberBuffers; i++) {
        auto& buf = ioData->mBuffers[i];
        size_t written = 0;
        while (written < buf.mDataByteSize) {
            TrackSlot* slot = engine->getActiveSlot();
            if (!slot || !slot->ringBuffer) break;

            size_t got = slot->ringBuffer->read(
                static_cast<uint8_t*>(buf.mData) + written,
                buf.mDataByteSize - written
            );
            written += got;

            const auto& renderFormat =
                slot->renderFormat.mBytesPerFrame > 0 ? slot->renderFormat : engine->outputFormat_;
            if (got > 0 && renderFormat.mBytesPerFrame > 0) {
                slot->framesPlayed.fetch_add(
                    got / renderFormat.mBytesPerFrame,
                    std::memory_order_relaxed
                );
            }

            if (written >= buf.mDataByteSize) break;
            if (!engine->tryPromoteQueuedSlot()) break;
        }

        if (written < buf.mDataByteSize) {
            std::memset(static_cast<uint8_t*>(buf.mData) + written, 0, buf.mDataByteSize - written);
        }
    }
    TrackSlot* slot = engine->getActiveSlot();
    const auto& renderFormat =
        slot && slot->renderFormat.mBytesPerFrame > 0 ? slot->renderFormat : engine->outputFormat_;
    engine->captureVisualizerSamples(ioData, renderFormat);
    return noErr;
}

// ---------------------------------------------------------------------------
// openExclusive
//   PCM exclusive keeps the existing IOProc path.
//   DSD/DoP exclusive uses HALOutput with an explicit int32 input bus because
//   some DACs expose the right physical carrier but keep the HAL stream virtual
//   format pinned to float, which blocks native DoP through AudioDeviceIOProc.
// ---------------------------------------------------------------------------

void AudioEngine::setHardwareBufferOptions(const std::string& deviceUid, bool useMax, bool powerOfTwo) {
    std::lock_guard<std::mutex> lock(bufferOptionsMutex_);
    if (!useMax && !powerOfTwo) {
        bufferOptions_.erase(deviceUid);
    } else {
        bufferOptions_[deviceUid] = {useMax, powerOfTwo};
    }
}

void AudioEngine::applyHardwareBufferOptions(AudioDeviceID device, const std::string& deviceUid) {
    HardwareBufferOptions options;
    {
        std::lock_guard<std::mutex> lock(bufferOptionsMutex_);
        auto it = bufferOptions_.find(deviceUid);
        if (it == bufferOptions_.end()) return;
        options = it->second;
    }

    AudioObjectPropertyAddress rangeProp = {kAudioDevicePropertyBufferFrameSizeRange,
                                            kAudioObjectPropertyScopeGlobal,
                                            kAudioObjectPropertyElementMain};
    AudioObjectPropertyAddress sizeProp = {kAudioDevicePropertyBufferFrameSize,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
    AudioValueRange range{};
    UInt32 rangeSize = sizeof(range);
    UInt32 current = 0;
    UInt32 currentSize = sizeof(current);
    if (AudioObjectGetPropertyData(device, &rangeProp, 0, nullptr, &rangeSize, &range) != noErr ||
        AudioObjectGetPropertyData(device, &sizeProp, 0, nullptr, &currentSize, &current) != noErr ||
        range.mMaximum < 1.0 || current == 0) {
        fprintf(stderr, "[Puros] Hardware buffer size range unavailable — keeping driver default\n");
        return;
    }

    const UInt32 minFrames = static_cast<UInt32>(range.mMinimum);
    const UInt32 maxFrames = static_cast<UInt32>(range.mMaximum);
    UInt32 target = options.useMax ? maxFrames : current;
    if (options.powerOfTwo) {
        UInt32 largestPow2 = 1;
        while (largestPow2 <= maxFrames / 2) largestPow2 <<= 1;
        if (options.useMax) {
            target = largestPow2;
        } else {
            UInt32 pow2 = 1;
            while (pow2 < target && pow2 < largestPow2) pow2 <<= 1;
            target = pow2;
        }
    }
    if (target < minFrames || target > maxFrames || target == current) return;

    if (AudioObjectSetPropertyData(device, &sizeProp, 0, nullptr, sizeof(target), &target) == noErr) {
        bufferFramesDevice_ = device;
        originalBufferFrames_ = current;
        fprintf(stderr, "[Puros] Hardware buffer: %u -> %u frames (range %u-%u)\n",
                current, target, minFrames, maxFrames);
    } else {
        fprintf(stderr, "[Puros] Device refused hardware buffer size %u frames\n", target);
    }
}

void AudioEngine::restoreHardwareBufferSize() {
    if (bufferFramesDevice_ == kAudioObjectUnknown) return;
    AudioObjectPropertyAddress sizeProp = {kAudioDevicePropertyBufferFrameSize,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
    UInt32 frames = originalBufferFrames_;
    AudioObjectSetPropertyData(bufferFramesDevice_, &sizeProp, 0, nullptr, sizeof(frames), &frames);
    bufferFramesDevice_ = kAudioObjectUnknown;
    originalBufferFrames_ = 0;
}

void AudioEngine::restoreOriginalStreamFormats(AudioStreamID stream) {
    setStreamFormat(stream, kAudioStreamPropertyVirtualFormat, originalVirtualFormat_);
    AudioStreamBasicDescription current{};
    UInt32 size = sizeof(current);
    AudioObjectPropertyAddress physProp = {kAudioStreamPropertyPhysicalFormat,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(stream, &physProp, 0, nullptr, &size, &current) == noErr &&
        audioFormatsEquivalent(current, originalPhysicalFormat_)) {
        return;
    }
    if (setStreamFormat(stream, kAudioStreamPropertyPhysicalFormat, originalPhysicalFormat_)) {
        waitForStreamFormat(stream, kAudioStreamPropertyPhysicalFormat, originalPhysicalFormat_, 1000, false);
    }
}

// Switch rate/depth on the device we already own: stop IO, change the physical
// format, restart. Hog mode, IOProc and the saved original format are kept, so
// a track-to-track rate change costs one DAC relock instead of a full teardown.
bool AudioEngine::reconfigureExclusive(double sampleRate, uint32_t bitDepth, std::string& error) {
    const AudioDeviceID device = activeDeviceId_;
    AudioStreamBasicDescription format{};
    if (!findBestFormat(device, sampleRate, bitDepth, false, format)) {
        error = "No suitable integer format on device";
        return false;
    }

    AudioDeviceStop(device, ioProcId_);
    stopPlayback();
    if (!setPhysicalFormat(device, format)) {
        error = "Failed to set physical format";
        return false;
    }
    setDeviceSampleRate(device, sampleRate);
    refreshActiveStreamFormats(&format);
    dsp_.setOutputFormat((outputFormat_.mFormatFlags & kAudioFormatFlagIsFloat) != 0, outputFormat_.mSampleRate);
    const OSStatus status = AudioDeviceStart(device, ioProcId_);
    if (status != noErr) {
        error = "Failed to restart audio device (error " + std::to_string(status) + ")";
        return false;
    }
    fprintf(stderr, "[Puros] Exclusive format changed in place: %.0f Hz / %u bit (physical %.0f Hz / %u bit)\n",
            outputFormat_.mSampleRate, outputFormat_.mBitsPerChannel,
            physicalOutputFormat_.mSampleRate, physicalOutputFormat_.mBitsPerChannel);
    return true;
}

bool AudioEngine::openExclusive(const std::string& deviceUid, double sampleRate,
                                 uint32_t bitDepth, bool preferNonMixableInteger, std::string& error) {
    // Same device, plain PCM IOProc path: change the format without letting go of the device.
    if (mode_ == AudioMode::Exclusive && activeDeviceUid_ == deviceUid && ioProcId_ != nullptr &&
        audioUnit_ == nullptr && !dsdHogMode_ && !preferNonMixableInteger) {
        if (reconfigureExclusive(sampleRate, bitDepth, error)) return true;
        fprintf(stderr, "[Puros] In-place format change failed (%s); reopening\n", error.c_str());
        error.clear();
    }

    close();

    AudioDeviceID device = findDeviceByUid(deviceUid);
    if (device == kAudioObjectUnknown) {
        error = "Device not found: " + deviceUid;
        return false;
    }

    activeDeviceId_ = device;
    activeDeviceUid_ = deviceUid;

    auto failExclusiveOpen = [&](const std::string& message) -> bool {
        if (audioUnit_ != nullptr) {
            AudioOutputUnitStop(audioUnit_);
            AudioUnitUninitialize(audioUnit_);
            AudioComponentInstanceDispose(audioUnit_);
            audioUnit_ = nullptr;
        }
        if (ioProcId_ != nullptr) {
            AudioDeviceDestroyIOProcID(device, ioProcId_);
            ioProcId_ = nullptr;
        }
        restoreHardwareBufferSize();
        restoreMixing();
        unhogDevice();
        activeDeviceId_ = kAudioObjectUnknown;
        error = message;
        return false;
    };

    // 0. Reject shared-only transports before any exclusive setup.
    //    Bluetooth and AirPlay outputs do not provide a stable exclusive path
    //    for this engine, so return sentinel errors for graceful shared-mode fallback.
    {
        UInt32 transport = 0, ts = sizeof(UInt32);
        AudioObjectPropertyAddress transProp = {kAudioDevicePropertyTransportType,
                                                 kAudioObjectPropertyScopeGlobal,
                                                 kAudioObjectPropertyElementMain};
        AudioObjectGetPropertyData(device, &transProp, 0, nullptr, &ts, &transport);
        if (transport == kAudioDeviceTransportTypeBluetooth ||
            transport == kAudioDeviceTransportTypeBluetoothLE) {
            error = "BLUETOOTH_DEVICE";
            activeDeviceId_ = kAudioObjectUnknown;
            return false;
        }
        if (transport == kAudioDeviceTransportTypeAirPlay) {
            error = "AIRPLAY_DEVICE";
            activeDeviceId_ = kAudioObjectUnknown;
            return false;
        }
    }

    // 1. Disable mixing FIRST — before hog, before format change
    if (!disableMixing(device, error)) {
        // Non-fatal on devices that don't support the property
        fprintf(stderr, "[Puros] Warning: %s\n", error.c_str());
        error.clear();
    }

    // 2. Acquire hog mode
    if (!hogDevice(device, error)) {
        restoreMixing();
        activeDeviceId_ = kAudioObjectUnknown;
        return false;
    }

    // 3. Find best integer format
    AudioStreamBasicDescription format{};
    if (!findBestFormat(device, sampleRate, bitDepth, preferNonMixableInteger, format)) {
        return failExclusiveOpen("No suitable integer format on device");
    }

    // 4. Set physical format on the stream (this also sets the sample rate)
    //    setPhysicalFormat also sets virtual format to match.
    if (!setPhysicalFormat(device, format)) {
        return failExclusiveOpen("Failed to set physical format");
    }

    // 4b. Audio Setup buffer options — while hogged, before any IO starts.
    applyHardwareBufferOptions(device, deviceUid);

    AudioStreamID stream = getOutputStream(device);
    if (preferNonMixableInteger) {
        setDeviceSampleRate(device, sampleRate);
        if (!verifyPhysicalFormat(device, format)) {
            return failExclusiveOpen("Device refused physical DoP carrier format");
        }

        if (stream != 0) {
            UInt32 sz = sizeof(AudioStreamBasicDescription);
            AudioStreamBasicDescription physActual{};
            AudioObjectPropertyAddress pp = {kAudioStreamPropertyPhysicalFormat,
                                             kAudioObjectPropertyScopeGlobal,
                                             kAudioObjectPropertyElementMain};
            if (AudioObjectGetPropertyData(stream, &pp, 0, nullptr, &sz, &physActual) == noErr &&
                physActual.mBytesPerFrame > 0) {
                physicalOutputFormat_ = physActual;
            } else {
                physicalOutputFormat_ = format;
            }
        } else {
            physicalOutputFormat_ = format;
        }
        virtualOutputFormat_ = format;
        outputFormat_ = format;

        AudioComponentDescription desc{};
        desc.componentType = kAudioUnitType_Output;
        desc.componentSubType = kAudioUnitSubType_HALOutput;
        desc.componentManufacturer = kAudioUnitManufacturer_Apple;

        AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
        if (!comp) {
            return failExclusiveOpen("AudioUnit component not found for DoP output");
        }

        OSStatus status = AudioComponentInstanceNew(comp, &audioUnit_);
        if (status != noErr) {
            return failExclusiveOpen("Failed to create DoP AudioUnit");
        }

        status = AudioUnitSetProperty(audioUnit_, kAudioOutputUnitProperty_CurrentDevice,
                                      kAudioUnitScope_Global, 0, &device, sizeof(device));
        if (status != noErr) {
            return failExclusiveOpen("Failed to bind DoP AudioUnit to output device");
        }

        status = AudioUnitSetProperty(audioUnit_, kAudioUnitProperty_StreamFormat,
                                      kAudioUnitScope_Input, 0, &outputFormat_,
                                      sizeof(outputFormat_));
        if (status != noErr) {
            return failExclusiveOpen("Failed to set DoP AudioUnit stream format (error " +
                                     std::to_string(status) + ")");
        }

        AURenderCallbackStruct cb{sharedRenderCallback, this};
        status = AudioUnitSetProperty(audioUnit_, kAudioUnitProperty_SetRenderCallback,
                                      kAudioUnitScope_Input, 0, &cb, sizeof(cb));
        if (status != noErr) {
            return failExclusiveOpen("Failed to set DoP AudioUnit render callback");
        }

        status = AudioUnitInitialize(audioUnit_);
        if (status != noErr) {
            return failExclusiveOpen("Failed to initialize DoP AudioUnit");
        }

        dsp_.setOutputFormat(false, outputFormat_.mSampleRate);

        status = AudioOutputUnitStart(audioUnit_);
        if (status != noErr) {
            return failExclusiveOpen("Failed to start DoP AudioUnit");
        }

        fprintf(stderr,
                "[Puros] Using HALOutput integer input path for DoP: %.0f Hz / %u bit / %u ch / %u Bpf\n",
                outputFormat_.mSampleRate, outputFormat_.mBitsPerChannel,
                outputFormat_.mChannelsPerFrame, outputFormat_.mBytesPerFrame);

        mode_ = AudioMode::Exclusive;
        return true;
    }

    // 5. Read back the ACTUAL virtual format — this is what the IOProc will deliver.
    //    Use this as outputFormat_ to ensure ring buffer stride matches exactly.
    if (stream != 0) {
        refreshActiveStreamFormats(&format);
    } else {
        physicalOutputFormat_ = format;
        virtualOutputFormat_ = format;
        outputFormat_ = format;
    }

    // Also set the device nominal sample rate to match (belt and suspenders)
    setDeviceSampleRate(device, sampleRate);

    // --- Diagnostic log ---
    {
        AudioStreamBasicDescription physActual{}, virtActual{};
        UInt32 sz = sizeof(AudioStreamBasicDescription);
        if (stream != 0) {
            AudioObjectPropertyAddress pp = {kAudioStreamPropertyPhysicalFormat,
                                             kAudioObjectPropertyScopeGlobal,
                                             kAudioObjectPropertyElementMain};
            AudioObjectGetPropertyData(stream, &pp, 0, nullptr, &sz, &physActual);
            sz = sizeof(AudioStreamBasicDescription);
            AudioObjectPropertyAddress vp = {kAudioStreamPropertyVirtualFormat,
                                             kAudioObjectPropertyScopeGlobal,
                                             kAudioObjectPropertyElementMain};
            AudioObjectGetPropertyData(stream, &vp, 0, nullptr, &sz, &virtActual);
        }

        pid_t hogCheck = -1;
        UInt32 hogSz = sizeof(pid_t);
        AudioObjectPropertyAddress hogProp = {kAudioDevicePropertyHogMode,
                                              kAudioObjectPropertyScopeGlobal,
                                              kAudioObjectPropertyElementMain};
        AudioObjectGetPropertyData(device, &hogProp, 0, nullptr, &hogSz, &hogCheck);

        UInt32 mixVal = 99;
        UInt32 mixSz = sizeof(UInt32);
        AudioObjectPropertyAddress mixProp = {kAudioDevicePropertySupportsMixing,
                                              kAudioObjectPropertyScopeGlobal,
                                              kAudioObjectPropertyElementMain};
        if (AudioObjectHasProperty(device, &mixProp))
            AudioObjectGetPropertyData(device, &mixProp, 0, nullptr, &mixSz, &mixVal);

        UInt32 bufFrames = 0;
        UInt32 bfSz = sizeof(UInt32);
        AudioObjectPropertyAddress bufProp = {kAudioDevicePropertyBufferFrameSize,
                                              kAudioObjectPropertyScopeOutput,
                                              kAudioObjectPropertyElementMain};
        AudioObjectGetPropertyData(device, &bufProp, 0, nullptr, &bfSz, &bufFrames);

        auto flagStr = [](UInt32 flags) -> std::string {
            std::string s;
            if (flags & kAudioFormatFlagIsFloat) s += "float ";
            if (flags & kAudioFormatFlagIsSignedInteger) s += "int ";
            if (flags & kAudioFormatFlagIsPacked) s += "packed ";
            if (flags & kAudioFormatFlagIsBigEndian) s += "BE ";
            if (flags & kAudioFormatFlagIsAlignedHigh) s += "alignHi ";
            return s.empty() ? "none" : s;
        };

        fprintf(stderr,
                "[Puros] === Exclusive Mode Diagnostics ===\n"
                "  Requested:  %.0f Hz / %u bit\n"
                "  Physical:   %.0f Hz / %u bit / %u ch / %u Bpf / flags: %s\n"
                "  Virtual:    %.0f Hz / %u bit / %u ch / %u Bpf / flags: %s\n"
                "  OutputFmt:  %.0f Hz / %u bit / %u ch / %u Bpf / flags: %s\n"
                "  Hog PID:    %d (ours: %d) %s\n"
                "  Mixing:     %u %s\n"
                "  BufFrames:  %u\n"
                "  =========================================\n",
                sampleRate, bitDepth,
                physActual.mSampleRate, physActual.mBitsPerChannel,
                physActual.mChannelsPerFrame, physActual.mBytesPerFrame,
                flagStr(physActual.mFormatFlags).c_str(),
                virtActual.mSampleRate, virtActual.mBitsPerChannel,
                virtActual.mChannelsPerFrame, virtActual.mBytesPerFrame,
                flagStr(virtActual.mFormatFlags).c_str(),
                outputFormat_.mSampleRate, outputFormat_.mBitsPerChannel,
                outputFormat_.mChannelsPerFrame, outputFormat_.mBytesPerFrame,
                flagStr(outputFormat_.mFormatFlags).c_str(),
                hogCheck, getpid(), (hogCheck == getpid() ? "OK" : "MISMATCH!"),
                mixVal, (mixVal == 0 ? "DISABLED (good)" : mixVal == 99 ? "(not supported)" : "ENABLED (BAD!)"),
                bufFrames);
    }

    {
        bool isFloat = (outputFormat_.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
        dsp_.setOutputFormat(isFloat, outputFormat_.mSampleRate);
    }

    // 6. IOProc — LAST
    OSStatus err = noErr;
    if (ioProcId_ == nullptr) {
        err = AudioDeviceCreateIOProcID(device, exclusiveIOProc, this, &ioProcId_);
        if (err != noErr) {
            return failExclusiveOpen("Failed to create IOProc (error " + std::to_string(err) + ")");
        }
    }

    err = AudioDeviceStart(device, ioProcId_);
    if (err != noErr) {
        AudioDeviceDestroyIOProcID(device, ioProcId_);
        ioProcId_ = nullptr;
        return failExclusiveOpen("Failed to start audio device (error " + std::to_string(err) + ")");
    }

    mode_ = AudioMode::Exclusive;
    return true;
}

// ---------------------------------------------------------------------------
// openShared — AudioUnit (HALOutput) through system mixer
// FIX: query device format dynamically, use 32-bit integer, match channels
// ---------------------------------------------------------------------------

bool AudioEngine::openShared(const std::string& deviceUid, std::string& error) {
    close();

    AudioDeviceID device = findDeviceByUid(deviceUid);
    if (device == kAudioObjectUnknown) {
        error = "Device not found: " + deviceUid;
        return false;
    }

    activeDeviceId_ = device;
    activeDeviceUid_ = deviceUid;

    // Create HAL output AudioUnit
    AudioComponentDescription desc{};
    desc.componentType = kAudioUnitType_Output;
    desc.componentSubType = kAudioUnitSubType_HALOutput;
    desc.componentManufacturer = kAudioUnitManufacturer_Apple;

    AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
    if (!comp) {
        error = "AudioUnit component not found";
        return false;
    }

    OSStatus status = AudioComponentInstanceNew(comp, &audioUnit_);
    if (status != noErr) {
        error = "Failed to create AudioUnit";
        return false;
    }

    // Set output device
    status = AudioUnitSetProperty(audioUnit_, kAudioOutputUnitProperty_CurrentDevice,
                                   kAudioUnitScope_Global, 0, &device, sizeof(device));
    if (status != noErr) {
        error = "Failed to set output device on AudioUnit";
        AudioComponentInstanceDispose(audioUnit_);
        audioUnit_ = nullptr;
        return false;
    }

    if (!selectOutputDataSource(device, deviceUid, error)) {
        AudioComponentInstanceDispose(audioUnit_);
        audioUnit_ = nullptr;
        activeDeviceId_ = kAudioObjectUnknown;
        return false;
    }

    // FIX: Query device's actual output format to get sample rate and channels
    AudioStreamBasicDescription deviceFmt{};
    UInt32 fmtSize = sizeof(deviceFmt);
    AudioUnitGetProperty(audioUnit_, kAudioUnitProperty_StreamFormat,
                          kAudioUnitScope_Output, 0, &deviceFmt, &fmtSize);

    // Query actual channel count from device stream configuration
    uint32_t deviceChannels = 2; // safe default
    AudioObjectPropertyAddress chanProp = {kAudioDevicePropertyStreamConfiguration,
                                            kAudioObjectPropertyScopeOutput,
                                            kAudioObjectPropertyElementMain};
    UInt32 chanSize = 0;
    if (AudioObjectGetPropertyDataSize(device, &chanProp, 0, nullptr, &chanSize) == noErr &&
        chanSize > 0) {
        std::vector<uint8_t> chanBuf(chanSize);
        auto* bufList = reinterpret_cast<AudioBufferList*>(chanBuf.data());
        if (AudioObjectGetPropertyData(device, &chanProp, 0, nullptr, &chanSize, bufList) == noErr) {
            uint32_t total = 0;
            for (UInt32 i = 0; i < bufList->mNumberBuffers; i++)
                total += bufList->mBuffers[i].mNumberChannels;
            if (total > 0 && total <= 8) deviceChannels = total;
        }
    }

    // FIX: Use 32-bit signed integer at device's native rate and channel count
    // This preserves full precision from 16-bit and 24-bit sources
    // (ExtAudioFile pads to 32-bit, no data loss)
    uint32_t channels = std::min(deviceChannels, 2u); // cap at stereo for now
    uint32_t bytesPerFrame = channels * 4; // 32-bit = 4 bytes per channel

    outputFormat_ = {};
    outputFormat_.mSampleRate = deviceFmt.mSampleRate;
    outputFormat_.mFormatID = kAudioFormatLinearPCM;
    outputFormat_.mFormatFlags =
        kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    outputFormat_.mBitsPerChannel = 32;
    outputFormat_.mChannelsPerFrame = channels;
    outputFormat_.mBytesPerFrame = bytesPerFrame;
    outputFormat_.mFramesPerPacket = 1;
    outputFormat_.mBytesPerPacket = bytesPerFrame;
    physicalOutputFormat_ = outputFormat_;
    virtualOutputFormat_ = outputFormat_;

    status = AudioUnitSetProperty(audioUnit_, kAudioUnitProperty_StreamFormat,
                                   kAudioUnitScope_Input, 0, &outputFormat_,
                                   sizeof(outputFormat_));
    if (status != noErr) {
        // Fallback: try 16-bit if 32-bit rejected
        outputFormat_.mBitsPerChannel = 16;
        bytesPerFrame = channels * 2;
        outputFormat_.mBytesPerFrame = bytesPerFrame;
        outputFormat_.mBytesPerPacket = bytesPerFrame;

        status = AudioUnitSetProperty(audioUnit_, kAudioUnitProperty_StreamFormat,
                                       kAudioUnitScope_Input, 0, &outputFormat_,
                                       sizeof(outputFormat_));
        if (status != noErr) {
            error = "Failed to set stream format on AudioUnit (error " +
                    std::to_string(status) + ")";
            AudioComponentInstanceDispose(audioUnit_);
            audioUnit_ = nullptr;
            return false;
        }
    }

    // Render callback
    AURenderCallbackStruct cb{sharedRenderCallback, this};
    status = AudioUnitSetProperty(audioUnit_, kAudioUnitProperty_SetRenderCallback,
                                   kAudioUnitScope_Input, 0, &cb, sizeof(cb));
    if (status != noErr) {
        error = "Failed to set render callback";
        AudioComponentInstanceDispose(audioUnit_);
        audioUnit_ = nullptr;
        return false;
    }

    status = AudioUnitInitialize(audioUnit_);
    if (status != noErr) {
        error = "Failed to initialize AudioUnit";
        AudioComponentInstanceDispose(audioUnit_);
        audioUnit_ = nullptr;
        return false;
    }

    // Shared mode is always signed integer (explicitly set above) — never float32.
    dsp_.setOutputFormat(false, outputFormat_.mSampleRate);

    status = AudioOutputUnitStart(audioUnit_);
    if (status != noErr) {
        error = "Failed to start AudioUnit";
        AudioUnitUninitialize(audioUnit_);
        AudioComponentInstanceDispose(audioUnit_);
        audioUnit_ = nullptr;
        return false;
    }

    mode_ = AudioMode::Shared;
    return true;
}

// ---------------------------------------------------------------------------
// Slot helpers + native current/next queue
// ---------------------------------------------------------------------------

int AudioEngine::getInactiveSlotIndex() const {
    const int active = activeSlotIndex_.load(std::memory_order_acquire);
    return active == 0 ? 1 : 0;
}

TrackSlot* AudioEngine::getActiveSlot() {
    const int active = activeSlotIndex_.load(std::memory_order_acquire);
    if (active < 0 || active >= static_cast<int>(trackSlots_.size())) return nullptr;
    return &trackSlots_[active];
}

const TrackSlot* AudioEngine::getActiveSlot() const {
    const int active = activeSlotIndex_.load(std::memory_order_acquire);
    if (active < 0 || active >= static_cast<int>(trackSlots_.size())) return nullptr;
    return &trackSlots_[active];
}

bool AudioEngine::canGaplesslyQueueSourceFormat(const AudioStreamBasicDescription& sourceFormat) const {
    if (mode_ != AudioMode::Exclusive) return true;
    return outputFormatCanRepresentSourcePcm(outputFormat_, sourceFormat);
}

void AudioEngine::stopDecodeThread(int slotIndex) {
    if (slotIndex < 0 || slotIndex >= static_cast<int>(trackSlots_.size())) return;
    auto& slot = trackSlots_[slotIndex];
    slot.stopDecode.store(true, std::memory_order_relaxed);
    if (slot.decodeThread.joinable()) slot.decodeThread.join();
}

void AudioEngine::resetTrackSlot(int slotIndex) {
    if (slotIndex < 0 || slotIndex >= static_cast<int>(trackSlots_.size())) return;
    auto& slot = trackSlots_[slotIndex];
    stopDecodeThread(slotIndex);
    if (slot.extAudioFile) {
        ExtAudioFileDispose(slot.extAudioFile);
        slot.extAudioFile = nullptr;
    }
    if (slot.dsd.file) {
        std::fclose(slot.dsd.file);
        slot.dsd.file = nullptr;
    }
    slot.framesRead.store(0, std::memory_order_relaxed);
    slot.framesPlayed.store(0, std::memory_order_relaxed);
    slot.totalFrames = 0;
    slot.fileSampleRate = 0;
    slot.fileEof.store(false, std::memory_order_relaxed);
    slot.prepared.store(false, std::memory_order_relaxed);
    slot.stopDecode.store(false, std::memory_order_relaxed);
    slot.filePath.clear();
    slot.ringBuffer.reset();
    slot.dsp.resetState();
    slot.renderFormat = {};
    slot.sourceKind = TrackSourceKind::None;
    slot.dsd = DsdPlaybackState{};
    slot.bypassDsp = false;
    slot.restoreSource = RestoreSourceClass::Unknown;
    slot.restoreCodec.clear();
    slot.floatPipeline = false;
    slot.sourceBits = 0;
    slot.sourceFloat = false;
    slot.decodeRate = 0;
    slot.rateConverted = false;
    slot.resampler.reset();
    slot.quantizer.reset();
    slot.ditherMode = DitherMode::None;
    slot.filterNx = false;
    slot.deemphasis = false;
    slot.deemphasisFilter.reset();
    slot.headroomGain = 1.0;
    slot.headroomDb = 0.0;
    slot.headroomAuto = false;
    slot.firResampler.reset();
    slot.dsdDecimator.reset();
    slot.dsdEncoder.reset();
    slot.dopOutput = false;
    slot.modulatorOverloads.store(0, std::memory_order_relaxed);
    slot.roomConvolver.reset();
    slot.convolutionTaps = 0;
    slot.convolutionTrim = 0;
    slot.convolutionTrimmed = 0;
    slot.convolutionInputFrames = 0;
    slot.convolutionScratch.clear();
    slot.convolutionError.clear();
    slot.clippedSamples.store(0, std::memory_order_relaxed);
    slot.peakLevel.store(0.0f, std::memory_order_relaxed);
}

void AudioEngine::cleanupRetiredSlot() {
    const int retired = retiredSlotIndex_.exchange(-1, std::memory_order_acq_rel);
    if (retired >= 0) {
        resetTrackSlot(retired);
    }
}

// Integer resolution of a decoded source; 0 when the decoder yields float
// (lossy codecs) or the depth is unknown.
static uint32_t sourceResolutionBits(const AudioStreamBasicDescription& format) {
    if (format.mFormatID == kAudioFormatLinearPCM) {
        return (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0 ? 0 : format.mBitsPerChannel;
    }
    if (format.mFormatID == kAudioFormatAppleLossless || format.mFormatID == kAudioFormatFLAC) {
        switch (format.mFormatFlags) {
            case kAppleLosslessFormatFlag_16BitSourceData: return 16;
            case kAppleLosslessFormatFlag_20BitSourceData: return 20;
            case kAppleLosslessFormatFlag_24BitSourceData: return 24;
            case kAppleLosslessFormatFlag_32BitSourceData: return 32;
            default: break;
        }
    }
    return 0;
}

void AudioEngine::setResamplerConfig(const ResamplerConfig& config) {
    std::lock_guard<std::mutex> lock(resamplerConfigMutex_);
    resamplerConfig_ = config;
}

ResamplerStatus AudioEngine::getResamplerStatus() const {
    ResamplerStatus status;
    const TrackSlot* slot = getActiveSlot();
    if (!slot) return status;
    // A room-correction file that failed to load is reported even on the bit-perfect path.
    status.convolutionError = slot->convolutionError;
    if (!slot->floatPipeline) return status;
    status.float64 = true;
    status.sourceBits = slot->sourceBits;
    status.sourceFloat = slot->sourceFloat;
    status.outputBits = slot->quantizer.gridBits();
    status.outputFloat = slot->quantizer.isFloat();
    status.resampling = slot->rateConverted;
    status.engine = !slot->rateConverted ? ""
        : slot->srcEngine == ResamplerEngine::Fir ? "fir"
        : slot->srcEngine == ResamplerEngine::Soxr ? "soxr" : "apple";
    status.firTaps = slot->firResampler ? slot->firResampler->taps() : 0;
    status.convolutionTaps = slot->convolutionTaps;
    if (slot->dsdEncoder) {
        status.dsdOutputRate = slot->dsdEncoder->dsdRate();
        status.modulator = slot->modulator == ModulatorType::Order5 ? "sdm5"
            : slot->modulator == ModulatorType::Order7 ? "sdm7" : "sdm7ec";
        status.modulatorOverloads = slot->modulatorOverloads.load(std::memory_order_relaxed);
    }
    status.convolutionError = slot->convolutionError;
    if (slot->dsdDecimator) {
        status.dsdSourceRate = slot->dsdDecimator->dsdRate();
        status.dsdStages = slot->dsdDecimator->stageCount();
        status.dsdFilterHz = slot->dsdDecimator->filterHz();
        status.dsdGainDb = slot->dsdDecimator->gainDb();
    }
    status.inputRate = slot->fileSampleRate;
    // With DSD output the PCM chain ends at the intermediate rate; the DoP carrier is not a PCM rate.
    status.outputRate = slot->dopOutput ? DsdEncoder::kIntermediateRate : slot->renderFormat.mSampleRate;
    status.ditherBits = slot->quantizer.ditherBits();
    switch (slot->quantizer.ditherActive() ? slot->ditherMode : DitherMode::None) {
        case DitherMode::Tpdf: status.dither = "tpdf"; break;
        case DitherMode::Gaussian: status.dither = "gauss"; break;
        case DitherMode::NoiseShaped: status.dither = "shaped"; break;
        case DitherMode::NoiseShaped5: status.dither = "shaped5"; break;
        case DitherMode::NoiseShaped9: status.dither = "shaped9"; break;
        default: status.dither = "none"; break;
    }
    status.filter = slot->filterNx ? "nx" : "1x";
    status.deemphasis = slot->deemphasis;
    status.headroomDb = slot->headroomDb;
    status.headroomAuto = slot->headroomAuto;
    const float peak = slot->peakLevel.load(std::memory_order_relaxed);
    status.peakDb = peak > 0.0f ? 20.0 * std::log10(static_cast<double>(peak)) : -200.0;
    status.clippedSamples = slot->clippedSamples.load(std::memory_order_relaxed);
    return status;
}

// Chooses how a PCM/compressed source reaches the output format:
//   - same rate, enough bits and no DSP → decode straight into the device format (bit-perfect);
//   - otherwise → float64 decode, SoX / FIR / Apple resampling, DSP, dithered quantization.
bool AudioEngine::configureDecodePipeline(TrackSlot& slot, const AudioStreamBasicDescription& sourceFormat,
                                          bool deemphasis, uint32_t dsdOutputRate, std::string& error) {
    ResamplerConfig config;
    {
        std::lock_guard<std::mutex> lock(resamplerConfigMutex_);
        config = resamplerConfig_;
    }

    const bool outputIsFloat = (outputFormat_.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    const uint32_t physicalBits = (physicalOutputFormat_.mFormatFlags & kAudioFormatFlagIsFloat) == 0
        ? physicalOutputFormat_.mBitsPerChannel
        : 0;
    const uint32_t containerBits = outputFormat_.mChannelsPerFrame > 0
        ? (outputFormat_.mBytesPerFrame / outputFormat_.mChannelsPerFrame) * 8
        : 32;
    const uint32_t validBits = outputFormat_.mBitsPerChannel > 0
        ? std::min<uint32_t>(outputFormat_.mBitsPerChannel, containerBits)
        : containerBits;
    const uint32_t outputBits = physicalBits >= 16 ? std::min(validBits, physicalBits) : validBits;
    const uint32_t sourceBits = sourceResolutionBits(sourceFormat);
    const uint32_t channels = std::max<uint32_t>(1, outputFormat_.mChannelsPerFrame);
    const double sourceRate = sourceFormat.mSampleRate;
    // PCM → DSD: everything before the modulator runs at the intermediate rate.
    const bool dsdOutput = dsdOutputRate > 0;
    const double outputRate = dsdOutput ? DsdEncoder::kIntermediateRate : outputFormat_.mSampleRate;

    const bool rateDiffers = std::abs(outputRate - sourceRate) > 1.0;
    const bool reducesBits = !outputIsFloat && (sourceBits == 0 ? outputBits < 32 : sourceBits > outputBits);

    // Room correction at the output rate (impulse resampled to it when needed).
    std::vector<std::shared_ptr<const KernelSpectrum>> roomSpectra;
    size_t roomPeak = 0;
    ImpulseResponseInfo roomInfo;
    slot.convolutionError.clear();
    if (!config.convolutionPath.empty()) {
        std::string convolutionError;
        if (!loadImpulseResponse(config.convolutionPath, outputRate, config.convolutionGainDb, roomSpectra,
                                 roomPeak, roomInfo, convolutionError)) {
            // A broken filter file must not stop playback: play without it and report why.
            fprintf(stderr, "[Puros] Room correction disabled: %s\n", convolutionError.c_str());
            slot.convolutionError = convolutionError;
            roomSpectra.clear();
        }
    }
    const bool convolution = !roomSpectra.empty();

    // Like Roon: any processing widens the samples to 64-bit float and requantizes at the end.
    // A DSD source is decoded straight into that chain.
    const bool dsdSource = slot.dsdDecimator != nullptr;
    const bool dsp = dsp_.isProcessing();
    // Restoration engaged for this source (Auto: confirmed lossy only) needs the float path;
    // a bypassed source keeps whatever path it would have had, bit-perfect included.
    const bool restore = dsp_.restoreWouldEngage(slot.restoreSource);
    slot.floatPipeline = dsdSource || dsdOutput || rateDiffers || reducesBits || deemphasis || convolution || dsp || restore;
    const bool sourceIsFloatPcm = sourceFormat.mFormatID == kAudioFormatLinearPCM &&
                                  (sourceFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    const bool sourceIsLossless = sourceFormat.mFormatID == kAudioFormatLinearPCM ||
                                  sourceFormat.mFormatID == kAudioFormatAppleLossless ||
                                  sourceFormat.mFormatID == kAudioFormatFLAC;
    slot.sourceFloat = sourceIsFloatPcm || !sourceIsLossless;
    slot.sourceBits = sourceIsFloatPcm ? sourceFormat.mBitsPerChannel
        : slot.sourceFloat ? 32
        : sourceBits;
    slot.rateConverted = rateDiffers;
    slot.ditherMode = config.dither;
    slot.deemphasis = deemphasis;
    slot.filterNx = ResamplerConfig::isHiRes(sourceRate);
    // DSD output keeps at least 3 dB: PCM full scale is already 50 % modulation, and
    // inter-sample overs of loud masters (+2 dB is common) would overload the loop.
    constexpr double kMinDsdHeadroomDb = 3.0;
    // Auto: 3 dB whenever the waveform is rebuilt (rate conversion, room correction, DSD
    // decimation — filtered 1-bit streams overshoot full scale too), which is where
    // inter-sample overs appear; requantization and de-emphasis add none.
    // Puros Restore too: lossy decodes of loud masters already overshoot full scale
    // (the plain decode path passes those overs on, the float path would clip them),
    // and the rebuilt top end needs room of its own.
    constexpr double kAutoHeadroomDb = 3.0;
    const double requestedHeadroomDb = !config.headroomAuto ? config.headroomDb
        : rateDiffers || convolution || restore || dsdSource ? kAutoHeadroomDb
        : 0.0;
    slot.headroomAuto = config.headroomAuto;
    slot.headroomDb = !slot.floatPipeline ? 0.0
        : dsdOutput ? std::clamp(std::max(requestedHeadroomDb, kMinDsdHeadroomDb), 0.0, 12.0)
        : std::clamp(requestedHeadroomDb, 0.0, 12.0);
    slot.headroomGain = std::pow(10.0, -slot.headroomDb / 20.0);

    if (!slot.floatPipeline) {
        const OSStatus status = ExtAudioFileSetProperty(slot.extAudioFile, kExtAudioFileProperty_ClientDataFormat,
                                                        sizeof(outputFormat_), &outputFormat_);
        if (status != noErr) {
            error = "Failed to set decode format (error " + std::to_string(status) + ")";
            return false;
        }
        return true;
    }

    // FIR for integer ratios when selected; SoX for everything else it covers; Apple on request
    // (it is ExtAudioFile's converter, so a DSD source uses SoX instead).
    const bool useFir = rateDiffers && config.engine == ResamplerEngine::Fir &&
                        FirResampler::supportsRatio(sourceRate, outputRate);
    const bool useSoxr = rateDiffers && !useFir && (config.engine != ResamplerEngine::Apple || dsdSource);
    slot.srcEngine = useFir ? ResamplerEngine::Fir : useSoxr ? ResamplerEngine::Soxr : ResamplerEngine::Apple;
    slot.decodeRate = useFir || useSoxr ? sourceRate : outputRate;

    // Decode straight to float64: the whole processing chain runs in double precision.
    // (The DSD decimator produces float64 itself.)
    if (!dsdSource) {
        AudioStreamBasicDescription client{};
        client.mSampleRate = slot.decodeRate;
        client.mFormatID = kAudioFormatLinearPCM;
        client.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
        client.mBitsPerChannel = 64;
        client.mChannelsPerFrame = channels;
        client.mBytesPerFrame = channels * 8;
        client.mFramesPerPacket = 1;
        client.mBytesPerPacket = client.mBytesPerFrame;
        OSStatus status = ExtAudioFileSetProperty(slot.extAudioFile, kExtAudioFileProperty_ClientDataFormat,
                                                  sizeof(client), &client);
        if (status != noErr) {
            error = "Failed to set float decode format (error " + std::to_string(status) + ")";
            return false;
        }

        if (rateDiffers && slot.srcEngine == ResamplerEngine::Apple) {
            // Apple resampler: tune the converter ExtAudioFile created for the client format.
            AudioConverterRef converter = nullptr;
            UInt32 size = sizeof(converter);
            if (ExtAudioFileGetProperty(slot.extAudioFile, kExtAudioFileProperty_AudioConverter, &size, &converter) == noErr &&
                converter) {
                UInt32 complexity = config.appleComplexity;
                UInt32 quality = std::min<uint32_t>(config.appleQuality, kAudioConverterQuality_Max);
                AudioConverterSetProperty(converter, kAudioConverterSampleRateConverterComplexity, sizeof(complexity), &complexity);
                AudioConverterSetProperty(converter, kAudioConverterSampleRateConverterQuality, sizeof(quality), &quality);
                CFArrayRef noConfig = nullptr;
                ExtAudioFileSetProperty(slot.extAudioFile, kExtAudioFileProperty_ConverterConfig, sizeof(noConfig), &noConfig);
            }
        }
    }

    if (useSoxr) {
        slot.resampler = std::make_unique<SoxrResampler>();
        if (!slot.resampler->configure(config.filterFor(sourceRate), sourceRate, outputRate, channels, error)) {
            slot.resampler.reset();
            return false;
        }
    }
    if (useFir) {
        slot.firResampler = std::make_unique<FirResampler>();
        if (!slot.firResampler->configure(config.firFor(sourceRate), sourceRate, outputRate, channels, error)) {
            slot.firResampler.reset();
            return false;
        }
    }
    if (convolution) {
        slot.roomConvolver = std::make_unique<FftConvolver>();
        if (!slot.roomConvolver->configure(roomSpectra, channels, error)) {
            slot.roomConvolver.reset();
            return false;
        }
        slot.convolutionTaps = slot.roomConvolver->kernelLength();
        // Delay compensation: drop the samples before the filter's main peak.
        slot.convolutionTrim = config.convolutionCompensateDelay ? roomPeak : 0;
    }

    // De-emphasis runs on the decoded signal, before any rate change.
    if (deemphasis) slot.deemphasisFilter.configure(slot.decodeRate, channels);
    if (dsdOutput) {
        // The delta-sigma modulator replaces requantization.
        slot.dsdEncoder = std::make_unique<DsdEncoder>();
        if (!slot.dsdEncoder->configure(dsdOutputRate, config.modulator, channels, error)) {
            slot.dsdEncoder.reset();
            return false;
        }
        slot.dopOutput = true;
        slot.modulator = config.modulator;
        return true;
    }
    slot.quantizer.configure(outputFormat_, physicalBits, config.dither);
    return true;
}

// Room-correction convolution of `pcm` (interleaved, output rate), in place;
// `atEnd` also drains the filter so the track keeps its exact length.
void AudioEngine::applyRoomCorrection(TrackSlot& slot, std::vector<double>& pcm, uint32_t channels, bool atEnd) {
    if (!slot.roomConvolver) return;
    const size_t frames = pcm.size() / channels;
    slot.convolutionInputFrames += frames;
    auto& convolved = slot.convolutionScratch;
    convolved.clear();
    if (frames > 0) slot.roomConvolver->process(pcm.data(), frames, convolved);
    if (atEnd) slot.roomConvolver->flushTo(slot.convolutionTrim + slot.convolutionInputFrames, convolved);
    const size_t produced = convolved.size() / channels;
    const size_t skip = std::min(produced, slot.convolutionTrim - std::min(slot.convolutionTrim, slot.convolutionTrimmed));
    slot.convolutionTrimmed += skip;
    pcm.assign(convolved.begin() + static_cast<ptrdiff_t>(skip * channels), convolved.end());
}

// Makes the output carry DoP at dsdRate / 16 for a PCM → DSD slot: reopens the
// device at the carrier when allowed, activates DSD output mode for the active
// slot, and requires an already-DoP output for a queued (gapless) slot.
bool AudioEngine::prepareDopOutput(int slotIndex, uint32_t dsdRate, bool allowDeviceReopen,
                                   AudioStreamBasicDescription& dopFormatOut, std::string& error) {
    if (mode_ != AudioMode::Exclusive) {
        error = "DSD output requires exclusive mode";
        return false;
    }
    const uint32_t carrier = dopCarrierRateForDsd(dsdRate);
    const AudioStreamBasicDescription requested = buildDoPASBD(static_cast<double>(dsdRate));
    if (requested.mFormatID == 0) {
        error = "Unsupported DSD output rate";
        return false;
    }
    std::string reason;
    if (!outputFormatCanCarryDoP(physicalOutputFormat_, carrier, &reason)) {
        if (!allowDeviceReopen) {
            error = "Queued DSD track requires device reopen";
            return false;
        }
        const int activeBefore = activeSlotIndex_.load(std::memory_order_acquire);
        const int queuedBefore = queuedSlotIndex_.load(std::memory_order_acquire);
        const int retiredBefore = retiredSlotIndex_.load(std::memory_order_acquire);
        const std::string uid = activeDeviceUid_;
        if (!openExclusive(uid, static_cast<double>(carrier), 32, true, error)) return false;
        activeSlotIndex_.store(activeBefore >= 0 ? activeBefore : slotIndex, std::memory_order_release);
        queuedSlotIndex_.store(queuedBefore, std::memory_order_release);
        retiredSlotIndex_.store(retiredBefore, std::memory_order_release);
        if (!outputFormatCanCarryDoP(physicalOutputFormat_, carrier, &reason)) {
            error = reason;
            return false;
        }
    }

    if (slotIndex == activeSlotIndex_.load(std::memory_order_acquire)) {
        const AudioStreamBasicDescription* dopFormat =
            selectDoPCarrierFormat(physicalOutputFormat_, virtualOutputFormat_, carrier, &reason);
        if (!dopFormat) {
            if (!activateDsdOutputMode(requested, error)) return false;
            dopFormat = selectDoPCarrierFormat(physicalOutputFormat_, virtualOutputFormat_, carrier, &reason);
            if (!dopFormat) {
                error = reason;
                return false;
            }
        }
        dopFormatOut = *dopFormat;
        return true;
    }

    const TrackSlot* active = getActiveSlot();
    if (!active || !(active->dopOutput || active->sourceKind == TrackSourceKind::DsdDoP) ||
        static_cast<uint32_t>(active->renderFormat.mSampleRate) != carrier ||
        !outputFormatCanCarryDoP(virtualOutputFormat_, carrier, &reason)) {
        error = "Queued DSD track requires device reopen";
        return false;
    }
    dopFormatOut = requested;
    return true;
}

bool AudioEngine::prepareTrackSlot(int slotIndex, const std::string& filePath, std::string& error,
                                   bool allowDeviceReopen, bool allowResample, bool deemphasis,
                                   uint32_t dsdOutputRate, RestoreSourceClass sourceHint,
                                   const DsdPcmOptions& dsdPcm) {
    resetTrackSlot(slotIndex);
    auto& slot = trackSlots_[slotIndex];

    // A DSD file goes out as DoP unless it is to be heard as PCM: requested, remodulated
    // (PCM → DSD), or in shared mode where the mixer only takes PCM.
    const bool dsdFile = !isRemoteAudioUrl(filePath) && isDsdFilePath(filePath);
    const bool decodeDsd = dsdFile && (dsdPcm.sampleRate > 0 || dsdOutputRate > 0 || mode_ != AudioMode::Exclusive);

    if (dsdFile && !decodeDsd) {
        if (!openDsdSourceFile(filePath, slot, error)) {
            return false;
        }

        if (slot.dsd.carrierSampleRate == 0) {
            error = "Unsupported DSD sample rate";
            resetTrackSlot(slotIndex);
            return false;
        }

        const AudioStreamBasicDescription requestedDoPFormat =
            buildDoPASBD(static_cast<double>(slot.dsd.sourceSampleRate));
        if (requestedDoPFormat.mFormatID == 0) {
            error = "Unsupported DSD sample rate";
            resetTrackSlot(slotIndex);
            return false;
        }

        const bool isActiveSlot = slotIndex == activeSlotIndex_.load(std::memory_order_acquire);
        std::string dopReason;
        if (!outputFormatCanCarryDoP(physicalOutputFormat_, slot.dsd.carrierSampleRate, &dopReason)) {
            if (!allowDeviceReopen) {
                error = "Queued DSD track requires device reopen";
                resetTrackSlot(slotIndex);
                return false;
            }

            const int activeBefore = activeSlotIndex_.load(std::memory_order_acquire);
            const int queuedBefore = queuedSlotIndex_.load(std::memory_order_acquire);
            const int retiredBefore = retiredSlotIndex_.load(std::memory_order_acquire);
            const std::string uid = activeDeviceUid_;
            const double carrierRate = static_cast<double>(slot.dsd.carrierSampleRate);

            resetTrackSlot(slotIndex);

            if (!openExclusive(uid, carrierRate, 32, true, error)) {
                return false;
            }

            activeSlotIndex_.store(activeBefore >= 0 ? activeBefore : slotIndex, std::memory_order_release);
            queuedSlotIndex_.store(queuedBefore, std::memory_order_release);
            retiredSlotIndex_.store(retiredBefore, std::memory_order_release);

            if (!openDsdSourceFile(filePath, slot, error)) {
                return false;
            }

            if (!outputFormatCanCarryDoP(physicalOutputFormat_, slot.dsd.carrierSampleRate, &dopReason)) {
                error = dopReason;
                resetTrackSlot(slotIndex);
                return false;
            }
        }

        const AudioStreamBasicDescription* dopFormat = nullptr;
        if (isActiveSlot) {
            dopFormat =
                selectDoPCarrierFormat(physicalOutputFormat_, virtualOutputFormat_, slot.dsd.carrierSampleRate, &dopReason);
            if (!dopFormat) {
                if (!activateDsdOutputMode(requestedDoPFormat, error)) {
                    resetTrackSlot(slotIndex);
                    return false;
                }
                dopFormat =
                    selectDoPCarrierFormat(physicalOutputFormat_, virtualOutputFormat_, slot.dsd.carrierSampleRate, &dopReason);
                if (!dopFormat) {
                    error = dopReason;
                    resetTrackSlot(slotIndex);
                    return false;
                }
            }
        } else {
            const TrackSlot* activeSlot = getActiveSlot();
            if (!activeSlot || activeSlot->sourceKind != TrackSourceKind::DsdDoP ||
                !outputFormatCanCarryDoP(virtualOutputFormat_, slot.dsd.carrierSampleRate, &dopReason)) {
                error = "Queued DSD track requires device reopen";
                resetTrackSlot(slotIndex);
                return false;
            }
            dopFormat = &requestedDoPFormat;
        }

        slot.renderFormat = *dopFormat;
        const size_t bufBytes =
            static_cast<size_t>(slot.renderFormat.mSampleRate * 2.0) * slot.renderFormat.mBytesPerFrame;
        slot.ringBuffer = std::make_unique<RingBuffer>(bufBytes);
        slot.stopDecode.store(false, std::memory_order_relaxed);
        slot.fileEof.store(false, std::memory_order_relaxed);
        slot.framesRead.store(0, std::memory_order_relaxed);
        slot.framesPlayed.store(0, std::memory_order_relaxed);
        slot.filePath = filePath;
        slot.fileSampleRate = static_cast<double>(slot.dsd.carrierSampleRate);
        slot.totalFrames = static_cast<int64_t>(slot.dsd.totalDoPFrames);
        slot.sourceKind = TrackSourceKind::DsdDoP;
        slot.bypassDsp = true;
        dsp_.copyConfigTo(slot.dsp);
        // Native DSD is never restored, in any mode.
        slot.restoreSource = RestoreSourceClass::Dsd;
        slot.restoreCodec = "DSD";
        slot.dsp.prepareRestoreStage(false, RestorePosition::Source, slot.renderFormat.mSampleRate,
                                     slot.renderFormat.mChannelsPerFrame, RestoreSourceClass::Dsd);

        if (slotIndex == activeSlotIndex_.load(std::memory_order_acquire)) {
            fprintf(stderr,
                "[Puros] === Playback Start ===\n"
                "  File:       DSD %.0f Hz / %u ch\n"
                "  Pipeline:   %.0f Hz / %u bit / %u ch / %u Bpf (flags: 0x%X)\n"
                "  Mode:       %s\n"
                "  Duration:   %.1f sec (%lld DoP frames @ carrier rate)\n"
                "  ==========================\n",
                static_cast<double>(slot.dsd.sourceSampleRate),
                slot.dsd.channels,
                slot.renderFormat.mSampleRate, slot.renderFormat.mBitsPerChannel,
                slot.renderFormat.mChannelsPerFrame, slot.renderFormat.mBytesPerFrame,
                static_cast<unsigned>(slot.renderFormat.mFormatFlags),
                mode_ == AudioMode::Exclusive ? "EXCLUSIVE" : "SHARED",
                (slot.fileSampleRate > 0 ? static_cast<double>(slot.totalFrames) / slot.fileSampleRate : 0.0),
                static_cast<long long>(slot.totalFrames));
        }

        slot.decodeThread = std::thread(&AudioEngine::decodeThreadFunc, this, slotIndex);
        slot.prepared.store(true, std::memory_order_release);
        return true;
    }

    // PCM → DSD: the output must carry DoP at dsdOutputRate / 16 before the file is opened.
    AudioStreamBasicDescription dopRenderFormat{};
    if (dsdOutputRate > 0) {
        if (!prepareDopOutput(slotIndex, dsdOutputRate, allowDeviceReopen, dopRenderFormat, error)) return false;
    } else if (slotIndex == activeSlotIndex_.load(std::memory_order_acquire)) {
        deactivateDsdOutputMode();
    }

    // Opens the file and describes what the decode path will read from it. A DSD source
    // reads as 32-bit float stereo PCM at the decimator's rate (as a converted file would).
    AudioStreamBasicDescription sourceFormat{};
    const auto openSource = [&]() -> bool {
        if (decodeDsd) {
            if (!openDsdSourceFile(filePath, slot, error)) return false;
            const uint32_t pcmRate = DsdDecimator::decodeRate(
                slot.dsd.sourceSampleRate, dsdPcm.sampleRate > 0 ? dsdPcm.sampleRate : 176400);
            slot.dsdDecimator = std::make_unique<DsdDecimator>();
            if (pcmRate == 0 ||
                !slot.dsdDecimator->configure(slot.dsd.sourceSampleRate, pcmRate, dsdPcm.filterHz, dsdPcm.gainDb, 2, error)) {
                if (error.empty()) error = "Unsupported DSD sample rate";
                return false;
            }
            sourceFormat = {};
            sourceFormat.mSampleRate = pcmRate;
            sourceFormat.mFormatID = kAudioFormatLinearPCM;
            sourceFormat.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
            sourceFormat.mBitsPerChannel = 32;
            sourceFormat.mChannelsPerFrame = 2;
            sourceFormat.mBytesPerFrame = 8;
            sourceFormat.mFramesPerPacket = 1;
            sourceFormat.mBytesPerPacket = 8;
            slot.fileSampleRate = pcmRate;
            slot.totalFrames = static_cast<int64_t>(slot.dsd.totalSamplesPerChannel / slot.dsdDecimator->ratio());
            return true;
        }

        CFURLRef fileUrl = createAudioSourceUrl(filePath);
        if (!fileUrl) {
            error = isRemoteAudioUrl(filePath) ? "Invalid stream URL" : "Invalid file path";
            return false;
        }
        const OSStatus status = ExtAudioFileOpenURL(fileUrl, &slot.extAudioFile);
        CFRelease(fileUrl);
        if (status != noErr) {
            error = "Failed to open audio file (error " + std::to_string(status) + ")";
            return false;
        }

        UInt32 size = sizeof(sourceFormat);
        ExtAudioFileGetProperty(slot.extAudioFile, kExtAudioFileProperty_FileDataFormat, &size, &sourceFormat);
        slot.fileSampleRate = sourceFormat.mSampleRate;
        SInt64 frames = 0;
        size = sizeof(frames);
        ExtAudioFileGetProperty(slot.extAudioFile, kExtAudioFileProperty_FileLengthFrames, &size, &frames);
        slot.totalFrames = frames;
        return true;
    };
    const auto closeSource = [&]() {
        if (slot.extAudioFile) {
            ExtAudioFileDispose(slot.extAudioFile);
            slot.extAudioFile = nullptr;
        }
        if (slot.dsd.file) {
            std::fclose(slot.dsd.file);
            slot.dsd.file = nullptr;
        }
        slot.dsdDecimator.reset();
    };

    if (!openSource()) {
        closeSource();
        return false;
    }

    if (allowDeviceReopen && !allowResample && dsdOutputRate == 0 && mode_ == AudioMode::Exclusive) {
        const bool needReopen = !outputFormatCanRepresentSourcePcm(outputFormat_, sourceFormat);

        if (needReopen) {
            std::string uid = activeDeviceUid_;
            uint32_t depth = sourceFormat.mBitsPerChannel > 0 ? sourceFormat.mBitsPerChannel : 16;
            double targetRate = sourceFormat.mSampleRate;
            const double previousRate = outputFormat_.mSampleRate;
            const uint32_t previousDepth = outputFormat_.mBitsPerChannel > 0 ? outputFormat_.mBitsPerChannel : 16;
            const int activeBefore = activeSlotIndex_.load(std::memory_order_acquire);
            const int queuedBefore = queuedSlotIndex_.load(std::memory_order_acquire);

            // openExclusive() changes the format in place while the device stays hogged.
            closeSource();

            bool opened = openExclusive(uid, targetRate, depth, false, error);
            if (!opened) {
                AudioStreamBasicDescription bestFmt{};
                AudioDeviceID fallbackDev = findDeviceByUid(uid);
                if (fallbackDev != kAudioObjectUnknown && findBestFormat(fallbackDev, targetRate, depth, false, bestFmt)) {
                    error.clear();
                    opened = openExclusive(uid, bestFmt.mSampleRate, bestFmt.mBitsPerChannel, false, error);
                }
            }
            // The device cannot run at the source rate: stay where it was and resample.
            if (!opened && previousRate > 0) {
                error.clear();
                opened = openExclusive(uid, previousRate, previousDepth, false, error);
            }

            if (!opened) return false;
            // openExclusive() closed everything; this slot is still the one being prepared.
            activeSlotIndex_.store(activeBefore >= 0 ? activeBefore : slotIndex, std::memory_order_release);
            queuedSlotIndex_.store(queuedBefore, std::memory_order_release);

            if (!openSource()) {
                closeSource();
                return false;
            }
        }
    } else if (!allowDeviceReopen && dsdOutputRate == 0 &&
               ((getActiveSlot() && (getActiveSlot()->sourceKind == TrackSourceKind::DsdDoP || getActiveSlot()->dopOutput)) ||
                (!allowResample && !canGaplesslyQueueSourceFormat(sourceFormat)))) {
        error = "Queued track requires device reopen";
        closeSource();
        return false;
    }

    // Puros Restore decides from the decoder's actual codec, not the file name.
    if (decodeDsd) {
        slot.restoreSource = RestoreSourceClass::Dsd;
        slot.restoreCodec = "DSD";
    } else {
        slot.restoreSource = classifyRestoreSource(sourceFormat.mFormatID, sourceHint, slot.restoreCodec);
    }

    if (!configureDecodePipeline(slot, sourceFormat, deemphasis, dsdOutputRate, error)) {
        closeSource();
        slot.resampler.reset();
        return false;
    }

    slot.renderFormat = dsdOutputRate > 0 ? dopRenderFormat : outputFormat_;
    const double bufferSeconds = isRemoteAudioUrl(filePath) ? 6.0 : 2.0;
    const size_t bufBytes =
        static_cast<size_t>(slot.renderFormat.mSampleRate * bufferSeconds) * slot.renderFormat.mBytesPerFrame;
    slot.ringBuffer = std::make_unique<RingBuffer>(bufBytes);
    slot.stopDecode.store(false, std::memory_order_relaxed);
    slot.fileEof.store(false, std::memory_order_relaxed);
    slot.framesRead.store(0, std::memory_order_relaxed);
    slot.framesPlayed.store(0, std::memory_order_relaxed);
    slot.filePath = filePath;
    slot.sourceKind = decodeDsd ? TrackSourceKind::DsdPcm : TrackSourceKind::ExtAudioFile;
    slot.bypassDsp = false;
    dsp_.copyConfigTo(slot.dsp);
    // DSP runs on the intermediate PCM before modulation.
    if (slot.dopOutput) slot.dsp.setSampleRate(DsdEncoder::kIntermediateRate);
    {
        // Restore runs on the decoded signal (before resampling) or after the DSP chain;
        // without the float path only in place, where source and output rate are equal.
        const RestorePosition position = dsp_.restoreConfig().position;
        const double dspRate = slot.dopOutput ? DsdEncoder::kIntermediateRate : outputFormat_.mSampleRate;
        const double stageRate = !slot.floatPipeline ? outputFormat_.mSampleRate
            : position == RestorePosition::Source ? slot.decodeRate
            : dspRate;
        slot.dsp.prepareRestoreStage(slot.floatPipeline, position, stageRate, outputFormat_.mChannelsPerFrame,
                                     slot.restoreSource);
    }

    if (slotIndex == activeSlotIndex_.load(std::memory_order_acquire)) {
        fprintf(stderr,
            "[Puros] === Playback Start ===\n"
            "  File:       %.0f Hz / %u bit / %u ch (formatID: %u)\n"
            "  Pipeline:   %.0f Hz / %u bit / %u ch / %u Bpf (flags: 0x%X)\n"
            "  Mode:       %s\n"
            "  Duration:   %.1f sec (%lld frames @ file rate)\n"
            "  ==========================\n",
            sourceFormat.mSampleRate, sourceFormat.mBitsPerChannel, sourceFormat.mChannelsPerFrame,
            (unsigned)sourceFormat.mFormatID,
            outputFormat_.mSampleRate, outputFormat_.mBitsPerChannel,
            outputFormat_.mChannelsPerFrame, outputFormat_.mBytesPerFrame,
            (unsigned)outputFormat_.mFormatFlags,
            mode_ == AudioMode::Exclusive ? "EXCLUSIVE" : "SHARED",
            (slot.fileSampleRate > 0 ? (double)slot.totalFrames / slot.fileSampleRate : 0.0),
            (long long)slot.totalFrames);
        if (slot.dsdDecimator) {
            fprintf(stderr, "  DSD:        %.4f MHz 1-bit -> %u Hz, %u stages, filter %s, gain %+.0f dB\n",
                    slot.dsd.sourceSampleRate / 1e6, slot.dsdDecimator->pcmRate(), slot.dsdDecimator->stageCount(),
                    slot.dsdDecimator->filterHz() > 0 ? (std::to_string(static_cast<int>(slot.dsdDecimator->filterHz())) + " Hz").c_str() : "off",
                    slot.dsdDecimator->gainDb());
        }
        if (slot.floatPipeline) {
            fprintf(stderr, "  Resampler:  %s %.0f -> %.0f Hz, dither %s%s\n",
                    !slot.rateConverted ? "none"
                        : slot.srcEngine == ResamplerEngine::Fir ? "FIR"
                        : slot.srcEngine == ResamplerEngine::Soxr ? "SoX" : "Apple",
                    sourceFormat.mSampleRate, outputFormat_.mSampleRate,
                    slot.quantizer.ditherActive()
                        ? (slot.ditherMode == DitherMode::Gaussian ? "Gaussian @ "
                           : slot.ditherMode == DitherMode::Tpdf ? "TPDF @ " : "shaped TPDF @ ")
                        : "off",
                    slot.quantizer.ditherActive() ? (std::to_string(slot.quantizer.ditherBits()) + " bit").c_str() : "");
        }
        const RestoreStatus restore = slot.dsp.restoreStatus();
        fprintf(stderr, "  Restore:    %s (%s source, codec %s)\n",
                restore.inChain ? "active" : restore.config.mode == RestoreMode::Off ? "off" : "bypassed",
                slot.restoreSource == RestoreSourceClass::Lossy ? "lossy"
                    : slot.restoreSource == RestoreSourceClass::Lossless ? "lossless"
                    : slot.restoreSource == RestoreSourceClass::Dsd ? "DSD" : "unknown",
                slot.restoreCodec.c_str());
    }

    slot.decodeThread = std::thread(&AudioEngine::decodeThreadFunc, this, slotIndex);
    slot.prepared.store(true, std::memory_order_release);
    return true;
}

void AudioEngine::decodeThreadFunc(int slotIndex) {
    auto& slot = trackSlots_[slotIndex];
    const auto& renderFormat =
        slot.renderFormat.mBytesPerFrame > 0 ? slot.renderFormat : outputFormat_;
    const UInt32 framesPerRead = 4096;
    const size_t bytesPerFrame = renderFormat.mBytesPerFrame;
    if (bytesPerFrame == 0) {
        slot.fileEof.store(true, std::memory_order_relaxed);
        return;
    }

    std::vector<uint8_t> buffer(framesPerRead * bytesPerFrame);
    std::vector<double> decodeIn;
    std::vector<double> converted;
    std::vector<uint8_t> dsdLeft, dsdRight;
    std::vector<double> dsdPcm;
    // Room for a block plus the Restore tail (≤ 16384 frames) so the stage never reallocates.
    decodeIn.reserve(static_cast<size_t>(framesPerRead + 16384) * std::max<uint32_t>(1, renderFormat.mChannelsPerFrame));
    auto lastDecodeSample = std::chrono::steady_clock::now();
    AudioBufferList bufList;
    bufList.mNumberBuffers = 1;
    bufList.mBuffers[0].mNumberChannels = renderFormat.mChannelsPerFrame;

    while (!slot.stopDecode.load(std::memory_order_relaxed)) {
        if (paused_.load(std::memory_order_relaxed)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }
        size_t bytesToWrite = 0;
        UInt32 numFrames = 0;
        bool endAfterWrite = false;

        if (slot.sourceKind == TrackSourceKind::DsdDoP) {
            if (!slot.dsd.file || !slot.ringBuffer) {
                slot.fileEof.store(true, std::memory_order_relaxed);
                break;
            }

            const size_t packedFrames = packDopFrames(slot, renderFormat, buffer.data(), framesPerRead);
            if (packedFrames == 0) {
                slot.fileEof.store(true, std::memory_order_relaxed);
                break;
            }

            numFrames = static_cast<UInt32>(packedFrames);
            bytesToWrite = packedFrames * bytesPerFrame;
        } else if (slot.floatPipeline) {
            if ((!slot.extAudioFile && !slot.dsdDecimator) || !slot.ringBuffer) {
                slot.fileEof.store(true, std::memory_order_relaxed);
                break;
            }

            const uint32_t channels = std::max<uint32_t>(1, renderFormat.mChannelsPerFrame);
            UInt32 readFrames = 0;
            if (slot.dsdDecimator) {
                // DSD → PCM: about one block of PCM frames' worth of bytes; drained at the end.
                const size_t bytesPerRead = static_cast<size_t>(framesPerRead) * slot.dsdDecimator->ratio() / 8;
                dsdLeft.resize(bytesPerRead);
                dsdRight.resize(bytesPerRead);
                const size_t bytes = readDsdBytes(slot, bytesPerRead, dsdLeft.data(), dsdRight.data());
                const uint8_t* channelBytes[2] = {dsdLeft.data(), dsdRight.data()};
                dsdPcm.clear();
                slot.dsdDecimator->process(channelBytes, bytes, dsdPcm);
                endAfterWrite = bytes == 0;
                if (endAfterWrite) slot.dsdDecimator->flush(dsdPcm);
                readFrames = static_cast<UInt32>(dsdPcm.size() / 2);
                decodeIn.resize(static_cast<size_t>(readFrames) * channels);
                for (size_t f = 0; f < readFrames; ++f) {
                    const double l = dsdPcm[f * 2], r = dsdPcm[f * 2 + 1];
                    double* frame = decodeIn.data() + f * channels;
                    if (channels == 1) {
                        frame[0] = 0.5 * (l + r);
                        continue;
                    }
                    frame[0] = l;
                    frame[1] = r;
                    for (uint32_t ch = 2; ch < channels; ++ch) frame[ch] = 0.0;
                }
            } else {
                decodeIn.resize(static_cast<size_t>(framesPerRead) * channels);
                AudioBufferList decodeList;
                decodeList.mNumberBuffers = 1;
                decodeList.mBuffers[0].mNumberChannels = channels;
                decodeList.mBuffers[0].mDataByteSize = static_cast<UInt32>(decodeIn.size() * sizeof(double));
                decodeList.mBuffers[0].mData = decodeIn.data();

                readFrames = framesPerRead;
                const OSStatus status = ExtAudioFileRead(slot.extAudioFile, &readFrames, &decodeList);
                endAfterWrite = status != noErr || readFrames == 0;
                if (endAfterWrite) readFrames = 0;
                decodeIn.resize(static_cast<size_t>(readFrames) * channels);
            }

            if (readFrames > 0 && slot.deemphasis) slot.deemphasisFilter.process(decodeIn.data(), readFrames);
            // Headroom first (everything up to the DSP chain is linear, so the place does not
            // change the result): Restore's over-protection then works against the real ceiling.
            if (readFrames > 0 && slot.headroomGain != 1.0) {
                const size_t count = static_cast<size_t>(readFrames) * channels;
                for (size_t i = 0; i < count; ++i) decodeIn[i] *= slot.headroomGain;
            }

            // Puros Restore on the decoded source, before any rate change (sample-aligned:
            // it drops its priming frames and appends its tail at the end).
            if (!slot.bypassDsp) slot.dsp.runRestoreStage(RestorePosition::Source, decodeIn, channels, endAfterWrite);
            const size_t sourceFrames = decodeIn.size() / channels;

            // Rate conversion; at the end, drain the filter so the last milliseconds are not lost.
            std::vector<double>* stage = &decodeIn;
            if (slot.firResampler || slot.resampler) {
                converted.clear();
                if (slot.firResampler) {
                    if (sourceFrames > 0) slot.firResampler->process(decodeIn.data(), sourceFrames, converted);
                    if (endAfterWrite) slot.firResampler->flush(converted);
                } else {
                    if (sourceFrames > 0) slot.resampler->process(decodeIn.data(), sourceFrames, converted);
                    if (endAfterWrite) slot.resampler->flush(converted);
                }
                stage = &converted;
            }
            applyRoomCorrection(slot, *stage, channels, endAfterWrite);

            const size_t dspFrames = stage->size() / channels;
            if (dspFrames > 0 && !slot.bypassDsp) {
                slot.dsp.processDouble(stage->data(), static_cast<uint32_t>(dspFrames), channels);
            }
            // ...or after the whole DSP chain, when placed there.
            if (!slot.bypassDsp) slot.dsp.runRestoreStage(RestorePosition::AfterDsp, *stage, channels, endAfterWrite);

            double* pcm = stage->data();
            const size_t pcmFrames = stage->size() / channels;
            if (pcmFrames > 0) {
                float peak = 0.0f;
                if (slot.dsdEncoder) {
                    buffer.clear();
                    slot.dsdEncoder->encode(pcm, pcmFrames, buffer);
                    const DsdEncoderStats stats = slot.dsdEncoder->takeStats();
                    if (stats.overloads > 0) slot.modulatorOverloads.fetch_add(stats.overloads, std::memory_order_relaxed);
                    peak = static_cast<float>(stats.peak);
                } else {
                    slot.quantizer.convert(pcm, pcmFrames, buffer);
                    const uint64_t clips = slot.quantizer.takeClips();
                    if (clips > 0) slot.clippedSamples.fetch_add(clips, std::memory_order_relaxed);
                    peak = static_cast<float>(slot.quantizer.takePeak());
                }
                if (peak > slot.peakLevel.load(std::memory_order_relaxed)) {
                    slot.peakLevel.store(peak, std::memory_order_relaxed);
                }
            }
            // DoP frames from the encoder, or one output frame per PCM frame.
            const size_t produced = slot.dsdEncoder
                ? (pcmFrames > 0 ? buffer.size() / bytesPerFrame : 0)
                : pcmFrames;
            numFrames = static_cast<UInt32>(produced);
            bytesToWrite = produced * bytesPerFrame;
        } else {
            if (!slot.extAudioFile || !slot.ringBuffer) {
                slot.fileEof.store(true, std::memory_order_relaxed);
                break;
            }

            numFrames = framesPerRead;
            bufList.mBuffers[0].mDataByteSize = static_cast<UInt32>(framesPerRead * bytesPerFrame);
            bufList.mBuffers[0].mData = buffer.data();

            OSStatus status = ExtAudioFileRead(slot.extAudioFile, &numFrames, &bufList);
            if (status != noErr || numFrames == 0) {
                // A Restore stage switched on mid-track still holds its delayed tail.
                numFrames = slot.bypassDsp ? 0 : slot.dsp.drainRestore(
                    buffer.data(), framesPerRead, renderFormat.mChannelsPerFrame,
                    renderFormat.mBytesPerFrame / renderFormat.mChannelsPerFrame);
                if (numFrames == 0) {
                    slot.fileEof.store(true, std::memory_order_relaxed);
                    break;
                }
            } else if (!slot.bypassDsp) {
                slot.dsp.process(
                    buffer.data(),
                    numFrames,
                    renderFormat.mChannelsPerFrame,
                    renderFormat.mBytesPerFrame / renderFormat.mChannelsPerFrame
                );
            }

            bytesToWrite = numFrames * bytesPerFrame;
        }

        size_t written = 0;
        while (written < bytesToWrite && !slot.stopDecode.load(std::memory_order_relaxed)) {
            size_t w = slot.ringBuffer->write(buffer.data() + written, bytesToWrite - written);
            written += w;
            if (written < bytesToWrite) {
                std::this_thread::sleep_for(std::chrono::microseconds(500));
            }
        }

        slot.framesRead.fetch_add(numFrames, std::memory_order_relaxed);
        if (endAfterWrite) {
            slot.fileEof.store(true, std::memory_order_relaxed);
            break;
        }

        const auto now = std::chrono::steady_clock::now();
        const std::chrono::duration<double> elapsed = now - lastDecodeSample;
        lastDecodeSample = now;
        if (elapsed.count() > 0.0 && renderFormat.mSampleRate > 0) {
            const float blockAudioSeconds =
                static_cast<float>(static_cast<double>(numFrames) / renderFormat.mSampleRate);
            const float instantSpeed = blockAudioSeconds / static_cast<float>(elapsed.count());
            const float previousSpeed = processingSpeed_.load(std::memory_order_relaxed);
            const float smoothedSpeed =
                previousSpeed > 0.0f
                    ? (previousSpeed * 0.72f) + (instantSpeed * 0.28f)
                    : instantSpeed;
            processingSpeed_.store(smoothedSpeed, std::memory_order_relaxed);
        }
    }
}

bool AudioEngine::tryPromoteQueuedSlot() {
    const int active = activeSlotIndex_.load(std::memory_order_acquire);
    if (active < 0) return false;

    auto& current = trackSlots_[active];
    if (!current.fileEof.load(std::memory_order_relaxed)) return false;
    if (current.ringBuffer && current.ringBuffer->available() > 0) return false;

    const int queued = queuedSlotIndex_.load(std::memory_order_acquire);
    if (queued < 0 || queued >= static_cast<int>(trackSlots_.size())) return false;

    auto& next = trackSlots_[queued];
    if (!next.prepared.load(std::memory_order_acquire) || !next.ringBuffer) return false;

    activeSlotIndex_.store(queued, std::memory_order_release);
    queuedSlotIndex_.store(-1, std::memory_order_release);
    retiredSlotIndex_.store(active, std::memory_order_release);
    queuedAdvancePending_.store(true, std::memory_order_release);
    return true;
}

bool AudioEngine::playFile(const std::string& filePath, bool allowResample, bool deemphasis, uint32_t dsdOutputRate,
                           RestoreSourceClass sourceHint, const DsdPcmOptions& dsdPcm, std::string& error) {
    if (mode_ == AudioMode::Closed) {
        error = "No audio device open. Call openShared or openExclusive first.";
        return false;
    }

    stopPlayback();

    activeSlotIndex_.store(0, std::memory_order_release);
    queuedSlotIndex_.store(-1, std::memory_order_release);
    retiredSlotIndex_.store(-1, std::memory_order_release);
    queuedAdvancePending_.store(false, std::memory_order_release);
    paused_.store(false, std::memory_order_relaxed);
    dsp_.setSampleRate(outputFormat_.mSampleRate);
    dsp_.resetState();
    return prepareTrackSlot(0, filePath, error, true, allowResample, deemphasis, dsdOutputRate, sourceHint, dsdPcm);
}

bool AudioEngine::startPcmStream(std::string& error) {
    if (mode_ == AudioMode::Closed) {
        error = "No audio device open. Call openShared or openExclusive first.";
        return false;
    }
    if (outputFormat_.mSampleRate <= 0 || outputFormat_.mBytesPerFrame == 0) {
        error = "Output device format is not ready";
        return false;
    }

    stopPlayback();

    activeSlotIndex_.store(0, std::memory_order_release);
    queuedSlotIndex_.store(-1, std::memory_order_release);
    retiredSlotIndex_.store(-1, std::memory_order_release);
    queuedAdvancePending_.store(false, std::memory_order_release);
    paused_.store(false, std::memory_order_relaxed);
    dsp_.setSampleRate(outputFormat_.mSampleRate);
    dsp_.resetState();

    auto& slot = trackSlots_[0];
    resetTrackSlot(0);
    const size_t bufBytes =
        static_cast<size_t>(outputFormat_.mSampleRate * 8.0) * outputFormat_.mBytesPerFrame;
    slot.ringBuffer = std::make_unique<RingBuffer>(bufBytes);
    slot.stopDecode.store(false, std::memory_order_relaxed);
    slot.fileEof.store(false, std::memory_order_relaxed);
    slot.framesRead.store(0, std::memory_order_relaxed);
    slot.framesPlayed.store(0, std::memory_order_relaxed);
    slot.fileSampleRate = outputFormat_.mSampleRate;
    slot.totalFrames = 0;
    slot.filePath = "live-radio";
    slot.renderFormat = outputFormat_;
    slot.sourceKind = TrackSourceKind::ManualPcm;
    slot.bypassDsp = false;
    dsp_.copyConfigTo(slot.dsp);
    // The stream's codec arrives later (setPcmStreamSourceClass); until then it is unknown.
    slot.restoreSource = RestoreSourceClass::Unknown;
    slot.restoreCodec.clear();
    slot.dsp.prepareRestoreStage(false, dsp_.restoreConfig().position, outputFormat_.mSampleRate,
                                 outputFormat_.mChannelsPerFrame, RestoreSourceClass::Unknown);
    slot.prepared.store(true, std::memory_order_release);
    return true;
}

bool AudioEngine::queueNextFile(const std::string& filePath, bool allowResample, bool deemphasis, uint32_t dsdOutputRate,
                                RestoreSourceClass sourceHint, const DsdPcmOptions& dsdPcm, std::string& error) {
    if (mode_ == AudioMode::Closed) {
        error = "No audio device open";
        return false;
    }

    const int active = activeSlotIndex_.load(std::memory_order_acquire);
    if (active < 0) {
        error = "No active playback slot";
        return false;
    }

    cleanupRetiredSlot();
    const int queued = getInactiveSlotIndex();
    if (!prepareTrackSlot(queued, filePath, error, false, allowResample, deemphasis, dsdOutputRate, sourceHint, dsdPcm)) {
        return false;
    }
    // Gapless: the next track starts from the cutoff this one found instead of re-learning it.
    trackSlots_[queued].dsp.seedRestoreFrom(trackSlots_[active].dsp);

    queuedSlotIndex_.store(queued, std::memory_order_release);
    return true;
}

void AudioEngine::clearQueuedFile() {
    const int queued = queuedSlotIndex_.exchange(-1, std::memory_order_acq_rel);
    if (queued >= 0) {
        resetTrackSlot(queued);
    }
    cleanupRetiredSlot();
}

void AudioEngine::stopPlayback() {
    deactivateDsdOutputMode();
    clearQueuedFile();
    const int active = activeSlotIndex_.exchange(-1, std::memory_order_acq_rel);
    if (active >= 0) {
        resetTrackSlot(active);
    }
    cleanupRetiredSlot();
    queuedAdvancePending_.store(false, std::memory_order_release);
    resetVisualizerState();
}

void AudioEngine::pause() {
    paused_.store(true, std::memory_order_relaxed);
    processingSpeed_.store(0.0f, std::memory_order_relaxed);
}

void AudioEngine::resume() { paused_.store(false, std::memory_order_relaxed); }

void AudioEngine::seek(double position) {
    TrackSlot* slot = getActiveSlot();
    if (!slot) return;

    const int active = activeSlotIndex_.load(std::memory_order_acquire);
    const bool wasPaused = paused_.load(std::memory_order_relaxed);
    stopDecodeThread(active);
    if (slot->ringBuffer) slot->ringBuffer->reset();
    slot->dsp.resetState();

    const auto& renderFormat =
        slot->renderFormat.mBytesPerFrame > 0 ? slot->renderFormat : outputFormat_;
    const double fileRate = slot->fileSampleRate > 0 ? slot->fileSampleRate : renderFormat.mSampleRate;
    const double outputRate = renderFormat.mSampleRate > 0 ? renderFormat.mSampleRate : fileRate;
    const int64_t outputFrame = std::max<int64_t>(0, static_cast<int64_t>(position * outputRate));

    if (slot->sourceKind == TrackSourceKind::DsdDoP && slot->dsd.file) {
        const uint64_t targetFrame = static_cast<uint64_t>(
            std::min<int64_t>(outputFrame, std::max<int64_t>(0, slot->totalFrames))
        );
        const uint64_t targetBytesPerChannel = targetFrame * 2ULL;
        if (!positionDsdSource(*slot, targetBytesPerChannel)) return;

        slot->dsd.markerPhase = (targetFrame % 2ULL) != 0;
        slot->dsd.primerFramesRemaining = kDoPPrimerFrames;
        slot->framesRead.store(static_cast<int64_t>(targetFrame), std::memory_order_relaxed);
        slot->framesPlayed.store(static_cast<int64_t>(targetFrame), std::memory_order_relaxed);
    } else {
        if (slot->dsdDecimator) {
            // Whole bytes: one PCM frame is ratio / 8 bytes per channel.
            const uint64_t pcmFrame = static_cast<uint64_t>(std::max(0.0, position * fileRate));
            const uint64_t targetBytes = std::min<uint64_t>(pcmFrame * (slot->dsdDecimator->ratio() / 8),
                                                            dsdBytesPerChannel(*slot));
            if (!positionDsdSource(*slot, targetBytes)) return;
            slot->dsdDecimator->reset();
        } else {
            if (!slot->extAudioFile) return;
            const SInt64 fileFrame = static_cast<SInt64>(position * fileRate);
            ExtAudioFileSeek(slot->extAudioFile, fileFrame);
        }
        if (slot->resampler) slot->resampler->reset();
        if (slot->firResampler) slot->firResampler->reset();
        if (slot->dsdEncoder) slot->dsdEncoder->reset();
        if (slot->roomConvolver) {
            slot->roomConvolver->reset();
            slot->convolutionTrimmed = 0;
            slot->convolutionInputFrames = 0;
        }
        slot->deemphasisFilter.reset();
        slot->quantizer.reset();
        slot->framesRead.store(outputFrame, std::memory_order_relaxed);
        slot->framesPlayed.store(outputFrame, std::memory_order_relaxed);
    }

    slot->fileEof.store(false, std::memory_order_relaxed);
    slot->stopDecode.store(false, std::memory_order_relaxed);
    paused_.store(wasPaused, std::memory_order_relaxed);
    slot->decodeThread = std::thread(&AudioEngine::decodeThreadFunc, this, active);
}

double AudioEngine::getPosition() const {
    const TrackSlot* slot = getActiveSlot();
    if (!slot) return 0;
    const auto& renderFormat =
        slot->renderFormat.mBytesPerFrame > 0 ? slot->renderFormat : outputFormat_;
    if (renderFormat.mSampleRate <= 0) return 0;
    return static_cast<double>(slot->framesPlayed.load(std::memory_order_relaxed)) / renderFormat.mSampleRate;
}

double AudioEngine::getDuration() const {
    const TrackSlot* slot = getActiveSlot();
    if (!slot || slot->fileSampleRate <= 0) return 0;
    return static_cast<double>(slot->totalFrames) / slot->fileSampleRate;
}

bool AudioEngine::isTrackEnded() const {
    const TrackSlot* slot = getActiveSlot();
    if (!slot) return false;
    if (!slot->fileEof.load(std::memory_order_relaxed)) return false;
    if (slot->ringBuffer && slot->ringBuffer->available() > 0) return false;
    if (queuedSlotIndex_.load(std::memory_order_acquire) >= 0) return false;
    return true;
}

bool AudioEngine::consumeQueuedAdvance() {
    cleanupRetiredSlot();
    return queuedAdvancePending_.exchange(false, std::memory_order_acq_rel);
}

// ---------------------------------------------------------------------------
// getCurrentFormat
// ---------------------------------------------------------------------------

DeviceFormat AudioEngine::getCurrentFormat() const {
    const TrackSlot* slot = getActiveSlot();
    const auto& currentFormat =
        slot && (slot->sourceKind == TrackSourceKind::DsdDoP || slot->dopOutput) && slot->renderFormat.mBytesPerFrame > 0
            ? slot->renderFormat
            : outputFormat_;
    return {
        currentFormat.mSampleRate,
        currentFormat.mBitsPerChannel,
        currentFormat.mChannelsPerFrame
    };
}

VisualizerSnapshot AudioEngine::getVisualizerSnapshot() const {
    VisualizerSnapshot snapshot;
    static_cast<VisualizerBuffer::Snapshot&>(snapshot) = visualizerBuffer_.snapshot();

    snapshot.peak = visualizerPeak_.load(std::memory_order_relaxed);
    snapshot.rms = visualizerRms_.load(std::memory_order_relaxed);
    snapshot.paused = paused_.load(std::memory_order_relaxed);
    snapshot.active = mode_ != AudioMode::Closed && getActiveSlot() != nullptr;
    return snapshot;
}

ProcessingStats AudioEngine::getProcessingStats() const {
    ProcessingStats stats;
    stats.speed = processingSpeed_.load(std::memory_order_relaxed);
    stats.active = mode_ != AudioMode::Closed && getActiveSlot() != nullptr && !paused_.load(std::memory_order_relaxed);
    return stats;
}

void AudioEngine::resetVisualizerState() {
    visualizerBuffer_.reset();
    visualizerPeak_.store(0.0f, std::memory_order_relaxed);
    visualizerRms_.store(0.0f, std::memory_order_relaxed);
    processingSpeed_.store(0.0f, std::memory_order_relaxed);
}

void AudioEngine::captureVisualizerSamples(const AudioBufferList* bufferList, const AudioStreamBasicDescription& format) {
    if (!bufferList || format.mBytesPerFrame == 0) return;

    const bool isNonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    const uint32_t channelCount = std::max<UInt32>(format.mChannelsPerFrame, 1);
    const uint32_t bytesPerSample = isNonInterleaved
        ? format.mBytesPerFrame
        : (channelCount > 0 ? format.mBytesPerFrame / channelCount : 0);
    if (bytesPerSample == 0) return;

    uint32_t frameCount = 0;
    if (isNonInterleaved) {
        if (bufferList->mNumberBuffers == 0) return;
        frameCount = bufferList->mBuffers[0].mDataByteSize / bytesPerSample;
    } else {
        if (bufferList->mNumberBuffers == 0) return;
        frameCount = bufferList->mBuffers[0].mDataByteSize / format.mBytesPerFrame;
    }
    if (frameCount == 0) return;

    const uint32_t activeChannels = isNonInterleaved
        ? std::min<UInt32>(bufferList->mNumberBuffers, 2)
        : std::min<UInt32>(channelCount, 2);
    if (activeChannels == 0) return;

    visualizerBuffer_.begin(format.mSampleRate);
    float peak = 0.0f;
    double energy = 0.0;
    uint32_t analyzedFrames = 0;

    for (uint32_t frame = 0; frame < frameCount; frame++) {
        float mono = 0.0f;
        uint32_t contributors = 0;
        float channels[2] = {0, 0};

        if (isNonInterleaved) {
            for (uint32_t channel = 0; channel < activeChannels; channel++) {
                const auto& buffer = bufferList->mBuffers[channel];
                const size_t offset = static_cast<size_t>(frame) * bytesPerSample;
                if (!buffer.mData || offset + bytesPerSample > buffer.mDataByteSize) continue;
                channels[channel] = clampVisualizerSample(decodePcmSample(static_cast<const uint8_t*>(buffer.mData) + offset, bytesPerSample, format));
                mono += channels[channel];
                contributors += 1;
            }
        } else {
            const auto& buffer = bufferList->mBuffers[0];
            if (!buffer.mData) break;
            const size_t frameOffset = static_cast<size_t>(frame) * format.mBytesPerFrame;
            for (uint32_t channel = 0; channel < activeChannels; channel++) {
                const size_t offset = frameOffset + static_cast<size_t>(channel) * bytesPerSample;
                if (offset + bytesPerSample > buffer.mDataByteSize) continue;
                channels[channel] = clampVisualizerSample(decodePcmSample(static_cast<const uint8_t*>(buffer.mData) + offset, bytesPerSample, format));
                mono += channels[channel];
                contributors += 1;
            }
        }

        if (contributors == 0) continue;

        mono = clampVisualizerSample(mono / static_cast<float>(contributors));
        peak = std::max(peak, std::fabs(mono));
        energy += static_cast<double>(mono) * static_cast<double>(mono);
        visualizerBuffer_.push(channels[0], activeChannels == 1 ? channels[0] : channels[1]);
        analyzedFrames += 1;
    }

    visualizerBuffer_.end();

    const float rms = analyzedFrames > 0
        ? static_cast<float>(std::sqrt(energy / static_cast<double>(analyzedFrames)))
        : 0.0f;
    const float previousPeak = visualizerPeak_.load(std::memory_order_relaxed);
    const float previousRms = visualizerRms_.load(std::memory_order_relaxed);
    visualizerPeak_.store(std::max(peak, previousPeak * 0.82f), std::memory_order_relaxed);
    visualizerRms_.store((previousRms * 0.68f) + (rms * 0.32f), std::memory_order_relaxed);
}

// ---------------------------------------------------------------------------
// setVolume — shared mode only; exclusive stays at 1.0 (bit-perfect)
// ---------------------------------------------------------------------------

void AudioEngine::setVolume(float gain) {
    if (mode_ != AudioMode::Shared || !audioUnit_) return;
    gain = std::max(0.0f, std::min(1.0f, gain));
    AudioUnitSetParameter(audioUnit_, kHALOutputParam_Volume,
                          kAudioUnitScope_Global, 0, gain, 0);
}

void AudioEngine::setDigitalVolume(double gain) {
    digitalVolume_.setTarget(gain);
}

HardwareVolumeInfo AudioEngine::getHardwareVolume(const std::string& deviceUid) {
    HardwareVolumeInfo info;
    const AudioDeviceID device = findDeviceByUid(deviceUid);
    const auto elements = findOutputControlElements(device, kAudioDevicePropertyVolumeScalar);
    if (elements.empty()) return info;

    Float32 scalar = 0;
    if (!readOutputFloat(device, kAudioDevicePropertyVolumeScalar, elements.front(), scalar)) return info;
    info.supported = true;
    info.scalar = std::clamp(static_cast<double>(scalar), 0.0, 1.0);

    Float32 decibels = 0;
    AudioValueRange range{};
    UInt32 rangeSize = sizeof(range);
    AudioObjectPropertyAddress rangeAddr{kAudioDevicePropertyVolumeRangeDecibels,
                                         kAudioDevicePropertyScopeOutput, elements.front()};
    if (readOutputFloat(device, kAudioDevicePropertyVolumeDecibels, elements.front(), decibels) &&
        AudioObjectGetPropertyData(device, &rangeAddr, 0, nullptr, &rangeSize, &range) == noErr) {
        info.hasDecibels = true;
        info.decibels = decibels;
        info.minDecibels = range.mMinimum;
        info.maxDecibels = range.mMaximum;
    }

    const auto muteElements = findOutputControlElements(device, kAudioDevicePropertyMute);
    if (!muteElements.empty()) {
        UInt32 muted = 0;
        UInt32 size = sizeof(muted);
        AudioObjectPropertyAddress muteAddr{kAudioDevicePropertyMute,
                                            kAudioDevicePropertyScopeOutput, muteElements.front()};
        if (AudioObjectGetPropertyData(device, &muteAddr, 0, nullptr, &size, &muted) == noErr) {
            info.muteSupported = true;
            info.muted = muted != 0;
        }
    }
    return info;
}

bool AudioEngine::setHardwareVolume(const std::string& deviceUid, double scalar, std::string& error) {
    if (!std::isfinite(scalar)) {
        error = "Invalid volume";
        return false;
    }
    const AudioDeviceID device = findDeviceByUid(deviceUid);
    const auto elements = findOutputControlElements(device, kAudioDevicePropertyVolumeScalar);
    if (elements.empty()) {
        error = "Device has no hardware volume control";
        return false;
    }

    Float32 value = static_cast<Float32>(std::clamp(scalar, 0.0, 1.0));
    for (auto element : elements) {
        AudioObjectPropertyAddress addr{kAudioDevicePropertyVolumeScalar,
                                        kAudioDevicePropertyScopeOutput, element};
        const OSStatus status = AudioObjectSetPropertyData(device, &addr, 0, nullptr, sizeof(value), &value);
        if (status != noErr) {
            error = "Failed to set device volume (error " + std::to_string(status) + ")";
            return false;
        }
    }
    return true;
}

bool AudioEngine::setHardwareMute(const std::string& deviceUid, bool muted, std::string& error) {
    const AudioDeviceID device = findDeviceByUid(deviceUid);
    const auto elements = findOutputControlElements(device, kAudioDevicePropertyMute);
    if (elements.empty()) {
        error = "Device has no hardware mute control";
        return false;
    }

    UInt32 value = muted ? 1 : 0;
    for (auto element : elements) {
        AudioObjectPropertyAddress addr{kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput, element};
        const OSStatus status = AudioObjectSetPropertyData(device, &addr, 0, nullptr, sizeof(value), &value);
        if (status != noErr) {
            error = "Failed to set device mute (error " + std::to_string(status) + ")";
            return false;
        }
    }
    return true;
}


// ---------------------------------------------------------------------------
// DSP / EQ
// ---------------------------------------------------------------------------

void AudioEngine::setEQProfile(const std::vector<EQBand>& bands, double preampGainDb) {
    dsp_.setProfile(bands, preampGainDb);
    for (auto& slot : trackSlots_) {
        slot.dsp.setProfile(bands, preampGainDb);
    }
}

void AudioEngine::setCrossfeed(bool enabled, double cutoffFrequency, double feedLevelDb) {
    const CrossfeedConfig config{
        enabled,
        cutoffFrequency,
        feedLevelDb,
    };
    dsp_.setCrossfeed(config);
    for (auto& slot : trackSlots_) {
        slot.dsp.setCrossfeed(config);
    }
}

bool AudioEngine::setPlugins(const std::vector<PluginSpec>& specs, std::string& error) {
    PluginRack::closeEditor();
    for (const auto& spec : specs) {
        if (spec.enabled && access(spec.path.c_str(), F_OK) != 0) {
            error = "Plug-in not found: " + spec.path;
            return false;
        }
    }
    const auto previous = pluginSpecs_;
    if (!dsp_.setPlugins(specs, error)) return false;
    for (auto& slot : trackSlots_) {
        if (!slot.dsp.setPlugins(specs, error)) {
            std::string ignored;
            dsp_.setPlugins(previous, ignored);
            for (auto& restoreSlot : trackSlots_)
                restoreSlot.dsp.setPlugins(previous, ignored);
            return false;
        }
    }
    pluginSpecs_ = specs;
    return true;
}

std::vector<PluginParameter> AudioEngine::getPluginParameters(size_t index) {
    if (index >= pluginSpecs_.size()) return {};
    return PluginRack::inspect(pluginSpecs_[index],
                              outputFormat_.mSampleRate > 0 ? outputFormat_.mSampleRate : 48000);
}

bool AudioEngine::setPluginParameter(size_t index, uint32_t id, double value, std::string& error) {
    if (index >= pluginSpecs_.size() || !std::isfinite(value)) {
        error = "Invalid plug-in parameter";
        return false;
    }
    if (!dsp_.setPluginParameter(index, id, value, error)) return false;
    for (auto& slot : trackSlots_)
        if (!slot.dsp.setPluginParameter(index, id, value, error)) return false;
    auto& params = pluginSpecs_[index].parameters;
    auto found = std::find_if(params.begin(), params.end(), [id](const auto& p) { return p.first == id; });
    if (found == params.end()) params.emplace_back(id, value);
    else found->second = value;
    return true;
}

bool AudioEngine::openPluginEditor(size_t index,
                                  std::function<void(size_t, uint32_t, double)> onChange,
                                  std::function<void(size_t)> onDisable,
                                  std::string& error) {
    if (index >= pluginSpecs_.size()) {
        error = "Invalid plug-in index";
        return false;
    }
    auto forward = [index, onChange = std::move(onChange)](uint32_t id, double value) {
            onChange(index, id, value);
        };
    auto disable = [index, onDisable = std::move(onDisable)]() { onDisable(index); };
    if (!pluginSpecs_[index].enabled) {
        error = "Enable the plug-in before opening its GUI";
        return false;
    }
    auto* slot = getActiveSlot();
    if (!slot || slot->sourceKind == TrackSourceKind::None || slot->bypassDsp) {
        error = "Start PCM playback before opening the plug-in GUI";
        return false;
    }
    PluginRack::closeEditor();
    return slot->dsp.openPluginEditor(index, std::move(forward), std::move(disable), error);
}

void AudioEngine::setEQEnabled(bool enabled) {
    dsp_.setEnabled(enabled);
    for (auto& slot : trackSlots_) {
        slot.dsp.setEnabled(enabled);
    }
}

bool AudioEngine::getEQEnabled() const {
    return dsp_.isEnabled();
}

void AudioEngine::clearEQProfile() {
    dsp_.clearProfile();
    for (auto& slot : trackSlots_) {
        slot.dsp.clearProfile();
    }
}

// ---------------------------------------------------------------------------
// Puros Restore
// ---------------------------------------------------------------------------

void AudioEngine::setRestoreConfig(const RestoreConfig& config) {
    dsp_.setRestoreConfig(config);
    for (auto& slot : trackSlots_) {
        slot.dsp.setRestoreConfig(config);
    }
}

void AudioEngine::setPcmStreamSourceClass(RestoreSourceClass sourceClass, const std::string& codec) {
    TrackSlot* slot = getActiveSlot();
    if (!slot || slot->sourceKind != TrackSourceKind::ManualPcm) return;
    slot->restoreSource = sourceClass;
    slot->restoreCodec = codec;
    slot->dsp.setRestoreSource(sourceClass);
}

RestoreEngineStatus AudioEngine::getRestoreStatus() const {
    RestoreEngineStatus status;
    const RestoreConfig config = dsp_.restoreConfig();
    status.mode = config.mode == RestoreMode::Manual ? "manual" : config.mode == RestoreMode::Auto ? "auto" : "off";
    status.position = config.position == RestorePosition::AfterDsp ? "afterDsp" : "source";
    const TrackSlot* slot = getActiveSlot();
    if (slot && slot->sourceKind != TrackSourceKind::None) {
        status.codec = slot->restoreCodec;
        status.sourceClass = slot->restoreSource == RestoreSourceClass::Lossy ? "lossy"
            : slot->restoreSource == RestoreSourceClass::Lossless ? "lossless"
            : slot->restoreSource == RestoreSourceClass::Dsd ? "dsd" : "unknown";
    }
    if (config.mode == RestoreMode::Off) {
        status.state = "off";
        return status;
    }
    if (!slot || slot->sourceKind == TrackSourceKind::None) {
        status.state = "idle";
        status.reason = "Nothing playing";
        return status;
    }
    const RestoreStatus stage = slot->dsp.restoreStatus();
    status.position = stage.position == RestorePosition::AfterDsp ? "afterDsp" : "source";
    status.sampleRate = stage.sampleRate;
    if (stage.inChain && stage.engaged) {
        status.state = "active";
        status.cutoffHz = stage.analysis.cutoffHz;
        status.confidence = stage.analysis.confidence;
        status.severity = stage.analysis.severity;
        status.mix = stage.mix;
        status.latencyMs = stage.latencySeconds * 1000.0;
        status.reason = config.mode == RestoreMode::Manual ? "Enabled manually" : "Lossy source";
        return status;
    }
    status.state = "bypassed";
    status.mix = stage.inChain ? stage.mix : 0.0;
    status.reason = slot->restoreSource == RestoreSourceClass::Dsd ? "DSD playback is never processed"
        : config.mode == RestoreMode::Manual ? "Not available for this stream"
        : slot->restoreSource == RestoreSourceClass::Lossless ? "Lossless source — left untouched"
        : "Codec not confirmed lossy — left untouched";
    return status;
}

// ---------------------------------------------------------------------------
// write() — manual PCM feeding
// ---------------------------------------------------------------------------

void AudioEngine::write(const void* data, size_t bytes) {
    TrackSlot* slot = getActiveSlot();
    if (mode_ == AudioMode::Closed || !slot || !slot->ringBuffer) return;
    std::lock_guard<std::mutex> lock(writeMutex_);

    std::vector<uint8_t> processed;
    auto* src = static_cast<const uint8_t*>(data);
    if (!slot->bypassDsp && slot->renderFormat.mBytesPerFrame > 0) {
        processed.assign(src, src + bytes);
        const UInt32 frames = static_cast<UInt32>(bytes / slot->renderFormat.mBytesPerFrame);
        if (frames > 0) {
            slot->dsp.process(
                processed.data(),
                frames,
                slot->renderFormat.mChannelsPerFrame,
                slot->renderFormat.mBytesPerFrame / slot->renderFormat.mChannelsPerFrame
            );
        }
        src = processed.data();
    }

    size_t written = 0;
    while (written < bytes) {
        size_t w = slot->ringBuffer->write(src + written, bytes - written);
        written += w;
        if (written < bytes) {
            // Nothing drains the buffer while paused: drop the rest instead of spinning.
            if (paused_.load(std::memory_order_relaxed)) return;
            std::this_thread::sleep_for(std::chrono::microseconds(500));
        }
    }
}

// ---------------------------------------------------------------------------
// close() — full teardown
// FIX: stop audio output and add safety delay before deallocating ring buffer
// ---------------------------------------------------------------------------

void AudioEngine::close() {
    PluginRack::closeEditor();
    deactivateDsdOutputMode(false);
    stopPlayback();

    // Exclusive mode teardown — exact reverse of init order:
    //   1. Stop IOProc (reverse of step 7)
    //   2. Restore virtual format (reverse of step 4/5)
    //   3. Restore physical format (reverse of step 4)
    //   4. Release hog (reverse of step 2)
    //   5. Re-enable mixing (reverse of step 1)
    if (ioProcId_ && activeDeviceId_ != kAudioObjectUnknown) {
        AudioDeviceStop(activeDeviceId_, ioProcId_);
        // Safety delay: ensure IOProc callback has fully exited
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        AudioDeviceDestroyIOProcID(activeDeviceId_, ioProcId_);
        ioProcId_ = nullptr;
    }

    if (formatChanged_ && activeDeviceId_ != kAudioObjectUnknown) {
        AudioStreamID stream = getOutputStream(activeDeviceId_);
        if (stream != 0) {
            // Restore the original physical format and let it settle before the hog
            // is released, so a reopen never races a half-applied format change.
            restoreOriginalStreamFormats(stream);
        }
        formatChanged_ = false;
    }

    restoreHardwareBufferSize();
    unhogDevice();
    restoreMixing();

    // Shared mode teardown — stop AudioUnit with safety delay
    if (audioUnit_) {
        AudioOutputUnitStop(audioUnit_);
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        AudioUnitUninitialize(audioUnit_);
        AudioComponentInstanceDispose(audioUnit_);
        audioUnit_ = nullptr;
    }

    resetTrackSlot(0);
    resetTrackSlot(1);
    activeSlotIndex_.store(-1, std::memory_order_release);
    queuedSlotIndex_.store(-1, std::memory_order_release);
    retiredSlotIndex_.store(-1, std::memory_order_release);
    queuedAdvancePending_.store(false, std::memory_order_release);
    activeDeviceId_ = kAudioObjectUnknown;
    activeDeviceUid_.clear();
    mode_ = AudioMode::Closed;
    outputFormat_ = {};
    physicalOutputFormat_ = {};
    virtualOutputFormat_ = {};
}
