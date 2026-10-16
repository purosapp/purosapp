import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from './schema'
import { sourceEntityId } from '../../../src/services/catalog/sourceIdentity'
const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
const id = (providerId: string, entityType: 'artist' | 'album' | 'track', sourceId: string) => sourceEntityId({ providerId, entityType, sourceId })
function legacy() {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys = ON'); initSchema(db, () => {})
  db.exec(`INSERT INTO artists (id, name) VALUES ('local-a', 'Local Artist');
    INSERT INTO albums (id, title, album_artist_id) VALUES ('local-b', 'Local Album', 'local-a');
    INSERT INTO tracks (id, file_path, title, artist_id, album_id, start_offset_ms, end_offset_ms) VALUES ('local-t', '/music/file.flac', 'Local Song', 'local-a', 'local-b', 300, 50300);
    INSERT INTO artists (id, name, source, source_id) VALUES ('remote-a', 'Tidal Artist', 'tidal', 'a');
    INSERT INTO albums (id, title, album_artist_id, source, source_id) VALUES ('remote-b', 'Tidal Album', 'remote-a', 'tidal', 'b');
    INSERT INTO tracks (id, file_path, title, artist_id, album_id, source, source_id) VALUES ('remote-t', 'tidal://track/t', 'Tidal Song', 'remote-a', 'remote-b', 'tidal', 't');
    INSERT INTO catalog_artists (id, name, genres_json) VALUES ('catalog:artist:old', 'Merged Artist', '["Wrong merged genre"]');
    INSERT INTO catalog_albums (id, title, primary_artist_id) VALUES ('catalog:album:old', 'Merged Album', 'catalog:artist:old');
    INSERT INTO catalog_tracks (id, title, album_id, primary_artist_id) VALUES ('catalog:track:old', 'Merged Song', 'catalog:album:old', 'catalog:artist:old');
    INSERT INTO catalog_artist_sources (catalog_artist_id, provider, source_id, local_artist_id, in_library, available) VALUES
      ('catalog:artist:old', 'local', 'local-a', 'local-a', 1, 1), ('catalog:artist:old', 'tidal', 'a', 'remote-a', 1, 1);
    INSERT INTO catalog_album_sources (catalog_album_id, provider, source_id, local_album_id, in_library, available) VALUES
      ('catalog:album:old', 'local', 'local-b', 'local-b', 1, 1), ('catalog:album:old', 'tidal', 'b', 'remote-b', 1, 1);
    INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, local_track_id, in_library, available) VALUES
      ('catalog:track:old', 'local', 'local-t', 'local-t', 1, 1), ('catalog:track:old', 'tidal', 't', 'remote-t', 1, 1);
    INSERT INTO catalog_artist_album_edges (catalog_artist_id, catalog_album_id, provider) VALUES
      ('catalog:artist:old', 'catalog:album:old', 'local'), ('catalog:artist:old', 'catalog:album:old', 'tidal');
    INSERT INTO catalog_album_track_edges (catalog_album_id, catalog_track_id, provider) VALUES
      ('catalog:album:old', 'catalog:track:old', 'local'), ('catalog:album:old', 'catalog:track:old', 'tidal');
    INSERT INTO playlists (id, name, source, playback_provider_id, read_only, legacy_mixed) VALUES
      (1, 'Local', 'local', 'local', 0, 0), (2, 'Tidal mirror', 'tidal', 'tidal', 1, 0),
      (3, 'Tidal copy', 'local', 'tidal', 0, 0), (4, 'Old mixed', 'local', 'mixed', 0, 1);
    INSERT INTO playlist_tracks (id, playlist_id, track_id, position) VALUES
      (11, 1, 'local-t', 0), (12, 1, 'local-t', 1), (21, 2, 'remote-t', 0),
      (31, 3, 'remote-t', 0), (41, 4, 'local-t', 0), (42, 4, 'remote-t', 1);
    INSERT INTO settings (key, value) VALUES ('pins:v1', '{"albums":["catalog:album:old"],"artists":[],"tracks":[],"playlists":[4]}'),
      ('home:recentlyPlayed', '[{"track":{"provider":"tidal","catalogTrackId":"catalog:track:old","sourceId":"t"}}]');`)
  db.pragma('user_version = 29')
  return db
}

describe('source separation migration', () => {
  it('splits merged identities and retains playlist IDs, positions, copies and mixed archives', () => {
    const db = legacy()
    const positions = db.prepare('SELECT * FROM playlist_tracks ORDER BY id').all()
    initSchema(db, () => {})
    expect(db.pragma('user_version', { simple: true })).toBe(32)
    expect(db.prepare('SELECT * FROM playlist_tracks ORDER BY id').all()).toEqual(positions)
    expect(db.prepare('SELECT playback_provider_id, management, legacy_mixed FROM playlists ORDER BY id').all()).toEqual([
      { playback_provider_id: 'local', management: 'app', legacy_mixed: 0 },
      { playback_provider_id: 'tidal', management: 'provider', legacy_mixed: 0 },
      { playback_provider_id: 'tidal', management: 'app', legacy_mixed: 0 },
      { playback_provider_id: 'mixed', management: 'app', legacy_mixed: 1 },
    ])
    expect(db.prepare('SELECT title FROM catalog_tracks WHERE id = ?').get(id('local', 'track', 'local-t'))).toEqual({ title: 'Local Song' })
    expect(db.prepare('SELECT title FROM catalog_tracks WHERE id = ?').get(id('tidal', 'track', 't'))).toEqual({ title: 'Tidal Song' })
    expect(db.prepare('SELECT start_offset_ms, end_offset_ms FROM tracks WHERE id = ?').get('local-t')).toEqual({ start_offset_ms: 300, end_offset_ms: 50300 })
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect((db.prepare('SELECT COUNT(*) as count FROM catalog_album_track_edges').get() as { count: number }).count).toBe(2)
    const history = db.prepare("SELECT value FROM settings WHERE key = 'home:recentlyPlayed'").get() as { value: string }
    expect(JSON.parse(history.value)[0].track.catalogTrackId).toBe(id('tidal', 'track', 't'))
    const pins = db.prepare("SELECT value FROM settings WHERE key = 'pins:v1'").get() as { value: string }
    expect(JSON.parse(pins.value).albums).toEqual(['catalog:album:old'])
    expect(db.prepare("SELECT kind FROM provider_separation_report WHERE reference = 'catalog:album:old'").get()).toEqual({ kind: 'ambiguous_reference' })
    initSchema(db, () => {})
    expect(db.prepare('SELECT * FROM playlist_tracks ORDER BY id').all()).toEqual(positions)
  })
  it('rejects adding foreign-provider tracks to new single-source playlists', () => {
    const db = legacy(); initSchema(db, () => {})
    expect(() => db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, ?, 2)').run('remote-t')).toThrow('same provider')
    expect(() => db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (3, ?, 1)').run('local-t')).toThrow('same provider')
  })
  it('retains multiple editions within one provider and remaps queues using the exact source ID', () => {
    const db = legacy()
    db.exec(`INSERT INTO catalog_album_sources (catalog_album_id, provider, source_id) VALUES ('catalog:album:old', 'tidal', 'edition-2');
      INSERT INTO settings (key, value) VALUES ('savedQueue', '[{"providerId":"tidal","sourceId":"edition-2","catalogAlbumId":"catalog:album:old"}]');`)
    initSchema(db, () => {})
    expect(db.prepare('SELECT id FROM catalog_albums WHERE provider_id = ? ORDER BY source_id').all('tidal')).toEqual([
      { id: id('tidal', 'album', 'b') }, { id: id('tidal', 'album', 'edition-2') },
    ])
    const queue = db.prepare("SELECT value FROM settings WHERE key = 'savedQueue'").get() as { value: string }
    expect(JSON.parse(queue.value)[0].catalogAlbumId).toBe(id('tidal', 'album', 'edition-2'))
    expect(db.prepare("SELECT value FROM settings WHERE key = 'catalog:needsSourceRebuild'").get()).toEqual({ value: 'true' })
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
  it('rolls back the migration on invalid source data without losing existing catalog rows', () => {
    const db = legacy(); db.pragma('foreign_keys = OFF')
    db.prepare(`INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id) VALUES ('missing', 'other', 'missing')`).run()
    expect(() => initSchema(db, () => {})).toThrow('Cannot migrate missing track')
    expect(db.pragma('user_version', { simple: true })).toBe(29)
    expect(db.prepare("SELECT title FROM catalog_tracks WHERE id = 'catalog:track:old'").get()).toEqual({ title: 'Merged Song' })
    expect(db.prepare('SELECT COUNT(*) as count FROM playlist_tracks').get()).toEqual({ count: 6 })
  })
})
