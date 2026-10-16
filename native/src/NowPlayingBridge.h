#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

enum class NowPlayingPlaybackState {
    Stopped,
    Paused,
    Playing,
};

struct NowPlayingInfoPayload {
    std::string title;
    std::string artist;
    std::string album;
    double duration = 0;
    double position = 0;
    std::string artworkMimeType;
    std::vector<uint8_t> artworkData;
};

class NowPlayingBridge {
public:
    NowPlayingBridge();
    ~NowPlayingBridge();

    void setRemoteCommandHandler(std::function<void(const std::string&)> handler);
    void updateNowPlaying(const NowPlayingInfoPayload& payload);
    void updatePlaybackState(NowPlayingPlaybackState state, double position, double duration);
    void clear();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
