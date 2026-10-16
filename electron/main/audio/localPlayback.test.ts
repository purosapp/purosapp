import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { buildDsdFilterChain, sanitizeDsdConversionOptions } = await import('./localPlayback')

describe('DSD conversion options', () => {
  it('rejects unusable renderer input', () => {
    expect(sanitizeDsdConversionOptions(null)).toEqual({ sampleRate: 176_400, filterHz: 0, gainDb: 0, precision: 28 })
    expect(sanitizeDsdConversionOptions({ sampleRate: 12345, filterHz: 90_000, gainDb: 12, precision: 64 }))
      .toEqual({ sampleRate: 176_400, filterHz: 0, gainDb: 0, precision: 28 })
    expect(sanitizeDsdConversionOptions({ sampleRate: 352_800, filterHz: 50_000, gainDb: 6, precision: 32 }))
      .toEqual({ sampleRate: 352_800, filterHz: 50_000, gainDb: 6, precision: 32 })
  })

  it('builds the SoX filter chain, with a plain fallback', () => {
    const options = { sampleRate: 176_400, filterHz: 30_000, gainDb: 3, precision: 28 }
    expect(buildDsdFilterChain(options)).toBe(
      'aresample=osr=176400:resampler=soxr:precision=28,asupercut=cutoff=30000:order=10,volume=3dB',
    )
    expect(buildDsdFilterChain(options, false)).toBe('aresample=osr=176400,volume=3dB')
    expect(buildDsdFilterChain({ ...options, filterHz: 0, gainDb: 0 })).toBe('aresample=osr=176400:resampler=soxr:precision=28')
  })
})
