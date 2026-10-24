import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const {
  dsdDecodeRate,
  prepareLocalPlaybackFile,
  resolveDsdPcmTarget,
  sanitizeDsdConversionOptions,
  toDsdPcmTarget,
} = await import('./localPlayback')

describe('DSD conversion options', () => {
  it('rejects unusable renderer input', () => {
    expect(sanitizeDsdConversionOptions(null)).toEqual({ sampleRate: 176_400, filterHz: 0, gainDb: 0 })
    expect(sanitizeDsdConversionOptions({ sampleRate: 12345, filterHz: 90_000, gainDb: 12 }))
      .toEqual({ sampleRate: 176_400, filterHz: 0, gainDb: 0 })
    expect(sanitizeDsdConversionOptions({ sampleRate: 352_800, filterHz: 50_000, gainDb: 6 }))
      .toEqual({ sampleRate: 352_800, filterHz: 50_000, gainDb: 6 })
  })

  it('decodes to the lowest dsdRate / 2^k at or above the request, like the engine', () => {
    expect(dsdDecodeRate(2_822_400, 176_400)).toBe(176_400)
    expect(dsdDecodeRate(2_822_400, 48_000)).toBe(88_200)
    expect(dsdDecodeRate(2_822_400, 384_000)).toBe(352_800)
    expect(dsdDecodeRate(11_289_600, 44_100)).toBe(44_100)
    expect(dsdDecodeRate(3_072_000, 96_000)).toBe(96_000)
    expect(dsdDecodeRate(0, 96_000)).toBe(0)
  })
})

describe('DSD playback targets', () => {
  it('round-trips the source file and its conversion settings', () => {
    const options = { sampleRate: 88_200, filterHz: 30_000, gainDb: 6 }
    const target = toDsdPcmTarget('/Music/A #1/track.dsf', options)
    expect(resolveDsdPcmTarget(target)).toEqual({ sourcePath: '/Music/A #1/track.dsf', options })
    expect(resolveDsdPcmTarget('/Music/track.flac')).toBeNull()
  })

  it('reports the rate the engine decodes to, without converting anything', async () => {
    const prepared = await prepareLocalPlaybackFile(
      '/Music/track.dsf',
      { isDsd: true, sampleRate: 11_289_600, channels: 2 },
      { sampleRate: 48_000, filterHz: 20_000, gainDb: 0 },
    )
    expect(prepared.outputFormat).toMatchObject({ sampleRate: 88_200, bitDepth: 32, channels: 2, isDsd: false })
    expect(resolveDsdPcmTarget(prepared.playbackPath)).toEqual({
      sourcePath: '/Music/track.dsf',
      options: { sampleRate: 88_200, filterHz: 20_000, gainDb: 0 },
    })
    await expect(prepareLocalPlaybackFile('/Music/track.flac', { sampleRate: 44_100 }))
      .resolves.toEqual({ playbackPath: '/Music/track.flac', outputFormat: null })
  })
})
