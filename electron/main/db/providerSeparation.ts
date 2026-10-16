import type Database from 'better-sqlite3'
import { sourceEntityId } from '../../../src/services/catalog/sourceIdentity'

type Row = Record<string, string | number | null>
const kinds = ['artist', 'album', 'track'] as const
const plurals = { artist: 'artists', album: 'albums', track: 'tracks' } as const

/** v30 is atomic. Library rows and playlist positions are never recreated. */
export function migrateProviderSeparation(db: Database.Database): void {
  if ((db.pragma('user_version', { simple: true }) as number) >= 30) return
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS catalog_source_migration (
      entity_type TEXT NOT NULL, old_id TEXT NOT NULL, provider TEXT NOT NULL,
      source_id TEXT NOT NULL, new_id TEXT NOT NULL,
      PRIMARY KEY(entity_type, old_id, provider, source_id)
    ); CREATE TABLE IF NOT EXISTS provider_separation_report (
      kind TEXT NOT NULL, reference TEXT NOT NULL, message TEXT NOT NULL
    );`)
    const snapshots = new Map<string, Row[]>()
    const tables = ['catalog_artists', 'catalog_albums', 'catalog_tracks', 'catalog_artist_sources',
      'catalog_album_sources', 'catalog_track_sources', 'catalog_artist_bios', 'catalog_field_provenance',
      'catalog_artist_album_edges', 'catalog_artist_track_edges', 'catalog_album_track_edges', 'catalog_related_artists']
    for (const table of tables) snapshots.set(table, db.prepare(`SELECT * FROM ${table}`).all() as Row[])
    for (const kind of kinds) {
      const table = `catalog_${plurals[kind]}`
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (!columns.some(c => c.name === 'provider_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN provider_id TEXT`)
      if (!columns.some(c => c.name === 'source_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN source_id TEXT`)
    }
    const playlistColumns = db.prepare('PRAGMA table_info(playlists)').all() as { name: string }[]
    for (const [name, definition] of [['playback_provider_id', "TEXT NOT NULL DEFAULT 'local'"], ['management', "TEXT NOT NULL DEFAULT 'app'"], ['legacy_mixed', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!playlistColumns.some(c => c.name === name)) db.exec(`ALTER TABLE playlists ADD COLUMN ${name} ${definition}`)
    }
    const mapping = new Map<string, string[]>()
    const key = (kind: string, old: string, provider: string) => JSON.stringify([kind, old, provider])
    const unambiguousId = (kind: string, old: string, provider: string) => {
      const ids = mapping.get(key(kind, old, provider)) ?? []
      return ids.length === 1 ? ids[0] : null
    }
    const write = (table: string, row: Row) => {
      const columns = Object.keys(row)
      db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row))
    }
    for (const kind of kinds) {
      for (const source of snapshots.get(`catalog_${kind}_sources`)!) {
        const old = String(source[`catalog_${kind}_id`])
        const provider = String(source.provider)
        const newId = sourceEntityId({ providerId: provider, entityType: kind, sourceId: String(source.source_id) })
        const ids = mapping.get(key(kind, old, provider)) ?? []
        ids.push(newId)
        mapping.set(key(kind, old, provider), ids)
        db.prepare(`INSERT OR REPLACE INTO catalog_source_migration VALUES (?, ?, ?, ?, ?)`).run(kind, old, provider, source.source_id, newId)
      }
    }
    // Preferences and canonical metadata belonged to the old composite identity.
    for (const table of ['catalog_album_preferences', 'catalog_artist_preferences', ...tables.slice(6),
      'catalog_track_sources', 'catalog_album_sources', 'catalog_artist_sources', 'catalog_tracks', 'catalog_albums', 'catalog_artists']) {
      db.prepare(`DELETE FROM ${table}`).run()
    }
    for (const kind of kinds) {
      const table = `catalog_${plurals[kind]}`
      const oldRows = new Map(snapshots.get(table)!.map(row => [String(row.id), row]))
      for (const source of snapshots.get(`catalog_${kind}_sources`)!) {
        const oldId = String(source[`catalog_${kind}_id`])
        const provider = String(source.provider)
        const row: Row = { ...oldRows.get(oldId)!, id: sourceEntityId({ providerId: provider, entityType: kind, sourceId: String(source.source_id) }), provider_id: provider, source_id: source.source_id }
        if (!oldRows.has(oldId)) throw new Error(`Cannot migrate missing ${kind}: ${oldId}`)
        for (const field of ['primary_artist_id', 'album_id']) {
          if (row[field]) row[field] = unambiguousId(field === 'album_id' ? 'album' : 'artist', String(row[field]), provider)
        }
        const multipleSources = snapshots.get(`catalog_${kind}_sources`)!.filter(s => s[`catalog_${kind}_id`] === oldId).length > 1
        if (multipleSources) {
          // Mixed artwork, genres and canonical results cannot be attributed to a source.
          for (const field of ['artwork_url', 'artwork_id', 'genres_json']) if (field in row) (row as Row)[field] = null
        }
        for (const field of Object.keys(row)) if (field.startsWith('mb_') || field.startsWith('canonical_')) (row as Row)[field] = field === 'canonical_match_status' ? 'none' : ['canonical_match_confidence', 'canonical_locked'].includes(field) ? 0 : null
        const library = db.prepare(`SELECT * FROM ${plurals[kind]} WHERE source = ? AND COALESCE(source_id, id) = ?`).get(provider, source.source_id) as Row | undefined
        if (library) {
          if (kind === 'artist') (row as Row).name = library.name
          else (row as Row).title = library.title
          if (kind === 'artist') row.normalized_name = library.normalized_name
          else row.normalized_title = library.normalized_title
          ;(row as Row).genres_json = library.genres
          ;(row as Row).artwork_url = library.art_path ?? null
          ;(row as Row).artwork_id = library.artwork_id ?? null
          if (kind === 'track') for (const field of ['duration_ms', 'format', 'sample_rate', 'bit_depth', 'bitrate', 'channels', 'lossless']) (row as Row)[field] = library[field]
        } else if (multipleSources) {
          // A composite cache has no authoritative metadata for an online-only
          // source. Its next source-owned search/profile response fills this in.
          if (kind === 'artist') { row.name = 'Unknown Artist'; row.normalized_name = null }
          else { row.title = kind === 'album' ? 'Unknown Album' : 'Unavailable Track'; row.normalized_title = null }
          for (const field of ['primary_artist_name', 'album_title', 'year', 'upc', 'isrc', 'format', 'sample_rate', 'bit_depth', 'bitrate', 'channels', 'stream_info_fetched_at']) if (field in row) row[field] = null
          if (kind === 'track') row.duration_ms = 0
          db.prepare(`INSERT INTO provider_separation_report VALUES ('metadata_refresh', ?, 'Composite metadata discarded; refresh from the owning provider')`).run(String(row.id))
        }
        write(table, row)
        write(`catalog_${kind}_sources`, { ...source, [`catalog_${kind}_id`]: row.id })
      }
    }
    const relationColumns: Record<string, Record<string, string>> = {
      catalog_artist_album_edges: { catalog_artist_id: 'artist', catalog_album_id: 'album' },
      catalog_artist_track_edges: { catalog_artist_id: 'artist', catalog_track_id: 'track' },
      catalog_album_track_edges: { catalog_album_id: 'album', catalog_track_id: 'track' },
      catalog_related_artists: { catalog_artist_id: 'artist', related_catalog_artist_id: 'artist' },
    }
    for (const [table, refs] of Object.entries(relationColumns)) {
      for (const old of snapshots.get(table)!) {
        const row = { ...old }
        let valid = true
        for (const [column, kind] of Object.entries(refs)) {
          const id = unambiguousId(kind, String(old[column]), String(old.provider))
          if (!id) valid = false
          row[column] = id ?? null
        }
        if (valid) write(table, row)
        else db.prepare(`INSERT INTO provider_separation_report VALUES ('ambiguous_relationship', ?, 'Relationship will be rebuilt from its source')`).run(table)
      }
    }
    for (const old of snapshots.get('catalog_artist_bios')!) {
      const id = unambiguousId('artist', String(old.catalog_artist_id), String(old.provider))
      if (id) write('catalog_artist_bios', { ...old, catalog_artist_id: id })
    }
    for (const old of snapshots.get('catalog_field_provenance')!) {
      const id = unambiguousId(String(old.entity_type), String(old.catalog_id), String(old.source))
      if (id) write('catalog_field_provenance', { ...old, catalog_id: id })
    }
    // Settings include pins, recents and saved queues. Keep ambiguous references
    // intact and record them; a user must choose a source instead of us guessing.
    const remap = (value: unknown, provider?: string, sourceId?: string): unknown => {
      if (typeof value === 'string' && value.startsWith('catalog:')) {
        const candidates = db.prepare(`SELECT new_id FROM catalog_source_migration WHERE old_id = ? AND (? IS NULL OR provider = ?) AND (? IS NULL OR source_id = ?)`).all(value, provider ?? null, provider ?? null, sourceId ?? null, sourceId ?? null) as { new_id: string }[]
        if (candidates.length === 1) return candidates[0].new_id
        if (candidates.length > 1) db.prepare(`INSERT INTO provider_separation_report VALUES ('ambiguous_reference', ?, 'Choose a provider for this legacy item')`).run(value)
        return value
      }
      if (Array.isArray(value)) return value.map(v => remap(v, provider, sourceId))
      if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>
        const hint = [object.provider, object.sourceType, object.source, object.providerId].find(v => typeof v === 'string') as string | undefined
        const sourceHint = typeof object.sourceId === 'string' ? object.sourceId : sourceId
        return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, remap(v, hint ?? provider, sourceHint)]))
      }
      return value
    }
    for (const setting of db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]) {
      try { db.prepare(`UPDATE settings SET value = ? WHERE key = ?`).run(JSON.stringify(remap(JSON.parse(setting.value))), setting.key) } catch { /* scalar setting */ }
    }
    for (const playlist of db.prepare(`SELECT id, source, read_only FROM playlists`).all() as { id: number; source: string; read_only: number }[]) {
      const sources = db.prepare(`SELECT DISTINCT t.source FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ?`).all(playlist.id) as { source: string }[]
      const providers = [...new Set(sources.map(s => s.source === 'm3u' ? 'local' : s.source))]
      const provider = providers.length === 1 ? providers[0] : playlist.source === 'm3u' ? 'local' : playlist.source
      const mixed = providers.length > 1
      db.prepare(`UPDATE playlists SET playback_provider_id = ?, management = ?, legacy_mixed = ? WHERE id = ?`).run(mixed ? 'mixed' : provider, playlist.read_only && !['local', 'm3u'].includes(playlist.source) ? 'provider' : 'app', mixed ? 1 : 0, playlist.id)
      if (mixed) db.prepare(`INSERT INTO provider_separation_report VALUES ('mixed_playlist', ?, 'Preserved as an archived mixed playlist')`).run(String(playlist.id))
    }
    for (const kind of kinds) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_${kind}_owner ON catalog_${plurals[kind]}(provider_id, source_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_${kind}_source_identity ON catalog_${kind}_sources(provider, source_id);`)
    }
    if (mapping.size) db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('catalog:needsSourceRebuild', 'true')`).run()
    db.pragma('user_version = 30')
  })()
}

/** Guard ownership even for writes outside the catalog service. */
export function ensureProviderBoundaries(db: Database.Database): void {
  for (const kind of kinds) {
    const entityTable = `catalog_${plurals[kind]}`
    for (const operation of ['INSERT', 'UPDATE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS guard_${kind}_source_${operation.toLowerCase()}
        BEFORE ${operation} ON catalog_${kind}_sources
        WHEN EXISTS (SELECT 1 FROM ${entityTable} e WHERE e.id = NEW.catalog_${kind}_id
          AND e.provider_id IS NOT NULL AND (e.provider_id <> NEW.provider OR e.source_id <> NEW.source_id))
        BEGIN SELECT RAISE(ABORT, 'Catalog source belongs to another provider'); END;`)
    }
  }
  const relations = [
    ['catalog_artist_album_edges', 'catalog_artist_id', 'catalog_artists', 'catalog_album_id', 'catalog_albums'],
    ['catalog_artist_track_edges', 'catalog_artist_id', 'catalog_artists', 'catalog_track_id', 'catalog_tracks'],
    ['catalog_album_track_edges', 'catalog_album_id', 'catalog_albums', 'catalog_track_id', 'catalog_tracks'],
    ['catalog_related_artists', 'catalog_artist_id', 'catalog_artists', 'related_catalog_artist_id', 'catalog_artists'],
  ]
  for (const [table, leftId, leftTable, rightId, rightTable] of relations) {
    for (const operation of ['INSERT', 'UPDATE']) db.exec(`CREATE TRIGGER IF NOT EXISTS guard_${table}_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table}
      WHEN EXISTS (SELECT 1 FROM ${leftTable} l, ${rightTable} r WHERE l.id = NEW.${leftId} AND r.id = NEW.${rightId}
        AND (l.provider_id <> r.provider_id OR l.provider_id <> NEW.provider OR r.provider_id <> NEW.provider))
      BEGIN SELECT RAISE(ABORT, 'Catalog relationship crosses providers'); END;`)
  }
  for (const operation of ['INSERT', 'UPDATE']) db.exec(`CREATE TRIGGER IF NOT EXISTS guard_playlist_track_${operation.toLowerCase()}
    BEFORE ${operation} ON playlist_tracks
    WHEN EXISTS (SELECT 1 FROM playlists p, tracks t WHERE p.id = NEW.playlist_id AND t.id = NEW.track_id
      AND p.legacy_mixed = 0 AND p.playback_provider_id <> t.source)
    BEGIN SELECT RAISE(ABORT, 'Playlist and track must use the same provider'); END;`)
}
