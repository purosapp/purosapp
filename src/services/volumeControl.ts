/**
 * Roon-style output volume control.
 *
 * Per device the user picks how volume is controlled in exclusive mode:
 *   - device: the DAC's own hardware volume. PCM stays bit-perfect.
 *   - dsp:    64-bit digital attenuation with TPDF dither in the engine. Bit-perfect only at 0 dB.
 *   - fixed:  no volume control; output is always bit-perfect at 100%, use the amplifier.
 *   - auto:   device when the DAC has a hardware control, otherwise dsp.
 * Shared mode always uses the system mixer volume ("system").
 */

export type VolumeModeSetting = 'auto' | 'device' | 'dsp' | 'fixed'
export type EffectiveVolumeMode = 'system' | 'device' | 'dsp' | 'fixed'

export const VOLUME_MODE_SETTINGS: readonly VolumeModeSetting[] = ['auto', 'device', 'dsp', 'fixed']

export interface HardwareVolumeState {
  scalar: number
  decibels: number | null
  minDecibels: number | null
  maxDecibels: number | null
  muteSupported: boolean
  muted: boolean
}

export interface VolumeControlState {
  configured: VolumeModeSetting
  effective: EffectiveVolumeMode
  hardwareAvailable: boolean
  hardware: HardwareVolumeState | null
}

const USER_VOLUME_TO_GAIN_EXPONENT = 2

export function isVolumeModeSetting(value: unknown): value is VolumeModeSetting {
  return typeof value === 'string' && (VOLUME_MODE_SETTINGS as readonly string[]).includes(value)
}

export function resolveVolumeMode(
  audioMode: 'exclusive' | 'shared' | 'closed',
  configured: VolumeModeSetting,
  hardwareAvailable: boolean,
): EffectiveVolumeMode {
  if (audioMode !== 'exclusive') return 'system'
  if (configured === 'fixed') return 'fixed'
  if (configured === 'dsp') return 'dsp'
  if (configured === 'device') return hardwareAvailable ? 'device' : 'dsp'
  return hardwareAvailable ? 'device' : 'dsp'
}

/** Slider position (0–1) → linear gain for system and DSP volume. */
export function userVolumeToGain(volume: number): number {
  const clamped = Math.max(0, Math.min(1, volume))
  return clamped <= 0 ? 0 : Math.pow(clamped, USER_VOLUME_TO_GAIN_EXPONENT)
}

export function gainToDecibels(gain: number): number {
  return gain <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(gain)
}

export function formatDecibels(db: number | null | undefined): string {
  if (db == null || Number.isNaN(db)) return ''
  if (!Number.isFinite(db)) return '−∞ dB'
  const rounded = Math.round(db * 10) / 10
  if (rounded === 0) return '0.0 dB'
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded).toFixed(1)} dB`
}

/** DSP volume changes the samples whenever it is below unity. */
export function isDspVolumeAttenuating(
  volumeControl: Pick<VolumeControlState, 'effective'> | null | undefined,
  volume: number,
): boolean {
  return volumeControl?.effective === 'dsp' && userVolumeToGain(volume) < 1
}

export function volumeModeLabel(mode: VolumeModeSetting | EffectiveVolumeMode): string {
  switch (mode) {
    case 'auto':
      return 'Auto'
    case 'device':
      return 'Device'
    case 'dsp':
      return 'DSP'
    case 'fixed':
      return 'Fixed'
    default:
      return 'System'
  }
}

export function volumeModeDescription(mode: EffectiveVolumeMode): string {
  switch (mode) {
    case 'device':
      return 'DAC hardware volume — the digital stream stays bit-perfect'
    case 'dsp':
      return '64-bit digital volume with TPDF dither — bit-perfect only at 100%'
    case 'fixed':
      return 'Fixed at 100% — always bit-perfect, set the level on your amplifier'
    default:
      return 'macOS system mixer volume'
  }
}

/** Hardware state → slider position; a muted device reads as zero. */
export function hardwareVolumeToUserVolume(hardware: Pick<HardwareVolumeState, 'scalar' | 'muted'>): number {
  if (hardware.muted) return 0
  return Math.max(0, Math.min(1, hardware.scalar))
}

/** Tooltip text for the transport volume control. */
export function describeVolumeControl(volumeControl: VolumeControlState, volume: number): string | null {
  switch (volumeControl.effective) {
    case 'fixed':
      return 'Fixed volume — bit-perfect at 100%, set the level on your amplifier'
    case 'device': {
      const hardware = volumeControl.hardware
      const level = hardware?.muted
        ? 'muted'
        : formatDecibels(hardware?.decibels) || `${Math.round(volume * 100)}%`
      return `Device volume ${level} (DAC hardware) — bit-perfect`
    }
    case 'dsp': {
      const db = formatDecibels(gainToDecibels(userVolumeToGain(volume)))
      return isDspVolumeAttenuating(volumeControl, volume)
        ? `DSP volume ${db} — 64-bit with dither, not bit-perfect`
        : 'DSP volume 0.0 dB — bit-perfect'
    }
    default:
      return null
  }
}
