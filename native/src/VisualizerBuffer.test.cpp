#include "VisualizerBuffer.h"
#include <cassert>
#include <cmath>
#include <thread>

int main() {
    VisualizerBuffer buffer;
    assert(!buffer.snapshot().valid);
    for (double rate : {44100.0, 48000.0, 96000.0}) {
        buffer.reset();
        const auto sample = [rate](int i) { return static_cast<float>(std::sin(i * 2 * 3.141592653589793 * 1000 / rate)); };
        // Mimic 20 ms polling, including missed callbacks. Every snapshot must
        // still be a continuous window, not four separated 256-sample blocks.
        int written = 0;
        for (int poll = 0; poll < 10; ++poll) {
            const int count = static_cast<int>(rate * 0.02);
            buffer.begin(rate);
            for (int j = 0; j < count; ++j, ++written) buffer.push(sample(written), -sample(written));
            assert(!buffer.snapshot().valid); // Never expose a partially written block.
            buffer.end();
            const auto snap = buffer.snapshot();
            assert(snap.valid && snap.sampleRate == rate);
            for (int j = 0; j < 1024; ++j) {
                const int index = written - 1024 + j;
                const float expected = index < 0 ? 0 : sample(index);
                assert(snap.left[j] == expected);
                assert(snap.right[j] == -expected);
            }
        }
    }
    buffer.begin(48000);
    buffer.push(0.5f, 0.5f);
    buffer.end();
    const auto changed = buffer.snapshot();
    assert(changed.sampleRate == 48000 && changed.left[1022] == 0 && changed.left[1023] == 0.5f);

    buffer.reset();
    std::atomic<bool> done{false};
    std::thread writer([&] {
        for (int block = 0; block < 2000; ++block) {
            buffer.begin(48000);
            for (int i = 0; i < 128; ++i) {
                const float value = static_cast<float>(block * 128 + i + 1);
                buffer.push(value, -value);
            }
            buffer.end();
        }
        done.store(true);
    });
    while (!done.load()) {
        const auto snap = buffer.snapshot();
        if (!snap.valid) continue;
        for (int i = 0; i < 1024; ++i) {
            assert(snap.left[i] == -snap.right[i]);
            if (i > 0 && snap.left[i - 1] != 0) assert(snap.left[i] == snap.left[i - 1] + 1);
        }
    }
    writer.join();
}
