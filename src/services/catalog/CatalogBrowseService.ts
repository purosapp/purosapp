import type Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { CatalogRegistry } from './CatalogRegistry'
import type { CatalogIngestService } from './CatalogIngestService'
import { parseSourceEntityId, sourceEntityId, type SourceEntityRef } from './sourceIdentity'
import type {
  CatalogAlbumPage, CatalogAlbumSummary, CatalogArtistCollaboratorSummary, CatalogArtistPage,
  CatalogArtistRoleSummary, CatalogArtistSummary, CatalogAvailability, CatalogBioProvider,
  CatalogCreditSummary, CatalogLocalCreditGuidanceMode, CatalogPlaylistSummary, CatalogProviderAlbumBundle,
  CatalogProviderArtistBundle, CatalogResolvedPlaybackTrack, CatalogSourceLink, CatalogTrackSummary,
  CatalogProviderName, CatalogEntityType, FieldProvenance,
} from './types'
function normalize(value: string | null | undefined) {
  return (value ?? '').toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim()
}
function parseGenres(value: string | null | undefined) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
function creditRoleRank(role: CatalogCreditSummary['role'] | null | undefined) {
  switch (role) {
    case 'primary': return 0
    case 'main': return 1
    case 'featured': return 2
    case 'performer': return 3
    case 'composer': return 4
    case 'producer': return 5
    case 'conductor': return 6
    default: return 7
  }
}
function dedupeCreditsForDisplay(credits: CatalogCreditSummary[] | null | undefined) {
  const ordered = [...(credits ?? [])].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position
    return a.artistName.localeCompare(b.artistName)
  })
  const merged = new Map<string, CatalogCreditSummary>()

  for (const credit of ordered) {
    const existing = merged.get(credit.artistId)
    if (!existing) {
      merged.set(credit.artistId, { ...credit })
      continue
    }

    const nextRole = creditRoleRank(credit.role) < creditRoleRank(existing.role) ? credit.role : existing.role
    merged.set(credit.artistId, {
      ...existing,
      role: nextRole,
      position: Math.min(existing.position, credit.position),
      joinPhrase: existing.joinPhrase ?? credit.joinPhrase ?? null,
      confidence: Math.max(existing.confidence ?? 0, credit.confidence ?? 0),
      source: existing.source ?? credit.source,
    })
  }

  return [...merged.values()].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position
    return a.artistName.localeCompare(b.artistName)
  })
}
function formatCreditDisplay(
  credits: CatalogCreditSummary[] | null | undefined,
  fallbackPrimaryName: string | null | undefined,
) {
  const ordered = dedupeCreditsForDisplay(credits)
  if (!ordered.length) return fallbackPrimaryName ?? null

  let value = ''
  for (const credit of ordered) {
    value += credit.artistName
    value += credit.joinPhrase ?? ''
  }
  return value.trim() || fallbackPrimaryName || null
}
function isPlaceholderArtistName(name: string | null | undefined) {
  const value = name?.trim().toLowerCase() ?? ''
  return !value || value === 'unknown artist' || value === 'unknown'
}
function buildAvailability(sourceLinks: CatalogSourceLink[]): CatalogAvailability {
  const ready = sourceLinks.filter((source) => source.available)
  const streamable = ready.filter((source) => !source.unavailableReason)
  const providers = new Set(streamable.map((source) => source.provider))
  const inLibrary = sourceLinks.some((source) => source.inLibrary)
  return {
    inLibrary,
    availableProviderIds: [...providers],
    playable: providers.size > 0,
    unavailableReason: providers.size > 0 ? null : ready.find((source) => source.unavailableReason)?.unavailableReason ?? null,
  }
}
export class CatalogBrowseService {
  private readonly db: Database.Database
  private readonly registry: CatalogRegistry
  private readonly ingest: CatalogIngestService
  private readonly artistBundles = new Map<string, { at: number; promise: Promise<CatalogProviderArtistBundle | null> }>()
  private readonly albumBundles = new Map<string, { at: number; promise: Promise<CatalogProviderAlbumBundle | null> }>()
  constructor(options: {
    db: Database.Database; registry: CatalogRegistry; ingest: CatalogIngestService
    getProviderPriority?: (provider: CatalogProviderName) => number
    getArtistBioSourcePriority?: () => CatalogBioProvider[]
    getLocalCreditGuidanceMode?: () => CatalogLocalCreditGuidanceMode
    getAlbumSourcePreference?: (id: string) => { provider: string | null; sourceId: string | null } | null
    getArtistSourcePreference?: (id: string) => { provider: string | null; sourceId: string | null } | null
    onBundleRefreshed?: () => void
  }) { this.db = options.db; this.registry = options.registry; this.ingest = options.ingest }

  private resolveId(kind: CatalogEntityType, id: string, provider?: string | null, sourceId?: string | null): string | null {
    const ref = parseSourceEntityId(id)
    if (ref) return ref.entityType === kind && (!provider || ref.providerId === provider) && (!sourceId || ref.sourceId === sourceId) ? id : null
    const rows = this.db.prepare(`SELECT new_id FROM catalog_source_migration WHERE entity_type = ? AND old_id = ? AND (? IS NULL OR provider = ?) AND (? IS NULL OR source_id = ?)`).all(kind, id, provider ?? null, provider ?? null, sourceId ?? null, sourceId ?? null) as { new_id: string }[]
    return rows.length === 1 ? rows[0].new_id : null
  }

  getSourceChoices(kind: CatalogEntityType, oldId: string): Array<{ id: string; providerId: string; sourceId: string; title: string }> {
    const rows = this.db.prepare('SELECT new_id, provider, source_id FROM catalog_source_migration WHERE entity_type = ? AND old_id = ? ORDER BY provider, source_id').all(kind, oldId) as Array<{ new_id: string; provider: string; source_id: string }>
    return rows.map(row => {
      const summary = kind === 'artist' ? this.getArtistSummary(row.new_id) : kind === 'album' ? this.getAlbumSummary(row.new_id) : this.getTrackSummary(row.new_id)
      return { id: row.new_id, providerId: row.provider, sourceId: row.source_id, title: summary ? ('name' in summary ? summary.name : summary.title) : row.source_id }
    })
  }
  private localTrackExists(id: string): boolean {
    const row = this.db.prepare('SELECT file_path, playback_file_path FROM tracks WHERE id = ? AND source = ?').get(id, 'local') as { file_path: string; playback_file_path: string | null } | undefined
    return !!row && existsSync(row.playback_file_path ?? row.file_path)
  }
  private getSourceLinks(kind: CatalogEntityType, id: string): CatalogSourceLink[] {
    const localColumn = `local_${kind}_id`
    const unavailableColumn = kind === 'track' ? 'unavailable_reason' : 'NULL'
    const rows = this.db.prepare(`SELECT provider, source_id, in_library, ${localColumn} as local_id, provider_priority, match_confidence, provider_url, available, ${unavailableColumn} as unavailable_reason FROM catalog_${kind}_sources WHERE catalog_${kind}_id = ?`).all(id) as Array<{ provider: string; source_id: string; in_library: number; local_id: string | null; provider_priority: number; match_confidence: number; provider_url: string | null; available: number; unavailable_reason: string | null }>
    const ref = parseSourceEntityId(id)
    return rows.filter(r => ref && r.provider === ref.providerId && r.source_id === ref.sourceId).map(r => ({ provider: r.provider, sourceId: r.source_id, inLibrary: !!r.in_library, localId: r.local_id, providerPriority: 0, matchConfidence: 1, providerUrl: r.provider_url, available: kind === 'track' && r.provider === 'local'
      ? this.localTrackExists(r.local_id ?? r.source_id)
      : !!r.available, unavailableReason: r.unavailable_reason }))
  }
  private getFieldProvenance(entityType: CatalogEntityType, id: string): FieldProvenance[] {
    return this.db.prepare(`
      SELECT field_name as field, source, source_id as sourceId, canonical_id as canonicalId,
             value, confidence, fetched_at as fetchedAt, expires_at as expiresAt
      FROM catalog_field_provenance
      WHERE entity_type = ? AND catalog_id = ?
      ORDER BY field_name
    `).all(entityType, id) as FieldProvenance[]
  }
  private getCreditsForEntity(entityType: 'album' | 'track', id: string): CatalogCreditSummary[] {
    const table = entityType === 'album' ? 'catalog_artist_album_edges' : 'catalog_artist_track_edges'
    const idColumn = entityType === 'album' ? 'catalog_album_id' : 'catalog_track_id'
    const rows = this.db.prepare(`
      SELECT ca.id as artistId, ca.name as artistName, edge.credit_role as role, edge.join_phrase as joinPhrase,
             edge.position as position, edge.metadata_source as source, edge.confidence as confidence
      FROM ${table} edge
      JOIN catalog_artists ca ON ca.id = edge.catalog_artist_id
      WHERE edge.${idColumn} = ?
      ORDER BY edge.position, ca.name
    `).all(id) as CatalogCreditSummary[]
    return dedupeCreditsForDisplay(rows)
  }
  private getArtistNameById(artistId: string | null | undefined) {
    if (!artistId) return null
    const row = this.db.prepare(`
      SELECT name
      FROM catalog_artists
      WHERE id = ?
      LIMIT 1
    `).get(artistId) as { name: string | null } | undefined
    const name = row?.name?.trim() || null
    return isPlaceholderArtistName(name) ? null : name
  }
  private resolveArtistDisplayName(artistId: string, currentName: string | null | undefined) {
    const directName = currentName?.trim() || null
    if (!isPlaceholderArtistName(directName)) return directName

    const albumRow = this.db.prepare(`
      SELECT primary_artist_name as name
      FROM catalog_albums
      WHERE primary_artist_id = ?
        AND primary_artist_name IS NOT NULL
        AND trim(primary_artist_name) <> ''
        AND lower(trim(primary_artist_name)) <> 'unknown artist'
        AND lower(trim(primary_artist_name)) <> 'unknown'
      ORDER BY year DESC, title
      LIMIT 1
    `).get(artistId) as { name: string | null } | undefined
    const albumName = albumRow?.name?.trim() || null
    if (!isPlaceholderArtistName(albumName)) return albumName

    const trackRow = this.db.prepare(`
      SELECT primary_artist_name as name
      FROM catalog_tracks
      WHERE primary_artist_id = ?
        AND primary_artist_name IS NOT NULL
        AND trim(primary_artist_name) <> ''
        AND lower(trim(primary_artist_name)) <> 'unknown artist'
        AND lower(trim(primary_artist_name)) <> 'unknown'
      ORDER BY title
      LIMIT 1
    `).get(artistId) as { name: string | null } | undefined
    const trackName = trackRow?.name?.trim() || null
    if (!isPlaceholderArtistName(trackName)) return trackName

    const creditRow = this.db.prepare(`
      SELECT ca.name as name
      FROM catalog_artist_album_edges edge
      JOIN catalog_artists ca ON ca.id = edge.catalog_artist_id
      WHERE edge.catalog_artist_id = ?
        AND ca.name IS NOT NULL
        AND trim(ca.name) <> ''
        AND lower(trim(ca.name)) <> 'unknown artist'
        AND lower(trim(ca.name)) <> 'unknown'
      LIMIT 1
    `).get(artistId) as { name: string | null } | undefined
    const creditName = creditRow?.name?.trim() || null
    return isPlaceholderArtistName(creditName) ? directName : creditName
  }
  private resolvePrimaryArtistName(
    entityType: 'album' | 'track',
    entityId: string,
    primaryArtistId: string | null | undefined,
    primaryArtistName: string | null | undefined,
  ): string | null {
    const directName = primaryArtistName?.trim() ?? null
    if (!isPlaceholderArtistName(directName)) return directName

    const linkedArtistName = this.getArtistNameById(primaryArtistId)
    if (linkedArtistName) return linkedArtistName

    const credits = this.getCreditsForEntity(entityType, entityId)
    const creditName = credits.find((credit) => credit.artistName?.trim())?.artistName?.trim() ?? null
    if (creditName) return creditName

    return null
  }
  private getArtistRoleSummary(id: string): CatalogArtistRoleSummary[] {
    return this.db.prepare(`
      WITH album_roles AS (
        SELECT COALESCE(credit_role, 'primary') as role,
               COUNT(DISTINCT catalog_album_id) as album_count,
               0 as track_count
        FROM catalog_artist_album_edges
        WHERE catalog_artist_id = ?
        GROUP BY COALESCE(credit_role, 'primary')
      ),
      track_roles AS (
        SELECT COALESCE(credit_role, 'main') as role,
               0 as album_count,
               COUNT(DISTINCT catalog_track_id) as track_count
        FROM catalog_artist_track_edges
        WHERE catalog_artist_id = ?
        GROUP BY COALESCE(credit_role, 'main')
      )
      SELECT role,
             SUM(album_count) as albumCount,
             SUM(track_count) as trackCount
      FROM (
        SELECT * FROM album_roles
        UNION ALL
        SELECT * FROM track_roles
      )
      GROUP BY role
      ORDER BY
        CASE role
          WHEN 'primary' THEN 0
          WHEN 'main' THEN 1
          WHEN 'featured' THEN 2
          WHEN 'performer' THEN 3
          WHEN 'composer' THEN 4
          WHEN 'producer' THEN 5
          WHEN 'conductor' THEN 6
          ELSE 7
        END,
        trackCount DESC,
        albumCount DESC
    `).all(id, id) as CatalogArtistRoleSummary[]
  }
  private getArtistCollaborators(id: string): CatalogArtistCollaboratorSummary[] {
    return this.db.prepare(`
      WITH shared_album AS (
        SELECT other.catalog_artist_id as artist_id,
               COUNT(DISTINCT self.catalog_album_id) as album_count
        FROM catalog_artist_album_edges self
        JOIN catalog_artist_album_edges other
          ON other.catalog_album_id = self.catalog_album_id
         AND other.catalog_artist_id <> self.catalog_artist_id
        WHERE self.catalog_artist_id = ?
        GROUP BY other.catalog_artist_id
      ),
      shared_track AS (
        SELECT other.catalog_artist_id as artist_id,
               COUNT(DISTINCT self.catalog_track_id) as track_count
        FROM catalog_artist_track_edges self
        JOIN catalog_artist_track_edges other
          ON other.catalog_track_id = self.catalog_track_id
         AND other.catalog_artist_id <> self.catalog_artist_id
        WHERE self.catalog_artist_id = ?
        GROUP BY other.catalog_artist_id
      )
      SELECT ca.id as artistId,
             ca.name as artistName,
             COALESCE(shared_track.track_count, 0) as trackCount,
             COALESCE(shared_album.album_count, 0) as albumCount
      FROM catalog_artists ca
      LEFT JOIN shared_track ON shared_track.artist_id = ca.id
      LEFT JOIN shared_album ON shared_album.artist_id = ca.id
      WHERE COALESCE(shared_track.track_count, 0) > 0
         OR COALESCE(shared_album.album_count, 0) > 0
      ORDER BY
        COALESCE(shared_track.track_count, 0) DESC,
        COALESCE(shared_album.album_count, 0) DESC,
        ca.name
      LIMIT 18
    `).all(id, id) as CatalogArtistCollaboratorSummary[]
  }
  private getArtistAppearsOnAlbums(id: string): CatalogAlbumSummary[] {
    const directAlbums = this.db.prepare(`
      SELECT catalog_album_id as id
      FROM catalog_artist_album_edges
      WHERE catalog_artist_id = ?
        AND COALESCE(credit_role, 'primary') <> 'primary'
      ORDER BY position, catalog_album_id
    `).all(id) as Array<{ id: string }>

    const featuredTrackAlbums = this.db.prepare(`
      SELECT DISTINCT ct.album_id as id
      FROM catalog_artist_track_edges edge
      JOIN catalog_tracks ct ON ct.id = edge.catalog_track_id
      WHERE edge.catalog_artist_id = ?
        AND COALESCE(edge.credit_role, 'main') <> 'primary'
        AND COALESCE(edge.credit_role, 'main') <> 'main'
        AND ct.album_id IS NOT NULL
    `).all(id) as Array<{ id: string | null }>

    const seen = new Set<string>()
    const ids = [...directAlbums.map((row) => row.id), ...featuredTrackAlbums.map((row) => row.id).filter((value): value is string => !!value)]
      .filter((albumId) => {
        if (seen.has(albumId)) return false
        seen.add(albumId)
        return true
      })
    return ids
      .map((albumId) => this.getAlbumSummary(albumId))
      .filter((album): album is CatalogAlbumSummary => !!album)
  }
  getArtistSummary(id: string): CatalogArtistSummary | null {
    const resolvedId = this.resolveId('artist', id)
    if (!resolvedId) return null
    id = resolvedId
    const row = this.db.prepare(`
      SELECT id, name, normalized_name, artwork_url, artwork_id
      FROM catalog_artists
      WHERE id = ?
    `).get(id) as {
      id: string
      name: string
      normalized_name: string | null
      artwork_url: string | null
      artwork_id: string | null
    } | undefined
    if (!row) return null

    const sourceLinks = this.getSourceLinks('artist', id)
    const groupedAlbums = this.getArtistAlbumSummaries(id)
    const trackCount = this.getArtistCounts(id).trackCount
    const resolvedArtistName = this.resolveArtistDisplayName(row.id, row.name)
    return {
      id: row.id,
      sourceRef: parseSourceEntityId(row.id)!,
      name: resolvedArtistName ?? row.name,
      normalizedName: row.normalized_name,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      sourceLinks,
      availability: buildAvailability(sourceLinks),
      albumCount: groupedAlbums.length,
      trackCount,
      canonicalIdentity: null,
      metadataProvenance: this.getFieldProvenance('artist', row.id),
    }
  }
  getArtistSearchSummary(id: string): CatalogArtistSummary | null {
    const resolvedId = this.resolveId('artist', id)
    if (!resolvedId) return null
    id = resolvedId
    const row = this.db.prepare(`
      SELECT id, name, normalized_name, artwork_url, artwork_id
      FROM catalog_artists
      WHERE id = ?
    `).get(id) as {
      id: string
      name: string
      normalized_name: string | null
      artwork_url: string | null
      artwork_id: string | null
    } | undefined
    if (!row) return null

    const sourceLinks = this.getSourceLinks('artist', id)
    const resolvedArtistName = this.resolveArtistDisplayName(row.id, row.name)
    return {
      id: row.id,
      sourceRef: parseSourceEntityId(row.id)!,
      name: resolvedArtistName ?? row.name,
      normalizedName: row.normalized_name,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      sourceLinks,
      availability: buildAvailability(sourceLinks),
      albumCount: 0,
      trackCount: 0,
      canonicalIdentity: null,
      metadataProvenance: [],
    }
  }
  getArtistCounts(id: string, scope: 'library' | 'all' = 'all'): { albumCount: number; trackCount: number } {
    const albumRow = this.db.prepare(`
      SELECT COUNT(DISTINCT catalog_album_id) as count
      FROM catalog_artist_album_edges
      WHERE catalog_artist_id = ?
        AND COALESCE(credit_role, 'primary') = 'primary'
        AND (? = 'all' OR EXISTS (SELECT 1 FROM catalog_album_sources s WHERE s.catalog_album_id = catalog_artist_album_edges.catalog_album_id AND s.in_library = 1))
    `).get(id, scope) as { count: number } | undefined
    const trackRow = this.db.prepare(`
      SELECT COUNT(DISTINCT catalog_track_id) as count
      FROM catalog_artist_track_edges
      WHERE catalog_artist_id = ?
        AND (? = 'all' OR EXISTS (SELECT 1 FROM catalog_track_sources s WHERE s.catalog_track_id = catalog_artist_track_edges.catalog_track_id AND s.in_library = 1))
    `).get(id, scope) as { count: number } | undefined
    return {
      albumCount: albumRow?.count ?? 0,
      trackCount: trackRow?.count ?? 0,
    }
  }
  getAlbumSummary(id: string): CatalogAlbumSummary | null {
    const resolvedId = this.resolveId('album', id)
    if (!resolvedId) return null
    id = resolvedId
    const row = this.db.prepare(`
      SELECT id, title, normalized_title, year, release_type, release_section, artwork_url, artwork_id,
             primary_artist_id, primary_artist_name, total_tracks, total_discs
      FROM catalog_albums
      WHERE id = ?
    `).get(id) as {
      id: string
      title: string
      normalized_title: string | null
      year: number | null
      release_type: CatalogAlbumSummary['releaseType']
      release_section: CatalogAlbumSummary['releaseSection']
      artwork_url: string | null
      artwork_id: string | null
      primary_artist_id: string | null
      primary_artist_name: string | null
      total_tracks: number | null
      total_discs: number | null
    } | undefined
    if (!row) return null

    const credits = this.getCreditsForEntity('album', row.id)
    const resolvedPrimaryArtistName = this.resolvePrimaryArtistName('album', row.id, row.primary_artist_id, row.primary_artist_name)
    const sourceLinks = this.getSourceLinks('album', id)
    return {
      id: row.id,
      sourceRef: parseSourceEntityId(row.id)!,
      title: row.title,
      normalizedTitle: row.normalized_title,
      year: row.year,
      releaseType: row.release_type,
      releaseSection: row.release_section,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      primaryArtistId: row.primary_artist_id,
      primaryArtistName: resolvedPrimaryArtistName,
      artistCreditName: formatCreditDisplay(credits, resolvedPrimaryArtistName),
      totalTracks: row.total_tracks,
      totalDiscs: row.total_discs,
      sourceLinks,
      availability: buildAvailability(sourceLinks),
      canonicalIdentity: null,
      metadataProvenance: this.getFieldProvenance('album', row.id),
      credits,
    }
  }
  getTrackSummary(id: string): CatalogTrackSummary | null {
    const resolvedId = this.resolveId('track', id)
    if (!resolvedId) return null
    id = resolvedId
    const row = this.db.prepare(`
      SELECT ct.id, ct.title, ct.normalized_title, ct.duration_ms, ct.track_number, ct.disc_number,
             ct.album_id, ct.album_title, ct.primary_artist_id, ct.primary_artist_name,
             ct.format, ct.sample_rate, ct.bit_depth, ct.bitrate, ct.channels, ct.lossless, ct.stream_info_fetched_at,
             COALESCE(ct.artwork_url, ca.artwork_url) AS artwork_url,
             COALESCE(ct.artwork_id, ca.artwork_id) AS artwork_id
      FROM catalog_tracks ct
      LEFT JOIN catalog_albums ca ON ca.id = ct.album_id
      WHERE ct.id = ?
    `).get(id) as {
      id: string
      title: string
      normalized_title: string | null
      duration_ms: number
      track_number: number | null
      disc_number: number | null
      album_id: string | null
      album_title: string | null
      primary_artist_id: string | null
      primary_artist_name: string | null
      format: string | null
      sample_rate: number | null
      bit_depth: number | null
      bitrate: number | null
      channels: number | null
      lossless: number
      stream_info_fetched_at: number | null
      artwork_url: string | null
      artwork_id: string | null
    } | undefined
    if (!row) return null

    const credits = this.getCreditsForEntity('track', row.id)
    const resolvedPrimaryArtistName = this.resolvePrimaryArtistName('track', row.id, row.primary_artist_id, row.primary_artist_name)
    const sourceLinks = this.getSourceLinks('track', id)
    const catalogFormatInfo = row.format && row.stream_info_fetched_at != null
      ? this.toCatalogFormatInfo({
          format: row.format,
          sample_rate: row.sample_rate,
          bit_depth: row.bit_depth,
          bitrate: row.bitrate,
          channels: row.channels,
          lossless: row.lossless,
        })
      : null
    const formatInfo = catalogFormatInfo ?? this.readTrackFormat(id)
    const formatInfoInspected = !!formatInfo
    return {
      id: row.id,
      sourceRef: parseSourceEntityId(row.id)!,
      title: row.title,
      normalizedTitle: row.normalized_title,
      durationMs: row.duration_ms ?? 0,
      trackNumber: row.track_number,
      discNumber: row.disc_number,
      albumId: row.album_id,
      albumTitle: row.album_title,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      primaryArtistId: row.primary_artist_id,
      primaryArtistName: resolvedPrimaryArtistName,
      artistCreditName: formatCreditDisplay(credits, resolvedPrimaryArtistName),
      sourceLinks,
      availability: buildAvailability(sourceLinks),
      formatInfo,
      formatInfoInspected,
      canonicalIdentity: null,
      metadataProvenance: this.getFieldProvenance('track', row.id),
      credits,
    }
  }
  private getArtistGenres(catalogArtistId: string): string[] {
    const row = this.db.prepare(`
      SELECT genres_json
      FROM catalog_artists
      WHERE id = ?
    `).get(catalogArtistId) as { genres_json: string | null } | undefined

    const provenanceRows = this.db.prepare(`
      SELECT value
      FROM catalog_field_provenance
      WHERE entity_type = 'artist'
        AND catalog_id = ?
        AND field_name = 'genres'
        AND source = 'local'
    `).all(catalogArtistId) as Array<{ value: string | null }>

    const seen = new Set<string>()
    const genres: string[] = []
    for (const genre of [
      ...parseGenres(row?.genres_json),
      ...provenanceRows.flatMap((entry) => parseGenres(entry.value)),
    ]) {
      const key = normalize(genre)
      if (!key || seen.has(key)) continue
      seen.add(key)
      genres.push(genre)
    }
    return genres
  }
  private toCatalogFormatInfo(row: {
    format: string | null
    sample_rate: number | null
    bit_depth: number | null
    bitrate: number | null
    channels: number | null
    lossless: number | null
  }): CatalogTrackSummary['formatInfo'] {
    if (!row.format) return null
    return {
      format: row.format as NonNullable<CatalogTrackSummary['formatInfo']>['format'],
      sampleRate: row.sample_rate ?? 0,
      bitDepth: row.bit_depth ?? 0,
      bitrate: row.bitrate ?? 0,
      channels: row.channels ?? 2,
      isLossless: !!row.lossless,
      isHiRes: (row.bit_depth ?? 0) > 16 || (row.sample_rate ?? 0) > 48000,
      isMqa: row.format === 'MQA',
      isDsd: row.format === 'DSD',
      dsdRate: row.format === 'DSD' ? (row.sample_rate ?? undefined) : undefined,
    }
  }

  private readTrackFormat(id: string): CatalogTrackSummary['formatInfo'] {
    const row = this.db.prepare('SELECT format, sample_rate, bit_depth, bitrate, channels, lossless FROM catalog_tracks WHERE id = ?').get(id) as Parameters<CatalogBrowseService['toCatalogFormatInfo']>[0] | undefined
    return row ? this.toCatalogFormatInfo(row) : null
  }
  private getArtistAlbumSummaries(id: string): CatalogAlbumSummary[] {
    const rows = this.db.prepare(`SELECT DISTINCT catalog_album_id as id FROM catalog_artist_album_edges WHERE catalog_artist_id = ? AND COALESCE(credit_role, 'primary') IN ('primary', 'main')`).all(id) as { id: string }[]
    return rows.map(r => this.getAlbumSummary(r.id)).filter((a): a is CatalogAlbumSummary => !!a).sort((a,b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title))
  }
  private getTracksForAlbum(id: string): CatalogTrackSummary[] {
    const rows = this.db.prepare('SELECT catalog_track_id as id FROM catalog_album_track_edges WHERE catalog_album_id = ? ORDER BY disc_number, position, catalog_track_id').all(id) as { id: string }[]
    return rows.map(r => this.getTrackSummary(r.id)).filter((t): t is CatalogTrackSummary => !!t)
  }
  private async artistBundle(id: string): Promise<CatalogProviderArtistBundle | null> {
    const source = this.getSourceLinks('artist', id)[0]
    if (!source || source.provider === 'local' || !source.available) return null
    const provider = this.registry.getProvider(source.provider)
    if (!provider?.capabilities.artistProfile || !(await provider.isAuthenticated())) return null
    const cached = this.artistBundles.get(id)
    if (cached && Date.now() - cached.at < 300_000) return cached.promise
    const promise = provider.getArtistBundle(source.sourceId, { limit: 256 }).then(async bundle => {
      if (bundle.artist.provider !== source.provider || bundle.artist.sourceId !== source.sourceId) throw new Error('Artist response does not belong to the requested source')
      await this.ingest.ingestProviderArtistBundle(bundle)
      return bundle
    }).catch(() => { this.artistBundles.delete(id); return null })
    this.artistBundles.set(id, { at: Date.now(), promise })
    return promise
  }
  private async albumBundle(id: string): Promise<CatalogProviderAlbumBundle | null> {
    const source = this.getSourceLinks('album', id)[0]
    if (!source || source.provider === 'local' || !source.available) return null
    const provider = this.registry.getProvider(source.provider)
    if (!provider?.capabilities.albumDetails || !(await provider.isAuthenticated())) return null
    const cached = this.albumBundles.get(id)
    if (cached && Date.now() - cached.at < 300_000) return cached.promise
    const promise = provider.getAlbumBundle(source.sourceId).then(async bundle => {
      if (bundle.album.provider !== source.provider || bundle.album.sourceId !== source.sourceId) throw new Error('Album response does not belong to the requested source')
      await this.ingest.ingestProviderAlbumBundle(bundle)
      return bundle
    }).catch(() => { this.albumBundles.delete(id); return null })
    this.albumBundles.set(id, { at: Date.now(), promise })
    return promise
  }
  getArtistPreviewPage(id: string): CatalogArtistPage | null {
    const summary = this.getArtistSummary(id)
    if (!summary) return null
    id = summary.id
    const ref = parseSourceEntityId(id)!
    const bio = this.db.prepare('SELECT bio, bio_url FROM catalog_artist_bios WHERE catalog_artist_id = ? AND provider = ?').get(id, ref.providerId) as { bio: string | null; bio_url: string | null } | undefined
    const releases = this.getArtistAlbumSummaries(id)
    return { ...summary, bio: bio?.bio ?? null, bioUrl: bio?.bio_url ?? null, bioSource: bio?.bio ? ref.providerId : null, genres: this.getArtistGenres(id), topTracks: [], releases, playlists: [], relatedArtists: [], localAlbums: ref.providerId === 'local' ? releases : [], appearsOn: this.getArtistAppearsOnAlbums(id), credits: [], roleSummary: this.getArtistRoleSummary(id), collaborators: this.getArtistCollaborators(id) }
  }
  async getArtistPage(id: string): Promise<CatalogArtistPage | null> {
    const resolved = this.resolveId('artist', id)
    if (!resolved) return null
    const bundle = await this.artistBundle(resolved)
    const page = this.getArtistPreviewPage(resolved)
    if (!page) return null
    const topTracks = bundle ? bundle.topTracks.map(t => this.getTrackSummary(sourceEntityId({ providerId: t.provider, entityType: 'track', sourceId: t.sourceId }))).filter((t): t is CatalogTrackSummary => !!t) : this.artistTracks(resolved)
    const related = this.db.prepare('SELECT related_catalog_artist_id as id FROM catalog_related_artists WHERE catalog_artist_id = ? ORDER BY position').all(resolved) as { id: string }[]
    return { ...page, topTracks, playlists: bundle?.playlists ?? [], relatedArtists: related.map(r => this.getArtistSummary(r.id)).filter((a): a is CatalogArtistSummary => !!a) }
  }
  private artistTracks(id: string): CatalogTrackSummary[] {
    const rows = this.db.prepare('SELECT DISTINCT catalog_track_id as id, position FROM catalog_artist_track_edges WHERE catalog_artist_id = ? ORDER BY position LIMIT 50').all(id) as { id: string }[]
    return rows.map(r => this.getTrackSummary(r.id)).filter((t): t is CatalogTrackSummary => !!t)
  }
  getAlbumPreviewPage(id: string): CatalogAlbumPage | null {
    const summary = this.getAlbumSummary(id)
    if (!summary) return null
    return { ...summary, tracks: [], versions: [] }
  }
  async getAlbumPage(id: string): Promise<CatalogAlbumPage | null> {
    const resolved = this.resolveId('album', id)
    if (!resolved) return null
    await this.albumBundle(resolved)
    const summary = this.getAlbumSummary(resolved)
    if (!summary) return null
    const ref = parseSourceEntityId(resolved)!
    const rows = this.db.prepare('SELECT id FROM catalog_albums WHERE provider_id = ? AND primary_artist_id = ? AND normalized_title = ? AND id <> ? ORDER BY year DESC, title').all(ref.providerId, summary.primaryArtistId, summary.normalizedTitle, resolved) as { id: string }[]
    return { ...summary, tracks: this.getTracksForAlbum(resolved), versions: rows.map(r => this.getAlbumSummary(r.id)).filter((a): a is CatalogAlbumSummary => !!a) }
  }
  async getArtistReleases(id: string) { return (await this.getArtistPage(id))?.releases ?? [] }
  async getArtistTopTracks(id: string) { return (await this.getArtistPage(id))?.topTracks ?? [] }
  async getArtistRelated(id: string) { return (await this.getArtistPage(id))?.relatedArtists ?? [] }
  async getArtistPlaylists(id: string): Promise<CatalogPlaylistSummary[]> { return (await this.getArtistPage(id))?.playlists ?? [] }
  async getAlbumTracks(id: string) { return (await this.getAlbumPage(id))?.tracks ?? [] }

  async resolvePlayback(trackRef: string | SourceEntityRef, providerId?: string | null, sourceId?: string | null, _options?: { allowDiscovery?: boolean }): Promise<CatalogResolvedPlaybackTrack | null> {
    const requested = typeof trackRef === 'string' ? trackRef : sourceEntityId(trackRef)
    const id = this.resolveId('track', requested, providerId, sourceId)
    if (!id) return null
    const track = this.getTrackSummary(id)
    const source = track?.sourceLinks[0]
    if (!track || !source?.available || !track.availability.playable) return null
    if (source.provider === 'local') {
      const row = this.db.prepare(`SELECT t.id, t.file_path, t.playback_file_path, t.start_offset_ms, t.end_offset_ms, t.cue_sheet_path, al.art_path, al.artwork_id FROM tracks t LEFT JOIN albums al ON al.id = t.album_id WHERE t.id = ? AND t.source = 'local'`).get(source.localId ?? source.sourceId) as { id: string; file_path: string; playback_file_path: string | null; start_offset_ms: number | null; end_offset_ms: number | null; cue_sheet_path: string | null; art_path: string | null; artwork_id: string | null } | undefined
      if (!row || !existsSync(row.playback_file_path ?? row.file_path)) return null
      const artwork = row.artwork_id ? `artwork://cache/${encodeURIComponent(row.artwork_id)}` : row.art_path
      return { catalogTrackId: id, catalogAlbumId: track.albumId, catalogArtistId: track.primaryArtistId, id: row.id, sourceType: 'local', sourceId: source.sourceId, provider: 'local', displayMetadataSource: 'local', title: track.title, artist: track.artistCreditName ?? track.primaryArtistName ?? 'Unknown Artist', album: track.albumTitle ?? 'Unknown Album', duration: track.durationMs / 1000, filePath: row.file_path, playbackFilePath: row.playback_file_path ?? row.file_path, coverUrl: artwork, artworkUrl: artwork, formatInfo: track.formatInfo, startOffsetMs: row.start_offset_ms ?? 0, endOffsetMs: row.end_offset_ms, cueSheetPath: row.cue_sheet_path }
    }
    const provider = this.registry.getProvider(source.provider)
    if (!provider?.capabilities.trackPlayback || !(await provider.isAuthenticated())) return null
    const resolved = await provider.resolvePlayback(id, source.sourceId).catch(() => null)
    if (!resolved || resolved.sourceId !== source.sourceId || (resolved.provider ?? resolved.sourceType) !== source.provider) return null
    return { ...resolved, catalogTrackId: id, catalogAlbumId: track.albumId, catalogArtistId: track.primaryArtistId, fallbackStreamIds: [], artist: track.artistCreditName ?? resolved.artist }
  }
  async addToLibrary(kind: CatalogEntityType, id: string, providerId?: string | null) {
    const resolved = this.resolveId(kind, id, providerId)
    if (!resolved) return false
    const source = this.getSourceLinks(kind, resolved)[0]
    if (!source || source.provider === 'local') return false
    const provider = this.registry.getProvider(source.provider)
    if (!provider?.capabilities.addToLibrary || !(await provider.isAuthenticated())) return false
    const add = kind === 'artist' ? provider.addArtistToLibrary : kind === 'album' ? provider.addAlbumToLibrary : provider.addTrackToLibrary
    if (!add) return false
    await add.call(provider, source.sourceId)
    return true
  }
  async refreshEntity(kind: CatalogEntityType, id: string) {
    const resolved = this.resolveId(kind, id)
    if (!resolved) return
    this.artistBundles.delete(resolved); this.albumBundles.delete(resolved)
    if (kind === 'artist') await this.getArtistPage(resolved)
    if (kind === 'album') await this.getAlbumPage(resolved)
  }
  async getArtistRadioTracks(options: { catalogArtistId?: string | null; artistName?: string | null; excludeTrackIds?: string[]; providerId?: string | null }) {
    let id = options.catalogArtistId ? this.resolveId('artist', options.catalogArtistId, options.providerId) : null
    if (!id && options.providerId && options.artistName) {
      const row = this.db.prepare('SELECT id FROM catalog_artists WHERE provider_id = ? AND normalized_name = ?').get(options.providerId, normalize(options.artistName)) as { id: string } | undefined
      id = row?.id ?? null
    }
    if (!id) return []
    const page = await this.getArtistPage(id)
    const excluded = new Set(options.excludeTrackIds ?? [])
    return (page?.topTracks ?? []).filter(t => t.availability.playable && !excluded.has(t.id) && !t.sourceLinks.some(s => excluded.has(s.sourceId)))
  }
}
