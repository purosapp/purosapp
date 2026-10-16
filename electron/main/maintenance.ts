import { app, session } from 'electron'
import path from 'node:path'
import {
  artCacheDir,
  clearArtworkMemoryCache,
} from './artwork/cache'
import {
  clearAutoEQMemoryCache,
  getAutoEQCachePath,
} from './audio/autoeq'
import {
  clearLegacyPurosDatabases,
  closeCurrentDatabase,
  getCurrentDatabasePath,
  getDb,
  removeSqliteDatabaseWithWal,
} from './db'
import { removePathIfExists } from './streamingCache'

type MaintenanceCallback = () => void | Promise<void>

const resetCallbacks: MaintenanceCallback[] = []
const shutdownCallbacks: MaintenanceCallback[] = []

export function registerReset(callbacks: MaintenanceCallback | MaintenanceCallback[]): void {
  resetCallbacks.push(...(Array.isArray(callbacks) ? callbacks : [callbacks]))
}

export function registerShutdown(callbacks: MaintenanceCallback | MaintenanceCallback[]): void {
  shutdownCallbacks.push(...(Array.isArray(callbacks) ? callbacks : [callbacks]))
}

export function clearAppCaches() {
  clearArtworkMemoryCache()
  clearAutoEQMemoryCache()

  const db = getDb()
  db.transaction(() => {
    db.exec(`
      DELETE FROM catalog_field_provenance;
      DELETE FROM catalog_artist_bios;
      DELETE FROM discord_artwork_uploads;
      UPDATE albums SET artwork_id = NULL, art_source = 'none';
      UPDATE playlists SET artwork_id = NULL;
      UPDATE artists SET artwork_id = NULL, art_source = 'none';
      UPDATE catalog_artists SET artwork_id = NULL;
      UPDATE catalog_albums SET artwork_id = NULL;
      UPDATE catalog_tracks SET artwork_id = NULL;
      DELETE FROM artwork_cache;
    `)
  })()

  removePathIfExists(artCacheDir())
  removePathIfExists(getAutoEQCachePath())
  getDb().prepare(`DELETE FROM streaming_audio_cache`).run()
  removePathIfExists(path.join(app.getPath('userData'), 'cache', 'streaming-audio'))
}

async function clearDefaultAppSessionData() {
  const defaultSession = session.defaultSession
  await defaultSession.clearStorageData().catch(() => {})
  await defaultSession.clearCache().catch(() => {})
  try {
    defaultSession.flushStorageData()
  } catch {
    // Best-effort cleanup only.
  }
}

export async function resetAppData() {
  for (const callback of resetCallbacks) await callback()
  for (const callback of shutdownCallbacks) await callback()

  const dbPath = getCurrentDatabasePath()
  closeCurrentDatabase()

  removeSqliteDatabaseWithWal(dbPath)
  clearLegacyPurosDatabases(dbPath)
  removePathIfExists(artCacheDir())
  removePathIfExists(getAutoEQCachePath())
  removePathIfExists(path.join(app.getPath('userData'), 'cache'))
  await clearDefaultAppSessionData()

  getDb()
}
