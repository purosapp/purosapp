import type { CatalogProviderName } from "../../../src/services/catalog"
import { getDb } from "../db"
import { upsertCatalogFieldProvenance } from "../metadata/canonical"
import { pauseBackgroundWorkForPlayback } from "../playbackCoordinator"
import { sendToRenderer } from "../rendererBridge"
import { normalizeGenreTags } from "../shared/normalize"
import { fetchOfficialArtistGenreMap } from './officialGenres'
import {
  ensureCatalogReady,
  getCatalogBrowseService,
  getCatalogIngestService,
  getCatalogRegistry,
} from "./services"

export async function enrichMissingGenreProviderArtists(providerName: CatalogProviderName): Promise<{ artists: number }> {
  const provider = getCatalogRegistry().getProvider(providerName)
  if (!provider?.capabilities.artistProfile) return { artists: 0 }
  const retryAfterSeconds = 7 * 24 * 60 * 60

  const rows = getDb().prepare(`
    WITH artist_genres AS (
      SELECT cas.catalog_artist_id AS id
      FROM catalog_artist_sources cas
      JOIN catalog_artists ca ON ca.id = cas.catalog_artist_id
      JOIN json_each(ca.genres_json) g
      WHERE cas.in_library = 1
        AND ca.genres_json IS NOT NULL AND ca.genres_json != ''
        AND TRIM(g.value) != ''
      UNION
      SELECT cas.catalog_artist_id AS id
      FROM catalog_artist_sources cas
      JOIN catalog_artist_bios cab ON cab.catalog_artist_id = cas.catalog_artist_id
      JOIN json_each(cab.genres_json) g
      WHERE cas.in_library = 1
        AND cab.genres_json IS NOT NULL AND cab.genres_json != ''
        AND TRIM(g.value) != ''
      UNION
      SELECT cae.catalog_artist_id AS id
      FROM catalog_artist_album_edges cae
      JOIN catalog_albums cal ON cal.id = cae.catalog_album_id
      JOIN catalog_album_sources cas ON cas.catalog_album_id = cae.catalog_album_id
      JOIN json_each(cal.genres_json) g
      WHERE cas.in_library = 1
        AND cal.genres_json IS NOT NULL AND cal.genres_json != ''
        AND TRIM(g.value) != ''
      UNION
      SELECT cate.catalog_artist_id AS id
      FROM catalog_artist_track_edges cate
      JOIN catalog_tracks ct ON ct.id = cate.catalog_track_id
      JOIN catalog_track_sources cts ON cts.catalog_track_id = cate.catalog_track_id
      JOIN json_each(ct.genres_json) g
      WHERE cts.in_library = 1
        AND ct.genres_json IS NOT NULL AND ct.genres_json != ''
        AND TRIM(g.value) != ''
      UNION
      SELECT cas.catalog_artist_id AS id
      FROM catalog_artist_sources cas
      JOIN catalog_field_provenance cfp ON cfp.entity_type = 'artist'
        AND cfp.catalog_id = cas.catalog_artist_id
        AND cfp.field_name = 'genres'
        AND (cfp.source IN ('local', 'itunes') OR cfp.source = cas.provider)
      JOIN json_each(cfp.value) g
      WHERE cas.in_library = 1
        AND cfp.value IS NOT NULL AND cfp.value != ''
        AND TRIM(g.value) != ''
    )
    SELECT DISTINCT cas.catalog_artist_id, cas.source_id, ca.name
    FROM catalog_artist_sources cas
    JOIN catalog_artists ca ON ca.id = cas.catalog_artist_id
    WHERE cas.provider = ?
      AND cas.in_library = 1
      AND cas.source_id IS NOT NULL
      AND cas.source_id != ''
      AND (
        cas.bundle_fetched_at IS NULL
        OR cas.bundle_fetched_at < strftime('%s', 'now') - ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM artist_genres ag WHERE ag.id = cas.catalog_artist_id
      )
    ORDER BY ca.normalized_name, ca.name
  `).all(providerName, retryAfterSeconds) as Array<{
    catalog_artist_id: string
    source_id: string
    name: string
  }>

  const recordAttempt = getDb().prepare(`
    UPDATE catalog_artist_sources
    SET bundle_fetched_at = ?
    WHERE provider = ? AND source_id = ?
  `)
  const recordCatalogAttempt = getDb().prepare(`
    UPDATE catalog_artist_sources
    SET bundle_fetched_at = ?
    WHERE catalog_artist_id = ? AND provider = ?
  `)
  let enriched = 0
  if (rows.length === 0) return { artists: 0 }
  const officialGenreMap = await fetchOfficialArtistGenreMap(providerName, rows.map((row) => row.source_id))
  // Without a genre index, one artist lookup per library artist would spend the provider's API quota.
  if (!officialGenreMap) return { artists: 0 }
  console.info(`[Puros][${providerName}] Fetching official artist metadata for ${rows.length} library artists missing genres`)
  let rateLimited = false
  for (let index = 0; index < rows.length && !rateLimited; index += 1) {
    await pauseBackgroundWorkForPlayback()
    const row = rows[index]
    const indexedGenres = officialGenreMap.get(row.source_id) ?? []
    if (indexedGenres.length > 0) {
      const catalogArtistIds = applyOfficialProviderArtistGenres(providerName, row.source_id, indexedGenres)
      const fetchedAt = Math.floor(Date.now() / 1000)
      recordAttempt.run(fetchedAt, providerName, row.source_id)
      for (const catalogArtistId of catalogArtistIds) {
        recordCatalogAttempt.run(fetchedAt, catalogArtistId, providerName)
      }
      enriched += 1
      continue
    }
    let shouldRecordAttempt = false
    const artist = await provider.getArtist(row.source_id).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      shouldRecordAttempt = /not found|404|does not exist/i.test(message)
      rateLimited = /rate.?limit|quota|429/i.test(message)
      console.warn(`[Puros][${providerName}] Artist metadata sync ${rateLimited ? 'stopped' : 'skipped'} for ${row.source_id}:`, message)
      return null
    })
    if (artist) shouldRecordAttempt = true
    const fetchedAt = Math.floor(Date.now() / 1000)
    if (shouldRecordAttempt) recordAttempt.run(fetchedAt, providerName, row.source_id)
    if (!artist) continue
    const catalogArtistId = await getCatalogIngestService().ingestProviderArtist(artist)
    recordCatalogAttempt.run(fetchedAt, catalogArtistId, providerName)
    enriched += 1
    if (index % 5 === 4) {
      sendToRenderer('catalog:changed')
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  return { artists: enriched }
}

export function setManualCatalogArtistGenres(catalogArtistId: string, genres: unknown): void {
  const normalizedGenres = normalizeGenreTags(Array.isArray(genres) ? genres : [])
  const fetchedAt = Math.floor(Date.now() / 1000)
  const genresJson = JSON.stringify(normalizedGenres)
  const result = getDb().prepare(`
    UPDATE catalog_artists
    SET genres_json = ?, fetched_at = ?
    WHERE id = ?
  `).run(genresJson, fetchedAt, catalogArtistId)
  if (result.changes === 0) throw new Error('Artist not found')
  upsertCatalogFieldProvenance(getDb(), 'artist', catalogArtistId, 'genres', 'local', {
    value: genresJson,
    confidence: 1,
    fetchedAt,
  })
}

export async function updateManualCatalogArtistGenres(
  catalogArtistId: string,
  genres: unknown,
  onChanged: () => void,
) {
  await ensureCatalogReady()
  setManualCatalogArtistGenres(catalogArtistId, genres)
  onChanged()
  return getCatalogBrowseService().getArtistPage(catalogArtistId)
}

function parseGenreJson(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    return normalizeGenreTags(JSON.parse(value) as unknown)
  } catch {
    return []
  }
}

export function preserveOfficialProviderArtistGenresFromCatalog(providerName: CatalogProviderName): { artists: number } {
  const metadataSource = providerName
  const rows = getDb().prepare(`
    SELECT cas.catalog_artist_id, cas.source_id, ca.genres_json
    FROM catalog_artist_sources cas
    JOIN catalog_artists ca ON ca.id = cas.catalog_artist_id
    WHERE cas.provider = ?
      AND cas.source_id IS NOT NULL
      AND cas.source_id != ''
      AND ca.genres_json IS NOT NULL
      AND ca.genres_json != ''
      AND EXISTS (
        SELECT 1
        FROM json_each(ca.genres_json) g
        WHERE TRIM(g.value) != ''
      )
      AND NOT EXISTS (
        SELECT 1
        FROM catalog_field_provenance cfp
        WHERE cfp.entity_type = 'artist'
          AND cfp.catalog_id = cas.catalog_artist_id
          AND cfp.field_name = 'genres'
          AND cfp.source != ?
      )
  `).all(providerName, metadataSource) as Array<{
    catalog_artist_id: string
    source_id: string
    genres_json: string | null
  }>
  if (rows.length === 0) return { artists: 0 }

  const updateSourceArtist = getDb().prepare(`
    UPDATE artists
    SET genres = CASE
      WHEN genres IS NULL OR genres = '' OR genres = '[]' THEN ?
      ELSE genres
    END
    WHERE source = ? AND source_id = ?
  `)
  const fetchedAt = Math.floor(Date.now() / 1000)
  let preserved = 0
  for (const row of rows) {
    const genres = parseGenreJson(row.genres_json)
    if (genres.length === 0) continue
    const genresJson = JSON.stringify(genres)
    updateSourceArtist.run(genresJson, providerName, row.source_id)
    upsertCatalogFieldProvenance(getDb(), 'artist', row.catalog_artist_id, 'genres', metadataSource, {
      sourceId: row.source_id,
      value: genresJson,
      confidence: 0.95,
      fetchedAt,
    })
    preserved += 1
  }
  if (preserved > 0) console.info(`[Puros][${providerName}] Preserved fetched genres for ${preserved} artists before catalog rebuild`)
  return { artists: preserved }
}

function applyOfficialProviderArtistGenres(
  providerName: CatalogProviderName,
  sourceId: string,
  genres: string[],
): string[] {
  const normalizedGenres = normalizeGenreTags(genres)
  if (normalizedGenres.length === 0) return []

  const rows = getDb().prepare(`
    SELECT catalog_artist_id
    FROM catalog_artist_sources
    WHERE provider = ? AND source_id = ?
  `).all(providerName, sourceId) as Array<{ catalog_artist_id: string }>
  if (rows.length === 0) return []

  const genresJson = JSON.stringify(normalizedGenres)
  const updateArtist = getDb().prepare(`
    UPDATE catalog_artists
    SET genres_json = ?, fetched_at = ?
    WHERE id = ?
  `)
  const updateSourceArtist = getDb().prepare(`
    UPDATE artists
    SET genres = CASE
      WHEN genres IS NULL OR genres = '' OR genres = '[]' THEN ?
      ELSE genres
    END
    WHERE source = ? AND source_id = ?
  `)
  const fetchedAt = Math.floor(Date.now() / 1000)
  const metadataSource = providerName
  updateSourceArtist.run(genresJson, providerName, sourceId)
  for (const row of rows) {
    updateArtist.run(genresJson, fetchedAt, row.catalog_artist_id)
    upsertCatalogFieldProvenance(getDb(), 'artist', row.catalog_artist_id, 'genres', metadataSource, {
      sourceId,
      value: genresJson,
      confidence: 0.95,
      fetchedAt,
    })
  }
  return rows.map((row) => row.catalog_artist_id)
}
