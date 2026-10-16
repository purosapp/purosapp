import type Database from 'better-sqlite3'
import type { CatalogBrowseScope, CatalogSearchResults, CatalogArtistSummary, CatalogAlbumSummary, CatalogTrackSummary, CatalogGenreSummary } from './types'
import { CatalogIngestService } from './CatalogIngestService'
import { CatalogBrowseService } from './CatalogBrowseService'
import { CatalogRegistry } from './CatalogRegistry'

export class CatalogSearchService {
  private readonly db: Database.Database
  private readonly registry: CatalogRegistry
  private readonly ingest: CatalogIngestService
  private readonly browseService: CatalogBrowseService
  constructor(options: { db: Database.Database; registry: CatalogRegistry; ingest: CatalogIngestService; browse: CatalogBrowseService; getShowUnavailableSources?: () => boolean }) {
    this.db = options.db; this.registry = options.registry; this.ingest = options.ingest; this.browseService = options.browse
  }
  private validate(providerId: string) {
    if (typeof providerId !== 'string' || !providerId.trim() || providerId === 'all' || providerId === 'library') throw new Error('Choose a provider before browsing the catalog')
  }
  private rows(kind: 'artist' | 'album' | 'track', providerId: string, scope: CatalogBrowseScope, limit: number, query = '') {
    this.validate(providerId)
    const plural = kind === 'artist' ? 'artists' : `${kind}s`
    const title = kind === 'artist' ? 'name' : 'title'
    const extra = kind === 'artist' ? '' : `OR e.primary_artist_name LIKE @term ${kind === 'track' ? 'OR e.album_title LIKE @term' : ''}`
    return this.db.prepare(`SELECT e.id FROM catalog_${plural} e WHERE e.provider_id = @provider
      AND (@query = '' OR e.${title} LIKE @term ${extra})
      AND (@scope = 'all' OR EXISTS (SELECT 1 FROM catalog_${kind}_sources s WHERE s.catalog_${kind}_id = e.id AND s.provider = @provider AND s.in_library = 1))
      ORDER BY CASE WHEN lower(e.${title}) = lower(@query) THEN 0 ELSE 1 END, e.${title}, e.id LIMIT @limit`).all({ provider: providerId, scope, query, term: `%${query}%`, limit: Math.max(1, Math.min(10000, Math.trunc(limit))) }) as { id: string }[]
  }
  browseArtists(providerId: string, scope: CatalogBrowseScope = 'library', limit = 2000, query = ''): CatalogArtistSummary[] {
    return this.rows('artist', providerId, scope, limit, query).map(r => { const artist = this.browseService.getArtistSearchSummary(r.id); return artist ? { ...artist, ...this.browseService.getArtistCounts(r.id, scope) } : null }).filter((a): a is CatalogArtistSummary => !!a)
  }
  browseAlbums(providerId: string, scope: CatalogBrowseScope = 'library', limit = 2000, query = ''): CatalogAlbumSummary[] {
    return this.rows('album', providerId, scope, limit, query).map(r => this.browseService.getAlbumSummary(r.id)).filter((a): a is CatalogAlbumSummary => !!a)
  }
  browseTracks(providerId: string, scope: CatalogBrowseScope = 'library', limit = 2000, query = ''): CatalogTrackSummary[] {
    return this.rows('track', providerId, scope, limit, query).map(r => this.browseService.getTrackSummary(r.id)).filter((t): t is CatalogTrackSummary => !!t)
  }
  browse(providerId: string, scope: CatalogBrowseScope = 'all', limit = 24): CatalogSearchResults {
    return { artists: this.browseArtists(providerId, scope, limit), albums: this.browseAlbums(providerId, scope, limit), tracks: this.browseTracks(providerId, scope, limit), playlists: [] }
  }
  searchLocalOnly(providerId: string, query: string, limit = 12, scope: CatalogBrowseScope = 'all'): CatalogSearchResults {
    this.validate(providerId)
    if (!query.trim()) return { artists: [], albums: [], tracks: [], playlists: [] }
    return { artists: this.browseArtists(providerId, scope, limit, query.trim()), albums: this.browseAlbums(providerId, scope, limit, query.trim()), tracks: this.browseTracks(providerId, scope, limit, query.trim()), playlists: [] }
  }
  async search(providerId: string, query: string, limit = 12, scope: CatalogBrowseScope = 'all') {
    return this.searchRemote(providerId, query, limit, scope)
  }
  async searchRemote(providerId: string, query: string, limit = 12, scope: CatalogBrowseScope = 'all'): Promise<CatalogSearchResults> {
    this.validate(providerId)
    const provider = this.registry.getProvider(providerId)
    if (providerId === 'local' || scope === 'library' || !query.trim() || !provider?.capabilities.search || !(await provider.isAuthenticated())) return this.searchLocalOnly(providerId, query, limit, scope)
    const results = await provider.search(query.trim(), { limit })
    if ([...results.artists, ...results.albums, ...results.tracks, ...results.playlists].some(r => r.provider !== providerId)) throw new Error('Provider returned items owned by another source')
    const ids = await this.ingest.ingestProviderSearchResults(results)
    return {
      artists: ids.artistIds.map(id => this.browseService.getArtistSearchSummary(id)).filter((a): a is CatalogArtistSummary => !!a),
      albums: ids.albumIds.map(id => this.browseService.getAlbumSummary(id)).filter((a): a is CatalogAlbumSummary => !!a),
      tracks: ids.trackIds.map(id => this.browseService.getTrackSummary(id)).filter((t): t is CatalogTrackSummary => !!t),
      playlists: results.playlists,
    }
  }
  private genreRows(providerId: string, scope: CatalogBrowseScope): Array<{ id: string; genre: string }> {
    this.validate(providerId)
    return this.db.prepare(`WITH visible AS (
      SELECT a.id, a.genres_json FROM catalog_artists a WHERE a.provider_id = @provider
      AND (@scope = 'all' OR EXISTS (SELECT 1 FROM catalog_artist_sources s WHERE s.catalog_artist_id = a.id AND s.provider = @provider AND s.in_library = 1))
    ), tags AS (
      SELECT v.id, g.value AS genre FROM visible v, json_each(COALESCE(v.genres_json, '[]')) g
      UNION SELECT v.id, g.value FROM visible v JOIN catalog_artist_album_edges edge ON edge.catalog_artist_id = v.id
      JOIN catalog_albums a ON a.id = edge.catalog_album_id AND a.provider_id = @provider, json_each(COALESCE(a.genres_json, '[]')) g
      WHERE @scope = 'all' OR EXISTS (SELECT 1 FROM catalog_album_sources s WHERE s.catalog_album_id = a.id AND s.in_library = 1)
      UNION SELECT v.id, g.value FROM visible v JOIN catalog_artist_track_edges edge ON edge.catalog_artist_id = v.id
      JOIN catalog_tracks t ON t.id = edge.catalog_track_id AND t.provider_id = @provider, json_each(COALESCE(t.genres_json, '[]')) g
      WHERE @scope = 'all' OR EXISTS (SELECT 1 FROM catalog_track_sources s WHERE s.catalog_track_id = t.id AND s.in_library = 1)
    ) SELECT id, trim(genre) AS genre FROM tags WHERE trim(genre) <> ''
    UNION SELECT v.id, 'Uncategorized' FROM visible v WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.id = v.id AND trim(t.genre) <> '')`).all({ provider: providerId, scope }) as Array<{ id: string; genre: string }>
  }
  browseGenres(providerId: string, scope: CatalogBrowseScope = 'library'): CatalogGenreSummary[] {
    const grouped = new Map<string, Set<string>>()
    for (const row of this.genreRows(providerId, scope)) {
      if (!grouped.has(row.genre)) grouped.set(row.genre, new Set())
      grouped.get(row.genre)!.add(row.id)
    }
    return [...grouped].map(([genre, artists]) => {
      const artwork = [...artists].map(id => this.browseService.getArtistSearchSummary(id)).find(a => a?.artworkId || a?.artworkUrl)
      return { genre, artistCount: artists.size, artworkId: artwork?.artworkId ?? null, artworkUrl: artwork?.artworkUrl ?? null }
    }).sort((a, b) => b.artistCount - a.artistCount || a.genre.localeCompare(b.genre))
  }
  browseArtistsByGenre(providerId: string, genre: string, scope: CatalogBrowseScope = 'library'): CatalogArtistSummary[] {
    const ids = new Set(this.genreRows(providerId, scope).filter(r => r.genre.toLowerCase() === genre.toLowerCase()).map(r => r.id))
    return [...ids].map(id => this.browseService.getArtistSearchSummary(id)).filter((a): a is CatalogArtistSummary => !!a).sort((a,b) => a.name.localeCompare(b.name))
  }
}
