#include "PluginRack.h"

#import <AppKit/AppKit.h>
#include <CoreFoundation/CoreFoundation.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <map>
#include <mutex>
#include <variant>
#include <stdexcept>
#include <utility>

#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/gui/iplugview.h"

namespace Steinberg {
DEF_CLASS_IID (IPlugView)
DEF_CLASS_IID (IPlugFrame)
}

@interface PuristPluginWindowDelegate : NSObject <NSWindowDelegate>
@property (nonatomic, copy) void (^closeHandler)(void);
@property (nonatomic, copy) void (^bypassHandler)(BOOL bypassed);
@property (nonatomic, copy) void (^cancelHandler)(void);
@property (nonatomic, weak) NSTextField* stateLabel;
@end

@implementation PuristPluginWindowDelegate
- (void)windowWillClose:(NSNotification*)notification {
    if (self.closeHandler) self.closeHandler();
}
- (void)toggleActive:(NSSwitch*)sender {
    const BOOL on = sender.state == NSControlStateValueOn;
    self.stateLabel.stringValue = on ? @"On" : @"Bypassed";
    if (self.bypassHandler) self.bypassHandler(!on);
}
// Closing the window keeps the edits, like the title-bar close button.
- (void)save:(NSButton*)sender {
    NSWindow* window = sender.window;
    [window close];
}
- (void)cancel:(NSButton*)sender {
    NSWindow* window = sender.window;
    PuristPluginWindowDelegate* keepAlive = self;
    if (keepAlive.cancelHandler) keepAlive.cancelHandler();
    [window close];
}
@end

namespace {
using namespace Steinberg;
using namespace Steinberg::Vst;

constexpr uint32_t kBlock = 4096;
// Host controls below the plug-in's own view.
constexpr CGFloat kEditorFooterHeight = 44;
constexpr CGFloat kEditorMinWidth = 320;

NSSize editorContentSize(CGFloat width, CGFloat height) {
    return NSMakeSize(std::max(width, kEditorMinWidth), height + kEditorFooterHeight);
}

NSView* makeEditorFooter(CGFloat width, PuristPluginWindowDelegate* delegate) {
    NSView* footer = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, kEditorFooterHeight)];
    footer.autoresizingMask = NSViewWidthSizable | NSViewMaxYMargin;

    NSBox* separator = [[NSBox alloc] initWithFrame:NSMakeRect(0, kEditorFooterHeight - 1, width, 1)];
    separator.boxType = NSBoxSeparator;
    separator.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    [footer addSubview:separator];

    NSSwitch* toggle = [[NSSwitch alloc] initWithFrame:NSZeroRect];
    toggle.state = NSControlStateValueOn;
    toggle.target = delegate;
    toggle.action = @selector(toggleActive:);
    toggle.toolTip = @"Turn off to bypass this plug-in. Saving while bypassed disables it in the effect stack.";
    [toggle sizeToFit];
    [toggle setFrameOrigin:NSMakePoint(12, std::round((kEditorFooterHeight - NSHeight(toggle.frame)) / 2))];
    [footer addSubview:toggle];

    NSTextField* label = [NSTextField labelWithString:@"Bypassed"];
    [label sizeToFit];
    label.stringValue = @"On";
    [label setFrameOrigin:NSMakePoint(NSMaxX(toggle.frame) + 8,
                                      std::round((kEditorFooterHeight - NSHeight(label.frame)) / 2))];
    [footer addSubview:label];
    delegate.stateLabel = label;

    NSButton* save = [NSButton buttonWithTitle:@"Save" target:delegate action:@selector(save:)];
    save.keyEquivalent = @"\r";
    NSButton* cancel = [NSButton buttonWithTitle:@"Cancel" target:delegate action:@selector(cancel:)];
    cancel.toolTip = @"Revert parameter changes made since this window opened";
    [save sizeToFit];
    [cancel sizeToFit];
    const CGFloat buttonWidth = std::max<CGFloat>(80, std::max(NSWidth(save.frame), NSWidth(cancel.frame)));
    save.frame = NSMakeRect(width - 12 - buttonWidth,
                            std::round((kEditorFooterHeight - NSHeight(save.frame)) / 2),
                            buttonWidth, NSHeight(save.frame));
    cancel.frame = NSMakeRect(NSMinX(save.frame) - 8 - buttonWidth, NSMinY(save.frame),
                              buttonWidth, NSHeight(cancel.frame));
    save.autoresizingMask = cancel.autoresizingMask = NSViewMinXMargin;
    [footer addSubview:cancel];
    [footer addSubview:save];
    return footer;
}

class Bundle {
public:
    explicit Bundle(const std::string& path) : path_(path) {
        std::lock_guard<std::mutex> lock(cacheMutex());
        auto found = cache().find(path);
        if (found != cache().end()) {
            bundle_ = found->second.bundle;
            return;
        }
        auto url = CFURLCreateFromFileSystemRepresentation(
            kCFAllocatorDefault, reinterpret_cast<const UInt8*>(path.data()), path.size(), true);
        if (!url) throw std::runtime_error("Invalid plug-in path");
        bundle_ = CFBundleCreate(kCFAllocatorDefault, url);
        CFRelease(url);
        if (!bundle_ || !CFBundleLoadExecutable(bundle_)) {
            if (bundle_) CFRelease(bundle_);
            throw std::runtime_error("Cannot load plug-in bundle: " + path);
        }
        cache().emplace(path, Record{bundle_, false});
    }
    bool enterVst3() {
        std::lock_guard<std::mutex> lock(cacheMutex());
        auto& record = cache().at(path_);
        if (record.entered) return true;
        auto entry = symbol<bool (*)(CFBundleRef)>("bundleEntry");
        auto exit = symbol<bool (*)()>("bundleExit");
        if (!entry || !exit || !entry(bundle_)) return false;
        record.entered = true;
        return true;
    }
    template<class T> T symbol(const char* name) const {
        auto key = CFStringCreateWithCString(kCFAllocatorDefault, name, kCFStringEncodingASCII);
        auto ptr = CFBundleGetFunctionPointerForName(bundle_, key);
        CFRelease(key);
        return reinterpret_cast<T>(ptr);
    }
private:
    struct Record { CFBundleRef bundle; bool entered; };
    static std::map<std::string, Record>& cache() {
        // Plug-ins may keep workers alive after an instance closes. Keep modules
        // loaded until process exit, and call bundleEntry only once per bundle.
        static auto* records = new std::map<std::string, Record>();
        return *records;
    }
    static std::mutex& cacheMutex() {
        static auto* mutex = new std::mutex();
        return *mutex;
    }
    std::string path_;
    CFBundleRef bundle_ = nullptr;
};

class HostAttributes final : public IAttributeList {
public:
    tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = nullptr;
        if (std::memcmp(iid, IAttributeList::iid, 16) == 0 ||
            std::memcmp(iid, FUnknown::iid, 16) == 0) {
            *obj = static_cast<IAttributeList*>(this); addRef(); return kResultOk;
        }
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return ++refs_; }
    uint32 PLUGIN_API release() override {
        auto n = --refs_; if (!n) delete this; return n;
    }
    tresult PLUGIN_API setInt(AttrID id, int64 value) override {
        if (!id) return kInvalidArgument;
        values_[id] = value; return kResultOk;
    }
    tresult PLUGIN_API getInt(AttrID id, int64& value) override {
        auto it = values_.find(id ? id : "");
        if (it == values_.end() || !std::holds_alternative<int64>(it->second)) return kResultFalse;
        value = std::get<int64>(it->second); return kResultOk;
    }
    tresult PLUGIN_API setFloat(AttrID id, double value) override {
        if (!id) return kInvalidArgument;
        values_[id] = value; return kResultOk;
    }
    tresult PLUGIN_API getFloat(AttrID id, double& value) override {
        auto it = values_.find(id ? id : "");
        if (it == values_.end() || !std::holds_alternative<double>(it->second)) return kResultFalse;
        value = std::get<double>(it->second); return kResultOk;
    }
    tresult PLUGIN_API setString(AttrID id, const TChar* value) override {
        if (!id || !value) return kInvalidArgument;
        values_[id] = std::u16string(reinterpret_cast<const char16_t*>(value)); return kResultOk;
    }
    tresult PLUGIN_API getString(AttrID id, TChar* value, uint32 size) override {
        auto it = values_.find(id ? id : "");
        if (it == values_.end() || !std::holds_alternative<std::u16string>(it->second)) return kResultFalse;
        const auto& str = std::get<std::u16string>(it->second);
        if (!value || size < sizeof(TChar)) return kInvalidArgument;
        auto count = std::min<size_t>(str.size(), size / sizeof(TChar) - 1);
        std::memcpy(value, str.data(), count * sizeof(TChar));
        value[count] = 0;
        return kResultOk;
    }
    tresult PLUGIN_API setBinary(AttrID id, const void* data, uint32 size) override {
        if (!id || (!data && size)) return kInvalidArgument;
        const auto* bytes = static_cast<const uint8_t*>(data);
        values_[id] = size ? std::vector<uint8_t>(bytes, bytes + size) : std::vector<uint8_t>{};
        return kResultOk;
    }
    tresult PLUGIN_API getBinary(AttrID id, const void*& data, uint32& size) override {
        auto it = values_.find(id ? id : "");
        if (it == values_.end() || !std::holds_alternative<std::vector<uint8_t>>(it->second)) {
            data = nullptr; size = 0; return kResultFalse;
        }
        const auto& bytes = std::get<std::vector<uint8_t>>(it->second);
        data = bytes.data(); size = static_cast<uint32>(bytes.size()); return kResultOk;
    }
private:
    std::atomic<uint32> refs_{1};
    std::map<std::string, std::variant<int64, double, std::u16string, std::vector<uint8_t>>> values_;
};

class HostMessage final : public IMessage {
public:
    ~HostMessage() { if (attributes_) attributes_->release(); }
    tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = nullptr;
        if (std::memcmp(iid, IMessage::iid, 16) == 0 ||
            std::memcmp(iid, FUnknown::iid, 16) == 0) {
            *obj = static_cast<IMessage*>(this); addRef(); return kResultOk;
        }
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return ++refs_; }
    uint32 PLUGIN_API release() override {
        auto n = --refs_; if (!n) delete this; return n;
    }
    const char* PLUGIN_API getMessageID() override { return id_.c_str(); }
    void PLUGIN_API setMessageID(const char* id) override { id_ = id ? id : ""; }
    IAttributeList* PLUGIN_API getAttributes() override {
        if (!attributes_) attributes_ = new HostAttributes();
        return attributes_;
    }
private:
    std::atomic<uint32> refs_{1};
    std::string id_;
    HostAttributes* attributes_ = nullptr;
};

class HostContext final : public IHostApplication {
public:
    tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = nullptr;
        if (std::memcmp(iid, IHostApplication::iid, 16) == 0 ||
            std::memcmp(iid, FUnknown::iid, 16) == 0) {
            *obj = static_cast<IHostApplication*>(this);
            addRef();
            return kResultOk;
        }
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return ++refs_; }
    uint32 PLUGIN_API release() override {
        auto n = --refs_;
        if (!n) delete this;
        return n;
    }
    tresult PLUGIN_API getName(String128 name) override {
        const char16_t text[] = u"Puros";
        std::memset(name, 0, 128 * sizeof(TChar));
        std::memcpy(name, text, sizeof(text));
        return kResultOk;
    }
    tresult PLUGIN_API createInstance(TUID cid, TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = nullptr;
        if (std::memcmp(cid, IMessage::iid, 16) == 0 &&
            std::memcmp(iid, IMessage::iid, 16) == 0) {
            *obj = new HostMessage(); return kResultOk;
        }
        if (std::memcmp(cid, IAttributeList::iid, 16) == 0 &&
            std::memcmp(iid, IAttributeList::iid, 16) == 0) {
            *obj = new HostAttributes(); return kResultOk;
        }
        return kNoInterface;
    }
private:
    std::atomic<uint32> refs_{1};
};

class HostHandler final : public IComponentHandler, public IComponentHandler2 {
public:
    void setCallback(std::function<void(ParamID, ParamValue)> callback) {
        callback_ = std::move(callback);
    }
    tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = nullptr;
        if (std::memcmp(iid, IComponentHandler::iid, 16) == 0 ||
            std::memcmp(iid, FUnknown::iid, 16) == 0) {
            *obj = static_cast<IComponentHandler*>(this);
            addRef();
            return kResultOk;
        }
        if (std::memcmp(iid, IComponentHandler2::iid, 16) == 0) {
            *obj = static_cast<IComponentHandler2*>(this);
            addRef();
            return kResultOk;
        }
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return ++refs_; }
    uint32 PLUGIN_API release() override {
        auto n = --refs_;
        if (!n) delete this;
        return n;
    }
    tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
    tresult PLUGIN_API performEdit(ParamID id, ParamValue value) override {
        if (callback_) callback_(id, value);
        return kResultOk;
    }
    tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
    tresult PLUGIN_API restartComponent(int32) override { return kResultOk; }
    tresult PLUGIN_API setDirty(TBool) override { return kResultOk; }
    tresult PLUGIN_API requestOpenEditor(FIDString) override { return kResultOk; }
    tresult PLUGIN_API startGroupEdit() override { return kResultOk; }
    tresult PLUGIN_API finishGroupEdit() override { return kResultOk; }
private:
    std::atomic<uint32> refs_{1};
    std::function<void(ParamID, ParamValue)> callback_;
};

class HostFrame final : public IPlugFrame {
public:
    explicit HostFrame(NSWindow* window) : window_(window) {}
    tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = nullptr;
        if (std::memcmp(iid, IPlugFrame::iid, 16) == 0 ||
            std::memcmp(iid, FUnknown::iid, 16) == 0) {
            *obj = static_cast<IPlugFrame*>(this); addRef(); return kResultOk;
        }
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return ++refs_; }
    uint32 PLUGIN_API release() override {
        auto n = --refs_; if (!n) delete this; return n;
    }
    tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* size) override {
        if (!window_ || !view || !size) return kInvalidArgument;
        const auto width = size->right - size->left;
        const auto height = size->bottom - size->top;
        if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return kInvalidArgument;
        [window_ setContentSize:editorContentSize(width, height)];
        return view->onSize(size);
    }
private:
    std::atomic<uint32> refs_{1};
    NSWindow* window_ = nil;
};

class ConnectionProxy final : public IConnectionPoint {
public:
    explicit ConnectionProxy(IConnectionPoint* source) : source_(source) { source_->addRef(); }
    ~ConnectionProxy() {
        if (destination_) destination_->release();
        source_->release();
    }
    tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = nullptr;
        if (std::memcmp(iid, IConnectionPoint::iid, 16) == 0 ||
            std::memcmp(iid, FUnknown::iid, 16) == 0) {
            *obj = static_cast<IConnectionPoint*>(this);
            addRef();
            return kResultOk;
        }
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return ++refs_; }
    uint32 PLUGIN_API release() override {
        auto n = --refs_;
        if (!n) delete this;
        return n;
    }
    tresult PLUGIN_API connect(IConnectionPoint* other) override {
        if (!other || destination_) return kResultFalse;
        destination_ = other;
        destination_->addRef();
        const auto result = source_->connect(this);
        if (result != kResultOk) {
            destination_->release();
            destination_ = nullptr;
        }
        return result;
    }
    tresult PLUGIN_API disconnect(IConnectionPoint* other) override {
        if (other != destination_) return kInvalidArgument;
        source_->disconnect(this);
        destination_->release();
        destination_ = nullptr;
        return kResultOk;
    }
    tresult PLUGIN_API notify(IMessage* message) override {
        return destination_ ? destination_->notify(message) : kResultFalse;
    }
    void disconnect() { if (destination_) disconnect(destination_); }
private:
    std::atomic<uint32> refs_{1};
    IConnectionPoint* source_;
    IConnectionPoint* destination_ = nullptr;
};

class ParamQueue final : public IParamValueQueue {
public:
    explicit ParamQueue(ParamID id) : id_(id) {}
    ParamQueue(ParamID id, double value) : id_(id) { points_.emplace_back(0, value); }
    tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = std::memcmp(iid, IParamValueQueue::iid, 16) == 0 ||
               std::memcmp(iid, FUnknown::iid, 16) == 0 ? this : nullptr;
        return *obj ? kResultOk : kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return 1; }
    uint32 PLUGIN_API release() override { return 1; }
    ParamID PLUGIN_API getParameterId() override { return id_; }
    int32 PLUGIN_API getPointCount() override { return static_cast<int32>(points_.size()); }
    tresult PLUGIN_API getPoint(int32 index, int32& offset, ParamValue& value) override {
        if (index < 0 || static_cast<size_t>(index) >= points_.size()) return kInvalidArgument;
        offset = points_[index].first; value = points_[index].second; return kResultOk;
    }
    tresult PLUGIN_API addPoint(int32 offset, ParamValue value, int32& index) override {
        if (offset < 0 || !std::isfinite(value)) return kInvalidArgument;
        index = static_cast<int32>(points_.size());
        points_.emplace_back(offset, value);
        return kResultOk;
    }
private:
    ParamID id_;
    std::vector<std::pair<int32, double>> points_;
};

class ParameterChanges final : public IParameterChanges {
public:
    ParameterChanges() = default;
    explicit ParameterChanges(const std::map<ParamID, double>& values) {
        for (const auto& [id, value] : values)
            queues_.push_back(std::make_unique<ParamQueue>(id, value));
    }
    tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
        if (!obj) return kInvalidArgument;
        *obj = std::memcmp(iid, IParameterChanges::iid, 16) == 0 ||
               std::memcmp(iid, FUnknown::iid, 16) == 0 ? this : nullptr;
        return *obj ? kResultOk : kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return 1; }
    uint32 PLUGIN_API release() override { return 1; }
    int32 PLUGIN_API getParameterCount() override { return static_cast<int32>(queues_.size()); }
    IParamValueQueue* PLUGIN_API getParameterData(int32 index) override {
        return index >= 0 && static_cast<size_t>(index) < queues_.size() ? queues_[index].get() : nullptr;
    }
    IParamValueQueue* PLUGIN_API addParameterData(const ParamID& id, int32& index) override {
        for (size_t i = 0; i < queues_.size(); ++i) {
            if (queues_[i]->getParameterId() == id) {
                index = static_cast<int32>(i);
                return queues_[i].get();
            }
        }
        index = static_cast<int32>(queues_.size());
        queues_.push_back(std::make_unique<ParamQueue>(id));
        return queues_.back().get();
    }
private:
    std::vector<std::unique_ptr<ParamQueue>> queues_;
};

std::string utf8Name(const TChar* text, size_t limit = 128) {
    size_t count = 0;
    while (count < limit && text[count]) ++count;
    auto str = CFStringCreateWithCharacters(kCFAllocatorDefault,
        reinterpret_cast<const UniChar*>(text), count);
    if (!str) return {};
    char buffer[512]{};
    const bool ok = CFStringGetCString(str, buffer, sizeof(buffer), kCFStringEncodingUTF8);
    CFRelease(str);
    return ok ? buffer : "";
}

// VST2's binary ABI. The discontinued SDK is not required to host existing bundles.
struct Vst2Effect;
using Vst2Host = intptr_t (*)(Vst2Effect*, int32_t, int32_t, intptr_t, void*, float);
using Vst2Dispatch = intptr_t (*)(Vst2Effect*, int32_t, int32_t, intptr_t, void*, float);
using Vst2Process = void (*)(Vst2Effect*, float**, float**, int32_t);
struct Vst2Effect {
    int32_t magic;
    Vst2Dispatch dispatcher;
    Vst2Process process;
    void (*setParameter)(Vst2Effect*, int32_t, float);
    float (*getParameter)(Vst2Effect*, int32_t);
    int32_t numPrograms, numParams, numInputs, numOutputs, flags;
    intptr_t reserved1, reserved2;
    int32_t initialDelay, realQualities, offQualities;
    float ioRatio;
    void* object;
    void* user;
    int32_t uniqueId, version;
    Vst2Process processReplacing;
    Vst2Process processDoubleReplacing;
    char future[56];
};

intptr_t vst2Host(Vst2Effect* effect, int32_t opcode, int32_t index, intptr_t, void*, float value) {
    if (opcode == 1) return 2400; // audioMasterVersion
    if (opcode == 0 && effect && effect->user && index >= 0) { // audioMasterAutomate
        auto* callback = static_cast<std::function<void(uint32_t, double)>*>(effect->user);
        if (*callback) (*callback)(static_cast<uint32_t>(index), value);
    }
    return 0;
}

struct Vst2Rect { int16_t top, left, bottom, right; };

float readPcm(const uint8_t* p, uint32_t bytes, bool isFloat) {
    if (isFloat) { float v; std::memcpy(&v, p, 4); return v; }
    if (bytes == 2) { int16_t v; std::memcpy(&v, p, 2); return v / 32768.f; }
    if (bytes == 3) {
        int32_t v = p[0] | (p[1] << 8) | (p[2] << 16);
        if (v & 0x800000) v |= static_cast<int32_t>(0xff000000u);
        return v / 8388608.f;
    }
    int32_t v; std::memcpy(&v, p, 4); return static_cast<float>(v / 2147483648.0);
}

void writePcm(uint8_t* p, uint32_t bytes, bool isFloat, float sample) {
    if (!std::isfinite(sample)) sample = 0;
    if (isFloat) { std::memcpy(p, &sample, 4); return; }
    const double v = std::clamp(static_cast<double>(sample), -1.0, 1.0);
    if (bytes == 2) {
        int16_t n = static_cast<int16_t>(std::lrint(v * 32767.0));
        std::memcpy(p, &n, 2);
    } else if (bytes == 3) {
        int32_t n = static_cast<int32_t>(std::lrint(v * 8388607.0));
        p[0] = n & 255; p[1] = (n >> 8) & 255; p[2] = (n >> 16) & 255;
    } else {
        int32_t n = static_cast<int32_t>(std::llrint(v * 2147483647.0));
        std::memcpy(p, &n, 4);
    }
}
} // namespace

class PluginRack::Instance {
public:
    Instance(const PluginSpec& spec, double sampleRate, bool withController = false)
        : bundle_(spec.path), withController_(withController) {
        try {
            const bool vst3 = spec.path.size() >= 5 && spec.path.substr(spec.path.size() - 5) == ".vst3";
            if (vst3) openVst3(sampleRate);
            else openVst2(sampleRate);
            for (const auto& [id, value] : spec.parameters) setParameter(id, value);
        } catch (...) {
            close();
            throw;
        }
    }
    ~Instance() {
        if (PluginRack::activeEditor_ == this) PluginRack::activeEditor_ = nullptr;
        onEditorChange_ = {};
        if (handler_) handler_->setCallback({});
        close();
    }
    bool bypassed() const { return bypassed_.load(std::memory_order_acquire); }
    void openEditor(std::function<void(uint32_t, double)> onChange, std::function<void()> onDisable) {
        if (![NSThread isMainThread])
            throw std::runtime_error("Plug-in editor must open on the main thread");
        if (!NSApp) [NSApplication sharedApplication];
        if (window_) { [window_ makeKeyAndOrderFront:nil]; return; }
        auto callback = std::move(onChange);
        if (!vst2_) ensureController();
        if (vst2_ && !(vst2_->flags & 1))
            throw std::runtime_error("VST plug-in has no editor");
        if (!vst2_ && !controller_)
            throw std::runtime_error("VST3 plug-in has no editor controller");

        window_ = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 600, 400)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
            backing:NSBackingStoreBuffered defer:NO];
        [window_ setReleasedWhenClosed:NO];
        [window_ setTitle:[NSString stringWithUTF8String:name_.c_str()]];
        window_.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        bypassed_.store(false, std::memory_order_release);

        int width = 600, height = 400;
        if (vst2_) {
            if (vst2_->getParameter) {
                for (int32_t i = 0; i < std::min(vst2_->numParams, 1024); ++i)
                    editorValues_[static_cast<uint32_t>(i)] = vst2_->getParameter(vst2_, i);
            }
            Vst2Rect* rect = nullptr;
            vst2_->dispatcher(vst2_, 13, 0, 0, &rect, 0); // effEditGetRect
            if (rect) {
                width = rect->right - rect->left;
                height = rect->bottom - rect->top;
            }
        } else {
            view_ = controller_->createView(ViewType::kEditor);
            if (!view_ || view_->isPlatformTypeSupported(kPlatformTypeNSView) != kResultOk)
                throw std::runtime_error("VST3 plug-in has no macOS editor view");
            snapshotEditorParameters(false);
            ViewRect rect{};
            if (view_->getSize(&rect) == kResultOk) {
                width = rect.right - rect.left;
                height = rect.bottom - rect.top;
            }
        }
        if (width <= 0 || width > 4096 || height <= 0 || height > 4096)
            throw std::runtime_error("Plug-in editor reported an invalid size");

        openValues_ = editorValues_;
        delegate_ = [PuristPluginWindowDelegate new];
        delegate_.closeHandler = ^{ this->editorCommitted(); };
        delegate_.bypassHandler = ^(BOOL bypassed) {
            this->bypassed_.store(bypassed, std::memory_order_release);
        };
        delegate_.cancelHandler = ^{ this->revertEditor(); };
        const NSSize contentSize = editorContentSize(width, height);
        NSView* root = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, contentSize.width, contentSize.height)];
        NSView* editorHost = [[NSView alloc] initWithFrame:NSMakeRect(0, kEditorFooterHeight, contentSize.width, height)];
        editorHost.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [root addSubview:editorHost];
        [root addSubview:makeEditorFooter(contentSize.width, delegate_)];
        [window_ setContentView:root];
        [window_ setContentSize:contentSize];
        [window_ setDelegate:delegate_];
        [window_ center];
        [window_ makeKeyAndOrderFront:nil];
        try {
            if (vst2_) {
                vst2_->dispatcher(vst2_, 14, 0, 0, (__bridge void*)editorHost, 0); // effEditOpen
                vst2EditorOpen_ = true;
            } else {
                frame_ = new HostFrame(window_);
                view_->setFrame(frame_);
                if (view_->attached((__bridge void*)editorHost, kPlatformTypeNSView) != kResultOk)
                    throw std::runtime_error("VST3 editor could not attach to the window");
                viewAttached_ = true;
            }
            onEditorChange_ = std::move(callback);
            onEditorDisable_ = std::move(onDisable);
            if (handler_) handler_->setCallback([this](ParamID id, ParamValue value) {
                forwardEditorParameter(id, value);
            });
            if (controller_) {
                captureOutputChanges_.store(true, std::memory_order_release);
                editorTimer_ = [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES
                    block:^(NSTimer*) {
                        this->applyOutputParameters();
                        this->snapshotEditorParameters(true);
                    }];
            }
            [NSApp activateIgnoringOtherApps:YES];
        } catch (...) {
            closeEditor();
            throw;
        }
    }
    // Host-initiated close (another editor, stack change): bypass is not kept.
    void closeEditor() {
        bypassed_.store(false, std::memory_order_release);
        if (window_) {
            [window_ setDelegate:nil];
            [window_ close];
        }
        editorClosed();
    }
    void close() {
        closeEditor();
        if (componentProxy_) { componentProxy_->disconnect(); componentProxy_->release(); }
        if (controllerProxy_) { controllerProxy_->disconnect(); controllerProxy_->release(); }
        if (componentConnection_) componentConnection_->release();
        if (controllerConnection_) controllerConnection_->release();
        if (controller_) controller_->setComponentHandler(nullptr);
        if (controller_ && controllerInitialized_) controller_->terminate();
        if (controller_) controller_->release();
        if (handler_) handler_->release();
        if (processor_ && processing_) processor_->setProcessing(false);
        if (component_) {
            if (active_) component_->setActive(false);
            if (initialized_) component_->terminate();
        }
        if (processor_) processor_->release();
        if (component_) component_->release();
        if (factory_) factory_->release();
        if (host_) host_->release();
        if (vst2_ && vst2Opened_) {
            vst2_->dispatcher(vst2_, 12, 0, 0, nullptr, 0); // effMainsChanged
            vst2_->dispatcher(vst2_, 1, 0, 0, nullptr, 0);  // effClose
        }
        processor_ = nullptr;
        component_ = nullptr;
        factory_ = nullptr;
        host_ = nullptr;
        vst2_ = nullptr;
        controller_ = nullptr;
        handler_ = nullptr;
        componentConnection_ = nullptr;
        controllerConnection_ = nullptr;
        componentProxy_ = nullptr;
        controllerProxy_ = nullptr;
        processing_ = active_ = initialized_ = vst2Opened_ = false;
        controllerInitialized_ = false;
    }
    void process(float** input, float** output, int32_t frames) {
        if (vst2_) {
            vst2_->processReplacing(vst2_, input, output, frames);
            return;
        }
        AudioBusBuffers in{}, out{};
        in.numChannels = out.numChannels = 2;
        in.channelBuffers32 = input;
        out.channelBuffers32 = output;
        ProcessData data{};
        data.processMode = kRealtime;
        data.symbolicSampleSize = kSample32;
        data.numSamples = frames;
        data.numInputs = data.numOutputs = 1;
        data.inputs = &in;
        data.outputs = &out;
        ParameterChanges changes(pendingParameters_);
        if (!pendingParameters_.empty()) data.inputParameterChanges = &changes;
        ParameterChanges outputChanges;
        const bool captureOutput = captureOutputChanges_.load(std::memory_order_acquire);
        if (captureOutput) data.outputParameterChanges = &outputChanges;
        if (processor_->process(data) != kResultOk)
            throw std::runtime_error("VST3 processing failed");
        pendingParameters_.clear();
        if (captureOutput && outputChanges.getParameterCount() > 0) {
            std::lock_guard<std::mutex> lock(outputParameterMutex_);
            for (int32_t i = 0; i < outputChanges.getParameterCount(); ++i) {
                auto* queue = outputChanges.getParameterData(i);
                if (!queue || queue->getPointCount() <= 0) continue;
                int32_t offset = 0;
                ParamValue value = 0;
                if (queue->getPoint(queue->getPointCount() - 1, offset, value) == kResultOk &&
                    std::isfinite(value))
                    outputParameters_[queue->getParameterId()] = std::clamp(value, 0.0, 1.0);
            }
        }
    }
    void reset() {
        if (processor_) { processor_->setProcessing(false); processor_->setProcessing(true); }
        if (vst2_) { vst2_->dispatcher(vst2_, 12, 0, 0, nullptr, 0); vst2_->dispatcher(vst2_, 12, 0, 1, nullptr, 0); }
    }
    std::string name() const { return name_; }
    std::vector<PluginParameter> parameters() const {
        std::vector<PluginParameter> result;
        if (vst2_) {
            for (int32_t i = 0; i < std::min(vst2_->numParams, 1024); ++i) {
                char name[256]{}, display[256]{}, label[256]{};
                vst2_->dispatcher(vst2_, 8, i, 0, name, 0);
                vst2_->dispatcher(vst2_, 7, i, 0, display, 0);
                vst2_->dispatcher(vst2_, 6, i, 0, label, 0);
                result.push_back({static_cast<uint32_t>(i), name[0] ? name : "Parameter " + std::to_string(i + 1),
                                  vst2_->getParameter ? vst2_->getParameter(vst2_, i) : 0,
                                  std::string(display) + (label[0] ? " " + std::string(label) : "")});
            }
        } else if (controller_) {
            for (int32_t i = 0; i < std::min(controller_->getParameterCount(), 1024); ++i) {
                ParameterInfo info{};
                const auto infoResult = controller_->getParameterInfo(i, info);
                if (infoResult != kResultOk ||
                    (info.flags & ParameterInfo::kIsReadOnly)) continue;
                const double value = controller_->getParamNormalized(info.id);
                String128 display{};
                controller_->getParamStringByValue(info.id, value, display);
                result.push_back({info.id, utf8Name(info.title), value, utf8Name(display)});
            }
        }
        return result;
    }
    void setParameter(uint32_t id, double value) {
        value = std::clamp(value, 0.0, 1.0);
        parameterValues_[id] = value;
        if (vst2_) {
            if (id < static_cast<uint32_t>(vst2_->numParams) && vst2_->setParameter)
                vst2_->setParameter(vst2_, static_cast<int32_t>(id), static_cast<float>(value));
        } else {
            if (controller_) controller_->setParamNormalized(id, value);
            pendingParameters_[id] = value;
        }
    }
private:
    void forwardEditorParameter(uint32_t id, double value) {
        if (applyingOutputParameters_) return;
        if (!std::isfinite(value)) return;
        const double normalized = std::clamp(value, 0.0, 1.0);
        editorValues_[id] = normalized;
        if (onEditorChange_) onEditorChange_(id, normalized);
    }
    void applyOutputParameters() {
        if (!controller_) return;
        std::map<ParamID, double> changes;
        {
            std::lock_guard<std::mutex> lock(outputParameterMutex_);
            changes.swap(outputParameters_);
        }
        applyingOutputParameters_ = true;
        for (const auto& [id, value] : changes)
            controller_->setParamNormalized(id, value);
        applyingOutputParameters_ = false;
    }
    void snapshotEditorParameters(bool forwardChanges) {
        if (!controller_) return;
        const int32_t count = std::min(controller_->getParameterCount(), 1024);
        for (int32_t i = 0; i < count; ++i) {
            ParameterInfo info{};
            if (controller_->getParameterInfo(i, info) != kResultOk ||
                (info.flags & ParameterInfo::kIsReadOnly)) continue;
            const double value = controller_->getParamNormalized(info.id);
            if (!std::isfinite(value)) continue;
            const auto found = editorValues_.find(info.id);
            if (forwardChanges && found != editorValues_.end() &&
                std::abs(found->second - value) > 0.000001)
                forwardEditorParameter(info.id, value);
            else editorValues_[info.id] = value;
        }
    }
    // Save or the title-bar close button. A bypassed plug-in stays silent until
    // the renderer disables it in the stack and the rack is rebuilt.
    void editorCommitted() {
        if (bypassed() && onEditorDisable_) onEditorDisable_();
        else bypassed_.store(false, std::memory_order_release);
        editorClosed();
    }
    void revertEditor() {
        bypassed_.store(false, std::memory_order_release);
        for (const auto& [id, original] : openValues_) {
            double current = original;
            if (vst2_ && vst2_->getParameter) current = vst2_->getParameter(vst2_, static_cast<int32_t>(id));
            else if (controller_) current = controller_->getParamNormalized(id);
            if (std::isfinite(current) && std::abs(current - original) > 0.000001)
                forwardEditorParameter(id, original);
        }
    }
    void editorClosed() {
        captureOutputChanges_.store(false, std::memory_order_release);
        if (editorTimer_) { [editorTimer_ invalidate]; editorTimer_ = nil; }
        if (controller_) snapshotEditorParameters(true);
        if (view_) {
            if (viewAttached_) view_->removed();
            view_->setFrame(nullptr);
            view_->release();
            view_ = nullptr;
        }
        if (frame_) { frame_->release(); frame_ = nullptr; }
        if (vst2_ && vst2EditorOpen_) {
            vst2_->dispatcher(vst2_, 15, 0, 0, nullptr, 0); // effEditClose
            vst2EditorOpen_ = false;
            if (vst2_->getParameter && onEditorChange_) {
                for (const auto& [id, before] : editorValues_) {
                    const double after = vst2_->getParameter(vst2_, static_cast<int32_t>(id));
                    if (std::isfinite(after) && std::abs(after - before) > 0.000001)
                        onEditorChange_(id, after);
                }
            }
        }
        editorValues_.clear();
        openValues_.clear();
        onEditorChange_ = {};
        onEditorDisable_ = {};
        if (handler_) handler_->setCallback({});
        viewAttached_ = false;
        if (delegate_) {
            delegate_.closeHandler = nil;
            delegate_.bypassHandler = nil;
            delegate_.cancelHandler = nil;
        }
        delegate_ = nil;
        window_ = nil;
    }
    void openVst3(double rate) {
        auto getFactory = bundle_.symbol<IPluginFactory* (*)()>("GetPluginFactory");
        if (!getFactory || !bundle_.enterVst3())
            throw std::runtime_error("Invalid VST3 bundle entry");
        factory_ = getFactory();
        if (!factory_) throw std::runtime_error("VST3 has no factory");
        PClassInfo info{};
        bool found = false;
        for (int32_t i = 0; i < factory_->countClasses(); ++i) {
            if (factory_->getClassInfo(i, &info) == kResultOk &&
                std::strcmp(info.category, kVstAudioEffectClass) == 0) {
                found = true; break;
            }
        }
        if (!found) throw std::runtime_error("No audio effect in VST3 bundle");
        name_ = info.name;
        if (factory_->createInstance(info.cid, IComponent::iid,
                                     reinterpret_cast<void**>(&component_)) != kResultOk || !component_)
            throw std::runtime_error("Cannot create VST3 component");
        host_ = new HostContext();
        if (component_->initialize(host_) != kResultOk)
            throw std::runtime_error("Cannot initialize VST3 component");
        initialized_ = true;
        if (component_->queryInterface(IAudioProcessor::iid,
                                       reinterpret_cast<void**>(&processor_)) != kResultOk || !processor_)
            throw std::runtime_error("VST3 component has no audio processor");
        if (component_->getBusCount(kAudio, kInput) != 1 ||
            component_->getBusCount(kAudio, kOutput) != 1 ||
            processor_->canProcessSampleSize(kSample32) != kResultOk)
            throw std::runtime_error("VST3 effect must support stereo float32 input/output");
        SpeakerArrangement arrangement = SpeakerArr::kStereo;
        if (processor_->setBusArrangements(&arrangement, 1, &arrangement, 1) != kResultOk)
            throw std::runtime_error("VST3 effect does not support stereo routing");
        component_->activateBus(kAudio, kInput, 0, true);
        component_->activateBus(kAudio, kOutput, 0, true);
        ProcessSetup setup{kRealtime, kSample32, static_cast<int32_t>(kBlock), rate};
        if (processor_->setupProcessing(setup) != kResultOk)
            throw std::runtime_error("Cannot set up VST3 processing");
        if (component_->setActive(true) != kResultOk)
            throw std::runtime_error("Cannot activate VST3 component");
        active_ = true;
        if (withController_) ensureController();
        // Some compatible plug-ins return kResultFalse here while accepting
        // process calls; Steinberg's reference host also treats it as advisory.
        processor_->setProcessing(true);
        processing_ = true;
    }
    void ensureController() {
        if (controller_ || !component_) return;
        TUID controllerId{};
        const auto controllerResult = component_->getControllerClassId(controllerId);
        if (controllerResult == kResultOk) {
            const auto createResult = factory_->createInstance(controllerId, IEditController::iid,
                                         reinterpret_cast<void**>(&controller_));
            if (createResult == kResultOk && controller_) {
                const auto initResult = controller_->initialize(host_);
                if (initResult == kResultOk) {
                    controllerInitialized_ = true;
                    handler_ = new HostHandler();
                    controller_->setComponentHandler(handler_);
                    component_->queryInterface(IConnectionPoint::iid,
                                                reinterpret_cast<void**>(&componentConnection_));
                    controller_->queryInterface(IConnectionPoint::iid,
                                                 reinterpret_cast<void**>(&controllerConnection_));
                    if (componentConnection_ && controllerConnection_) {
                        componentProxy_ = new ConnectionProxy(componentConnection_);
                        controllerProxy_ = new ConnectionProxy(controllerConnection_);
                        componentProxy_->connect(controllerConnection_);
                        controllerProxy_->connect(componentConnection_);
                    }
                    for (const auto& [id, value] : parameterValues_)
                        controller_->setParamNormalized(id, value);
                }
            }
        } else if (component_->queryInterface(IEditController::iid,
                                              reinterpret_cast<void**>(&controller_)) == kResultOk && controller_) {
            handler_ = new HostHandler();
            controller_->setComponentHandler(handler_);
            for (const auto& [id, value] : parameterValues_)
                controller_->setParamNormalized(id, value);
        }
    }
    void openVst2(double rate) {
        auto entry = bundle_.symbol<Vst2Effect* (*)(Vst2Host)>("VSTPluginMain");
        if (!entry) entry = bundle_.symbol<Vst2Effect* (*)(Vst2Host)>("main_macho");
        if (!entry) throw std::runtime_error("Invalid VST bundle entry");
        auto* effect = entry(vst2Host);
        if (!effect || effect->magic != 0x56737450 || !effect->dispatcher ||
            !effect->processReplacing || effect->numInputs != 2 || effect->numOutputs != 2)
            throw std::runtime_error("VST effect must support stereo replacing processing");
        vst2_ = effect;
        vst2_->user = &onEditorChange_;
        vst2_->dispatcher(vst2_, 0, 0, 0, nullptr, 0); // effOpen
        vst2Opened_ = true;
        char name[256]{};
        vst2_->dispatcher(vst2_, 45, 0, 0, name, 0); // effGetEffectName
        name_ = name[0] ? name : "VST effect";
        vst2_->dispatcher(vst2_, 10, 0, 0, nullptr, static_cast<float>(rate));
        vst2_->dispatcher(vst2_, 11, 0, kBlock, nullptr, 0);
        vst2_->dispatcher(vst2_, 12, 0, 1, nullptr, 0);
    }
    Bundle bundle_;
    IPluginFactory* factory_ = nullptr;
    IComponent* component_ = nullptr;
    IAudioProcessor* processor_ = nullptr;
    IEditController* controller_ = nullptr;
    HostHandler* handler_ = nullptr;
    IConnectionPoint* componentConnection_ = nullptr;
    IConnectionPoint* controllerConnection_ = nullptr;
    ConnectionProxy* componentProxy_ = nullptr;
    ConnectionProxy* controllerProxy_ = nullptr;
    HostContext* host_ = nullptr;
    Vst2Effect* vst2_ = nullptr;
    NSWindow* window_ = nil;
    PuristPluginWindowDelegate* delegate_ = nil;
    NSTimer* editorTimer_ = nil;
    std::atomic<bool> captureOutputChanges_{false};
    bool applyingOutputParameters_ = false;
    std::mutex outputParameterMutex_;
    std::map<ParamID, double> outputParameters_;
    IPlugView* view_ = nullptr;
    HostFrame* frame_ = nullptr;
    bool viewAttached_ = false;
    bool vst2EditorOpen_ = false;
    std::function<void(uint32_t, double)> onEditorChange_;
    std::function<void()> onEditorDisable_;
    std::map<uint32_t, double> editorValues_;
    std::map<uint32_t, double> openValues_;
    std::atomic<bool> bypassed_{false};
    bool initialized_ = false;
    bool active_ = false;
    bool processing_ = false;
    bool vst2Opened_ = false;
    bool controllerInitialized_ = false;
    bool withController_ = false;
    std::map<ParamID, double> pendingParameters_;
    std::map<ParamID, double> parameterValues_;
    std::string name_;
};

PluginRack::Instance* PluginRack::activeEditor_ = nullptr;

PluginRack::PluginRack() = default;
PluginRack::~PluginRack() = default;

void PluginRack::closeEditor() {
    if (activeEditor_) {
        auto* current = activeEditor_;
        activeEditor_ = nullptr;
        current->closeEditor();
    }
}

bool PluginRack::openActiveEditor(size_t specIndex,
                                  std::function<void(uint32_t, double)> onChange,
                                  std::function<void()> onDisable,
                                  std::string& error) {
    for (size_t i = 0; i < instanceSpecIndices_.size(); ++i) {
        if (instanceSpecIndices_[i] != specIndex) continue;
        try {
            instances_[i]->openEditor(std::move(onChange), std::move(onDisable));
            activeEditor_ = instances_[i].get();
            return true;
        } catch (const std::exception& e) {
            error = e.what();
            return false;
        }
    }
    error = "Plug-in is not running on the active PCM track";
    return false;
}

std::string PluginRack::probe(const std::string& path) {
    PluginSpec spec{path, "", true, {}};
    Instance instance(spec, 48000);
    return instance.name();
}

std::vector<PluginParameter> PluginRack::inspect(const PluginSpec& spec, double sampleRate) {
    Instance instance(spec, sampleRate > 0 ? sampleRate : 48000, true);
    auto parameters = instance.parameters();
    for (auto& parameter : parameters) {
        const auto saved = std::find_if(spec.parameters.begin(), spec.parameters.end(),
            [&](const auto& entry) { return entry.first == parameter.id; });
        if (saved != spec.parameters.end()) parameter.value = saved->second;
    }
    return parameters;
}

bool PluginRack::configure(const std::vector<PluginSpec>& specs, double sampleRate,
                           std::string& error) {
    std::vector<std::unique_ptr<Instance>> next;
    std::vector<size_t> nextIndices;
    try {
        if (sampleRate > 0) {
            for (size_t i = 0; i < specs.size(); ++i)
                if (specs[i].enabled) {
                    next.push_back(std::make_unique<Instance>(specs[i], sampleRate));
                    nextIndices.push_back(i);
                }
        }
    } catch (const std::exception& e) {
        error = e.what();
        return false;
    }
    instances_.swap(next);
    instanceSpecIndices_.swap(nextIndices);
    specs_ = specs;
    sampleRate_ = sampleRate;
    return true;
}

bool PluginRack::active() const { return !instances_.empty(); }

bool PluginRack::setParameter(size_t specIndex, uint32_t id, double value, std::string& error) {
    if (specIndex >= specs_.size() || !std::isfinite(value)) {
        error = "Invalid plug-in parameter";
        return false;
    }
    value = std::clamp(value, 0.0, 1.0);
    auto& params = specs_[specIndex].parameters;
    auto found = std::find_if(params.begin(), params.end(), [id](const auto& p) { return p.first == id; });
    if (found == params.end()) params.emplace_back(id, value);
    else found->second = value;
    for (size_t i = 0; i < instances_.size(); ++i)
        if (instanceSpecIndices_[i] == specIndex) instances_[i]->setParameter(id, value);
    return true;
}

void PluginRack::reset() {
    for (auto& instance : instances_) instance->reset();
}

void PluginRack::process(uint8_t* data, uint32_t frames, uint32_t channels,
                         uint32_t bytes, bool isFloat) {
    if (instances_.empty() || channels != 2 || (bytes != 2 && bytes != 3 && bytes != 4)) return;
    float a[2][kBlock], b[2][kBlock];
    float* input[2] = {a[0], a[1]};
    float* output[2] = {b[0], b[1]};
    for (uint32_t offset = 0; offset < frames; offset += kBlock) {
        auto count = std::min(kBlock, frames - offset);
        for (uint32_t i = 0; i < count; ++i)
            for (uint32_t ch = 0; ch < 2; ++ch)
                input[ch][i] = readPcm(data + ((offset + i) * 2 + ch) * bytes, bytes, isFloat);
        for (auto& instance : instances_) {
            if (instance->bypassed()) continue;
            try {
                instance->process(input, output, static_cast<int32_t>(count));
            } catch (...) {
                instances_.clear();
                return; // Leave this and subsequent PCM blocks untouched.
            }
            std::swap(input[0], output[0]);
            std::swap(input[1], output[1]);
        }
        for (uint32_t i = 0; i < count; ++i)
            for (uint32_t ch = 0; ch < 2; ++ch)
                writePcm(data + ((offset + i) * 2 + ch) * bytes, bytes, isFloat, input[ch][i]);
        // Swapped pointers must be restored before the next block.
        input[0] = a[0]; input[1] = a[1];
        output[0] = b[0]; output[1] = b[1];
    }
}
