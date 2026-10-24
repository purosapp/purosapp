/**
 * Puros Restore — adaptive restoration for lossy sources (native DSP stage).
 *
 * Settings shared by the renderer (DSP panel, playback) and the main process
 * (IPC validation). The engine decides activation from the decoder's actual
 * codec; `restoreSourceHint` only fills in what a PCM container cannot say.
 */

import type { FormatInfo } from './local/formats'

export type RestoreMode = 'off' | 'manual' | 'auto'
export type RestoreProfile = 'adaptive' | 'natural' | 'detailed'
/** source: on the decoded signal, before resampling and EQ; afterDsp: after EQ, crossfeed and VST plug-ins. */
export type RestorePosition = 'source' | 'afterDsp'
export type RestoreSourceHint = 'lossy' | 'lossless' | 'dsd' | 'unknown'

export interface RestoreSettings {
  mode: RestoreMode
  profile: RestoreProfile
  /** 0–100 % */
  strength: number
  artifactReduction: boolean
  hfReconstruction: boolean
  transientRestoration: boolean
  position: RestorePosition
}

/** What the native engine receives. */
export interface NativeRestoreConfig extends Omit<RestoreSettings, 'strength'> {
  /** 0–1 */
  strength: number
}

export interface RestoreStatus {
  mode: RestoreMode
  /** off: disabled; idle: nothing playing; active: restoring; bypassed: source left untouched. */
  state: 'off' | 'idle' | 'active' | 'bypassed'
  reason: string
  sourceClass: RestoreSourceHint
  codec: string | null
  position: RestorePosition
  cutoffHz: number
  confidence: number
  severity: number
  mix: number
  latencyMs: number
  sampleRate: number
}

export const DEFAULT_RESTORE_SETTINGS: RestoreSettings = {
  mode: 'off',
  profile: 'adaptive',
  strength: 30,
  artifactReduction: true,
  hfReconstruction: true,
  transientRestoration: true,
  position: 'source',
}

const MODES: readonly RestoreMode[] = ['off', 'manual', 'auto']
const PROFILES: readonly RestoreProfile[] = ['adaptive', 'natural', 'detailed']
const POSITIONS: readonly RestorePosition[] = ['source', 'afterDsp']

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Anything missing or invalid falls back to the defaults, so a broken setting can only mean "off". */
export function sanitizeRestoreSettings(raw: unknown): RestoreSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const strength = typeof input.strength === 'number' && Number.isFinite(input.strength)
    ? Math.round(Math.min(100, Math.max(0, input.strength)))
    : DEFAULT_RESTORE_SETTINGS.strength
  return {
    mode: pick(input.mode, MODES, DEFAULT_RESTORE_SETTINGS.mode),
    profile: pick(input.profile, PROFILES, DEFAULT_RESTORE_SETTINGS.profile),
    strength,
    artifactReduction: flag(input.artifactReduction, DEFAULT_RESTORE_SETTINGS.artifactReduction),
    hfReconstruction: flag(input.hfReconstruction, DEFAULT_RESTORE_SETTINGS.hfReconstruction),
    transientRestoration: flag(input.transientRestoration, DEFAULT_RESTORE_SETTINGS.transientRestoration),
    position: pick(input.position, POSITIONS, DEFAULT_RESTORE_SETTINGS.position),
  }
}

export function toNativeRestoreConfig(settings: RestoreSettings): NativeRestoreConfig {
  return { ...settings, strength: settings.strength / 100 }
}

/** Strict check for configs crossing IPC (already in native form). */
export function isValidNativeRestoreConfig(config: unknown): config is NativeRestoreConfig {
  if (!config || typeof config !== 'object') return false
  const c = config as Record<string, unknown>
  return MODES.includes(c.mode as RestoreMode) &&
    PROFILES.includes(c.profile as RestoreProfile) &&
    POSITIONS.includes(c.position as RestorePosition) &&
    typeof c.strength === 'number' && Number.isFinite(c.strength) && c.strength >= 0 && c.strength <= 1 &&
    typeof c.artifactReduction === 'boolean' &&
    typeof c.hfReconstruction === 'boolean' &&
    typeof c.transientRestoration === 'boolean'
}

export function isRestoreSourceHint(value: unknown): value is RestoreSourceHint {
  return value === 'lossy' || value === 'lossless' || value === 'dsd' || value === 'unknown'
}

const LOSSY_FORMATS = new Set(['MP3', 'AAC', 'VORBIS', 'OPUS'])
const LOSSLESS_FORMATS = new Set(['FLAC', 'FLAC_HIRES', 'ALAC', 'AIFF', 'WAV', 'MQA'])

/**
 * Codec metadata for the engine. It only matters when the decoder sees a PCM
 * container (a DSD → PCM conversion, a lossy stream decoded upstream); for real
 * codec bitstreams the engine trusts the decoder over this hint.
 */
export function restoreSourceHint(formatInfo: Pick<FormatInfo, 'format' | 'isDsd' | 'isLossless'> | null | undefined): RestoreSourceHint {
  if (!formatInfo) return 'unknown'
  if (formatInfo.isDsd || formatInfo.format === 'DSD') return 'dsd'
  if (LOSSY_FORMATS.has(formatInfo.format)) return 'lossy'
  if (formatInfo.isLossless && LOSSLESS_FORMATS.has(formatInfo.format)) return 'lossless'
  return 'unknown'
}

/**
 * Codec names ffmpeg reports for an input stream ("Audio: aac (LC)" → "aac").
 * Lossy only when ffmpeg identified a perceptual codec; anything else stays unknown.
 */
export function restoreSourceForFfmpegCodec(codec: string | null | undefined): RestoreSourceHint {
  if (!codec) return 'unknown'
  const name = codec.toLowerCase()
  if (/^(mp3|mp3float|mp2|mp2float|mp1|aac|aac_latm|aac_fixed|opus|libopus|vorbis|libvorbis|ac3|eac3|wmav1|wmav2|amr_nb|amr_wb|speex|gsm|nellymoser|ra_144|ra_288|cook|atrac3|atrac3p|mpc7|mpc8)$/.test(name)) {
    return 'lossy'
  }
  if (/^(flac|alac|ape|wavpack|tta|truehd|mlp|pcm_[a-z0-9]+)$/.test(name)) return 'lossless'
  if (/^dsd_/.test(name)) return 'dsd'
  return 'unknown'
}

/** "Audio: aac (LC), 44100 Hz, stereo" in ffmpeg's input banner → "aac". */
export function parseFfmpegAudioCodec(line: string): string | null {
  const match = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio: ([A-Za-z0-9_]+)/)
  return match?.[1] ?? null
}
