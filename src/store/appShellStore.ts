import { create } from 'zustand'
import type { HomeProviderCollectionItem } from '../services/homeProviderShelves'
import { useCatalogStore } from './catalogStore'

export type AppShellView = 'library' | 'explore' | 'artists' | 'albums' | 'tracks' | 'genres' | 'history' | 'pins' | 'live-radio' | 'provider-collection' | number
export type CatalogSurfaceScope = 'library' | 'explore'

interface AppShellHistorySnapshot {
  providerId: string
  activeView: AppShellView
  lastCatalogScope: CatalogSurfaceScope
  currentProviderCollection: HomeProviderCollectionItem | null
}

interface AppShellState {
  activeView: AppShellView
  lastCatalogScope: CatalogSurfaceScope
  currentProviderCollection: HomeProviderCollectionItem | null
  history: AppShellHistorySnapshot[]
  canGoBack: boolean
  future: AppShellHistorySnapshot[]
  canGoForward: boolean
  setActiveView: (view: AppShellView) => void
  openPlaylist: (playlistId: number) => void
  openProviderCollection: (collection: HomeProviderCollectionItem) => void
  openCatalogArtist: (catalogArtistId: string, scope?: CatalogSurfaceScope) => Promise<void>
  openCatalogAlbum: (catalogAlbumId: string, scope?: CatalogSurfaceScope) => Promise<void>
  goBack: () => void
  goForward: () => void
  clearForward: () => void
}

function createShellSnapshot(state: Pick<AppShellState, 'activeView' | 'lastCatalogScope' | 'currentProviderCollection'>): AppShellHistorySnapshot {
  return {
    providerId: useCatalogStore.getState().activeProviderId,
    activeView: state.activeView,
    lastCatalogScope: state.lastCatalogScope,
    currentProviderCollection: state.currentProviderCollection,
  }
}

function restoreShellSnapshot(snapshot: AppShellHistorySnapshot) {
  useCatalogStore.getState().setProvider(snapshot.providerId, { browse: false, pushHistory: false })
  return {
    activeView: snapshot.activeView,
    lastCatalogScope: snapshot.lastCatalogScope,
    currentProviderCollection: snapshot.currentProviderCollection,
  }
}

export const useAppShellStore = create<AppShellState>((set, get) => ({
  activeView: 'library',
  lastCatalogScope: 'explore',
  currentProviderCollection: null,
  history: [],
  canGoBack: false,
  future: [],
  canGoForward: false,

  setActiveView: (view) => {
    const state = get()
    if (state.activeView === view && view !== 'provider-collection') {
      if (view === 'explore') {
        useCatalogStore.getState().resetToDefault()
      }
      return
    }

    set((currentState) => {
      const nextHistory = [...currentState.history, createShellSnapshot(currentState)]
      return {
        activeView: view,
        currentProviderCollection: typeof view === 'number' || view === 'library' || view === 'explore' || view === 'artists' || view === 'albums' || view === 'tracks' || view === 'genres' || view === 'history' || view === 'pins' || view === 'live-radio'
          ? null
          : currentState.currentProviderCollection,
        lastCatalogScope: typeof view === 'number'
          ? currentState.lastCatalogScope
          : view === 'explore'
            ? 'explore'
            : currentState.lastCatalogScope,
        history: nextHistory,
        canGoBack: nextHistory.length > 0,
      }
    })
  },

  openPlaylist: (playlistId) => set((state) => {
    if (state.activeView === playlistId) return state
    const nextHistory = [...state.history, createShellSnapshot(state)]
    return {
      activeView: playlistId,
      currentProviderCollection: null,
      lastCatalogScope: state.lastCatalogScope,
      history: nextHistory,
      canGoBack: nextHistory.length > 0,
    }
  }),

  openProviderCollection: (collection) => set((state) => {
    if (
      state.activeView === 'provider-collection' &&
      state.currentProviderCollection?.id === collection.id &&
      state.currentProviderCollection?.sourceId === collection.sourceId &&
      state.currentProviderCollection?.provider === collection.provider
    ) {
      return state
    }

    const nextHistory = [...state.history, createShellSnapshot(state)]
    return {
      activeView: 'provider-collection',
      currentProviderCollection: collection,
      lastCatalogScope: state.lastCatalogScope,
      history: nextHistory,
      canGoBack: nextHistory.length > 0,
    }
  }),

  openCatalogArtist: async (catalogArtistId, scope) => {
    const nextScope = scope ?? 'explore'
    const enteringFromOutsideExplore = get().activeView !== 'explore'
    if (enteringFromOutsideExplore) {
      useCatalogStore.getState().clearHistory()
    }
    const openArtistPromise = useCatalogStore.getState().openArtist(catalogArtistId, {
      pushHistory: !enteringFromOutsideExplore,
    })
    set((state) => {
      const nextHistory = enteringFromOutsideExplore
        ? [...state.history, createShellSnapshot(state)]
        : state.history
      return {
        activeView: 'explore',
        lastCatalogScope: nextScope,
        currentProviderCollection: null,
        history: nextHistory,
        canGoBack: nextHistory.length > 0,
      }
    })
    await openArtistPromise
  },

  openCatalogAlbum: async (catalogAlbumId, scope) => {
    const nextScope = scope ?? 'explore'
    const enteringFromOutsideExplore = get().activeView !== 'explore'
    if (enteringFromOutsideExplore) {
      useCatalogStore.getState().clearHistory()
    }
    const openAlbumPromise = useCatalogStore.getState().openAlbum(catalogAlbumId, {
      pushHistory: !enteringFromOutsideExplore,
    })
    set((state) => {
      const nextHistory = enteringFromOutsideExplore
        ? [...state.history, createShellSnapshot(state)]
        : state.history
      return {
        activeView: 'explore',
        lastCatalogScope: nextScope,
        currentProviderCollection: null,
        history: nextHistory,
        canGoBack: nextHistory.length > 0,
      }
    })
    await openAlbumPromise
  },

  goBack: () => set((state) => {
    const previous = state.history[state.history.length - 1]
    if (!previous) return state
    const nextHistory = state.history.slice(0, -1)
    const nextFuture = [...state.future, createShellSnapshot(state)]
    return {
      ...restoreShellSnapshot(previous),
      history: nextHistory,
      canGoBack: nextHistory.length > 0,
      future: nextFuture,
      canGoForward: true,
    }
  }),

  goForward: () => set((state) => {
    const next = state.future[state.future.length - 1]
    if (!next) return state
    const nextFuture = state.future.slice(0, -1)
    const nextHistory = [...state.history, createShellSnapshot(state)]
    return {
      ...restoreShellSnapshot(next),
      history: nextHistory,
      canGoBack: true,
      future: nextFuture,
      canGoForward: nextFuture.length > 0,
    }
  }),

  clearForward: () => {
    if (get().future.length > 0) set({ future: [], canGoForward: false })
  },
}))
