import type { PlaybackPreparationStrategy, PreparationOptions, PreparedPlayback } from './types'
import type { Track } from '../../store/playerStore'
import { resolveProviderArtifact, waitForCompletedArtifact } from './providerArtifact'

export class DownloadFirstPreparationStrategy implements PlaybackPreparationStrategy {
  async prepareTrack(track: Track, options: PreparationOptions): Promise<PreparedPlayback> {
    const intent = options.intent ?? 'playback'
    const { providerId, artifact } = await resolveProviderArtifact(track, intent, intent === 'prefetch', options)
    if (!artifact) return { playbackTarget: null, formatInfo: null, providerId }
    const completed = await waitForCompletedArtifact(providerId, artifact)
    return {
      playbackTarget: completed.path,
      formatInfo: completed.format,
      sourceFormatInfo: completed.sourceFormat ?? null,
      artifact: completed,
      providerId,
    }
  }
}
