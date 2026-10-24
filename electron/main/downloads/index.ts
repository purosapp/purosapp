import fs from 'node:fs'
import { getDb } from '../db'
import { isPathInsideRoot } from '../security/pathPolicy'
import { getStreamingAudioCacheDir, removePathIfExists } from '../streamingCache'

/**
 * Playlist downloads pin provider tracks in the streaming audio cache.
 *
 * The renderer drives the actual downloads through each provider's
 * prefetch/resolve call (which already writes into the cache) and reports
 * every finished file here. Membership is computed from the playlists, so a
 * track shared by two downloaded playlists is stored once.
 */

export interface PlaylistDownloadState {
  enabled: boolean
  /** Provider tracks that can be downloaded (local and unavailable tracks excluded). */
  total: number
  downloaded: number
  unavailable: number
  totalBytes: number
  /** `provider:sourceId` keys of the tracks already on disk. */
  downloadedKeys: string[]
}

export interface DownloadedPlaylistSummary {
  playlistId: number
  name: string
  provider: string
  artworkId: string | null
  createdAt: number
  total: number
  downloaded: number
  unavailable: number
  totalBytes: number
}

export interface DownloadsOverview {
  playlists: DownloadedPlaylistSummary[]
  fileCount: number
  totalBytes: number
  orphanedCount: number
  orphanedBytes: number
}

type MemberRow = {
  provider: string
  source_id: string
  unavailable_reason: string | null
  file_path: string | null
  file_size: number | null
}

export function downloadKey(provider: string, sourceId: string): string {
  return `${provider}:${sourceId}`
}

function fileSize(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 0 ? stat.size : null
  } catch {
    return null
  }
}

function playlistMembers(playlistId: number): MemberRow[] {
  return getDb().prepare(`
    SELECT t.source as provider, t.source_id, MAX(t.unavailable_reason) as unavailable_reason,
           ot.file_path, ot.file_size
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    LEFT JOIN offline_tracks ot ON ot.provider = t.source AND ot.source_id = t.source_id
    WHERE pt.playlist_id = ?
      AND t.source != 'local'
      AND t.source_id IS NOT NULL
    GROUP BY t.source, t.source_id
  `).all(playlistId) as MemberRow[]
}

function forgetDownloadedTrack(provider: string, sourceId: string) {
  getDb().prepare(`DELETE FROM offline_tracks WHERE provider = ? AND source_id = ?`).run(provider, sourceId)
}

function summarizeMembers(members: MemberRow[]) {
  let total = 0
  let downloaded = 0
  let unavailable = 0
  let totalBytes = 0
  const downloadedKeys: string[] = []
  for (const member of members) {
    if (member.file_path) {
      const size = fileSize(member.file_path)
      if (size) {
        total += 1
        downloaded += 1
        totalBytes += size
        downloadedKeys.push(downloadKey(member.provider, member.source_id))
        continue
      }
      // The file vanished (deleted by hand, disk cleanup); download it again.
      forgetDownloadedTrack(member.provider, member.source_id)
    }
    if (member.unavailable_reason) unavailable += 1
    else total += 1
  }
  return { total, downloaded, unavailable, totalBytes, downloadedKeys }
}

function isPlaylistDownloadEnabled(playlistId: number): boolean {
  return getDb().prepare(`SELECT 1 FROM offline_playlists WHERE playlist_id = ?`).get(playlistId) != null
}

export function getPlaylistDownloadState(playlistId: number): PlaylistDownloadState {
  return {
    enabled: isPlaylistDownloadEnabled(playlistId),
    ...summarizeMembers(playlistMembers(playlistId)),
  }
}

export function enablePlaylistDownload(playlistId: number): PlaylistDownloadState {
  const exists = getDb().prepare(`SELECT 1 FROM playlists WHERE id = ?`).get(playlistId) != null
  if (!exists) throw new Error(`Playlist not found: ${playlistId}`)
  getDb().prepare(`INSERT OR IGNORE INTO offline_playlists (playlist_id) VALUES (?)`).run(playlistId)
  return getPlaylistDownloadState(playlistId)
}

function isTrackInDownloadedPlaylist(provider: string, sourceId: string): boolean {
  return getDb().prepare(`
    SELECT 1
    FROM offline_playlists op
    JOIN playlist_tracks pt ON pt.playlist_id = op.playlist_id
    JOIN tracks t ON t.id = pt.track_id
    WHERE t.source = ? AND t.source_id = ?
    LIMIT 1
  `).get(provider, sourceId) != null
}

/**
 * Pins a finished provider file. Prefers the cache entry the provider wrote for
 * this source, since that is the file its cache lookup will serve offline.
 */
export function markTrackDownloaded(provider: string, sourceId: string, artifactPath: string): boolean {
  if (typeof provider !== 'string' || !provider || provider === 'local') throw new TypeError('Invalid download provider')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('Invalid download source ID')
  if (typeof artifactPath !== 'string' || !artifactPath) throw new TypeError('Invalid download path')
  if (!isTrackInDownloadedPlaylist(provider, sourceId)) return false

  const cacheRoot = fs.realpathSync.native(getStreamingAudioCacheDir(provider))
  const cached = getDb().prepare(`
    SELECT file_path FROM streaming_audio_cache
    WHERE provider = ? AND source_id = ?
    ORDER BY last_played_at DESC, last_accessed_at DESC
  `).all(provider, sourceId) as Array<{ file_path: string }>
  const candidates = [...cached.map((row) => row.file_path), artifactPath]

  for (const candidate of candidates) {
    let realPath: string
    try {
      realPath = fs.realpathSync.native(candidate)
    } catch {
      continue
    }
    if (!isPathInsideRoot(realPath, cacheRoot)) continue
    const size = fileSize(realPath)
    if (!size) continue
    getDb().prepare(`
      INSERT INTO offline_tracks (provider, source_id, file_path, file_size, downloaded_at)
      VALUES (?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(provider, source_id) DO UPDATE SET
        file_path = excluded.file_path,
        file_size = excluded.file_size,
        downloaded_at = excluded.downloaded_at
    `).run(provider, sourceId, realPath, size)
    return true
  }
  throw new Error('Downloaded audio is not in the provider cache')
}

function orphanedTracks(): Array<{ provider: string; source_id: string; file_path: string; file_size: number }> {
  return getDb().prepare(`
    SELECT ot.provider, ot.source_id, ot.file_path, ot.file_size
    FROM offline_tracks ot
    WHERE NOT EXISTS (
      SELECT 1
      FROM offline_playlists op
      JOIN playlist_tracks pt ON pt.playlist_id = op.playlist_id
      JOIN tracks t ON t.id = pt.track_id
      WHERE t.source = ot.provider AND t.source_id = ot.source_id
    )
  `).all() as Array<{ provider: string; source_id: string; file_path: string; file_size: number }>
}

function deleteDownloadedFiles(rows: Array<{ provider: string; source_id: string; file_path: string }>): number {
  const db = getDb()
  const forget = db.prepare(`DELETE FROM offline_tracks WHERE provider = ? AND source_id = ?`)
  const stillPinned = db.prepare(`SELECT 1 FROM offline_tracks WHERE file_path = ? LIMIT 1`)
  const dropCacheRows = db.prepare(`DELETE FROM streaming_audio_cache WHERE file_path = ?`)
  const removedPaths: string[] = []
  db.transaction(() => {
    for (const row of rows) {
      forget.run(row.provider, row.source_id)
      if (stillPinned.get(row.file_path)) continue
      dropCacheRows.run(row.file_path)
      removedPaths.push(row.file_path)
    }
  })()
  removedPaths.forEach(removePathIfExists)
  return removedPaths.length
}

/** Deletes downloaded files no downloaded playlist contains any more. */
export function pruneOrphanedDownloads(): number {
  return deleteDownloadedFiles(orphanedTracks())
}

export function removePlaylistDownload(playlistId: number): number {
  getDb().prepare(`DELETE FROM offline_playlists WHERE playlist_id = ?`).run(playlistId)
  return pruneOrphanedDownloads()
}

export function removeAllDownloads(): number {
  getDb().prepare(`DELETE FROM offline_playlists`).run()
  const rows = getDb().prepare(`SELECT provider, source_id, file_path FROM offline_tracks`).all() as Array<{ provider: string; source_id: string; file_path: string }>
  return deleteDownloadedFiles(rows)
}

export function getDownloadsOverview(): DownloadsOverview {
  const playlists = getDb().prepare(`
    SELECT op.playlist_id, op.created_at, p.name, p.playback_provider_id as provider, p.artwork_id
    FROM offline_playlists op
    JOIN playlists p ON p.id = op.playlist_id
    ORDER BY p.name COLLATE NOCASE
  `).all() as Array<{ playlist_id: number; created_at: number; name: string; provider: string; artwork_id: string | null }>

  const summaries = playlists.map((playlist): DownloadedPlaylistSummary => {
    const { total, downloaded, unavailable, totalBytes } = summarizeMembers(playlistMembers(playlist.playlist_id))
    return {
      playlistId: playlist.playlist_id,
      name: playlist.name,
      provider: playlist.provider,
      artworkId: playlist.artwork_id,
      createdAt: playlist.created_at,
      total,
      downloaded,
      unavailable,
      totalBytes,
    }
  })

  // Shared tracks count once towards the totals.
  const files = getDb().prepare(`SELECT DISTINCT file_path FROM offline_tracks`).all() as Array<{ file_path: string }>
  let totalBytes = 0
  let fileCount = 0
  for (const { file_path } of files) {
    const size = fileSize(file_path)
    if (!size) continue
    totalBytes += size
    fileCount += 1
  }
  const orphans = orphanedTracks()

  return {
    playlists: summaries,
    fileCount,
    totalBytes,
    orphanedCount: orphans.length,
    orphanedBytes: orphans.reduce((sum, row) => sum + (fileSize(row.file_path) ?? 0), 0),
  }
}
