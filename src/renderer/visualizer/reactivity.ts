// Butterchurn 2.x internals: there is no public post-analysis sensitivity hook.
interface ReactiveVisualizer {
  renderer: {
    audioLevels: {
      val: Float32Array
      att: Float32Array
      updateAudioLevels(fps: number, frame: number): void
    }
  }
  audio: {
    timeArrayL: Int8Array
    timeArrayR: Int8Array
    freqArrayL: Float32Array
    freqArrayR: Float32Array
  }
}

export function installReactivityControl(visualizer: ReactiveVisualizer, getStrength: () => number): () => void {
  const levels = visualizer.renderer.audioLevels
  const original = levels.updateAudioLevels
  levels.updateAudioLevels = function (fps, frame) {
    original.call(this, fps, frame)
    const strength = getStrength()
    if (strength === 1) return

    // Normalized bands have a neutral level of 1. Dampen deviations only,
    // preserving the preset's baseline motion and the analyzer's running averages.
    // Reducing PCM gain before analysis would be undone by auto-normalization.
    for (const bands of [this.val, this.att]) {
      for (let i = 0; i < bands.length; i++) bands[i] = 1 + (bands[i] - 1) * strength
    }

    // Waves read these samples directly. Scale them after band analysis; each
    // frame's updateAudio() replaces them, so attenuation never accumulates.
    const audio = visualizer.audio
    for (const samples of [audio.timeArrayL, audio.timeArrayR, audio.freqArrayL, audio.freqArrayR]) {
      for (let i = 0; i < samples.length; i++) samples[i] *= strength
    }
  }
  return () => { levels.updateAudioLevels = original }
}
