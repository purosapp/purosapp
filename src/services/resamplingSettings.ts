/**
 * Resampling, requantization and DSD → PCM settings (PowerAmp-style).
 *
 * Applied only when the output cannot take the source as-is (or a policy asks
 * for a different rate); bit-perfect playback never goes through a resampler.
 * One global set lives in Audio Setup; any device can override it.
 */

import type { DeviceCapabilities } from './formatCompatibility'

/** fir: long-FIR filters for integer ratios (×2…×16, ÷2…÷16), SoX for the rest. */
export type ResamplerEngineSetting = 'soxr' | 'fir' | 'apple'
export type FirWindowSetting = 'kaiser' | 'blackman-harris' | 'gauss'
export type FirLengthSetting = 'short' | 'medium' | 'long' | 'extreme'
export type FirPhaseSetting = 'linear' | 'minimum'
export type SoxrPreset = 'quick' | 'low' | 'medium' | 'high' | 'very-high' | 'apodizing' | 'custom'
export type AppleComplexity = 'linear' | 'normal' | 'mastering'
export type AppleQuality = 'min' | 'low' | 'medium' | 'high' | 'max'
/** Which rate to use when the source rate is not available on the output. */
export type TargetRatePolicy = 'family-max' | 'lowest-above' | 'fixed'
/** Resample even when the source rate is supported: to a multiple of it, or to the highest rate. */
export type UpsamplingMode = 'off' | '2x' | '4x' | '8x' | 'family-max' | 'device-max'
export type OutputBitDepthSetting = 'auto' | 16 | 24 | 32
export type DitherSetting = 'none' | 'tpdf' | 'gauss' | 'shaped' | 'shaped5' | 'shaped9'
export type HeadroomSetting = 0 | 1 | 2 | 3 | 6
export type DeemphasisSetting = 'auto' | 'off'
/** 0 = no limit. Caps every upsampling mode. */
export type MaxOutputRateSetting = 0 | 96000 | 192000 | 384000 | 768000
export type DsdPcmRateSetting = 'auto' | 88200 | 176400 | 352800
export type DsdFilterSetting = 'off' | 20000 | 24000 | 30000 | 50000
export type DsdGainSetting = 0 | 3 | 6
/** PCM → DSD upsampling target (sent as DoP). */
export type DsdOutputSetting = 'off' | 64 | 128 | 256 | 'max'
export type DsdModulatorSetting = 'sdm5' | 'sdm7' | 'sdm7ec'

/** One long-FIR design (engine "fir"). */
export interface FirFilterSettings {
  window: FirWindowSetting
  length: FirLengthSetting
  phase: FirPhaseSetting
  /** Full attenuation at the lower Nyquist (no source-filter ringing passes). */
  apodizing: boolean
  /** −6 dB point, % of the lower Nyquist, when not apodizing. */
  cutoffPercent: number
  /** Kaiser stopband attenuation. */
  attenuationDb: number
}

/** Room-correction convolution (FIR impulse from a WAV/AIFF/FLAC file). */
export interface ConvolutionSettings {
  path: string | null
  gainDb: number
  /** Drop the samples before the filter's main peak so playback stays in sync. */
  compensateDelay: boolean
}

/** One SoX filter design. */
export interface SoxrFilterSettings {
  soxrPreset: SoxrPreset
  /** Custom preset only. */
  soxrPrecision: number
  /** Custom preset only: 0 dB bandwidth, % of Nyquist. */
  passbandPercent: number
  /** Custom preset only: where full attenuation starts, % of Nyquist. */
  stopbandPercent: number
  /** 0 = minimum phase, 50 = linear, 100 = maximum phase. */
  phaseResponse: number
  steepFilter: boolean
  allowAliasing: boolean
}

export interface ResamplingSettings extends SoxrFilterSettings {
  engine: ResamplerEngineSetting
  /** The SoxrFilterSettings fields above are the filter for 1x (44.1/48 kHz) sources. */
  soxrPreset: SoxrPreset
  /** Custom preset only. */
  soxrPrecision: number
  /** Custom preset only: 0 dB bandwidth, % of Nyquist. */
  passbandPercent: number
  /** Custom preset only: where full attenuation starts, % of Nyquist. */
  stopbandPercent: number
  /** 0 = minimum phase, 50 = linear, 100 = maximum phase. */
  phaseResponse: number
  steepFilter: boolean
  allowAliasing: boolean
  appleComplexity: AppleComplexity
  appleQuality: AppleQuality
  targetRate: TargetRatePolicy
  fixedSampleRate: number
  upsampling: UpsamplingMode
  maxOutputRate: MaxOutputRateSetting
  outputBitDepth: OutputBitDepthSetting
  dither: DitherSetting
  /** Attenuation in the processing path so inter-sample peaks don't clip. */
  headroomDb: HeadroomSetting
  /** Separate filter for hi-res (88.2 kHz+) sources; null → same as the 1x filter. */
  nxFilter: SoxrFilterSettings | null
  /** Undo CD pre-emphasis flagged in the CUE sheet or tags. */
  deemphasis: DeemphasisSetting
  /** Engine "fir": filter for 1x sources, and optionally another for hi-res. */
  fir: FirFilterSettings
  firNx: FirFilterSettings | null
  convolution: ConvolutionSettings
  /** Upsample PCM to DSD in exclusive mode on DoP-capable outputs. */
  dsdOutput: DsdOutputSetting
  dsdModulator: DsdModulatorSetting
  /** DSD sources: convert to the DSD output rate instead of passing them through. */
  dsdRemodulate: boolean
  dsdPcmRate: DsdPcmRateSetting
  dsdFilter: DsdFilterSetting
  dsdGainDb: DsdGainSetting
}

export const DEFAULT_RESAMPLING: ResamplingSettings = {
  engine: 'soxr',
  soxrPreset: 'very-high',
  soxrPrecision: 28,
  passbandPercent: 91.3,
  stopbandPercent: 100,
  phaseResponse: 50,
  steepFilter: false,
  allowAliasing: false,
  appleComplexity: 'mastering',
  appleQuality: 'max',
  targetRate: 'family-max',
  fixedSampleRate: 48000,
  upsampling: 'off',
  maxOutputRate: 0,
  outputBitDepth: 'auto',
  dither: 'tpdf',
  headroomDb: 0,
  nxFilter: null,
  deemphasis: 'auto',
  fir: {
    window: 'kaiser',
    length: 'long',
    phase: 'linear',
    apodizing: true,
    cutoffPercent: 100,
    attenuationDb: 160,
  },
  firNx: null,
  convolution: { path: null, gainDb: 0, compensateDelay: true },
  dsdOutput: 'off',
  dsdModulator: 'sdm7',
  dsdRemodulate: false,
  dsdPcmRate: 'auto',
  dsdFilter: 'off',
  dsdGainDb: 0,
}

export const SOXR_PRESETS: ReadonlyArray<{ id: SoxrPreset; label: string; short: string; description: string }> = [
  { id: 'quick', label: 'Quick', short: 'QQ', description: 'Cubic interpolation — lowest CPU, audible aliasing. Only for very weak hardware.' },
  { id: 'low', label: 'Low', short: 'LQ', description: '16-bit precision with a wide roll-off.' },
  { id: 'medium', label: 'Medium', short: 'MQ', description: '16-bit precision with a medium roll-off.' },
  { id: 'high', label: 'High', short: 'HQ', description: '20-bit precision, 91.3% bandwidth — transparent for 16-bit sources.' },
  { id: 'very-high', label: 'Very High', short: 'VHQ', description: '28-bit precision, 91.3% bandwidth — transparent for 24-bit sources.' },
  { id: 'apodizing', label: 'Apodizing', short: 'Apodizing', description: '28-bit, rolls off from 87% and reaches full attenuation at the source Nyquist — removes the pre-ringing of the recording’s own filter (≈19–22 kHz at 44.1 kHz).' },
  { id: 'custom', label: 'Custom', short: 'Custom', description: 'Set precision, pass-band and stop-band yourself.' },
]

const SOXR_RECIPES: Record<SoxrPreset, number> = {
  quick: 0,
  low: 1,
  medium: 2,
  high: 4,
  'very-high': 6,
  apodizing: 6,
  custom: 7,
}

/** The apodizing preset: VHQ with an earlier, gentler transition that ends at Nyquist. */
const APODIZING = { passbandEnd: 0.87, stopbandBegin: 1.0 }

export const DITHER_OPTIONS: ReadonlyArray<{ id: DitherSetting; label: string; description: string }> = [
  { id: 'none', label: 'None', description: 'Plain rounding — distortion correlated with the music at low levels.' },
  { id: 'tpdf', label: 'TPDF', description: 'Triangular dither: flat, signal-independent noise.' },
  { id: 'gauss', label: 'Gaussian', description: 'Gaussian dither (σ = 0.5 LSB): slightly lower noise than TPDF.' },
  { id: 'shaped', label: 'Shaped (light)', description: 'TPDF + 3-tap noise shaping (E-weighted at 44.1/48 kHz).' },
  { id: 'shaped5', label: 'Shaped 5th', description: 'TPDF + 5th-order shaping (Lipshitz at 44.1/48 kHz, audio-band zeros above).' },
  { id: 'shaped9', label: 'Shaped 9th', description: 'TPDF + 9th-order shaping (improved E-weighted at 44.1/48 kHz, audio-band zeros above). Most noise moved out of the audible band, most ultrasonic energy.' },
]

/** Taps per polyphase branch for each length (kernel = ratio × taps + 1). */
export const FIR_LENGTH_TAPS: Record<FirLengthSetting, number> = {
  short: 64,
  medium: 512,
  long: 4096,
  extreme: 65536,
}

export const FIR_LENGTHS: ReadonlyArray<{ id: FirLengthSetting; label: string; description: string }> = [
  { id: 'short', label: 'Short', description: 'Very short ringing, gentle transition — rolls off some top-octave treble.' },
  { id: 'medium', label: 'Medium', description: 'Balanced: flat to ~20 kHz, short ringing.' },
  { id: 'long', label: 'Long', description: 'Flat to ~21.9 kHz at 44.1 kHz, ringing confined to the transition band.' },
  { id: 'extreme', label: 'Extreme', description: 'Up to ~1M taps (×16): brick-wall transition at Nyquist, longest ringing.' },
]

export const FIR_WINDOWS: ReadonlyArray<{ id: FirWindowSetting; label: string; description: string }> = [
  { id: 'kaiser', label: 'Kaiser', description: 'Adjustable stopband (attenuation below); the sharpest transition for a given length.' },
  { id: 'blackman-harris', label: 'Blackman-Harris', description: 'Fixed ~−90 dB stopband, wider transition, very low passband ripple.' },
  { id: 'gauss', label: 'Gauss', description: 'Gaussian window: smooth, short time-domain response, ~−120 dB stopband, gentlest roll-off.' },
]

export const HEADROOM_OPTIONS: readonly HeadroomSetting[] = [0, 1, 2, 3, 6]
export const MAX_OUTPUT_RATE_OPTIONS: readonly MaxOutputRateSetting[] = [0, 96000, 192000, 384000, 768000]

const APPLE_QUALITY_VALUES: Record<AppleQuality, number> = { min: 0, low: 0x20, medium: 0x40, high: 0x60, max: 0x7f }

export const APPLE_COMPLEXITY_LABELS: Record<AppleComplexity, string> = {
  linear: 'Linear',
  normal: 'Normal',
  mastering: 'Mastering',
}

export const APPLE_QUALITY_LABELS: Record<AppleQuality, string> = {
  min: 'Minimum',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Maximum',
}

export const PHASE_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 50, label: 'Linear' },
  { value: 25, label: 'Intermediate' },
  { value: 0, label: 'Minimum' },
]

export const FIXED_RATE_OPTIONS = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000] as const

function oneOf<T extends string | number>(values: readonly T[], value: unknown, fallback: T): T {
  return (values as readonly unknown[]).includes(value) ? value as T : fallback
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function sanitizeFir(raw: unknown): FirFilterSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const d = DEFAULT_RESAMPLING.fir
  return {
    window: oneOf(['kaiser', 'blackman-harris', 'gauss'] as const, input.window, d.window),
    length: oneOf(['short', 'medium', 'long', 'extreme'] as const, input.length, d.length),
    phase: oneOf(['linear', 'minimum'] as const, input.phase, d.phase),
    apodizing: typeof input.apodizing === 'boolean' ? input.apodizing : d.apodizing,
    cutoffPercent: clampNumber(input.cutoffPercent, 80, 110, d.cutoffPercent),
    attenuationDb: Math.round(clampNumber(input.attenuationDb, 80, 200, d.attenuationDb)),
  }
}

function sanitizeConvolution(raw: unknown): ConvolutionSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    path: typeof input.path === 'string' && input.path.trim() ? input.path : null,
    gainDb: Math.round(clampNumber(input.gainDb, -30, 12, 0) * 10) / 10,
    compensateDelay: typeof input.compensateDelay === 'boolean' ? input.compensateDelay : true,
  }
}

function sanitizeFilter(raw: unknown): SoxrFilterSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const d = DEFAULT_RESAMPLING
  const passbandPercent = clampNumber(input.passbandPercent, 80, 99.5, d.passbandPercent)
  return {
    soxrPreset: oneOf(SOXR_PRESETS.map((preset) => preset.id), input.soxrPreset, d.soxrPreset),
    soxrPrecision: Math.round(clampNumber(input.soxrPrecision, 16, 32, d.soxrPrecision)),
    passbandPercent,
    stopbandPercent: Math.max(passbandPercent + 0.5, clampNumber(input.stopbandPercent, 100, 150, d.stopbandPercent)),
    phaseResponse: Math.round(clampNumber(input.phaseResponse, 0, 100, d.phaseResponse)),
    steepFilter: typeof input.steepFilter === 'boolean' ? input.steepFilter : d.steepFilter,
    allowAliasing: typeof input.allowAliasing === 'boolean' ? input.allowAliasing : d.allowAliasing,
  }
}

export function pickFilter(settings: SoxrFilterSettings): SoxrFilterSettings {
  const { soxrPreset, soxrPrecision, passbandPercent, stopbandPercent, phaseResponse, steepFilter, allowAliasing } = settings
  return { soxrPreset, soxrPrecision, passbandPercent, stopbandPercent, phaseResponse, steepFilter, allowAliasing }
}

export function sanitizeResamplingSettings(raw: unknown): ResamplingSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const d = DEFAULT_RESAMPLING
  return {
    engine: oneOf(['soxr', 'fir', 'apple'] as const, input.engine, d.engine),
    ...sanitizeFilter(input),
    appleComplexity: oneOf(['linear', 'normal', 'mastering'] as const, input.appleComplexity, d.appleComplexity),
    appleQuality: oneOf(['min', 'low', 'medium', 'high', 'max'] as const, input.appleQuality, d.appleQuality),
    targetRate: oneOf(['family-max', 'lowest-above', 'fixed'] as const, input.targetRate, d.targetRate),
    fixedSampleRate: oneOf(FIXED_RATE_OPTIONS, input.fixedSampleRate, d.fixedSampleRate as typeof FIXED_RATE_OPTIONS[number]),
    upsampling: oneOf(['off', '2x', '4x', '8x', 'family-max', 'device-max'] as const, input.upsampling, d.upsampling),
    maxOutputRate: oneOf(MAX_OUTPUT_RATE_OPTIONS, input.maxOutputRate, d.maxOutputRate),
    outputBitDepth: oneOf(['auto', 16, 24, 32] as const, input.outputBitDepth, d.outputBitDepth),
    dither: oneOf(DITHER_OPTIONS.map((option) => option.id), input.dither, d.dither),
    headroomDb: oneOf(HEADROOM_OPTIONS, input.headroomDb, d.headroomDb),
    nxFilter: input.nxFilter && typeof input.nxFilter === 'object' ? sanitizeFilter(input.nxFilter) : null,
    deemphasis: oneOf(['auto', 'off'] as const, input.deemphasis, d.deemphasis),
    fir: sanitizeFir(input.fir),
    firNx: input.firNx && typeof input.firNx === 'object' ? sanitizeFir(input.firNx) : null,
    convolution: sanitizeConvolution(input.convolution),
    dsdOutput: oneOf(['off', 64, 128, 256, 'max'] as const, input.dsdOutput, d.dsdOutput),
    dsdModulator: oneOf(['sdm5', 'sdm7', 'sdm7ec'] as const, input.dsdModulator, d.dsdModulator),
    dsdRemodulate: typeof input.dsdRemodulate === 'boolean' ? input.dsdRemodulate : d.dsdRemodulate,
    dsdPcmRate: oneOf(['auto', 88200, 176400, 352800] as const, input.dsdPcmRate, d.dsdPcmRate),
    dsdFilter: oneOf(['off', 20000, 24000, 30000, 50000] as const, input.dsdFilter, d.dsdFilter),
    dsdGainDb: oneOf([0, 3, 6] as const, input.dsdGainDb, d.dsdGainDb),
  }
}

export interface NativeSoxrFilter {
  recipe: number
  precision: number
  phaseResponse: number
  passbandEnd: number
  stopbandBegin: number
  steepFilter: boolean
  allowAliasing: boolean
}

export interface NativeFirDesign {
  window: FirWindowSetting
  tapsPerPhase: number
  minimumPhase: boolean
  apodizing: boolean
  /** Fraction of the lower Nyquist. */
  cutoff: number
  attenuationDb: number
}

export function toNativeFirDesign(fir: FirFilterSettings): NativeFirDesign {
  return {
    window: fir.window,
    tapsPerPhase: FIR_LENGTH_TAPS[fir.length],
    minimumPhase: fir.phase === 'minimum',
    apodizing: fir.apodizing,
    cutoff: fir.cutoffPercent / 100,
    attenuationDb: fir.attenuationDb,
  }
}

/** Shape expected by the native engine's setResamplerConfig(). */
export interface NativeResamplerConfig {
  engine: ResamplerEngineSetting
  filter1x: NativeSoxrFilter
  filterNx: NativeSoxrFilter
  fir1x: NativeFirDesign
  firNx: NativeFirDesign
  convolution: { path: string; gainDb: number; compensateDelay: boolean } | null
  modulator: DsdModulatorSetting
  appleComplexity: AppleComplexity
  appleQuality: number
  dither: DitherSetting
  headroomDb: number
}

function toNativeFilter(filter: SoxrFilterSettings): NativeSoxrFilter {
  const custom = filter.soxrPreset === 'custom'
  const apodizing = filter.soxrPreset === 'apodizing'
  return {
    recipe: SOXR_RECIPES[filter.soxrPreset],
    precision: custom ? filter.soxrPrecision : 0,
    phaseResponse: filter.phaseResponse,
    passbandEnd: custom ? filter.passbandPercent / 100 : apodizing ? APODIZING.passbandEnd : 0,
    stopbandBegin: custom ? filter.stopbandPercent / 100 : apodizing ? APODIZING.stopbandBegin : 0,
    steepFilter: filter.steepFilter,
    // Apodizing exists to kill everything at Nyquist; aliasing would defeat it.
    allowAliasing: apodizing ? false : filter.allowAliasing,
  }
}

/** Native previewFirFilter(): magnitude/impulse of a FIR design for a rate pair. */
export type FirPreview =
  | { success: false; error: string }
  | {
      success: true
      frequencies: Float64Array
      magnitudeDb: Float64Array
      impulse: Float64Array
      impulseSampleRate: number
      impulsePeakIndex: number
      taps: number
      lengthMs: number
      passbandEdgeHz: number
      minus3DbHz: number
      attenuationAtNyquistDb: number
      preRingingMs: number
    }

export type ImpulseResponseInspection =
  | { success: false; error: string }
  | { success: true; channels: number; sampleRate: number; taps: number; peakIndex: number; peakDb: number }

/** What the engine does to the active track (native getResamplerStatus()). */
export interface ResamplerStatus {
  resampling: boolean
  engine: ResamplerEngineSetting | null
  inputRate: number
  outputRate: number
  /** 0 → no dither applied. */
  ditherBits: number
  dither: DitherSetting
  /** Which SoX filter the source rate selected. */
  filter: '1x' | 'nx'
  deemphasis: boolean
  headroomDb: number
  /** Highest level reaching the requantizer this track, dBFS. */
  peakDb: number
  clippedSamples: number
  /** FIR kernel length when the FIR engine converts this track. */
  firTaps: number
  /** Room-correction filter length (0 → off). */
  convolutionTaps: number
  /** Why the room-correction file could not be used, if it failed. */
  convolutionError: string | null
  /** PCM → DSD rate when modulating, else 0. */
  dsdOutputRate: number
  modulator: DsdModulatorSetting | null
  /** Modulator stability-guard activations (input too hot). */
  modulatorOverloads: number
}

export function toNativeResamplerConfig(settings: ResamplingSettings): NativeResamplerConfig {
  const filter1x = toNativeFilter(settings)
  return {
    engine: settings.engine,
    filter1x,
    filterNx: settings.nxFilter ? toNativeFilter(settings.nxFilter) : filter1x,
    fir1x: toNativeFirDesign(settings.fir),
    firNx: toNativeFirDesign(settings.firNx ?? settings.fir),
    convolution: settings.convolution.path
      ? { path: settings.convolution.path, gainDb: settings.convolution.gainDb, compensateDelay: settings.convolution.compensateDelay }
      : null,
    modulator: settings.dsdModulator,
    appleComplexity: settings.appleComplexity,
    appleQuality: APPLE_QUALITY_VALUES[settings.appleQuality],
    dither: settings.dither,
    headroomDb: settings.headroomDb,
  }
}

function phaseLabel(phase: number): string {
  if (phase === 50) return 'linear phase'
  if (phase === 0) return 'minimum phase'
  if (phase === 25) return 'intermediate phase'
  return `phase ${phase}`
}

/**
 * e.g. "SoX VHQ · linear phase" or "Apple Mastering · max". `filter` picks the
 * 1x or hi-res (Nx) filter when they differ.
 */
export function describeFir(fir: FirFilterSettings): string {
  const window = FIR_WINDOWS.find((entry) => entry.id === fir.window)?.label ?? fir.window
  const length = FIR_LENGTHS.find((entry) => entry.id === fir.length)?.label ?? fir.length
  return `FIR ${window} ${length.toLowerCase()} · ${fir.phase} phase${fir.apodizing ? ', apodizing' : ''}`
}

export function describeResampler(
  settings: ResamplingSettings,
  filter: '1x' | 'nx' = '1x',
  engine: ResamplerEngineSetting = settings.engine,
): string {
  if (engine === 'fir') return describeFir(filter === 'nx' && settings.firNx ? settings.firNx : settings.fir)
  if (engine === 'apple') {
    return `Apple ${APPLE_COMPLEXITY_LABELS[settings.appleComplexity]} · ${APPLE_QUALITY_LABELS[settings.appleQuality].toLowerCase()}`
  }
  const active = filter === 'nx' && settings.nxFilter ? settings.nxFilter : settings
  const preset = SOXR_PRESETS.find((entry) => entry.id === active.soxrPreset)
  const name = active.soxrPreset === 'custom'
    ? `custom ${active.soxrPrecision}-bit ${active.passbandPercent}%`
    : preset?.short ?? active.soxrPreset
  const extras = [
    active.soxrPreset !== 'quick' ? phaseLabel(active.phaseResponse) : null,
    active.steepFilter ? 'steep' : null,
    active.allowAliasing && active.soxrPreset !== 'apodizing' ? 'aliasing' : null,
  ].filter(Boolean)
  return `SoX ${name}${extras.length ? ` · ${extras.join(', ')}` : ''}`
}

export function describeDither(dither: DitherSetting): string {
  switch (dither) {
    case 'tpdf': return 'TPDF'
    case 'gauss': return 'Gaussian'
    case 'shaped': return 'TPDF + light shaping'
    case 'shaped5': return 'TPDF + 5th-order shaping'
    case 'shaped9': return 'TPDF + 9th-order shaping'
    default: return 'None'
  }
}

export const DSD_MODULATORS: ReadonlyArray<{ id: DsdModulatorSetting; label: string; description: string }> = [
  { id: 'sdm5', label: '5th order', description: 'Most robust: stable up to ~1.6 dB over full scale. ~112 dB in-band SNR at DSD64 (−6 dBFS).' },
  { id: 'sdm7', label: '7th order', description: '~132 dB in-band SNR at DSD64; stable up to ~0.8 dB over full scale.' },
  { id: 'sdm7ec', label: '7th order EC', description: 'Extended compensation: an aggressive loop (~144 dB in-band SNR at DSD64) with look-ahead hand-over to a conservative loop just before loud passages.' },
]

const DSD_RATE_BY_CAPABILITY: Record<'DoP64' | 'DoP128' | 'DoP256', number> = {
  DoP64: 2822400,
  DoP128: 5644800,
  DoP256: 11289600,
}

/** DSD rate for PCM → DSD on an output with `capability`, or 0 when it cannot take it. */
export function resolveDsdOutputRate(
  setting: DsdOutputSetting,
  capability: DeviceCapabilities['dopCapability'] | null | undefined,
): number {
  if (setting === 'off' || !capability || capability === 'FallbackPCM') return 0
  const max = DSD_RATE_BY_CAPABILITY[capability]
  if (setting === 'max') return max
  return Math.min(setting * 44100, max)
}

export function dsdRateName(rate: number): string {
  return `DSD${Math.round(rate / 44100)}`
}

export function formatMaxRate(rate: MaxOutputRateSetting): string {
  return rate === 0 ? 'No limit' : `${rate / 1000} kHz`
}

// ---------------------------------------------------------------------------
// DSD → PCM
// ---------------------------------------------------------------------------

export interface DsdConversionOptions {
  sampleRate: number
  /** Ultrasonic low-pass cutoff in Hz; 0 = off. */
  filterHz: number
  gainDb: number
  /** ffmpeg aresample precision for the SoX resampler. */
  precision: number
}

const DSD_PCM_RATES = [352800, 176400, 88200]

/**
 * Rate for DSD played as PCM. "Auto" picks the highest 44.1 kHz multiple the
 * output supports (so no second conversion is needed), else its highest rate.
 */
export function resolveDsdPcmRate(setting: DsdPcmRateSetting, caps: Pick<DeviceCapabilities, 'supportedFormats'> | null): number {
  if (setting !== 'auto') return setting
  const rates = new Set((caps?.supportedFormats ?? []).map((format) => format.sampleRate))
  const family = DSD_PCM_RATES.find((rate) => rates.has(rate))
  if (family) return family
  const highest = Math.max(0, ...rates)
  return highest >= 44100 ? highest : 176400
}

export function resolveDsdConversionOptions(
  settings: ResamplingSettings,
  caps: Pick<DeviceCapabilities, 'supportedFormats'> | null,
): DsdConversionOptions {
  const sampleRate = resolveDsdPcmRate(settings.dsdPcmRate, caps)
  // A cutoff at or above the new Nyquist is already handled by the resampler's filter.
  const filterHz = settings.dsdFilter !== 'off' && settings.dsdFilter < sampleRate * 0.475 ? settings.dsdFilter : 0
  const precision = settings.soxrPreset === 'custom'
    ? settings.soxrPrecision
    : settings.soxrPreset === 'very-high' || settings.soxrPreset === 'apodizing' ? 28
      : settings.soxrPreset === 'high' ? 20 : 16
  return { sampleRate, filterHz, gainDb: settings.dsdGainDb, precision }
}
