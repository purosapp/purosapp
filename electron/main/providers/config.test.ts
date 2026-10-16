import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ userData: '', encryptionAvailable: true, packaged: false }))
vi.mock('electron', () => ({
  app: { getPath: () => electronState.userData, get isPackaged() { return electronState.packaged } },
  safeStorage: {
    isEncryptionAvailable: () => electronState.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))

import { initSchema } from '../db/schema'
import { listRetainedProviderData, removeProviderData } from './config'
import { migrateLegacyProviderState } from './migrations'
import { TidalSecureStore } from '../../../tests/fixtures/TidalSecureStoreLegacy'

const databases: Database.Database[] = []
const temporaryRoots: string[] = []

beforeEach(() => {
  electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-provider-config-'))
  electronState.encryptionAvailable = true
  electronState.packaged = false
  temporaryRoots.push(electronState.userData)
})

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('provider data removal', () => {
  it('removes only the selected provider data and preserves shared catalog identities', () => {
    const db = new Database(':memory:')
    databases.push(db)
    initSchema(db, () => {})
    const cacheRoot = path.join(electronState.userData, 'cache', 'streaming-audio', 'target-provider')
    const cacheFile = path.join(cacheRoot, 'track.flac')
    fs.mkdirSync(cacheRoot, { recursive: true })
    fs.writeFileSync(cacheFile, 'fixture')

    db.exec(`
      INSERT INTO artists (id, name, source, source_id) VALUES
        ('target-artist', 'Target Artist', 'target-provider', 'artist-source'),
        ('other-artist', 'Other Artist', 'other-provider', 'other-artist-source');
      INSERT INTO albums (id, title, source, source_id) VALUES
        ('target-album', 'Target Album', 'target-provider', 'album-source'),
        ('other-album', 'Other Album', 'other-provider', 'other-album-source');
      INSERT INTO tracks (id, file_path, title, source, source_id) VALUES
        ('target-track', 'provider://target-provider/track-source', 'Target Track', 'target-provider', 'track-source'),
        ('other-track', 'provider://other-provider/other-track-source', 'Other Track', 'other-provider', 'other-track-source');
      INSERT INTO playlists (id, name, source, source_id) VALUES
        (10, 'Target Playlist', 'target-provider', 'playlist-source'),
        (20, 'Other Playlist', 'other-provider', 'other-playlist-source');
      INSERT INTO catalog_artists (id, name, normalized_name) VALUES ('catalog-artist', 'Artist', 'artist');
      INSERT INTO catalog_albums (id, title, normalized_title) VALUES ('catalog-album', 'Album', 'album');
      INSERT INTO catalog_tracks (id, title, normalized_title, duration_ms) VALUES ('catalog-track', 'Track', 'track', 1000);
      INSERT INTO catalog_artist_sources (catalog_artist_id, provider, source_id) VALUES
        ('catalog-artist', 'target-provider', 'artist-source'), ('catalog-artist', 'other-provider', 'other-artist-source');
      INSERT INTO catalog_album_sources (catalog_album_id, provider, source_id) VALUES
        ('catalog-album', 'target-provider', 'album-source'), ('catalog-album', 'other-provider', 'other-album-source');
      INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id) VALUES
        ('catalog-track', 'target-provider', 'track-source'), ('catalog-track', 'other-provider', 'other-track-source');
      INSERT INTO provider_kv (provider, key, value) VALUES ('target-provider', 'state', 'true'), ('other-provider', 'state', 'true');
      INSERT INTO provider_secrets (provider, key, ciphertext) VALUES
        ('target-provider', 'token', X'01'), ('other-provider', 'token', X'02');
      INSERT INTO settings (key, value) VALUES
        ('provider.target-provider.enabled', 'true'), ('target-provider:legacySession', 'secret'),
        ('provider.other-provider.enabled', 'true'), ('other-provider:legacySession', 'secret');
    `)
    db.prepare(`INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path) VALUES (?, ?, ?, ?)`)
      .run('target-provider', 'track-source', 'lossless', cacheFile)

    expect(listRetainedProviderData(db).map((entry) => entry.providerId)).toEqual(['other-provider', 'target-provider'])
    expect(listRetainedProviderData(db).find((entry) => entry.providerId === 'target-provider')).toEqual({
      providerId: 'target-provider', tracks: 1, albums: 1, artists: 1, playlists: 1, catalogLinks: 3, cacheEntries: 1, privateEntries: 4,
    })
    const removed = removeProviderData(db, 'target-provider')

    expect(removed).toMatchObject({ tracks: 1, albums: 1, artists: 1, playlists: 1, cacheEntries: 1 })
    expect(db.prepare(`SELECT 1 FROM tracks WHERE source = 'target-provider'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM tracks WHERE source = 'other-provider'`).get()).toBeDefined()
    expect(db.prepare(`SELECT 1 FROM catalog_tracks WHERE id = 'catalog-track'`).get()).toBeDefined()
    expect(db.prepare(`SELECT 1 FROM catalog_track_sources WHERE provider = 'other-provider'`).get()).toBeDefined()
    expect(db.prepare(`SELECT 1 FROM provider_kv WHERE provider = 'target-provider'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM provider_kv WHERE provider = 'other-provider'`).get()).toBeDefined()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'provider.target-provider.enabled'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'target-provider:legacySession'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'provider.other-provider.enabled'`).get()).toBeDefined()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'other-provider:legacySession'`).get()).toBeDefined()
    expect(fs.existsSync(cacheFile)).toBe(false)
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
    expect(listRetainedProviderData(db).map((entry) => entry.providerId)).toEqual(['other-provider'])
  })

  it('never lists or removes core sources, even under a provider-shaped ID', () => {
    const db = new Database(':memory:')
    databases.push(db)
    initSchema(db, () => {})
    db.exec(`
      INSERT INTO playlists (id, name, source, source_id) VALUES (1, 'Imported', 'm3u', '/music/list.m3u'), (2, 'Mine', 'local', NULL);
      INSERT INTO settings (key, value) VALUES ('lastfm:config', '{}');
      INSERT INTO provider_kv (provider, key, value) VALUES ('legacy-provider', '_migration.legacySettings.v1', '{"complete":true}');
    `)
    expect(listRetainedProviderData(db)).toEqual([])
    expect(() => removeProviderData(db, 'm3u')).toThrow('not a provider ID')
    expect(() => removeProviderData(db, 'local')).toThrow('not a provider ID')
    expect(db.prepare(`SELECT COUNT(*) AS count FROM playlists`).get()).toEqual({ count: 2 })
  })
})

describe('legacy provider state migration', () => {
  it('moves Tidal session and sync checkpoint to provider-owned rows without deleting Apple legacy state', async () => {
    const db = new Database(':memory:')
    databases.push(db)
    initSchema(db, () => {})
    const session = {
      accessToken: 'access', refreshToken: 'refresh', expiresAt: 123,
      tokenType: 'Bearer', scopes: ['r_usr'], countryCode: 'US',
    }
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?)`)
      .run('tidal:session', Buffer.from(JSON.stringify(session)).toString('base64'), 'tidal:lastSyncAt', '456', 'apple:lastSyncAt', '789')

    migrateLegacyProviderState(db)
    migrateLegacyProviderState(db)

    const store = new TidalSecureStore(db)
    expect(await store.load()).toEqual(session)
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'tidal:session'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'tidal:lastSyncAt'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'apple:lastSyncAt'`).get()).toBeDefined()
    expect((db.prepare(`SELECT value FROM provider_kv WHERE provider = 'tidal' AND key = 'lastSyncAt'`).get() as { value: string }).value).toBe('456')

    const updated = { ...session, accessToken: 'refreshed' }
    await store.save(updated)
    expect(await new TidalSecureStore(db).load()).toEqual(updated)
    await store.clear()
    expect(await new TidalSecureStore(db).load()).toBeNull()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'apple:lastSyncAt'`).get()).toBeDefined()
  })

  it('keeps development-only unencrypted sessions in memory', async () => {
    const db = new Database(':memory:')
    databases.push(db)
    initSchema(db, () => {})
    electronState.encryptionAvailable = false
    const session = {
      accessToken: 'access', refreshToken: 'refresh', expiresAt: 123,
      tokenType: 'Bearer', scopes: ['r_usr'], countryCode: 'US',
    }
    const store = new TidalSecureStore(db)
    await store.save(session)
    expect(await store.load()).toEqual(session)
    expect(db.prepare(`SELECT 1 FROM provider_secrets WHERE provider = 'tidal'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'tidal:session'`).get()).toBeUndefined()
  })

  it('copies legacy values into provider-owned stores without breaking thin adapters', () => {
    const db = new Database(':memory:')
    databases.push(db)
    initSchema(db, () => {})
    const session = JSON.stringify({ accessToken: 'access', refreshToken: 'refresh' })
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?)`)
      .run(
        'tidal:session', Buffer.from(session).toString('base64'),
        'tidal:lastSyncAt', '123',
        'apple:webPlayerToken', 'web-token',
        'apple:lastSyncAt', '456',
      )

    migrateLegacyProviderState(db, { retainLegacy: true })
    migrateLegacyProviderState(db, { retainLegacy: true })

    const tidalSecret = db.prepare(`SELECT ciphertext FROM provider_secrets WHERE provider = 'tidal' AND key = 'session'`)
      .get() as { ciphertext: Buffer }
    expect(tidalSecret.ciphertext.toString()).toBe(session)
    const appleSecret = db.prepare(`SELECT ciphertext FROM provider_secrets WHERE provider = 'apple' AND key = 'webPlayerToken'`)
      .get() as { ciphertext: Buffer }
    expect(appleSecret.ciphertext.toString()).toBe('web-token')
    expect((db.prepare(`SELECT value FROM provider_kv WHERE provider = 'tidal' AND key = 'lastSyncAt'`).get() as { value: string }).value)
      .toBe('123')
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'tidal:session'`).get()).toBeDefined()
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'apple:webPlayerToken'`).get()).toBeDefined()
    expect(JSON.parse((db.prepare(`SELECT value FROM provider_kv WHERE provider = 'tidal' AND key = '_migration.legacySettings.v1'`).get() as { value: string }).value))
      .toEqual({ complete: true, retainedForLegacyAdapter: true })
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
  })

  it('marks secure migration pending without deleting the legacy value', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = new Database(':memory:')
    databases.push(db)
    initSchema(db, () => {})
    electronState.encryptionAvailable = false
    db.prepare(`INSERT INTO settings (key, value) VALUES ('apple:webPlayerToken', 'web-token')`).run()

    migrateLegacyProviderState(db, { retainLegacy: true })

    expect(db.prepare(`SELECT 1 FROM provider_secrets WHERE provider = 'apple'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'apple:webPlayerToken'`).get()).toBeDefined()
    expect(JSON.parse((db.prepare(`SELECT value FROM provider_kv WHERE provider = 'apple' AND key = '_migration.legacySettings.v1'`).get() as { value: string }).value))
      .toEqual({ complete: false, retainedForLegacyAdapter: true })
    expect(warning).toHaveBeenCalledOnce()
    warning.mockRestore()
  })
})
