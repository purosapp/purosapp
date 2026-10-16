#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <MediaPlayer/MediaPlayer.h>

#include "NowPlayingBridge.h"

#include <dispatch/dispatch.h>
#include <mutex>
#include <utility>

namespace {

NSString* ToNSString(const std::string& value) {
    return [NSString stringWithUTF8String:value.empty() ? "" : value.c_str()];
}

MPNowPlayingPlaybackState ToNativePlaybackState(NowPlayingPlaybackState state) {
    switch (state) {
        case NowPlayingPlaybackState::Playing:
            return MPNowPlayingPlaybackStatePlaying;
        case NowPlayingPlaybackState::Paused:
            return MPNowPlayingPlaybackStatePaused;
        default:
            return MPNowPlayingPlaybackStateStopped;
    }
}

}  // namespace

class NowPlayingBridge::Impl {
public:
    Impl() {
        if ([NSThread isMainThread]) {
            configureRemoteCommands();
        } else {
            dispatch_sync(dispatch_get_main_queue(), ^{
                configureRemoteCommands();
            });
        }
    }

    ~Impl() {
        if ([NSThread isMainThread]) {
            teardownRemoteCommands();
            [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = nil;
            [MPNowPlayingInfoCenter defaultCenter].playbackState = MPNowPlayingPlaybackStateStopped;
        } else {
            dispatch_sync(dispatch_get_main_queue(), ^{
                teardownRemoteCommands();
                [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = nil;
                [MPNowPlayingInfoCenter defaultCenter].playbackState = MPNowPlayingPlaybackStateStopped;
            });
        }
    }

    void setRemoteCommandHandler(std::function<void(const std::string&)> nextHandler) {
        std::lock_guard<std::mutex> lock(handlerMutex_);
        handler_ = std::move(nextHandler);
    }

    void updateNowPlaying(const NowPlayingInfoPayload& payload) {
        NowPlayingInfoPayload copy = payload;
        dispatch_async(dispatch_get_main_queue(), ^{
            NSMutableDictionary<NSString*, id>* info = [NSMutableDictionary dictionary];
            info[MPMediaItemPropertyTitle] = ToNSString(copy.title);
            info[MPMediaItemPropertyArtist] = ToNSString(copy.artist);
            info[MPMediaItemPropertyAlbumTitle] = ToNSString(copy.album);
            info[MPMediaItemPropertyPlaybackDuration] = @(copy.duration > 0 ? copy.duration : 0);
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(copy.position > 0 ? copy.position : 0);
            info[MPNowPlayingInfoPropertyPlaybackRate] = @1.0;

            if (!copy.artworkData.empty()) {
                NSData* data = [NSData dataWithBytes:copy.artworkData.data()
                                              length:copy.artworkData.size()];
                NSImage* image = [[NSImage alloc] initWithData:data];
                if (image) {
                    MPMediaItemArtwork* artwork = [[MPMediaItemArtwork alloc]
                        initWithBoundsSize:image.size
                            requestHandler:^NSImage* _Nonnull(CGSize size) {
                                return image;
                            }];
                    info[MPMediaItemPropertyArtwork] = artwork;
                }
            }

            [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = info;
        });
    }

    void updatePlaybackState(NowPlayingPlaybackState state, double position, double duration) {
        dispatch_async(dispatch_get_main_queue(), ^{
            MPNowPlayingInfoCenter* center = [MPNowPlayingInfoCenter defaultCenter];
            center.playbackState = ToNativePlaybackState(state);

            NSMutableDictionary<NSString*, id>* info = center.nowPlayingInfo
                ? [center.nowPlayingInfo mutableCopy]
                : [NSMutableDictionary dictionary];

            if (duration > 0) {
                info[MPMediaItemPropertyPlaybackDuration] = @(duration);
            }
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(position > 0 ? position : 0);
            info[MPNowPlayingInfoPropertyPlaybackRate] =
                (state == NowPlayingPlaybackState::Playing) ? @1.0 : @0.0;

            center.nowPlayingInfo = info;
        });
    }

    void clear() {
        dispatch_async(dispatch_get_main_queue(), ^{
            MPNowPlayingInfoCenter* center = [MPNowPlayingInfoCenter defaultCenter];
            center.nowPlayingInfo = nil;
            center.playbackState = MPNowPlayingPlaybackStateStopped;
        });
    }

private:
    void emitCommand(const std::string& command) {
        std::lock_guard<std::mutex> lock(handlerMutex_);
        if (handler_) handler_(command);
    }

    void configureRemoteCommands() {
        MPRemoteCommandCenter* center = [MPRemoteCommandCenter sharedCommandCenter];

        playTarget_ = [center.playCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
            emitCommand("play");
            return MPRemoteCommandHandlerStatusSuccess;
        }];
        pauseTarget_ = [center.pauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
            emitCommand("pause");
            return MPRemoteCommandHandlerStatusSuccess;
        }];
        toggleTarget_ = [center.togglePlayPauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
            emitCommand("play-pause");
            return MPRemoteCommandHandlerStatusSuccess;
        }];
        nextTarget_ = [center.nextTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
            emitCommand("next");
            return MPRemoteCommandHandlerStatusSuccess;
        }];
        previousTarget_ = [center.previousTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
            emitCommand("previous");
            return MPRemoteCommandHandlerStatusSuccess;
        }];
        stopTarget_ = [center.stopCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
            emitCommand("stop");
            return MPRemoteCommandHandlerStatusSuccess;
        }];

        center.playCommand.enabled = YES;
        center.pauseCommand.enabled = YES;
        center.togglePlayPauseCommand.enabled = YES;
        center.nextTrackCommand.enabled = YES;
        center.previousTrackCommand.enabled = YES;
        center.stopCommand.enabled = YES;
    }

    void teardownRemoteCommands() {
        MPRemoteCommandCenter* center = [MPRemoteCommandCenter sharedCommandCenter];
        if (playTarget_) [center.playCommand removeTarget:playTarget_];
        if (pauseTarget_) [center.pauseCommand removeTarget:pauseTarget_];
        if (toggleTarget_) [center.togglePlayPauseCommand removeTarget:toggleTarget_];
        if (nextTarget_) [center.nextTrackCommand removeTarget:nextTarget_];
        if (previousTarget_) [center.previousTrackCommand removeTarget:previousTarget_];
        if (stopTarget_) [center.stopCommand removeTarget:stopTarget_];

        playTarget_ = nil;
        pauseTarget_ = nil;
        toggleTarget_ = nil;
        nextTarget_ = nil;
        previousTarget_ = nil;
        stopTarget_ = nil;
    }

    std::mutex handlerMutex_;
    std::function<void(const std::string&)> handler_;
    id playTarget_ = nil;
    id pauseTarget_ = nil;
    id toggleTarget_ = nil;
    id nextTarget_ = nil;
    id previousTarget_ = nil;
    id stopTarget_ = nil;
};

NowPlayingBridge::NowPlayingBridge()
    : impl_(std::make_unique<Impl>()) {}

NowPlayingBridge::~NowPlayingBridge() = default;

void NowPlayingBridge::setRemoteCommandHandler(std::function<void(const std::string&)> handler) {
    impl_->setRemoteCommandHandler(std::move(handler));
}

void NowPlayingBridge::updateNowPlaying(const NowPlayingInfoPayload& payload) {
    impl_->updateNowPlaying(payload);
}

void NowPlayingBridge::updatePlaybackState(
    NowPlayingPlaybackState state,
    double position,
    double duration
) {
    impl_->updatePlaybackState(state, position, duration);
}

void NowPlayingBridge::clear() {
    impl_->clear();
}
