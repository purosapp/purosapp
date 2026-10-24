import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AudioFormat } from '../../../src/services/local/formats'
import { getFfmpegPath } from './ffmpegPath'

const execFileAsync = promisify(execFile)

type LocalPreparedFormatInfo = {
  format: 'WAV'
  sampleRate: number
  bitDepth: number
  bitrate: number
  channels: number
  isLossless: boolean
  isHiRes: boolean
  isMqa: false
  isDsd: false
}

type ParsedPlaybackTrack = {
  format: string
  sampleRate: number | null
  bitDepth: number | null
  bitrate: number | null
  channels: number
  lossless: boolean
}

let parsePlaybackTrackFile: (
  filePath: string,
  mm: typeof import('music-metadata'),
) => Promise<ParsedPlaybackTrack>

export function configureLocalPlayback(deps: {
  parseTrackFile: typeof parsePlaybackTrackFile
}) {
  parsePlaybackTrackFile = deps.parseTrackFile
}

export { getFfmpegPath }

function isLikelyDsdFile(filePath: string, sourceFormat?: { isDsd?: boolean } | null): boolean {
  if (sourceFormat?.isDsd) return true
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.dsf' || ext === '.dff'
}

/** Where earlier versions cached DSD files converted to WAV by ffmpeg. */
export function removeLegacyDsdCache(): Promise<void> {
  return fs.promises.rm(path.join(app.getPath('userData'), 'cache', 'dsd-pcm'), { recursive: true, force: true })
}

/** DSD → PCM in the audio engine (its DsdDecimator), applied while the file plays. */
export interface DsdConversionOptions {
  /** PCM rate the DSD stream is decimated to (dsdRate / 2^k); the engine resamples from there. */
  sampleRate: number
  /** Ultrasonic low-pass cutoff (Hz); 0 = off. */
  filterHz: number
  gainDb: number
}

const DEFAULT_DSD_CONVERSION: DsdConversionOptions = { sampleRate: 176_400, filterHz: 0, gainDb: 0 }
const DSD_PCM_RATES = new Set([44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 352_800, 384_000])
/** DSD rate assumed when the source's is unknown: its 44.1 kHz multiples cover every request. */
const FALLBACK_DSD_RATE = 22_579_200

/** Validate renderer-supplied options; anything unusable falls back to the defaults. */
export function sanitizeDsdConversionOptions(raw: unknown): DsdConversionOptions {
  const input = raw && typeof raw === 'object' ? raw as Partial<Record<keyof DsdConversionOptions, unknown>> : {}
  const sampleRate = typeof input.sampleRate === 'number' && DSD_PCM_RATES.has(input.sampleRate)
    ? input.sampleRate
    : DEFAULT_DSD_CONVERSION.sampleRate
  const filterHz = typeof input.filterHz === 'number' && input.filterHz >= 20_000 && input.filterHz < sampleRate / 2
    ? Math.round(input.filterHz)
    : 0
  const gainDb = input.gainDb === 3 || input.gainDb === 6 ? input.gainDb : 0
  return { sampleRate, filterHz, gainDb }
}

/**
 * PCM rate a DSD stream decodes to for a requested rate: dsdRate / 2^k (k ≥ 3), the
 * lowest at or above the request, at most dsdRate / 8. Mirrors DsdDecimator::decodeRate.
 */
export function dsdDecodeRate(dsdRate: number, requested: number): number {
  if (!Number.isInteger(dsdRate) || dsdRate <= 0 || dsdRate % 8 !== 0) return 0
  let rate = dsdRate / 8
  while (rate % 2 === 0 && rate / 2 >= requested) rate /= 2
  return rate
}

const DSD_PCM_TARGET = /#dsd-pcm=(\d+),(\d+),(\d+)$/

/**
 * The playback target for a DSD file heard as PCM: the file plus its conversion
 * settings. It is never written; playFile() hands both to the engine.
 */
export function toDsdPcmTarget(filePath: string, options: DsdConversionOptions): string {
  return `${filePath}#dsd-pcm=${options.sampleRate},${options.filterHz},${options.gainDb}`
}

export function resolveDsdPcmTarget(target: string): { sourcePath: string; options: DsdConversionOptions } | null {
  const match = DSD_PCM_TARGET.exec(target)
  if (!match) return null
  const sampleRate = Number(match[1])
  return {
    sourcePath: target.slice(0, match.index),
    options: {
      sampleRate,
      // Already validated when the target was made; only bounds-checked here.
      filterHz: Math.min(Number(match[2]), sampleRate / 2),
      gainDb: Math.min(Number(match[3]), 6),
    },
  }
}

export async function prepareLocalPlaybackFile(
  filePath: string,
  sourceFormat?: {
    sampleRate?: number
    dsdRate?: number
    channels?: number
    isDsd?: boolean
  } | null,
  dsdOptions: DsdConversionOptions = DEFAULT_DSD_CONVERSION,
): Promise<{ playbackPath: string; outputFormat: LocalPreparedFormatInfo | null }> {
  if (!isLikelyDsdFile(filePath, sourceFormat)) {
    return { playbackPath: filePath, outputFormat: null }
  }

  // The engine decodes stereo; what it reads is 32-bit float PCM at the decimator's rate.
  const sourceDsdRate = sourceFormat?.dsdRate ?? sourceFormat?.sampleRate ?? 0
  const targetSampleRate = dsdDecodeRate(sourceDsdRate, dsdOptions.sampleRate) ||
    dsdDecodeRate(FALLBACK_DSD_RATE, dsdOptions.sampleRate)
  const targetChannels = 2
  const targetBitDepth = 32
  const outputFormat: LocalPreparedFormatInfo = {
    format: 'WAV',
    sampleRate: targetSampleRate,
    bitDepth: targetBitDepth,
    bitrate: Math.round((targetSampleRate * targetBitDepth * targetChannels) / 1000),
    channels: targetChannels,
    isLossless: true,
    isHiRes: true,
    isMqa: false,
    isDsd: false,
  }
  const options = sanitizeDsdConversionOptions({ ...dsdOptions, sampleRate: targetSampleRate })
  return { playbackPath: toDsdPcmTarget(filePath, options), outputFormat }
}

export async function inspectPlaybackFileFormat(filePath: string) {
  try {
    const mm = await import('music-metadata')
    const parsed = await parsePlaybackTrackFile(filePath, mm)
    return {
      format: parsed.format as AudioFormat,
      sampleRate: parsed.sampleRate ?? 0,
      bitDepth: parsed.bitDepth ?? 0,
      bitrate: parsed.bitrate ?? 0,
      channels: parsed.channels ?? 2,
      isLossless: parsed.lossless,
      // A lossy decode is never Hi-Res, whatever rate the decoder runs at.
      isHiRes: parsed.lossless && ((parsed.bitDepth ?? 0) > 16 || (parsed.sampleRate ?? 0) > 48000),
      isMqa: parsed.format === 'MQA',
      isDsd: parsed.format === 'DSD',
      // Omit rather than set `undefined`: provider payloads must be plain values.
      ...(parsed.format === 'DSD' && parsed.sampleRate ? { dsdRate: parsed.sampleRate } : {}),
    }
  } catch {
    return null
  }
}

export async function validateProgressiveFlacFile(
  filePath: string,
  options: { requireDuration: boolean },
) {
  const mm = await import('music-metadata')
  const metadata = await mm.parseFile(filePath, { duration: true, skipCovers: true })
  let duration = metadata.format.duration ?? 0
  if (duration <= 0 && options.requireDuration) {
    const { stderr } = await execFileAsync(getFfmpegPath(), [
      '-hide_banner',
      '-nostdin',
      '-threads', '1',
      '-i', filePath,
      '-map', '0:a:0',
      '-f', 'null',
      '-',
    ])
    const timestamps = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
    const lastTimestamp = timestamps[timestamps.length - 1]
    if (lastTimestamp) {
      duration = Number(lastTimestamp[1]) * 3600
        + Number(lastTimestamp[2]) * 60
        + Number(lastTimestamp[3])
    }
  }
  return {
    codec: metadata.format.codec ?? '',
    sampleRate: metadata.format.sampleRate ?? 0,
    channels: metadata.format.numberOfChannels ?? 0,
    duration,
  }
}

interface FlacStreamInfo {
  sampleRate: number
  bitsPerSample: number
  channels: number
}

export function readFlacStreamInfo(filePath: string): FlacStreamInfo | null {
  // Search the first 512 KB then the 512 KB surrounding the moov atom.
  // FLAC-in-ISOBMFF DASH files can place the dfLa box inside
  // moov which may be in the middle or end of the file.
  // We look for the ISO 14496-14 "dfLa" box which contains:
  //   version(1) + flags(3) + FLAC_block_header(4) + STREAMINFO(34)
  // We also handle bare "fLaC" markers (native FLAC files).
  try {
    const fileSize = fs.statSync(filePath).size
    const chunkSize = 524288 // 512 KB

    const parseChunk = (data: Buffer): FlacStreamInfo | null => {
      // Priority: look for "dfLa" (FLAC-in-MP4 codec box)
      const dfLaMarker = Buffer.from('dfLa')
      let pos = 0
      while (pos <= data.length - 50) {
        const idx = data.indexOf(dfLaMarker, pos)
        if (idx === -1) break
        // dfLa payload: version(1)+flags(3) then FLAC block header+data
        const hdrOff = idx + 4 + 4 // skip 'dfLa' + version/flags
        const blockType = data[hdrOff] & 0x7F
        const blockLen = (data[hdrOff + 1] << 16) | (data[hdrOff + 2] << 8) | data[hdrOff + 3]
        if (blockType === 0 && blockLen === 34 && hdrOff + 4 + 34 <= data.length) {
          const si = hdrOff + 4
          const sampleRate = (data[si + 10] << 12) | (data[si + 11] << 4) | (data[si + 12] >> 4)
          const channels = ((data[si + 12] >> 1) & 0x07) + 1
          const bitsPerSample = (((data[si + 12] & 0x01) << 4) | (data[si + 13] >> 4)) + 1
          if (sampleRate > 0 && sampleRate <= 768000) {
            return { sampleRate, bitsPerSample, channels }
          }
        }
        pos = idx + 1
      }

      // Fallback: bare "fLaC" marker (native FLAC, no version/flags offset)
      const fLaCMarker = Buffer.from('fLaC')
      pos = 0
      while (pos <= data.length - 46) {
        const idx = data.indexOf(fLaCMarker, pos)
        if (idx === -1) break
        const blockType = data[idx + 4] & 0x7F
        const blockLen = (data[idx + 5] << 16) | (data[idx + 6] << 8) | data[idx + 7]
        if (blockType === 0 && blockLen === 34 && idx + 8 + 34 <= data.length) {
          const si = idx + 8
          const sampleRate = (data[si + 10] << 12) | (data[si + 11] << 4) | (data[si + 12] >> 4)
          const channels = ((data[si + 12] >> 1) & 0x07) + 1
          const bitsPerSample = (((data[si + 12] & 0x01) << 4) | (data[si + 13] >> 4)) + 1
          if (sampleRate > 0 && sampleRate <= 768000) {
            return { sampleRate, bitsPerSample, channels }
          }
        }
        pos = idx + 1
      }
      return null
    }

    const fd = fs.openSync(filePath, 'r')
    try {
      // Read first 512 KB
      const buf1 = Buffer.alloc(Math.min(chunkSize, fileSize))
      fs.readSync(fd, buf1, 0, buf1.length, 0)
      const r1 = parseChunk(buf1)
      if (r1) return r1

      // If file is larger, also read a chunk from the middle (typical moov location
      // in DASH streams) and from the end
      if (fileSize > chunkSize) {
        const buf2 = Buffer.alloc(Math.min(chunkSize, fileSize - chunkSize))
        const midOffset = Math.max(0, Math.floor(fileSize / 2) - chunkSize / 2)
        fs.readSync(fd, buf2, 0, buf2.length, midOffset)
        const r2 = parseChunk(buf2)
        if (r2) return r2
      }
    } finally {
      fs.closeSync(fd)
    }
    return null
  } catch {
    return null
  }
}
