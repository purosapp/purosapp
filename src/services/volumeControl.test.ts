import { describe, expect, it } from 'vitest'
import {
  describeVolumeControl,
  formatDecibels,
  gainToDecibels,
  hardwareVolumeToUserVolume,
  isDspVolumeAttenuating,
  isVolumeModeSetting,
  resolveVolumeMode,
  userVolumeToGain,
  volumeDecibels,
  type VolumeControlState,
} from './volumeControl'

const state = (effective: VolumeControlState['effective']): VolumeControlState => ({
  configured: 'auto',
  effective,
  hardwareAvailable: effective === 'device',
  hardware: effective === 'device'
    ? { scalar: 0.5, decibels: -18.44, minDecibels: -63, maxDecibels: 0, muteSupported: true, muted: false }
    : null,
})

describe('resolveVolumeMode', () => {
  it('uses the system mixer outside exclusive mode', () => {
    for (const mode of ['auto', 'device', 'dsp', 'fixed'] as const) {
      expect(resolveVolumeMode('shared', mode, true)).toBe('system')
      expect(resolveVolumeMode('closed', mode, false)).toBe('system')
    }
  })

  it('prefers DAC hardware volume in auto and falls back to DSP', () => {
    expect(resolveVolumeMode('exclusive', 'auto', true)).toBe('device')
    expect(resolveVolumeMode('exclusive', 'auto', false)).toBe('dsp')
  })

  it('honours explicit choices, falling back to DSP when the DAC has no control', () => {
    expect(resolveVolumeMode('exclusive', 'device', true)).toBe('device')
    expect(resolveVolumeMode('exclusive', 'device', false)).toBe('dsp')
    expect(resolveVolumeMode('exclusive', 'dsp', true)).toBe('dsp')
    expect(resolveVolumeMode('exclusive', 'fixed', true)).toBe('fixed')
  })
})

describe('DSP volume', () => {
  it('is bit-perfect only at full scale', () => {
    expect(isDspVolumeAttenuating(state('dsp'), 1)).toBe(false)
    expect(isDspVolumeAttenuating(state('dsp'), 0.999)).toBe(true)
    expect(isDspVolumeAttenuating(state('device'), 0.2)).toBe(false)
    expect(isDspVolumeAttenuating(state('fixed'), 1)).toBe(false)
  })

  it('maps the slider to gain and decibels', () => {
    expect(userVolumeToGain(1)).toBe(1)
    expect(userVolumeToGain(0)).toBe(0)
    expect(gainToDecibels(userVolumeToGain(0.5))).toBeCloseTo(-12.04, 2)
    expect(formatDecibels(gainToDecibels(userVolumeToGain(0.5)))).toBe('−12.0 dB')
    expect(formatDecibels(gainToDecibels(0))).toBe('−∞ dB')
    expect(formatDecibels(0)).toBe('0.0 dB')
  })

  it('describes whether the path stays bit-perfect', () => {
    expect(describeVolumeControl(state('dsp'), 1)).toContain('bit-perfect')
    expect(describeVolumeControl(state('dsp'), 0.5)).toContain('not bit-perfect')
    expect(describeVolumeControl(state('device'), 0.5)).toBe('Device volume −18.4 dB (DAC hardware) — bit-perfect')
    expect(describeVolumeControl(state('system'), 0.5)).toBeNull()
  })
})

describe('hardware volume', () => {
  it('reads a muted device as zero', () => {
    expect(hardwareVolumeToUserVolume({ scalar: 0.7, muted: false })).toBe(0.7)
    expect(hardwareVolumeToUserVolume({ scalar: 0.7, muted: true })).toBe(0)
  })

  it('validates persisted settings', () => {
    expect(isVolumeModeSetting('dsp')).toBe(true)
    expect(isVolumeModeSetting('loud')).toBe(false)
    expect(isVolumeModeSetting(null)).toBe(false)
  })
})

describe('volumeDecibels', () => {
  it('follows the slider gain curve for system and DSP volume', () => {
    expect(volumeDecibels(state('dsp'), 1)).toBe(0)
    expect(volumeDecibels(state('system'), 0.5)).toBeCloseTo(-12.04, 2)
    expect(volumeDecibels(state('dsp'), 0)).toBe(Number.NEGATIVE_INFINITY)
  })

  it('reads the DAC for device volume', () => {
    expect(volumeDecibels(state('device'), 0.5)).toBe(-18.44)
    const muted = state('device')
    muted.hardware = { ...muted.hardware!, muted: true }
    expect(volumeDecibels(muted, 0.5)).toBe(Number.NEGATIVE_INFINITY)
    expect(volumeDecibels({ ...state('device'), hardware: null }, 0.5)).toBeNull()
  })

  it('is unity for fixed volume', () => {
    expect(volumeDecibels(state('fixed'), 0.3)).toBe(0)
  })
})
