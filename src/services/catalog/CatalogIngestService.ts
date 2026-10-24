import type Database from 'better-sqlite3'
import type {
  CatalogCreditRole,
  CatalogAlbumIdentityInput,
  CatalogArtworkCache,
  CatalogDbContext,
  CatalogEntityType,
  CatalogIdentityInput,
  MetadataSource,
  CatalogProviderAlbum,
  CatalogProviderArtist,
  CatalogProviderArtistBundle,
  CatalogProviderName,
  CatalogProviderSearchResults,
  CatalogProviderTrack,
  CatalogTrackIdentityInput,
} from './types'
import { CatalogIdentityService } from './CatalogIdentityService'
import { inferArtistCredits, inferCreditJoinPhrase, normalizeCreditRole } from './creditHeuristics'

function nowSeconds() {
  return Math.floor(Date.now() / 1_000)
}

function norm(value: string | null | undefined) {
  return (value ?? '').toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim()
}

function toFormatColumns(formatInfo: CatalogProviderTrack['formatInfo']) {
  if (!formatInfo) {
    return {
      format: null,
      sampleRate: null,
      bitDepth: null,
      bitrate: null,
      channels: null,
      lossless: 0,
    }
  }

  return {
    format: formatInfo.format,
    sampleRate: formatInfo.sampleRate ?? null,
    bitDepth: formatInfo.bitDepth ?? null,
    bitrate: formatInfo.bitrate ?? null,
    channels: formatInfo.channels ?? null,
    lossless: formatInfo.isLossless ? 1 : 0,
  }
}

function providerMetadataSource(provider: CatalogProviderName): MetadataSource {
  return provider
}

function normalizeMetadataSource(value: string | null | undefined, fallback: MetadataSource): MetadataSource {
  return value?.trim() || fallback
}

function normalizeGenres(value: string[] | null | undefined) {
  const seen = new Set<string>()
  const genres: string[] = []
  for (const raw of value ?? []) {
    const genre = raw.trim()
    const key = norm(genre)
    if (!genre || seen.has(key)) continue
    seen.add(key)
    genres.push(genre)
  }
  return genres
}

function librarySourceToProvider(source: string | null | undefined): CatalogProviderName {
  return source === 'm3u' ? 'local' : source?.trim() || 'local'
}

export class CatalogIngestService {
  private readonly db: Database.Database
  private readonly identity: CatalogIdentityService
  private readonly rebuildSearchIndex: () => void
  private readonly artworkCache: CatalogArtworkCache
  private readonly getLocalCreditGuidanceMode: () => import('./types').CatalogLocalCreditGuidanceMode
  private readonly isProviderAvailable: (provider: CatalogProviderName) => boolean
  // Serializes catalog rebuilds. The chunked rebuild yields the event loop
  // between batches, so two overlapping rebuilds could otherwise interleave
  // their DELETE-all and repopulation. New requests during an active rebuild
  // are coalesced into a single follow-up pass.
  private rebuildInFlight: Promise<void> | null = null
  private rebuildPending = false

  constructor(options: {
    dbContext: CatalogDbContext
    artworkCache: CatalogArtworkCache
    getLocalCreditGuidanceMode: () => import('./types').CatalogLocalCreditGuidanceMode
    isProviderAvailable?: (provider: CatalogProviderName) => boolean
  }) {
    this.db = options.dbContext.db
    this.identity = new CatalogIdentityService(this.db)
    this.rebuildSearchIndex = options.dbContext.rebuildSearchIndex
    this.artworkCache = options.artworkCache
    this.getLocalCreditGuidanceMode = options.getLocalCreditGuidanceMode
    this.isProviderAvailable = options.isProviderAvailable ?? ((provider) => provider === 'local')
  }

  rebuildFromLibrarySources(): Promise<void> {
    if (this.rebuildInFlight) {
      // A rebuild is already running; flag that sources changed so it does one
      // more pass, and hand this caller the in-flight promise.
      this.rebuildPending = true
      return this.rebuildInFlight
    }
    this.rebuildInFlight = (async () => {
      do {
        this.rebuildPending = false
        await this.doRebuildFromLibrarySources()
      } while (this.rebuildPending)
    })().finally(() => {
      this.rebuildInFlight = null
    })
    return this.rebuildInFlight
  }

  /**
   * Run `perItem` over `items` in transaction-wrapped batches, yielding the
   * event loop between batches. Batching avoids a per-row commit/fsync (a big
   * speedup) while the yields keep the main process responsive so a large
   * library rebuild no longer freezes the app.
   */
  private async runBatched<T>(items: T[], batchSize: number, perItem: (item: T) => void): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)
      this.db.transaction(() => {
        for (const item of batch) perItem(item)
      })()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  private async doRebuildFromLibrarySources(): Promise<void> {
    const db = this.db
    const timestamp = nowSeconds()
    const REBUILD_BATCH_SIZE = 100
    // Refresh membership without erasing the online catalogs of other providers.
    db.transaction(() => {
      for (const kind of ['artist', 'album', 'track']) {
        db.prepare(`UPDATE catalog_${kind}_sources SET in_library = 0`).run()
      }
    })()

    const artists = db.prepare(`
      SELECT id, name, normalized_name, bio, bio_source, bio_url, genres, art_path, artwork_id, art_source, source, source_id
      FROM artists
    `).all() as Array<{
      id: string
      name: string
      normalized_name: string | null
      bio: string | null
      bio_source: string | null
      bio_url: string | null
      genres: string | null
      art_path: string | null
      artwork_id: string | null
      art_source: string | null
      source: string
      source_id: string | null
    }>

    const artistMap = new Map<string, string>()
    await this.runBatched(artists, REBUILD_BATCH_SIZE, (artist) => {
      const artistSource = librarySourceToProvider(artist.source)
      const artistSourceId = artist.source_id ?? artist.id
      const catalogArtistId = this.upsertArtist({
        provider: artistSource,
        sourceId: artistSourceId,
        name: artist.name,
        normalizedName: artist.normalized_name ?? norm(artist.name),
        localId: artist.id,
        inLibrary: true,
        providerUrl: null,
      }, {
        genres: artist.genres ? safeParseJsonArray(artist.genres) : [],
        artworkUrl: artist.art_path,
        artworkId: artist.artwork_id,
        artworkSource: normalizeMetadataSource(artist.art_source, providerMetadataSource(artistSource)),
        fetchedAt: timestamp,
      })
      if (artist.bio) {
        this.upsertArtistBio(catalogArtistId, artist.bio_source ?? 'wikipedia', {
          bio: artist.bio,
          bioUrl: artist.bio_url,
          genres: artist.genres ? safeParseJsonArray(artist.genres) : [],
          fetchedAt: timestamp,
        })
      }
      artistMap.set(artist.id, catalogArtistId)
    })

    const albums = db.prepare(`
      SELECT id, title, normalized_title, year, total_tracks, total_discs,
             album_artist_id, album_artist_name, art_path, artwork_id, art_source, genres, source, source_id, upc
      FROM albums
    `).all() as Array<{
      id: string
      title: string
      normalized_title: string | null
      year: number | null
      total_tracks: number | null
      total_discs: number | null
      album_artist_id: string | null
      album_artist_name: string | null
      art_path: string | null
      artwork_id: string | null
      art_source: string | null
      genres: string | null
      source: string
      source_id: string | null
      upc: string | null
    }>

    const albumMap = new Map<string, string>()
    await this.runBatched(albums, REBUILD_BATCH_SIZE, (album) => {
      const albumSource = librarySourceToProvider(album.source)
      const albumSourceId = album.source_id ?? album.id
      const catalogAlbumId = this.upsertAlbum({
        provider: albumSource,
        sourceId: albumSourceId,
        title: album.title,
        normalizedTitle: album.normalized_title ?? norm(album.title),
        upc: album.upc,
        releaseType: null,
        primaryArtistName: album.album_artist_name,
        primaryArtistNormalizedName: norm(album.album_artist_name),
        year: album.year,
        totalTracks: album.total_tracks,
        localId: album.id,
        inLibrary: true,
        providerUrl: null,
      }, {
        primaryArtistId: album.album_artist_id ? artistMap.get(album.album_artist_id) ?? null : null,
        primaryArtistName: album.album_artist_name,
        upc: album.upc,
        year: album.year,
        releaseType: null,
        releaseSection: null,
        genres: album.genres ? safeParseJsonArray(album.genres) : [],
        totalTracks: album.total_tracks,
        totalDiscs: album.total_discs,
        artworkUrl: album.art_path,
        artworkId: album.artwork_id,
        artworkSource: normalizeMetadataSource(album.art_source, providerMetadataSource(albumSource)),
        fetchedAt: timestamp,
      })
      albumMap.set(album.id, catalogAlbumId)
    })

    const tracks = db.prepare(`
      SELECT t.id, t.title, t.genres, t.duration_ms, t.track_number, t.disc_number,
             t.album_id, t.artist_id, t.source, t.source_id, t.isrc, t.upc, t.format, t.sample_rate,
             t.bit_depth, t.bitrate, t.channels, t.lossless, t.stream_info_fetched_at, t.unavailable_reason,
             al.title as album_title,
             ar.name as artist_name,
             al.artwork_id as album_artwork_id,
             al.art_path as album_art_path,
             al.art_source as album_art_source,
             t.artwork_id as track_artwork_id,
             t.art_path as track_art_path
      FROM tracks t
      LEFT JOIN albums al ON t.album_id = al.id
      LEFT JOIN artists ar ON t.artist_id = ar.id
    `).all() as Array<{
      id: string
      title: string
      genres: string | null
      duration_ms: number
      track_number: number | null
      disc_number: number | null
      album_id: string | null
      artist_id: string | null
      source: string
      source_id: string | null
      isrc: string | null
      upc: string | null
      format: string | null
      sample_rate: number | null
      bit_depth: number | null
      bitrate: number | null
      channels: number | null
      lossless: number
      stream_info_fetched_at: number | null
      unavailable_reason: string | null
      album_title: string | null
      artist_name: string | null
      album_artwork_id: string | null
      album_art_path: string | null
      track_artwork_id: string | null
      track_art_path: string | null
      album_art_source: string | null
    }>

    const trackArtistCredits = db.prepare(`
      SELECT track_id, artist_id, role, position
      FROM track_artists
      ORDER BY track_id, position, artist_id
    `).all() as Array<{
      track_id: string
      artist_id: string
      role: string | null
      position: number | null
    }>
    const trackArtistCreditsByTrackId = new Map<string, Array<{
      artist_id: string
      role: string | null
      position: number | null
    }>>()
    for (const credit of trackArtistCredits) {
      const existing = trackArtistCreditsByTrackId.get(credit.track_id)
      if (existing) {
        existing.push(credit)
      } else {
        trackArtistCreditsByTrackId.set(credit.track_id, [credit])
      }
    }

    const insertTrackEdge = this.db.prepare(`
        INSERT OR REPLACE INTO catalog_artist_track_edges (
          catalog_artist_id, catalog_track_id, provider, position, metadata_source, credit_role, join_phrase, confidence, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
    await this.runBatched(tracks, REBUILD_BATCH_SIZE, (track) => {
      const trackProvider = librarySourceToProvider(track.source)
      const catalogAlbumId = track.album_id ? albumMap.get(track.album_id) ?? null : null
      const catalogArtistId = track.artist_id ? artistMap.get(track.artist_id) ?? null : null
      const catalogTrackId = this.upsertTrack({
        provider: trackProvider,
        sourceId: track.source_id ?? track.id,
        title: track.title ?? 'Unknown Track',
        normalizedTitle: norm(track.title),
        isrc: track.isrc,
        upc: track.upc,
        albumId: catalogAlbumId,
        albumTitle: track.album_title,
        primaryArtistName: track.artist_name,
        primaryArtistNormalizedName: norm(track.artist_name),
        durationMs: track.duration_ms ?? 0,
        trackNumber: track.track_number,
        discNumber: track.disc_number,
        localId: track.id,
        inLibrary: true,
        providerUrl: null,
        unavailableReason: track.unavailable_reason,
      }, {
        albumId: catalogAlbumId,
        albumTitle: track.album_title,
        primaryArtistId: catalogArtistId,
        primaryArtistName: track.artist_name,
        isrc: track.isrc,
        upc: track.upc,
        durationMs: track.duration_ms ?? 0,
        trackNumber: track.track_number,
        discNumber: track.disc_number,
        // A track without album artwork keeps its own (provider thumbnail).
        artworkId: track.album_artwork_id ?? (track.album_art_path ? null : track.track_artwork_id),
        artworkUrl: track.album_art_path ?? (track.album_artwork_id ? null : track.track_art_path),
        artworkSource: normalizeMetadataSource(track.album_art_source, providerMetadataSource(trackProvider)),
        format: track.format,
        sampleRate: track.sample_rate,
        bitDepth: track.bit_depth,
        bitrate: track.bitrate,
        channels: track.channels,
        lossless: track.lossless ? 1 : 0,
        genres: track.genres ? safeParseJsonArray(track.genres) : [],
        streamInfoFetchedAt: track.stream_info_fetched_at,
        fetchedAt: timestamp,
      })

      const creditedArtistIds = (trackArtistCreditsByTrackId.get(track.id) ?? [])
        .map((credit) => ({
          catalogArtistId: artistMap.get(credit.artist_id) ?? null,
          position: credit.position ?? 0,
          role: normalizeCreditRole(credit.role),
          joinPhrase: null as string | null,
        }))
        .filter((credit): credit is { catalogArtistId: string; position: number; role: CatalogCreditRole; joinPhrase: string | null } => !!credit.catalogArtistId)

      const fallbackArtistIds = catalogArtistId ? [{ catalogArtistId, position: 0, role: 'primary' as CatalogCreditRole, joinPhrase: null }] : []
      const orderedArtistIds = [...creditedArtistIds, ...fallbackArtistIds]
      const seenArtistIds = new Set<string>()
      const dedupedCredits = orderedArtistIds.filter((credit) => {
        if (seenArtistIds.has(credit.catalogArtistId)) return false
        seenArtistIds.add(credit.catalogArtistId)
        return true
      })
      dedupedCredits.forEach((credit, index) => {
        insertTrackEdge.run(
          credit.catalogArtistId,
          catalogTrackId,
          trackProvider,
          (track.track_number ?? 0) * 100 + credit.position,
          trackProvider,
          credit.role,
          inferCreditJoinPhrase(index, dedupedCredits.map((item) => ({ role: item.role, joinPhrase: item.joinPhrase }))),
          1,
          timestamp,
        )
      })
    })

    this.rebuildSearchIndex()
  }

  async ingestProviderSearchResults(results: CatalogProviderSearchResults) {
    const artistIds = await Promise.all(results.artists.map((artist) => this.ingestProviderArtist(artist)))
    const albumIds = await Promise.all(results.albums.map((album) => this.ingestProviderAlbum(album)))
    const trackIds = await Promise.all(results.tracks.map((track) => this.ingestProviderTrack(track)))
    this.rebuildSearchIndex()
    return { artistIds, albumIds, trackIds }
  }

  async ingestProviderArtistBundle(bundle: CatalogProviderArtistBundle) {
    const owner = bundle.artist.provider
    if ([...bundle.releases, ...bundle.topTracks, ...bundle.relatedArtists, ...bundle.playlists].some(item => item.provider !== owner)) throw new Error('Artist bundle crosses provider boundaries')
    const artistId = await this.ingestProviderArtist(bundle.artist)
    this.clearArtistProviderEdges(artistId, bundle.artist.provider)
    const relatedArtistIds = await Promise.all(bundle.relatedArtists.map((artist) => this.ingestProviderArtist(artist)))
    const releaseIds = await Promise.all(
      bundle.releases.map((album) => this.ingestProviderAlbum(album, artistId)),
    )
    const topTrackIds = await Promise.all(
      bundle.topTracks.map((track) => this.ingestProviderTrack(track, undefined, artistId)),
    )

    const clearRelated = this.db.prepare(`DELETE FROM catalog_related_artists WHERE catalog_artist_id = ?`)
    const insertRelated = this.db.prepare(`
      INSERT OR REPLACE INTO catalog_related_artists (
        catalog_artist_id, related_catalog_artist_id, provider, position, metadata_source, confidence, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const fetchedAt = nowSeconds()
    clearRelated.run(artistId)
    relatedArtistIds.forEach((relatedId, index) => {
      insertRelated.run(artistId, relatedId, bundle.artist.provider, index, providerMetadataSource(bundle.artist.provider), 0.8, fetchedAt)
    })

    this.rebuildSearchIndex()
    return { artistId, releaseIds, topTrackIds, relatedArtistIds }
  }

  async ingestProviderAlbumBundle(bundle: { album: CatalogProviderAlbum; tracks: CatalogProviderTrack[] }) {
    if (bundle.tracks.some(track => track.provider !== bundle.album.provider)) throw new Error('Album bundle crosses provider boundaries')
    const albumId = await this.ingestProviderAlbum(bundle.album)
    this.clearAlbumProviderTrackEdges(albumId, bundle.album.provider)
    const trackIds = await Promise.all(
      bundle.tracks.map((track) => this.ingestProviderTrack(track, albumId)),
    )
    this.rebuildSearchIndex()
    return { albumId, trackIds }
  }

  async ingestProviderArtist(artist: CatalogProviderArtist) {
    const artworkId = await this.artworkCache.cacheRemoteArtwork(artist.artworkUrl)
    const catalogArtistId = this.upsertArtist({
      provider: artist.provider,
      sourceId: artist.sourceId,
      name: artist.name,
      normalizedName: artist.normalizedName ?? norm(artist.name),
      inLibrary: !!artist.inLibrary,
      providerUrl: artist.providerUrl ?? null,
    }, {
      genres: artist.genres ?? [],
      artworkUrl: artist.artworkUrl ?? null,
      artworkId,
      artworkSource: providerMetadataSource(artist.provider),
      fetchedAt: nowSeconds(),
    })
    if (artist.bio) {
      this.upsertArtistBio(catalogArtistId, artist.bioSource ?? artist.provider, {
        bio: artist.bio,
        bioUrl: artist.bioUrl ?? null,
        genres: artist.genres ?? [],
        fetchedAt: nowSeconds(),
      })
    }
    return catalogArtistId
  }

  async ingestProviderAlbum(album: CatalogProviderAlbum, knownArtistId?: string | null) {
    const primaryArtistId = knownArtistId ?? this.resolveOrCreateArtistFromProviderRefs({
      provider: album.provider,
      sourceId: album.primaryArtistSourceId ?? null,
      name: album.primaryArtistName ?? null,
      normalizedName: album.primaryArtistNormalizedName ?? norm(album.primaryArtistName),
      inLibrary: !!album.inLibrary,
    })
    const artworkId = await this.artworkCache.cacheRemoteArtwork(album.artworkUrl)
    const catalogAlbumId = this.upsertAlbum({
      provider: album.provider,
      sourceId: album.sourceId,
      title: album.title,
      normalizedTitle: album.normalizedTitle ?? norm(album.title),
      releaseType: album.releaseType ?? null,
      releaseSection: album.releaseSection ?? null,
      primaryArtistName: album.primaryArtistName ?? null,
      primaryArtistNormalizedName: album.primaryArtistNormalizedName ?? norm(album.primaryArtistName),
      year: album.year ?? null,
      totalTracks: album.totalTracks ?? null,
      inLibrary: !!album.inLibrary,
      providerUrl: album.providerUrl ?? null,
    }, {
      primaryArtistId,
      primaryArtistName: album.primaryArtistName ?? null,
      upc: album.upc ?? null,
      year: album.year ?? null,
      releaseType: album.releaseType ?? null,
      releaseSection: album.releaseSection ?? null,
      genres: album.genres ?? [],
      totalTracks: album.totalTracks ?? null,
      totalDiscs: album.totalDiscs ?? null,
      artworkUrl: album.artworkUrl ?? null,
      artworkId,
      artworkSource: providerMetadataSource(album.provider),
      fetchedAt: nowSeconds(),
    })

    const creditedArtists = this.resolveProviderArtists(album.provider, album.artists ?? [], !!album.inLibrary, {
      entityType: 'album',
      title: album.title,
      primaryArtistSourceId: album.primaryArtistSourceId ?? null,
      primaryArtistName: album.primaryArtistName ?? null,
    })
    const orderedArtistIds = this.buildOrderedArtistIds(creditedArtists, primaryArtistId)
    if (this.shouldApplyProviderCreditGuidance('album', catalogAlbumId, album.provider)) {
      this.clearAlbumProviderArtistEdges(catalogAlbumId, album.provider)
      this.insertAlbumArtistEdges(catalogAlbumId, album.provider, orderedArtistIds)
    }

    return catalogAlbumId
  }

  async ingestProviderTrack(
    track: CatalogProviderTrack,
    knownAlbumId?: string | null,
    knownArtistId?: string | null,
  ) {
    const primaryArtistId = knownArtistId ?? this.resolveOrCreateArtistFromProviderRefs({
      provider: track.provider,
      sourceId: track.primaryArtistSourceId ?? null,
      name: track.primaryArtistName ?? null,
      normalizedName: track.primaryArtistNormalizedName ?? norm(track.primaryArtistName),
      inLibrary: !!track.inLibrary,
    })
    const albumId = knownAlbumId ?? this.resolveOrCreateAlbumFromProviderRefs({
      provider: track.provider,
      sourceId: track.albumSourceId ?? null,
      title: track.albumTitle ?? null,
      normalizedTitle: norm(track.albumTitle),
      upc: track.upc ?? null,
      primaryArtistId,
      primaryArtistName: track.primaryArtistName ?? null,
      primaryArtistNormalizedName: track.primaryArtistNormalizedName ?? norm(track.primaryArtistName),
      inLibrary: !!track.inLibrary,
    })
    const artworkId = await this.artworkCache.cacheRemoteArtwork(track.artworkUrl)
    const providerFormatColumns = toFormatColumns(track.formatInfo ?? null)
    const catalogTrackId = this.upsertTrack({
      provider: track.provider,
      sourceId: track.sourceId,
      title: track.title,
      normalizedTitle: track.normalizedTitle ?? norm(track.title),
      isrc: track.isrc ?? null,
      upc: track.upc ?? null,
      albumId,
      albumTitle: track.albumTitle ?? null,
      primaryArtistName: track.primaryArtistName ?? null,
      primaryArtistNormalizedName: track.primaryArtistNormalizedName ?? norm(track.primaryArtistName),
      durationMs: track.durationMs,
      trackNumber: track.trackNumber ?? null,
      discNumber: track.discNumber ?? null,
      inLibrary: !!track.inLibrary,
      providerUrl: track.providerUrl ?? null,
      // Each listing replaces what the last one said.
      unavailableReason: track.playable === false ? (track.unavailableReason ?? 'other') : null,
    }, {
      albumId,
      albumTitle: track.albumTitle ?? null,
      primaryArtistId,
      primaryArtistName: track.primaryArtistName ?? null,
      isrc: track.isrc ?? null,
      upc: track.upc ?? null,
      durationMs: track.durationMs,
      trackNumber: track.trackNumber ?? null,
      discNumber: track.discNumber ?? null,
      artworkId,
      artworkUrl: track.artworkUrl ?? null,
      artworkSource: providerMetadataSource(track.provider),
      ...providerFormatColumns,
      genres: track.genres ?? [],
      fetchedAt: nowSeconds(),
    })

    const creditedArtists = this.resolveProviderArtists(track.provider, track.artists ?? [], !!track.inLibrary, {
      entityType: 'track',
      title: track.title,
      primaryArtistSourceId: track.primaryArtistSourceId ?? null,
      primaryArtistName: track.primaryArtistName ?? null,
    })
    const orderedArtistIds = this.buildOrderedArtistIds(creditedArtists, primaryArtistId)
    if (this.shouldApplyProviderCreditGuidance('track', catalogTrackId, track.provider)) {
      this.clearTrackProviderArtistEdges(catalogTrackId, track.provider)
      this.insertTrackArtistEdges(catalogTrackId, track.provider, orderedArtistIds, track.trackNumber ?? 0)
    }

    return catalogTrackId
  }

  private resolveOrCreateArtistFromProviderRefs(input: {
    provider: CatalogIdentityInput['provider']
    sourceId: string | null
    name: string | null
    normalizedName: string
    inLibrary: boolean
  }) {
    if (!input.sourceId || !input.name) return null
    return this.upsertArtist({
      provider: input.provider,
      sourceId: input.sourceId,
      name: input.name,
      normalizedName: input.normalizedName || norm(input.name),
      inLibrary: input.inLibrary,
      providerUrl: null,
    }, {
      genres: [],
      artworkUrl: null,
      artworkId: null,
      artworkSource: providerMetadataSource(input.provider),
      fetchedAt: nowSeconds(),
    })
  }

  private resolveOrCreateAlbumFromProviderRefs(input: {
    provider: CatalogAlbumIdentityInput['provider']
    sourceId: string | null
    title: string | null
    normalizedTitle: string
    upc?: string | null
    primaryArtistId: string | null
    primaryArtistName: string | null
    primaryArtistNormalizedName: string | null
    inLibrary: boolean
  }) {
    if (!input.sourceId || !input.title) return null
    return this.upsertAlbum({
      provider: input.provider,
      sourceId: input.sourceId,
      title: input.title,
      normalizedTitle: input.normalizedTitle || norm(input.title),
      upc: input.upc ?? null,
      primaryArtistName: input.primaryArtistName,
      primaryArtistNormalizedName: input.primaryArtistNormalizedName,
      year: null,
      totalTracks: null,
      inLibrary: input.inLibrary,
      providerUrl: null,
    }, {
      primaryArtistId: input.primaryArtistId,
      primaryArtistName: input.primaryArtistName,
      upc: input.upc ?? null,
      year: null,
      releaseType: null,
      releaseSection: null,
      genres: [],
      totalTracks: null,
      totalDiscs: null,
      artworkUrl: null,
      artworkId: null,
      artworkSource: providerMetadataSource(input.provider),
      fetchedAt: nowSeconds(),
    })
  }

  private resolveProviderArtists(
    provider: CatalogIdentityInput['provider'],
    artists: CatalogProviderArtist[],
    inLibrary: boolean,
    options: {
      entityType: 'album' | 'track'
      title?: string | null
      primaryArtistSourceId?: string | null
      primaryArtistName?: string | null
    },
  ): Array<{ id: string; index: number; role: CatalogCreditRole; joinPhrase: string | null }> {
    const resolved: Array<{
      id: string
      index: number
      sourceId: string | null
      name: string | null
      role: CatalogCreditRole | string | null
      joinPhrase: string | null
    }> = []

    artists.forEach((artist, index) => {
      if (artist.provider !== provider) throw new Error('Artist credit belongs to another provider')
      const id = this.resolveOrCreateArtistFromProviderRefs({
          provider,
          sourceId: artist.sourceId ?? null,
          name: artist.name ?? null,
          normalizedName: artist.normalizedName ?? norm(artist.name),
          inLibrary,
      })
      if (!id) return
      resolved.push({
        id,
        index,
        sourceId: artist.sourceId ?? null,
        name: artist.name ?? null,
        role: artist.role ?? null,
        joinPhrase: artist.joinPhrase ?? null,
      })
    })

    const inferred = inferArtistCredits({
      entityType: options.entityType,
      title: options.title ?? null,
      primaryArtistSourceId: options.primaryArtistSourceId ?? null,
      primaryArtistName: options.primaryArtistName ?? null,
      artists: resolved,
    })

    return resolved.map((artist, index) => ({
      id: artist.id,
      index: artist.index,
      role: inferred[index]?.role ?? normalizeCreditRole(artist.role),
      joinPhrase: inferred[index]?.joinPhrase ?? artist.joinPhrase,
    }))
  }

  private buildOrderedArtistIds(
    creditedArtists: Array<{ id: string; index: number; role: CatalogCreditRole; joinPhrase: string | null }>,
    primaryArtistId: string | null,
  ) {
    const ordered = [
      ...(primaryArtistId ? [{ id: primaryArtistId, index: 0, role: 'primary' as CatalogCreditRole, joinPhrase: null }] : []),
      ...creditedArtists,
    ]
    const seen = new Set<string>()
    return ordered.filter((artist) => {
      if (seen.has(artist.id)) return false
      seen.add(artist.id)
      return true
    })
  }

  private shouldApplyProviderCreditGuidance(
    entityType: 'album' | 'track',
    catalogId: string,
    provider: CatalogProviderName,
  ) {
    if (provider === 'local') return true
    if (this.getLocalCreditGuidanceMode() !== 'local_only') return true

    const table = entityType === 'album' ? 'catalog_album_sources' : 'catalog_track_sources'
    const idColumn = entityType === 'album' ? 'catalog_album_id' : 'catalog_track_id'
    const row = this.db.prepare(`
      SELECT 1 as has_local
      FROM ${table}
      WHERE ${idColumn} = ?
        AND provider = 'local'
      LIMIT 1
    `).get(catalogId) as { has_local: number } | undefined
    return !row
  }

  private insertAlbumArtistEdges(
    catalogAlbumId: string,
    provider: CatalogProviderName,
    artists: Array<{ id: string; index: number; role: CatalogCreditRole; joinPhrase: string | null }>,
  ) {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO catalog_artist_album_edges (
        catalog_artist_id, catalog_album_id, provider, position, metadata_source, credit_role, join_phrase, confidence, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const fetchedAt = nowSeconds()
    artists.forEach((artist, position) => {
      insert.run(
        artist.id,
        catalogAlbumId,
        provider,
        position,
        providerMetadataSource(provider),
        artist.role,
        inferCreditJoinPhrase(position, artists),
        0.85,
        fetchedAt,
      )
    })
  }

  private insertTrackArtistEdges(
    catalogTrackId: string,
    provider: CatalogProviderName,
    artists: Array<{ id: string; index: number; role: CatalogCreditRole; joinPhrase: string | null }>,
    trackNumber: number,
  ) {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO catalog_artist_track_edges (
        catalog_artist_id, catalog_track_id, provider, position, metadata_source, credit_role, join_phrase, confidence, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const fetchedAt = nowSeconds()
    artists.forEach((artist, position) => {
      insert.run(
        artist.id,
        catalogTrackId,
        provider,
        trackNumber * 100 + position,
        providerMetadataSource(provider),
        artist.role,
        inferCreditJoinPhrase(position, artists),
        0.85,
        fetchedAt,
      )
    })
  }

  private upsertFieldProvenance(
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
    this.db.prepare(`
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

  private upsertArtist(
    input: CatalogIdentityInput,
    payload: {
      genres: string[]
      artworkUrl: string | null
      artworkId: string | null
      artworkSource: MetadataSource
      fetchedAt: number
    },
  ) {
    const catalogArtistId = this.identity.findOrCreateArtist(input)
    this.db.prepare(`
      INSERT INTO catalog_artists (
        provider_id, source_id, id, name, normalized_name, genres_json, artwork_url, artwork_id, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        normalized_name = excluded.normalized_name,
        genres_json = CASE
          WHEN excluded.genres_json IS NOT NULL AND excluded.genres_json != '[]' THEN excluded.genres_json
          ELSE catalog_artists.genres_json
        END,
        artwork_url = COALESCE(excluded.artwork_url, catalog_artists.artwork_url),
        artwork_id = COALESCE(excluded.artwork_id, catalog_artists.artwork_id),
        fetched_at = excluded.fetched_at
    `).run(
      input.provider,
      input.sourceId,
      catalogArtistId,
      input.name,
      input.normalizedName,
      JSON.stringify(payload.genres),
      payload.artworkUrl,
      payload.artworkId,
      payload.fetchedAt,
    )

    const identitySource = providerMetadataSource(input.provider)
    this.upsertFieldProvenance('artist', catalogArtistId, 'identity', identitySource, {
      sourceId: input.sourceId,
      value: input.name,
      confidence: input.inLibrary ? 1 : 0.85,
      fetchedAt: payload.fetchedAt,
    })
    this.upsertFieldProvenance('artist', catalogArtistId, 'name', identitySource, {
      sourceId: input.sourceId,
      value: input.name,
      confidence: input.inLibrary ? 1 : 0.85,
      fetchedAt: payload.fetchedAt,
    })
    if (payload.genres.length > 0) {
      this.upsertFieldProvenance('artist', catalogArtistId, 'genres', identitySource, {
        sourceId: input.sourceId,
        value: JSON.stringify(payload.genres),
        confidence: input.inLibrary ? 1 : 0.75,
        fetchedAt: payload.fetchedAt,
      })
    }
    if (payload.artworkUrl || payload.artworkId) {
      this.upsertFieldProvenance('artist', catalogArtistId, 'artwork', payload.artworkSource, {
        sourceId: input.sourceId,
        value: payload.artworkId ?? payload.artworkUrl,
        confidence: input.inLibrary ? 1 : 0.75,
        fetchedAt: payload.fetchedAt,
      })
    }

    this.db.prepare(`
      INSERT INTO catalog_artist_sources (
        catalog_artist_id, provider, source_id, local_artist_id, in_library,
        provider_priority, match_confidence, provider_url, last_seen_at, available
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(catalog_artist_id, provider, source_id) DO UPDATE SET
        local_artist_id = COALESCE(excluded.local_artist_id, catalog_artist_sources.local_artist_id),
        in_library = CASE
          WHEN excluded.in_library = 1 THEN 1
          ELSE catalog_artist_sources.in_library
        END,
        provider_url = COALESCE(excluded.provider_url, catalog_artist_sources.provider_url),
        match_confidence = MAX(catalog_artist_sources.match_confidence, excluded.match_confidence),
        last_seen_at = excluded.last_seen_at,
        available = excluded.available
    `).run(
      catalogArtistId,
      input.provider,
      input.sourceId,
      input.localId ?? null,
      input.inLibrary ? 1 : 0,
      providerPriority(input.provider),
      input.inLibrary ? 1 : 0.85,
      input.providerUrl ?? null,
      payload.fetchedAt,
      this.isProviderAvailable(input.provider) ? 1 : 0,
    )

    return catalogArtistId
  }

  private upsertArtistBio(
    catalogArtistId: string,
    provider: string,
    payload: {
      bio: string | null
      bioUrl: string | null
      genres: string[]
      fetchedAt: number
    },
  ) {
    this.db.prepare(`
      INSERT INTO catalog_artist_bios (
        catalog_artist_id, provider, bio, bio_url, genres_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(catalog_artist_id, provider) DO UPDATE SET
        bio = COALESCE(excluded.bio, catalog_artist_bios.bio),
        bio_url = COALESCE(excluded.bio_url, catalog_artist_bios.bio_url),
        genres_json = CASE
          WHEN excluded.genres_json IS NOT NULL AND excluded.genres_json != '[]' THEN excluded.genres_json
          ELSE catalog_artist_bios.genres_json
        END,
        fetched_at = excluded.fetched_at
    `).run(
      catalogArtistId,
      provider,
      payload.bio,
      payload.bioUrl,
      JSON.stringify(payload.genres),
      payload.fetchedAt,
    )
    this.upsertFieldProvenance('artist', catalogArtistId, 'bio', normalizeMetadataSource(provider, 'wikipedia'), {
      value: payload.bio,
      confidence: payload.bio ? 0.8 : 0,
      fetchedAt: payload.fetchedAt,
    })
  }

  private upsertAlbum(
    input: CatalogAlbumIdentityInput,
    payload: {
      primaryArtistId: string | null
      primaryArtistName: string | null
      upc: string | null
      year: number | null
      releaseType: string | null
      releaseSection: string | null
      genres: string[]
      totalTracks: number | null
      totalDiscs: number | null
      artworkUrl: string | null
      artworkId: string | null
      artworkSource: MetadataSource
      fetchedAt: number
    },
  ) {
    const catalogAlbumId = this.identity.findOrCreateAlbum(input)
    this.db.prepare(`
      INSERT INTO catalog_albums (
        provider_id, source_id, id, title, normalized_title, year, release_type, release_section, total_tracks, total_discs,
        primary_artist_id, primary_artist_name, primary_artist_normalized_name, upc,
        genres_json, artwork_url, artwork_id, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        normalized_title = excluded.normalized_title,
        year = COALESCE(excluded.year, catalog_albums.year),
        release_type = COALESCE(excluded.release_type, catalog_albums.release_type),
        release_section = COALESCE(excluded.release_section, catalog_albums.release_section),
        total_tracks = COALESCE(excluded.total_tracks, catalog_albums.total_tracks),
        total_discs = COALESCE(excluded.total_discs, catalog_albums.total_discs),
        primary_artist_id = COALESCE(excluded.primary_artist_id, catalog_albums.primary_artist_id),
        primary_artist_name = COALESCE(excluded.primary_artist_name, catalog_albums.primary_artist_name),
        primary_artist_normalized_name = COALESCE(excluded.primary_artist_normalized_name, catalog_albums.primary_artist_normalized_name),
        upc = COALESCE(excluded.upc, catalog_albums.upc),
        genres_json = CASE
          WHEN excluded.genres_json IS NOT NULL AND excluded.genres_json != '[]' THEN excluded.genres_json
          ELSE catalog_albums.genres_json
        END,
        artwork_url = COALESCE(excluded.artwork_url, catalog_albums.artwork_url),
        artwork_id = COALESCE(excluded.artwork_id, catalog_albums.artwork_id),
        fetched_at = excluded.fetched_at
    `).run(
      input.provider,
      input.sourceId,
      catalogAlbumId,
      input.title,
      input.normalizedTitle,
      payload.year,
      input.releaseType ?? null,
      payload.releaseSection,
      payload.totalTracks,
      payload.totalDiscs,
      payload.primaryArtistId,
      payload.primaryArtistName,
      input.primaryArtistNormalizedName,
      payload.upc,
      JSON.stringify(normalizeGenres(payload.genres)),
      payload.artworkUrl,
      payload.artworkId,
      payload.fetchedAt,
    )

    const identitySource = providerMetadataSource(input.provider)
    this.upsertFieldProvenance('album', catalogAlbumId, 'identity', identitySource, {
      sourceId: input.sourceId,
      value: input.title,
      confidence: input.inLibrary ? 1 : 0.8,
      fetchedAt: payload.fetchedAt,
    })
    this.upsertFieldProvenance('album', catalogAlbumId, 'title', identitySource, {
      sourceId: input.sourceId,
      value: input.title,
      confidence: input.inLibrary ? 1 : 0.8,
      fetchedAt: payload.fetchedAt,
    })
    if (payload.upc) {
      this.upsertFieldProvenance('album', catalogAlbumId, 'upc', identitySource, {
        sourceId: input.sourceId,
        value: payload.upc,
        confidence: input.inLibrary ? 1 : 0.95,
        fetchedAt: payload.fetchedAt,
      })
    }
    if (payload.genres.length > 0) {
      this.upsertFieldProvenance('album', catalogAlbumId, 'genres', identitySource, {
        sourceId: input.sourceId,
        value: JSON.stringify(normalizeGenres(payload.genres)),
        confidence: input.inLibrary ? 1 : 0.8,
        fetchedAt: payload.fetchedAt,
      })
    }
    if (payload.artworkUrl || payload.artworkId) {
      this.upsertFieldProvenance('album', catalogAlbumId, 'artwork', payload.artworkSource, {
        sourceId: input.sourceId,
        value: payload.artworkId ?? payload.artworkUrl,
        confidence: input.inLibrary ? 1 : 0.75,
        fetchedAt: payload.fetchedAt,
      })
    }

    this.db.prepare(`
      INSERT INTO catalog_album_sources (
        catalog_album_id, provider, source_id, local_album_id, in_library,
        provider_priority, match_confidence, provider_url, last_seen_at, available
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(catalog_album_id, provider, source_id) DO UPDATE SET
        local_album_id = COALESCE(excluded.local_album_id, catalog_album_sources.local_album_id),
        in_library = CASE
          WHEN excluded.in_library = 1 THEN 1
          ELSE catalog_album_sources.in_library
        END,
        provider_url = COALESCE(excluded.provider_url, catalog_album_sources.provider_url),
        match_confidence = MAX(catalog_album_sources.match_confidence, excluded.match_confidence),
        last_seen_at = excluded.last_seen_at,
        available = excluded.available
    `).run(
      catalogAlbumId,
      input.provider,
      input.sourceId,
      input.localId ?? null,
      input.inLibrary ? 1 : 0,
      providerPriority(input.provider),
      input.inLibrary ? 1 : 0.8,
      input.providerUrl ?? null,
      payload.fetchedAt,
      this.isProviderAvailable(input.provider) ? 1 : 0,
    )

    if (payload.primaryArtistId) {
      this.db.prepare(`
      INSERT OR REPLACE INTO catalog_artist_album_edges (
          catalog_artist_id, catalog_album_id, provider, position, metadata_source, credit_role, join_phrase, confidence, fetched_at
        ) VALUES (?, ?, ?, 0, ?, 'primary', NULL, ?, ?)
      `).run(payload.primaryArtistId, catalogAlbumId, input.provider, identitySource, 1, payload.fetchedAt)
    }

    return catalogAlbumId
  }

  private upsertTrack(
    input: CatalogTrackIdentityInput,
    payload: {
      albumId: string | null
      albumTitle: string | null
      primaryArtistId: string | null
      primaryArtistName: string | null
      isrc: string | null
      upc: string | null
      durationMs: number
      trackNumber: number | null
      discNumber: number | null
      artworkId: string | null
      artworkUrl: string | null
      artworkSource: MetadataSource
      format: string | null
      sampleRate: number | null
      bitDepth: number | null
      bitrate: number | null
      channels: number | null
      lossless: number
      genres: string[]
      streamInfoFetchedAt?: number | null
      fetchedAt: number
    },
  ) {
    const catalogTrackId = this.identity.findOrCreateTrack(input)
    const preserveExistingFormat = input.provider !== 'local' && !!this.db.prepare(`
      SELECT 1
      FROM catalog_track_sources
      WHERE catalog_track_id = ?
        AND provider = 'local'
      LIMIT 1
    `).get(catalogTrackId)
    this.db.prepare(`
      INSERT INTO catalog_tracks (
        provider_id, source_id, id, title, normalized_title, duration_ms, track_number, disc_number,
        album_id, album_title, primary_artist_id, primary_artist_name, isrc, upc,
        primary_artist_normalized_name, artwork_url, artwork_id, format, sample_rate,
        bit_depth, bitrate, channels, lossless, genres_json, stream_info_fetched_at, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        normalized_title = excluded.normalized_title,
        duration_ms = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE catalog_tracks.duration_ms END,
        track_number = COALESCE(excluded.track_number, catalog_tracks.track_number),
        disc_number = COALESCE(excluded.disc_number, catalog_tracks.disc_number),
        album_id = COALESCE(excluded.album_id, catalog_tracks.album_id),
        album_title = COALESCE(excluded.album_title, catalog_tracks.album_title),
        primary_artist_id = COALESCE(excluded.primary_artist_id, catalog_tracks.primary_artist_id),
        primary_artist_name = COALESCE(excluded.primary_artist_name, catalog_tracks.primary_artist_name),
        isrc = COALESCE(excluded.isrc, catalog_tracks.isrc),
        upc = COALESCE(excluded.upc, catalog_tracks.upc),
        primary_artist_normalized_name = COALESCE(excluded.primary_artist_normalized_name, catalog_tracks.primary_artist_normalized_name),
        artwork_url = COALESCE(excluded.artwork_url, catalog_tracks.artwork_url),
        artwork_id = COALESCE(excluded.artwork_id, catalog_tracks.artwork_id),
        format = CASE
          WHEN ? = 1 THEN catalog_tracks.format
          WHEN catalog_tracks.stream_info_fetched_at IS NOT NULL THEN catalog_tracks.format
          ELSE COALESCE(excluded.format, catalog_tracks.format)
        END,
        sample_rate = CASE
          WHEN ? = 1 THEN catalog_tracks.sample_rate
          WHEN catalog_tracks.stream_info_fetched_at IS NOT NULL THEN catalog_tracks.sample_rate
          ELSE COALESCE(excluded.sample_rate, catalog_tracks.sample_rate)
        END,
        bit_depth = CASE
          WHEN ? = 1 THEN catalog_tracks.bit_depth
          WHEN catalog_tracks.stream_info_fetched_at IS NOT NULL THEN catalog_tracks.bit_depth
          ELSE COALESCE(excluded.bit_depth, catalog_tracks.bit_depth)
        END,
        bitrate = CASE
          WHEN ? = 1 THEN catalog_tracks.bitrate
          WHEN catalog_tracks.stream_info_fetched_at IS NOT NULL THEN catalog_tracks.bitrate
          ELSE COALESCE(excluded.bitrate, catalog_tracks.bitrate)
        END,
        channels = CASE
          WHEN ? = 1 THEN catalog_tracks.channels
          WHEN catalog_tracks.stream_info_fetched_at IS NOT NULL THEN catalog_tracks.channels
          ELSE COALESCE(excluded.channels, catalog_tracks.channels)
        END,
        lossless = CASE
          WHEN ? = 1 THEN catalog_tracks.lossless
          WHEN catalog_tracks.stream_info_fetched_at IS NOT NULL THEN catalog_tracks.lossless
          WHEN excluded.lossless = 1 THEN 1
          ELSE catalog_tracks.lossless
        END,
        genres_json = CASE
          WHEN excluded.genres_json IS NOT NULL AND excluded.genres_json != '[]' THEN excluded.genres_json
          ELSE catalog_tracks.genres_json
        END,
        stream_info_fetched_at = COALESCE(catalog_tracks.stream_info_fetched_at, excluded.stream_info_fetched_at),
        fetched_at = excluded.fetched_at
    `).run(
      input.provider,
      input.sourceId,
      catalogTrackId,
      input.title,
      input.normalizedTitle,
      payload.durationMs,
      payload.trackNumber,
      payload.discNumber,
      payload.albumId,
      payload.albumTitle,
      payload.primaryArtistId,
      payload.primaryArtistName,
      payload.isrc,
      payload.upc,
      input.primaryArtistNormalizedName,
      payload.artworkUrl,
      payload.artworkId,
      payload.format,
      payload.sampleRate,
      payload.bitDepth,
      payload.bitrate,
      payload.channels,
      payload.lossless,
      JSON.stringify(normalizeGenres(payload.genres)),
      payload.streamInfoFetchedAt ?? null,
      payload.fetchedAt,
      preserveExistingFormat ? 1 : 0,
      preserveExistingFormat ? 1 : 0,
      preserveExistingFormat ? 1 : 0,
      preserveExistingFormat ? 1 : 0,
      preserveExistingFormat ? 1 : 0,
      preserveExistingFormat ? 1 : 0,
    )

    const identitySource = providerMetadataSource(input.provider)
    this.upsertFieldProvenance('track', catalogTrackId, 'identity', identitySource, {
      sourceId: input.sourceId,
      value: input.title,
      confidence: input.inLibrary ? 1 : 0.75,
      fetchedAt: payload.fetchedAt,
    })
    this.upsertFieldProvenance('track', catalogTrackId, 'title', identitySource, {
      sourceId: input.sourceId,
      value: input.title,
      confidence: input.inLibrary ? 1 : 0.75,
      fetchedAt: payload.fetchedAt,
    })
    if (payload.isrc) {
      this.upsertFieldProvenance('track', catalogTrackId, 'isrc', identitySource, {
        sourceId: input.sourceId,
        value: payload.isrc,
        confidence: input.inLibrary ? 1 : 0.98,
        fetchedAt: payload.fetchedAt,
      })
    }
    if (payload.upc) {
      this.upsertFieldProvenance('track', catalogTrackId, 'upc', identitySource, {
        sourceId: input.sourceId,
        value: payload.upc,
        confidence: input.inLibrary ? 1 : 0.92,
        fetchedAt: payload.fetchedAt,
      })
    }
    if (payload.genres.length > 0) {
      this.upsertFieldProvenance('track', catalogTrackId, 'genres', identitySource, {
        sourceId: input.sourceId,
        value: JSON.stringify(normalizeGenres(payload.genres)),
        confidence: input.inLibrary ? 1 : 0.8,
        fetchedAt: payload.fetchedAt,
      })
    }
    if (payload.artworkUrl || payload.artworkId) {
      this.upsertFieldProvenance('track', catalogTrackId, 'artwork', payload.artworkSource, {
        sourceId: input.sourceId,
        value: payload.artworkId ?? payload.artworkUrl,
        confidence: input.inLibrary ? 1 : 0.7,
        fetchedAt: payload.fetchedAt,
      })
    }
    if (payload.format || payload.sampleRate || payload.bitDepth || payload.bitrate) {
      this.upsertFieldProvenance('track', catalogTrackId, 'format', identitySource, {
        sourceId: input.sourceId,
        value: JSON.stringify({
          format: payload.format,
          sampleRate: payload.sampleRate,
          bitDepth: payload.bitDepth,
          bitrate: payload.bitrate,
          channels: payload.channels,
        }),
        confidence: input.inLibrary ? 1 : 0.75,
        fetchedAt: payload.fetchedAt,
      })
    }

    this.db.prepare(`
      INSERT INTO catalog_track_sources (
        catalog_track_id, provider, source_id, local_track_id, in_library,
        provider_priority, match_confidence, provider_url, last_seen_at, available, unavailable_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(catalog_track_id, provider, source_id) DO UPDATE SET
        local_track_id = COALESCE(excluded.local_track_id, catalog_track_sources.local_track_id),
        in_library = CASE
          WHEN excluded.in_library = 1 THEN 1
          ELSE catalog_track_sources.in_library
        END,
        provider_url = COALESCE(excluded.provider_url, catalog_track_sources.provider_url),
        match_confidence = MAX(catalog_track_sources.match_confidence, excluded.match_confidence),
        last_seen_at = excluded.last_seen_at,
        available = excluded.available,
        unavailable_reason = excluded.unavailable_reason
    `).run(
      catalogTrackId,
      input.provider,
      input.sourceId,
      input.localId ?? null,
      input.inLibrary ? 1 : 0,
      providerPriority(input.provider),
      input.inLibrary ? 1 : 0.75,
      input.providerUrl ?? null,
      payload.fetchedAt,
      this.isProviderAvailable(input.provider) ? 1 : 0,
      input.unavailableReason ?? null,
    )

    if (payload.albumId) {
      this.db.prepare(`
      INSERT OR REPLACE INTO catalog_album_track_edges (
          catalog_album_id, catalog_track_id, provider, position, disc_number, metadata_source, confidence, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payload.albumId,
        catalogTrackId,
        input.provider,
        input.trackNumber ?? 0,
        input.discNumber ?? 1,
        identitySource,
        input.inLibrary ? 1 : 0.75,
        payload.fetchedAt,
      )
    }

    if (payload.primaryArtistId) {
      this.db.prepare(`
      INSERT OR REPLACE INTO catalog_artist_track_edges (
          catalog_artist_id, catalog_track_id, provider, position, metadata_source, credit_role, join_phrase, confidence, fetched_at
        ) VALUES (?, ?, ?, ?, ?, 'primary', NULL, ?, ?)
      `).run(
        payload.primaryArtistId,
        catalogTrackId,
        input.provider,
        input.trackNumber ?? 0,
        identitySource,
        input.inLibrary ? 1 : 0.75,
        payload.fetchedAt,
      )
    }

    return catalogTrackId
  }

  private clearArtistProviderEdges(catalogArtistId: string, provider: CatalogProviderArtist['provider']) {
    this.db.prepare(`
      DELETE FROM catalog_artist_album_edges
      WHERE catalog_artist_id = ? AND provider = ?
    `).run(catalogArtistId, provider)

    this.db.prepare(`
      DELETE FROM catalog_artist_track_edges
      WHERE catalog_artist_id = ? AND provider = ?
    `).run(catalogArtistId, provider)
  }

  private clearAlbumProviderTrackEdges(catalogAlbumId: string, provider: CatalogProviderAlbum['provider']) {
    this.db.prepare(`
      DELETE FROM catalog_album_track_edges
      WHERE catalog_album_id = ? AND provider = ?
    `).run(catalogAlbumId, provider)
  }

  private clearAlbumProviderArtistEdges(catalogAlbumId: string, provider: CatalogProviderAlbum['provider']) {
    this.db.prepare(`
      DELETE FROM catalog_artist_album_edges
      WHERE catalog_album_id = ? AND provider = ?
    `).run(catalogAlbumId, provider)
  }

  private clearTrackProviderArtistEdges(catalogTrackId: string, provider: CatalogProviderTrack['provider']) {
    this.db.prepare(`
      DELETE FROM catalog_artist_track_edges
      WHERE catalog_track_id = ? AND provider = ?
    `).run(catalogTrackId, provider)
  }
}

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function providerPriority(provider: CatalogProviderName) {
  return provider === 'local' ? 0 : 1
}
