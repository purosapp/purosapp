import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { FormatInfo } from '../../../src/services/local/formats'
import { getDb } from '../db'
import { runPlaybackIdleTask } from '../playbackCoordinator'
import {
  DEFAULT_STREAMING_AUDIO_CACHE_LIMIT_GB,
  STREAMING_AUDIO_CACHE_LIMIT_GB_KEY,
} from '../settings/store'

export interface ResolvedStreamingPlaybackInfo {
  playbackPath: string
  quality: FormatInfo
  /** Provenance of what the service delivered when the cached file is a conversion. */
  sourceQuality?: FormatInfo
  resolvedQuality?: string
  resolvedTrackId?: string
  recoveryTrace?: string[]
  cacheHit?: boolean
}

export function getStreamingAudioCacheRoot(): string {
  const dir = path.join(app.getPath('userData'), 'cache', 'streaming-audio')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getStreamingAudioCacheDir(provider: string): string {
  const safeProvider = provider.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'provider'
  const dir = path.join(getStreamingAudioCacheRoot(), safeProvider)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getStreamingAudioCacheLimitGb(): number {
  const raw = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(STREAMING_AUDIO_CACHE_LIMIT_GB_KEY) as { value: string } | undefined
  const parsed = Number(raw?.value)
  if (!Number.isFinite(parsed)) return DEFAULT_STREAMING_AUDIO_CACHE_LIMIT_GB
  return Math.max(1, Math.min(500, parsed))
}

function getStreamingAudioCacheLimitBytes(): number {
  return Math.floor(getStreamingAudioCacheLimitGb() * 1024 * 1024 * 1024)
}

function isLosslessStreamingQualityKey(qualityKey: string | null | undefined): boolean {
  const normalized = String(qualityKey ?? '').trim().toUpperCase()
  return normalized === 'MAX' || normalized === 'HI_RES' || normalized === 'HI_RES_LOSSLESS' || normalized === 'LOSSLESS'
}

function getStreamingAudioFileSize(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 0 ? stat.size : null
  } catch {
    return null
  }
}

function parseSourceQuality(raw: string | null | undefined): FormatInfo | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<FormatInfo>
    if (!value || typeof value.format !== 'string' || typeof value.isLossless !== 'boolean') return undefined
    return {
      format: value.format as FormatInfo['format'],
      sampleRate: Number(value.sampleRate) || 0,
      bitDepth: Number(value.bitDepth) || 0,
      bitrate: Number(value.bitrate) || 0,
      channels: Number(value.channels) || 2,
      isLossless: value.isLossless,
      isHiRes: value.isHiRes === true,
      isMqa: value.isMqa === true,
      isDsd: value.isDsd === true,
      ...(value.dsdRate ? { dsdRate: Number(value.dsdRate) } : {}),
    }
  } catch {
    return undefined
  }
}

/** A lossless request must be satisfied by the delivered source, not by a lossless conversion of it. */
function isLosslessPlayback(info: Pick<ResolvedStreamingPlaybackInfo, 'quality' | 'sourceQuality'>): boolean {
  return (info.sourceQuality ?? info.quality).isLossless
}

function cachedStreamingAudioRowToPlaybackInfo(row: {
  source_id: string
  resolved_source_id: string | null
  resolved_quality: string | null
  file_path: string
  format: string | null
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  lossless: number | null
  is_dsd: number | null
  dsd_rate: number | null
  source_format?: string | null
}): ResolvedStreamingPlaybackInfo {
  const format = (row.format ?? 'FLAC') as FormatInfo['format']
  const sampleRate = row.sample_rate ?? 0
  const bitDepth = row.bit_depth ?? 0
  const isDsd = row.is_dsd === 1 || format === 'DSD'
  return {
    playbackPath: row.file_path,
    quality: {
      format,
      sampleRate,
      bitDepth,
      bitrate: row.bitrate ?? 0,
      channels: row.channels ?? 2,
      isLossless: row.lossless !== 0,
      isHiRes: isDsd || bitDepth > 16 || sampleRate > 48_000,
      isMqa: format === 'MQA',
      isDsd,
      dsdRate: isDsd ? (row.dsd_rate ?? sampleRate) : undefined,
    },
    sourceQuality: parseSourceQuality(row.source_format),
    resolvedQuality: row.resolved_quality ?? undefined,
    resolvedTrackId: row.resolved_source_id ?? row.source_id,
    recoveryTrace: [],
    cacheHit: true,
  }
}

export function getCachedStreamingAudio(provider: string, sourceId: string, qualityKey: string, requireLossless = isLosslessStreamingQualityKey(qualityKey)): ResolvedStreamingPlaybackInfo | null {
  const row = getDb().prepare(`
    SELECT source_id, resolved_source_id, resolved_quality, file_path, file_size,
           format, sample_rate, bit_depth, bitrate, channels, lossless, is_dsd, dsd_rate, source_format
    FROM streaming_audio_cache
    WHERE provider = ?
      AND quality_key = ?
      AND source_id = ?
      AND COALESCE(resolved_source_id, source_id) = source_id
    ORDER BY last_played_at DESC,
             last_accessed_at DESC
    LIMIT 1
  `).get(provider, qualityKey, sourceId) as {
    source_id: string
    resolved_source_id: string | null
    resolved_quality: string | null
    file_path: string
    file_size: number | null
    format: string | null
    sample_rate: number | null
    bit_depth: number | null
    bitrate: number | null
    channels: number | null
    lossless: number | null
    is_dsd: number | null
    dsd_rate: number | null
    source_format: string | null
  } | undefined

  if (!row) return null
  const fileSize = getStreamingAudioFileSize(row.file_path)
  if (!fileSize) {
    getDb().prepare(`DELETE FROM streaming_audio_cache WHERE provider = ? AND source_id = ? AND quality_key = ?`).run(provider, row.source_id, qualityKey)
    return null
  }

  getDb().prepare(`
    UPDATE streaming_audio_cache
    SET file_size = ?, last_accessed_at = strftime('%s','now'), last_played_at = strftime('%s','now')
    WHERE provider = ? AND source_id = ? AND quality_key = ?
  `).run(fileSize, provider, row.source_id, qualityKey)

  const cached = cachedStreamingAudioRowToPlaybackInfo(row)
  if (requireLossless && !isLosslessPlayback(cached)) {
    console.info(
      '[Puros][StreamingCache] Ignoring lossy cache entry for lossless request:',
      sourceId,
      qualityKey,
      cached.resolvedQuality ?? 'unknown',
      cached.quality.format,
    )
    getDb().prepare(`
      DELETE FROM streaming_audio_cache
      WHERE provider = ? AND source_id = ? AND quality_key = ?
    `).run(provider, row.source_id, qualityKey)
    try {
      fs.unlinkSync(row.file_path)
    } catch {
      // Best-effort cache cleanup.
    }
    return null
  }

  return cached
}

export function registerStreamingAudioCacheEntry(
  provider: string,
  requestedSourceId: string,
  qualityKey: string,
  playbackInfo: ResolvedStreamingPlaybackInfo,
  requireLossless = isLosslessStreamingQualityKey(qualityKey),
) {
  const fileSize = getStreamingAudioFileSize(playbackInfo.playbackPath)
  if (!fileSize) return

  const quality = playbackInfo.quality
  if (requireLossless && !isLosslessPlayback(playbackInfo)) {
    console.info(
      '[Puros][StreamingCache] Not storing lossy fallback under lossless cache key:',
      requestedSourceId,
      qualityKey,
      playbackInfo.resolvedQuality ?? 'unknown',
      quality.format,
    )
    return
  }

  getDb().prepare(`
    INSERT INTO streaming_audio_cache (
      provider, source_id, quality_key, resolved_source_id, resolved_quality, file_path, file_size,
      format, sample_rate, bit_depth, bitrate, channels, lossless, is_dsd, dsd_rate, source_format,
      created_at, last_accessed_at, last_played_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'), strftime('%s','now'))
    ON CONFLICT(provider, source_id, quality_key) DO UPDATE SET
      resolved_source_id = excluded.resolved_source_id,
      resolved_quality = excluded.resolved_quality,
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      format = excluded.format,
      sample_rate = excluded.sample_rate,
      bit_depth = excluded.bit_depth,
      bitrate = excluded.bitrate,
      channels = excluded.channels,
      lossless = excluded.lossless,
      is_dsd = excluded.is_dsd,
      dsd_rate = excluded.dsd_rate,
      source_format = excluded.source_format,
      last_accessed_at = strftime('%s','now'),
      last_played_at = strftime('%s','now')
  `).run(
    provider,
    requestedSourceId,
    qualityKey,
    playbackInfo.resolvedTrackId ?? requestedSourceId,
    playbackInfo.resolvedQuality ?? null,
    playbackInfo.playbackPath,
    fileSize,
    quality.format,
    quality.sampleRate || null,
    quality.bitDepth || null,
    quality.bitrate || null,
    quality.channels || 2,
    quality.isLossless ? 1 : 0,
    quality.isDsd ? 1 : 0,
    quality.dsdRate ?? null,
    playbackInfo.sourceQuality ? JSON.stringify(playbackInfo.sourceQuality) : null,
  )
}

function trimStreamingAudioCache(provider?: string) {
  const limitBytes = getStreamingAudioCacheLimitBytes()
  const rows = getDb().prepare(`
    SELECT file_path,
           MAX(COALESCE(last_played_at, last_accessed_at, created_at, 0)) as last_used_at
    FROM streaming_audio_cache
    ${provider ? 'WHERE provider = ?' : ''}
    GROUP BY file_path
    ORDER BY last_used_at DESC
  `).all(...(provider ? [provider] : [])) as Array<{ file_path: string; last_used_at: number | null }>

  const stalePaths: string[] = []
  for (const row of rows) {
    const size = getStreamingAudioFileSize(row.file_path)
    if (!size) {
      stalePaths.push(row.file_path)
      continue
    }
  }

  for (const stalePath of stalePaths) {
    getDb().prepare(`DELETE FROM streaming_audio_cache WHERE file_path = ?`).run(stalePath)
  }

  let runningTotal = 0
  rows.forEach((row, index) => {
    if (stalePaths.includes(row.file_path)) return
    const size = getStreamingAudioFileSize(row.file_path)
    if (!size) return
    runningTotal += size
    if (index === 0) return
    if (runningTotal <= limitBytes) return
    removePathIfExists(row.file_path)
    getDb().prepare(`DELETE FROM streaming_audio_cache WHERE file_path = ?`).run(row.file_path)
  })
}

let streamingAudioCacheTrimScheduled = false
let trimAllStreamingAudioCaches = false
const pendingStreamingAudioCacheProviders = new Set<string>()

export function scheduleStreamingAudioCacheTrim(provider?: string) {
  if (provider) pendingStreamingAudioCacheProviders.add(provider)
  else trimAllStreamingAudioCaches = true
  if (streamingAudioCacheTrimScheduled) return

  streamingAudioCacheTrimScheduled = true
  runPlaybackIdleTask('streaming cache trim', () => {
    streamingAudioCacheTrimScheduled = false
    const trimAll = trimAllStreamingAudioCaches
    const providers = [...pendingStreamingAudioCacheProviders]
    trimAllStreamingAudioCaches = false
    pendingStreamingAudioCacheProviders.clear()
    if (trimAll) trimStreamingAudioCache()
    else providers.forEach((nextProvider) => trimStreamingAudioCache(nextProvider))
  })
}

export function getStreamingAudioCacheStats(provider?: string) {
  const rows = getDb().prepare(`
    SELECT file_path
    FROM streaming_audio_cache
    ${provider ? 'WHERE provider = ?' : ''}
    GROUP BY file_path
  `).all(...(provider ? [provider] : [])) as Array<{ file_path: string }>

  let totalBytes = 0
  let fileCount = 0
  const stalePaths: string[] = []

  for (const row of rows) {
    const size = getStreamingAudioFileSize(row.file_path)
    if (!size) {
      stalePaths.push(row.file_path)
      continue
    }
    totalBytes += size
    fileCount += 1
  }

  for (const stalePath of stalePaths) {
    getDb().prepare(`DELETE FROM streaming_audio_cache WHERE file_path = ?`).run(stalePath)
  }

  return {
    totalBytes,
    totalGb: totalBytes / (1024 * 1024 * 1024),
    fileCount,
    limitGb: getStreamingAudioCacheLimitGb(),
    limitBytes: getStreamingAudioCacheLimitBytes(),
  }
}

export function removePathIfExists(targetPath: string) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only.
  }
}
