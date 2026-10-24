import type { CatalogProviderName } from './catalog/types'
import type { FormatInfo } from './local/formats'

export type HomeProviderCollectionKind = 'playlist' | 'mix' | 'station'

export interface HomeProviderCollectionItem {
  id: string
  provider: CatalogProviderName | string
  sourceType: HomeProviderCollectionKind
  sourceId: string
  title: string
  subtitle: string | null
  description?: string | null
  artworkUrl: string | null
  providerUrl: string | null
  trackCount?: number | null
  syncedPlaylistId?: number | null
}

export interface HomeProviderShelf {
  id: string
  provider: CatalogProviderName | string
  title: string
  subtitle: string | null
  items: HomeProviderCollectionItem[]
}

export interface HomeProviderTrack {
  id: string
  provider: CatalogProviderName | string
  sourceId: string
  catalogTrackId?: string | null
  catalogAlbumId?: string | null
  catalogArtistId?: string | null
  title: string
  artist: string
  album: string
  duration: number
  artworkUrl: string | null
  providerUrl?: string | null
  discordArtworkUrl?: string | null
  trackNumber?: number | null
  formatInfo: FormatInfo | null
  /** Why the account cannot stream this track; null when it can. */
  unavailableReason?: string | null
}

export interface HomeProviderCollectionBundle {
  provider: CatalogProviderName | string
  sourceType: HomeProviderCollectionKind
  sourceId: string
  title: string
  subtitle: string | null
  description?: string | null
  artworkUrl: string | null
  providerUrl: string | null
  tracks: HomeProviderTrack[]
}
