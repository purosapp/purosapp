import type Database from "better-sqlite3"
import type {
  CatalogAlbumArtworkProvider,
  CatalogArtistArtworkProvider,
  CatalogEntityType,
  CatalogRegistry,
} from "../../../src/services/catalog"
import { cacheRemoteArtwork } from "../artwork/cache"
import { getDb } from "../db"
import { pauseBackgroundWorkForPlayback, waitForPlaybackIdle } from "../playbackCoordinator"
import { sendToRenderer } from "../rendererBridge"
import { getAlbumArtworkSourcePriority, getArtistArtworkSourcePriority } from "../settings/store"
import {
  ARTIST_BIO_MIN_SCORE,
  ensureCatalogArtistBioPriority,
  fetchBestWikipediaArtistCandidate,
  namesLikelyMatch,
  titlesLikelyMatch,
} from "./bios"
import {
  enqueueMetadataTask,
  ensureCatalogArtistCanonicalMatch,
  ensureCatalogEntityCanonicalMatch,
  musicBrainzSpineClient,
  normalizeCanonicalStatus,
  upsertCatalogFieldProvenance,
} from "./canonical"

type MetadataArtworkDeps = {
  getCatalogRegistry: () => CatalogRegistry
}

let metadataArtworkDeps: MetadataArtworkDeps | null = null
let artworkBackfillPromise: Promise<{ artists: number; albums: number }> | null = null
let metadataSpineBackfillPromise: Promise<void> | null = null

export function configureMetadataArtwork(deps: MetadataArtworkDeps) {
  metadataArtworkDeps = deps
}

function getMetadataArtworkDeps(): MetadataArtworkDeps {
  if (!metadataArtworkDeps) throw new Error("Metadata artwork is not configured")
  return metadataArtworkDeps
}

export function resetMetadataBackfills() {
  artworkBackfillPromise = null
  metadataSpineBackfillPromise = null
}

async function fetchWikipediaArtistArtwork(
  artistName: string,
  options?: { preferredTitles?: string[] | null },
): Promise<{ artworkUrl: string | null; sourceUrl: string | null } | null> {
  const { candidate, score } = await fetchBestWikipediaArtistCandidate(artistName, { preferredTitles: options?.preferredTitles ?? null })
  if (!candidate?.imageUrl || score < ARTIST_BIO_MIN_SCORE) return null
  return {
    artworkUrl: candidate.imageUrl,
    sourceUrl: candidate.sourceUrl,
  }
}

async function fetchProviderArtistArtwork(providerId: string, artistName: string): Promise<string | null> {
  const provider = getMetadataArtworkDeps().getCatalogRegistry().getProvider(providerId)
  if (!provider || !(await provider.isAuthenticated().catch(() => false))) return null
  const results = await provider.search(artistName, { limit: 8 }).catch(() => null)
  const match = results?.artists.find((artist) => namesLikelyMatch(artist.name, artistName))
  return match?.artworkUrl ?? null
}

async function fetchItunesArtistArtwork(artistName: string): Promise<string | null> {
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=musicArtist&limit=8`,
    { headers: { 'User-Agent': 'Puros/1.0' } },
  )
  if (!res.ok) return null

  const data = await res.json() as {
    results?: Array<{
      wrapperType?: string
      artistType?: string
      artistName?: string
      artworkUrl100?: string
    }>
  }

  const match = (data.results ?? [])
    .filter((r) => r.wrapperType === 'artist')
    .find((r) => namesLikelyMatch(r.artistName, artistName))

  if (!match?.artworkUrl100) return null
  // Upgrade from 100x100 thumbnail to 1000x1000
  return match.artworkUrl100.replace(/\/\d+x\d+bb\./, '/1000x1000bb.')
}

async function fetchProviderAlbumArtwork(
  providerId: string,
  albumTitle: string,
  artistName: string | null | undefined,
): Promise<string | null> {
  const provider = getMetadataArtworkDeps().getCatalogRegistry().getProvider(providerId)
  if (!provider || !(await provider.isAuthenticated().catch(() => false))) return null
  const query = [artistName, albumTitle].filter(Boolean).join(' ')
  const results = await provider.search(query || albumTitle, { limit: 10 }).catch(() => null)
  const match = results?.albums.find((album) =>
    titlesLikelyMatch(album.title, albumTitle) &&
    namesLikelyMatch(album.primaryArtistName, artistName),
  )
  return match?.artworkUrl ?? null
}

async function fetchCoverArtArchiveAlbumArtworkByReleaseGroupId(releaseGroupId: string): Promise<string | null> {
  const artRes = await fetch(
    `https://coverartarchive.org/release-group/${encodeURIComponent(releaseGroupId)}`,
    { headers: { 'User-Agent': 'Puros/1.0' } },
  )
  if (!artRes.ok) return null

  const artData = await artRes.json() as {
    images?: Array<{
      front?: boolean
      image?: string | null
      thumbnails?: Record<string, string | null> | null
    }>
  }
  const image = artData.images?.find((candidate) => candidate.front) ?? artData.images?.[0]
  return image?.thumbnails?.['500']
    ?? image?.thumbnails?.large
    ?? image?.thumbnails?.['250']
    ?? image?.image
    ?? null
}

function applyCatalogArtistArtwork(
  db: Database.Database,
  catalogArtistId: string,
  artworkUrl: string | null,
  artworkId: string | null,
  source: CatalogArtistArtworkProvider,
) {
  const nowSec = Math.floor(Date.now() / 1000)
  db.prepare(`
    UPDATE catalog_artists
    SET artwork_url = COALESCE(?, artwork_url),
        artwork_id = COALESCE(?, artwork_id),
        fetched_at = ?
    WHERE id = ?
  `).run(artworkUrl, artworkId, nowSec, catalogArtistId)
  upsertCatalogFieldProvenance(db, 'artist', catalogArtistId, 'artwork', source === 'none' ? 'local' : source, {
    value: artworkId ?? artworkUrl,
    confidence: 0.8,
    fetchedAt: nowSec,
  })

  if (artworkId) {
    db.prepare(`
      UPDATE artists
      SET artwork_id = COALESCE(?, artwork_id),
          art_source = ?
      WHERE id IN (
        SELECT local_artist_id
        FROM catalog_artist_sources
        WHERE catalog_artist_id = ?
          AND local_artist_id IS NOT NULL
      )
    `).run(artworkId, source, catalogArtistId)
  }
}

function applyCatalogAlbumArtwork(
  db: Database.Database,
  catalogAlbumId: string,
  artworkUrl: string | null,
  artworkId: string | null,
  source: CatalogAlbumArtworkProvider,
) {
  const nowSec = Math.floor(Date.now() / 1000)
  db.prepare(`
    UPDATE catalog_albums
    SET artwork_url = COALESCE(?, artwork_url),
        artwork_id = COALESCE(?, artwork_id),
        fetched_at = ?
    WHERE id = ?
  `).run(artworkUrl, artworkId, nowSec, catalogAlbumId)
  upsertCatalogFieldProvenance(db, 'album', catalogAlbumId, 'artwork', source === 'none' ? 'local' : source, {
    value: artworkId ?? artworkUrl,
    confidence: 0.8,
    fetchedAt: nowSec,
  })

  db.prepare(`
    UPDATE catalog_tracks
    SET artwork_url = COALESCE(?, artwork_url),
        artwork_id = COALESCE(?, artwork_id),
        fetched_at = ?
    WHERE album_id = ?
      AND artwork_id IS NULL
  `).run(artworkUrl, artworkId, nowSec, catalogAlbumId)

  if (artworkId) {
    db.prepare(`
      UPDATE albums
      SET artwork_id = COALESCE(?, artwork_id),
          art_source = ?
      WHERE id IN (
        SELECT local_album_id
        FROM catalog_album_sources
        WHERE catalog_album_id = ?
          AND local_album_id IS NOT NULL
      )
    `).run(artworkId, source, catalogAlbumId)
  }
}

export async function ensureCatalogArtistArtworkPriority(db: Database.Database, catalogArtistId: string, options?: { force?: boolean }): Promise<boolean> {
  const artist = db.prepare(`
    SELECT id, name, artwork_url, artwork_id, mb_artist_id
    FROM catalog_artists
    WHERE id = ?
    LIMIT 1
  `).get(catalogArtistId) as {
    id: string
    name: string
    artwork_url: string | null
    artwork_id: string | null
    mb_artist_id: string | null
  } | undefined
  if (!artist) return false
  if (!options?.force && (artist.artwork_id || artist.artwork_url)) return false

  for (const source of getArtistArtworkSourcePriority(db)) {
    if (source === 'none') break

    let artworkUrl: string | null = null
    if (source === 'wikipedia') {
      const preferredTitles = artist.mb_artist_id
        ? await musicBrainzSpineClient.getArtistWikipediaSeedTitles(artist.mb_artist_id).catch(() => [])
        : []
      artworkUrl = (await fetchWikipediaArtistArtwork(artist.name, { preferredTitles }))?.artworkUrl ?? null
    } else if (source === 'itunes') {
      artworkUrl = await fetchItunesArtistArtwork(artist.name)
    } else {
      artworkUrl = await fetchProviderArtistArtwork(source, artist.name)
    }

    if (!artworkUrl) continue

    const artworkId = await cacheRemoteArtwork(artworkUrl)
    applyCatalogArtistArtwork(db, catalogArtistId, artworkUrl, artworkId, source)
    return true
  }

  return false
}

export async function ensureCatalogAlbumArtworkPriority(db: Database.Database, catalogAlbumId: string, options?: { force?: boolean }): Promise<boolean> {
  const album = db.prepare(`
    SELECT id, title, primary_artist_name, artwork_url, artwork_id, mb_release_group_id
    FROM catalog_albums
    WHERE id = ?
    LIMIT 1
  `).get(catalogAlbumId) as {
    id: string
    title: string
    primary_artist_name: string | null
    artwork_url: string | null
    artwork_id: string | null
    mb_release_group_id: string | null
  } | undefined
  if (!album) return false
  if (!options?.force && (album.artwork_id || album.artwork_url)) return false

  for (const source of getAlbumArtworkSourcePriority(db)) {
    if (source === 'none') break

    let artworkUrl: string | null = null
    if (source === 'coverartarchive') {
      if (!album.mb_release_group_id) continue
      artworkUrl = await fetchCoverArtArchiveAlbumArtworkByReleaseGroupId(album.mb_release_group_id)
    } else {
      artworkUrl = await fetchProviderAlbumArtwork(source, album.title, album.primary_artist_name)
    }

    if (!artworkUrl) continue

    const artworkId = await cacheRemoteArtwork(artworkUrl)
    applyCatalogAlbumArtwork(db, catalogAlbumId, artworkUrl, artworkId, source)
    return true
  }

  return false
}

async function ensureCatalogEntityMetadataFoundation(
  db: Database.Database,
  entityType: CatalogEntityType,
  catalogId: string,
  options?: { forceCanonical?: boolean; forceEnrichment?: boolean },
): Promise<void> {
  await ensureCatalogEntityCanonicalMatch(db, entityType, catalogId, { force: options?.forceCanonical })

  if (entityType === 'artist') {
    await ensureCatalogArtistBioPriority(db, catalogId, { force: options?.forceEnrichment })
    await ensureCatalogArtistArtworkPriority(db, catalogId, { force: options?.forceEnrichment })
    return
  }

  if (entityType === 'album') {
    await ensureCatalogAlbumArtworkPriority(db, catalogId, { force: options?.forceEnrichment })
  }
}

export async function runCatalogMetadataTask(
  entityType: CatalogEntityType,
  catalogId: string,
  options?: { forceCanonical?: boolean; forceEnrichment?: boolean },
) {
  await enqueueMetadataTask(`metadata:${entityType}:${catalogId}:${options?.forceCanonical ? 'reid' : 'steady'}:${options?.forceEnrichment ? 'refresh' : 'keep'}`, async () => {
    await ensureCatalogEntityMetadataFoundation(getDb(), entityType, catalogId, options)
  })
}

export function scheduleCatalogArtistEnrichment(
  catalogArtistId: string,
  onChanged: () => void,
): void {
  void enqueueMetadataTask(`enrich:artist:${catalogArtistId}`, async () => {
    const db = getDb()
    let changed = false

    // Canonical match (only when status is still 'none')
    const preMatch = db.prepare(`
      SELECT canonical_match_status, canonical_locked, mb_artist_id FROM catalog_artists WHERE id = ?
    `).get(catalogArtistId) as { canonical_match_status: string | null; canonical_locked: number; mb_artist_id: string | null } | undefined
    if (preMatch && !preMatch.canonical_locked && normalizeCanonicalStatus(preMatch.canonical_match_status) === 'none') {
      await ensureCatalogArtistCanonicalMatch(db, catalogArtistId)
      const postMatch = db.prepare(`SELECT mb_artist_id, canonical_match_status FROM catalog_artists WHERE id = ?`).get(catalogArtistId) as { mb_artist_id: string | null; canonical_match_status: string | null } | undefined
      if (postMatch?.mb_artist_id) {
        // Invalidate empty bio cache so next step can use MB seed titles
        db.prepare(`UPDATE catalog_artist_bios SET fetched_at = NULL WHERE catalog_artist_id = ? AND provider = 'wikipedia' AND bio IS NULL`).run(catalogArtistId)
        changed = true
      }
    }

    // Bio
    const hasBioBefore = !!(db.prepare(`SELECT 1 FROM catalog_artist_bios WHERE catalog_artist_id = ? AND bio IS NOT NULL LIMIT 1`).get(catalogArtistId))
    await ensureCatalogArtistBioPriority(db, catalogArtistId)
    const hasBioAfter = !!(db.prepare(`SELECT 1 FROM catalog_artist_bios WHERE catalog_artist_id = ? AND bio IS NOT NULL LIMIT 1`).get(catalogArtistId))
    if (!hasBioBefore && hasBioAfter) changed = true

    // Artwork
    const artworkFetched = await ensureCatalogArtistArtworkPriority(db, catalogArtistId)
    if (artworkFetched) changed = true

    if (changed) onChanged()
  })
}

export function scheduleCatalogAlbumEnrichment(
  catalogAlbumId: string,
  onChanged: () => void,
): void {
  void enqueueMetadataTask(`enrich:album:${catalogAlbumId}`, async () => {
    const artworkFetched = await ensureCatalogAlbumArtworkPriority(getDb(), catalogAlbumId)
    if (artworkFetched) onChanged()
  })
}

export async function enrichCatalogArtistForPage(catalogArtistId: string): Promise<void> {
  const db = getDb()

  // Run canonical match first so bio/artwork get mb_artist_id seed titles
  const preMatch = db.prepare(`
    SELECT canonical_match_status, canonical_locked, mb_artist_id FROM catalog_artists WHERE id = ?
  `).get(catalogArtistId) as { canonical_match_status: string | null; canonical_locked: number; mb_artist_id: string | null } | undefined
  if (preMatch && !preMatch.canonical_locked && normalizeCanonicalStatus(preMatch.canonical_match_status) === 'none') {
    await ensureCatalogArtistCanonicalMatch(db, catalogArtistId)
    // If canonical match now set mb_artist_id, invalidate any cached empty bio so
    // the next bio step can use the seed titles from MusicBrainz
    const postMatch = db.prepare(`SELECT mb_artist_id FROM catalog_artists WHERE id = ?`).get(catalogArtistId) as { mb_artist_id: string | null } | undefined
    if (postMatch?.mb_artist_id) {
      db.prepare(`
        UPDATE catalog_artist_bios
        SET fetched_at = NULL
        WHERE catalog_artist_id = ? AND provider = 'wikipedia' AND bio IS NULL
      `).run(catalogArtistId)
    }
  }

  await ensureCatalogArtistBioPriority(db, catalogArtistId)
  await ensureCatalogArtistArtworkPriority(db, catalogArtistId)
}

export async function scheduleMetadataSpineBackfill() {
  if (metadataSpineBackfillPromise) return metadataSpineBackfillPromise

  metadataSpineBackfillPromise = (async () => {
    const db = getDb()
    const artists = db.prepare(`
      SELECT id
      FROM catalog_artists
      WHERE EXISTS (
        SELECT 1 FROM catalog_artist_sources cas
        WHERE cas.catalog_artist_id = catalog_artists.id
          AND cas.in_library = 1
      )
      ORDER BY normalized_name, name
    `).all() as Array<{ id: string }>

    for (const row of artists) {
      await runCatalogMetadataTask('artist', row.id)
    }

    const albums = db.prepare(`
      SELECT id
      FROM catalog_albums
      WHERE EXISTS (
        SELECT 1 FROM catalog_album_sources cas
        WHERE cas.catalog_album_id = catalog_albums.id
          AND cas.in_library = 1
      )
      ORDER BY normalized_title, title
    `).all() as Array<{ id: string }>

    for (const row of albums) {
      await runCatalogMetadataTask('album', row.id)
    }

    const tracks = db.prepare(`
      SELECT id
      FROM catalog_tracks
      WHERE EXISTS (
        SELECT 1 FROM catalog_track_sources cts
        WHERE cts.catalog_track_id = catalog_tracks.id
          AND cts.in_library = 1
      )
      ORDER BY album_title, disc_number, track_number, title
    `).all() as Array<{ id: string }>

    for (const row of tracks) {
      await runCatalogMetadataTask('track', row.id)
    }

    sendToRenderer('catalog:changed')
  })()

  try {
    await metadataSpineBackfillPromise
  } finally {
    metadataSpineBackfillPromise = null
  }
}

export async function clearMetadataCacheOnly(db: Database.Database) {
  db.exec(`
    DELETE FROM catalog_field_provenance;
    DELETE FROM catalog_artist_bios;

    UPDATE catalog_artists
    SET mb_artist_id = NULL,
        canonical_match_status = 'none',
        canonical_match_confidence = 0,
        canonical_match_source = NULL,
        canonical_fetched_at = NULL,
        canonical_locked = 0,
        artwork_url = NULL,
        artwork_id = NULL,
        fetched_at = NULL,
        expires_at = NULL;

    UPDATE catalog_albums
    SET mb_release_group_id = NULL,
        mb_release_id = NULL,
        canonical_match_status = 'none',
        canonical_match_confidence = 0,
        canonical_match_source = NULL,
        canonical_fetched_at = NULL,
        canonical_locked = 0,
        artwork_url = NULL,
        artwork_id = NULL,
        fetched_at = NULL,
        expires_at = NULL;

    UPDATE catalog_tracks
    SET mb_recording_id = NULL,
        mb_release_id = NULL,
        canonical_match_status = 'none',
        canonical_match_confidence = 0,
        canonical_match_source = NULL,
        canonical_fetched_at = NULL,
        canonical_locked = 0,
        artwork_url = NULL,
        artwork_id = NULL,
        fetched_at = NULL,
        expires_at = NULL;
  `)
}

async function backfillMissingArtwork(db: Database.Database): Promise<{ artists: number; albums: number }> {
  await waitForPlaybackIdle()
  const artistRows = db.prepare(`
    SELECT id
    FROM catalog_artists
    WHERE artwork_id IS NULL
      AND artwork_url IS NULL
      AND EXISTS (
        SELECT 1
        FROM catalog_artist_sources cas
        WHERE cas.catalog_artist_id = catalog_artists.id
          AND cas.in_library = 1
      )
    ORDER BY normalized_name, name
  `).all() as Array<{ id: string }>

  const albumRows = db.prepare(`
    SELECT id
    FROM catalog_albums
    WHERE artwork_id IS NULL
      AND artwork_url IS NULL
      AND EXISTS (
        SELECT 1
        FROM catalog_album_sources cas
        WHERE cas.catalog_album_id = catalog_albums.id
          AND cas.in_library = 1
      )
    ORDER BY COALESCE(primary_artist_normalized_name, ''), normalized_title, title
  `).all() as Array<{ id: string }>

  let updatedArtists = 0
  let updatedAlbums = 0

  for (const row of artistRows) {
    await pauseBackgroundWorkForPlayback()
    if (await ensureCatalogArtistArtworkPriority(db, row.id)) updatedArtists += 1
  }
  for (const row of albumRows) {
    await pauseBackgroundWorkForPlayback()
    if (await ensureCatalogAlbumArtworkPriority(db, row.id)) updatedAlbums += 1
  }

  return { artists: updatedArtists, albums: updatedAlbums }
}

export function scheduleArtworkBackfill() {
  if (artworkBackfillPromise) return artworkBackfillPromise

  artworkBackfillPromise = (async () => {
    try {
      const result = await backfillMissingArtwork(getDb())
      if (result.artists > 0 || result.albums > 0) {
        sendToRenderer('catalog:changed')
        sendToRenderer('library:changed')
      }
      return result
    } finally {
      artworkBackfillPromise = null
    }
  })()

  return artworkBackfillPromise
}
