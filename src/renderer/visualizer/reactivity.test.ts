import { describe, expect, it } from 'vitest'
import { installReactivityControl } from './reactivity'

describe('visualizer reactivity', () => {
  it('dampens normalized beats and raw waves without feeding attenuation back into analysis', () => {
    let strength = 0.5
    const averages = new Float32Array([2, 4, 8])
    const levels = {
      val: new Float32Array(3),
      att: new Float32Array(3),
      updateAudioLevels() {
        // Model a sustained beat against the analyzer's unmodified averages.
        this.val.set([averages[0], 1, 0.5])
        this.att.set([1.5, 1, 0.75])
      },
    }
    const audio = {
      timeArrayL: new Int8Array(2), timeArrayR: new Int8Array(2),
      freqArrayL: new Float32Array(2), freqArrayR: new Float32Array(2),
    }
    const original = levels.updateAudioLevels
    const restore = installReactivityControl({ renderer: { audioLevels: levels }, audio }, () => strength)
    const renderFrame = () => {
      // As in Butterchurn, updateAudio refreshes buffers before each render.
      audio.timeArrayL.set([100, -100]); audio.timeArrayR.set([80, -80])
      audio.freqArrayL.set([10, 20]); audio.freqArrayR.set([30, 40])
      levels.updateAudioLevels()
    }

    for (let frame = 0; frame < 120; frame++) {
      renderFrame()
      expect([...levels.val]).toEqual([1.5, 1, 0.75])
      expect([...levels.att]).toEqual([1.25, 1, 0.875])
      expect([...audio.timeArrayL]).toEqual([50, -50])
      expect([...audio.freqArrayR]).toEqual([15, 20])
    }
    expect([...averages]).toEqual([2, 4, 8])

    // Live changes need no preset reload; zero retains neutral preset motion.
    strength = 0
    renderFrame()
    expect([...levels.val, ...levels.att]).toEqual([1, 1, 1, 1, 1, 1])
    expect([...audio.timeArrayR, ...audio.freqArrayL]).toEqual([0, 0, 0, 0])

    strength = 1
    renderFrame()
    expect([...levels.val]).toEqual([2, 1, 0.5])
    expect([...audio.timeArrayL]).toEqual([100, -100])
    restore()
    expect(levels.updateAudioLevels).toBe(original)
  })
})
