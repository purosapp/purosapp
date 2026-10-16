import { create } from 'zustand'
import type { ProviderDescriptorV1, ProviderEventEnvelopeV1 } from '../provider-api/v1'

export type ProviderWarningCode =
  | 'rate_limited'
  | 'auth_expired'
  | 'provider_unavailable'
  | 'partial_results'
  | 'sync_failed'
  | 'playback_failed'

export interface ProviderWarning {
  provider: string
  code: ProviderWarningCode
  message: string
  scope?: string | null
  retryable?: boolean
  timestamp: number
}

interface ProviderStatusState {
  providers: ProviderDescriptorV1[]
  loaded: boolean
  latestEvents: Record<string, ProviderEventEnvelopeV1>
  currentWarning: ProviderWarning | null
  loadProviders: () => Promise<void>
  refreshProvider: (providerId: string) => Promise<void>
  setWarning: (warning: Omit<ProviderWarning, 'timestamp'>) => void
  clearWarning: () => void
}

let unsubscribeProviderEvents: (() => void) | null = null

export const useProviderStatusStore = create<ProviderStatusState>((set, get) => ({
  providers: [],
  loaded: false,
  latestEvents: {},
  currentWarning: null,

  loadProviders: async () => {
    const providers = await window.puros.provider.list()
    set({ providers, loaded: true })
    if (!unsubscribeProviderEvents) {
      unsubscribeProviderEvents = window.puros.provider.onEvent((event) => {
        const changedStatus = event.event.type === 'status.changed' ? event.event.status : null
        set((state) => ({
          latestEvents: { ...state.latestEvents, [event.providerId]: event },
          providers: changedStatus
            ? state.providers.map((descriptor) => (
              descriptor.manifest.id === event.providerId
                ? { ...descriptor, status: changedStatus }
                : descriptor
            ))
            : state.providers,
        }))
      })
    }
  },

  refreshProvider: async (providerId) => {
    const status = await window.puros.provider.status(providerId)
    set({
      providers: get().providers.map((descriptor) => (
        descriptor.manifest.id === providerId ? { ...descriptor, status } : descriptor
      )),
    })
  },

  setWarning: (warning) => set({
    currentWarning: {
      ...warning,
      timestamp: Date.now(),
    },
  }),

  clearWarning: () => set({ currentWarning: null }),
}))
