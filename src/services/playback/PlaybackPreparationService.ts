import { useSettingsStore } from '../../store/settingsStore'
import { DownloadFirstPreparationStrategy } from './DownloadFirstPreparationStrategy'
import { ProgressiveCachePreparationStrategy } from './ProgressiveCachePreparationStrategy'
import type {
  PlaybackPreparationStrategy,
  PreparationOptions,
  PreparedPlayback,
  StreamingPlaybackMode,
} from './types'
import { PlaybackPreparationCancelledError } from './types'
import { providerIdForTrack } from './providerArtifact'
import type { Track } from '../../store/playerStore'

interface ActivePreparation {
  providerId: string
  requestSessionId: string
  progressiveSessionId: string | null
  cancelledSessionId: string | null
  cancelled: boolean
}

export class PlaybackPreparationService {
  private readonly strategies: Record<StreamingPlaybackMode, PlaybackPreparationStrategy>
  private activePreparation: ActivePreparation | null = null
  private preparationGeneration = 0

  constructor() {
    this.strategies = {
      'download-first': new DownloadFirstPreparationStrategy(),
      'progressive-cache': new ProgressiveCachePreparationStrategy(),
    }
  }

  async prepareTrack(track: Track, options: PreparationOptions = {}): Promise<PreparedPlayback> {
    if (options.intent === 'prefetch') {
      const mode = useSettingsStore.getState().streamingPlaybackMode
      return await this.strategies[mode].prepareTrack(track, options)
    }

    const generation = ++this.preparationGeneration
    const previous = this.activePreparation
    this.activePreparation = null
    await this.cancelPreparation(previous)
    if (generation !== this.preparationGeneration) throw new PlaybackPreparationCancelledError()
    const preparation: ActivePreparation = {
      providerId: providerIdForTrack(track),
      requestSessionId: globalThis.crypto.randomUUID(),
      progressiveSessionId: null,
      cancelledSessionId: null,
      cancelled: false,
    }
    this.activePreparation = preparation
    const mode = useSettingsStore.getState().streamingPlaybackMode
    const strategy = this.strategies[mode]
    const strategyName = mode === 'download-first'
      ? 'DownloadFirstPreparationStrategy'
      : 'ProgressiveCachePreparationStrategy'

    console.info(`[PlaybackPreparation] Selected mode: ${mode}`)
    console.info(`[PlaybackPreparation] Selected strategy: ${strategyName}`)

    try {
      const prepared = await strategy.prepareTrack(track, {
        ...options,
        sessionId: preparation.requestSessionId,
        isCancelled: () => preparation.cancelled || generation !== this.preparationGeneration,
      })
      preparation.progressiveSessionId = prepared.streamingSession?.sessionId ?? null
      if (generation !== this.preparationGeneration || preparation.cancelled) {
        await this.cancelPreparation(preparation)
        throw new PlaybackPreparationCancelledError()
      }
      if (!preparation.progressiveSessionId) this.activePreparation = null
      return prepared
    } catch (error) {
      if (this.activePreparation === preparation) this.activePreparation = null
      if (generation !== this.preparationGeneration || preparation.cancelled) {
        throw new PlaybackPreparationCancelledError()
      }
      throw error
    }
  }

  async prepareDownloadFirst(track: Track): Promise<PreparedPlayback> {
    await this.cancelActiveSession()
    console.info('[Streaming] Fallback to download-first')
    return await this.strategies['download-first'].prepareTrack(track, { intent: 'playback' })
  }

  async cancelActiveSession(): Promise<void> {
    this.preparationGeneration += 1
    const preparation = this.activePreparation
    this.activePreparation = null
    await this.cancelPreparation(preparation)
  }

  getActiveGrowingSession(): { providerId: string; sessionId: string } | null {
    const preparation = this.activePreparation
    return preparation?.progressiveSessionId
      ? { providerId: preparation.providerId, sessionId: preparation.progressiveSessionId }
      : null
  }

  private async cancelPreparation(preparation: ActivePreparation | null): Promise<void> {
    if (!preparation) return
    preparation.cancelled = true
    const sessionId = preparation.progressiveSessionId ?? preparation.requestSessionId
    if (preparation.cancelledSessionId === sessionId) return
    preparation.cancelledSessionId = sessionId
    if (preparation.progressiveSessionId) {
      await window.puros.provider.invoke(preparation.providerId, 'playback.progressive', 'cancel', [{ sessionId }]).catch((error) => {
        console.warn('[Streaming] Failed to cancel session:', error)
      })
    } else {
      await window.puros.provider.cancelSession(preparation.providerId, sessionId).catch((error) => {
        console.warn('[Streaming] Failed to cancel pending playback:', error)
      })
    }
  }
}

export const playbackPreparationService = new PlaybackPreparationService()
