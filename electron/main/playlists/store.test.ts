import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../db/schema'

const fixture = vi.hoisted(() => ({
  resolvedProvider: 'tidal',
  available: true,
}))

vi.mock('../providers', () => ({
  listProviderDescriptors: () => [
    { manifest: { id: 'tidal', librarySyncMode: 'host-mirror' } },
    { manifest: { id: 'service-a', librarySyncMode: 'host-mirror' } },
    { manifest: { id: 'apple' } },
  ],
  isProviderAvailable: (id: string) => fixture.available && id !== 'apple',
}))

vi.mock('../artwork/cache', () => ({ cacheRemoteArtwork: vi.fn(async () => null) }))
vi.mock('../catalog/services', () => ({
  ensureCatalogReady: vi.fn(async () => {}),
  getCatalogBrowseService: () => ({
    resolvePlayback: async () => ({ provider: fixture.resolvedProvider, sourceId: 'track-1' }),
    getTrackSummary: () => ({
      id: 'catalog:track:1', title: 'Track', durationMs: 123_000,
      trackNumber: 2, discNumber: 1, primaryArtistId: 'catalog:artist:1',
      primaryArtistName: 'Artist', albumId: 'catalog:album:1', credits: [],
      sourceLinks: ['tidal', 'service-a', 'apple'].map((provider) => ({ provider, sourceId: 'track-1' })),
    }),
    getArtistSummary: () => ({
      id: 'catalog:artist:1', name: 'Artist',
      sourceLinks: ['tidal', 'service-a', 'apple'].map((provider) => ({ provider, sourceId: 'artist-1' })),
    }),
    getAlbumSummary: () => ({
      id: 'catalog:album:1', title: 'Album', primaryArtistId: 'catalog:artist:1',
      primaryArtistName: 'Artist', artworkId: null, artworkUrl: null,
      sourceLinks: ['tidal', 'service-a', 'apple'].map((provider) => ({ provider, sourceId: 'album-1' })),
    }),
  }),
}))

import { ensurePlaylistTrackIdForCatalogTrack, repairPlaylistProviderTrackMetadata } from './store'

function rowId(provider: string, sourceId: string): string {
  return createHash('sha256').update(`${provider}://track/${sourceId}`).digest('hex')
}

function database(): Database.Database {
  const db = new Database(':memory:')
  initSchema(db, () => {})
  db.pragma('foreign_keys = ON')
  db.prepare(`INSERT INTO catalog_artists (id, name, normalized_name) VALUES ('catalog:artist:1', 'Artist', 'artist')`).run()
  db.prepare(`INSERT INTO catalog_albums (id, title, normalized_title, primary_artist_id) VALUES ('catalog:album:1', 'Album', 'album', 'catalog:artist:1')`).run()
  db.prepare(`INSERT INTO catalog_tracks (id, title, normalized_title, album_id, primary_artist_id) VALUES ('catalog:track:1', 'Track', 'track', 'catalog:album:1', 'catalog:artist:1')`).run()
  for (const provider of ['tidal', 'service-a', 'apple']) {
    db.prepare(`INSERT INTO catalog_artist_sources (catalog_artist_id, provider, source_id) VALUES (?, ?, 'artist-1')`).run('catalog:artist:1', provider)
    db.prepare(`INSERT INTO catalog_album_sources (catalog_album_id, provider, source_id) VALUES (?, ?, 'album-1')`).run('catalog:album:1', provider)
    db.prepare(`INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id) VALUES (?, ?, 'track-1')`).run('catalog:track:1', provider)
  }
  return db
}

beforeEach(() => {
  fixture.resolvedProvider = 'tidal'
  fixture.available = true
})

describe('provider playlist row hydration', () => {
  it('preserves Tidal IDs, inspected format, source links, cache, and settings in a populated DB', async () => {
    const db = database()
    try {
      const tidalId = rowId('tidal', 'track-1')
      db.prepare(`INSERT INTO tracks (id, file_path, title, source, source_id, format, sample_rate, bit_depth, lossless, stream_info_fetched_at) VALUES (?, 'tidal://track/track-1', 'Old title', 'tidal', 'track-1', 'FLAC', 96000, 24, 1, 123)`).run(tidalId)
      db.prepare(`INSERT INTO tracks (id, file_path, title, source, source_id) VALUES ('local-1', '/music/local.flac', 'Local', 'local', '/music/local.flac')`).run()
      db.prepare(`INSERT INTO tracks (id, file_path, title, source, source_id) VALUES ('apple-1', 'apple://track/other', 'Apple', 'apple', 'other')`).run()
      db.prepare(`INSERT INTO settings (key, value) VALUES ('playerVolume', '0.7')`).run()
      db.prepare(`INSERT INTO provider_kv (provider, key, value) VALUES ('tidal', 'lastSyncAt', '123')`).run()
      db.prepare(`INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path) VALUES ('tidal', 'track-1', 'LOSSLESS', '/cache/track.flac')`).run()

      expect(await ensurePlaylistTrackIdForCatalogTrack(db, 'catalog:track:1')).toBe(tidalId)
      expect(db.prepare(`SELECT id, file_path, format, sample_rate, bit_depth, lossless, stream_info_fetched_at, artist_id, album_id FROM tracks WHERE id = ?`).get(tidalId)).toEqual({
        id: tidalId, file_path: 'tidal://track/track-1', format: 'FLAC', sample_rate: 96000,
        bit_depth: 24, lossless: 1, stream_info_fetched_at: 123,
        artist_id: 'tidal:artist:artist-1', album_id: 'tidal:album:album-1',
      })
      expect(db.prepare(`SELECT local_track_id FROM catalog_track_sources WHERE provider = 'tidal'`).get()).toEqual({ local_track_id: tidalId })
      expect(db.prepare(`SELECT id FROM tracks WHERE source IN ('local', 'apple') ORDER BY id`).all()).toEqual([{ id: 'apple-1' }, { id: 'local-1' }])
      expect(db.prepare(`SELECT value FROM settings WHERE key = 'playerVolume'`).get()).toEqual({ value: '0.7' })
      expect(db.prepare(`SELECT value FROM provider_kv WHERE provider = 'tidal' AND key = 'lastSyncAt'`).get()).toEqual({ value: '123' })
      expect(db.prepare(`SELECT file_path FROM streaming_audio_cache WHERE provider = 'tidal'`).get()).toEqual({ file_path: '/cache/track.flac' })
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally { db.close() }
  })

  it('hydrates only available host-mirror providers, leaving the Apple legacy adapter unchanged', async () => {
    const db = database()
    try {
      fixture.resolvedProvider = 'apple'
      expect(await ensurePlaylistTrackIdForCatalogTrack(db, 'catalog:track:1')).toBeNull()
      fixture.resolvedProvider = 'service-a'
      expect(await ensurePlaylistTrackIdForCatalogTrack(db, 'catalog:track:1')).toBe(rowId('service-a', 'track-1'))
      fixture.available = false
      fixture.resolvedProvider = 'tidal'
      expect(await ensurePlaylistTrackIdForCatalogTrack(db, 'catalog:track:1')).toBeNull()
      expect(db.prepare(`SELECT id FROM tracks WHERE source = 'tidal'`).all()).toEqual([])
    } finally { db.close() }
  })

  it('repairs an app-managed provider playlist item only while its provider is available', async () => {
    const db = database()
    try {
      const tidalId = rowId('tidal', 'track-1')
      db.prepare(`INSERT INTO tracks (id, file_path, title, source, source_id) VALUES (?, 'tidal://track/track-1', 'Track', 'tidal', 'track-1')`).run(tidalId)
      db.prepare(`INSERT INTO playlists (id, name, source, playback_provider_id) VALUES (1, 'Pinned', 'local', 'tidal')`).run()
      db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, ?, 0)`).run(tidalId)
      fixture.available = false
      await repairPlaylistProviderTrackMetadata(db, 1)
      expect(db.prepare(`SELECT artist_id FROM tracks WHERE id = ?`).get(tidalId)).toEqual({ artist_id: null })
      fixture.available = true
      await repairPlaylistProviderTrackMetadata(db, 1)
      expect(db.prepare(`SELECT artist_id, album_id FROM tracks WHERE id = ?`).get(tidalId)).toEqual({
        artist_id: 'tidal:artist:artist-1', album_id: 'tidal:album:album-1',
      })
      expect(db.prepare(`SELECT track_id FROM playlist_tracks WHERE playlist_id = 1`).get()).toEqual({ track_id: tidalId })
    } finally { db.close() }
  })
})
