import { usePlayerStore } from '../store/playerStore'
import { useProviderStatusStore } from '../store/providerStatusStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  HOME_RECENTS_CHANGED_EVENT,
  filterVisibleRecentPlaylists,
  getRecentPlaylistDedupeKey,
  loadRecentlyPlayedPlaylists,
  openRecentPlaylist,
  type RecentPlaylistEntry,
} from './homeRecents'

const MAX_DOCK_RECENTS = 5

export interface DockMenuState {
  hasTrack: boolean
  isPlaying: boolean
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
  recents: Array<{ id: string; title: string }>
}

/** The recently played playlists Home would show (unavailable providers hidden unless the user opted in). */
function visibleRecents(entries: RecentPlaylistEntry[]): RecentPlaylistEntry[] {
  const availableProviders = new Set(useProviderStatusStore.getState().providers
    .filter(({ status }) => (status.state === 'ready' || status.state === 'degraded') && status.authenticated !== false)
    .map(({ manifest }) => manifest.id))
  return filterVisibleRecentPlaylists(entries, availableProviders, useSettingsStore.getState().showUnavailableSources)
    .slice(0, MAX_DOCK_RECENTS)
}

export function buildDockMenuState(recents: RecentPlaylistEntry[]): DockMenuState {
  const { currentTrack, isPlaying, shuffle, repeat } = usePlayerStore.getState()
  return {
    hasTrack: !!currentTrack,
    isPlaying: !!currentTrack && isPlaying,
    shuffle,
    repeat,
    recents: visibleRecents(recents).map((entry) => ({ id: getRecentPlaylistDedupeKey(entry), title: entry.name })),
  }
}

/** Keeps the macOS Dock icon menu in step with the player; returns a cleanup. */
export function startDockMenuSync(): () => void {
  let recents: RecentPlaylistEntry[] = []
  let scheduled = false
  let disposed = false

  const push = () => {
    scheduled = false
    if (disposed) return
    void window.puros.app.setDockMenu(buildDockMenuState(recents))
      .catch((error: unknown) => console.warn('[Puros] Could not update the Dock menu:', error))
  }
  // Several stores can change in one tick; send one update.
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(push)
  }
  const loadRecents = async () => {
    recents = await loadRecentlyPlayedPlaylists()
    schedule()
  }

  const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
    // The store updates position many times a second; only these fields matter here.
    if (
      !!state.currentTrack !== !!previous.currentTrack ||
      state.isPlaying !== previous.isPlaying ||
      state.shuffle !== previous.shuffle ||
      state.repeat !== previous.repeat
    ) schedule()
  })
  const unsubscribeProviders = useProviderStatusStore.subscribe((state, previous) => {
    if (state.providers !== previous.providers) schedule()
  })
  const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
    if (state.showUnavailableSources !== previous.showUnavailableSources) schedule()
  })
  const handleRecentsChanged = () => { void loadRecents() }
  window.addEventListener(HOME_RECENTS_CHANGED_EVENT, handleRecentsChanged)
  const unsubscribeOpen = window.puros.on('player:open-recent', (id: unknown) => {
    const entry = recents.find((candidate) => getRecentPlaylistDedupeKey(candidate) === id)
    if (entry) openRecentPlaylist(entry)
  })

  void loadRecents()
  return () => {
    disposed = true
    unsubscribePlayer()
    unsubscribeProviders()
    unsubscribeSettings()
    window.removeEventListener(HOME_RECENTS_CHANGED_EVENT, handleRecentsChanged)
    unsubscribeOpen()
  }
}
