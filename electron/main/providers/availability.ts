import type Database from 'better-sqlite3'
import type { ProviderRegistry } from './registry'

const SOURCE_TABLES = [
  'catalog_artist_sources',
  'catalog_album_sources',
  'catalog_track_sources',
] as const

export function reconcileProviderAvailability(db: Database.Database, registry: ProviderRegistry): void {
  const available = registry.list()
    .filter(({ manifest, status }) => (
      (status.state === 'ready' || status.state === 'degraded')
      && status.authenticated !== false
      && manifest.capabilities.some((capability) => capability.startsWith('catalog.') || capability === 'playback.resolve')
    ))
    .map(({ manifest }) => manifest.id)

  db.transaction(() => {
    for (const table of SOURCE_TABLES) {
      db.prepare(`UPDATE ${table} SET available = CASE WHEN provider = 'local' THEN 1 ELSE 0 END`).run()
      const markAvailable = db.prepare(`UPDATE ${table} SET available = 1 WHERE provider = ?`)
      for (const providerId of available) markAvailable.run(providerId)
    }
  })()
}
