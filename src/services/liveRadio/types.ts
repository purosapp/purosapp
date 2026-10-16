import type { FormatInfo } from '../local/formats'

export interface LiveRadioStream {
  url: string
  codec?: string
  bitrate?: number
}

export interface Station {
  id: string
  name: string
  streams: LiveRadioStream[]
  defaultStreamIndex: number
  genre?: string[]
  country?: string
  countryCode?: string
  language?: string
  logoUrl?: string
  homepage?: string
  codec?: string
  bitrate?: number
  clickCount?: number
  votes?: number
  lastCheckOk?: boolean
  isCustom: boolean
  isFavorite: boolean
}

export interface LiveRadioBrowseOptions {
  query?: string
  tag?: string
  countryCode?: string
  language?: string
  sort?: 'popular' | 'votes' | 'name'
  limit?: number
  hideBroken?: boolean
}

export interface LiveRadioFilterOption {
  name: string
  value: string
  count?: number
}

export interface LiveRadioDirectoryFilters {
  tags: LiveRadioFilterOption[]
  countries: LiveRadioFilterOption[]
  languages: LiveRadioFilterOption[]
}

export interface LiveRadioProbeResult {
  ok: boolean
  streamUrl?: string
  displayName?: string
  formatInfo?: FormatInfo
  codec?: string
  bitrate?: number
  contentType?: string
  error?: string
}

export interface LiveRadioNowPlayingMetadata {
  stationId: string
  title: string | null
  artist: string | null
  rawTitle: string | null
  fetchedAt: number
}

export interface LiveRadioPlaybackStatus {
  stationId: string
  state: 'connecting' | 'playing' | 'reconnecting' | 'stopped' | 'error'
  message?: string | null
  attempt: number
}
