import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from './schema'

const databases: Database.Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function createPopulatedV26Fixture(): Database.Database {
  const db = new Database(':memory:')
  databases.push(db)
  db.pragma('foreign_keys = ON')
  initSchema(db, () => {})
  db.exec(`
    INSERT INTO artists (id, name, source, source_id) VALUES ('artist-row', 'Artist', 'legacy-provider', 'artist-source');
    INSERT INTO albums (id, title, album_artist_id, source, source_id) VALUES ('album-row', 'Album', 'artist-row', 'legacy-provider', 'album-source');
    INSERT INTO tracks (id, file_path, title, album_id, artist_id, source, source_id)
      VALUES ('track-row', 'provider://legacy-provider/track-source', 'Track', 'album-row', 'artist-row', 'legacy-provider', 'track-source');
    INSERT INTO playlists (id, name, source, source_id) VALUES (41, 'Playlist', 'legacy-provider', 'playlist-source');
    INSERT INTO settings (key, value) VALUES
      ('catalogSourcePriority', '["local","unknown-provider"]'),
      ('legacy-provider:session', 'opaque-session');
    INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path)
      VALUES ('legacy-provider', 'track-source', 'lossless', '/tmp/retained-cache.flac');
    INSERT INTO catalog_artists (id, name, normalized_name) VALUES ('catalog-artist', 'Artist', 'artist');
    INSERT INTO catalog_albums (id, title, normalized_title, primary_artist_id, primary_artist_name)
      VALUES ('catalog-album', 'Album', 'album', 'catalog-artist', 'Artist');
    INSERT INTO catalog_tracks (id, title, normalized_title, duration_ms, album_id, primary_artist_id)
      VALUES ('catalog-track', 'Track', 'track', 1000, 'catalog-album', 'catalog-artist');
    INSERT INTO catalog_artist_sources (catalog_artist_id, provider, source_id, local_artist_id, in_library)
      VALUES ('catalog-artist', 'legacy-provider', 'artist-source', 'artist-row', 1);
    INSERT INTO catalog_album_sources (catalog_album_id, provider, source_id, local_album_id, in_library)
      VALUES ('catalog-album', 'legacy-provider', 'album-source', 'album-row', 1);
    INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, local_track_id, in_library)
      VALUES ('catalog-track', 'legacy-provider', 'track-source', 'track-row', 1);
    INSERT INTO catalog_artist_sources (catalog_artist_id, provider, source_id, in_library)
      VALUES ('catalog-artist', 'local', 'local-artist-source', 1);
  `)
  for (const table of ['catalog_artist_sources', 'catalog_album_sources', 'catalog_track_sources']) {
    db.exec(`DROP INDEX IF EXISTS idx_${table}_provider_available`)
    db.exec(`ALTER TABLE ${table} DROP COLUMN available`)
  }
  db.exec(`DROP TABLE provider_kv; DROP TABLE provider_secrets;`)
  db.pragma('user_version = 26')
  return db
}

describe('provider data migrations', () => {
  it('upgrades a populated v26 database without deleting provider-owned or core rows', () => {
    const db = createPopulatedV26Fixture()
    const countsBefore = {
      artists: (db.prepare(`SELECT count(*) count FROM artists`).get() as { count: number }).count,
      albums: (db.prepare(`SELECT count(*) count FROM albums`).get() as { count: number }).count,
      tracks: (db.prepare(`SELECT count(*) count FROM tracks`).get() as { count: number }).count,
      playlists: (db.prepare(`SELECT count(*) count FROM playlists`).get() as { count: number }).count,
      cache: (db.prepare(`SELECT count(*) count FROM streaming_audio_cache`).get() as { count: number }).count,
      settings: (db.prepare(`SELECT count(*) count FROM settings`).get() as { count: number }).count,
    }

    initSchema(db, () => {})
    initSchema(db, () => {})

    expect(db.pragma('user_version', { simple: true })).toBe(33)
    expect((db.prepare(`PRAGMA table_info(streaming_audio_cache)`).all() as Array<{ name: string }>).map((column) => column.name)).toContain('source_format')
    expect((db.prepare(`PRAGMA table_info(tracks)`).all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining(['artwork_id', 'art_path', 'unavailable_reason']))
    expect((db.prepare(`PRAGMA table_info(catalog_track_sources)`).all() as Array<{ name: string }>).map((column) => column.name)).toContain('unavailable_reason')
    expect((db.prepare(`SELECT count(*) count FROM artists`).get() as { count: number }).count).toBe(countsBefore.artists)
    expect((db.prepare(`SELECT count(*) count FROM albums`).get() as { count: number }).count).toBe(countsBefore.albums)
    expect((db.prepare(`SELECT count(*) count FROM tracks`).get() as { count: number }).count).toBe(countsBefore.tracks)
    expect((db.prepare(`SELECT count(*) count FROM playlists`).get() as { count: number }).count).toBe(countsBefore.playlists)
    expect((db.prepare(`SELECT count(*) count FROM streaming_audio_cache`).get() as { count: number }).count).toBe(countsBefore.cache)
    expect((db.prepare(`SELECT count(*) count FROM settings WHERE key != 'catalog:needsSourceRebuild'`).get() as { count: number }).count).toBe(countsBefore.settings)
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'catalog:needsSourceRebuild'`).get()).toEqual({ value: 'true' })
    expect((db.prepare(`SELECT id FROM tracks WHERE id = 'track-row'`).get() as { id: string }).id).toBe('track-row')
    expect((db.prepare(`SELECT value FROM settings WHERE key = 'catalogSourcePriority'`).get() as { value: string }).value)
      .toBe('["local","unknown-provider"]')
    expect((db.prepare(`SELECT available FROM catalog_track_sources WHERE provider = 'legacy-provider'`).get() as { available: number }).available).toBe(0)
    expect((db.prepare(`SELECT available FROM catalog_artist_sources WHERE provider = 'local'`).get() as { available: number }).available).toBe(1)
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
  })
})
