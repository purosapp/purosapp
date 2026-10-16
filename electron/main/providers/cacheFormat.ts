import fs from 'node:fs'
import type { FormatInfoV1 } from '../../../src/provider-api/v1'
import { isPathInsideRoot } from '../security/pathPolicy'

/** Keep provider file inspection behind the same canonical cache-root policy as cache registration. */
export async function inspectProviderCacheFormat(
  filePath: string,
  cacheRoot: string,
  inspect: (canonicalPath: string) => Promise<FormatInfoV1 | null>,
): Promise<FormatInfoV1 | null> {
  const realPath = fs.realpathSync.native(filePath)
  if (!isPathInsideRoot(realPath, cacheRoot) || !fs.statSync(realPath).isFile()) {
    throw new Error('Provider audio path is outside its cache root')
  }
  return inspect(realPath)
}

/** Formats the engine opens through ExtAudioFile on every supported macOS. */
const ALWAYS_PLAYABLE_FORMATS: ReadonlySet<string> = new Set(['FLAC', 'FLAC_HIRES', 'MQA', 'ALAC', 'AIFF', 'WAV', 'MP3', 'AAC'])

/** System decoders that only some macOS versions provide, probed once per run. */
export interface CoreDecoderProbes {
  oggVorbis: () => Promise<boolean>
  /** Ogg Opus with correct pre-skip/end trimming; WebM/MP4 Opus is never opened directly. */
  oggOpus: () => Promise<boolean>
}

/**
 * Whether core plays a provider file of `format` without conversion. DSD
 * artifacts are excluded: only local DSD files get the DoP/PCM preparation path.
 */
export async function canCorePlayFormat(format: unknown, probes: CoreDecoderProbes): Promise<boolean> {
  if (typeof format !== 'string') throw new TypeError('Invalid provider audio format')
  if (ALWAYS_PLAYABLE_FORMATS.has(format)) return true
  if (format === 'VORBIS') return probes.oggVorbis()
  if (format === 'OPUS') return probes.oggOpus()
  return false
}
