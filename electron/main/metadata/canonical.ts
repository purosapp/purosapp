import type Database from "better-sqlite3"
import {
  MusicBrainzSpineClient,
  type CanonicalMatchStatus,
  type CatalogEntityType,
  type MetadataSource,
} from "../../../src/services/catalog"
import { waitForPlaybackIdle } from "../playbackCoordinator"
import { getMetadataMusicBrainzEnabled } from "../settings/store"

const metadataTaskMap = new Map<string, Promise<void>>()
export const musicBrainzSpineClient = new MusicBrainzSpineClient({ userAgent: "Puros/1.0 (metadata spine)" })

function metadataEntityTable(entityType: CatalogEntityType) {
  if (entityType === 'artist') return 'catalog_artists'
  if (entityType === 'album') return 'catalog_albums'
  return 'catalog_tracks'
}

function canonicalIdColumns(entityType: CatalogEntityType) {
  if (entityType === 'artist') return ['mb_artist_id']
  if (entityType === 'album') return ['mb_release_group_id', 'mb_release_id']
  return ['mb_recording_id', 'mb_release_id']
}

export function enqueueMetadataTask(taskKey: string, taskFactory: () => Promise<void>) {
  const existing = metadataTaskMap.get(taskKey)
  if (existing) return existing
  const task = (async () => {
    await waitForPlaybackIdle()
    await taskFactory()
  })().finally(() => {
    metadataTaskMap.delete(taskKey)
  })
  metadataTaskMap.set(taskKey, task)
  return task
}

export function upsertCatalogFieldProvenance(
  db: Database.Database,
  entityType: CatalogEntityType,
  catalogId: string,
  fieldName: string,
  source: MetadataSource,
  payload: {
    sourceId?: string | null
    canonicalId?: string | null
    value?: string | null
    confidence?: number | null
    fetchedAt?: number | null
    expiresAt?: number | null
  } = {},
) {
  db.prepare(`
    INSERT INTO catalog_field_provenance (
      entity_type, catalog_id, field_name, source, source_id, canonical_id, value, confidence, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_type, catalog_id, field_name) DO UPDATE SET
      source = excluded.source,
      source_id = COALESCE(excluded.source_id, catalog_field_provenance.source_id),
      canonical_id = COALESCE(excluded.canonical_id, catalog_field_provenance.canonical_id),
      value = COALESCE(excluded.value, catalog_field_provenance.value),
      confidence = COALESCE(excluded.confidence, catalog_field_provenance.confidence),
      fetched_at = COALESCE(excluded.fetched_at, catalog_field_provenance.fetched_at),
      expires_at = COALESCE(excluded.expires_at, catalog_field_provenance.expires_at)
  `).run(
    entityType,
    catalogId,
    fieldName,
    source,
    payload.sourceId ?? null,
    payload.canonicalId ?? null,
    payload.value ?? null,
    payload.confidence ?? null,
    payload.fetchedAt ?? null,
    payload.expiresAt ?? null,
  )
}

export function clearCatalogCanonicalMatch(db: Database.Database, entityType: CatalogEntityType, catalogId: string) {
  const table = metadataEntityTable(entityType)
  const columns = canonicalIdColumns(entityType)
  const clearAssignments = columns.map((column) => `${column} = NULL`).join(', ')
  db.prepare(`
    UPDATE ${table}
    SET ${clearAssignments},
        canonical_match_status = 'none',
        canonical_match_confidence = 0,
        canonical_match_source = NULL,
        canonical_fetched_at = NULL,
        canonical_locked = 0
    WHERE id = ?
  `).run(catalogId)
  db.prepare(`
    DELETE FROM catalog_field_provenance
    WHERE entity_type = ? AND catalog_id = ? AND field_name = 'canonical_identity'
  `).run(entityType, catalogId)
}

export function setCatalogCanonicalLock(
  db: Database.Database,
  entityType: CatalogEntityType,
  catalogId: string,
  locked: boolean,
) {
  db.prepare(`
    UPDATE ${metadataEntityTable(entityType)}
    SET canonical_locked = ?,
        canonical_match_status = CASE
          WHEN ? = 1 AND canonical_match_status IN ('matched_low', 'matched_high', 'candidate') THEN 'locked'
          WHEN ? = 0 AND canonical_match_status = 'locked' THEN 'matched_low'
          ELSE canonical_match_status
        END
    WHERE id = ?
  `).run(locked ? 1 : 0, locked ? 1 : 0, locked ? 0 : 1, catalogId)
}

export function normalizeCanonicalStatus(
  status: string | null | undefined,
): CanonicalMatchStatus {
  if (status === 'candidate' || status === 'matched_low' || status === 'matched_high' || status === 'locked') {
    return status
  }
  return 'none'
}

function applyArtistCanonicalMatch(
  db: Database.Database,
  catalogArtistId: string,
  match: {
    status: CanonicalMatchStatus
    confidence: number
    artistId: string | null
  },
) {
  const fetchedAt = Math.floor(Date.now() / 1000)
  db.prepare(`
    UPDATE catalog_artists
    SET mb_artist_id = ?,
        canonical_match_status = ?,
        canonical_match_confidence = ?,
        canonical_match_source = 'musicbrainz',
        canonical_fetched_at = ?
    WHERE id = ?
      AND canonical_locked = 0
  `).run(match.artistId, match.status, match.confidence, fetchedAt, catalogArtistId)
  upsertCatalogFieldProvenance(db, 'artist', catalogArtistId, 'canonical_identity', 'musicbrainz', {
    canonicalId: match.artistId,
    value: match.artistId,
    confidence: match.confidence,
    fetchedAt,
  })
}

function applyAlbumCanonicalMatch(
  db: Database.Database,
  catalogAlbumId: string,
  match: {
    status: CanonicalMatchStatus
    confidence: number
    releaseGroupId: string | null
    releaseId: string | null
  },
) {
  const fetchedAt = Math.floor(Date.now() / 1000)
  db.prepare(`
    UPDATE catalog_albums
    SET mb_release_group_id = ?,
        mb_release_id = ?,
        canonical_match_status = ?,
        canonical_match_confidence = ?,
        canonical_match_source = 'musicbrainz',
        canonical_fetched_at = ?
    WHERE id = ?
      AND canonical_locked = 0
  `).run(match.releaseGroupId, match.releaseId, match.status, match.confidence, fetchedAt, catalogAlbumId)
  upsertCatalogFieldProvenance(db, 'album', catalogAlbumId, 'canonical_identity', 'musicbrainz', {
    canonicalId: match.releaseGroupId ?? match.releaseId,
    value: match.releaseGroupId ?? match.releaseId,
    confidence: match.confidence,
    fetchedAt,
  })
}

function applyTrackCanonicalMatch(
  db: Database.Database,
  catalogTrackId: string,
  match: {
    status: CanonicalMatchStatus
    confidence: number
    recordingId: string | null
    releaseId: string | null
  },
) {
  const fetchedAt = Math.floor(Date.now() / 1000)
  db.prepare(`
    UPDATE catalog_tracks
    SET mb_recording_id = ?,
        mb_release_id = ?,
        canonical_match_status = ?,
        canonical_match_confidence = ?,
        canonical_match_source = 'musicbrainz',
        canonical_fetched_at = ?
    WHERE id = ?
      AND canonical_locked = 0
  `).run(match.recordingId, match.releaseId, match.status, match.confidence, fetchedAt, catalogTrackId)
  upsertCatalogFieldProvenance(db, 'track', catalogTrackId, 'canonical_identity', 'musicbrainz', {
    canonicalId: match.recordingId ?? match.releaseId,
    value: match.recordingId ?? match.releaseId,
    confidence: match.confidence,
    fetchedAt,
  })
}

export async function ensureCatalogArtistCanonicalMatch(
  db: Database.Database,
  catalogArtistId: string,
  options?: { force?: boolean },
): Promise<void> {
  if (!getMetadataMusicBrainzEnabled(db)) return
  const artist = db.prepare(`
    SELECT id, name, canonical_locked, canonical_match_status, mb_artist_id
    FROM catalog_artists
    WHERE id = ?
    LIMIT 1
  `).get(catalogArtistId) as {
    id: string
    name: string
    canonical_locked: number
    canonical_match_status: string | null
    mb_artist_id: string | null
  } | undefined
  if (!artist) return
  if (artist.canonical_locked && !options?.force) return
  if (!options?.force && normalizeCanonicalStatus(artist.canonical_match_status) === 'matched_high' && artist.mb_artist_id) return

  const match = await musicBrainzSpineClient.matchArtist(artist.name)
  applyArtistCanonicalMatch(db, catalogArtistId, match)
}

async function ensureCatalogAlbumCanonicalMatch(
  db: Database.Database,
  catalogAlbumId: string,
  options?: { force?: boolean },
): Promise<void> {
  if (!getMetadataMusicBrainzEnabled(db)) return
  const album = db.prepare(`
    SELECT id, title, primary_artist_name, canonical_locked, canonical_match_status, mb_release_group_id, mb_release_id,
           (SELECT mb_artist_id FROM catalog_artists WHERE id = catalog_albums.primary_artist_id) as mb_artist_id
    FROM catalog_albums
    WHERE id = ?
    LIMIT 1
  `).get(catalogAlbumId) as {
    id: string
    title: string
    primary_artist_name: string | null
    canonical_locked: number
    canonical_match_status: string | null
    mb_release_group_id: string | null
    mb_release_id: string | null
    mb_artist_id: string | null
  } | undefined
  if (!album) return
  if (album.canonical_locked && !options?.force) return
  if (!options?.force && normalizeCanonicalStatus(album.canonical_match_status) === 'matched_high' && album.mb_release_group_id) return

  const match = await musicBrainzSpineClient.matchAlbum({
    title: album.title,
    artistName: album.primary_artist_name,
    mbArtistId: album.mb_artist_id,
  })
  applyAlbumCanonicalMatch(db, catalogAlbumId, match)
}

async function ensureCatalogTrackCanonicalMatch(
  db: Database.Database,
  catalogTrackId: string,
  options?: { force?: boolean },
): Promise<void> {
  if (!getMetadataMusicBrainzEnabled(db)) return
  const track = db.prepare(`
    SELECT id, title, album_title, primary_artist_name, duration_ms, canonical_locked, canonical_match_status, mb_recording_id,
           (SELECT mb_artist_id FROM catalog_artists WHERE id = catalog_tracks.primary_artist_id) as mb_artist_id
    FROM catalog_tracks
    WHERE id = ?
    LIMIT 1
  `).get(catalogTrackId) as {
    id: string
    title: string
    album_title: string | null
    primary_artist_name: string | null
    duration_ms: number | null
    canonical_locked: number
    canonical_match_status: string | null
    mb_recording_id: string | null
    mb_artist_id: string | null
  } | undefined
  if (!track) return
  if (track.canonical_locked && !options?.force) return
  if (!options?.force && normalizeCanonicalStatus(track.canonical_match_status) === 'matched_high' && track.mb_recording_id) return

  const match = await musicBrainzSpineClient.matchTrack({
    title: track.title,
    artistName: track.primary_artist_name,
    albumTitle: track.album_title,
    durationMs: track.duration_ms,
    mbArtistId: track.mb_artist_id,
  })
  applyTrackCanonicalMatch(db, catalogTrackId, match)
}

export async function ensureCatalogEntityCanonicalMatch(
  db: Database.Database,
  entityType: CatalogEntityType,
  catalogId: string,
  options?: { force?: boolean },
) {
  if (entityType === 'artist') {
    await ensureCatalogArtistCanonicalMatch(db, catalogId, options)
    return
  }
  if (entityType === 'album') {
    await ensureCatalogAlbumCanonicalMatch(db, catalogId, options)
    return
  }
  await ensureCatalogTrackCanonicalMatch(db, catalogId, options)
}
