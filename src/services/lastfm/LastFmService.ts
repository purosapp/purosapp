import type { Track } from '../../store/playerStore'
import { RateLimiter } from '../../utils/RateLimiter'
import type { LastFmConfig, LastFmMethod, LastFmTrack, ScrobbleState } from './types'

type LastFmServiceEventMap = {
  scrobbled: LastFmTrack
  scrobbleError: unknown
  queuedForLater: LastFmTrack
  flushedQueue: number
  nowPlayingSent: LastFmTrack
  queueChanged: LastFmTrack[]
}

type Listener<T> = (payload: T) => void

const OFFLINE_QUEUE_KEY = 'lastfm:offlineQueue'
const MAX_OFFLINE_QUEUE = 50
const PAUSE_NEW_SESSION_MS = 10 * 60 * 1000
const BACKWARD_SEEK_RESET_SECONDS = 10

class LastFmEventEmitter {
  private listeners = new Map<keyof LastFmServiceEventMap, Set<Listener<LastFmServiceEventMap[keyof LastFmServiceEventMap]>>>()

  on<K extends keyof LastFmServiceEventMap>(event: K, listener: Listener<LastFmServiceEventMap[K]>): () => void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener as Listener<LastFmServiceEventMap[keyof LastFmServiceEventMap]>)
    this.listeners.set(event, listeners)

    return () => {
      listeners.delete(listener as Listener<LastFmServiceEventMap[keyof LastFmServiceEventMap]>)
    }
  }

  protected emit<K extends keyof LastFmServiceEventMap>(event: K, payload: LastFmServiceEventMap[K]): void {
    this.listeners.get(event)?.forEach((listener) => listener(payload))
  }
}

export class LastFmService extends LastFmEventEmitter {
  private config: LastFmConfig
  private currentScrobble: ScrobbleState | null = null
  private rateLimiter = new RateLimiter({ maxRequests: 1, windowMs: 1100 })
  private offlineQueue: LastFmTrack[] = []
  private pauseStartedAt: number | null = null
  private queueLoaded = false
  private queueLoadPromise: Promise<void> | null = null

  constructor(config: LastFmConfig) {
    super()
    this.config = this.normalizeConfig(config)
    void this.loadOfflineQueue()
  }

  async authenticate(token: string): Promise<{ username: string; sessionKey: string }> {
    const result = await this.apiCall('auth.getSession', { token }, {
      sign: true,
      useSessionKey: false,
    }) as { session?: { name?: unknown; key?: unknown } }

    const session = result?.session
    if (!session?.name || !session?.key) {
      throw new Error('Last.fm did not return a session')
    }

    return {
      username: String(session.name),
      sessionKey: String(session.key),
    }
  }

  startTrack(track: Track): void {
    if (!this.isReadyForPlayback()) return

    if (this.currentScrobble && !this.currentScrobble.scrobbled) {
      this.endTrack()
    }

    const lastFmTrack = this.mapTrack(track)
    if (!this.hasRequiredMetadata(lastFmTrack)) return

    this.currentScrobble = {
      track: lastFmTrack,
      startTime: Date.now(),
      pausedTime: 0,
      lastPosition: 0,
      scrobbled: false,
      nowPlayingSent: false,
    }
    this.pauseStartedAt = null

    void this.sendNowPlaying(lastFmTrack)
  }

  pauseTrack(): void {
    if (!this.currentScrobble || this.pauseStartedAt != null) return
    this.pauseStartedAt = Date.now()
  }

  resumeTrack(): void {
    if (!this.currentScrobble || this.pauseStartedAt == null) return

    const pausedFor = Date.now() - this.pauseStartedAt
    if (pausedFor >= PAUSE_NEW_SESSION_MS) {
      this.currentScrobble.startTime = Date.now()
      this.currentScrobble.pausedTime = 0
      this.currentScrobble.nowPlayingSent = false
      if (!this.currentScrobble.scrobbled && this.currentScrobble.track) {
        void this.sendNowPlaying(this.currentScrobble.track)
      }
    } else {
      this.currentScrobble.pausedTime += pausedFor
    }

    this.pauseStartedAt = null
  }

  endTrack(forceScrobble = false): void {
    if (!this.currentScrobble) return

    if (!this.currentScrobble.scrobbled && (this.shouldScrobble() || this.shouldForceScrobble(forceScrobble))) {
      this.currentScrobble.scrobbled = true
      void this.submitScrobble(this.currentScrobble.track!, this.currentScrobble.startTime)
    }

    this.currentScrobble = null
    this.pauseStartedAt = null
  }

  updatePosition(positionSeconds: number): void {
    if (!this.currentScrobble || !Number.isFinite(positionSeconds)) return

    const position = Math.max(0, positionSeconds)
    const previousPosition = this.currentScrobble.lastPosition

    if (previousPosition - position > BACKWARD_SEEK_RESET_SECONDS) {
      this.resetForBackwardSeek(position)
    } else {
      this.currentScrobble.lastPosition = position
    }

    if (!this.currentScrobble || this.currentScrobble.scrobbled) return

    if (this.shouldScrobble()) {
      this.currentScrobble.scrobbled = true
      void this.submitScrobble(this.currentScrobble.track!, this.currentScrobble.startTime)
    }
  }

  async flushOfflineQueue(): Promise<void> {
    await this.ensureQueueLoaded()
    if (!this.config.sessionKey || this.offlineQueue.length === 0) return

    const batch = this.offlineQueue.slice(0, MAX_OFFLINE_QUEUE)
    const params: Record<string, string | number> = {}

    batch.forEach((track, index) => {
      params[`track[${index}]`] = track.track
      params[`artist[${index}]`] = track.artist
      if (track.album) params[`album[${index}]`] = track.album
      if (track.timestamp) params[`timestamp[${index}]`] = track.timestamp
      if (track.duration) params[`duration[${index}]`] = track.duration
      if (track.trackNumber) params[`trackNumber[${index}]`] = track.trackNumber
      if (track.mbid) params[`mbid[${index}]`] = track.mbid
    })

    try {
      await this.apiCall('track.scrobble', params)
      this.offlineQueue = this.offlineQueue.slice(batch.length)
      await this.saveOfflineQueue()
      this.emit('flushedQueue', batch.length)
      this.emit('queueChanged', [...this.offlineQueue])
    } catch (error) {
      console.warn('[LastFm] Failed to flush offline queue:', error)
    }
  }

  updateConfig(config: Partial<LastFmConfig>): void {
    this.config = this.normalizeConfig({ ...this.config, ...config })
  }

  disconnect(): void {
    this.config.sessionKey = undefined
    this.config.username = undefined
    this.currentScrobble = null
    this.pauseStartedAt = null
  }

  getConfig(): LastFmConfig {
    return { ...this.config }
  }

  getOfflineQueue(): LastFmTrack[] {
    return [...this.offlineQueue]
  }

  getOfflineQueueLength(): number {
    return this.offlineQueue.length
  }

  private shouldScrobble(): boolean {
    if (!this.currentScrobble?.track) return false

    const { track, lastPosition } = this.currentScrobble
    const duration = Math.max(0, track.duration ?? 0)

    if (duration > 0 && duration < this.config.minDuration) return false
    if (lastPosition < this.config.minDuration) return false

    const thresholdTime = duration > 0
      ? Math.min(duration * this.config.scrobbleThreshold, 4 * 60)
      : 4 * 60

    return lastPosition >= thresholdTime
  }

  private shouldForceScrobble(forceScrobble: boolean): boolean {
    if (!forceScrobble || !this.currentScrobble?.track) return false

    const duration = Math.max(0, this.currentScrobble.track.duration ?? 0)
    if (duration > 0 && duration < this.config.minDuration) return false

    return this.currentScrobble.lastPosition >= this.config.minDuration
  }

  private async submitScrobble(track: LastFmTrack, startTimeMs: number): Promise<void> {
    const scrobbleData: LastFmTrack = {
      ...track,
      timestamp: Math.max(1, Math.floor(startTimeMs / 1000)),
    }

    if (!this.config.sessionKey) {
      await this.queueOfflineScrobble(scrobbleData)
      return
    }

    try {
      await this.apiCall('track.scrobble', this.toScrobbleParams(scrobbleData))
      this.emit('scrobbled', scrobbleData)
      void this.flushOfflineQueue()
    } catch (error) {
      await this.queueOfflineScrobble(scrobbleData)
      this.emit('scrobbleError', error)
    }
  }

  private async sendNowPlaying(track: LastFmTrack): Promise<void> {
    if (!this.config.sessionKey) return

    try {
      await this.apiCall('track.updateNowPlaying', {
        artist: track.artist,
        track: track.track,
        album: track.album,
        duration: track.duration,
        trackNumber: track.trackNumber,
        mbid: track.mbid,
      })

      if (this.currentScrobble?.track === track) {
        this.currentScrobble.nowPlayingSent = true
      }
      this.emit('nowPlayingSent', track)
    } catch (error) {
      console.warn('[LastFm] Now Playing failed:', error)
    }
  }

  private async queueOfflineScrobble(track: LastFmTrack): Promise<void> {
    await this.ensureQueueLoaded()

    if (this.offlineQueue.length >= MAX_OFFLINE_QUEUE) {
      this.offlineQueue = this.offlineQueue.slice(this.offlineQueue.length - MAX_OFFLINE_QUEUE + 1)
    }

    this.offlineQueue.push(track)
    await this.saveOfflineQueue()
    this.emit('queuedForLater', track)
    this.emit('queueChanged', [...this.offlineQueue])
  }

  private async loadOfflineQueue(): Promise<void> {
    if (this.queueLoaded) return
    if (this.queueLoadPromise) return this.queueLoadPromise

    this.queueLoadPromise = (async () => {
      try {
        const raw = await window.puros.settings.get(OFFLINE_QUEUE_KEY)
        if (!raw) return

        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return

        this.offlineQueue = parsed
          .filter((track): track is LastFmTrack => {
            if (!track || typeof track !== 'object') return false
            const candidate = track as Partial<LastFmTrack>
            return typeof candidate.artist === 'string' && typeof candidate.track === 'string'
          })
          .slice(-MAX_OFFLINE_QUEUE)
        this.emit('queueChanged', [...this.offlineQueue])
      } catch (error) {
        console.warn('[LastFm] Failed to load offline queue:', error)
      } finally {
        this.queueLoaded = true
        this.queueLoadPromise = null
      }
    })()

    await this.queueLoadPromise
  }

  private async ensureQueueLoaded(): Promise<void> {
    if (this.queueLoaded) return
    await this.loadOfflineQueue()
  }

  private async saveOfflineQueue(): Promise<void> {
    await window.puros.settings.set(OFFLINE_QUEUE_KEY, JSON.stringify(this.offlineQueue))
  }

  private async apiCall(
    method: LastFmMethod,
    params: Record<string, unknown>,
    options: { sign?: boolean; useSessionKey?: boolean } = {},
  ): Promise<unknown> {
    await this.rateLimiter.acquire()

    return window.puros.lastfm.apiCall({
      method,
      params: this.cleanParams(params),
      sessionKey: this.config.sessionKey,
      sign: options.sign ?? true,
      useSessionKey: options.useSessionKey ?? true,
    })
  }

  private mapTrack(track: Track): LastFmTrack {
    return {
      artist: track.artist || 'Unknown Artist',
      track: track.title || 'Unknown Track',
      album: track.album || undefined,
      duration: track.duration ? Math.round(track.duration) : undefined,
    }
  }

  private resetForBackwardSeek(position: number): void {
    if (!this.currentScrobble) return

    this.currentScrobble.startTime = Date.now()
    this.currentScrobble.pausedTime = 0
    this.currentScrobble.lastPosition = position
    this.currentScrobble.scrobbled = false
    this.pauseStartedAt = null
  }

  private toScrobbleParams(track: LastFmTrack): Record<string, string | number | undefined> {
    return {
      artist: track.artist,
      track: track.track,
      album: track.album,
      duration: track.duration,
      timestamp: track.timestamp,
      trackNumber: track.trackNumber,
      mbid: track.mbid,
    }
  }

  private cleanParams(params: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [key, String(value)]),
    )
  }

  private isReadyForPlayback(): boolean {
    return this.config.enabled && !!this.config.sessionKey
  }

  private hasRequiredMetadata(track: LastFmTrack): boolean {
    return track.artist.trim().length > 0 && track.track.trim().length > 0
  }

  private normalizeConfig(config: LastFmConfig): LastFmConfig {
    return {
      ...config,
      scrobbleThreshold: Number.isFinite(config.scrobbleThreshold)
        ? Math.max(0.1, Math.min(1, config.scrobbleThreshold))
        : 0.5,
      minDuration: Number.isFinite(config.minDuration)
        ? Math.max(30, config.minDuration)
        : 30,
    }
  }
}
