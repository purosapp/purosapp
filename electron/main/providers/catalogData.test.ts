import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initSchema } from '../db/schema'
import { getProviderPlaybackRecoverySeed, getStoredProviderTrack, setProviderTrackUnavailableReason } from './catalogData'

describe('provider-scoped playback recovery seed', () => {
  it('returns imported identity and only same-provider equivalent sources', () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      db.prepare(`INSERT INTO artists (id, name, normalized_name, source, source_id) VALUES ('artist', 'Performer', 'performer', 'fixture', 'a')`).run()
      db.prepare(`INSERT INTO albums (id, title, normalized_title, source, source_id) VALUES ('album', 'Record', 'record', 'fixture', 'b')`).run()
      db.prepare(`INSERT INTO tracks (id, file_path, title, duration_ms, album_id, artist_id, source, source_id, isrc)
                  VALUES ('track', 'fixture://track', 'Song', 123000, 'album', 'artist', 'fixture', 'song', 'USAAA1234567')`).run()
      db.prepare(`INSERT INTO catalog_tracks (id, title) VALUES ('canonical', 'Song')`).run()
      db.prepare(`INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, in_library)
                  VALUES ('canonical', 'fixture', 'song', 1), ('canonical', 'fixture', 'alternate', 0), ('canonical', 'other', 'private', 1)`).run()
      expect(getProviderPlaybackRecoverySeed(db, 'fixture', 'song')).toEqual({
        title: 'Song', artist: 'Performer', album: 'Record', isrc: 'USAAA1234567', durationMs: 123000,
        equivalentSourceIds: ['song', 'alternate'],
      })
      expect(getProviderPlaybackRecoverySeed(db, 'other', 'song')).toBeNull()
      db.prepare(`UPDATE catalog_track_sources SET provider_url = 'https://fixture.example/track/song' WHERE provider = 'fixture' AND source_id = 'song'`).run()
      expect(getStoredProviderTrack(db, 'fixture', 'song')).toMatchObject({
        sourceId: 'song', providerUrl: 'https://fixture.example/track/song',
      })
      expect(getStoredProviderTrack(db, 'other', 'song')).toBeNull()
    } finally {
      db.close()
    }
  })
})

describe('playback-discovered track availability', () => {
  it('marks and clears only the provider’s own source rows and reports changes', () => {
    const db = new Database(':memory:')
    try {
      initSchema(db, () => {})
      db.pragma('foreign_keys = OFF')
      db.prepare(`INSERT INTO tracks (id, file_path, title, duration_ms, source, source_id) VALUES ('a', 'fixture://a', 'A', 1, 'fixture', 'song'), ('b', 'other://b', 'B', 1, 'other', 'song')`).run()
      db.prepare(`INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id) VALUES ('ca', 'fixture', 'song'), ('cb', 'other', 'song')`).run()
      const reasons = () => [
        ...db.prepare(`SELECT source, unavailable_reason FROM tracks ORDER BY source`).all(),
        ...db.prepare(`SELECT provider, unavailable_reason FROM catalog_track_sources ORDER BY provider`).all(),
      ]

      expect(setProviderTrackUnavailableReason(db, 'fixture', 'song', 'region')).toBe(true)
      expect(setProviderTrackUnavailableReason(db, 'fixture', 'song', 'region')).toBe(false)
      expect(reasons()).toEqual([
        { source: 'fixture', unavailable_reason: 'region' }, { source: 'other', unavailable_reason: null },
        { provider: 'fixture', unavailable_reason: 'region' }, { provider: 'other', unavailable_reason: null },
      ])
      expect(setProviderTrackUnavailableReason(db, 'fixture', 'song', null)).toBe(true)
      expect(setProviderTrackUnavailableReason(db, 'fixture', 'song', null)).toBe(false)
      expect(reasons().every((row) => (row as { unavailable_reason: string | null }).unavailable_reason === null)).toBe(true)
    } finally {
      db.close()
    }
  })
})
