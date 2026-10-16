import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESAMPLING,
  describeResampler,
  resolveDsdConversionOptions,
  resolveDsdOutputRate,
  resolveDsdPcmRate,
  sanitizeResamplingSettings,
  toNativeResamplerConfig,
} from './resamplingSettings'

const caps = (rates: number[]) => ({
  supportedFormats: rates.map((sampleRate) => ({ sampleRate, bitDepth: 24, isFloat: false, channels: 2 })),
})

describe('sanitizeResamplingSettings', () => {
  it('fills defaults and clamps ranges', () => {
    expect(sanitizeResamplingSettings(undefined)).toEqual(DEFAULT_RESAMPLING)
    const settings = sanitizeResamplingSettings({
      engine: 'apple',
      soxrPreset: 'custom',
      soxrPrecision: 99,
      passbandPercent: 99.9,
      stopbandPercent: 90,
      phaseResponse: -5,
      outputBitDepth: 20,
      dsdFilter: 30000,
      dsdGainDb: 6,
      fixedSampleRate: 12345,
      upsampling: '16x',
      maxOutputRate: 192000,
      headroomDb: 4,
      dither: 'shaped5',
      deemphasis: 'maybe',
      nxFilter: { soxrPreset: 'apodizing', phaseResponse: 0 },
    })
    expect(settings).toMatchObject({
      engine: 'apple',
      soxrPreset: 'custom',
      soxrPrecision: 32,
      passbandPercent: 99.5,
      stopbandPercent: 100,
      phaseResponse: 0,
      outputBitDepth: 'auto',
      dsdFilter: 30000,
      dsdGainDb: 6,
      fixedSampleRate: 48000,
      upsampling: 'off',
      maxOutputRate: 192000,
      headroomDb: 0,
      dither: 'shaped5',
      deemphasis: 'auto',
    })
    expect(settings.nxFilter).toMatchObject({ soxrPreset: 'apodizing', phaseResponse: 0, soxrPrecision: 28 })
  })
})

describe('toNativeResamplerConfig', () => {
  it('maps presets to SoX recipes and leaves fine-tuning at recipe defaults', () => {
    const native = toNativeResamplerConfig(DEFAULT_RESAMPLING)
    expect(native).toMatchObject({ engine: 'soxr', dither: 'tpdf', headroomDb: 0 })
    expect(native.filter1x).toMatchObject({ recipe: 6, precision: 0, passbandEnd: 0, stopbandBegin: 0, phaseResponse: 50 })
    // Without a separate hi-res filter both slots use the same design.
    expect(native.filterNx).toEqual(native.filter1x)
  })

  it('passes custom filter parameters as fractions of Nyquist', () => {
    const native = toNativeResamplerConfig({
      ...DEFAULT_RESAMPLING, soxrPreset: 'custom', soxrPrecision: 32, passbandPercent: 95, stopbandPercent: 101,
    })
    expect(native.filter1x).toMatchObject({ recipe: 7, precision: 32, passbandEnd: 0.95, stopbandBegin: 1.01 })
  })

  it('uses a separate hi-res filter and the apodizing design', () => {
    const native = toNativeResamplerConfig({
      ...DEFAULT_RESAMPLING,
      soxrPreset: 'apodizing',
      allowAliasing: true,
      headroomDb: 3,
      dither: 'shaped9',
      nxFilter: { ...DEFAULT_RESAMPLING, soxrPreset: 'high', phaseResponse: 0, steepFilter: true, allowAliasing: false,
        soxrPrecision: 28, passbandPercent: 91.3, stopbandPercent: 100 },
    })
    expect(native.filter1x).toMatchObject({ recipe: 6, passbandEnd: 0.87, stopbandBegin: 1, allowAliasing: false })
    expect(native.filterNx).toMatchObject({ recipe: 4, phaseResponse: 0, steepFilter: true, passbandEnd: 0 })
    expect(native).toMatchObject({ headroomDb: 3, dither: 'shaped9' })
  })

  it('maps Apple quality to AudioConverter values', () => {
    expect(toNativeResamplerConfig({ ...DEFAULT_RESAMPLING, engine: 'apple', appleQuality: 'high' }).appleQuality).toBe(0x60)
  })
})

describe('describeResampler', () => {
  it('names the engine and preset', () => {
    expect(describeResampler(DEFAULT_RESAMPLING)).toBe('SoX VHQ · linear phase')
    expect(describeResampler({ ...DEFAULT_RESAMPLING, phaseResponse: 0, steepFilter: true })).toBe('SoX VHQ · minimum phase, steep')
    expect(describeResampler({ ...DEFAULT_RESAMPLING, engine: 'apple' })).toBe('Apple Mastering · maximum')
    const split = { ...DEFAULT_RESAMPLING, nxFilter: { ...DEFAULT_RESAMPLING, soxrPreset: 'apodizing' as const, phaseResponse: 0 } }
    expect(describeResampler(split, '1x')).toBe('SoX VHQ · linear phase')
    expect(describeResampler(split, 'nx')).toBe('SoX Apodizing · minimum phase')
  })
})

describe('DSD to PCM', () => {
  it('picks the highest 44.1 kHz multiple the output supports', () => {
    expect(resolveDsdPcmRate('auto', caps([44_100, 88_200, 176_400, 192_000]))).toBe(176_400)
    expect(resolveDsdPcmRate('auto', caps([44_100, 48_000, 352_800]))).toBe(352_800)
    // No 44.1k multiple ≥ 88.2k: the device's own maximum, so no second conversion is needed.
    expect(resolveDsdPcmRate('auto', caps([48_000, 96_000]))).toBe(96_000)
    expect(resolveDsdPcmRate('auto', null)).toBe(176_400)
    expect(resolveDsdPcmRate(88_200, caps([48_000]))).toBe(88_200)
  })

  it('drops an ultrasonic filter at or above the new Nyquist', () => {
    const settings = { ...DEFAULT_RESAMPLING, dsdFilter: 50000 as const, dsdGainDb: 6 as const }
    expect(resolveDsdConversionOptions(settings, caps([176_400]))).toEqual({ sampleRate: 176_400, filterHz: 50_000, gainDb: 6, precision: 28 })
    expect(resolveDsdConversionOptions(settings, caps([88_200])).filterHz).toBe(0)
  })
})

describe('FIR engine and room correction', () => {
  it('sanitizes FIR and convolution settings', () => {
    const settings = sanitizeResamplingSettings({
      engine: 'fir',
      fir: { window: 'gauss', length: 'extreme', phase: 'minimum', apodizing: false, cutoffPercent: 150, attenuationDb: 10 },
      firNx: { window: 'nope', length: 'short' },
      convolution: { path: '  ', gainDb: -99 },
    })
    expect(settings.engine).toBe('fir')
    expect(settings.fir).toEqual({
      window: 'gauss', length: 'extreme', phase: 'minimum', apodizing: false, cutoffPercent: 110, attenuationDb: 80,
    })
    expect(settings.firNx).toMatchObject({ window: 'kaiser', length: 'short', phase: 'linear', apodizing: true })
    expect(settings.convolution).toEqual({ path: null, gainDb: -30, compensateDelay: true })
  })

  it('maps FIR designs and the room-correction file to the native config', () => {
    const native = toNativeResamplerConfig({
      ...DEFAULT_RESAMPLING,
      engine: 'fir',
      fir: { ...DEFAULT_RESAMPLING.fir, length: 'extreme', phase: 'minimum' },
      convolution: { path: '/filters/room.wav', gainDb: -4.5, compensateDelay: false },
    })
    expect(native.engine).toBe('fir')
    expect(native.fir1x).toEqual({
      window: 'kaiser', tapsPerPhase: 65536, minimumPhase: true, apodizing: true, cutoff: 1, attenuationDb: 160,
    })
    // No separate hi-res design: both slots use the 1x one.
    expect(native.firNx).toEqual(native.fir1x)
    expect(native.convolution).toEqual({ path: '/filters/room.wav', gainDb: -4.5, compensateDelay: false })
    expect(toNativeResamplerConfig(DEFAULT_RESAMPLING).convolution).toBeNull()
  })

  it('describes the FIR filter in use', () => {
    const settings = { ...DEFAULT_RESAMPLING, engine: 'fir' as const, firNx: { ...DEFAULT_RESAMPLING.fir, window: 'gauss' as const, length: 'short' as const } }
    expect(describeResampler(settings, '1x')).toBe('FIR Kaiser long · linear phase, apodizing')
    expect(describeResampler(settings, 'nx')).toBe('FIR Gauss short · linear phase, apodizing')
    // A 44.1 ↔ 48 kHz track falls back to SoX even with the FIR engine selected.
    expect(describeResampler(settings, '1x', 'soxr')).toBe('SoX VHQ · linear phase')
  })
})

describe('PCM → DSD output', () => {
  it('sanitizes the DSD output settings', () => {
    expect(sanitizeResamplingSettings({ dsdOutput: 512, dsdModulator: 'x', dsdRemodulate: 'yes' }))
      .toMatchObject({ dsdOutput: 'off', dsdModulator: 'sdm7', dsdRemodulate: false })
    expect(sanitizeResamplingSettings({ dsdOutput: 128, dsdModulator: 'sdm7ec', dsdRemodulate: true }))
      .toMatchObject({ dsdOutput: 128, dsdModulator: 'sdm7ec', dsdRemodulate: true })
  })

  it('picks the DSD rate the output can take over DoP', () => {
    expect(resolveDsdOutputRate('off', 'DoP256')).toBe(0)
    expect(resolveDsdOutputRate(128, 'FallbackPCM')).toBe(0)
    expect(resolveDsdOutputRate(64, 'DoP256')).toBe(2822400)
    expect(resolveDsdOutputRate(256, 'DoP128')).toBe(5644800)
    expect(resolveDsdOutputRate('max', 'DoP256')).toBe(11289600)
    expect(resolveDsdOutputRate('max', null)).toBe(0)
  })

  it('passes the modulator to the engine', () => {
    expect(toNativeResamplerConfig({ ...DEFAULT_RESAMPLING, dsdModulator: 'sdm5' }).modulator).toBe('sdm5')
  })
})
