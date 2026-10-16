import { sendToRenderer } from './rendererBridge'

type PlaybackState = 'playing' | 'paused' | 'stopped'

let playbackState: PlaybackState = 'stopped'
const playbackIdleWaiters = new Set<() => void>()

export function setPlaybackState(nextState: PlaybackState) {
  playbackState = nextState
  if (nextState === 'playing') return
  for (const resolve of playbackIdleWaiters) resolve()
  playbackIdleWaiters.clear()
}

export function isPlaybackActive() {
  return playbackState === 'playing'
}

export async function waitForPlaybackIdle(): Promise<void> {
  while (isPlaybackActive()) {
    await new Promise<void>((resolve) => playbackIdleWaiters.add(resolve))
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  if (isPlaybackActive()) await waitForPlaybackIdle()
}

export async function pauseBackgroundWorkForPlayback(): Promise<void> {
  if (isPlaybackActive()) await waitForPlaybackIdle()
}

export function runPlaybackIdleTask(label: string, task: () => Promise<void> | void): void {
  void (async () => {
    await waitForPlaybackIdle()
    await task()
  })().catch((error) => {
    console.warn(`[Puros] Deferred ${label} failed:`, error)
  })
}

let playbackIdleRefreshScheduled = false
let refreshPlaylistsWhenIdle = false
let refreshLibraryWhenIdle = false
let refreshCatalogWhenIdle = false

export function schedulePlaybackIdleRefresh(options: {
  playlists?: boolean
  library?: boolean
  catalog?: boolean
} = {}) {
  refreshPlaylistsWhenIdle ||= options.playlists ?? true
  refreshLibraryWhenIdle ||= options.library ?? true
  refreshCatalogWhenIdle ||= options.catalog ?? true
  if (playbackIdleRefreshScheduled) return

  playbackIdleRefreshScheduled = true
  runPlaybackIdleTask('library refresh notification', () => {
    playbackIdleRefreshScheduled = false
    if (refreshPlaylistsWhenIdle) sendToRenderer('playlists:changed')
    if (refreshLibraryWhenIdle) sendToRenderer('library:changed')
    if (refreshCatalogWhenIdle) sendToRenderer('catalog:changed')
    refreshPlaylistsWhenIdle = false
    refreshLibraryWhenIdle = false
    refreshCatalogWhenIdle = false
  })
}
