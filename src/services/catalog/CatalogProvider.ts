import type {
  CatalogProviderAlbum,
  CatalogProviderAlbumBundle,
  CatalogProviderArtist,
  CatalogProviderArtistBundle,
  CatalogProviderName,
  CatalogProviderSearchResults,
  CatalogResolvedPlaybackTrack,
} from './types'

export interface CatalogProviderCapabilities {
  search: boolean
  artistProfile: boolean
  artistDiscography: boolean
  albumDetails: boolean
  trackPlayback: boolean
  relatedArtists: boolean
  similarAlbums: boolean
  addToLibrary: boolean
}

export interface CatalogProvider {
  readonly name: CatalogProviderName
  readonly capabilities: CatalogProviderCapabilities

  isAuthenticated(): Promise<boolean>

  search(query: string, options?: { limit?: number }): Promise<CatalogProviderSearchResults>
  getArtist(providerArtistId: string): Promise<CatalogProviderArtist>
  getArtistDiscography(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderAlbum[]>
  getArtistTopTracks(providerArtistId: string, options?: { limit?: number }): Promise<import('./types').CatalogProviderTrack[]>
  getArtistRelated(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderArtist[]>
  getArtistBundle(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderArtistBundle>
  getAlbum(providerAlbumId: string): Promise<CatalogProviderAlbum>
  getAlbumTracks(providerAlbumId: string): Promise<import('./types').CatalogProviderTrack[]>
  getAlbumBundle(providerAlbumId: string): Promise<CatalogProviderAlbumBundle>
  resolvePlayback(catalogTrackId: string, providerTrackId: string): Promise<CatalogResolvedPlaybackTrack>
  addArtistToLibrary?(providerArtistId: string): Promise<void>
  addAlbumToLibrary?(providerAlbumId: string): Promise<void>
  addTrackToLibrary?(providerTrackId: string): Promise<void>
}
