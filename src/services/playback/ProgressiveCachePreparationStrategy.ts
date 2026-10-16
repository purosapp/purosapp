import type { PlaybackPreparationStrategy, PreparationOptions, PreparedPlayback } from './types'
import type { Track } from '../../store/playerStore'
import { StreamingSessionState, type StreamingSessionSnapshot } from './streaming'
import { resolveProviderArtifact } from './providerArtifact'

export class ProgressiveCachePreparationStrategy implements PlaybackPreparationStrategy {
  async prepareTrack(track: Track, options: PreparationOptions): Promise<PreparedPlayback> {
    const { providerId, artifact } = await resolveProviderArtifact(
      track,
      options.intent ?? 'playback',
      options.intent === 'prefetch',
      options,
    )
    if (!artifact) return { playbackTarget: null, formatInfo: null, providerId }
    if (artifact.lifecycle === 'complete') {
      return {
        playbackTarget: artifact.path,
        formatInfo: artifact.format,
        sourceFormatInfo: artifact.sourceFormat ?? null,
        artifact,
        providerId,
      }
    }
    if (!artifact.sessionId) throw new Error('Growing playback artifact is missing a session ID')
    const sourceId = track.streamId ?? track.sourceId ?? track.id
    const streamingSession: StreamingSessionSnapshot = {
      sessionId: artifact.sessionId,
      trackId: sourceId,
      createdAt: Date.now(),
      state: StreamingSessionState.Running,
      manifest: {
        trackId: sourceId,
        codec: artifact.format.format,
        sampleRate: artifact.format.sampleRate,
        bitDepth: artifact.format.bitDepth,
        urls: [],
        encrypted: false,
        provider: providerId,
      },
      bytesDownloaded: 0,
      totalSegments: 1,
      completedSegments: 0,
      downloadRate: 0,
      estimatedRemaining: null,
      playbackStarted: false,
      playbackRevision: 0,
    }
    return {
      playbackTarget: artifact.path,
      formatInfo: artifact.format,
      sourceFormatInfo: artifact.sourceFormat ?? null,
      isStreamingSession: true,
      streamingSession,
      artifact,
      providerId,
    }
  }
}
