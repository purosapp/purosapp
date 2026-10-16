export interface LastFmConfig {
  sessionKey?: string
  username?: string
  enabled: boolean
  scrobbleThreshold: number
  minDuration: number
  showScrobbleToasts: boolean
}

export interface LastFmTrack {
  artist: string
  track: string
  album?: string
  duration?: number
  timestamp?: number
  trackNumber?: number
  mbid?: string
}

export interface ScrobbleState {
  track: LastFmTrack | null
  startTime: number
  pausedTime: number
  lastPosition: number
  scrobbled: boolean
  nowPlayingSent: boolean
}

export type LastFmMethod =
  | 'track.scrobble'
  | 'track.updateNowPlaying'
  | 'auth.getSession'
  | 'user.getInfo'

export const DEFAULT_LASTFM_CONFIG: LastFmConfig = {
  enabled: false,
  scrobbleThreshold: 0.5,
  minDuration: 30,
  showScrobbleToasts: true,
}
