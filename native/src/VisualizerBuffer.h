#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

// One audio-thread writer, bounded non-blocking readers. Never concatenate
// snapshots: each successful read contains the latest contiguous PCM window.
class VisualizerBuffer {
public:
    static constexpr size_t size = 1024;
    struct Snapshot {
        std::array<float, size> left{};
        std::array<float, size> right{};
        double sampleRate = 0;
        bool valid = false;
    };

    void begin(double rate) {
        sequence_.fetch_add(1, std::memory_order_acq_rel);
        if (resetRequested_.exchange(false, std::memory_order_acq_rel) ||
            rate != sampleRate_.load(std::memory_order_relaxed)) clearSamples();
        sampleRate_.store(rate, std::memory_order_relaxed);
    }
    void push(float left, float right) {
        const size_t cursor = cursor_.load(std::memory_order_relaxed);
        left_[cursor].store(left, std::memory_order_relaxed);
        right_[cursor].store(right, std::memory_order_relaxed);
        cursor_.store((cursor + 1) % size, std::memory_order_relaxed);
    }
    void end() { sequence_.fetch_add(1, std::memory_order_release); }

    // stopPlayback can run while the callback is writing silence. Only request
    // a reset here; the audio thread remains the sole writer of sample data.
    void reset() { resetRequested_.store(true, std::memory_order_release); }

    Snapshot snapshot() const {
        Snapshot result;
        for (int attempt = 0; attempt < 3; ++attempt) {
            if (resetRequested_.load(std::memory_order_acquire)) return result;
            const auto before = sequence_.load(std::memory_order_acquire);
            if (before & 1) continue;
            const size_t cursor = cursor_.load(std::memory_order_relaxed);
            result.sampleRate = sampleRate_.load(std::memory_order_relaxed);
            for (size_t i = 0; i < size; ++i) {
                const size_t index = (cursor + i) % size;
                result.left[i] = left_[index].load(std::memory_order_relaxed);
                result.right[i] = right_[index].load(std::memory_order_relaxed);
            }
            std::atomic_thread_fence(std::memory_order_acquire);
            if (before == sequence_.load(std::memory_order_relaxed)) {
                result.valid = result.sampleRate > 0 && !resetRequested_.load(std::memory_order_acquire);
                return result;
            }
        }
        return result; // Caller ignores samples when valid is false.
    }

private:
    void clearSamples() {
        for (size_t i = 0; i < size; ++i) {
            left_[i].store(0, std::memory_order_relaxed);
            right_[i].store(0, std::memory_order_relaxed);
        }
        cursor_.store(0, std::memory_order_relaxed);
    }
    std::array<std::atomic<float>, size> left_{};
    std::array<std::atomic<float>, size> right_{};
    std::atomic<size_t> cursor_{0};
    std::atomic<double> sampleRate_{0};
    std::atomic<uint64_t> sequence_{0};
    std::atomic<bool> resetRequested_{false};
};
