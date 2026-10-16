/**
 * Audio format detection and classification.
 *
 * Detects: FLAC, FLAC_HIRES, MQA, DSD, ALAC, AIFF, WAV, MP3, AAC, VORBIS, OPUS
 * Extracts: sample rate, bit depth, bitrate, channels, MQA tags, DSD type
 */

export type AudioFormat =
  | 'FLAC'
  | 'FLAC_HIRES'
  | 'MQA'
  | 'DSD'
  | 'ALAC'
  | 'AIFF'
  | 'WAV'
  | 'MP3'
  | 'AAC'
  | 'VORBIS'
  | 'OPUS'

export type OutputMode = 'EXCLUSIVE' | 'SHARED' | 'AIRPLAY'

export interface FormatInfo {
  format: AudioFormat
  sampleRate: number      // Hz (e.g. 44100, 96000, 192000)
  bitDepth: number        // bits (e.g. 16, 24, 32)
  bitrate: number         // kbps
  channels: number
  isLossless: boolean
  isHiRes: boolean        // 24-bit+ or >48kHz
  isMqa: boolean
  isDsd: boolean
  dsdRate?: number        // DSD64 = 2822400, DSD128 = 5644800, etc.
}

export const HIGH_QUALITY_LOSSY_BITRATE_KBPS = 160

const LOSSY_FORMATS: ReadonlySet<AudioFormat> = new Set<AudioFormat>(['MP3', 'AAC', 'VORBIS', 'OPUS'])

/** Perceptual codecs: always lossy, never Hi-Res or bit-perfect to the source, whatever the decoder emits. */
export function isLossyFormat(format: AudioFormat): boolean {
  return LOSSY_FORMATS.has(format)
}

export function isHighQualityLossyFormat(
  formatInfo: Pick<FormatInfo, 'format' | 'bitrate'> | null | undefined,
): boolean {
  if (!formatInfo) return false
  if (!isLossyFormat(formatInfo.format)) return false
  return formatInfo.bitrate > HIGH_QUALITY_LOSSY_BITRATE_KBPS
}

/** File extensions we support */
export const SUPPORTED_EXTENSIONS = new Set([
  '.flac', '.alac', '.m4a', '.aiff', '.aif', '.wav',
  '.mp3', '.aac', '.dsf', '.dff',
])

export function isSupportedFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return SUPPORTED_EXTENSIONS.has(ext)
}

/**
 * Classify format from raw metadata values.
 * MQA detection is done via Vorbis comment tags (MQAENCODER, ENCODER with "MQA").
 * DSD detection is done via container type (DSF/DFF).
 */
export function classifyFormat(params: {
  codec: string
  container: string
  sampleRate: number
  bitDepth: number
  bitrate: number
  channels: number
  tags?: Record<string, string>
}): FormatInfo {
  const { codec, container, sampleRate, bitDepth, bitrate, channels, tags } = params

  const isDsd = container === 'dsf' || container === 'dff' ||
    codec.toLowerCase().includes('dsd')
  const isMqa = detectMqa(tags)
  const isHiRes = bitDepth > 16 || sampleRate > 48000

  let format: AudioFormat

  if (isDsd) {
    format = 'DSD'
  } else if (isMqa) {
    format = 'MQA'
  } else if (codec === 'flac' || codec === 'FLAC') {
    format = isHiRes ? 'FLAC_HIRES' : 'FLAC'
  } else if (codec === 'alac' || codec === 'ALAC') {
    format = 'ALAC'
  } else if (codec === 'aiff' || codec === 'AIFF' || container === 'aiff') {
    format = 'AIFF'
  } else if (codec === 'pcm' && container === 'wav') {
    format = 'WAV'
  } else if (codec === 'mp3' || codec === 'MPEG 1 Layer 3') {
    format = 'MP3'
  } else if (codec === 'aac' || codec === 'AAC') {
    format = 'AAC'
  } else if (codec.toLowerCase() === 'vorbis') {
    format = 'VORBIS'
  } else if (codec.toLowerCase() === 'opus') {
    format = 'OPUS'
  } else {
    // Fallback: try to identify by container
    format = containerFallback(container, isHiRes)
  }

  const isLossless = ['FLAC', 'FLAC_HIRES', 'ALAC', 'AIFF', 'WAV', 'DSD', 'MQA'].includes(format)
  const lossy = isLossyFormat(format)

  return {
    format,
    // Opus always decodes at 48 kHz; its header's input rate only describes the encoder source.
    sampleRate: format === 'OPUS' ? 48_000 : sampleRate,
    bitDepth: format === 'OPUS' || format === 'AAC' ? 0 : bitDepth,
    bitrate: Math.round(bitrate / 1000), // convert to kbps
    channels,
    isLossless,
    isHiRes: isHiRes && !lossy,
    isMqa,
    isDsd,
    dsdRate: isDsd ? sampleRate : undefined,
  }
}

/**
 * Detect MQA via Vorbis comment inspection.
 * MQA-encoded files contain an MQAENCODER tag or ENCODER containing "MQA".
 */
function detectMqa(tags?: Record<string, string>): boolean {
  if (!tags) return false

  // Check for explicit MQA encoder tag
  if (tags['MQAENCODER'] || tags['mqaencoder']) return true

  // Check ENCODER field for MQA string
  const encoder = tags['ENCODER'] || tags['encoder'] || ''
  if (encoder.toUpperCase().includes('MQA')) return true

  return false
}

function containerFallback(container: string, isHiRes: boolean): AudioFormat {
  switch (container.toLowerCase()) {
    case 'flac': return isHiRes ? 'FLAC_HIRES' : 'FLAC'
    case 'aiff': return 'AIFF'
    case 'wav': case 'wave': return 'WAV'
    case 'mp3': return 'MP3'
    case 'mp4': case 'm4a': return 'AAC'
    case 'ogg': case 'oga': return 'VORBIS'
    case 'opus': return 'OPUS'
    case 'dsf': case 'dff': return 'DSD'
    default: return 'FLAC' // safe default for unknown lossless
  }
}

/** Human-readable format label for badges */
export function formatLabel(format: AudioFormat): string {
  switch (format) {
    case 'FLAC_HIRES': return 'FLAC'
    case 'VORBIS': return 'OGG'
    case 'OPUS': return 'Opus'
    default: return format
  }
}

/** Format sample rate for display (e.g. "44.1kHz", "96kHz") */
export function formatSampleRate(hz: number): string {
  if (hz >= 1000) {
    const khz = hz / 1000
    return khz % 1 === 0 ? `${khz}kHz` : `${khz.toFixed(1)}kHz`
  }
  return `${hz}Hz`
}

/** Format bit depth for display */
export function formatBitDepth(bits: number): string {
  return `${bits}bit`
}

/**
 * Bit depth label for display, or null when there is nothing to show.
 * Lossy streams store no bit depth; the streamed Vorbis (Spotify), Opus/AAC
 * (YouTube Music) and MP3/AAC (SoundCloud) we play are encoded from 16-bit
 * masters, so they are labelled 16-bit. `FormatInfo.bitDepth` stays 0 so output
 * format negotiation never treats a lossy decode as 16-bit PCM.
 */
const DISPLAYED_AS_16_BIT: ReadonlySet<AudioFormat> = new Set<AudioFormat>(['VORBIS', 'OPUS', 'AAC', 'MP3'])

export function formatDisplayBitDepth(info: Pick<FormatInfo, 'format' | 'bitDepth'>): string | null {
  if (info.bitDepth > 0) return formatBitDepth(info.bitDepth)
  if (DISPLAYED_AS_16_BIT.has(info.format)) return formatBitDepth(16)
  return null
}

/** Format bitrate for display */
export function formatBitrate(kbps: number): string {
  return `${kbps}kbps`
}

/** Format DSD rate for display as rounded MHz (e.g. "2.8MHz") */
export function formatDsdRateMHz(rate: number): string {
  const mhz = rate / 1_000_000
  return `${mhz.toFixed(1)}MHz`
}

/** DSD rate name */
export function dsdRateName(rate: number): string {
  if (rate >= 45158400) return 'DSD1024'
  if (rate >= 22579200) return 'DSD512'
  if (rate >= 11289600) return 'DSD256'
  if (rate >= 5644800) return 'DSD128'
  return 'DSD64'
}
