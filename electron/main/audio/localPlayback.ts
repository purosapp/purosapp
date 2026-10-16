import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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

const localDsdPreparationTasks = new Map<string, Promise<{
  playbackPath: string
  outputFormat: LocalPreparedFormatInfo
}>>()

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

export function getLocalDsdCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'cache', 'dsd-pcm')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export interface DsdConversionOptions {
  sampleRate: number
  /** Ultrasonic low-pass cutoff (Hz); 0 = off. */
  filterHz: number
  gainDb: number
  /** SoX resampler precision in bits. */
  precision: number
}

const DEFAULT_DSD_CONVERSION: DsdConversionOptions = { sampleRate: 176_400, filterHz: 0, gainDb: 0, precision: 28 }
const DSD_PCM_RATES = new Set([44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 352_800, 384_000])

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
  const precision = typeof input.precision === 'number' && input.precision >= 16 && input.precision <= 32
    ? Math.round(input.precision)
    : DEFAULT_DSD_CONVERSION.precision
  return { sampleRate, filterHz, gainDb, precision }
}

/** ffmpeg audio filter chain: SoX resampling, optional ultrasonic filter, level compensation. */
export function buildDsdFilterChain(options: DsdConversionOptions, useSoxr = true): string {
  const filters = [
    useSoxr
      ? `aresample=osr=${options.sampleRate}:resampler=soxr:precision=${options.precision}`
      : `aresample=osr=${options.sampleRate}`,
  ]
  // asupercut is a high-order Butterworth low-pass for the DSD noise shelf.
  if (useSoxr && options.filterHz > 0) filters.push(`asupercut=cutoff=${options.filterHz}:order=10`)
  if (options.gainDb > 0) filters.push(`volume=${options.gainDb}dB`)
  return filters.join(',')
}

export async function prepareLocalPlaybackFile(
  filePath: string,
  sourceFormat?: {
    sampleRate?: number
    channels?: number
    isDsd?: boolean
  } | null,
  dsdOptions: DsdConversionOptions = DEFAULT_DSD_CONVERSION,
): Promise<{ playbackPath: string; outputFormat: LocalPreparedFormatInfo | null }> {
  if (!isLikelyDsdFile(filePath, sourceFormat)) {
    return { playbackPath: filePath, outputFormat: null }
  }

  const stat = fs.statSync(filePath)
  const cacheKey = createHash('sha256')
    .update(filePath)
    .update('\x00')
    .update(String(Math.floor(stat.mtimeMs)))
    .update('\x00')
    .update(String(stat.size))
    .update('\x00')
    // Each conversion setting yields its own cached PCM file.
    .update(JSON.stringify(dsdOptions))
    .digest('hex')
  const existingTask = localDsdPreparationTasks.get(cacheKey)
  if (existingTask) return existingTask

  const targetChannels = Math.max(1, Math.min(2, sourceFormat?.channels ?? 2))
  const targetSampleRate = dsdOptions.sampleRate
  const targetBitDepth = 32
  const outputFormat: LocalPreparedFormatInfo = {
    format: 'WAV',
    sampleRate: targetSampleRate,
    bitDepth: targetBitDepth,
    bitrate: Math.round((targetSampleRate * targetBitDepth * targetChannels) / 1000),
    channels: targetChannels,
    isLossless: true,
    isHiRes: targetSampleRate > 48_000 || targetBitDepth > 16,
    isMqa: false,
    isDsd: false,
  }
  const outputPath = path.join(getLocalDsdCacheDir(), `${cacheKey}.wav`)

  const task = (async () => {
    if (!fs.existsSync(outputPath)) {
      const ffmpegPath = getFfmpegPath()
      const args = (useSoxr: boolean) => [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', filePath,
        '-vn',
        '-map_metadata', '-1',
        '-af', buildDsdFilterChain(dsdOptions, useSoxr),
        '-c:a', 'pcm_f32le',
        '-ac', String(targetChannels),
        outputPath,
      ]

      try {
        await execFileAsync(ffmpegPath, args(true))
      } catch (error) {
        // An external ffmpeg (PUROS_FFMPEG_PATH / Homebrew) may lack libsoxr or asupercut.
        try {
          await execFileAsync(ffmpegPath, args(false))
          console.warn('[Puros] ffmpeg has no SoX resampler; DSD converted with the default resampler:', error)
        } catch (fallbackError) {
          const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          throw new Error(`Failed to prepare DSD playback via ffmpeg: ${message}`)
        }
      }
    }

    return { playbackPath: outputPath, outputFormat }
  })()

  localDsdPreparationTasks.set(cacheKey, task)
  try {
    return await task
  } finally {
    localDsdPreparationTasks.delete(cacheKey)
  }
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
