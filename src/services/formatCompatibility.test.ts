import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OUTPUT_POLICY,
  buildDeviceCapabilities,
  isLossyCodec,
  requiresSampleRateConversion,
  resolvePlaybackFormat,
  type OutputFormatPolicy,
} from './formatCompatibility'

function device(formats: Array<[number, number, boolean]>) {
  return buildDeviceCapabilities({
    id: 'dac',
    name: 'DAC',
    supportedFormats: formats.map(([sampleRate, bitDepth, isFloat]) => ({ sampleRate, bitDepth, isFloat, channels: 2 })),
  })
}

describe('output negotiation', () => {
  const dac = device([[44_100, 16, false], [44_100, 24, false], [48_000, 16, false], [48_000, 24, false], [48_000, 32, true]])

  it('keeps lossless sources bit-perfect', () => {
    expect(resolvePlaybackFormat({ sampleRate: 44_100, bitDepth: 16, channels: 2, codec: 'FLAC' }, dac)).toMatchObject({
      mode: 'BIT_PERFECT', deviceSampleRate: 44_100, deviceBitDepth: 16,
    })
  })

  it('opens Opus at its 48 kHz decode rate with the widest integer format, without claiming bit-perfect', () => {
    const decision = resolvePlaybackFormat({ sampleRate: 48_000, bitDepth: 0, channels: 2, codec: 'OPUS' }, dac)
    expect(decision).toMatchObject({ mode: 'NATIVE_RATE', deviceSampleRate: 48_000, deviceBitDepth: 24 })
    expect(decision.reason).toMatch(/bit-perfect does not apply/)
    expect(requiresSampleRateConversion(decision)).toBe(false)
  })

  it('treats AAC at 44.1 kHz the same way', () => {
    expect(resolvePlaybackFormat({ sampleRate: 44_100, bitDepth: 0, channels: 2, codec: 'AAC' }, dac)).toMatchObject({
      mode: 'NATIVE_RATE', deviceSampleRate: 44_100, deviceBitDepth: 24,
    })
  })

  it('reports a rate conversion when the device lacks 48 kHz', () => {
    const only441 = device([[44_100, 24, false]])
    const decision = resolvePlaybackFormat({ sampleRate: 48_000, bitDepth: 0, channels: 2, codec: 'OPUS' }, only441)
    expect(decision.mode).toBe('RESAMPLED')
    expect(requiresSampleRateConversion(decision)).toBe(true)
  })

  it('knows which codecs are lossy', () => {
    expect(['MP3', 'AAC', 'VORBIS', 'OPUS'].every(isLossyCodec)).toBe(true)
    expect(isLossyCodec('FLAC')).toBe(false)
  })
})

describe('output format policy', () => {
  const policy = (patch: Partial<OutputFormatPolicy>): OutputFormatPolicy => ({ ...DEFAULT_OUTPUT_POLICY, ...patch })
  const flac = (sampleRate: number, bitDepth = 24) => ({ sampleRate, bitDepth, channels: 2, codec: 'FLAC' })
  const wide = device([
    [44_100, 16, false], [44_100, 24, false], [48_000, 24, false], [88_200, 24, false],
    [96_000, 24, false], [176_400, 24, false], [192_000, 24, false],
  ])
  const only48 = device([[48_000, 16, false], [48_000, 24, false], [96_000, 24, false]])

  it('matches the classic decision with the default policy', () => {
    for (const rate of [44_100, 48_000, 96_000, 352_800]) {
      expect(resolvePlaybackFormat(flac(rate), wide, DEFAULT_OUTPUT_POLICY)).toEqual(resolvePlaybackFormat(flac(rate), wide))
    }
  })

  it('picks the lowest supported rate at or above an unsupported source', () => {
    const decision = resolvePlaybackFormat(flac(44_100), only48, policy({ targetRate: 'lowest-above' }))
    expect(decision).toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 48_000, deviceBitDepth: 24 })
    // Supported sources stay bit-perfect.
    expect(resolvePlaybackFormat(flac(48_000), only48, policy({ targetRate: 'lowest-above' })).mode).toBe('BIT_PERFECT')
  })

  it('plays everything at a fixed rate when the output has it', () => {
    expect(resolvePlaybackFormat(flac(44_100), wide, policy({ targetRate: 'fixed', fixedSampleRate: 48_000 })))
      .toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 48_000 })
    expect(resolvePlaybackFormat(flac(48_000), wide, policy({ targetRate: 'fixed', fixedSampleRate: 48_000 })).mode)
      .toBe('BIT_PERFECT')
    // Unavailable fixed rate → classic rules.
    expect(resolvePlaybackFormat(flac(96_000), only48, policy({ targetRate: 'fixed', fixedSampleRate: 44_100 })))
      .toMatchObject({ mode: 'BIT_PERFECT', deviceSampleRate: 96_000 })
  })

  it('upsamples within the rate family or to the device maximum', () => {
    expect(resolvePlaybackFormat(flac(44_100), wide, policy({ upsampling: 'family-max' })))
      .toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 176_400 })
    expect(resolvePlaybackFormat(flac(48_000), wide, policy({ upsampling: 'family-max' })))
      .toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 192_000 })
    expect(resolvePlaybackFormat(flac(44_100), wide, policy({ upsampling: 'device-max' })))
      .toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 192_000 })
    // Already at the top: nothing to do.
    expect(resolvePlaybackFormat(flac(192_000), wide, policy({ upsampling: 'device-max' })).mode).toBe('BIT_PERFECT')
  })

  it('upsamples by whole multiples of the source, within the rate cap', () => {
    const big = device([
      [44_100, 24, false], [48_000, 24, false], [88_200, 24, false], [96_000, 24, false],
      [176_400, 24, false], [192_000, 24, false], [352_800, 24, false], [384_000, 24, false],
    ])
    expect(resolvePlaybackFormat(flac(44_100), big, policy({ upsampling: '2x' })))
      .toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 88_200 })
    // A 16-bit source is upsampled into the deepest format, not requantized back to 16 bit.
    const deep = device([[44_100, 16, false], [176_400, 16, false], [176_400, 32, false]])
    expect(resolvePlaybackFormat(flac(44_100, 16), deep, policy({ upsampling: '4x' })))
      .toMatchObject({ deviceSampleRate: 176_400, deviceBitDepth: 32 })
    expect(resolvePlaybackFormat(flac(48_000), big, policy({ upsampling: '4x' })))
      .toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 192_000 })
    expect(resolvePlaybackFormat(flac(44_100), big, policy({ upsampling: '8x' })))
      .toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 352_800 })
    // Capped: 8× of 44.1 limited to 192 kHz → 176.4 kHz (4×).
    expect(resolvePlaybackFormat(flac(44_100), big, policy({ upsampling: '8x', maxOutputRate: 192_000 })))
      .toMatchObject({ deviceSampleRate: 176_400 })
    // Hi-res source: 2× of 96 kHz is 192 kHz.
    expect(resolvePlaybackFormat(flac(96_000), big, policy({ upsampling: '2x' })))
      .toMatchObject({ deviceSampleRate: 192_000 })
    // Largest supported multiple when the exact factor is missing.
    expect(resolvePlaybackFormat(flac(44_100), wide, policy({ upsampling: '8x' })))
      .toMatchObject({ deviceSampleRate: 176_400 })
    // No higher multiple available → stays bit-perfect.
    expect(resolvePlaybackFormat(flac(192_000), wide, policy({ upsampling: '2x' })).mode).toBe('BIT_PERFECT')
    // The cap also bounds device-max.
    expect(resolvePlaybackFormat(flac(44_100), big, policy({ upsampling: 'device-max', maxOutputRate: 96_000 })))
      .toMatchObject({ deviceSampleRate: 96_000 })
  })

  it('forces the output bit depth and reports requantization', () => {
    const decision = resolvePlaybackFormat(flac(44_100, 24), wide, policy({ outputBitDepth: 16 }))
    expect(decision).toMatchObject({ mode: 'RESAMPLED', deviceSampleRate: 44_100, deviceBitDepth: 16 })
    expect(requiresSampleRateConversion(decision)).toBe(false)
    expect(resolvePlaybackFormat(flac(44_100, 16), wide, policy({ outputBitDepth: 24 })))
      .toMatchObject({ mode: 'BIT_PERFECT', deviceBitDepth: 24 })
    // 32 bit is unavailable: the deepest integer format below it is used.
    expect(resolvePlaybackFormat(flac(96_000, 24), wide, policy({ outputBitDepth: 32 })))
      .toMatchObject({ mode: 'BIT_PERFECT', deviceBitDepth: 24 })
  })
})
