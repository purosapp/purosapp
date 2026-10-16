import type { AudioVisualizerFrame } from '../../../electron/preload'

export const FFT_SIZE = 1024

interface AudioAnalysis {
  starts: number[]
  stops: number[]
  val: Float32Array
  att: Float32Array
  avg: Float32Array
  longAvg: Float32Array
}

// Match Butterchurn's band boundaries, using the rate of the actual native PCM.
// The otherwise unused Web Audio context can have a different device/rate.
export function setAnalysisSampleRate(levels: AudioAnalysis, sampleRate: number): void {
  const bin = (hz: number) => Math.max(0, Math.min(511, Math.round(hz * FFT_SIZE / sampleRate) - 1))
  levels.starts = [bin(20), bin(320), bin(2800)]
  levels.stops = [bin(320), bin(2800), bin(11025)]
  for (const values of [levels.val, levels.att, levels.avg, levels.longAvg]) values.fill(1)
}

export class VisualizerAudioWindow {
  readonly center = new Uint8Array(FFT_SIZE).fill(128)
  readonly left = new Uint8Array(FFT_SIZE).fill(128)
  readonly right = new Uint8Array(FFT_SIZE).fill(128)
  sampleRate = 0
  private updatedAt = -Infinity

  silence(): void {
    this.center.fill(128)
    this.left.fill(128)
    this.right.fill(128)
  }

  accept(frame: AudioVisualizerFrame, now: number): void {
    if (frame.paused || !frame.active) {
      this.silence()
      this.updatedAt = -Infinity
      return
    }
    if (!frame.valid || !Number.isFinite(frame.sampleRate) || frame.sampleRate <= 0 ||
        frame.left.length !== FFT_SIZE || frame.right.length !== FFT_SIZE) return
    const sample = (value: number) => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const left = sample(frame.left[i]), right = sample(frame.right[i])
      this.left[i] = Math.round(left * 127 + 128)
      this.right[i] = Math.round(right * 127 + 128)
      this.center[i] = Math.round((left + right) * 0.5 * 127 + 128)
    }
    this.sampleRate = frame.sampleRate
    this.updatedAt = now
  }

  expire(now: number): void {
    if (now - this.updatedAt > 200) this.silence()
  }
}
