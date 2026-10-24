import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../db/schema'

const context = vi.hoisted(() => ({ db: null as Database.Database | null, userData: '' }))
vi.mock('../db', () => ({ getDb: () => context.db! }))
vi.mock('electron', () => ({ app: { getPath: () => context.userData } }))
import {
  enablePlaylistDownload,
  getDownloadsOverview,
  getPlaylistDownloadState,
  markTrackDownloaded,
  removePlaylistDownload,
} from './index'
import { clearStreamingAudioCacheExceptDownloads, getStreamingAudioCacheStats } from '../streamingCache'

function cacheFile(provider: string, name: string, bytes = 1024): string {
  const dir = join(context.userData, 'cache', 'streaming-audio', provider)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, Buffer.alloc(bytes, 1))
  const realFile = realpathSync.native(file)
  context.db!.prepare(`
    INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path, file_size, format, lossless)
    VALUES (?, ?, 'MAX', ?, ?, 'FLAC', 1)
  `).run(provider, name, realFile, bytes)
  return realFile
}

function addTrack(playlistId: number, provider: string, sourceId: string) {
  const id = `${provider}-${sourceId}`
  context.db!.prepare(`INSERT INTO tracks (id, file_path, title, source, source_id) VALUES (?, ?, ?, ?, ?)`)
    .run(id, `${provider}://${sourceId}`, sourceId, provider, sourceId)
  const position = (context.db!.prepare(`SELECT COUNT(*) as count FROM playlist_tracks WHERE playlist_id = ?`).get(playlistId) as { count: number }).count
  context.db!.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`).run(playlistId, id, position)
}

function addPlaylist(name: string): number {
  return Number(context.db!.prepare(`INSERT INTO playlists (name, source, playback_provider_id) VALUES (?, 'tidal', 'tidal')`).run(name).lastInsertRowid)
}

beforeEach(() => {
  context.userData = mkdtempSync(join(tmpdir(), 'puros-downloads-'))
  context.db = new Database(':memory:')
  context.db.pragma('foreign_keys = ON')
  initSchema(context.db, () => {})
})

afterEach(() => {
  context.db?.close(); context.db = null
  rmSync(context.userData, { recursive: true, force: true })
})

describe('playlist downloads', () => {
  it('pins downloaded tracks so they survive clearing the cache and leave the cache stats', () => {
    const playlistId = addPlaylist('Road trip')
    addTrack(playlistId, 'tidal', 'a')
    addTrack(playlistId, 'tidal', 'b')
    enablePlaylistDownload(playlistId)

    const pinned = cacheFile('tidal', 'a')
    const loose = cacheFile('tidal', 'loose')
    expect(markTrackDownloaded('tidal', 'a', pinned)).toBe(true)
    expect(markTrackDownloaded('tidal', 'loose', loose)).toBe(false)

    const state = getPlaylistDownloadState(playlistId)
    expect(state).toMatchObject({ enabled: true, total: 2, downloaded: 1, downloadedKeys: ['tidal:a'] })
    expect(getStreamingAudioCacheStats().fileCount).toBe(1)

    clearStreamingAudioCacheExceptDownloads()
    expect(existsSync(pinned)).toBe(true)
    expect(existsSync(loose)).toBe(false)
    expect(getPlaylistDownloadState(playlistId).downloaded).toBe(1)
  })

  it('rejects files outside the provider cache', () => {
    const playlistId = addPlaylist('Mix')
    addTrack(playlistId, 'tidal', 'a')
    enablePlaylistDownload(playlistId)
    const outside = join(context.userData, 'elsewhere.flac')
    writeFileSync(outside, 'x')
    expect(() => markTrackDownloaded('tidal', 'a', outside)).toThrow()
  })

  it('keeps files shared with another downloaded playlist when one is removed', () => {
    const first = addPlaylist('First')
    const second = addPlaylist('Second')
    addTrack(first, 'tidal', 'shared')
    addTrack(first, 'tidal', 'only-first')
    context.db!.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, 'tidal-shared', 0)`).run(second)
    enablePlaylistDownload(first)
    enablePlaylistDownload(second)
    const shared = cacheFile('tidal', 'shared')
    const onlyFirst = cacheFile('tidal', 'only-first')
    markTrackDownloaded('tidal', 'shared', shared)
    markTrackDownloaded('tidal', 'only-first', onlyFirst)

    expect(getDownloadsOverview()).toMatchObject({ fileCount: 2, orphanedCount: 0 })
    expect(removePlaylistDownload(first)).toBe(1)
    expect(existsSync(onlyFirst)).toBe(false)
    expect(existsSync(shared)).toBe(true)
    expect(getDownloadsOverview().playlists.map((playlist) => playlist.name)).toEqual(['Second'])
  })
})
