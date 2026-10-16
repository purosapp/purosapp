/**
 * Remembers the player session (queue, current track, position, shuffle,
 * repeat) across launches when Settings → Playback → "Remember last session"
 * is on.
 *
 * The queue is saved debounced whenever it changes; the position is saved
 * under its own key every few seconds while playing, on pause and on unload,
 * so position ticks never rewrite the whole queue.
 */

import { getTrackIdentity, tracksShareIdentity, usePlayerStore, type Track } from '../store/playerStore'
import { useSettingsStore } from '../store/settingsStore'
import { deleteSetting, getJsonSetting, setJsonSetting } from '../utils/appSettings'
import { audioService } from './AudioService'
import { isLiveRadioTrack } from './liveRadio/track'

const SNAPSHOT_KEY = 'playbackSession'
const POSITION_KEY = 'playbackSessionPosition'
const SNAPSHOT_VERSION = 1
const SNAPSHOT_DEBOUNCE_MS = 1500
const POSITION_SAVE_INTERVAL_MS = 5000
/** A track saved this close to its end starts over instead. */
const END_GUARD_SECONDS = 5

interface PlaybackSessionSnapshot {
  version: typeof SNAPSHOT_VERSION
  queue: Track[]
  /** Shuffled order as indexes into `queue`; null when it could not be mapped. */
  shuffledOrder: number[] | null
  queuePrimaryLength: number
  queueIndex: number
  radioArtistName: string | null
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
  currentTrack: Track
}

interface PlaybackSessionPosition {
  trackIdentity: string | null
  position: number
}

/** data:/blob: artwork is session-local (and data: URLs can be huge), so it is not saved. */
function persistableTrack(track: Track): Track {
  const isTransient = (url: string | null | undefined) => !!url && /^(data|blob):/i.test(url)
  if (!isTransient(track.coverUrl) && !isTransient(track.artworkUrl)) return track
  return {
    ...track,
    coverUrl: isTransient(track.coverUrl) ? null : track.coverUrl,
    artworkUrl: isTransient(track.artworkUrl) ? null : track.artworkUrl,
  }
}

function buildSnapshot(state: ReturnType<typeof usePlayerStore.getState>): PlaybackSessionSnapshot | null {
  if (!state.currentTrack) return null
  const queueIndexes = new Map(state.queue.map((track, index) => [track, index]))
  const shuffledOrder = state.shuffledQueue.map((track) => queueIndexes.get(track) ?? -1)
  return {
    version: SNAPSHOT_VERSION,
    queue: state.queue.map(persistableTrack),
    shuffledOrder: shuffledOrder.includes(-1) ? null : shuffledOrder,
    queuePrimaryLength: state.queuePrimaryLength,
    queueIndex: state.queueIndex,
    radioArtistName: state.radioArtistName,
    shuffle: state.shuffle,
    repeat: state.repeat,
    currentTrack: persistableTrack(state.currentTrack),
  }
}

function isSnapshot(value: unknown): value is PlaybackSessionSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<PlaybackSessionSnapshot>
  return snapshot.version === SNAPSHOT_VERSION
    && Array.isArray(snapshot.queue)
    && !!snapshot.currentTrack
    && typeof snapshot.currentTrack.id === 'string'
}

/** Restores the saved session if the setting is on and nothing is playing yet. */
export async function restorePlaybackSession(): Promise<void> {
  const settings = useSettingsStore.getState()
  if (!settings.rememberPlaybackSession) return

  const [rawSnapshot, savedPosition] = await Promise.all([
    getJsonSetting<unknown>(SNAPSHOT_KEY, null),
    getJsonSetting<PlaybackSessionPosition | null>(POSITION_KEY, null),
  ])
  if (!isSnapshot(rawSnapshot)) return
  // The user already started something while settings were loading.
  if (usePlayerStore.getState().currentTrack) return

  const snapshot = rawSnapshot
  const queue = snapshot.queue
  const shuffledQueue = snapshot.shuffledOrder
    && snapshot.shuffledOrder.length > 0
    && snapshot.shuffledOrder.every((index) => Number.isInteger(index) && index >= 0 && index < queue.length)
    ? snapshot.shuffledOrder.map((index) => queue[index])
    : [...queue]
  const activeQueue = snapshot.shuffle ? shuffledQueue : queue

  // Reuse the queue entry so next/previous continue from it; fall back to a
  // one-track queue when the current track was played outside the queue.
  let queueIndex = snapshot.queueIndex
  if (!tracksShareIdentity(activeQueue[queueIndex], snapshot.currentTrack)) {
    queueIndex = activeQueue.findIndex((track) => tracksShareIdentity(track, snapshot.currentTrack))
  }
  const restoredQueue = queueIndex >= 0 ? queue : [snapshot.currentTrack]
  const restoredShuffledQueue = queueIndex >= 0 ? shuffledQueue : [snapshot.currentTrack]
  if (queueIndex < 0) queueIndex = 0
  const currentTrack = (snapshot.shuffle ? restoredShuffledQueue : restoredQueue)[queueIndex]

  let position = 0
  if (
    savedPosition
    && savedPosition.trackIdentity === getTrackIdentity(currentTrack)
    && Number.isFinite(savedPosition.position)
    && !isLiveRadioTrack(currentTrack)
  ) {
    position = Math.max(0, savedPosition.position - settings.resumeRewindSeconds)
    if (currentTrack.duration > 0 && position >= currentTrack.duration - END_GUARD_SECONDS) position = 0
  }

  await audioService.restoreSession({
    queue: restoredQueue,
    shuffledQueue: restoredShuffledQueue,
    queuePrimaryLength: Math.max(0, Math.min(snapshot.queuePrimaryLength, restoredQueue.length)),
    queueIndex,
    radioArtistName: snapshot.radioArtistName ?? null,
    shuffle: !!snapshot.shuffle,
    repeat: snapshot.repeat === 'all' || snapshot.repeat === 'one' ? snapshot.repeat : 'off',
    currentTrack,
    position,
  }, { autoplay: settings.resumePlaybackOnLaunch })
}

/** Keeps the saved session in sync with the player. Returns a cleanup function. */
export function startPlaybackSessionPersistence(): () => void {
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null
  let lastPositionSaveAt = 0

  const saveSnapshot = () => {
    if (snapshotTimer) clearTimeout(snapshotTimer)
    snapshotTimer = null
    const snapshot = buildSnapshot(usePlayerStore.getState())
    void (snapshot ? setJsonSetting(SNAPSHOT_KEY, snapshot) : deleteSetting(SNAPSHOT_KEY)).catch((error) => {
      console.warn('[PlaybackSession] Failed to save session:', error)
    })
  }

  const scheduleSnapshot = () => {
    if (snapshotTimer) clearTimeout(snapshotTimer)
    snapshotTimer = setTimeout(saveSnapshot, SNAPSHOT_DEBOUNCE_MS)
  }

  const savePosition = () => {
    lastPositionSaveAt = Date.now()
    const { currentTrack, position } = usePlayerStore.getState()
    const value: PlaybackSessionPosition = {
      trackIdentity: getTrackIdentity(currentTrack),
      position: currentTrack && !isLiveRadioTrack(currentTrack) ? position : 0,
    }
    void setJsonSetting(POSITION_KEY, value).catch(() => {
      // Best effort; the next tick retries.
    })
  }

  const flush = () => {
    if (!useSettingsStore.getState().rememberPlaybackSession) return
    if (snapshotTimer) saveSnapshot()
    savePosition()
  }

  const unsubscribePlayer = usePlayerStore.subscribe((state, prev) => {
    if (!useSettingsStore.getState().rememberPlaybackSession) return
    const trackChanged = getTrackIdentity(state.currentTrack) !== getTrackIdentity(prev.currentTrack)
    if (
      trackChanged
      || state.currentTrack !== prev.currentTrack
      || state.queue !== prev.queue
      || state.shuffledQueue !== prev.shuffledQueue
      || state.queueIndex !== prev.queueIndex
      || state.queuePrimaryLength !== prev.queuePrimaryLength
      || state.radioArtistName !== prev.radioArtistName
      || state.shuffle !== prev.shuffle
      || state.repeat !== prev.repeat
    ) {
      scheduleSnapshot()
    }
    if (trackChanged || state.isPlaying !== prev.isPlaying) {
      savePosition()
    } else if (
      state.position !== prev.position
      && (!state.isPlaying || Date.now() - lastPositionSaveAt >= POSITION_SAVE_INTERVAL_MS)
    ) {
      // Paused seeks are saved right away; playback ticks are throttled.
      savePosition()
    }
  })

  const unsubscribeSettings = useSettingsStore.subscribe((state, prev) => {
    if (state.rememberPlaybackSession === prev.rememberPlaybackSession || !prev.loaded) return
    if (state.rememberPlaybackSession) {
      saveSnapshot()
      savePosition()
    } else {
      if (snapshotTimer) clearTimeout(snapshotTimer)
      snapshotTimer = null
      void deleteSetting(SNAPSHOT_KEY).catch(() => undefined)
      void deleteSetting(POSITION_KEY).catch(() => undefined)
    }
  })

  window.addEventListener('beforeunload', flush)

  return () => {
    flush()
    if (snapshotTimer) clearTimeout(snapshotTimer)
    unsubscribePlayer()
    unsubscribeSettings()
    window.removeEventListener('beforeunload', flush)
  }
}
