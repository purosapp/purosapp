import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { initSchema } from '../electron/main/db/schema'
import { mirrorProviderLibrary } from '../electron/main/providers/libraryMirror'
import { TidalLibrarySync } from './fixtures/TidalLibrarySyncLegacy'
import type { TidalApiService } from '../providers/tidal/src/TidalApiService'
import type { TidalLibraryPayload } from '../providers/tidal/src/types'
import { mapTidalLibraryRecords } from '../providers/tidal/src/libraryRecords'

const artist = { id: 7, name: 'Artist', genres: ['Jazz'] }
const album = { id: 9, title: 'Album', upc: '000123', artists: [artist], numberOfTracks: 1, releaseDate: '2024-01-01' }
const track = { id: 11, title: 'Track', isrc: 'USABC1234567', duration: 121, album, artists: [artist] }
const payload: TidalLibraryPayload = {
  albums: [album],
  tracks: [track],
  playlistFolders: [{ sourceId: 'folder', name: 'Folder', position: 0 }],
  playlists: [{ uuid: 'playlist', title: 'List', folderSourceId: 'folder', folderPosition: 2, items: [track, track] }],
}

function snapshot(db: Database.Database) {
  const tables = ['artists', 'albums', 'tracks', 'track_artists', 'playlists', 'playlist_folders', 'playlist_tracks'] as const
  return Object.fromEntries(tables.map((table) => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
    const stable = rows.map((row) => {
      const value = { ...row }
      delete value.indexed_at
      delete value.created_at
      return value
    })
    return [table, stable]
  }))
}

describe('Tidal library mirror parity before activation', () => {
  it('matches the legacy SQLite rows for the same completed payload', async () => {
    const legacy = new Database(':memory:')
    const mirrored = new Database(':memory:')
    try {
      initSchema(legacy, () => {})
      initSchema(mirrored, () => {})
      const sync = new TidalLibrarySync({
        api: { fetchLibraryPayload: async () => payload } as unknown as TidalApiService,
        dbContext: { db: legacy, rebuildSearchIndex: () => {} },
        artworkCache: { cacheRemoteArtwork: async () => null },
      })
      await sync.syncUserLibrary()
      await mirrorProviderLibrary(mirrored, 'tidal', mapTidalLibraryRecords(payload), async () => null)
      expect(snapshot(mirrored)).toEqual(snapshot(legacy))
    } finally {
      legacy.close()
      mirrored.close()
    }
  })

  it('matches legacy cleanup without losing locally pinned rows, source links, or cache entries', async () => {
    const legacy = new Database(':memory:')
    const mirrored = new Database(':memory:')
    try {
      let nextPayload = payload
      const databases = [legacy, mirrored]
      const syncs = databases.map((db) => {
        initSchema(db, () => {})
        return new TidalLibrarySync({
          api: { fetchLibraryPayload: async () => nextPayload } as unknown as TidalApiService,
          dbContext: { db, rebuildSearchIndex: () => {} },
          artworkCache: { cacheRemoteArtwork: async () => null },
        })
      })
      await Promise.all(syncs.map((sync) => sync.syncUserLibrary()))
      for (const db of databases) {
        const trackId = (db.prepare(`SELECT id FROM tracks WHERE source = 'tidal'`).get() as { id: string }).id
        const localId = db.prepare(`INSERT INTO playlists (name, source, source_id, playback_provider_id) VALUES ('Local', 'local', 'local-list', 'tidal')`).run().lastInsertRowid
        db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, 0)`).run(localId, trackId)
        db.prepare(`INSERT INTO catalog_tracks (id, title, normalized_title, duration_ms) VALUES ('canonical', 'Track', 'track', 121000)`).run()
        db.prepare(`INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, local_track_id) VALUES ('canonical', 'tidal', '11', ?)`)
          .run(trackId)
        db.prepare(`INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path) VALUES ('tidal', '11', 'LOSSLESS', '/tmp/existing-cache.flac')`).run()
      }

      nextPayload = { albums: [], tracks: [], playlists: [], playlistFolders: [] }
      await syncs[0].syncUserLibrary()
      await mirrorProviderLibrary(mirrored, 'tidal', mapTidalLibraryRecords(nextPayload), async () => null)

      expect(snapshot(mirrored)).toEqual(snapshot(legacy))
      for (const db of databases) {
        expect(db.prepare(`SELECT 1 FROM catalog_track_sources WHERE provider = 'tidal' AND source_id = '11'`).get()).toBeDefined()
        expect(db.prepare(`SELECT 1 FROM streaming_audio_cache WHERE provider = 'tidal' AND source_id = '11'`).get()).toBeDefined()
        expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
      }
    } finally {
      legacy.close()
      mirrored.close()
    }
  })

  it('applies the new snapshot only to a SQLite backup of a populated library', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-tidal-library-copy-'))
    const original = new Database(':memory:')
    let copy: Database.Database | null = null
    try {
      initSchema(original, () => {})
      const sync = new TidalLibrarySync({
        api: { fetchLibraryPayload: async () => payload } as unknown as TidalApiService,
        dbContext: { db: original, rebuildSearchIndex: () => {} },
        artworkCache: { cacheRemoteArtwork: async () => null },
      })
      await sync.syncUserLibrary()
      const before = snapshot(original)
      const backupPath = path.join(tempRoot, 'populated-copy.db')
      await original.backup(backupPath)
      copy = new Database(backupPath)
      await mirrorProviderLibrary(copy, 'tidal', mapTidalLibraryRecords({ albums: [], tracks: [], playlists: [], playlistFolders: [] }), async () => null)

      expect(snapshot(original)).toEqual(before)
      expect((original.prepare(`SELECT count(*) AS count FROM tracks WHERE source = 'tidal'`).get() as { count: number }).count).toBe(1)
      expect((copy.prepare(`SELECT count(*) AS count FROM tracks WHERE source = 'tidal'`).get() as { count: number }).count).toBe(0)
      expect(copy.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
    } finally {
      copy?.close()
      original.close()
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
