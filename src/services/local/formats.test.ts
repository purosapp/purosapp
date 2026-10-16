import { describe, expect, it } from 'vitest'
import { classifyFormat, formatDisplayBitDepth, formatLabel, isHighQualityLossyFormat, isLossyFormat } from './formats'

describe('format display helpers', () => {
  it('labels Vorbis as 16-bit and keeps real bit depths', () => {
    expect(formatDisplayBitDepth({ format: 'VORBIS', bitDepth: 0 })).toBe('16bit')
    expect(formatDisplayBitDepth({ format: 'FLAC', bitDepth: 24 })).toBe('24bit')
    expect(formatDisplayBitDepth({ format: 'DSD', bitDepth: 0 })).toBeNull()
  })

  it('labels MP3 as 16-bit for display only', () => {
    expect(formatDisplayBitDepth({ format: 'MP3', bitDepth: 0 })).toBe('16bit')
  })

  it('labels YouTube Music Opus and AAC as 16-bit for display only', () => {
    expect(formatDisplayBitDepth({ format: 'OPUS', bitDepth: 0 })).toBe('16bit')
    expect(formatDisplayBitDepth({ format: 'AAC', bitDepth: 0 })).toBe('16bit')
    expect(formatLabel('OPUS')).toBe('Opus')
  })
})

describe('lossy classification', () => {
  it('classifies Opus as lossy at its 48 kHz decode rate, never Hi-Res', () => {
    const opus = classifyFormat({ codec: 'Opus', container: 'Ogg', sampleRate: 44_100, bitDepth: 16, bitrate: 160_000, channels: 2 })
    expect(opus).toMatchObject({ format: 'OPUS', sampleRate: 48_000, bitDepth: 0, bitrate: 160, isLossless: false, isHiRes: false })
    const aac = classifyFormat({ codec: 'AAC', container: 'M4A', sampleRate: 96_000, bitDepth: 16, bitrate: 256_000, channels: 2 })
    expect(aac).toMatchObject({ format: 'AAC', sampleRate: 96_000, bitDepth: 0, isLossless: false, isHiRes: false })
    expect(isLossyFormat('OPUS')).toBe(true)
    expect(isLossyFormat('FLAC')).toBe(false)
  })

  it('treats high-bitrate Opus like other high-quality lossy codecs', () => {
    expect(isHighQualityLossyFormat({ format: 'OPUS', bitrate: 256 })).toBe(true)
    expect(isHighQualityLossyFormat({ format: 'OPUS', bitrate: 128 })).toBe(false)
  })
})
