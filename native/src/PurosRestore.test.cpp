// Build & run (from the repo root):
//   xcrun clang++ -std=c++17 -O2 -mmacosx-version-min=12.0 native/src/PurosRestore.cpp native/src/PurosRestore.test.cpp \
//     -framework Accelerate -framework AudioToolbox -framework CoreFoundation -o /tmp/restore-test && /tmp/restore-test
#include "PurosRestore.h"

#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <random>
#include <vector>

// Counts heap allocations so the test can prove process()/flush() never allocate.
static std::atomic<size_t> gAllocations{0};
void* operator new(size_t size) {
    gAllocations.fetch_add(1, std::memory_order_relaxed);
    if (void* p = std::malloc(size ? size : 1)) return p;
    throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, size_t) noexcept { std::free(p); }

namespace {

constexpr double kPi = 3.14159265358979323846;
int failures = 0;

void check(bool ok, const char* what) {
    std::printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
    if (!ok) ++failures;
}

RestoreConfig manual(double strength, RestoreProfile profile = RestoreProfile::Adaptive) {
    RestoreConfig config;
    config.mode = RestoreMode::Manual;
    config.profile = profile;
    config.strength = strength;
    return config;
}

// Runs `in` through a Trim-mode processor in irregular blocks plus flush; output is aligned.
std::vector<double> runAligned(RestoreProcessor& restore, const std::vector<double>& in, uint32_t channels,
                               uint32_t seed = 1) {
    std::vector<double> out;
    out.reserve(in.size() + restore.latency() * channels);
    std::vector<double> block;
    block.reserve(8192 * channels);
    std::mt19937 rng(seed);
    std::uniform_int_distribution<size_t> sizes(1, 4096);
    const size_t frames = in.size() / channels;
    for (size_t pos = 0; pos < frames;) {
        const size_t count = std::min(frames - pos, sizes(rng));
        block.assign(in.begin() + static_cast<ptrdiff_t>(pos * channels),
                     in.begin() + static_cast<ptrdiff_t>((pos + count) * channels));
        const size_t produced = restore.process(block.data(), count);
        out.insert(out.end(), block.begin(), block.begin() + static_cast<ptrdiff_t>(produced * channels));
        pos += count;
    }
    const size_t tail = restore.pendingTail();
    block.assign(tail * channels, 0.0);
    const size_t flushed = restore.flush(block.data(), tail);
    out.insert(out.end(), block.begin(), block.begin() + static_cast<ptrdiff_t>(flushed * channels));
    return out;
}

// Whole-signal FFT filter: zeroes everything above `cutoffHz` (a codec-style brick wall).
void brickwall(std::vector<double>& signal, uint32_t channels, double rate, double cutoffHz) {
    const size_t frames = signal.size() / channels;
    size_t log2n = 1;
    while ((size_t{1} << log2n) < frames) ++log2n;
    const size_t n = size_t{1} << log2n;
    FFTSetupD setup = vDSP_create_fftsetupD(log2n, kFFTRadix2);
    std::vector<double> buffer(n), re(n / 2), im(n / 2);
    for (uint32_t c = 0; c < channels; ++c) {
        std::fill(buffer.begin(), buffer.end(), 0.0);
        for (size_t i = 0; i < frames; ++i) buffer[i] = signal[i * channels + c];
        DSPDoubleSplitComplex split{re.data(), im.data()};
        vDSP_ctozD(reinterpret_cast<const DSPDoubleComplex*>(buffer.data()), 2, &split, 1, n / 2);
        vDSP_fft_zripD(setup, &split, 1, log2n, kFFTDirection_Forward);
        const size_t cutBin = static_cast<size_t>(cutoffHz / rate * static_cast<double>(n));
        for (size_t k = cutBin; k < n / 2; ++k) re[k] = im[k] = 0.0;
        im[0] = 0.0;  // Nyquist
        vDSP_fft_zripD(setup, &split, 1, log2n, kFFTDirection_Inverse);
        vDSP_ztocD(&split, 1, reinterpret_cast<DSPDoubleComplex*>(buffer.data()), 2, n / 2);
        for (size_t i = 0; i < frames; ++i) signal[i * channels + c] = buffer[i] / (2.0 * static_cast<double>(n));
    }
    vDSP_destroy_fftsetupD(setup);
}

// Average power in [loHz, hiHz) over the whole signal (Welch, 4096-point Hann).
double bandPower(const std::vector<double>& signal, uint32_t channels, double rate, double loHz, double hiHz,
                 size_t from = 0, size_t to = 0) {
    const size_t n = 4096;
    const vDSP_Length log2n = 12;
    FFTSetupD setup = vDSP_create_fftsetupD(log2n, kFFTRadix2);
    std::vector<double> buffer(n), re(n / 2), im(n / 2), window(n);
    for (size_t i = 0; i < n; ++i) window[i] = 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / n);
    const size_t frames = to ? to : signal.size() / channels;
    double total = 0.0;
    size_t count = 0;
    for (uint32_t c = 0; c < channels; ++c) {
        for (size_t start = from; start + n <= frames; start += n / 2) {
            for (size_t i = 0; i < n; ++i) buffer[i] = signal[(start + i) * channels + c] * window[i];
            DSPDoubleSplitComplex split{re.data(), im.data()};
            vDSP_ctozD(reinterpret_cast<const DSPDoubleComplex*>(buffer.data()), 2, &split, 1, n / 2);
            vDSP_fft_zripD(setup, &split, 1, log2n, kFFTDirection_Forward);
            for (size_t k = static_cast<size_t>(loHz / rate * n); k < static_cast<size_t>(hiHz / rate * n); ++k) {
                total += re[k] * re[k] + im[k] * im[k];
            }
            ++count;
        }
    }
    vDSP_destroy_fftsetupD(setup);
    return count ? total / static_cast<double>(count) : 0.0;
}

double db(double power) { return 10.0 * std::log10(power + 1e-30); }

double rms(const std::vector<double>& signal) {
    double sum = 0.0;
    for (double v : signal) sum += v * v;
    return std::sqrt(sum / static_cast<double>(signal.size()));
}

// Stereo "music": panned harmonic notes, a decaying noise hit every 250 ms, a pink-ish bed.
std::vector<double> musicLike(double rate, double seconds, uint32_t seed = 7) {
    const size_t frames = static_cast<size_t>(rate * seconds);
    std::vector<double> out(frames * 2, 0.0);
    std::mt19937 rng(seed);
    std::normal_distribution<double> noise(0.0, 1.0);
    const double notes[] = {220.0, 277.18, 329.63, 440.0};
    double pinkL = 0.0, pinkR = 0.0;
    for (size_t i = 0; i < frames; ++i) {
        const double t = static_cast<double>(i) / rate;
        double left = 0.0, right = 0.0;
        for (int v = 0; v < 4; ++v) {
            const double f0 = notes[v] * (1.0 + 0.003 * std::sin(2.0 * kPi * 5.0 * t + v));
            double tone = 0.0;
            for (int h = 1; f0 * h < rate * 0.45; ++h) tone += std::sin(2.0 * kPi * f0 * h * t + h * v) / (h * 1.3);
            const double pan = 0.2 + 0.2 * v;
            left += 0.05 * tone * (1.0 - pan);
            right += 0.05 * tone * pan;
        }
        const double sinceHit = std::fmod(t, 0.25);
        const double hit = std::exp(-sinceHit / 0.04) * 0.25;
        const double white = noise(rng);
        pinkL = 0.97 * pinkL + 0.03 * noise(rng);
        pinkR = 0.97 * pinkR + 0.03 * noise(rng);
        out[i * 2] = left + hit * white + 0.05 * pinkL + 0.004 * noise(rng);
        out[i * 2 + 1] = right + hit * white * 0.8 + 0.05 * pinkR + 0.004 * noise(rng);
    }
    return out;
}

void testEngageRules() {
    std::printf("activation rules\n");
    RestoreConfig config;
    check(!restoreEngagesFor(config, RestoreSourceClass::Lossy), "off by default, even for lossy sources");
    config.mode = RestoreMode::Auto;
    check(restoreEngagesFor(config, RestoreSourceClass::Lossy), "auto: lossy engages");
    check(!restoreEngagesFor(config, RestoreSourceClass::Lossless), "auto: lossless bypassed");
    check(!restoreEngagesFor(config, RestoreSourceClass::Unknown), "auto: unknown bypassed");
    check(!restoreEngagesFor(config, RestoreSourceClass::Dsd), "auto: DSD bypassed");
    config.mode = RestoreMode::Manual;
    check(restoreEngagesFor(config, RestoreSourceClass::Lossless), "manual: lossless PCM processed");
    check(!restoreEngagesFor(config, RestoreSourceClass::Dsd), "manual: DSD never processed");

    std::string name;
    check(classifyRestoreSource(kAudioFormatMPEGLayer3, RestoreSourceClass::Unknown, name) == RestoreSourceClass::Lossy && name == "MP3", "MP3 → lossy");
    check(classifyRestoreSource(kAudioFormatMPEG4AAC, RestoreSourceClass::Lossless, name) == RestoreSourceClass::Lossy, "AAC bitstream wins over a lossless hint");
    check(classifyRestoreSource(kAudioFormatOpus, RestoreSourceClass::Unknown, name) == RestoreSourceClass::Lossy, "Opus → lossy");
    check(classifyRestoreSource(kAudioFormatFLAC, RestoreSourceClass::Lossy, name) == RestoreSourceClass::Lossless, "FLAC bitstream stays lossless");
    check(classifyRestoreSource(kAudioFormatAppleLossless, RestoreSourceClass::Unknown, name) == RestoreSourceClass::Lossless, "ALAC → lossless");
    check(classifyRestoreSource(kAudioFormatLinearPCM, RestoreSourceClass::Unknown, name) == RestoreSourceClass::Lossless, "WAV/AIFF PCM → lossless");
    check(classifyRestoreSource(kAudioFormatLinearPCM, RestoreSourceClass::Dsd, name) == RestoreSourceClass::Dsd, "DSD → PCM cache stays DSD");
    check(classifyRestoreSource(kAudioFormatLinearPCM, RestoreSourceClass::Lossy, name) == RestoreSourceClass::Lossy, "PCM decoded upstream from a lossy codec → lossy");
    check(classifyRestoreSource('abcd', RestoreSourceClass::Unknown, name) == RestoreSourceClass::Unknown, "unidentified codec → unknown");
}

void testBypassBitExact() {
    std::printf("bypass\n");
    for (uint32_t channels : {1u, 2u, 6u}) {
        RestoreProcessor restore;
        restore.configure(44100.0, channels);
        restore.setConfig(manual(1.0));
        restore.reset(RestoreProcessor::Start::Trim, false);
        restore.setEngaged(false, true);
        std::mt19937 rng(channels);
        std::uniform_real_distribution<double> dist(-1.0, 1.0);
        std::vector<double> in(44100 * 3 * channels);
        for (double& v : in) v = dist(rng);
        const std::vector<double> out = runAligned(restore, in, channels);
        bool exact = out.size() == in.size();
        for (size_t i = 0; exact && i < in.size(); ++i) exact = out[i] == in[i];
        char label[96];
        std::snprintf(label, sizeof(label), "disengaged output is the input bit for bit (%u ch)", channels);
        check(exact, label);
    }
}

void testAlignment() {
    std::printf("latency and length\n");
    for (double rate : {22050.0, 44100.0, 48000.0, 96000.0, 192000.0, 384000.0}) {
        for (uint32_t channels : {1u, 2u, 8u}) {
            RestoreProcessor restore;
            if (!restore.configure(rate, channels)) {
                check(false, "configure");
                continue;
            }
            restore.setConfig(manual(0.0));
            restore.reset(RestoreProcessor::Start::Trim, false);
            restore.setEngaged(true, true);
            std::vector<double> in(static_cast<size_t>(rate * 1.5) * channels);
            for (size_t i = 0; i < in.size(); ++i) in[i] = 0.5 * std::sin(0.001 * static_cast<double>(i) * (1 + i % channels));
            const std::vector<double> out = runAligned(restore, in, channels, 3);
            double worst = out.size() == in.size() ? 0.0 : 1.0;
            for (size_t i = 0; i < std::min(out.size(), in.size()); ++i) worst = std::max(worst, std::fabs(out[i] - in[i]));
            char label[128];
            std::snprintf(label, sizeof(label), "%6.0f Hz %u ch: same length, aligned, transparent at 0 %% (err %.1e, latency %.1f ms)",
                          rate, channels, worst, 1000.0 * restore.latency() / rate);
            check(worst < 1e-12, label);
        }
    }
}

void testHfReconstruction() {
    std::printf("high-frequency reconstruction\n");
    const double rate = 44100.0;
    std::vector<double> lossy = musicLike(rate, 6.0);
    brickwall(lossy, 2, rate, 16000.0);
    RestoreProcessor restore;
    restore.configure(rate, 2);
    RestoreConfig config = manual(1.0);
    config.artifactReduction = false;
    config.transientRestoration = false;
    restore.setConfig(config);
    restore.reset(RestoreProcessor::Start::Trim, false);
    restore.setEngaged(true, true);
    const std::vector<double> out = runAligned(restore, lossy, 2);
    const RestoreAnalysis analysis = restore.analysis();
    char label[160];
    std::snprintf(label, sizeof(label), "cutoff detected at %.0f Hz (16000 expected), confidence %.2f", analysis.cutoffHz, analysis.confidence);
    check(std::fabs(analysis.cutoffHz - 16000.0) < 150.0 && analysis.confidence > 0.5, label);

    const size_t from = static_cast<size_t>(rate * 1.5);
    const double edge = db(bandPower(out, 2, rate, 14500.0, 15800.0, from));
    const double before = db(bandPower(lossy, 2, rate, 16300.0, 20000.0, from));
    const double after = db(bandPower(out, 2, rate, 16300.0, 20000.0, from));
    const double perBinEdge = edge - db((15800.0 - 14500.0) / rate * 4096.0);
    const double perBinAfter = after - db((20000.0 - 16300.0) / rate * 4096.0);
    std::snprintf(label, sizeof(label), "16.3–20 kHz band rebuilt: %.1f dB → %.1f dB, %.1f dB/bin under the 15 kHz level",
                  before, after, perBinEdge - perBinAfter);
    check(after - before > 60.0 && perBinEdge - perBinAfter > 4.0 && perBinEdge - perBinAfter < 30.0, label);
    const double low = db(bandPower(out, 2, rate, 100.0, 15000.0, from)) - db(bandPower(lossy, 2, rate, 100.0, 15000.0, from));
    std::snprintf(label, sizeof(label), "content below the cutoff unchanged (%.3f dB)", low);
    check(std::fabs(low) < 0.05, label);
}

void testFullBandLeftAlone() {
    std::printf("full-bandwidth (lossless-like) material\n");
    const double rate = 44100.0;
    const std::vector<double> full = musicLike(rate, 6.0, 11);
    RestoreProcessor restore;
    restore.configure(rate, 2);
    restore.setConfig(manual(1.0));
    restore.reset(RestoreProcessor::Start::Trim, false);
    restore.setEngaged(true, true);
    const std::vector<double> out = runAligned(restore, full, 2);
    char label[160];
    std::snprintf(label, sizeof(label), "no codec cutoff found (%.0f Hz), severity %.2f", restore.analysis().cutoffHz, restore.analysis().severity);
    check(restore.analysis().cutoffHz == 0.0, label);
    const size_t from = static_cast<size_t>(rate * 1.0);
    const double hf = db(bandPower(out, 2, rate, 12000.0, 20000.0, from)) - db(bandPower(full, 2, rate, 12000.0, 20000.0, from));
    const double level = 20.0 * std::log10(rms(out) / rms(full));
    std::snprintf(label, sizeof(label), "top octave within 0.5 dB (%.2f dB), level within 0.2 dB (%.3f dB)", hf, level);
    check(std::fabs(hf) < 0.5 && std::fabs(level) < 0.2, label);

    // A natural roll-off (−18 dB/octave above 8 kHz) is not a codec cutoff.
    std::vector<double> rolled = musicLike(rate, 4.0, 12);
    double z1[2] = {0, 0}, z2[2] = {0, 0}, z3[2] = {0, 0};
    const double a = std::exp(-2.0 * kPi * 8000.0 / rate);
    for (size_t i = 0; i < rolled.size(); ++i) {
        const int c = static_cast<int>(i % 2);
        z1[c] = (1 - a) * rolled[i] + a * z1[c];
        z2[c] = (1 - a) * z1[c] + a * z2[c];
        z3[c] = (1 - a) * z2[c] + a * z3[c];
        rolled[i] = z3[c];
    }
    RestoreProcessor second;
    second.configure(rate, 2);
    second.setConfig(manual(1.0));
    second.reset(RestoreProcessor::Start::Trim, false);
    second.setEngaged(true, true);
    runAligned(second, rolled, 2);
    check(second.analysis().cutoffHz == 0.0, "gentle analog-style roll-off is not mistaken for a codec cutoff");
}

void testArtifactReduction() {
    std::printf("artifact reduction\n");
    const double rate = 44100.0;
    std::vector<double> clean = musicLike(rate, 6.0, 21);
    brickwall(clean, 2, rate, 17000.0);
    // Codec-style holes: per 576-sample granule (sine window, 50 % overlap), zero whole
    // ~350 Hz bands between 4 and 16 kHz, each for two granules, like an encoder starving
    // scale-factor bands of bits. Both channels share the holes (joint stereo).
    std::vector<double> holey(clean.size(), 0.0);
    const size_t n = 1152, hop = 576;
    const size_t fftN = 2048;
    FFTSetupD setup = vDSP_create_fftsetupD(11, kFFTRadix2);
    std::vector<double> buffer(fftN), re(fftN / 2), im(fftN / 2), window(n);
    for (size_t i = 0; i < n; ++i) window[i] = std::sin(kPi * (i + 0.5) / n);
    const size_t frames = clean.size() / 2;
    const size_t bandBins = 16;
    const size_t loBin = static_cast<size_t>(4000.0 / rate * fftN), hiBin = static_cast<size_t>(16000.0 / rate * fftN);
    std::vector<std::vector<uint8_t>> plan;
    std::mt19937 rng(9);
    std::uniform_real_distribution<double> coin(0.0, 1.0);
    for (size_t start = 0, g = 0; start + n <= frames; start += hop, ++g) {
        std::vector<uint8_t> zero((hiBin - loBin) / bandBins, 0);
        for (size_t b = 0; b < zero.size(); ++b) {
            zero[b] = (g > 0 && plan[g - 1][b] == 1) ? 2 : (coin(rng) < 0.10 ? 1 : 0);
        }
        plan.push_back(zero);
    }
    for (uint32_t c = 0; c < 2; ++c) {
        for (size_t start = 0, g = 0; start + n <= frames; start += hop, ++g) {
            std::fill(buffer.begin(), buffer.end(), 0.0);
            for (size_t i = 0; i < n; ++i) buffer[i] = clean[(start + i) * 2 + c] * window[i];
            DSPDoubleSplitComplex split{re.data(), im.data()};
            vDSP_ctozD(reinterpret_cast<const DSPDoubleComplex*>(buffer.data()), 2, &split, 1, fftN / 2);
            vDSP_fft_zripD(setup, &split, 1, 11, kFFTDirection_Forward);
            for (size_t b = 0; b < plan[g].size(); ++b) {
                if (!plan[g][b]) continue;
                for (size_t j = loBin + b * bandBins; j < loBin + (b + 1) * bandBins; ++j) re[j] = im[j] = 0.0;
            }
            vDSP_fft_zripD(setup, &split, 1, 11, kFFTDirection_Inverse);
            vDSP_ztocD(&split, 1, reinterpret_cast<DSPDoubleComplex*>(buffer.data()), 2, fftN / 2);
            for (size_t i = 0; i < n; ++i) holey[(start + i) * 2 + c] += buffer[i] * window[i] / (2.0 * fftN);
        }
    }
    vDSP_destroy_fftsetupD(setup);

    const auto measure = [&](const std::vector<double>& signal, RestoreProcessor& restore) {
        restore.configure(rate, 2);
        RestoreConfig config = manual(1.0);
        config.hfReconstruction = false;
        config.transientRestoration = false;
        restore.setConfig(config);
        restore.reset(RestoreProcessor::Start::Trim, false);
        restore.setEngaged(true, true);
        return runAligned(restore, signal, 2);
    };
    RestoreProcessor onHoley, onClean;
    const std::vector<double> repaired = measure(holey, onHoley);
    measure(clean, onClean);
    char label[200];
    std::snprintf(label, sizeof(label), "hole rate: %.3f on coded-like input vs %.3f on clean input",
                  onHoley.analysis().holeRate, onClean.analysis().holeRate);
    check(onHoley.analysis().holeRate > 3.0 * onClean.analysis().holeRate && onHoley.analysis().holeRate > 0.01, label);

    // The repair moves the damaged band toward the undamaged reference.
    const size_t from = static_cast<size_t>(rate * 1.0);
    const double refBand = bandPower(clean, 2, rate, 4000.0, 16000.0, from);
    const double damaged = db(refBand) - db(bandPower(holey, 2, rate, 4000.0, 16000.0, from));
    const double restored = db(refBand) - db(bandPower(repaired, 2, rate, 4000.0, 16000.0, from));
    std::snprintf(label, sizeof(label), "4–16 kHz energy deficit vs. the undamaged signal: %.2f dB → %.2f dB", damaged, restored);
    check(restored < damaged && restored > -0.5, label);
}

void testPreEcho() {
    std::printf("transient restoration\n");
    const double rate = 44100.0;
    const size_t frames = static_cast<size_t>(rate * 4.0);
    std::vector<double> in(frames * 2, 0.0);
    std::mt19937 rng(3);
    std::normal_distribution<double> noise(0.0, 1.0);
    std::vector<size_t> onsets;
    for (size_t onset = static_cast<size_t>(rate * 0.5); onset + 20000 < frames; onset += static_cast<size_t>(rate * 0.6)) {
        onsets.push_back(onset);
        const size_t preEcho = static_cast<size_t>(rate * 0.010);
        for (size_t i = onset - preEcho; i < onset; ++i) {
            const double v = 0.003 * noise(rng);  // −34 dB smeared quantization noise
            in[i * 2] += v;
            in[i * 2 + 1] += v;
        }
        for (size_t i = onset; i < onset + 15000; ++i) {
            const double env = 0.15 * std::exp(-static_cast<double>(i - onset) / (0.03 * rate));
            const double v = env * noise(rng);
            in[i * 2] += v;
            in[i * 2 + 1] += 0.9 * v;
        }
    }
    RestoreProcessor restore;
    restore.configure(rate, 2);
    RestoreConfig config = manual(1.0, RestoreProfile::Detailed);
    config.artifactReduction = false;
    config.hfReconstruction = false;
    restore.setConfig(config);
    restore.reset(RestoreProcessor::Start::Trim, false);
    restore.setEngaged(true, true);
    const std::vector<double> out = runAligned(restore, in, 2);
    double preIn = 0, preOut = 0, attackIn = 0, attackOut = 0;
    for (size_t onset : onsets) {
        for (size_t i = onset - static_cast<size_t>(rate * 0.009); i < onset - static_cast<size_t>(rate * 0.001); ++i) {
            preIn += in[i * 2] * in[i * 2];
            preOut += out[i * 2] * out[i * 2];
        }
        for (size_t i = onset; i < onset + static_cast<size_t>(rate * 0.005); ++i) {
            attackIn += in[i * 2] * in[i * 2];
            attackOut += out[i * 2] * out[i * 2];
        }
    }
    char label[160];
    std::snprintf(label, sizeof(label), "pre-echo before attacks attenuated by %.1f dB", db(preIn) - db(preOut));
    check(db(preIn) - db(preOut) > 3.0, label);
    std::snprintf(label, sizeof(label), "attacks lifted by %.2f dB (bounded)", db(attackOut) - db(attackIn));
    check(db(attackOut) - db(attackIn) > 0.2 && db(attackOut) - db(attackIn) < 3.5, label);
}

void testSafety() {
    std::printf("safety\n");
    const double rate = 48000.0;
    // Loud, bright, brick-walled material near full scale.
    std::vector<double> loud = musicLike(rate, 4.0, 31);
    for (double& v : loud) v = std::tanh(6.0 * v);
    brickwall(loud, 2, rate, 15000.0);
    double peakIn = 0;
    for (double v : loud) peakIn = std::max(peakIn, std::fabs(v));
    RestoreProcessor restore;
    restore.configure(rate, 2);
    restore.setConfig(manual(1.0, RestoreProfile::Detailed));
    restore.reset(RestoreProcessor::Start::Trim, false);
    restore.setEngaged(true, true);
    const std::vector<double> out = runAligned(restore, loud, 2);
    double peakOut = 0;
    bool finite = true;
    for (double v : out) {
        peakOut = std::max(peakOut, std::fabs(v));
        finite = finite && std::isfinite(v);
    }
    char label[160];
    std::snprintf(label, sizeof(label), "no new overs: peak %.4f in, %.4f out", peakIn, peakOut);
    check(peakOut <= std::max(1.0, peakIn) + 1e-12, label);
    const double level = 20.0 * std::log10(rms(out) / rms(loud));
    std::snprintf(label, sizeof(label), "no level jump at 100 %% (%.3f dB)", level);
    check(std::fabs(level) < 0.25, label);

    std::vector<double> poisoned = musicLike(rate, 2.0, 32);
    for (size_t i = 1000; i < poisoned.size(); i += 7919) {
        poisoned[i] = (i / 7919) % 2 ? std::numeric_limits<double>::quiet_NaN() : std::numeric_limits<double>::infinity();
    }
    RestoreProcessor guarded;
    guarded.configure(rate, 2);
    guarded.setConfig(manual(1.0));
    guarded.reset(RestoreProcessor::Start::Trim, false);
    guarded.setEngaged(true, true);
    const std::vector<double> cleanOut = runAligned(guarded, poisoned, 2);
    finite = true;
    for (double v : cleanOut) finite = finite && std::isfinite(v);
    check(finite, "NaN / Inf input never reaches the output");
}

// Power in [loHz, hiHz) of one 1024-sample Hann window starting at `start` (channel 0).
double windowBandPower(const std::vector<double>& signal, uint32_t channels, double rate, size_t start, double loHz, double hiHz) {
    const size_t n = 1024;
    FFTSetupD setup = vDSP_create_fftsetupD(10, kFFTRadix2);
    std::vector<double> buffer(n), re(n / 2), im(n / 2);
    for (size_t i = 0; i < n; ++i) {
        buffer[i] = signal[(start + i) * channels] * (0.5 - 0.5 * std::cos(2.0 * kPi * i / n));
    }
    DSPDoubleSplitComplex split{re.data(), im.data()};
    vDSP_ctozD(reinterpret_cast<const DSPDoubleComplex*>(buffer.data()), 2, &split, 1, n / 2);
    vDSP_fft_zripD(setup, &split, 1, 10, kFFTDirection_Forward);
    double total = 0;
    for (size_t k = static_cast<size_t>(loHz / rate * n); k < std::min(n / 2, static_cast<size_t>(hiHz / rate * n)); ++k) {
        total += re[k] * re[k] + im[k] * im[k];
    }
    vDSP_destroy_fftsetupD(setup);
    return total;
}

void testSmoothSwitching() {
    std::printf("switching\n");
    const double rate = 44100.0;
    // Band-limited to 16 kHz; restoration stays below 21 kHz, so energy at 21–22 kHz
    // around a switch point can only be a click.
    std::vector<double> in = musicLike(rate, 6.0, 41);
    brickwall(in, 2, rate, 16000.0);

    RestoreProcessor restore;
    restore.configure(rate, 2);
    restore.setConfig(manual(1.0, RestoreProfile::Detailed));
    restore.reset(RestoreProcessor::Start::Trim, false);
    restore.setEngaged(false, true);
    std::vector<double> out;
    std::vector<double> block;
    const size_t frames = in.size() / 2;
    const size_t blockFrames = static_cast<size_t>(rate * 0.5);
    bool engaged = false;
    std::vector<size_t> switches;
    for (size_t pos = 0; pos < frames; pos += blockFrames) {
        const size_t count = std::min(blockFrames, frames - pos);
        block.assign(in.begin() + static_cast<ptrdiff_t>(pos * 2), in.begin() + static_cast<ptrdiff_t>((pos + count) * 2));
        engaged = !engaged;
        restore.setEngaged(engaged, false);
        if (pos > 0) switches.push_back(out.size() / 2);
        const size_t produced = restore.process(block.data(), count);
        out.insert(out.end(), block.begin(), block.begin() + static_cast<ptrdiff_t>(produced * 2));
    }
    // Same input, always engaged: its 21–22 kHz leakage is the floor a switch must not exceed.
    RestoreProcessor steady;
    steady.configure(rate, 2);
    steady.setConfig(manual(1.0, RestoreProfile::Detailed));
    steady.reset(RestoreProcessor::Start::Trim, false);
    steady.setEngaged(true, true);
    const std::vector<double> reference = runAligned(steady, in, 2);
    double worstSwitch = 0, floor = 0;
    for (size_t at : switches) {
        if (at + 4096 > out.size() / 2) continue;
        for (size_t w = at - 1024; w < at + 3072; w += 128) {
            worstSwitch = std::max(worstSwitch, windowBandPower(out, 2, rate, w, 21200.0, 22050.0));
            floor = std::max(floor, windowBandPower(reference, 2, rate, w, 21200.0, 22050.0));
        }
    }
    char label[160];
    std::snprintf(label, sizeof(label), "toggling every 0.5 s: no clicks (21–22 kHz around switches %.1f dB vs %.1f dB steady)",
                  db(worstSwitch), db(floor));
    check(worstSwitch <= 2.0 * floor, label);

    // Joining a stream that is already playing, in fixed-length blocks.
    const double f = 440.0;
    std::vector<double> sine(static_cast<size_t>(rate * 2.0) * 2);
    for (size_t i = 0; i < sine.size() / 2; ++i) sine[i * 2] = sine[i * 2 + 1] = 0.5 * std::sin(2.0 * kPi * f * i / rate);
    RestoreProcessor joining;
    joining.configure(rate, 2);
    joining.setConfig(manual(0.3));
    joining.reset(RestoreProcessor::Start::Join, true);
    joining.setEngaged(true, false);
    std::vector<double> joined = sine;
    const size_t produced = joining.process(joined.data(), joined.size() / 2);
    double splatter = 0;
    for (size_t w = 0; w + 1024 < static_cast<size_t>(rate * 0.1); w += 128) {
        splatter = std::max(splatter, windowBandPower(joined, 2, rate, w, 3000.0, 22050.0));
    }
    const double tone = windowBandPower(joined, 2, rate, static_cast<size_t>(rate * 1.0), 100.0, 3000.0);
    std::snprintf(label, sizeof(label), "join keeps the block length, no clicks (splatter %.1f dB under the tone)", db(tone) - db(splatter));
    check(produced == sine.size() / 2 && db(tone) - db(splatter) > 60.0, label);
}

void testRealTimeSafety() {
    std::printf("real-time safety and CPU\n");
    for (double rate : {44100.0, 96000.0, 192000.0}) {
        RestoreProcessor restore;
        restore.configure(rate, 2);
        restore.setConfig(manual(1.0));
        restore.reset(RestoreProcessor::Start::Trim, false);
        restore.setEngaged(true, true);
        const double seconds = 30.0;
        std::vector<double> lossy = musicLike(rate, seconds, 51);
        brickwall(lossy, 2, rate, 16000.0);
        std::vector<double> tail(restore.latency() * 2);
        const size_t frames = lossy.size() / 2;
        const size_t before = gAllocations.load();
        const auto start = std::chrono::steady_clock::now();
        for (size_t pos = 0; pos < frames; pos += 4096) {
            restore.process(lossy.data() + pos * 2, std::min<size_t>(4096, frames - pos));
        }
        restore.flush(tail.data(), restore.pendingTail());
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        const size_t allocations = gAllocations.load() - before;
        char label[200];
        std::snprintf(label, sizeof(label), "%6.0f Hz stereo: %zu allocations in process/flush, %.0f× real time (%.2f %% of one core)",
                      rate, allocations, seconds / elapsed, 100.0 * elapsed / seconds);
        check(allocations == 0 && seconds / elapsed > 50.0, label);
    }
}

}  // namespace

int main() {
    testEngageRules();
    testBypassBitExact();
    testAlignment();
    testHfReconstruction();
    testFullBandLeftAlone();
    testArtifactReduction();
    testPreEcho();
    testSafety();
    testSmoothSwitching();
    testRealTimeSafety();
    std::printf(failures ? "\n%d FAILED\n" : "\nall passed\n", failures);
    return failures ? 1 : 0;
}
