import { create } from 'zustand'
import { LastFmService } from '../services/lastfm/LastFmService'
import { DEFAULT_LASTFM_CONFIG, type LastFmConfig, type LastFmTrack } from '../services/lastfm/types'
import { usePlayerStore } from './playerStore'

const CONFIG_KEY = 'lastfmConfig'

interface LastFmState {
  config: LastFmConfig
  service: LastFmService | null
  loaded: boolean
  authenticating: boolean
  scrobbleCount: number
  offlineQueue: LastFmTrack[]
  authError: string | null
  configured: boolean
  isConnected: boolean
  load: () => Promise<void>
  updateConfig: (config: Partial<LastFmConfig>) => Promise<void>
  authenticate: (token: string) => Promise<void>
  disconnect: () => Promise<void>
  getService: () => LastFmService | null
  flushOfflineQueue: () => Promise<void>
}

function parseConfig(raw: string | null): LastFmConfig {
  const fallback: LastFmConfig = DEFAULT_LASTFM_CONFIG

  if (!raw) return fallback

  try {
    const parsed = JSON.parse(raw) as Partial<LastFmConfig>
    return {
      ...fallback,
      ...parsed,
      enabled: parsed.enabled ?? fallback.enabled,
      scrobbleThreshold: parsed.scrobbleThreshold ?? fallback.scrobbleThreshold,
      minDuration: parsed.minDuration ?? fallback.minDuration,
      showScrobbleToasts: parsed.showScrobbleToasts ?? fallback.showScrobbleToasts,
    }
  } catch {
    return fallback
  }
}

function isConnected(config: LastFmConfig): boolean {
  return !!config.sessionKey
}

function userMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useLastFmStore = create<LastFmState>((set, get) => {
  let unsubscribers: Array<() => void> = []

  const bindService = (config: LastFmConfig) => {
    unsubscribers.forEach((unsubscribe) => unsubscribe())
    unsubscribers = []

    const service = new LastFmService(config)
    const flushOnOnline = () => {
      void service.flushOfflineQueue()
    }
    window.addEventListener('online', flushOnOnline)

    unsubscribers = [
      () => window.removeEventListener('online', flushOnOnline),
      service.on('scrobbled', (track) => {
        set((state) => ({ scrobbleCount: state.scrobbleCount + 1 }))
        if (get().config.showScrobbleToasts) {
          usePlayerStore.getState().setNotification(`Scrobbled: ${track.artist} - ${track.track}`)
        }
      }),
      service.on('queuedForLater', () => {
        if (get().config.showScrobbleToasts) {
          usePlayerStore.getState().setNotification('Last.fm scrobble queued for later')
        }
      }),
      service.on('queueChanged', (offlineQueue) => {
        set({ offlineQueue })
      }),
      service.on('flushedQueue', (count) => {
        if (count > 0) {
          usePlayerStore.getState().setNotification(`Sent ${count} queued Last.fm scrobble${count === 1 ? '' : 's'}`)
        }
      }),
    ]

    set({ service, offlineQueue: service.getOfflineQueue() })
    void service.flushOfflineQueue()
    return service
  }

  const persistConfig = async (config: LastFmConfig) => {
    const storedConfig: LastFmConfig = {
      enabled: config.enabled,
      sessionKey: config.sessionKey,
      username: config.username,
      scrobbleThreshold: config.scrobbleThreshold,
      minDuration: config.minDuration,
      showScrobbleToasts: config.showScrobbleToasts,
    }
    await window.puros.settings.set(CONFIG_KEY, JSON.stringify(storedConfig))
  }

  return {
    config: DEFAULT_LASTFM_CONFIG,
    service: null,
    loaded: false,
    authenticating: false,
    scrobbleCount: 0,
    offlineQueue: [],
    authError: null,
    configured: false,
    isConnected: false,

    load: async () => {
      if (get().loaded) return

      const [rawConfig, status] = await Promise.all([
        window.puros.settings.get(CONFIG_KEY),
        window.puros.lastfm.getConfigStatus(),
      ])

      const config = parseConfig(rawConfig)
      set({
        config,
        loaded: true,
        configured: status.configured,
        isConnected: isConnected(config),
      })
      bindService(config)

      if (rawConfig && (rawConfig.includes('"apiKey"') || rawConfig.includes('"apiSecret"'))) {
        await persistConfig(config)
      }
    },

    updateConfig: async (patch) => {
      const config: LastFmConfig = {
        ...get().config,
        ...patch,
        scrobbleThreshold: patch.scrobbleThreshold !== undefined
          ? Math.max(0.1, Math.min(1, patch.scrobbleThreshold))
          : get().config.scrobbleThreshold,
        minDuration: patch.minDuration !== undefined
          ? Math.max(30, patch.minDuration)
          : get().config.minDuration,
      }

      get().service?.updateConfig(config)
      set({ config, isConnected: isConnected(config), authError: null })
      await persistConfig(config)
      bindService(config)
    },

    authenticate: async (token) => {
      const trimmedToken = token.trim()
      if (!trimmedToken) return

      set({ authenticating: true, authError: null })
      try {
        const config = { ...get().config, enabled: true }
        const service = new LastFmService(config)
        const session = await service.authenticate(trimmedToken)
        const nextConfig: LastFmConfig = {
          ...config,
          sessionKey: session.sessionKey,
          username: session.username,
          enabled: true,
        }

        set({
          config: nextConfig,
          authenticating: false,
          isConnected: true,
          authError: null,
        })
        await persistConfig(nextConfig)
        const nextService = bindService(nextConfig)
        void nextService?.flushOfflineQueue()
        void window.puros.lastfm.completeAuth(trimmedToken).catch(() => {})
        usePlayerStore.getState().setNotification(`Connected Last.fm as ${session.username}`)
      } catch (error) {
        set({ authenticating: false, authError: userMessage(error) })
        usePlayerStore.getState().setNotification(`Last.fm sign-in failed: ${userMessage(error)}`)
      }
    },

    disconnect: async () => {
      get().service?.disconnect()
      const config: LastFmConfig = {
        ...get().config,
        sessionKey: undefined,
        username: undefined,
        enabled: false,
      }
      set({
        config,
        isConnected: false,
        service: null,
        authError: null,
      })
      await persistConfig(config)
      bindService(config)
    },

    getService: () => get().service,

    flushOfflineQueue: async () => {
      await get().service?.flushOfflineQueue()
    },
  }
})
