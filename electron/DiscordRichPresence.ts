import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('@xhayper/discord-rpc') as typeof import('@xhayper/discord-rpc')

type DiscordRpcClient = import('@xhayper/discord-rpc').Client

type DiscordPlaybackState = 'playing' | 'paused' | 'stopped'

export interface DiscordPresenceConfig {
  enabled: boolean
  smallImageKey?: string
  smallImageUrl?: string
  fallbackLargeImageKey?: string
  fallbackLargeImageUrl?: string
}

export interface DiscordNowPlayingPayload {
  title: string
  artist: string
  album: string
  duration: number
  position: number
  artworkUrl?: string | null
  providerLabel?: string | null
  providerTrackUrl?: string | null
}

export interface DiscordPlaybackPayload {
  state: DiscordPlaybackState
  position: number
  duration: number
}

type DiscordActivity = {
  name: string
  type: number
  details?: string
  state?: string
  startTimestamp?: Date
  endTimestamp?: Date
  largeImageKey?: string
  largeImageUrl?: string
  largeImageText?: string
  smallImageKey?: string
  smallImageUrl?: string
  smallImageText?: string
  buttons?: Array<{ label: string; url: string }>
}

const LISTENING_ACTIVITY_TYPE = 2
const RECONNECT_COOLDOWN_MS = 15_000
const POSITION_RESYNC_DRIFT_SECONDS = 3
const PUROS_DOWNLOAD_URL = 'https://getpuros.app'
const PUROS_DISCORD_CLIENT_ID = '1491520035292708894'

function clampDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return seconds
}

function sanitizeText(value: string | null | undefined, maxLength = 128): string | undefined {
  const normalized = String(value ?? '').trim()
  if (!normalized) return undefined
  return normalized.length > maxLength
    ? normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…'
    : normalized
}

function normalizeArtworkUrl(value: string | null | undefined): string | undefined {
  const normalized = String(value ?? '').trim()
  if (!normalized) return undefined
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) return normalized
  return undefined
}

function normalizeDiscordAssetKey(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim()
  if (normalized.toLowerCase() === 'purist') return 'puros'
  return normalized
}

export class DiscordRichPresenceService {
  private client: DiscordRpcClient | null = null
  private connectPromise: Promise<void> | null = null
  private reconnectAfter = 0
  private config: DiscordPresenceConfig = {
    enabled: false,
    smallImageKey: '',
    smallImageUrl: '',
    fallbackLargeImageKey: '',
    fallbackLargeImageUrl: '',
  }
  private metadata: DiscordNowPlayingPayload | null = null
  private playback: DiscordPlaybackPayload = {
    state: 'stopped',
    position: 0,
    duration: 0,
  }
  private lastActivityKey: string | null = null
  private lastActivityPosition = 0
  private lastActivityState: DiscordPlaybackState = 'stopped'
  private lastActivitySyncedAt = 0
  private syncTimer: ReturnType<typeof setTimeout> | null = null

  configure(config: DiscordPresenceConfig) {
    const nextSmallImageKey = normalizeDiscordAssetKey(config.smallImageKey)
    const nextSmallImageUrl = config.smallImageUrl?.trim() ?? ''
    const nextFallbackLargeImageKey = normalizeDiscordAssetKey(config.fallbackLargeImageKey)
    const nextFallbackLargeImageUrl = config.fallbackLargeImageUrl?.trim() ?? ''
    const changed = this.config.enabled !== config.enabled
      || this.config.smallImageKey !== nextSmallImageKey
      || this.config.smallImageUrl !== nextSmallImageUrl
      || this.config.fallbackLargeImageKey !== nextFallbackLargeImageKey
      || this.config.fallbackLargeImageUrl !== nextFallbackLargeImageUrl
    this.config = {
      enabled: config.enabled,
      smallImageKey: nextSmallImageKey,
      smallImageUrl: nextSmallImageUrl,
      fallbackLargeImageKey: nextFallbackLargeImageKey,
      fallbackLargeImageUrl: nextFallbackLargeImageUrl,
    }
    if (!changed) return

    if (!this.config.enabled) {
      void this.clearAndDisconnect()
      return
    }

    this.lastActivityKey = null
    this.scheduleSync(true)
  }

  setNowPlaying(payload: DiscordNowPlayingPayload) {
    this.metadata = payload
    this.playback = {
      ...this.playback,
      duration: clampDuration(payload.duration),
      position: Math.max(0, payload.position || 0),
    }
    this.scheduleSync(true)
  }

  updatePlaybackState(payload: DiscordPlaybackPayload) {
    this.playback = {
      state: payload.state,
      position: Math.max(0, payload.position || 0),
      duration: clampDuration(payload.duration),
    }
    this.scheduleSync(payload.state !== this.lastActivityState)
  }

  clearNowPlaying() {
    this.metadata = null
    this.playback = {
      state: 'stopped',
      position: 0,
      duration: 0,
    }
    this.scheduleSync(true)
  }

  shutdown() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    void this.disconnectClient()
  }

  private scheduleSync(immediate = false) {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    if (immediate) {
      void this.sync()
      return
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.sync()
    }, 150)
  }

  private async sync() {
    if (!this.config.enabled) {
      await this.clearAndDisconnect()
      return
    }

    if (!this.metadata || this.playback.state === 'stopped') {
      await this.clearActivity()
      return
    }

    const activity = this.buildActivity()
    if (!activity) {
      await this.clearActivity()
      return
    }

    if (!(await this.ensureConnected())) return
    if (!this.client?.user) return

    const nextKey = this.getActivityKey(activity)
    if (!this.shouldSyncActivity(nextKey)) return

    try {
      await this.setActivityRaw(activity)
      this.lastActivityKey = nextKey
      this.lastActivityPosition = this.playback.position
      this.lastActivityState = this.playback.state
      this.lastActivitySyncedAt = Date.now()
    } catch (err) {
      console.warn('[Puros][Discord] Failed to update Rich Presence:', err)
      this.lastActivityKey = null
      this.reconnectAfter = Date.now() + RECONNECT_COOLDOWN_MS
      await this.disconnectClient()
    }
  }

  private buildActivity(): DiscordActivity | null {
    if (!this.metadata) return null

    const title = sanitizeText(this.metadata.title)
    const artist = sanitizeText(this.metadata.artist)
    const album = sanitizeText(this.metadata.album)

    if (!title) return null

    const artworkUrl = normalizeArtworkUrl(this.metadata.artworkUrl)
    const providerTrackUrl = normalizeArtworkUrl(this.metadata.providerTrackUrl)
    const smallImageUrl = normalizeArtworkUrl(this.config.smallImageUrl)
    const fallbackLargeImageUrl = normalizeArtworkUrl(this.config.fallbackLargeImageUrl)
    const duration = clampDuration(this.playback.duration || this.metadata.duration)
    const position = Math.max(0, this.playback.position || this.metadata.position || 0)

    const resolvedLargeImage = artworkUrl
      ?? fallbackLargeImageUrl
      ?? this.config.fallbackLargeImageKey
      ?? undefined

    const resolvedSmallImageKey = smallImageUrl
      ? undefined
      : this.config.smallImageKey || undefined

    const buttons: Array<{ label: string; url: string }> = [
      { label: 'Get Puros', url: PUROS_DOWNLOAD_URL },
    ]
    if (providerTrackUrl) {
      const providerName = sanitizeText(this.metadata.providerLabel, 24) ?? 'Platform'
      buttons.push({
        label: `Listen on ${providerName}`,
        url: providerTrackUrl,
      })
    }

    const activity: DiscordActivity = {
      name: 'Puros',
      type: LISTENING_ACTIVITY_TYPE,
      details: title,
      state: this.playback.state === 'paused'
        ? `Paused${artist ? ` • ${artist}` : ''}`
        : (artist ?? album ?? 'Listening now'),
      largeImageKey: resolvedLargeImage,
      largeImageText: album ?? title ?? 'Puros',
      smallImageKey: resolvedSmallImageKey,
      smallImageUrl,
      smallImageText: this.playback.state === 'paused' ? 'Paused in Puros' : 'Puros',
      buttons,
    }

    if (this.playback.state === 'playing' && duration > 0) {
      const start = new Date(Date.now() - position * 1000)
      activity.startTimestamp = start
      activity.endTimestamp = new Date(start.getTime() + duration * 1000)
    }

    return activity
  }

  private async setActivityRaw(activity: DiscordActivity) {
    if (!this.client) return

    const formattedActivity: Record<string, unknown> = {
      name: activity.name,
      type: activity.type,
      instance: false,
    }

    if (activity.details) formattedActivity.details = activity.details
    if (activity.state) formattedActivity.state = activity.state

    if (activity.startTimestamp || activity.endTimestamp) {
      const timestamps: Record<string, number> = {}
      if (activity.startTimestamp instanceof Date) {
        timestamps.start = activity.startTimestamp.getTime()
      } else if (typeof activity.startTimestamp === 'number') {
        timestamps.start = activity.startTimestamp
      }
      if (activity.endTimestamp instanceof Date) {
        timestamps.end = activity.endTimestamp.getTime()
      } else if (typeof activity.endTimestamp === 'number') {
        timestamps.end = activity.endTimestamp
      }
      if (Object.keys(timestamps).length) {
        formattedActivity.timestamps = timestamps
      }
    }

    if (
      activity.largeImageKey
      || activity.smallImageKey
      || activity.largeImageUrl
      || activity.smallImageUrl
      || activity.largeImageText
      || activity.smallImageText
    ) {
      const assets: Record<string, string> = {}
      if (activity.largeImageKey) assets.large_image = activity.largeImageKey
      if (activity.smallImageKey) assets.small_image = activity.smallImageKey
      if (activity.largeImageUrl) assets.large_url = activity.largeImageUrl
      if (activity.smallImageUrl) assets.small_url = activity.smallImageUrl
      if (activity.largeImageText) assets.large_text = activity.largeImageText
      if (activity.smallImageText) assets.small_text = activity.smallImageText
      if (Object.keys(assets).length) {
        formattedActivity.assets = assets
      }
    }

    if (activity.buttons?.length) {
      formattedActivity.buttons = activity.buttons
    }

    await (this.client as DiscordRpcClient & {
      request: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
    }).request('SET_ACTIVITY', {
      pid: process.pid,
      activity: formattedActivity,
    })
  }

  private getActivityKey(activity: DiscordActivity) {
    return JSON.stringify({
      name: activity.name,
      type: activity.type,
      details: activity.details ?? null,
      state: activity.state ?? null,
      duration: Math.round(this.playback.duration || this.metadata?.duration || 0),
      largeImageKey: activity.largeImageKey ?? null,
      smallImageKey: activity.smallImageKey ?? null,
      largeImageUrl: activity.largeImageUrl ?? null,
      smallImageUrl: activity.smallImageUrl ?? null,
      buttons: activity.buttons ?? null,
      playbackState: this.playback.state,
    })
  }

  private shouldSyncActivity(nextKey: string) {
    if (!this.lastActivityKey) return true
    if (this.lastActivityKey !== nextKey) return true
    if (this.playback.state !== this.lastActivityState) return true

    const now = Date.now()
    if (this.playback.state === 'playing') {
      const expectedPosition = this.lastActivityPosition + (now - this.lastActivitySyncedAt) / 1000
      return Math.abs(this.playback.position - expectedPosition) >= POSITION_RESYNC_DRIFT_SECONDS
    }

    return Math.abs(this.playback.position - this.lastActivityPosition) >= POSITION_RESYNC_DRIFT_SECONDS
  }

  private async ensureConnected() {
    if (!this.config.enabled) return false
    if (this.client?.isConnected && this.client.user) return true
    if (this.connectPromise) {
      await this.connectPromise
      return Boolean(this.client?.isConnected && this.client.user)
    }
    if (Date.now() < this.reconnectAfter) return false

    if (!this.client || this.client.clientId !== PUROS_DISCORD_CLIENT_ID) {
      await this.disconnectClient()
      this.client = new Client({
        clientId: PUROS_DISCORD_CLIENT_ID,
      })
      this.client.on('disconnected', () => {
        this.lastActivityKey = null
      })
      this.client.on('debug', (...data) => {
        if (!data.length) return
        console.debug('[Puros][Discord]', ...data)
      })
    }

    this.connectPromise = (async () => {
      try {
        await this.client!.login()
      } catch (err) {
        console.warn('[Puros][Discord] Failed to connect Rich Presence:', err)
        this.reconnectAfter = Date.now() + RECONNECT_COOLDOWN_MS
        await this.disconnectClient()
      } finally {
        this.connectPromise = null
      }
    })()

    await this.connectPromise
    return Boolean(this.client?.isConnected && this.client.user)
  }

  private async clearActivity() {
    this.lastActivityKey = null
    this.lastActivityState = 'stopped'
    this.lastActivityPosition = 0
    this.lastActivitySyncedAt = 0

    if (!this.client?.isConnected || !this.client.user) return

    try {
      await this.client.user.clearActivity(process.pid)
    } catch (err) {
      console.warn('[Puros][Discord] Failed to clear Rich Presence:', err)
    }
  }

  private async clearAndDisconnect() {
    await this.clearActivity()
    await this.disconnectClient()
  }

  private async disconnectClient() {
    const client = this.client
    this.client = null
    this.connectPromise = null
    if (!client) return
    try {
      await client.destroy()
    } catch {
      // ignore disconnect failures
    }
  }
}
