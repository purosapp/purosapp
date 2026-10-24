import type { Track } from '../../store/playerStore'
import type { FormatInfo } from '../local/formats'
import type { StreamingSessionSnapshot } from './streaming'
import type { PlaybackArtifactV1, ProviderPlaybackProgressV1 } from '../../provider-api/v1'

export type StreamingPlaybackMode = 'download-first' | 'progressive-cache'

export type PreparationIntent = 'playback' | 'prefetch'

export interface PreparationOptions {
  intent?: PreparationIntent
  /** Renderer-only controls; only sessionId is sent across the provider boundary. */
  sessionId?: string
  isCancelled?: () => boolean
  onProgress?: (progress: ProviderPlaybackProgressV1) => void
}

export class PlaybackPreparationCancelledError extends Error {
  constructor() {
    super('Playback preparation cancelled')
    this.name = 'AbortError'
  }
}

/** The provider says this account cannot stream the track; skip it rather than stop. */
export class TrackUnavailableError extends Error {
  readonly reason: string

  constructor(reason: string, message: string) {
    super(message)
    this.name = 'TrackUnavailableError'
    this.reason = reason
  }
}

export interface PreparedPlayback {
  playbackTarget: string | null
  /** The prepared file's format; drives output negotiation. */
  formatInfo: FormatInfo | null
  /** What the service delivered when the file is a conversion (e.g. Vorbis → FLAC); drives quality labels. */
  sourceFormatInfo?: FormatInfo | null
  isStreamingSession?: boolean
  streamingSession?: StreamingSessionSnapshot
  artifact?: PlaybackArtifactV1
  providerId?: string
}

export interface PlaybackPreparationStrategy {
  prepareTrack(
    track: Track,
    options: PreparationOptions,
  ): Promise<PreparedPlayback>
}
