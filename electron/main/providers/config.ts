import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { isValidProviderId, RESERVED_PROVIDER_IDS, type ProviderManifestV1, type ProviderPrimitiveV1 } from '../../../src/provider-api/v1'
import { getSettingForIpc, setSettingValue, deleteSettingValue } from '../settings/store'
import { isPathInsideRoot } from '../security/pathPolicy'
import { getStreamingAudioCacheDir } from '../streamingCache'

function settingKey(providerId: string, key: string): string {
  return `provider.${providerId}.${key}`
}

function settingControl(manifest: ProviderManifestV1, key: string) {
  return manifest.settings?.find((control) => 'key' in control && control.key === key)
}

function assertSecret(manifest: ProviderManifestV1, key: string): void {
  if (!(manifest.permissions?.secrets ?? []).includes(key)) {
    throw new Error(`Provider ${manifest.id} did not declare secret ${key}`)
  }
  const control = settingControl(manifest, key)
  if (!control || !('storage' in control) || control.storage !== 'secret') {
    throw new Error(`Provider ${manifest.id} does not expose secret ${key} as a setting`)
  }
}

export function getProviderSetting(manifest: ProviderManifestV1, key: string): ProviderPrimitiveV1 | undefined {
  const control = settingControl(manifest, key)
  if (!control || !('storage' in control) || control.storage !== 'setting') {
    throw new Error(`Provider ${manifest.id} did not declare setting ${key}`)
  }
  const raw = getSettingForIpc(settingKey(manifest.id, key))
  if (raw === null) {
    if (control.type === 'select' || control.type === 'toggle') return control.defaultValue
    return undefined
  }
  const parsed = JSON.parse(raw) as unknown
  if (parsed === null || typeof parsed === 'string' || typeof parsed === 'boolean' || (typeof parsed === 'number' && Number.isFinite(parsed))) {
    return parsed
  }
  throw new Error(`Stored provider setting ${key} is invalid`)
}

export function setProviderSetting(manifest: ProviderManifestV1, key: string, value: ProviderPrimitiveV1): void {
  const control = settingControl(manifest, key)
  if (!control || !('storage' in control) || control.storage !== 'setting') {
    throw new Error(`Provider ${manifest.id} did not declare setting ${key}`)
  }
  if (control.type === 'toggle' && typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  if (control.type === 'select' && (typeof value !== 'string' || !control.options.some((option) => option.value === value))) {
    throw new TypeError(`${key} must be one of the declared options`)
  }
  if (control.type === 'text' && typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${key} must be finite`)
  setSettingValue(settingKey(manifest.id, key), JSON.stringify(value))
}

export function deleteProviderSetting(manifest: ProviderManifestV1, key: string): void {
  const control = settingControl(manifest, key)
  if (!control || !('storage' in control) || control.storage !== 'setting') {
    throw new Error(`Provider ${manifest.id} did not declare setting ${key}`)
  }
  deleteSettingValue(settingKey(manifest.id, key))
}

export function hasProviderSecret(db: Database.Database, manifest: ProviderManifestV1, key: string): boolean {
  assertSecret(manifest, key)
  return !!db.prepare(`SELECT 1 FROM provider_secrets WHERE provider = ? AND key = ?`).get(manifest.id, key)
}

export function setProviderSecret(db: Database.Database, manifest: ProviderManifestV1, key: string, value: string): void {
  assertSecret(manifest, key)
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure provider secret storage is unavailable')
  const ciphertext = safeStorage.encryptString(value)
  db.prepare(`
    INSERT INTO provider_secrets (provider, key, ciphertext, encryption_version, updated_at)
    VALUES (?, ?, ?, 1, strftime('%s', 'now'))
    ON CONFLICT(provider, key) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      encryption_version = excluded.encryption_version,
      updated_at = excluded.updated_at
  `).run(manifest.id, key, ciphertext)
}

export function deleteProviderSecret(db: Database.Database, manifest: ProviderManifestV1, key: string): void {
  assertSecret(manifest, key)
  db.prepare(`DELETE FROM provider_secrets WHERE provider = ? AND key = ?`).run(manifest.id, key)
}

export interface ProviderDataRemovalResult {
  providerId: string
  tracks: number
  albums: number
  artists: number
  playlists: number
  cacheEntries: number
}

/** Core-owned `source` values; they are never provider data. */
const CORE_SOURCES = new Set<string>(RESERVED_PROVIDER_IDS)

export interface RetainedProviderData {
  providerId: string
  tracks: number
  albums: number
  artists: number
  playlists: number
  catalogLinks: number
  cacheEntries: number
  /** Provider-private rows: storage, encrypted secrets, and settings. */
  privateEntries: number
}

/**
 * Providers that still have data in this profile, found only through
 * provider-scoped columns and `provider.<id>.*` settings. Core sources are excluded.
 */
export function listRetainedProviderData(db: Database.Database): RetainedProviderData[] {
  const ids = new Set<string>()
  const collect = (sql: string) => {
    for (const row of db.prepare(sql).all() as Array<{ id: string | null }>) if (row.id) ids.add(row.id)
  }
  for (const table of ['tracks', 'albums', 'artists', 'playlists', 'playlist_folders']) collect(`SELECT DISTINCT source AS id FROM ${table}`)
  for (const table of ['catalog_track_sources', 'catalog_album_sources', 'catalog_artist_sources', 'streaming_audio_cache', 'provider_secrets']) {
    collect(`SELECT DISTINCT provider AS id FROM ${table}`)
  }
  // Core's legacy-migration sentinels live in provider_kv but are not provider data.
  collect(`SELECT DISTINCT provider AS id FROM provider_kv WHERE key NOT LIKE '\\_migration.%' ESCAPE '\\'`)
  collect(`SELECT DISTINCT substr(key, 10, instr(substr(key, 10), '.') - 1) AS id FROM settings WHERE key LIKE 'provider.%.%'`)
  const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { count: number }).count
  return [...ids]
    .filter((id) => isValidProviderId(id) && !CORE_SOURCES.has(id))
    .sort()
    .map((providerId) => ({
      providerId,
      tracks: count(`SELECT COUNT(*) AS count FROM tracks WHERE source = ?`, providerId),
      albums: count(`SELECT COUNT(*) AS count FROM albums WHERE source = ?`, providerId),
      artists: count(`SELECT COUNT(*) AS count FROM artists WHERE source = ?`, providerId),
      playlists: count(`SELECT COUNT(*) AS count FROM playlists WHERE source = ?`, providerId),
      catalogLinks: count(`SELECT (SELECT COUNT(*) FROM catalog_track_sources WHERE provider = ?) + (SELECT COUNT(*) FROM catalog_album_sources WHERE provider = ?)
        + (SELECT COUNT(*) FROM catalog_artist_sources WHERE provider = ?) AS count`, providerId, providerId, providerId),
      cacheEntries: count(`SELECT COUNT(*) AS count FROM streaming_audio_cache WHERE provider = ?`, providerId),
      privateEntries: count(`SELECT (SELECT COUNT(*) FROM provider_kv WHERE provider = ? AND key NOT LIKE '\\_migration.%' ESCAPE '\\') + (SELECT COUNT(*) FROM provider_secrets WHERE provider = ?)
        + (SELECT COUNT(*) FROM settings WHERE key LIKE ? ESCAPE '\\' OR key LIKE ?) AS count`, providerId, providerId, `provider.${providerId}.%`, `${providerId}:%`),
    }))
    .filter((entry) => entry.tracks + entry.albums + entry.artists + entry.playlists + entry.catalogLinks + entry.cacheEntries + entry.privateEntries > 0)
}

export function removeProviderData(db: Database.Database, providerId: string): ProviderDataRemovalResult {
  if (!isValidProviderId(providerId) || CORE_SOURCES.has(providerId)) throw new Error(`Refusing to remove data for ${providerId}: not a provider ID`)
  const cacheRows = db.prepare(`SELECT file_path FROM streaming_audio_cache WHERE provider = ?`).all(providerId) as Array<{ file_path: string }>
  const counts = {
    providerId,
    tracks: (db.prepare(`SELECT COUNT(*) AS count FROM tracks WHERE source = ?`).get(providerId) as { count: number }).count,
    albums: (db.prepare(`SELECT COUNT(*) AS count FROM albums WHERE source = ?`).get(providerId) as { count: number }).count,
    artists: (db.prepare(`SELECT COUNT(*) AS count FROM artists WHERE source = ?`).get(providerId) as { count: number }).count,
    playlists: (db.prepare(`SELECT COUNT(*) AS count FROM playlists WHERE source = ?`).get(providerId) as { count: number }).count,
    cacheEntries: cacheRows.length,
  }

  db.transaction(() => {
    db.prepare(`UPDATE catalog_album_preferences SET preferred_provider = NULL, preferred_source_id = NULL WHERE preferred_provider = ?`).run(providerId)
    db.prepare(`UPDATE catalog_artist_preferences SET preferred_provider = NULL, preferred_source_id = NULL WHERE preferred_provider = ?`).run(providerId)
    db.prepare(`DELETE FROM catalog_related_artists WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM catalog_artist_track_edges WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM catalog_album_track_edges WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM catalog_artist_album_edges WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM catalog_artist_bios WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM catalog_track_sources WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM catalog_album_sources WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM catalog_artist_sources WHERE provider = ?`).run(providerId)

    db.prepare(`DELETE FROM playlists WHERE source = ?`).run(providerId)
    db.prepare(`DELETE FROM playlist_folders WHERE source = ?`).run(providerId)
    db.prepare(`DELETE FROM tracks WHERE source = ?`).run(providerId)
    db.prepare(`DELETE FROM albums WHERE source = ? AND NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id)`).run(providerId)
    db.prepare(`DELETE FROM artists WHERE source = ?
      AND NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.artist_id = artists.id)
      AND NOT EXISTS (SELECT 1 FROM albums WHERE albums.album_artist_id = artists.id)
      AND NOT EXISTS (SELECT 1 FROM track_artists WHERE track_artists.artist_id = artists.id)
    `).run(providerId)

    db.exec(`DELETE FROM catalog_tracks WHERE NOT EXISTS (SELECT 1 FROM catalog_track_sources WHERE catalog_track_id = catalog_tracks.id)`)
    db.exec(`DELETE FROM catalog_albums WHERE NOT EXISTS (SELECT 1 FROM catalog_album_sources WHERE catalog_album_id = catalog_albums.id)
      AND NOT EXISTS (SELECT 1 FROM catalog_tracks WHERE album_id = catalog_albums.id)`)
    db.exec(`DELETE FROM catalog_artists WHERE NOT EXISTS (SELECT 1 FROM catalog_artist_sources WHERE catalog_artist_id = catalog_artists.id)
      AND NOT EXISTS (SELECT 1 FROM catalog_albums WHERE primary_artist_id = catalog_artists.id)
      AND NOT EXISTS (SELECT 1 FROM catalog_tracks WHERE primary_artist_id = catalog_artists.id)`)

    db.prepare(`DELETE FROM streaming_audio_cache WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM provider_kv WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM provider_secrets WHERE provider = ?`).run(providerId)
    db.prepare(`DELETE FROM settings WHERE key LIKE ?`).run(`${providerId}:%`)
    db.prepare(`DELETE FROM settings WHERE key LIKE ? ESCAPE '\\'`).run(`provider.${providerId}.%`)
  })()

  const cacheRoot = path.resolve(getStreamingAudioCacheDir(providerId))
  const dataRoot = path.resolve(app.getPath('userData'), 'providers', providerId)
  for (const row of cacheRows) {
    const candidate = path.resolve(row.file_path)
    if (!isPathInsideRoot(candidate, cacheRoot)) continue
    try { fs.unlinkSync(candidate) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[Puros][Provider:${providerId}] Failed to remove cache file:`, error)
    }
  }
  for (const root of [cacheRoot, dataRoot]) {
    const providerParent = path.dirname(root)
    if (!isPathInsideRoot(root, providerParent) || path.basename(root) !== providerId) continue
    fs.rmSync(root, { recursive: true, force: true })
  }

  return counts
}
