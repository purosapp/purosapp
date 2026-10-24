/**
 * Node.js N-API addon exposing CoreAudio engine with exclusive + shared modes.
 *
 * API:
 *   listDevices() → async [{ id, name, uid, channels, sampleRate, sampleRates, bitDepths }]
 * Device/playback control runs on a serial control thread and returns Promises
 * (marked "async"); everything else is synchronous and never waits for it.
 *
 *   openExclusive(deviceUid, sampleRate, bitDepth, preferNonMixableInteger?) → async { success, error? }
 *   openShared(deviceUid) → async { success, error? }
 *   playFile(filePath, allowResample?, deemphasis?, dsdOutputRate?, sourceHint?, dsdPcm?) → async { success, error? }
 *       sourceHint = "lossy" | "lossless" | "dsd" | "unknown" (codec metadata for Puros Restore)
 *       dsdPcm = { sampleRate, filterHz, gainDb }: decode a DSD file to PCM instead of DoP
 *   startPcmStream() → async { success, error? }
 *   queueNextFile(filePath, allowResample?, deemphasis?, dsdOutputRate?, sourceHint?, dsdPcm?) → async { success, error? }
 *   setRestoreConfig({ mode, profile, strength, artifactReduction, hfReconstruction, transientRestoration, position }) → void
 *   getRestoreStatus() → { mode, state, reason, sourceClass, codec, position, cutoffHz, confidence, severity, mix,
 *                          latencyMs, sampleRate }
 *   setPcmStreamSourceClass(sourceClass, codec) → async void
 *   setResamplerConfig({ engine, filter1x, filterNx, appleComplexity, appleQuality, dither, headroomDb, headroomAuto }) → void
 *       filter = { recipe, precision, phaseResponse, passbandEnd, stopbandBegin, steepFilter, allowAliasing }
 *       fir = { window, tapsPerPhase, minimumPhase, apodizing, cutoff, attenuationDb }
 *       + fir1x, firNx, convolution { path, gainDb, compensateDelay }
 *   getResamplerStatus() → { float64, sourceBits, sourceFloat, outputBits, outputFloat, resampling, engine, inputRate, outputRate, ditherBits, dither, filter,
 *                            deemphasis, headroomDb, headroomAuto, peakDb, clippedSamples, firTaps, convolutionTaps,
 *                            convolutionError, dsdOutputRate, modulator, modulatorOverloads,
 *                            dsdSourceRate, dsdStages, dsdFilterHz, dsdGainDb }
 *   previewFirFilter(fir, inputRate, outputRate) → async { success, frequencies, magnitudeDb, impulse, … }
 *   inspectImpulseResponse(path) → async { success, channels, sampleRate, taps, peakIndex, peakDb }
 *   clearQueuedFile() → async void
 *   stopPlayback() → async void
 *   pause() → void
 *   resume() → void
 *   seek(position) → async void
 *   setVolume(gain) → async void                   (shared-mode HAL volume)
 *   write(buffer) → void
 *   setDigitalVolume(gain) → void                  (exclusive DSP volume, 1.0 = bit-perfect)
 *   getHardwareVolume(uid) → { supported, scalar, decibels, minDecibels, maxDecibels, muteSupported, muted }
 *   setHardwareVolume(uid, scalar) → { success, error? }
 *   setHardwareMute(uid, muted) → { success, error? }
 *   setHardwareBufferOptions(uid, useMax, powerOfTwo) → void
 *   getMode() → "exclusive" | "shared" | "closed"
 *   getPosition() → number
 *   getDuration() → number
 *   isTrackEnded() → boolean
 *   consumeQueuedAdvance() → boolean
 *   close() → async void
 *   closeSync() → void                             (app shutdown only)
 */

#include <napi.h>
#include <algorithm>
#include <cstring>
#include <cstdlib>
#include <cmath>
#include <set>
#include <mutex>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <shared_mutex>
#include <thread>
#include <CoreAudio/CoreAudio.h>
#include "AudioEngine.h"
#include "NowPlayingBridge.h"

static AudioEngine engine;
static NowPlayingBridge nowPlayingBridge;
static std::mutex remoteCommandMutex;
static Napi::ThreadSafeFunction remoteCommandTsfn;
static std::mutex pluginChangeMutex;
static Napi::ThreadSafeFunction pluginChangeTsfn;
static std::mutex pluginDisableMutex;
static Napi::ThreadSafeFunction pluginDisableTsfn;

// ---------------------------------------------------------------------------
// Control thread
//
// Opening, reconfiguring and closing a CoreAudio device blocks for as long as the
// hardware needs (a DAC sample-rate relock plus AudioDeviceStart can take ~1 s).
// Like mpv's audio thread, those operations run here — serially, in call order —
// and resolve a Promise, so the Electron main process never stalls on them.
// Readers (position, format, …) never wait: while an operation holds the engine
// they return the last known value.
// ---------------------------------------------------------------------------

static std::shared_mutex engineStateMutex;

namespace {

class ControlQueue {
public:
    void push(std::function<void()> task) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!started_) {
                started_ = true;
                // Intentionally detached: the queue lives for the whole process.
                std::thread([this] { run(); }).detach();
            }
            tasks_.push_back(std::move(task));
        }
        ready_.notify_one();
    }

private:
    void run() {
        for (;;) {
            std::function<void()> task;
            {
                std::unique_lock<std::mutex> lock(mutex_);
                ready_.wait(lock, [this] { return !tasks_.empty(); });
                task = std::move(tasks_.front());
                tasks_.pop_front();
            }
            task();
        }
    }

    std::mutex mutex_;
    std::condition_variable ready_;
    std::deque<std::function<void()>> tasks_;
    bool started_ = false;
};

ControlQueue* controlQueue = new ControlQueue();  // never destroyed (worker is detached)

struct OpResult {
    bool success = true;
    std::string error;
};

Napi::Value ToJs(Napi::Env env, const OpResult& result) {
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("success", Napi::Boolean::New(env, result.success));
    if (!result.success) obj.Set("error", Napi::String::New(env, result.error));
    return obj;
}

// Runs `work` on the control thread holding the engine exclusively; resolves
// the returned Promise with ToJs(result) (or undefined when `voidResult`).
Napi::Value RunOnControlThread(Napi::Env env, const char* name, std::function<OpResult()> work,
                               bool voidResult = false) {
    auto deferred = std::make_shared<Napi::Promise::Deferred>(Napi::Promise::Deferred::New(env));
    Napi::Value promise = deferred->Promise();
    auto tsfn = Napi::ThreadSafeFunction::New(
        env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), name, 0, 1);
    controlQueue->push([tsfn, deferred, work = std::move(work), voidResult]() mutable {
        auto result = std::make_shared<OpResult>();
        {
            std::unique_lock<std::shared_mutex> lock(engineStateMutex);
            *result = work();
        }
        tsfn.BlockingCall([deferred, result, voidResult](Napi::Env callEnv, Napi::Function) {
            deferred->Resolve(voidResult ? callEnv.Undefined() : ToJs(callEnv, *result));
        });
        tsfn.Release();
    });
    return promise;
}

// Runs `work` on its own thread (no engine lock) and resolves with toJs(result).
template <typename Result>
Napi::Value RunInBackground(Napi::Env env, const char* name, std::function<Result()> work,
                            std::function<Napi::Value(Napi::Env, const Result&)> toJs) {
    auto deferred = std::make_shared<Napi::Promise::Deferred>(Napi::Promise::Deferred::New(env));
    Napi::Value promise = deferred->Promise();
    auto tsfn = Napi::ThreadSafeFunction::New(
        env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), name, 0, 1);
    std::thread([tsfn, deferred, work = std::move(work), toJs = std::move(toJs)]() mutable {
        auto result = std::make_shared<Result>(work());
        tsfn.BlockingCall([deferred, result, toJs](Napi::Env callEnv, Napi::Function) {
            deferred->Resolve(toJs(callEnv, *result));
        });
        tsfn.Release();
    }).detach();
    return promise;
}

FirDesign ParseFirDesign(const Napi::Object& source) {
    FirDesign design;
    const auto number = [&](const char* key, double fallback) {
        const Napi::Value value = source.Get(key);
        return value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : fallback;
    };
    const auto flag = [&](const char* key, bool fallback) {
        const Napi::Value value = source.Get(key);
        return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
    };
    const Napi::Value window = source.Get("window");
    const std::string name = window.IsString() ? window.As<Napi::String>().Utf8Value() : "kaiser";
    design.window = name == "blackman-harris" ? FirWindow::BlackmanHarris
        : name == "gauss" ? FirWindow::Gauss
        : FirWindow::Kaiser;
    design.tapsPerPhase = static_cast<unsigned>(std::clamp(number("tapsPerPhase", 4096), 8.0, 65536.0));
    design.minimumPhase = flag("minimumPhase", false);
    design.apodizing = flag("apodizing", true);
    design.cutoff = std::clamp(number("cutoff", 1.0), 0.5, 1.2);
    design.attenuationDb = std::clamp(number("attenuationDb", 160), 60.0, 220.0);
    return design;
}

// Last values handed to JS; returned while the control thread holds the engine.
std::atomic<double> cachedPosition{0.0};
std::atomic<double> cachedDuration{0.0};
std::mutex cachedFormatMutex;
DeviceFormat cachedFormat{0, 0, 0};
ResamplerStatus cachedResamplerStatus;
RestoreEngineStatus cachedRestoreStatus;

DsdPcmOptions ParseDsdPcmOptions(const Napi::Value& value) {
    DsdPcmOptions options;
    if (!value.IsObject()) return options;
    const Napi::Object object = value.As<Napi::Object>();
    const auto number = [&](const char* key) {
        const Napi::Value field = object.Get(key);
        return field.IsNumber() ? field.As<Napi::Number>().DoubleValue() : 0.0;
    };
    const double sampleRate = number("sampleRate");
    options.sampleRate = sampleRate > 0 && sampleRate <= 1e6 ? static_cast<uint32_t>(sampleRate) : 0;
    options.filterHz = std::clamp(number("filterHz"), 0.0, 200000.0);
    options.gainDb = std::clamp(number("gainDb"), 0.0, 12.0);
    return options;
}

RestoreSourceClass ParseRestoreSourceClass(const Napi::Value& value) {
    if (!value.IsString()) return RestoreSourceClass::Unknown;
    const std::string text = value.As<Napi::String>().Utf8Value();
    if (text == "lossy") return RestoreSourceClass::Lossy;
    if (text == "lossless") return RestoreSourceClass::Lossless;
    if (text == "dsd") return RestoreSourceClass::Dsd;
    return RestoreSourceClass::Unknown;
}

const char* ToDoPCapabilityString(DoPCapability capability) {
    switch (capability) {
        case DoPCapability::DoP64:
            return "DoP64";
        case DoPCapability::DoP128:
            return "DoP128";
        case DoPCapability::DoP256:
            return "DoP256";
        case DoPCapability::FallbackPCM:
        default:
            return "FallbackPCM";
    }
}

void EmitRemoteCommandToJs(const std::string& command) {
    std::lock_guard<std::mutex> lock(remoteCommandMutex);
    if (!remoteCommandTsfn) return;

    auto* payload = new std::string(command);
    napi_status status = remoteCommandTsfn.NonBlockingCall(
        payload,
        [](Napi::Env env, Napi::Function callback, std::string* value) {
            callback.Call({Napi::String::New(env, *value)});
            delete value;
        }
    );

    if (status != napi_ok) {
        delete payload;
    }
}

struct PluginChange { size_t index; uint32_t id; double value; };

void EmitPluginChangeToJs(size_t index, uint32_t id, double value) {
    std::lock_guard<std::mutex> lock(pluginChangeMutex);
    if (!pluginChangeTsfn) return;
    auto* change = new PluginChange{index, id, value};
    auto status = pluginChangeTsfn.NonBlockingCall(change,
        [](Napi::Env env, Napi::Function callback, PluginChange* item) {
            callback.Call({Napi::Number::New(env, item->index),
                           Napi::Number::New(env, item->id),
                           Napi::Number::New(env, item->value)});
            delete item;
        });
    if (status != napi_ok) delete change;
}

void EmitPluginDisableToJs(size_t index) {
    std::lock_guard<std::mutex> lock(pluginDisableMutex);
    if (!pluginDisableTsfn) return;
    auto* item = new size_t(index);
    auto status = pluginDisableTsfn.NonBlockingCall(item,
        [](Napi::Env env, Napi::Function callback, size_t* index) {
            callback.Call({Napi::Number::New(env, *index)});
            delete index;
        });
    if (status != napi_ok) delete item;
}

NowPlayingPlaybackState ParseNowPlayingPlaybackState(const std::string& state) {
    if (state == "playing") return NowPlayingPlaybackState::Playing;
    if (state == "paused") return NowPlayingPlaybackState::Paused;
    return NowPlayingPlaybackState::Stopped;
}

}  // namespace

Napi::Array DevicesToJs(Napi::Env env, const std::vector<AudioDevice>& devices) {
    Napi::Array arr = Napi::Array::New(env, devices.size());

    for (size_t i = 0; i < devices.size(); i++) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("id", Napi::String::New(env, devices[i].uid));
        obj.Set("name", Napi::String::New(env, devices[i].name));
        obj.Set("uid", Napi::String::New(env, devices[i].uid));
        obj.Set("channels", Napi::Number::New(env, devices[i].channels));
        obj.Set("sampleRate", Napi::Number::New(env, devices[i].sampleRate));
        obj.Set("transportType", Napi::Number::New(env, static_cast<double>(devices[i].transportType)));
        obj.Set("routeParentUid", Napi::String::New(env, devices[i].routeParentUid));
        obj.Set("routeDataSourceId", Napi::Number::New(env, static_cast<double>(devices[i].routeDataSourceId)));
        obj.Set("isRouteEndpoint", Napi::Boolean::New(env, devices[i].isRouteEndpoint));
        obj.Set("isCurrentRoute", Napi::Boolean::New(env, devices[i].isCurrentRoute));
        obj.Set("dopCapability", Napi::String::New(env, ToDoPCapabilityString(devices[i].dopCapability)));
        obj.Set("hardwareVolume", Napi::Boolean::New(env, devices[i].hardwareVolume));

        // Full format capability matrix
        const auto& fmts = devices[i].supportedFormats;
        Napi::Array supportedFormats = Napi::Array::New(env, fmts.size());
        for (size_t j = 0; j < fmts.size(); j++) {
            Napi::Object fmt = Napi::Object::New(env);
            fmt.Set("sampleRate", Napi::Number::New(env, fmts[j].sampleRate));
            fmt.Set("bitDepth", Napi::Number::New(env, static_cast<double>(fmts[j].bitDepth)));
            fmt.Set("isFloat", Napi::Boolean::New(env, fmts[j].isFloat));
            fmt.Set("channels", Napi::Number::New(env, static_cast<double>(fmts[j].channels)));
            supportedFormats.Set(j, fmt);
        }
        obj.Set("supportedFormats", supportedFormats);

        // Convenience: derive flat sampleRates and bitDepths for backward compat
        std::set<double> rateSet;
        std::set<uint32_t> depthSet;
        for (const auto& f : fmts) {
            rateSet.insert(f.sampleRate);
            if (f.bitDepth > 0) depthSet.insert(f.bitDepth);
        }
        Napi::Array rates = Napi::Array::New(env, rateSet.size());
        { size_t j = 0; for (double r : rateSet) rates.Set(j++, Napi::Number::New(env, r)); }
        obj.Set("sampleRates", rates);

        Napi::Array depths = Napi::Array::New(env, depthSet.size());
        { size_t j = 0; for (uint32_t d : depthSet) depths.Set(j++, Napi::Number::New(env, static_cast<double>(d))); }
        obj.Set("bitDepths", depths);

        arr.Set(i, obj);
    }

    return arr;
}

// Enumerating devices queries the HAL, which blocks while any device is being
// reconfigured (up to ~1 s during an exclusive rate change) — so it runs off
// the JS thread and resolves a Promise.
Napi::Value ListDevices(const Napi::CallbackInfo& info) {
    return RunInBackground<std::vector<AudioDevice>>(info.Env(), "puros-list-devices",
        [] { return engine.listDevices(); },
        [](Napi::Env env, const std::vector<AudioDevice>& devices) -> Napi::Value { return DevicesToJs(env, devices); });
}

Napi::Value OpenExclusive(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected: deviceUid, sampleRate, bitDepth, [preferNonMixableInteger]")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string uid = info[0].As<Napi::String>().Utf8Value();
    double rate = info[1].As<Napi::Number>().DoubleValue();
    uint32_t depth = info[2].As<Napi::Number>().Uint32Value();
    bool preferNonMixableInteger =
        info.Length() >= 4 && info[3].IsBoolean() ? info[3].As<Napi::Boolean>().Value() : false;

    return RunOnControlThread(env, "puros-open-exclusive", [uid, rate, depth, preferNonMixableInteger] {
        OpResult result;
        result.success = engine.openExclusive(uid, rate, depth, preferNonMixableInteger, result.error);
        return result;
    });
}

Napi::Value OpenShared(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected: deviceUid")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string uid = info[0].As<Napi::String>().Utf8Value();
    return RunOnControlThread(env, "puros-open-shared", [uid] {
        OpResult result;
        result.success = engine.openShared(uid, result.error);
        return result;
    });
}

Napi::Value PlayFile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected: filePath")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    const bool allowResample = info.Length() >= 2 && info[1].IsBoolean() && info[1].As<Napi::Boolean>().Value();
    const bool deemphasis = info.Length() >= 3 && info[2].IsBoolean() && info[2].As<Napi::Boolean>().Value();
    const uint32_t dsdOutputRate = info.Length() >= 4 && info[3].IsNumber() ? info[3].As<Napi::Number>().Uint32Value() : 0;
    const RestoreSourceClass sourceHint = info.Length() >= 5 ? ParseRestoreSourceClass(info[4]) : RestoreSourceClass::Unknown;
    const DsdPcmOptions dsdPcm = info.Length() >= 6 ? ParseDsdPcmOptions(info[5]) : DsdPcmOptions{};
    return RunOnControlThread(env, "puros-play-file", [path, allowResample, deemphasis, dsdOutputRate, sourceHint, dsdPcm] {
        OpResult result;
        result.success = engine.playFile(path, allowResample, deemphasis, dsdOutputRate, sourceHint, dsdPcm, result.error);
        return result;
    });
}

Napi::Value StartPcmStream(const Napi::CallbackInfo& info) {
    return RunOnControlThread(info.Env(), "puros-start-pcm", [] {
        OpResult result;
        result.success = engine.startPcmStream(result.error);
        return result;
    });
}

Napi::Value QueueNextFile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected: filePath")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    const bool allowResample = info.Length() >= 2 && info[1].IsBoolean() && info[1].As<Napi::Boolean>().Value();
    const bool deemphasis = info.Length() >= 3 && info[2].IsBoolean() && info[2].As<Napi::Boolean>().Value();
    const uint32_t dsdOutputRate = info.Length() >= 4 && info[3].IsNumber() ? info[3].As<Napi::Number>().Uint32Value() : 0;
    const RestoreSourceClass sourceHint = info.Length() >= 5 ? ParseRestoreSourceClass(info[4]) : RestoreSourceClass::Unknown;
    const DsdPcmOptions dsdPcm = info.Length() >= 6 ? ParseDsdPcmOptions(info[5]) : DsdPcmOptions{};
    return RunOnControlThread(env, "puros-queue-file", [path, allowResample, deemphasis, dsdOutputRate, sourceHint, dsdPcm] {
        OpResult result;
        result.success = engine.queueNextFile(path, allowResample, deemphasis, dsdOutputRate, sourceHint, dsdPcm, result.error);
        return result;
    });
}

Napi::Value ClearQueuedFile(const Napi::CallbackInfo& info) {
    return RunOnControlThread(info.Env(), "puros-clear-queued", [] {
        engine.clearQueuedFile();
        return OpResult{};
    }, true);
}

Napi::Value StopPlayback(const Napi::CallbackInfo& info) {
    return RunOnControlThread(info.Env(), "puros-stop", [] {
        engine.stopPlayback();
        cachedPosition.store(0.0, std::memory_order_relaxed);
        return OpResult{};
    }, true);
}

Napi::Value Pause(const Napi::CallbackInfo& info) {
    engine.pause();
    return info.Env().Undefined();
}

Napi::Value Resume(const Napi::CallbackInfo& info) {
    engine.resume();
    return info.Env().Undefined();
}

Napi::Value Seek(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsNumber()) return info.Env().Undefined();
    const double position = info[0].As<Napi::Number>().DoubleValue();
    // Report the target right away; the engine catches up on the control thread.
    cachedPosition.store(position, std::memory_order_relaxed);
    return RunOnControlThread(info.Env(), "puros-seek", [position] {
        engine.seek(position);
        return OpResult{};
    }, true);
}

Napi::Value WriteBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected a Buffer").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    // A stream being (re)started on the control thread has no slot to feed yet.
    std::shared_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
    if (!lock.owns_lock()) return env.Undefined();
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    engine.write(buf.Data(), buf.Length());
    return env.Undefined();
}

Napi::Value GetMode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    switch (engine.getMode()) {
    case AudioMode::Exclusive: return Napi::String::New(env, "exclusive");
    case AudioMode::Shared: return Napi::String::New(env, "shared");
    default: return Napi::String::New(env, "closed");
    }
}

Napi::Value GetPosition(const Napi::CallbackInfo& info) {
    std::shared_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
    if (lock.owns_lock()) cachedPosition.store(engine.getPosition(), std::memory_order_relaxed);
    return Napi::Number::New(info.Env(), cachedPosition.load(std::memory_order_relaxed));
}

Napi::Value GetDuration(const Napi::CallbackInfo& info) {
    std::shared_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
    if (lock.owns_lock()) cachedDuration.store(engine.getDuration(), std::memory_order_relaxed);
    return Napi::Number::New(info.Env(), cachedDuration.load(std::memory_order_relaxed));
}

Napi::Value IsTrackEnded(const Napi::CallbackInfo& info) {
    std::shared_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
    return Napi::Boolean::New(info.Env(), lock.owns_lock() && engine.isTrackEnded());
}

Napi::Value ConsumeQueuedAdvance(const Napi::CallbackInfo& info) {
    // Also frees the retired slot, so it needs the engine to itself; when busy the
    // advance stays pending and the next poll picks it up.
    std::unique_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
    return Napi::Boolean::New(info.Env(), lock.owns_lock() && engine.consumeQueuedAdvance());
}

Napi::Value GetCurrentFormat(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    DeviceFormat fmt;
    {
        std::shared_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
        std::lock_guard<std::mutex> cacheLock(cachedFormatMutex);
        if (lock.owns_lock()) cachedFormat = engine.getCurrentFormat();
        fmt = cachedFormat;
    }
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("sampleRate", Napi::Number::New(env, fmt.sampleRate));
    obj.Set("bitDepth", Napi::Number::New(env, fmt.bitDepth));
    obj.Set("channels", Napi::Number::New(env, fmt.channels));
    return obj;
}

Napi::Value SetResamplerConfig(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected: resampler config object").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const Napi::Object obj = info[0].As<Napi::Object>();
    const auto number = [](const Napi::Object& source, const char* key, double fallback) {
        const Napi::Value value = source.Get(key);
        return value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : fallback;
    };
    const auto flag = [](const Napi::Object& source, const char* key) {
        const Napi::Value value = source.Get(key);
        return value.IsBoolean() && value.As<Napi::Boolean>().Value();
    };
    const auto text = [&](const char* key) {
        const Napi::Value value = obj.Get(key);
        return value.IsString() ? value.As<Napi::String>().Utf8Value() : std::string();
    };
    const auto filter = [&](const char* key) {
        SoxrFilterConfig config;
        const Napi::Value value = obj.Get(key);
        if (!value.IsObject()) return config;
        const Napi::Object source = value.As<Napi::Object>();
        config.recipe = static_cast<unsigned>(std::clamp(number(source, "recipe", 6), 0.0, 7.0));
        config.precision = number(source, "precision", 0);
        config.phaseResponse = number(source, "phaseResponse", 50);
        config.passbandEnd = number(source, "passbandEnd", 0);
        config.stopbandBegin = number(source, "stopbandBegin", 0);
        config.steepFilter = flag(source, "steepFilter");
        config.allowAliasing = flag(source, "allowAliasing");
        return config;
    };

    const auto fir = [&](const char* key) {
        FirDesign design;
        const Napi::Value value = obj.Get(key);
        if (!value.IsObject()) return design;
        design = ParseFirDesign(value.As<Napi::Object>());
        return design;
    };

    ResamplerConfig config;
    const std::string engineName = text("engine");
    config.engine = engineName == "apple" ? ResamplerEngine::Apple
        : engineName == "fir" ? ResamplerEngine::Fir
        : ResamplerEngine::Soxr;
    config.filter1x = filter("filter1x");
    config.fir1x = fir("fir1x");
    config.firNx = obj.Get("firNx").IsObject() ? fir("firNx") : config.fir1x;
    const Napi::Value convolution = obj.Get("convolution");
    if (convolution.IsObject()) {
        const Napi::Object conv = convolution.As<Napi::Object>();
        const Napi::Value path = conv.Get("path");
        if (path.IsString()) config.convolutionPath = path.As<Napi::String>().Utf8Value();
        config.convolutionGainDb = std::clamp(number(conv, "gainDb", 0), -30.0, 12.0);
        const Napi::Value compensate = conv.Get("compensateDelay");
        config.convolutionCompensateDelay = !compensate.IsBoolean() || compensate.As<Napi::Boolean>().Value();
    }
    config.filterNx = obj.Get("filterNx").IsObject() ? filter("filterNx") : config.filter1x;
    config.headroomDb = std::clamp(number(obj, "headroomDb", 0), 0.0, 12.0);
    const Napi::Value headroomAuto = obj.Get("headroomAuto");
    config.headroomAuto = headroomAuto.IsBoolean() && headroomAuto.As<Napi::Boolean>().Value();
    const std::string modulator = text("modulator");
    config.modulator = modulator == "sdm5" ? ModulatorType::Order5
        : modulator == "sdm7ec" ? ModulatorType::Order7EC
        : ModulatorType::Order7;
    const std::string complexity = text("appleComplexity");
    config.appleComplexity = complexity == "linear" ? kAudioConverterSampleRateConverterComplexity_Linear
        : complexity == "normal" ? kAudioConverterSampleRateConverterComplexity_Normal
        : kAudioConverterSampleRateConverterComplexity_Mastering;
    config.appleQuality = static_cast<uint32_t>(std::clamp(number(obj, "appleQuality", 127), 0.0, 127.0));
    const std::string dither = text("dither");
    config.dither = dither == "none" ? DitherMode::None
        : dither == "gauss" ? DitherMode::Gaussian
        : dither == "shaped" ? DitherMode::NoiseShaped
        : dither == "shaped5" ? DitherMode::NoiseShaped5
        : dither == "shaped9" ? DitherMode::NoiseShaped9
        : DitherMode::Tpdf;
    engine.setResamplerConfig(config);
    return env.Undefined();
}

Napi::Value GetResamplerStatus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    ResamplerStatus status;
    {
        std::shared_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
        std::lock_guard<std::mutex> cacheLock(cachedFormatMutex);
        if (lock.owns_lock()) cachedResamplerStatus = engine.getResamplerStatus();
        status = cachedResamplerStatus;
    }
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("float64", Napi::Boolean::New(env, status.float64));
    obj.Set("sourceBits", Napi::Number::New(env, status.sourceBits));
    obj.Set("sourceFloat", Napi::Boolean::New(env, status.sourceFloat));
    obj.Set("outputBits", Napi::Number::New(env, status.outputBits));
    obj.Set("outputFloat", Napi::Boolean::New(env, status.outputFloat));
    obj.Set("resampling", Napi::Boolean::New(env, status.resampling));
    obj.Set("engine", status.engine.empty() ? env.Null() : Napi::String::New(env, status.engine));
    obj.Set("inputRate", Napi::Number::New(env, status.inputRate));
    obj.Set("outputRate", Napi::Number::New(env, status.outputRate));
    obj.Set("ditherBits", Napi::Number::New(env, status.ditherBits));
    obj.Set("dither", Napi::String::New(env, status.dither.empty() ? "none" : status.dither));
    obj.Set("filter", Napi::String::New(env, status.filter.empty() ? "1x" : status.filter));
    obj.Set("deemphasis", Napi::Boolean::New(env, status.deemphasis));
    obj.Set("headroomDb", Napi::Number::New(env, status.headroomDb));
    obj.Set("headroomAuto", Napi::Boolean::New(env, status.headroomAuto));
    obj.Set("peakDb", Napi::Number::New(env, status.peakDb));
    obj.Set("clippedSamples", Napi::Number::New(env, static_cast<double>(status.clippedSamples)));
    obj.Set("firTaps", Napi::Number::New(env, static_cast<double>(status.firTaps)));
    obj.Set("convolutionTaps", Napi::Number::New(env, static_cast<double>(status.convolutionTaps)));
    obj.Set("convolutionError", status.convolutionError.empty() ? env.Null() : Napi::String::New(env, status.convolutionError));
    obj.Set("dsdOutputRate", Napi::Number::New(env, status.dsdOutputRate));
    obj.Set("modulator", status.modulator.empty() ? env.Null() : Napi::String::New(env, status.modulator));
    obj.Set("modulatorOverloads", Napi::Number::New(env, static_cast<double>(status.modulatorOverloads)));
    obj.Set("dsdSourceRate", Napi::Number::New(env, status.dsdSourceRate));
    obj.Set("dsdStages", Napi::Number::New(env, status.dsdStages));
    obj.Set("dsdFilterHz", Napi::Number::New(env, status.dsdFilterHz));
    obj.Set("dsdGainDb", Napi::Number::New(env, status.dsdGainDb));
    return obj;
}

// FIR design preview for the settings UI (runs off the JS thread; designs are cached).
Napi::Value PreviewFirFilter(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "Expected: design, inputRate, outputRate").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const FirDesign design = ParseFirDesign(info[0].As<Napi::Object>());
    const double inputRate = info[1].As<Napi::Number>().DoubleValue();
    const double outputRate = info[2].As<Napi::Number>().DoubleValue();
    struct Result { bool ok = false; std::string error; FirResponse response; };
    return RunInBackground<Result>(env, "puros-fir-preview",
        [design, inputRate, outputRate] {
            Result result;
            result.ok = analyzeFirDesign(design, inputRate, outputRate, result.response, result.error);
            return result;
        },
        [](Napi::Env callEnv, const Result& result) -> Napi::Value {
            Napi::Object obj = Napi::Object::New(callEnv);
            obj.Set("success", Napi::Boolean::New(callEnv, result.ok));
            if (!result.ok) {
                obj.Set("error", Napi::String::New(callEnv, result.error));
                return obj;
            }
            const auto toArray = [&](const std::vector<double>& values) {
                Napi::Float64Array array = Napi::Float64Array::New(callEnv, values.size());
                std::copy(values.begin(), values.end(), array.Data());
                return array;
            };
            const FirResponse& r = result.response;
            obj.Set("frequencies", toArray(r.frequencies));
            obj.Set("magnitudeDb", toArray(r.magnitudeDb));
            obj.Set("impulse", toArray(r.impulse));
            obj.Set("impulseSampleRate", Napi::Number::New(callEnv, r.impulseSampleRate));
            obj.Set("impulsePeakIndex", Napi::Number::New(callEnv, static_cast<double>(r.impulsePeakIndex)));
            obj.Set("taps", Napi::Number::New(callEnv, static_cast<double>(r.taps)));
            obj.Set("lengthMs", Napi::Number::New(callEnv, r.lengthMs));
            obj.Set("passbandEdgeHz", Napi::Number::New(callEnv, r.passbandEdgeHz));
            obj.Set("minus3DbHz", Napi::Number::New(callEnv, r.minus3DbHz));
            obj.Set("attenuationAtNyquistDb", Napi::Number::New(callEnv, r.attenuationAtNyquistDb));
            obj.Set("preRingingMs", Napi::Number::New(callEnv, r.preRingingMs));
            return obj;
        });
}

// Room-correction impulse response header/peak (settings UI).
Napi::Value InspectImpulseResponse(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected: path").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const std::string path = info[0].As<Napi::String>().Utf8Value();
    struct Result { bool ok = false; std::string error; ImpulseResponseInfo info; };
    return RunInBackground<Result>(env, "puros-ir-inspect",
        [path] {
            Result result;
            result.ok = inspectImpulseResponse(path, result.info, result.error);
            return result;
        },
        [](Napi::Env callEnv, const Result& result) -> Napi::Value {
            Napi::Object obj = Napi::Object::New(callEnv);
            obj.Set("success", Napi::Boolean::New(callEnv, result.ok));
            if (!result.ok) {
                obj.Set("error", Napi::String::New(callEnv, result.error));
                return obj;
            }
            obj.Set("channels", Napi::Number::New(callEnv, result.info.channels));
            obj.Set("sampleRate", Napi::Number::New(callEnv, result.info.sampleRate));
            obj.Set("taps", Napi::Number::New(callEnv, static_cast<double>(result.info.taps)));
            obj.Set("peakIndex", Napi::Number::New(callEnv, static_cast<double>(result.info.peakIndex)));
            obj.Set("peakDb", Napi::Number::New(callEnv, result.info.peakDb));
            return obj;
        });
}

Napi::Value GetVisualizerSnapshot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto snapshot = engine.getVisualizerSnapshot();
    Napi::Object obj = Napi::Object::New(env);

    const auto addSamples = [&](const char* key, const std::array<float, VisualizerBuffer::size>& samples) {
        Napi::ArrayBuffer buffer = Napi::ArrayBuffer::New(env, samples.size() * sizeof(float));
        std::memcpy(buffer.Data(), samples.data(), samples.size() * sizeof(float));
        obj.Set(key, Napi::Float32Array::New(env, samples.size(), buffer, 0));
    };
    addSamples("left", snapshot.left);
    addSamples("right", snapshot.right);
    obj.Set("sampleRate", Napi::Number::New(env, snapshot.sampleRate));
    obj.Set("valid", Napi::Boolean::New(env, snapshot.valid));
    obj.Set("peak", Napi::Number::New(env, snapshot.peak));
    obj.Set("rms", Napi::Number::New(env, snapshot.rms));
    obj.Set("paused", Napi::Boolean::New(env, snapshot.paused));
    obj.Set("active", Napi::Boolean::New(env, snapshot.active));
    return obj;
}

Napi::Value GetProcessingStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto stats = engine.getProcessingStats();
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("speed", Napi::Number::New(env, stats.speed));
    obj.Set("active", Napi::Boolean::New(env, stats.active));
    return obj;
}

Napi::Value SetEQProfile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected: bands[], preampGainDb")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto bandsArr = info[0].As<Napi::Array>();
    double preampGainDb = info[1].As<Napi::Number>().DoubleValue();

    std::vector<EQBand> bands;
    bands.reserve(bandsArr.Length());
    for (uint32_t i = 0; i < bandsArr.Length(); i++) {
        auto obj = bandsArr.Get(i).As<Napi::Object>();
        EQBand band;
        band.type = obj.Get("type").As<Napi::String>().Utf8Value();
        band.freq = obj.Get("freq").As<Napi::Number>().DoubleValue();
        band.gain = obj.Get("gain").As<Napi::Number>().DoubleValue();
        band.q    = obj.Get("q").As<Napi::Number>().DoubleValue();
        bands.push_back(band);
    }

    engine.setEQProfile(bands, preampGainDb);
    return env.Undefined();
}

Napi::Value SetCrossfeed(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected: enabled, cutoffFrequency, feedLevelDb")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const bool enabled = info[0].As<Napi::Boolean>().Value();
    const double cutoffFrequency = info[1].As<Napi::Number>().DoubleValue();
    const double feedLevelDb = info[2].As<Napi::Number>().DoubleValue();

    engine.setCrossfeed(enabled, cutoffFrequency, feedLevelDb);
    return env.Undefined();
}

Napi::Value SetRestoreConfig(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected: restore config object").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const Napi::Object obj = info[0].As<Napi::Object>();
    const auto text = [&obj](const char* key) {
        const Napi::Value value = obj.Get(key);
        return value.IsString() ? value.As<Napi::String>().Utf8Value() : std::string();
    };
    const auto flag = [&obj](const char* key, bool fallback) {
        const Napi::Value value = obj.Get(key);
        return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
    };
    RestoreConfig config;
    const std::string mode = text("mode");
    config.mode = mode == "manual" ? RestoreMode::Manual : mode == "auto" ? RestoreMode::Auto : RestoreMode::Off;
    const std::string profile = text("profile");
    config.profile = profile == "natural" ? RestoreProfile::Natural
        : profile == "detailed" ? RestoreProfile::Detailed
        : RestoreProfile::Adaptive;
    const Napi::Value strength = obj.Get("strength");
    const double value = strength.IsNumber() ? strength.As<Napi::Number>().DoubleValue() : 0.3;
    config.strength = std::isfinite(value) ? std::clamp(value, 0.0, 1.0) : 0.3;
    config.artifactReduction = flag("artifactReduction", true);
    config.hfReconstruction = flag("hfReconstruction", true);
    config.transientRestoration = flag("transientRestoration", true);
    config.position = text("position") == "afterDsp" ? RestorePosition::AfterDsp : RestorePosition::Source;
    engine.setRestoreConfig(config);
    return env.Undefined();
}

Napi::Value GetRestoreStatus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    RestoreEngineStatus status;
    {
        std::shared_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
        std::lock_guard<std::mutex> cacheLock(cachedFormatMutex);
        if (lock.owns_lock()) cachedRestoreStatus = engine.getRestoreStatus();
        status = cachedRestoreStatus;
    }
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("mode", Napi::String::New(env, status.mode));
    obj.Set("state", Napi::String::New(env, status.state));
    obj.Set("reason", Napi::String::New(env, status.reason));
    obj.Set("sourceClass", Napi::String::New(env, status.sourceClass));
    obj.Set("codec", status.codec.empty() ? env.Null() : Napi::String::New(env, status.codec));
    obj.Set("position", Napi::String::New(env, status.position));
    obj.Set("cutoffHz", Napi::Number::New(env, status.cutoffHz));
    obj.Set("confidence", Napi::Number::New(env, status.confidence));
    obj.Set("severity", Napi::Number::New(env, status.severity));
    obj.Set("mix", Napi::Number::New(env, status.mix));
    obj.Set("latencyMs", Napi::Number::New(env, status.latencyMs));
    obj.Set("sampleRate", Napi::Number::New(env, status.sampleRate));
    return obj;
}

Napi::Value SetPcmStreamSourceClass(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const RestoreSourceClass sourceClass = info.Length() >= 1 ? ParseRestoreSourceClass(info[0]) : RestoreSourceClass::Unknown;
    const std::string codec = info.Length() >= 2 && info[1].IsString() ? info[1].As<Napi::String>().Utf8Value() : "";
    // Serialized after startPcmStream, so it always reaches the stream it describes.
    return RunOnControlThread(env, "puros-pcm-source", [sourceClass, codec] {
        engine.setPcmStreamSourceClass(sourceClass, codec);
        return OpResult{};
    }, true);
}

Napi::Value ProbePlugin(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected plug-in path").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    try {
        return Napi::String::New(env, PluginRack::probe(info[0].As<Napi::String>().Utf8Value()));
    } catch (const std::exception& error) {
        Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
        return env.Undefined();
    }
}

Napi::Value SetPlugins(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected plug-in array").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::vector<PluginSpec> specs;
    auto array = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < array.Length(); ++i) {
        auto item = array.Get(i).As<Napi::Object>();
        PluginSpec spec;
        spec.path = item.Get("path").As<Napi::String>().Utf8Value();
        spec.name = item.Get("name").As<Napi::String>().Utf8Value();
        spec.enabled = item.Get("enabled").As<Napi::Boolean>().Value();
        auto rawParams = item.Get("parameters");
        if (rawParams.IsObject()) {
            auto params = rawParams.As<Napi::Object>();
            auto keys = params.GetPropertyNames();
            for (uint32_t j = 0; j < keys.Length(); ++j) {
                auto key = keys.Get(j).As<Napi::String>().Utf8Value();
                auto value = params.Get(key);
                char* end = nullptr;
                unsigned long id = std::strtoul(key.c_str(), &end, 10);
                if (end && *end == '\0' && end != key.c_str() && id <= UINT32_MAX &&
                    value.IsNumber()) {
                    double normalized = value.As<Napi::Number>().DoubleValue();
                    if (std::isfinite(normalized))
                        spec.parameters.emplace_back(static_cast<uint32_t>(id), normalized);
                }
            }
        }
        specs.push_back(std::move(spec));
    }
    std::string error;
    if (!engine.setPlugins(specs, error))
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
}

Napi::Value GetPluginParameters(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) return Napi::Array::New(env);
    try {
        auto parameters = engine.getPluginParameters(info[0].As<Napi::Number>().Uint32Value());
        auto result = Napi::Array::New(env, parameters.size());
        for (size_t i = 0; i < parameters.size(); ++i) {
            auto param = Napi::Object::New(env);
            param.Set("id", Napi::Number::New(env, parameters[i].id));
            param.Set("name", Napi::String::New(env, parameters[i].name));
            param.Set("value", Napi::Number::New(env, parameters[i].value));
            param.Set("display", Napi::String::New(env, parameters[i].display));
            result.Set(i, param);
        }
        return result;
    } catch (const std::exception& error) {
        Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
        return env.Undefined();
    }
}

Napi::Value SetPluginParameter(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "Expected plug-in index, parameter ID, value").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string error;
    if (!engine.setPluginParameter(info[0].As<Napi::Number>().Uint32Value(),
                                   info[1].As<Napi::Number>().Uint32Value(),
                                   info[2].As<Napi::Number>().DoubleValue(), error))
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
}

Napi::Value OpenPluginEditor(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected plug-in index").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::shared_lock<std::shared_mutex> lock(engineStateMutex, std::try_to_lock);
    if (!lock.owns_lock()) {
        Napi::Error::New(env, "Audio output is busy; try again in a moment").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string error;
    if (!engine.openPluginEditor(info[0].As<Napi::Number>().Uint32Value(),
        [](size_t index, uint32_t id, double value) {
            if (!std::isfinite(value)) return;
            value = std::clamp(value, 0.0, 1.0);
            std::string error;
            if (engine.setPluginParameter(index, id, value, error))
                EmitPluginChangeToJs(index, id, value);
        },
        [](size_t index) { EmitPluginDisableToJs(index); }, error))
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
}

Napi::Value RegisterPluginChangeHandler(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::lock_guard<std::mutex> lock(pluginChangeMutex);
    if (pluginChangeTsfn) { pluginChangeTsfn.Release(); pluginChangeTsfn = {}; }
    pluginChangeTsfn = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "PurosPluginChangeHandler", 0, 1);
    return env.Undefined();
}

Napi::Value RegisterPluginDisableHandler(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::lock_guard<std::mutex> lock(pluginDisableMutex);
    if (pluginDisableTsfn) { pluginDisableTsfn.Release(); pluginDisableTsfn = {}; }
    pluginDisableTsfn = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "PurosPluginDisableHandler", 0, 1);
    return env.Undefined();
}

Napi::Value SetEQEnabled(const Napi::CallbackInfo& info) {
    if (info.Length() < 1) return info.Env().Undefined();
    engine.setEQEnabled(info[0].As<Napi::Boolean>().Value());
    return info.Env().Undefined();
}

Napi::Value GetEQEnabled(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), engine.getEQEnabled());
}

Napi::Value ClearEQProfile(const Napi::CallbackInfo& info) {
    engine.clearEQProfile();
    return info.Env().Undefined();
}

Napi::Value SetVolume(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsNumber()) return info.Env().Undefined();
    float gain = static_cast<float>(info[0].As<Napi::Number>().DoubleValue());
    return RunOnControlThread(info.Env(), "puros-set-volume", [gain] {
        engine.setVolume(gain);
        return OpResult{};
    }, true);
}

Napi::Value SetDigitalVolume(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsNumber()) return info.Env().Undefined();
    engine.setDigitalVolume(info[0].As<Napi::Number>().DoubleValue());
    return info.Env().Undefined();
}

Napi::Value SetHardwareBufferOptions(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsBoolean() || !info[2].IsBoolean()) {
        Napi::TypeError::New(env, "Expected: deviceUid, useMax, powerOfTwo").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    engine.setHardwareBufferOptions(info[0].As<Napi::String>().Utf8Value(),
                                    info[1].As<Napi::Boolean>().Value(),
                                    info[2].As<Napi::Boolean>().Value());
    return env.Undefined();
}

Napi::Value GetHardwareVolume(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object obj = Napi::Object::New(env);
    HardwareVolumeInfo volume;
    if (info.Length() >= 1 && info[0].IsString()) {
        volume = engine.getHardwareVolume(info[0].As<Napi::String>().Utf8Value());
    }
    obj.Set("supported", Napi::Boolean::New(env, volume.supported));
    obj.Set("scalar", Napi::Number::New(env, volume.scalar));
    obj.Set("decibels", volume.hasDecibels ? Napi::Number::New(env, volume.decibels) : env.Null());
    obj.Set("minDecibels", volume.hasDecibels ? Napi::Number::New(env, volume.minDecibels) : env.Null());
    obj.Set("maxDecibels", volume.hasDecibels ? Napi::Number::New(env, volume.maxDecibels) : env.Null());
    obj.Set("muteSupported", Napi::Boolean::New(env, volume.muteSupported));
    obj.Set("muted", Napi::Boolean::New(env, volume.muted));
    return obj;
}

Napi::Value SetHardwareVolume(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    std::string error = "Invalid arguments";
    bool ok = false;
    if (info.Length() >= 2 && info[0].IsString() && info[1].IsNumber()) {
        ok = engine.setHardwareVolume(info[0].As<Napi::String>().Utf8Value(),
                                      info[1].As<Napi::Number>().DoubleValue(), error);
    }
    result.Set("success", Napi::Boolean::New(env, ok));
    if (!ok) result.Set("error", Napi::String::New(env, error));
    return result;
}

Napi::Value SetHardwareMute(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    std::string error = "Invalid arguments";
    bool ok = false;
    if (info.Length() >= 2 && info[0].IsString() && info[1].IsBoolean()) {
        ok = engine.setHardwareMute(info[0].As<Napi::String>().Utf8Value(),
                                    info[1].As<Napi::Boolean>().Value(), error);
    }
    result.Set("success", Napi::Boolean::New(env, ok));
    if (!ok) result.Set("error", Napi::String::New(env, error));
    return result;
}

Napi::Value Close(const Napi::CallbackInfo& info) {
    return RunOnControlThread(info.Env(), "puros-close", [] {
        engine.close();
        cachedPosition.store(0.0, std::memory_order_relaxed);
        return OpResult{};
    }, true);
}

// Synchronous close for app shutdown, where a Promise would never settle.
Napi::Value CloseSync(const Napi::CallbackInfo& info) {
    std::unique_lock<std::shared_mutex> lock(engineStateMutex);
    engine.close();
    return info.Env().Undefined();
}

Napi::Value SetNowPlayingInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected now playing payload object")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object obj = info[0].As<Napi::Object>();
    NowPlayingInfoPayload payload;

    payload.title = obj.Has("title") ? obj.Get("title").ToString().Utf8Value() : "";
    payload.artist = obj.Has("artist") ? obj.Get("artist").ToString().Utf8Value() : "";
    payload.album = obj.Has("album") ? obj.Get("album").ToString().Utf8Value() : "";
    payload.duration = obj.Has("duration") ? obj.Get("duration").ToNumber().DoubleValue() : 0;
    payload.position = obj.Has("position") ? obj.Get("position").ToNumber().DoubleValue() : 0;
    payload.artworkMimeType = obj.Has("artworkMimeType")
        ? obj.Get("artworkMimeType").ToString().Utf8Value()
        : "";

    if (obj.Has("artworkData")) {
        Napi::Value artworkValue = obj.Get("artworkData");
        if (artworkValue.IsBuffer()) {
            Napi::Buffer<uint8_t> artworkBuffer = artworkValue.As<Napi::Buffer<uint8_t>>();
            payload.artworkData.assign(
                artworkBuffer.Data(),
                artworkBuffer.Data() + artworkBuffer.Length()
            );
        }
    }

    nowPlayingBridge.updateNowPlaying(payload);
    return env.Undefined();
}

Napi::Value UpdateNowPlayingPlaybackState(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected: state, position, duration")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const std::string state = info[0].As<Napi::String>().Utf8Value();
    const double position = info[1].As<Napi::Number>().DoubleValue();
    const double duration = info[2].As<Napi::Number>().DoubleValue();

    nowPlayingBridge.updatePlaybackState(
        ParseNowPlayingPlaybackState(state),
        position,
        duration
    );
    return env.Undefined();
}

Napi::Value ClearNowPlayingInfo(const Napi::CallbackInfo& info) {
    nowPlayingBridge.clear();
    return info.Env().Undefined();
}

Napi::Value RegisterRemoteCommandHandler(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected a callback function")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::lock_guard<std::mutex> lock(remoteCommandMutex);
    if (remoteCommandTsfn) {
        remoteCommandTsfn.Release();
        remoteCommandTsfn = {};
    }

    remoteCommandTsfn = Napi::ThreadSafeFunction::New(
        env,
        info[0].As<Napi::Function>(),
        "PurosRemoteCommandHandler",
        0,
        1
    );

    nowPlayingBridge.setRemoteCommandHandler([](const std::string& command) {
        EmitRemoteCommandToJs(command);
    });

    return env.Undefined();
}

// Returns the UID string of the current system default output device.
// Used by the main process for Bluetooth detection without a full listDevices() call.
Napi::Value GetDefaultOutputDeviceUid(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    AudioDeviceID defaultDev = kAudioObjectUnknown;
    UInt32 size = sizeof(AudioDeviceID);
    AudioObjectPropertyAddress prop = {kAudioHardwarePropertyDefaultOutputDevice,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &prop, 0, nullptr, &size,
                                    &defaultDev) != noErr || defaultDev == kAudioObjectUnknown) {
        return env.Null();
    }

    CFStringRef uidRef = nullptr;
    UInt32 us = sizeof(CFStringRef);
    AudioObjectPropertyAddress uidProp = {kAudioDevicePropertyDeviceUID,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(defaultDev, &uidProp, 0, nullptr, &us, &uidRef) != noErr
        || !uidRef) {
        return env.Null();
    }
    char buf[256];
    CFStringGetCString(uidRef, buf, sizeof(buf), kCFStringEncodingUTF8);
    CFRelease(uidRef);
    return Napi::String::New(env, buf);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("listDevices", Napi::Function::New(env, ListDevices));
    exports.Set("openExclusive", Napi::Function::New(env, OpenExclusive));
    exports.Set("openShared", Napi::Function::New(env, OpenShared));
    exports.Set("playFile", Napi::Function::New(env, PlayFile));
    exports.Set("startPcmStream", Napi::Function::New(env, StartPcmStream));
    exports.Set("queueNextFile", Napi::Function::New(env, QueueNextFile));
    exports.Set("clearQueuedFile", Napi::Function::New(env, ClearQueuedFile));
    exports.Set("stopPlayback", Napi::Function::New(env, StopPlayback));
    exports.Set("pause", Napi::Function::New(env, Pause));
    exports.Set("resume", Napi::Function::New(env, Resume));
    exports.Set("seek", Napi::Function::New(env, Seek));
    exports.Set("write", Napi::Function::New(env, WriteBuffer));
    exports.Set("getMode", Napi::Function::New(env, GetMode));
    exports.Set("getPosition", Napi::Function::New(env, GetPosition));
    exports.Set("getDuration", Napi::Function::New(env, GetDuration));
    exports.Set("isTrackEnded", Napi::Function::New(env, IsTrackEnded));
    exports.Set("consumeQueuedAdvance", Napi::Function::New(env, ConsumeQueuedAdvance));
    exports.Set("getCurrentFormat", Napi::Function::New(env, GetCurrentFormat));
    exports.Set("setResamplerConfig", Napi::Function::New(env, SetResamplerConfig));
    exports.Set("getResamplerStatus", Napi::Function::New(env, GetResamplerStatus));
    exports.Set("previewFirFilter", Napi::Function::New(env, PreviewFirFilter));
    exports.Set("inspectImpulseResponse", Napi::Function::New(env, InspectImpulseResponse));
    exports.Set("getVisualizerSnapshot", Napi::Function::New(env, GetVisualizerSnapshot));
    exports.Set("getProcessingStats", Napi::Function::New(env, GetProcessingStats));
    exports.Set("setVolume", Napi::Function::New(env, SetVolume));
    exports.Set("setDigitalVolume", Napi::Function::New(env, SetDigitalVolume));
    exports.Set("getHardwareVolume", Napi::Function::New(env, GetHardwareVolume));
    exports.Set("setHardwareVolume", Napi::Function::New(env, SetHardwareVolume));
    exports.Set("setHardwareMute", Napi::Function::New(env, SetHardwareMute));
    exports.Set("setHardwareBufferOptions", Napi::Function::New(env, SetHardwareBufferOptions));
    exports.Set("setEQProfile", Napi::Function::New(env, SetEQProfile));
    exports.Set("setCrossfeed", Napi::Function::New(env, SetCrossfeed));
    exports.Set("probePlugin", Napi::Function::New(env, ProbePlugin));
    exports.Set("setPlugins", Napi::Function::New(env, SetPlugins));
    exports.Set("getPluginParameters", Napi::Function::New(env, GetPluginParameters));
    exports.Set("setPluginParameter", Napi::Function::New(env, SetPluginParameter));
    exports.Set("openPluginEditor", Napi::Function::New(env, OpenPluginEditor));
    exports.Set("registerPluginChangeHandler", Napi::Function::New(env, RegisterPluginChangeHandler));
    exports.Set("registerPluginDisableHandler", Napi::Function::New(env, RegisterPluginDisableHandler));
    exports.Set("setEQEnabled", Napi::Function::New(env, SetEQEnabled));
    exports.Set("getEQEnabled", Napi::Function::New(env, GetEQEnabled));
    exports.Set("clearEQProfile", Napi::Function::New(env, ClearEQProfile));
    exports.Set("setRestoreConfig", Napi::Function::New(env, SetRestoreConfig));
    exports.Set("getRestoreStatus", Napi::Function::New(env, GetRestoreStatus));
    exports.Set("setPcmStreamSourceClass", Napi::Function::New(env, SetPcmStreamSourceClass));
    exports.Set("close", Napi::Function::New(env, Close));
    exports.Set("closeSync", Napi::Function::New(env, CloseSync));
    exports.Set("getDefaultOutputDeviceUid", Napi::Function::New(env, GetDefaultOutputDeviceUid));
    exports.Set("setNowPlayingInfo", Napi::Function::New(env, SetNowPlayingInfo));
    exports.Set("updateNowPlayingPlaybackState", Napi::Function::New(env, UpdateNowPlayingPlaybackState));
    exports.Set("clearNowPlayingInfo", Napi::Function::New(env, ClearNowPlayingInfo));
    exports.Set("registerRemoteCommandHandler", Napi::Function::New(env, RegisterRemoteCommandHandler));
    return exports;
}

NODE_API_MODULE(puros_audio, Init)
