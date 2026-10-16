import type Database from 'better-sqlite3'
import type { FormatInfoV1, ProviderPlaybackRecoverySeedV1, ProviderTrackV1 } from '../../../src/provider-api/v1'

/** Provider-scoped read of an already-imported core catalog row. */
export function getStoredProviderTrack(
  db: Database.Database,
  providerId: string,
  sourceId: string,
): ProviderTrackV1 | null {
  const row = db.prepare(`
    SELECT ct.*, source.provider_url FROM catalog_tracks ct
    JOIN catalog_track_sources source ON source.catalog_track_id = ct.id
    WHERE source.provider = ? AND source.source_id = ? LIMIT 1
  `).get(providerId, sourceId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    sourceId,
    title: String(row.title ?? 'Unknown Track'),
    durationMs: Number(row.duration_ms ?? 0),
    trackNumber: Number(row.track_number ?? 0) || null,
    discNumber: Number(row.disc_number ?? 0) || null,
    albumTitle: typeof row.album_title === 'string' ? row.album_title : null,
    primaryArtistName: typeof row.primary_artist_name === 'string' ? row.primary_artist_name : null,
    artworkUrl: typeof row.artwork_url === 'string' ? row.artwork_url : null,
    providerUrl: typeof row.provider_url === 'string' ? row.provider_url : null,
  }
}

/** Identity remains in core; no other provider's source IDs cross this boundary. */
export function getProviderPlaybackRecoverySeed(
  db: Database.Database,
  providerId: string,
  sourceId: string,
): ProviderPlaybackRecoverySeedV1 | null {
  const row = db.prepare(`
    SELECT t.title, t.isrc, t.duration_ms, al.title AS album_title,
           COALESCE(
             (SELECT group_concat(piece, '') FROM (
               SELECT ca.name || COALESCE(edge.join_phrase, '') AS piece,
                      MIN(edge.position) AS sort_position
               FROM catalog_artist_track_edges edge
               JOIN catalog_artists ca ON ca.id = edge.catalog_artist_id
               JOIN catalog_track_sources source2 ON source2.catalog_track_id = edge.catalog_track_id
               WHERE source2.provider = ? AND source2.source_id = t.source_id
               GROUP BY ca.id, piece ORDER BY sort_position, ca.name
             )),
             (SELECT a.name FROM artists a WHERE a.id = t.artist_id LIMIT 1),
             (SELECT ct.primary_artist_name FROM catalog_track_sources source3
              JOIN catalog_tracks ct ON ct.id = source3.catalog_track_id
              WHERE source3.provider = ? AND source3.source_id = t.source_id LIMIT 1)
           ) AS artist_name,
           (SELECT source.catalog_track_id FROM catalog_track_sources source
            WHERE source.provider = ? AND source.source_id = t.source_id LIMIT 1) AS catalog_track_id
    FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
    WHERE t.source = ? AND t.source_id = ? LIMIT 1
  `).get(providerId, providerId, providerId, providerId, sourceId) as {
    title: string | null; isrc: string | null; duration_ms: number | null
    album_title: string | null; artist_name: string | null; catalog_track_id: string | null
  } | undefined
  if (!row) return null
  const equivalentSourceIds = row.catalog_track_id
    ? (db.prepare(`
      SELECT source_id FROM catalog_track_sources
      WHERE provider = ? AND catalog_track_id = ? AND source_id IS NOT NULL
      ORDER BY in_library DESC, match_confidence DESC, source_id ASC LIMIT 20
    `).all(providerId, row.catalog_track_id) as Array<{ source_id: string }>).map(({ source_id }) => source_id)
    : []
  return {
    title: row.title ?? null,
    artist: row.artist_name ?? null,
    album: row.album_title ?? null,
    isrc: row.isrc ?? null,
    durationMs: row.duration_ms ?? null,
    equivalentSourceIds,
  }
}

/** Core-owned source-format persistence; never overwrites a local-backed canonical track. */
export function updateProviderTrackFormat(
  db: Database.Database,
  providerId: string,
  sourceId: string,
  format: FormatInfoV1,
): void {
  const bitrate = format.bitrate > 10_000 ? Math.round(format.bitrate / 1_000) : format.bitrate
  const values = [
    format.format,
    format.sampleRate || null,
    format.bitDepth || null,
    bitrate || null,
    format.channels || 2,
    format.isLossless ? 1 : 0,
  ]
  db.prepare(`
    UPDATE tracks
    SET format = ?, sample_rate = ?, bit_depth = ?, bitrate = ?, channels = ?, lossless = ?,
        stream_info_fetched_at = strftime('%s','now')
    WHERE source = ? AND source_id = ?
  `).run(...values, providerId, sourceId)

  db.prepare(`
    UPDATE catalog_tracks
    SET format = ?, sample_rate = ?, bit_depth = ?, bitrate = ?, channels = ?, lossless = ?,
        stream_info_fetched_at = strftime('%s','now')
    WHERE id IN (
      SELECT catalog_track_id FROM catalog_track_sources
      WHERE provider = ? AND source_id = ?
    )
      AND NOT EXISTS (
        SELECT 1 FROM catalog_track_sources local_source
        WHERE local_source.catalog_track_id = catalog_tracks.id AND local_source.provider = 'local'
      )
  `).run(...values, providerId, sourceId)
}

export function listProviderTracksNeedingFormat(
  db: Database.Database,
  providerId: string,
  limit: number,
): string[] {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const rows = db.prepare(`
    SELECT source_id FROM (
      SELECT source_id, indexed_at AS sort_order
      FROM tracks
      WHERE source = ? AND source_id IS NOT NULL AND stream_info_fetched_at IS NULL
      UNION
      SELECT source.source_id, COALESCE(track.fetched_at, 0) AS sort_order
      FROM catalog_track_sources source
      JOIN catalog_tracks track ON track.id = source.catalog_track_id
      WHERE source.provider = ? AND source.source_id IS NOT NULL
        AND track.stream_info_fetched_at IS NULL
    )
    ORDER BY sort_order DESC LIMIT ?
  `).all(providerId, providerId, boundedLimit) as Array<{ source_id: string | null }>
  return rows.flatMap(({ source_id }) => source_id ? [source_id] : [])
}
