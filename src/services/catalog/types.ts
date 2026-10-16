import type { SourceEntityRef } from './sourceIdentity'
import type Database from 'better-sqlite3'
import type { FormatInfo } from '../local/formats'

export type CatalogProviderName = string
export type CatalogEntityType = 'artist' | 'album' | 'track'
export type CatalogReleaseType = 'album' | 'ep' | 'single' | 'compilation'
export type CatalogReleaseSection = 'album' | 'ep' | 'single' | 'compilation' | 'live' | 'other'
export type CatalogBrowseScope = 'all' | 'library'
export type CatalogBioProvider = string
export type CatalogArtistArtworkProvider = string
export type CatalogAlbumArtworkProvider = string
export type CatalogLocalCreditGuidanceMode = 'local_only' | 'provider_when_matched'
export type MetadataSource = string
export type CanonicalMatchStatus = 'none' | 'candidate' | 'matched_low' | 'matched_high' | 'locked'
export type CatalogCreditRole =
  | 'primary'
  | 'main'
  | 'featured'
  | 'composer'
  | 'producer'
  | 'conductor'
  | 'performer'
  | 'related'

export interface FieldProvenance {
  field: string
  source: MetadataSource
  sourceId: string | null
  confidence: number | null
  fetchedAt: number | null
  expiresAt: number | null
  canonicalId: string | null
  value: string | null
}

export interface CanonicalIdentity {
  source: 'musicbrainz'
  status: CanonicalMatchStatus
  confidence: number
  locked: boolean
  fetchedAt: number | null
  artistId?: string | null
  releaseGroupId?: string | null
  releaseId?: string | null
  recordingId?: string | null
}

export interface CatalogCreditSummary {
  artistId: string
  artistName: string
  role: CatalogCreditRole
  joinPhrase: string | null
  position: number
  source: MetadataSource
  confidence: number | null
}

export interface CatalogArtistRoleSummary {
  role: CatalogCreditRole
  trackCount: number
  albumCount: number
}

export interface CatalogArtistCollaboratorSummary {
  artistId: string
  artistName: string
  trackCount: number
  albumCount: number
}

export interface CatalogSourceLink {
  provider: CatalogProviderName
  sourceId: string
  inLibrary: boolean
  localId: string | null
  providerPriority: number
  matchConfidence: number
  providerUrl: string | null
  available: boolean
}

export interface CatalogAvailability {
  inLibrary: boolean
  availableProviderIds: CatalogProviderName[]
  playable: boolean
}

export interface CatalogArtistSummary {
  sourceRef: SourceEntityRef
  id: string
  name: string
  normalizedName: string | null
  artworkUrl: string | null
  artworkId: string | null
  availability: CatalogAvailability
  sourceLinks: CatalogSourceLink[]
  albumCount: number
  trackCount: number
  canonicalIdentity?: CanonicalIdentity | null
  metadataProvenance?: FieldProvenance[]
}

export interface CatalogGenreSummary {
  genre: string
  artistCount: number
  artworkUrl: string | null
  artworkId: string | null
}

export interface CatalogAlbumSummary {
  sourceRef: SourceEntityRef
  id: string
  title: string
  normalizedTitle: string | null
  year: number | null
  releaseType: CatalogReleaseType | null
  releaseSection: CatalogReleaseSection | null
  artworkUrl: string | null
  artworkId: string | null
  primaryArtistId: string | null
  primaryArtistName: string | null
  artistCreditName?: string | null
  totalTracks: number | null
  totalDiscs: number | null
  availability: CatalogAvailability
  sourceLinks: CatalogSourceLink[]
  canonicalIdentity?: CanonicalIdentity | null
  metadataProvenance?: FieldProvenance[]
  credits?: CatalogCreditSummary[]
}

export interface CatalogTrackSummary {
  sourceRef: SourceEntityRef
  id: string
  title: string
  normalizedTitle: string | null
  durationMs: number
  trackNumber: number | null
  discNumber: number | null
  albumId: string | null
  albumTitle: string | null
  primaryArtistId: string | null
  primaryArtistName: string | null
  artistCreditName?: string | null
  availability: CatalogAvailability
  sourceLinks: CatalogSourceLink[]
  formatInfo: FormatInfo | null
  formatInfoInspected: boolean
  preferredProvider?: CatalogProviderName | null
  preferredSourceId?: string | null
  canonicalIdentity?: CanonicalIdentity | null
  metadataProvenance?: FieldProvenance[]
  credits?: CatalogCreditSummary[]
}

export interface CatalogSearchResults {
  artists: CatalogArtistSummary[]
  albums: CatalogAlbumSummary[]
  tracks: CatalogTrackSummary[]
  playlists: CatalogPlaylistSummary[]
}

export interface CatalogArtistPage extends CatalogArtistSummary {
  bio: string | null
  bioSource: CatalogBioProvider | null
  bioUrl: string | null
  genres: string[]
  topTracks: CatalogTrackSummary[]
  releases: CatalogAlbumSummary[]
  playlists: CatalogPlaylistSummary[]
  relatedArtists: CatalogArtistSummary[]
  localAlbums: CatalogAlbumSummary[]
  appearsOn: CatalogAlbumSummary[]
  credits: CatalogCreditSummary[]
  roleSummary: CatalogArtistRoleSummary[]
  collaborators: CatalogArtistCollaboratorSummary[]
  preferredProvider?: CatalogProviderName | null
  preferredSourceId?: string | null
}

export interface CatalogAlbumPage extends CatalogAlbumSummary {
  tracks: CatalogTrackSummary[]
  versions: CatalogAlbumSummary[]
  preferredProvider?: CatalogProviderName | null
  preferredSourceId?: string | null
}

export interface CatalogResolvedPlaybackTrack {
  catalogTrackId: string
  catalogAlbumId?: string | null
  catalogArtistId?: string | null
  sourceType: CatalogProviderName
  sourceId: string
  displayMetadataSource: CatalogProviderName
  id: string
  title: string
  artist: string
  album: string
  duration: number
  filePath?: string
  playbackFilePath?: string
  streamId?: string
  fallbackStreamIds?: string[]
  provider?: string
  coverUrl?: string | null
  artworkUrl?: string | null
  discordArtworkUrl?: string | null
  formatInfo?: FormatInfo | null
  startOffsetMs?: number
  endOffsetMs?: number | null
  cueSheetPath?: string | null
}

export interface CatalogProviderArtist {
  provider: CatalogProviderName
  sourceId: string
  name: string
  normalizedName?: string | null
  role?: CatalogCreditRole | null
  joinPhrase?: string | null
  artworkUrl?: string | null
  artworkId?: string | null
  bio?: string | null
  bioSource?: string | null
  bioUrl?: string | null
  genres?: string[]
  providerUrl?: string | null
  albumCount?: number | null
  trackCount?: number | null
  inLibrary?: boolean
}

export interface CatalogProviderAlbum {
  provider: CatalogProviderName
  sourceId: string
  title: string
  normalizedTitle?: string | null
  upc?: string | null
  year?: number | null
  releaseType?: CatalogReleaseType | null
  releaseSection?: CatalogReleaseSection | null
  artworkUrl?: string | null
  artworkId?: string | null
  primaryArtistSourceId?: string | null
  primaryArtistName?: string | null
  primaryArtistNormalizedName?: string | null
  artists?: CatalogProviderArtist[]
  genres?: string[]
  totalTracks?: number | null
  totalDiscs?: number | null
  providerUrl?: string | null
  inLibrary?: boolean
}

export interface CatalogProviderTrack {
  provider: CatalogProviderName
  sourceId: string
  title: string
  normalizedTitle?: string | null
  isrc?: string | null
  upc?: string | null
  durationMs: number
  trackNumber?: number | null
  discNumber?: number | null
  albumSourceId?: string | null
  albumTitle?: string | null
  primaryArtistSourceId?: string | null
  primaryArtistName?: string | null
  primaryArtistNormalizedName?: string | null
  artists?: CatalogProviderArtist[]
  genres?: string[]
  artworkUrl?: string | null
  artworkId?: string | null
  providerUrl?: string | null
  inLibrary?: boolean
  formatInfo?: FormatInfo | null
}

export interface CatalogProviderSearchResults {
  artists: CatalogProviderArtist[]
  albums: CatalogProviderAlbum[]
  tracks: CatalogProviderTrack[]
  playlists: CatalogPlaylistSummary[]
}

export interface CatalogPlaylistSummary {
  id: string
  provider: CatalogProviderName
  sourceId: string
  title: string
  artworkUrl: string | null
  artworkId?: string | null
  trackCount: number | null
  providerUrl: string | null
}

export interface CatalogProviderArtistBundle {
  artist: CatalogProviderArtist
  releases: CatalogProviderAlbum[]
  playlists: CatalogPlaylistSummary[]
  topTracks: CatalogProviderTrack[]
  relatedArtists: CatalogProviderArtist[]
}

export interface CatalogProviderAlbumBundle {
  album: CatalogProviderAlbum
  tracks: CatalogProviderTrack[]
}

export interface CatalogDbContext {
  db: Database.Database
  rebuildSearchIndex(): void
}

export interface CatalogArtworkCache {
  cacheRemoteArtwork(url: string | null | undefined): Promise<string | null>
}

export interface CatalogIdentityInput {
  provider: CatalogProviderName
  sourceId: string
  name: string
  normalizedName: string
  localId?: string | null
  inLibrary?: boolean
  providerUrl?: string | null
}

export interface CatalogAlbumIdentityInput {
  provider: CatalogProviderName
  sourceId: string
  title: string
  normalizedTitle: string
  upc?: string | null
  releaseType?: CatalogReleaseType | null
  releaseSection?: CatalogReleaseSection | null
  primaryArtistName: string | null
  primaryArtistNormalizedName: string | null
  year?: number | null
  totalTracks?: number | null
  localId?: string | null
  inLibrary?: boolean
  providerUrl?: string | null
}

export interface CatalogTrackIdentityInput {
  provider: CatalogProviderName
  sourceId: string
  title: string
  normalizedTitle: string
  isrc?: string | null
  upc?: string | null
  albumId: string | null
  albumTitle: string | null
  primaryArtistName: string | null
  primaryArtistNormalizedName: string | null
  durationMs: number
  trackNumber?: number | null
  discNumber?: number | null
  localId?: string | null
  inLibrary?: boolean
  providerUrl?: string | null
}
