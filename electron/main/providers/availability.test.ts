import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../db/schema'
import { reconcileProviderAvailability } from './availability'
import type { ProviderRegistry } from './registry'

const databases: Database.Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('provider source availability', () => {
  it('keeps rows and marks only local and ready provider sources available', () => {
    const db = new Database(':memory:')
    databases.push(db)
    initSchema(db, () => {})
    db.exec(`
      INSERT INTO catalog_artists (id, name, normalized_name) VALUES ('artist', 'Artist', 'artist');
      INSERT INTO catalog_albums (id, title, normalized_title) VALUES ('album', 'Album', 'album');
      INSERT INTO catalog_tracks (id, title, normalized_title, duration_ms) VALUES ('track', 'Track', 'track', 1000);
      INSERT INTO catalog_artist_sources (catalog_artist_id, provider, source_id, available)
        VALUES ('artist', 'local', 'local-artist', 0), ('artist', 'ready-provider', 'ready-artist', 0), ('artist', 'missing-provider', 'missing-artist', 1);
      INSERT INTO catalog_album_sources (catalog_album_id, provider, source_id, available)
        VALUES ('album', 'ready-provider', 'ready-album', 0), ('album', 'missing-provider', 'missing-album', 1);
      INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, available)
        VALUES ('track', 'ready-provider', 'ready-track', 0), ('track', 'missing-provider', 'missing-track', 1);
    `)

    const registry = {
      list: () => [{
        manifest: { id: 'ready-provider', capabilities: ['catalog.search'] },
        status: { state: 'ready' },
      }],
    } as unknown as ProviderRegistry

    reconcileProviderAvailability(db, registry)

    const rows = db.prepare(`
      SELECT provider, available FROM catalog_artist_sources ORDER BY provider
    `).all() as Array<{ provider: string; available: number }>
    expect(rows).toEqual([
      { provider: 'local', available: 1 },
      { provider: 'missing-provider', available: 0 },
      { provider: 'ready-provider', available: 1 },
    ])
    expect((db.prepare(`SELECT count(*) count FROM catalog_track_sources`).get() as { count: number }).count).toBe(2)
  })

  it('keeps every imported row and cache entry when a selected provider is paused', () => {
    const db = new Database(':memory:')
    databases.push(db)
    initSchema(db, () => {})
    db.exec(`
      INSERT INTO artists (id, name, normalized_name, source, source_id) VALUES ('apple-artist', 'Artist', 'artist', 'apple', 'artist-1');
      INSERT INTO albums (id, title, normalized_title, source, source_id) VALUES ('apple-album', 'Album', 'album', 'apple', 'album-1');
      INSERT INTO tracks (id, file_path, title, source, source_id) VALUES ('apple-track', 'apple://track/track-1', 'Track', 'apple', 'track-1');
      INSERT INTO playlists (name, source, source_id) VALUES ('Playlist', 'apple', 'playlist-1');
      INSERT INTO catalog_tracks (id, title) VALUES ('catalog-track', 'Track');
      INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, local_track_id, available)
        VALUES ('catalog-track', 'apple', 'track-1', 'apple-track', 1);
      INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path)
        VALUES ('apple', 'track-1', 'aac', '/tmp/retained.m4a');
      INSERT INTO settings (key, value) VALUES ('apple:lastSyncAt', '123');
    `)
    const registry = {
      list: () => [{ manifest: { id: 'apple', capabilities: [] }, status: { state: 'degraded', authenticated: false } }],
    } as unknown as ProviderRegistry

    reconcileProviderAvailability(db, registry)

    expect(db.prepare(`SELECT available, local_track_id FROM catalog_track_sources WHERE provider = 'apple'`).get())
      .toEqual({ available: 0, local_track_id: 'apple-track' })
    for (const table of ['artists', 'albums', 'tracks', 'playlists', 'streaming_audio_cache']) {
      expect((db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table === 'streaming_audio_cache' ? 'provider' : 'source'} = 'apple'`).get() as { count: number }).count)
        .toBe(1)
    }
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'apple:lastSyncAt'`).get()).toEqual({ value: '123' })
  })
})
