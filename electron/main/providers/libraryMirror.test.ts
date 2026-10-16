import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { ProviderLibraryRecordV1 } from '../../../src/provider-api/v1'
import { initSchema } from '../db/schema'
import { applyProviderLibraryUrls, mirrorProviderLibrary, providerLibraryRowId } from './libraryMirror'

const provider = 'service-a'
const records: ProviderLibraryRecordV1[] = [
  { type: 'artist', value: { sourceId: 'artist', name: 'Artist', genres: ['Jazz'] } },
  { type: 'album', value: { sourceId: 'album', title: 'Album', primaryArtistSourceId: 'artist', primaryArtistName: 'Artist' } },
  { type: 'track', value: {
    sourceId: 'track', title: 'Track', durationMs: 123_000,
    albumSourceId: 'album', primaryArtistSourceId: 'artist', primaryArtistName: 'Artist',
    artists: [{ artistSourceId: 'artist', artistName: 'Artist', role: 'primary', position: 0 }],
  } },
  { type: 'playlistFolder', value: { sourceId: 'folder', name: 'Folder', position: 0 } },
  { type: 'playlist', value: { sourceId: 'playlist', title: 'List', folderSourceId: 'folder', folderPosition: 2 } },
  { type: 'playlistTrack', value: { playlistSourceId: 'playlist', trackSourceId: 'track', position: 0 } },
  { type: 'playlistTrack', value: { playlistSourceId: 'playlist', trackSourceId: 'track', position: 1 } },
]

describe('core-owned provider library mirror', () => {
  it('copies snapshot provider links onto catalog source rows and ignores non-web values', () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      db.pragma('foreign_keys = OFF')
      const insert = db.prepare(`INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, provider_url) VALUES (?, ?, ?, ?)`)
      insert.run('catalog:track:a', provider, 'track-a', null)
      insert.run('catalog:track:b', provider, 'track-b', 'https://old.example/b')
      insert.run('catalog:track:c', 'service-b', 'track-a', null)
      const updated = applyProviderLibraryUrls(db, provider, [
        { type: 'track', value: { sourceId: 'track-a', title: 'A', durationMs: 1, providerUrl: 'https://open.example/track/a' } },
        { type: 'track', value: { sourceId: 'track-b', title: 'B', durationMs: 1, providerUrl: 'javascript:alert(1)' } },
        { type: 'playlist', value: { sourceId: 'track-a', title: 'not a track', providerUrl: 'https://x.example' } },
      ])
      expect(updated).toBe(1)
      const urls = db.prepare(`SELECT provider, source_id, provider_url FROM catalog_track_sources ORDER BY catalog_track_id`).all()
      expect(urls).toEqual([
        { provider, source_id: 'track-a', provider_url: 'https://open.example/track/a' },
        { provider, source_id: 'track-b', provider_url: 'https://old.example/b' },
        { provider: 'service-b', source_id: 'track-a', provider_url: null },
      ])
      // Re-applying the same link is a no-op.
      expect(applyProviderLibraryUrls(db, provider, [
        { type: 'track', value: { sourceId: 'track-a', title: 'A', durationMs: 1, providerUrl: 'https://open.example/track/a' } },
      ])).toBe(0)
    } finally {
      db.close()
    }
  })

  it('fetches each distinct artwork URL once with bounded concurrency', async () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      const albums: ProviderLibraryRecordV1[] = Array.from({ length: 40 }, (_, index) => ({
        type: 'album' as const,
        value: { sourceId: `album-${index}`, title: `Album ${index}`, artworkUrl: `https://img.example/${index % 20}.jpg` },
      }))
      let active = 0
      let peak = 0
      const fetched: string[] = []
      await mirrorProviderLibrary(db, provider, albums, async (url) => {
        active += 1
        peak = Math.max(peak, active)
        fetched.push(url!)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active -= 1
        return null
      })
      expect(new Set(fetched).size).toBe(20)
      expect(fetched).toHaveLength(20)
      expect(peak).toBeGreaterThan(1)
      expect(peak).toBeLessThanOrEqual(8)
    } finally {
      db.close()
    }
  })

  it('keeps a track’s own artwork for tracks without an album cover, and keeps it across a sync without one', async () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      // The fake cache returns IDs without artwork_cache rows.
      db.pragma('foreign_keys = OFF')
      const cache = async (url: string | null | undefined) => (url ? `cached:${url}` : null)
      await mirrorProviderLibrary(db, provider, [
        { type: 'album', value: { sourceId: 'album', title: 'Album', artworkUrl: 'https://img.example/album.jpg' } },
        { type: 'track', value: { sourceId: 'video', title: 'Live video', durationMs: 1, artworkUrl: 'https://img.example/thumb.jpg' } },
        { type: 'track', value: { sourceId: 'song', title: 'Song', durationMs: 1, albumSourceId: 'album', artworkUrl: 'https://img.example/song.jpg' } },
      ], cache)
      const rows = db.prepare(`
        SELECT t.source_id, t.artwork_id AS track_artwork_id, al.artwork_id AS album_artwork_id
        FROM tracks t LEFT JOIN albums al ON al.id = t.album_id WHERE t.source = ? ORDER BY t.source_id
      `).all(provider)
      expect(rows).toEqual([
        { source_id: 'song', track_artwork_id: 'cached:https://img.example/song.jpg', album_artwork_id: 'cached:https://img.example/album.jpg' },
        { source_id: 'video', track_artwork_id: 'cached:https://img.example/thumb.jpg', album_artwork_id: null },
      ])
      await mirrorProviderLibrary(db, provider, [
        { type: 'track', value: { sourceId: 'video', title: 'Live video', durationMs: 1 } },
      ], cache)
      expect(db.prepare(`SELECT artwork_id, art_path FROM tracks WHERE source = ? AND source_id = 'video'`).get(provider))
        .toEqual({ artwork_id: 'cached:https://img.example/thumb.jpg', art_path: 'https://img.example/thumb.jpg' })
    } finally {
      db.close()
    }
  })

  it('reuses pre-v1 row IDs and preserves source links, cache, and playlist membership', async () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      const artistId = 'legacy-artist-hash'
      const albumId = 'legacy-album-hash'
      const trackId = 'legacy-track-hash'
      db.prepare(`INSERT INTO artists (id, name, normalized_name, source, source_id) VALUES (?, 'Old Artist', 'old artist', ?, 'artist')`).run(artistId, provider)
      db.prepare(`INSERT INTO albums (id, title, normalized_title, album_artist_id, source, source_id) VALUES (?, 'Old Album', 'old album', ?, ?, 'album')`).run(albumId, artistId, provider)
      db.prepare(`INSERT INTO tracks (id, file_path, title, duration_ms, album_id, artist_id, source, source_id) VALUES (?, ?, 'Old Track', 1, ?, ?, ?, 'track')`)
        .run(trackId, 'legacy://track/track', albumId, artistId, provider)
      db.prepare(`INSERT INTO catalog_artists (id, name) VALUES ('canonical-artist', 'Artist')`).run()
      db.prepare(`INSERT INTO catalog_albums (id, title) VALUES ('canonical-album', 'Album')`).run()
      db.prepare(`INSERT INTO catalog_tracks (id, title) VALUES ('canonical-track', 'Track')`).run()
      db.prepare(`INSERT INTO catalog_artist_sources (catalog_artist_id, provider, source_id, local_artist_id) VALUES ('canonical-artist', ?, 'artist', ?)`).run(provider, artistId)
      db.prepare(`INSERT INTO catalog_album_sources (catalog_album_id, provider, source_id, local_album_id) VALUES ('canonical-album', ?, 'album', ?)`).run(provider, albumId)
      db.prepare(`INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, local_track_id) VALUES ('canonical-track', ?, 'track', ?)`).run(provider, trackId)
      db.prepare(`INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path) VALUES (?, 'track', 'lossless', '/tmp/retained.flac')`).run(provider)
      const localPlaylist = db.prepare(`INSERT INTO playlists (name, source, source_id, playback_provider_id) VALUES ('Local', 'local', 'local-list', ?)`).run(provider).lastInsertRowid
      db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, 0)`).run(localPlaylist, trackId)

      await mirrorProviderLibrary(db, provider, records, async () => null)
      expect(db.prepare(`SELECT id, name FROM artists WHERE source = ?`).all(provider)).toEqual([{ id: artistId, name: 'Artist' }])
      expect(db.prepare(`SELECT id, title, album_artist_id FROM albums WHERE source = ?`).all(provider)).toEqual([
        { id: albumId, title: 'Album', album_artist_id: artistId },
      ])
      expect(db.prepare(`SELECT id, title, album_id, artist_id FROM tracks WHERE source = ?`).all(provider)).toEqual([
        { id: trackId, title: 'Track', album_id: albumId, artist_id: artistId },
      ])
      expect(db.prepare(`SELECT local_artist_id FROM catalog_artist_sources WHERE provider = ?`).get(provider)).toEqual({ local_artist_id: artistId })
      expect(db.prepare(`SELECT local_album_id FROM catalog_album_sources WHERE provider = ?`).get(provider)).toEqual({ local_album_id: albumId })
      expect(db.prepare(`SELECT local_track_id FROM catalog_track_sources WHERE provider = ?`).get(provider)).toEqual({ local_track_id: trackId })
      expect(db.prepare(`SELECT quality_key FROM streaming_audio_cache WHERE provider = ?`).get(provider)).toEqual({ quality_key: 'lossless' })
      expect(db.prepare(`SELECT track_id FROM playlist_tracks WHERE playlist_id = ?`).get(localPlaylist)).toEqual({ track_id: trackId })
      expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps deterministic imported IDs and stable repeated playlist membership IDs across syncs', async () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      const cacheArtwork = async () => null
      const first = await mirrorProviderLibrary(db, provider, records, cacheArtwork)
      expect(first).toEqual({ artists: 1, albums: 1, tracks: 1, playlists: 1, folders: 1 })
      const trackId = providerLibraryRowId(provider, 'track', 'track')
      expect((db.prepare(`SELECT file_path, album_id, artist_id FROM tracks WHERE id = ?`).get(trackId) as Record<string, unknown>))
        .toMatchObject({
          file_path: 'service-a://track/track',
          album_id: 'service-a:album:album',
          artist_id: 'service-a:artist:artist',
        })
      const memberIds = (db.prepare(`SELECT pt.id FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id WHERE p.source = ? ORDER BY pt.position`).all(provider) as Array<{ id: number }>).map(({ id }) => id)
      expect(memberIds).toHaveLength(2)

      db.prepare(`INSERT INTO catalog_tracks (id, title, normalized_title, duration_ms) VALUES (?, ?, ?, ?)`)
        .run('canonical-track', 'Track', 'track', 123_000)
      db.prepare(`INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, local_track_id) VALUES (?, ?, ?, ?)`)
        .run('canonical-track', provider, 'track', trackId)
      db.prepare(`INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path) VALUES (?, ?, ?, ?)`)
        .run(provider, 'track', 'lossless', '/tmp/existing-provider-cache.flac')

      await mirrorProviderLibrary(db, provider, records, cacheArtwork)
      const repeatedIds = (db.prepare(`SELECT pt.id FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id WHERE p.source = ? ORDER BY pt.position`).all(provider) as Array<{ id: number }>).map(({ id }) => id)
      expect(repeatedIds).toEqual(memberIds)
      expect(db.prepare(`SELECT local_track_id FROM catalog_track_sources WHERE provider = ? AND source_id = ?`).get(provider, 'track'))
        .toEqual({ local_track_id: trackId })
      expect(db.prepare(`SELECT quality_key FROM streaming_audio_cache WHERE provider = ? AND source_id = ?`).get(provider, 'track'))
        .toEqual({ quality_key: 'lossless' })
      expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('preserves format data already resolved from an actual playback file', async () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      await mirrorProviderLibrary(db, provider, records, async () => null)
      const trackId = providerLibraryRowId(provider, 'track', 'track')
      db.prepare(`UPDATE tracks SET format = 'FLAC_HIRES', sample_rate = 96000, bit_depth = 24, stream_info_fetched_at = 123 WHERE id = ?`).run(trackId)
      await mirrorProviderLibrary(db, provider, records, async () => null)
      expect(db.prepare(`SELECT format, sample_rate, bit_depth FROM tracks WHERE id = ?`).get(trackId))
        .toEqual({ format: 'FLAC_HIRES', sample_rate: 96000, bit_depth: 24 })
    } finally {
      db.close()
    }
  })

  it('removes stale remote rows but preserves tracks pinned by an app-managed provider playlist', async () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      await mirrorProviderLibrary(db, provider, records, async () => null)
      const trackId = providerLibraryRowId(provider, 'track', 'track')
      const localPlaylist = db.prepare(`INSERT INTO playlists (name, created_at, source, source_id, read_only, playback_provider_id) VALUES ('Local', 1, 'local', 'local-list', 0, ?)`).run(provider).lastInsertRowid
      db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, 0)`).run(localPlaylist, trackId)

      await mirrorProviderLibrary(db, provider, [], async () => null)
      expect(db.prepare(`SELECT id FROM tracks WHERE id = ?`).get(trackId)).toBeDefined()
      expect(db.prepare(`SELECT id FROM albums WHERE id = ?`).get('service-a:album:album')).toBeDefined()
      expect(db.prepare(`SELECT id FROM artists WHERE id = ?`).get('service-a:artist:artist')).toBeDefined()
      expect(db.prepare(`SELECT id FROM playlists WHERE source = ?`).get(provider)).toBeUndefined()

      db.prepare(`DELETE FROM playlists WHERE id = ?`).run(localPlaylist)
      await mirrorProviderLibrary(db, provider, [], async () => null)
      expect(db.prepare(`SELECT id FROM tracks WHERE id = ?`).get(trackId)).toBeUndefined()
      expect(db.prepare(`SELECT id FROM albums WHERE id = ?`).get('service-a:album:album')).toBeUndefined()
      expect(db.prepare(`SELECT id FROM artists WHERE id = ?`).get('service-a:artist:artist')).toBeUndefined()
      expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
    } finally {
      db.close()
    }
  })
})
