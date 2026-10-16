/**
 * Format compatibility engine.
 *
 * Given a track's format and a device's supported formats,
 * decides how to play: bit-perfect or resampled, and to what target format.
 */

export interface DeviceCapabilities {
  id: string
  name: string
  dopCapability: 'DoP64' | 'DoP128' | 'DoP256' | 'FallbackPCM'
  /** The device exposes a settable output volume (CoreAudio VolumeScalar). */
  hardwareVolume?: boolean
  supportedFormats: Array<{
    sampleRate: number
    bitDepth: number
    isFloat: boolean
    channels: number
  }>
  /**
   * Full device format list when Audio Setup limits trimmed `supportedFormats`;
   * DoP carriers are checked against it because DSD has its own rate limit.
   */
  dopCarrierFormats?: DeviceCapabilities['supportedFormats']
  maxSampleRate: number
  maxBitDepth: number
  supportsInteger: boolean
}

export interface TrackFormat {
  sampleRate: number
  bitDepth: number
  channels: number
  codec: string
}

export type PlaybackDecision =
  | {
      mode: 'BIT_PERFECT'
      deviceSampleRate: number
      deviceBitDepth: number
      reason: string
    }
  | {
      /**
       * A lossy source (MP3, AAC, Vorbis, Opus) decoded to PCM at the decoder's
       * own rate: no sample-rate conversion, but never "bit-perfect" — there is
       * no lossless source for the output to be identical to.
       */
      mode: 'NATIVE_RATE'
      deviceSampleRate: number
      deviceBitDepth: number
      reason: string
    }
  | {
      mode: 'RESAMPLED'
      deviceSampleRate: number
      deviceBitDepth: number
      originalSampleRate: number
      originalBitDepth: number
      reason: string
      /**
       * PCM → DSD: the source is modulated to DSD at this rate and sent as DoP;
       * deviceSampleRate is then the DoP carrier (rate / 16).
       */
      dsdOutputRate?: number
    }

/**
 * Build DeviceCapabilities from raw device info returned by listDevices().
 */
export function buildDeviceCapabilities(device: {
  id: string
  name: string
  dopCapability?: 'DoP64' | 'DoP128' | 'DoP256' | 'FallbackPCM'
  hardwareVolume?: boolean
  supportedFormats: Array<{ sampleRate: number; bitDepth: number; isFloat: boolean; channels: number }>
}): DeviceCapabilities {
  const fmts = device.supportedFormats
  return {
    id: device.id,
    name: device.name,
    dopCapability: device.dopCapability ?? 'FallbackPCM',
    hardwareVolume: device.hardwareVolume ?? false,
    supportedFormats: fmts,
    maxSampleRate: fmts.reduce((max, f) => Math.max(max, f.sampleRate), 0),
    maxBitDepth: fmts.reduce((max, f) => Math.max(max, f.bitDepth), 0),
    supportsInteger: fmts.some(f => !f.isFloat),
  }
}

const LOSSY_CODECS: ReadonlySet<string> = new Set(['MP3', 'AAC', 'VORBIS', 'OPUS'])

/** Whether a track codec is a perceptual (lossy) format whose decode can never be bit-perfect. */
export function isLossyCodec(codec: string): boolean {
  return LOSSY_CODECS.has(codec.toUpperCase())
}

/**
 * Same-rate output for a lossy decode. The decoder emits float PCM, so the
 * widest integer format (else float) keeps its precision; no SRC is involved.
 */
function resolveLossyNativeRate(track: TrackFormat, fmts: DeviceCapabilities['supportedFormats']): PlaybackDecision | null {
  const sameRate = fmts.filter((f) => f.sampleRate === track.sampleRate)
  const best = [...sameRate].sort((a, b) => Number(a.isFloat) - Number(b.isFloat) || b.bitDepth - a.bitDepth)[0]
  if (!best) return null
  return {
    mode: 'NATIVE_RATE',
    deviceSampleRate: best.sampleRate,
    deviceBitDepth: best.bitDepth,
    reason: `Lossy ${track.codec} decoded at its native ${track.sampleRate / 1000}kHz and sent at ${best.bitDepth}bit${best.isFloat ? ' float' : ''} — no sample-rate conversion; bit-perfect does not apply to lossy sources`,
  }
}

/** A decision that converts the sample rate, which a strict (no-resampling) output must refuse. */
export function requiresSampleRateConversion(decision: PlaybackDecision | null | undefined): boolean {
  return decision?.mode === 'RESAMPLED' && decision.originalSampleRate > 0 && decision.originalSampleRate !== decision.deviceSampleRate
}

const is441Family = (sr: number) => sr % 44100 === 0
const is48Family = (sr: number) => sr % 48000 === 0

/**
 * How the output format is chosen beyond "play the source as-is when possible"
 * (Audio Setup → Resampling). The default reproduces the classic behaviour.
 */
export interface OutputFormatPolicy {
  /** Rate to use when the source rate is not available on the device. */
  targetRate: 'family-max' | 'lowest-above' | 'fixed'
  /** Used when targetRate is 'fixed': every source is played at this rate. */
  fixedSampleRate: number
  /** Resample supported sources too: to 2/4/8× the source rate, or to the highest rate. */
  upsampling: 'off' | '2x' | '4x' | '8x' | 'family-max' | 'device-max'
  /** Upper bound for every upsampling mode; 0 = the device maximum. */
  maxOutputRate: number
  outputBitDepth: 'auto' | 16 | 24 | 32
}

export const DEFAULT_OUTPUT_POLICY: OutputFormatPolicy = {
  targetRate: 'family-max',
  fixedSampleRate: 48000,
  upsampling: 'off',
  maxOutputRate: 0,
  outputBitDepth: 'auto',
}

type SupportedFormat = DeviceCapabilities['supportedFormats'][number]

function sameFamily(a: number, b: number): boolean {
  return is441Family(a) ? is441Family(b) : is48Family(a) && is48Family(b)
}

/** A rate the policy insists on, or null to let the classic rules decide. */
function policyRate(track: TrackFormat, fmts: SupportedFormat[], policy: OutputFormatPolicy): { rate: number; why: string } | null {
  const rates = [...new Set(fmts.map((f) => f.sampleRate))].sort((a, b) => a - b)
  if (rates.length === 0) return null
  const highest = rates[rates.length - 1]

  if (policy.targetRate === 'fixed' && rates.includes(policy.fixedSampleRate)) {
    return { rate: policy.fixedSampleRate, why: `Fixed output rate ${policy.fixedSampleRate / 1000}kHz` }
  }
  if (policy.upsampling !== 'off' && track.sampleRate > 0) {
    // Upsampling never goes above the cap, and never below the source.
    const cap = policy.maxOutputRate > 0 ? policy.maxOutputRate : Number.POSITIVE_INFINITY
    const capped = rates.filter((rate) => rate <= cap && rate >= track.sampleRate)
    const cappedLabel = policy.maxOutputRate > 0 ? ` (limit ${policy.maxOutputRate / 1000}kHz)` : ''
    if (policy.upsampling === 'device-max') {
      const rate = capped[capped.length - 1]
      if (rate) return { rate, why: `Upsampling to the device maximum${cappedLabel}, ${rate / 1000}kHz` }
    } else if (policy.upsampling === 'family-max') {
      const rate = [...capped].reverse().find((candidate) => sameFamily(track.sampleRate, candidate))
      if (rate) return { rate, why: `Upsampling to the highest rate in the ${is441Family(track.sampleRate) ? '44.1k' : '48k'} family${cappedLabel}, ${rate / 1000}kHz` }
    } else {
      // 2x / 4x / 8x: the largest whole multiple of the source up to the factor.
      const factor = Number.parseInt(policy.upsampling, 10)
      const multiples = capped.filter((rate) =>
        rate % track.sampleRate === 0 && rate / track.sampleRate <= factor)
      const rate = multiples[multiples.length - 1]
      if (rate && rate > track.sampleRate) {
        return { rate, why: `Upsampling ${rate / track.sampleRate}× to ${rate / 1000}kHz${cappedLabel}` }
      }
    }
  }
  if (policy.targetRate === 'lowest-above' && track.sampleRate > 0 && !rates.includes(track.sampleRate)) {
    const above = rates.filter((rate) => rate >= track.sampleRate)
    const rate = above.find((candidate) => sameFamily(track.sampleRate, candidate)) ?? above[0] ?? highest
    return { rate, why: `DAC does not support ${track.sampleRate / 1000}kHz. Resampling to the lowest supported rate at or above it, ${rate / 1000}kHz` }
  }
  return null
}

/** Best format at `rate` for the requested (or source) bit depth; integer preferred. */
function formatAtRate(fmts: SupportedFormat[], rate: number, sourceBits: number, forced: OutputFormatPolicy['outputBitDepth']): SupportedFormat | null {
  const atRate = fmts.filter((f) => f.sampleRate === rate)
  const integers = atRate.filter((f) => !f.isFloat).sort((a, b) => a.bitDepth - b.bitDepth)
  const wanted = forced === 'auto' ? sourceBits : forced
  return integers.find((f) => f.bitDepth === wanted)
    ?? (forced === 'auto'
      ? integers.find((f) => f.bitDepth >= wanted)
      : [...integers].reverse().find((f) => f.bitDepth <= wanted) ?? integers[0])
    ?? integers[integers.length - 1]
    ?? atRate[0]
    ?? null
}

/**
 * Resolve the playback format for a track on a device under an output policy.
 *
 * With the default policy this is the classic decision (see resolveSourceFormat).
 * A policy may pin the rate (fixed rate, upsampling, lowest-above) or the bit
 * depth; the result is BIT_PERFECT only when neither rate nor resolution changes.
 */
export function resolvePlaybackFormat(
  track: TrackFormat,
  device: DeviceCapabilities,
  policy: OutputFormatPolicy = DEFAULT_OUTPUT_POLICY,
): PlaybackDecision {
  const fmts = device.supportedFormats
  const pinned = fmts.length > 0 ? policyRate(track, fmts, policy) : null
  if (!pinned && policy.outputBitDepth === 'auto') return resolveSourceFormat(track, device)

  const classic = resolveSourceFormat(track, device)
  const rate = pinned?.rate ?? classic.deviceSampleRate
  // Resampled samples no longer fit the source's word length: "auto" then means
  // the deepest integer format, so the conversion is not requantized to 16 bit.
  const sourceBits = rate !== track.sampleRate ? 32 : track.bitDepth
  const format = formatAtRate(fmts, rate, sourceBits, policy.outputBitDepth)
  if (!format) return classic

  const bitNote = policy.outputBitDepth !== 'auto' ? ` Output bit depth fixed at ${policy.outputBitDepth}bit.` : ''
  if (rate === track.sampleRate) {
    if (isLossyCodec(track.codec)) {
      return {
        mode: 'NATIVE_RATE',
        deviceSampleRate: rate,
        deviceBitDepth: format.bitDepth,
        reason: `Lossy ${track.codec} decoded at its native ${rate / 1000}kHz and sent at ${format.bitDepth}bit — no sample-rate conversion.${bitNote}`,
      }
    }
    if (format.bitDepth >= track.bitDepth) {
      return {
        mode: 'BIT_PERFECT',
        deviceSampleRate: rate,
        deviceBitDepth: format.bitDepth,
        reason: `DAC supports ${rate / 1000}kHz at ${format.bitDepth}bit${format.isFloat ? ' float' : ' integer'}${format.bitDepth > track.bitDepth ? ` (padded from ${track.bitDepth}bit)` : ''}.${bitNote}`,
      }
    }
    return {
      mode: 'RESAMPLED',
      deviceSampleRate: rate,
      deviceBitDepth: format.bitDepth,
      originalSampleRate: track.sampleRate,
      originalBitDepth: track.bitDepth,
      reason: `Requantized from ${track.bitDepth}bit to ${format.bitDepth}bit at ${rate / 1000}kHz — no sample-rate conversion.${bitNote}`,
    }
  }

  return {
    mode: 'RESAMPLED',
    deviceSampleRate: rate,
    deviceBitDepth: format.bitDepth,
    originalSampleRate: track.sampleRate,
    originalBitDepth: track.bitDepth,
    reason: `${pinned?.why ?? classic.reason}: ${rate / 1000}kHz / ${format.bitDepth}bit.${bitNote}`,
  }
}

/**
 * Classic decision: play the source as-is when possible.
 *
 * Priority:
 *   1. Exact match (rate + depth, integer) → BIT_PERFECT
 *   2. Same rate, higher bit depth (integer) → BIT_PERFECT (zero-padded)
 *   3. Same sample rate family, best available → RESAMPLED
 *   4. Any format the DAC supports → RESAMPLED (last resort)
 */
function resolveSourceFormat(
  track: TrackFormat,
  device: DeviceCapabilities
): PlaybackDecision {
  const fmts = device.supportedFormats
  if (fmts.length === 0) {
    return {
      mode: 'RESAMPLED',
      deviceSampleRate: 44100,
      deviceBitDepth: 16,
      originalSampleRate: track.sampleRate,
      originalBitDepth: track.bitDepth,
      reason: 'No supported formats reported by device — using safe defaults',
    }
  }

  if (isLossyCodec(track.codec) && track.sampleRate > 0) {
    const native = resolveLossyNativeRate(track, fmts)
    if (native) return native
  }

  // Step 1: exact match (prefer integer over float)
  const exactMatch = fmts.find(
    f =>
      f.sampleRate === track.sampleRate &&
      f.bitDepth === track.bitDepth &&
      !f.isFloat
  )
  if (exactMatch) {
    return {
      mode: 'BIT_PERFECT',
      deviceSampleRate: exactMatch.sampleRate,
      deviceBitDepth: exactMatch.bitDepth,
      reason: `DAC natively supports ${track.sampleRate / 1000}kHz / ${track.bitDepth}bit integer`,
    }
  }

  // Also accept exact match in float if no integer available
  const exactFloat = fmts.find(
    f => f.sampleRate === track.sampleRate && f.bitDepth === track.bitDepth && f.isFloat
  )

  // Step 2: same sample rate, higher bit depth (integer preferred)
  const sameRateInteger = fmts
    .filter(f => f.sampleRate === track.sampleRate && !f.isFloat && f.bitDepth >= track.bitDepth)
    .sort((a, b) => a.bitDepth - b.bitDepth)
  if (sameRateInteger.length > 0) {
    const best = sameRateInteger[0]
    return {
      mode: 'BIT_PERFECT',
      deviceSampleRate: best.sampleRate,
      deviceBitDepth: best.bitDepth,
      reason: `DAC supports ${track.sampleRate / 1000}kHz at ${best.bitDepth}bit integer (padded from ${track.bitDepth}bit — no sample rate conversion)`,
    }
  }

  // Accept float at same rate as bit-perfect (still no SRC)
  if (exactFloat) {
    return {
      mode: 'BIT_PERFECT',
      deviceSampleRate: exactFloat.sampleRate,
      deviceBitDepth: exactFloat.bitDepth,
      reason: `DAC supports ${track.sampleRate / 1000}kHz / ${exactFloat.bitDepth}bit float (integer not available at this rate)`,
    }
  }

  // Step 3: same sample rate family, best available
  const trackFamily = is441Family(track.sampleRate) ? '44.1k' : '48k'
  const familyFormats = fmts
    .filter(f => {
      const inFamily = trackFamily === '44.1k' ? is441Family(f.sampleRate) : is48Family(f.sampleRate)
      return inFamily && !f.isFloat
    })
    .sort((a, b) => b.sampleRate - a.sampleRate || b.bitDepth - a.bitDepth)

  if (familyFormats.length > 0) {
    const best = familyFormats[0]
    return {
      mode: 'RESAMPLED',
      deviceSampleRate: best.sampleRate,
      deviceBitDepth: best.bitDepth,
      originalSampleRate: track.sampleRate,
      originalBitDepth: track.bitDepth,
      reason: `DAC does not support ${track.sampleRate / 1000}kHz. Resampling to best in ${trackFamily} family: ${best.sampleRate / 1000}kHz / ${best.bitDepth}bit`,
    }
  }

  // Step 4: any integer format (cross-family)
  const anyInteger = fmts
    .filter(f => !f.isFloat)
    .sort((a, b) => b.sampleRate - a.sampleRate || b.bitDepth - a.bitDepth)

  if (anyInteger.length > 0) {
    const best = anyInteger[0]
    return {
      mode: 'RESAMPLED',
      deviceSampleRate: best.sampleRate,
      deviceBitDepth: best.bitDepth,
      originalSampleRate: track.sampleRate,
      originalBitDepth: track.bitDepth,
      reason: `DAC does not support ${track.sampleRate / 1000}kHz / ${track.bitDepth}bit. Falling back to ${best.sampleRate / 1000}kHz / ${best.bitDepth}bit integer`,
    }
  }

  // Step 5: last resort — any format including float
  const anyFormat = fmts.sort((a, b) => b.sampleRate - a.sampleRate || b.bitDepth - a.bitDepth)[0]
  return {
    mode: 'RESAMPLED',
    deviceSampleRate: anyFormat.sampleRate,
    deviceBitDepth: anyFormat.bitDepth,
    originalSampleRate: track.sampleRate,
    originalBitDepth: track.bitDepth,
    reason: `DAC does not support ${track.sampleRate / 1000}kHz / ${track.bitDepth}bit. Using ${anyFormat.sampleRate / 1000}kHz / ${anyFormat.bitDepth}bit float`,
  }
}

/**
 * Format a PlaybackDecision for console logging.
 */
export function formatDecisionLog(
  fileName: string,
  track: TrackFormat,
  deviceName: string,
  decision: PlaybackDecision
): string {
  return [
    `[Puros] Playback: ${fileName}`,
    `  Track:    ${track.sampleRate}Hz / ${track.bitDepth}bit / ${track.codec}`,
    `  Device:   ${deviceName}`,
    `  Decision: ${decision.mode}`,
    `  Output:   ${decision.deviceSampleRate}Hz / ${decision.deviceBitDepth}bit`,
    `  Reason:   ${decision.reason}`,
  ].join('\n')
}
