import { describe, expect, it } from 'vitest'
import { FFT_SIZE, setAnalysisSampleRate, VisualizerAudioWindow } from './audio'

const frame = () => ({
  left: Array.from({ length: FFT_SIZE }, (_, i) => Math.sin(i * Math.PI / 24)),
  right: Array.from({ length: FFT_SIZE }, (_, i) => -Math.sin(i * Math.PI / 24)),
  sampleRate: 48000, valid: true, active: true, paused: false, peak: 1, rms: 0.7,
})

describe('native PCM to visualizer', () => {
  it('uses complete snapshots unchanged across polling and preserves stereo', () => {
    const pcm = new VisualizerAudioWindow()
    const input = frame()
    pcm.accept(input, 0)
    expect([...pcm.left]).toEqual(input.left.map(v => Math.round(v * 127 + 128)))
    expect([...pcm.right]).toEqual(input.right.map(v => Math.round(v * 127 + 128)))
    expect([...pcm.center]).toEqual(new Array(FFT_SIZE).fill(128))
    pcm.accept(input, 20)
    expect([...pcm.left]).toEqual(input.left.map(v => Math.round(v * 127 + 128)))
    const mono = { ...input, right: input.left }
    pcm.accept(mono, 40)
    expect(pcm.left).toEqual(pcm.right)
    expect(pcm.left).toEqual(pcm.center)
  })

  it('ignores torn snapshots and clears old audio on pause, stop or IPC failure', () => {
    const pcm = new VisualizerAudioWindow()
    pcm.accept(frame(), 0)
    const previous = pcm.left.slice()
    pcm.accept({ ...frame(), valid: false }, 100)
    expect(pcm.left).toEqual(previous)
    pcm.expire(201)
    expect([...pcm.left]).toEqual(new Array(FFT_SIZE).fill(128))
    for (const flags of [{ paused: true }, { active: false }]) {
      pcm.accept(frame(), 300)
      pcm.accept({ ...frame(), ...flags }, 301)
      expect([...pcm.left]).toEqual(new Array(FFT_SIZE).fill(128))
    }
  })

  it('maps spectral bands to the source rate and discards averages from the old rate', () => {
    const levels = { starts: [], stops: [], val: new Float32Array(3), att: new Float32Array(3), avg: new Float32Array(3), longAvg: new Float32Array(3) }
    for (const rate of [44100, 48000, 96000]) {
      setAnalysisSampleRate(levels, rate)
      // Every upper boundary lands within one FFT bin of its target frequency.
      for (const [i, hz] of [320, 2800, 11025].entries()) {
        expect(Math.abs((levels.stops[i] + 1) * rate / FFT_SIZE - hz)).toBeLessThan(rate / FFT_SIZE)
      }
      expect([...levels.longAvg]).toEqual([1, 1, 1])
    }
  })
})
