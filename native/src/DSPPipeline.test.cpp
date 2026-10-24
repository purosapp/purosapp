// Puros Restore inside the DSP pipeline: activation, bypass, alignment.
// Build & run (from the repo root):
//   xcrun clang++ -std=c++17 -O2 -fobjc-arc -mmacosx-version-min=12.0 -Inative/vendor/vst3sdk-interfaces \
//     native/src/DSPPipeline.cpp native/src/PurosRestore.cpp native/src/PluginRack.mm \
//     native/vendor/vst3sdk-interfaces/pluginterfaces/base/coreiids.cpp \
//     native/vendor/vst3sdk-interfaces/public.sdk/source/vst/vstinitiids.cpp native/src/DSPPipeline.test.cpp \
//     -framework Accelerate -framework AudioToolbox -framework CoreFoundation -framework AppKit -framework Foundation \
//     -o /tmp/dsp-test && /tmp/dsp-test
#include "DSPPipeline.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>

namespace {

int failures = 0;

void check(bool ok, const char* what) {
    std::printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
    if (!ok) ++failures;
}

constexpr double kRate = 44100.0;

RestoreConfig config(RestoreMode mode, RestorePosition position = RestorePosition::Source) {
    RestoreConfig c;
    c.mode = mode;
    c.strength = 1.0;
    c.position = position;
    return c;
}

// Stereo int16 test material: band-limited noise plus a tone, near -12 dBFS.
std::vector<int16_t> pcm16(size_t frames, uint32_t seed) {
    std::mt19937 rng(seed);
    std::normal_distribution<double> noise(0.0, 0.08);
    std::vector<int16_t> out(frames * 2);
    double lp = 0;
    for (size_t i = 0; i < frames; ++i) {
        lp = 0.6 * lp + 0.4 * noise(rng);
        const double v = lp + 0.2 * std::sin(2.0 * M_PI * 1000.0 * i / kRate);
        out[i * 2] = static_cast<int16_t>(std::lrint(v * 32767.0));
        out[i * 2 + 1] = static_cast<int16_t>(std::lrint(0.8 * v * 32767.0));
    }
    return out;
}

void processInt16(DSPPipeline& dsp, std::vector<int16_t>& samples, size_t block) {
    for (size_t pos = 0; pos < samples.size() / 2; pos += block) {
        const size_t count = std::min(block, samples.size() / 2 - pos);
        dsp.process(reinterpret_cast<uint8_t*>(samples.data() + pos * 2), static_cast<uint32_t>(count), 2, 2);
    }
}

void testAutoBypassesLossless() {
    std::printf("auto mode, in-place integer path (bit-perfect playback)\n");
    DSPPipeline dsp;
    dsp.setOutputFormat(false, kRate);
    dsp.setRestoreConfig(config(RestoreMode::Auto));
    dsp.prepareRestoreStage(false, RestorePosition::Source, kRate, 2, RestoreSourceClass::Lossless);
    const std::vector<int16_t> original = pcm16(kRate * 2, 1);
    std::vector<int16_t> samples = original;
    processInt16(dsp, samples, 4096);
    check(samples == original && !dsp.restoreStatus().inChain, "lossless source: every sample untouched, stage not in the chain");

    for (RestoreSourceClass source : {RestoreSourceClass::Unknown, RestoreSourceClass::Dsd}) {
        DSPPipeline other;
        other.setOutputFormat(false, kRate);
        other.setRestoreConfig(config(RestoreMode::Auto));
        other.prepareRestoreStage(false, RestorePosition::Source, kRate, 2, source);
        std::vector<int16_t> copy = original;
        processInt16(other, copy, 4096);
        check(copy == original && !other.restoreStatus().inChain,
              source == RestoreSourceClass::Unknown ? "unknown codec: untouched" : "DSD: untouched");
    }
    check(!dsp.isProcessing(), "restore never makes the pipeline report processing (bit-perfect decision unchanged)");

    DSPPipeline manualDsd;
    manualDsd.setRestoreConfig(config(RestoreMode::Manual));
    manualDsd.prepareRestoreStage(false, RestorePosition::Source, kRate, 2, RestoreSourceClass::Dsd);
    check(!manualDsd.restoreStatus().inChain, "manual mode still never touches DSD");
}

void testOffByDefault() {
    std::printf("defaults\n");
    DSPPipeline dsp;
    check(dsp.restoreConfig().mode == RestoreMode::Off, "a new pipeline has Restore off");
    check(std::fabs(dsp.restoreConfig().strength - 0.3) < 1e-12, "default strength 30 %");
    dsp.prepareRestoreStage(true, RestorePosition::Source, kRate, 2, RestoreSourceClass::Lossy);
    check(!dsp.restoreStatus().inChain && !dsp.restoreWouldEngage(RestoreSourceClass::Lossy), "off: even lossy sources pass untouched");
}

void testAutoEngagesLossy() {
    std::printf("auto mode, lossy source in the float pipeline\n");
    DSPPipeline dsp;
    dsp.setOutputFormat(true, kRate);
    dsp.setRestoreConfig(config(RestoreMode::Auto));
    check(dsp.restoreWouldEngage(RestoreSourceClass::Lossy), "engine is told to use the float path for lossy sources");
    dsp.prepareRestoreStage(true, RestorePosition::Source, kRate, 2, RestoreSourceClass::Lossy);
    const RestoreStatus status = dsp.restoreStatus();
    check(status.inChain && status.engaged && status.mix == 1.0, "stage in the chain and fully in from the first sample");

    // Feed in decode-sized blocks; output must be the same length and sample-aligned.
    std::mt19937 rng(4);
    std::normal_distribution<double> noise(0.0, 0.1);
    std::vector<double> input(static_cast<size_t>(kRate * 3) * 2);
    for (double& v : input) v = noise(rng);
    std::vector<double> output;
    std::vector<double> block;
    block.reserve((4096 + 16384) * 2);
    const size_t frames = input.size() / 2;
    bool reallocated = false;
    for (size_t pos = 0; pos < frames; pos += 4096) {
        const size_t count = std::min<size_t>(4096, frames - pos);
        block.assign(input.begin() + pos * 2, input.begin() + (pos + count) * 2);
        const double* storage = block.data();
        dsp.runRestoreStage(RestorePosition::Source, block, 2, pos + count == frames);
        reallocated = reallocated || block.data() != storage;
        output.insert(output.end(), block.begin(), block.end());
    }
    check(output.size() == input.size(), "track length unchanged (latency trimmed, tail flushed)");
    check(!reallocated, "decode buffers are never reallocated by the stage (tail included)");
    // The stage at the other position is a no-op.
    std::vector<double> untouched = input;
    dsp.runRestoreStage(RestorePosition::AfterDsp, untouched, 2, false);
    check(untouched == input, "stage only runs at its configured position");
}

void testManualToggleMidStream() {
    std::printf("manual mode switched during playback (in place)\n");
    DSPPipeline dsp;
    dsp.setOutputFormat(false, kRate);
    dsp.prepareRestoreStage(false, RestorePosition::Source, kRate, 2, RestoreSourceClass::Lossless);
    const std::vector<int16_t> original = pcm16(static_cast<size_t>(kRate * 4), 2);
    std::vector<int16_t> samples = original;
    const size_t second = static_cast<size_t>(kRate);
    dsp.process(reinterpret_cast<uint8_t*>(samples.data()), static_cast<uint32_t>(second), 2, 2);
    check(std::memcmp(samples.data(), original.data(), second * 4) == 0, "off: first second untouched");

    dsp.setRestoreConfig(config(RestoreMode::Manual));
    check(dsp.restoreStatus().inChain, "switching to Manual joins the running stream");
    dsp.process(reinterpret_cast<uint8_t*>(samples.data() + second * 2), static_cast<uint32_t>(second), 2, 2);

    // Back to Off: crossfades to the delayed dry signal, which is then bit-exact.
    dsp.setRestoreConfig(config(RestoreMode::Off));
    dsp.process(reinterpret_cast<uint8_t*>(samples.data() + second * 4), static_cast<uint32_t>(second * 2), 2, 2);
    const size_t latency = static_cast<size_t>(std::lround(dsp.restoreStatus().latencySeconds * kRate));
    bool exact = latency > 0;
    for (size_t i = second * 3; exact && i < second * 4; ++i) {
        exact = samples[i * 2] == original[(i - latency) * 2] && samples[i * 2 + 1] == original[(i - latency) * 2 + 1];
    }
    check(exact, "after switching off: bit-exact (delayed) passthrough of the integer stream");

    // End of stream: the delayed tail comes out instead of being lost.
    std::vector<int16_t> tail(4096 * 2);
    uint32_t drained = 0;
    while (const uint32_t n = dsp.drainRestore(reinterpret_cast<uint8_t*>(tail.data()), 4096, 2, 2)) drained += n;
    check(drained == latency, "end of stream drains exactly the latency tail");
}

void testCopyConfig() {
    std::printf("configuration hand-off\n");
    DSPPipeline master(true);
    RestoreConfig c = config(RestoreMode::Auto, RestorePosition::AfterDsp);
    c.profile = RestoreProfile::Detailed;
    c.strength = 0.55;
    c.hfReconstruction = false;
    master.setRestoreConfig(c);
    DSPPipeline slot;
    master.copyConfigTo(slot);
    const RestoreConfig copied = slot.restoreConfig();
    check(copied.mode == RestoreMode::Auto && copied.profile == RestoreProfile::Detailed && copied.strength == 0.55 &&
              !copied.hfReconstruction && copied.position == RestorePosition::AfterDsp,
          "track slots receive the full Restore configuration");
    check(!master.restoreStatus().inChain, "the configuration-only master never runs a stage");
}

}  // namespace

int main() {
    testOffByDefault();
    testAutoBypassesLossless();
    testAutoEngagesLossy();
    testManualToggleMidStream();
    testCopyConfig();
    std::printf(failures ? "\n%d FAILED\n" : "\nall passed\n", failures);
    return failures ? 1 : 0;
}
