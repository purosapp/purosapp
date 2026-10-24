import type Database from 'better-sqlite3'
import type {
  ProviderAlbumBundleV1,
  ProviderAlbumV1,
  ProviderArtistBundleV1,
  ProviderArtistCreditV1,
  ProviderArtistV1,
  ProviderPlaylistV1,
  ProviderSearchResultsV1,
  ProviderTrackV1,
  ProviderValueV1,
} from '../../../src/provider-api/v1'
import type {
  CatalogPlaylistSummary,
  CatalogProviderAlbum,
  CatalogProviderArtist,
  CatalogProviderSearchResults,
  CatalogProviderTrack,
  CatalogResolvedPlaybackTrack,
} from '../../../src/services/catalog/types'
import type { CatalogProvider } from '../../../src/services/catalog/CatalogProvider'
import type { ProviderRegistry } from './registry'

function toArtistCredit(providerId: string, credit: ProviderArtistCreditV1): CatalogProviderArtist {
  return {
    provider: providerId,
    sourceId: credit.artistSourceId ?? `${credit.artistName}:${credit.position}`,
    name: credit.artistName,
    role: credit.role === 'other' ? 'performer' : credit.role,
    joinPhrase: credit.joinPhrase ?? null,
  }
}

function toArtist(providerId: string, artist: ProviderArtistV1): CatalogProviderArtist {
  return {
    ...artist,
    provider: providerId,
    artworkId: null,
    bioSource: artist.bio ? providerId : null,
  }
}

function toAlbum(providerId: string, album: ProviderAlbumV1): CatalogProviderAlbum {
  const releaseType = album.releaseType && ['album', 'ep', 'single', 'compilation'].includes(album.releaseType)
    ? album.releaseType as CatalogProviderAlbum['releaseType']
    : null
  return {
    ...album,
    provider: providerId,
    releaseType,
    releaseSection: album.releaseType ?? null,
    artworkId: null,
    artists: album.artists?.map((credit) => toArtistCredit(providerId, credit)),
  }
}

export function toTrack(providerId: string, track: ProviderTrackV1): CatalogProviderTrack {
  return {
    ...track,
    provider: providerId,
    artworkId: null,
    artists: track.artists?.map((credit) => toArtistCredit(providerId, credit)),
  }
}

function toPlaylist(providerId: string, playlist: ProviderPlaylistV1): CatalogPlaylistSummary {
  return {
    id: `${providerId}:${playlist.sourceId}`,
    provider: providerId,
    sourceId: playlist.sourceId,
    title: playlist.title,
    artworkUrl: playlist.artworkUrl ?? null,
    artworkId: null,
    trackCount: playlist.trackCount ?? null,
    providerUrl: playlist.providerUrl ?? null,
  }
}

function toSearchResults(providerId: string, results: ProviderSearchResultsV1): CatalogProviderSearchResults {
  return {
    artists: results.artists.map((artist) => toArtist(providerId, artist)),
    albums: results.albums.map((album) => toAlbum(providerId, album)),
    tracks: results.tracks.map((track) => toTrack(providerId, track)),
    playlists: results.playlists.map((playlist) => toPlaylist(providerId, playlist)),
  }
}

export class ProviderCatalogAdapter implements CatalogProvider {
  readonly name: string
  readonly capabilities: CatalogProvider['capabilities']

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly db: Database.Database,
    providerId: string,
  ) {
    this.name = providerId
    const declared = new Set(registry.getEntry(providerId).manifest.capabilities)
    const hasEntities = declared.has('catalog.entities')
    this.capabilities = {
      search: declared.has('catalog.search'),
      artistProfile: hasEntities,
      artistDiscography: hasEntities,
      albumDetails: hasEntities,
      trackPlayback: declared.has('playback.resolve'),
      relatedArtists: hasEntities,
      similarAlbums: false,
      addToLibrary: declared.has('library.sync'),
    }
  }

  async isAuthenticated(): Promise<boolean> {
    const status = this.registry.getStatus(this.name)
    return (status.state === 'ready' || status.state === 'degraded') && status.authenticated !== false
  }

  async search(query: string, options?: { limit?: number }): Promise<CatalogProviderSearchResults> {
    const value = await this.invoke<ProviderSearchResultsV1>('catalog.search', 'search', [{ query, limit: options?.limit }])
    return toSearchResults(this.name, value)
  }

  async getArtist(providerArtistId: string): Promise<CatalogProviderArtist> {
    return toArtist(this.name, await this.invoke<ProviderArtistV1>('catalog.entities', 'getArtist', [providerArtistId]))
  }

  async getArtistDiscography(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderAlbum[]> {
    const bundle = await this.getArtistBundle(providerArtistId, options)
    return bundle.releases
  }

  async getArtistTopTracks(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderTrack[]> {
    const bundle = await this.getArtistBundle(providerArtistId, options)
    return bundle.topTracks
  }

  async getArtistRelated(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderArtist[]> {
    const bundle = await this.getArtistBundle(providerArtistId, options)
    return bundle.relatedArtists
  }

  async getArtistBundle(providerArtistId: string, options?: { limit?: number }) {
    const bundle = await this.invoke<ProviderArtistBundleV1>(
      'catalog.entities',
      'getArtistBundle',
      [providerArtistId, { limit: options?.limit }],
    )
    return {
      artist: toArtist(this.name, bundle.artist),
      releases: bundle.releases.map((album) => toAlbum(this.name, album)),
      playlists: bundle.playlists.map((playlist) => toPlaylist(this.name, playlist)),
      topTracks: bundle.topTracks.map((track) => toTrack(this.name, track)),
      relatedArtists: bundle.relatedArtists.map((artist) => toArtist(this.name, artist)),
    }
  }

  async getAlbum(providerAlbumId: string): Promise<CatalogProviderAlbum> {
    return toAlbum(this.name, await this.invoke<ProviderAlbumV1>('catalog.entities', 'getAlbum', [providerAlbumId]))
  }

  async getAlbumTracks(providerAlbumId: string): Promise<CatalogProviderTrack[]> {
    const bundle = await this.getAlbumBundle(providerAlbumId)
    return bundle.tracks
  }

  async getAlbumBundle(providerAlbumId: string) {
    const bundle = await this.invoke<ProviderAlbumBundleV1>('catalog.entities', 'getAlbumBundle', [providerAlbumId])
    return {
      album: toAlbum(this.name, bundle.album),
      tracks: bundle.tracks.map((track) => toTrack(this.name, track)),
    }
  }

  async resolvePlayback(catalogTrackId: string, providerTrackId: string): Promise<CatalogResolvedPlaybackTrack> {
    const row = this.db.prepare(`
      SELECT title, duration_ms, album_id, album_title, primary_artist_id, primary_artist_name,
             artwork_url, artwork_id
      FROM catalog_tracks
      WHERE id = ?
      LIMIT 1
    `).get(catalogTrackId) as {
      title: string
      duration_ms: number
      album_id: string | null
      album_title: string | null
      primary_artist_id: string | null
      primary_artist_name: string | null
      artwork_url: string | null
      artwork_id: string | null
    } | undefined
    if (!row) throw new Error('Catalog playback target not found')
    const artworkUrl = row.artwork_id
      ? `artwork://cache/${encodeURIComponent(row.artwork_id)}`
      : row.artwork_url
    return {
      catalogTrackId,
      catalogAlbumId: row.album_id,
      catalogArtistId: row.primary_artist_id,
      sourceType: this.name,
      sourceId: providerTrackId,
      displayMetadataSource: this.name,
      id: catalogTrackId,
      title: row.title,
      artist: row.primary_artist_name ?? 'Unknown Artist',
      album: row.album_title ?? 'Unknown Album',
      duration: Math.round(row.duration_ms / 1000),
      streamId: providerTrackId,
      provider: this.name,
      coverUrl: artworkUrl,
      artworkUrl,
    }
  }

  private async invoke<T>(capability: Parameters<ProviderRegistry['invoke']>[1], method: string, args: unknown[]): Promise<T> {
    const result = await this.registry.invoke(
      this.name,
      capability,
      method,
      args as ProviderValueV1[],
    )
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
}
