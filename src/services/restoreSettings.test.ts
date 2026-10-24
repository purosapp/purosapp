import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESTORE_SETTINGS,
  isValidNativeRestoreConfig,
  parseFfmpegAudioCodec,
  restoreSourceForFfmpegCodec,
  restoreSourceHint,
  sanitizeRestoreSettings,
  toNativeRestoreConfig,
} from './restoreSettings'

describe('Puros Restore settings', () => {
  it('defaults to off, adaptive, 30 %, every module on', () => {
    expect(DEFAULT_RESTORE_SETTINGS).toEqual({
      mode: 'off',
      profile: 'adaptive',
      strength: 30,
      artifactReduction: true,
      hfReconstruction: true,
      transientRestoration: true,
      position: 'source',
    })
    // Existing users have nothing stored: they get the defaults, i.e. off.
    expect(sanitizeRestoreSettings(null)).toEqual(DEFAULT_RESTORE_SETTINGS)
    expect(sanitizeRestoreSettings(undefined).mode).toBe('off')
  })

  it('falls back field by field on corrupt settings', () => {
    expect(sanitizeRestoreSettings({ mode: 'always', profile: 'loud', strength: 250, hfReconstruction: false, position: 'middle' }))
      .toEqual({ ...DEFAULT_RESTORE_SETTINGS, strength: 100, hfReconstruction: false })
    expect(sanitizeRestoreSettings({ strength: Number.NaN }).strength).toBe(30)
    expect(sanitizeRestoreSettings({ mode: 'auto', strength: -4 })).toMatchObject({ mode: 'auto', strength: 0 })
  })

  it('converts to the native 0–1 strength and validates it across IPC', () => {
    const native = toNativeRestoreConfig({ ...DEFAULT_RESTORE_SETTINGS, mode: 'auto', strength: 45 })
    expect(native.strength).toBeCloseTo(0.45)
    expect(isValidNativeRestoreConfig(native)).toBe(true)
    expect(isValidNativeRestoreConfig({ ...native, strength: 45 })).toBe(false)
    expect(isValidNativeRestoreConfig({ ...native, mode: 'on' })).toBe(false)
    expect(isValidNativeRestoreConfig({ ...native, transientRestoration: 1 })).toBe(false)
    expect(isValidNativeRestoreConfig(null)).toBe(false)
  })
})

describe('restoreSourceHint', () => {
  const info = (format: string, isLossless: boolean, isDsd = false) =>
    ({ format, isLossless, isDsd }) as Parameters<typeof restoreSourceHint>[0]

  it('maps codec metadata, never guessing', () => {
    expect(restoreSourceHint(info('MP3', false))).toBe('lossy')
    expect(restoreSourceHint(info('AAC', false))).toBe('lossy')
    expect(restoreSourceHint(info('OPUS', false))).toBe('lossy')
    expect(restoreSourceHint(info('VORBIS', false))).toBe('lossy')
    expect(restoreSourceHint(info('FLAC', true))).toBe('lossless')
    expect(restoreSourceHint(info('WAV', true))).toBe('lossless')
    expect(restoreSourceHint(info('DSD', true, true))).toBe('dsd')
    expect(restoreSourceHint(null)).toBe('unknown')
  })
})

describe('ffmpeg codec names (live radio)', () => {
  it('parses the input stream line', () => {
    expect(parseFfmpegAudioCodec('[info]   Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s')).toBe('mp3')
    expect(parseFfmpegAudioCodec('[info]   Stream #0:0[0x1](eng): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz')).toBe('aac')
    expect(parseFfmpegAudioCodec('[info]   Duration: N/A, start: 0.000000, bitrate: 128 kb/s')).toBeNull()
  })

  it('classifies only identified codecs', () => {
    expect(restoreSourceForFfmpegCodec('mp3')).toBe('lossy')
    expect(restoreSourceForFfmpegCodec('aac')).toBe('lossy')
    expect(restoreSourceForFfmpegCodec('opus')).toBe('lossy')
    expect(restoreSourceForFfmpegCodec('vorbis')).toBe('lossy')
    expect(restoreSourceForFfmpegCodec('flac')).toBe('lossless')
    expect(restoreSourceForFfmpegCodec('pcm_s16le')).toBe('lossless')
    expect(restoreSourceForFfmpegCodec('somethingnew')).toBe('unknown')
    expect(restoreSourceForFfmpegCodec(null)).toBe('unknown')
  })
})
