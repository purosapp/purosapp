#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

struct PluginSpec {
    std::string path;
    std::string name;
    bool enabled = true;
    std::vector<std::pair<uint32_t, double>> parameters;
};

struct PluginParameter {
    uint32_t id;
    std::string name;
    double value;
    std::string display;
};

// One rack per decode path. No plug-in code runs on the CoreAudio callback.
class PluginRack {
public:
    PluginRack();
    ~PluginRack();
    PluginRack(const PluginRack&) = delete;
    PluginRack& operator=(const PluginRack&) = delete;

    static std::string probe(const std::string& path);
    static std::vector<PluginParameter> inspect(const PluginSpec& spec, double sampleRate);
    static void closeEditor();
    // onDisable fires when the editor is saved with its bypass switch off.
    bool openActiveEditor(size_t specIndex, std::function<void(uint32_t, double)> onChange,
                          std::function<void()> onDisable, std::string& error);
    bool configure(const std::vector<PluginSpec>& specs, double sampleRate,
                   std::string& error);
    void process(uint8_t* interleaved, uint32_t frames, uint32_t channels,
                 uint32_t bytesPerSample, bool isFloat);
    void reset();
    bool active() const;
    bool setParameter(size_t specIndex, uint32_t id, double value, std::string& error);

private:
    class Instance;
    static Instance* activeEditor_;
    std::vector<std::unique_ptr<Instance>> instances_;
    std::vector<size_t> instanceSpecIndices_;
    std::vector<PluginSpec> specs_;
    double sampleRate_ = 0;
};
