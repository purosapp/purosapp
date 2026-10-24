/**
 * Player state — Zustand store.
 *
 * The native audio engine is the source of truth for playback.
 * This store observes state via IPC events and provides
 * a reactive interface for the UI.
 */

import { create } from 'zustand'
import type { FormatInfo, OutputMode } from '../services/local/formats'
import type { PlaybackDecision, DeviceCapabilities } from '../services/formatCompatibility'
import type { BluetoothInfo } from '../../electron/preload'
import type { VolumeControlState } from '../services/volumeControl'
import { fisherYatesShuffle } from '../services/local/scanner'

export type PlaybackContext =
  | { kind: 'playlist'; label: string; playlistId: number }
  | {
      kind: 'provider-playlist'
      label: string
      provider: string
      sourceType: 'playlist' | 'mix' | 'station'
      sourceId: string
      itemId: string
      subtitle?: string | null
      artworkUrl?: string | null
      providerUrl?: string | null
      trackCount?: number | null
      syncedPlaylistId?: number | null
    }
  | { kind: 'album'; label: string; catalogAlbumId: string }
  | { kind: 'artist'; label: string; catalogArtistId: string }
  | { kind: 'artist-radio'; label: string; catalogArtistId: string | null }
  | { kind: 'live-radio'; label: string; stationId: string }

export interface Track {
  id: string
  playlistItemId?: number
  smartStackId?: number | null
  smartStackPosition?: number | null
  title: string
  artist: string
  album: string
  duration: number
  catalogTrackId?: string
  catalogAlbumId?: string | null
  catalogArtistId?: string | null
  sourceType?: string
  sourceId?: string
  displayMetadataSource?: string
  filePath?: string        // local files
  playbackFilePath?: string
  streamId?: string        // streaming tracks
  fallbackStreamIds?: string[]
  provider?: string
  coverUrl?: string | null
  artworkUrl?: string | null
  discordArtworkUrl?: string | null
  formatInfo?: FormatInfo
  startOffsetMs?: number
  endOffsetMs?: number | null
  cueSheetPath?: string | null
  playbackContext?: PlaybackContext | null
  /**
   * Lightweight catalog queue entry whose playable source/artwork/format has
   * not been resolved yet. Resolved just-in-time when it becomes the current
   * track, so playing one song from a playlist doesn't resolve the whole queue.
   */
  unresolved?: boolean
  /**
   * Set when the account cannot stream the track (a provider reason such as
   * `region`). Such entries never enter a queue and are skipped if playback
   * finds out after they were queued.
   */
  unavailableReason?: string | null
}

export interface RestoredPlayerSession {
  queue: Track[]
  shuffledQueue: Track[]
  queuePrimaryLength: number
  queueIndex: number
  radioArtistName: string | null
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
  currentTrack: Track
  position: number
}

interface PlayerState {
  // Current track
  currentTrack: Track | null
  playbackRequestId: number
  formatInfo: FormatInfo | null
  outputMode: OutputMode
  deviceName: string | null

  // Audio output
  audioDevice: string | null      // device UID
  audioMode: 'exclusive' | 'shared' | 'closed'
  audioError: string | null

  // Format decision
  playbackDecision: PlaybackDecision | null
  deviceCapabilities: DeviceCapabilities | null
  deviceFormat: { sampleRate: number; bitDepth: number; channels: number } | null

  // Bluetooth
  bluetoothInfo: BluetoothInfo | null
  processingSpeed: number | null

  // When "__default__" virtual device is active, the physical device name it resolved to
  resolvedDeviceName: string | null

  // Transient info notification (auto-clears, not an error)
  notification: string | null
  bufferProgress: number | null
  /** The file the engine opened for the current track; drives the seek-bar waveform. */
  playbackSource: PlaybackSource | null

  // Playback state
  isPlaying: boolean
  position: number          // seconds
  duration: number          // seconds (from native engine)
  volume: number            // 0-1
  volumeControl: VolumeControlState

  // Queue
  queue: Track[]
  queuePrimaryLength: number
  radioArtistName: string | null
  queueIndex: number
  shuffle: boolean
  shuffledQueue: Track[]
  repeat: 'off' | 'all' | 'one'

  // Actions
  setTrack: (track: Track) => void
  play: () => void
  pause: () => void
  togglePlayPause: () => void
  seek: (position: number) => void
  setVolume: (volume: number) => void
  setVolumeControl: (volumeControl: VolumeControlState) => void
  next: () => void
  previous: () => void

  setQueue: (tracks: Track[], startIndex?: number, playbackContext?: PlaybackContext | null) => void
  jumpToQueueIndex: (index: number) => void
  appendRadioQueue: (tracks: Track[], artistName: string, artistId?: string | null) => void
  addToQueue: (track: Track) => void
  reorderQueue: (fromIndex: number, toIndex: number) => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void
  /** Puts a saved session back without starting playback (AudioService loads it on play). */
  restoreSession: (session: RestoredPlayerSession) => void

  toggleShuffle: () => void
  cycleRepeat: () => void

  setFormatInfo: (info: FormatInfo) => void
  setOutputMode: (mode: OutputMode) => void
  setDeviceName: (name: string | null) => void
  setPosition: (pos: number) => void
  setDuration: (dur: number) => void
  setIsPlaying: (playing: boolean) => void
  setAudioDevice: (deviceUid: string | null) => void
  setAudioMode: (mode: 'exclusive' | 'shared' | 'closed') => void
  setAudioError: (error: string | null) => void
  setDeviceFormat: (fmt: { sampleRate: number; bitDepth: number; channels: number } | null) => void
  setPlaybackDecision: (decision: PlaybackDecision | null) => void
  setDeviceCapabilities: (caps: DeviceCapabilities | null) => void
  setCurrentTrackArtwork: (url: string | null) => void
  hydrateQueueTrack: (target: Track, data: Partial<Track>) => void
  /** Greys out every queue entry for this track's source so the queue skips it. */
  markTrackUnavailable: (target: Track, reason: string) => void
  setBluetoothInfo: (info: BluetoothInfo | null) => void
  setProcessingSpeed: (speed: number | null) => void
  setResolvedDeviceName: (name: string | null) => void
  setNotification: (msg: string | null) => void
  setBufferProgress: (progress: number | null) => void
  setPlaybackSource: (source: PlaybackSource | null) => void
  /** The current track's growing file has been fully written (and possibly moved to `path`). */
  markPlaybackSourceComplete: (trackIdentity: string, path: string) => void
}

export interface PlaybackSource {
  /** getTrackIdentity() of the track playing from this file. */
  trackIdentity: string
  path: string
  /** Still being written by a provider's progressive download. */
  growing: boolean
  /** A CUE track's slice of the file. */
  startSeconds: number
  durationSeconds: number | null
}

let notificationTimer: ReturnType<typeof setTimeout> | null = null
let playbackRequestSequence = 0

export function getTrackIdentity(
  track: Pick<Track, 'id' | 'playlistItemId' | 'catalogTrackId' | 'provider' | 'streamId' | 'sourceId'> | null | undefined,
): string | null {
  if (!track) return null
  if (typeof track.playlistItemId === 'number') {
    return `playlist-item:${track.playlistItemId}`
  }
  if (track.catalogTrackId) return `catalog-track:${track.catalogTrackId}`
  return `track:${track.id}`
}

export function tracksShareIdentity(
  a: Pick<Track, 'id' | 'playlistItemId' | 'catalogTrackId' | 'provider' | 'streamId' | 'sourceId'> | null | undefined,
  b: Pick<Track, 'id' | 'playlistItemId' | 'catalogTrackId' | 'provider' | 'streamId' | 'sourceId'> | null | undefined,
): boolean {
  const aIdentity = getTrackIdentity(a)
  return aIdentity !== null && aIdentity === getTrackIdentity(b)
}

/**
 * Resolve once `trackId` is actually playing — or the request is superseded
 * (`shouldContinue` returns false) or a safety timeout elapses. Lets callers
 * hold background queue hydration until the clicked song has started so nothing
 * competes with getting it playing.
 */
export function waitForPlaybackStart(
  trackId: string,
  shouldContinue: () => boolean,
  timeoutMs = 12000,
): Promise<void> {
  return new Promise((resolve) => {
    const isReady = () => {
      const state = usePlayerStore.getState()
      // Require the clicked track to be the current one AND actually advancing.
      // setQueue resets position to 0 but leaves isPlaying alone, so isPlaying
      // alone is stale-true when switching from an already-playing track —
      // position > 0 proves the new track's audio has really started.
      return state.currentTrack?.id === trackId && state.isPlaying && state.position > 0
    }
    if (!shouldContinue() || isReady()) {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      unsubscribe()
      clearTimeout(timer)
      resolve()
    }
    const unsubscribe = usePlayerStore.subscribe(() => {
      if (!shouldContinue() || isReady()) finish()
    })
    const timer = setTimeout(finish, timeoutMs)
  })
}

function buildPlaybackUnits(tracks: Track[]): Track[][] {
  const units: Track[][] = []

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    if (!track) continue

    if (track.smartStackId == null) {
      units.push([track])
      continue
    }

    const stackTracks = [track]
    while (
      index + 1 < tracks.length &&
      tracks[index + 1]?.smartStackId === track.smartStackId
    ) {
      index += 1
      stackTracks.push(tracks[index]!)
    }
    units.push(stackTracks)
  }

  return units
}

function shuffleTrackUnits(tracks: Track[]): Track[] {
  return fisherYatesShuffle(buildPlaybackUnits(tracks)).flat()
}

/**
 * The nearest entry after (`step` 1) or before (-1) `from` that is not marked
 * unavailable, wrapping past the end when `wrap` is set; -1 when there is none.
 */
export function findPlayableIndex(tracks: Track[], from: number, step: 1 | -1, wrap: boolean): number {
  for (let offset = 1; offset <= tracks.length; offset += 1) {
    let index = from + step * offset
    if (index < 0 || index >= tracks.length) {
      if (!wrap) return -1
      index = ((index % tracks.length) + tracks.length) % tracks.length
    }
    // A full wrap lands back on `from`: repeat-all replays a lone playable track.
    if (!tracks[index]?.unavailableReason) return index
    if (index === from) return -1
  }
  return -1
}

function findTrackIndex(tracks: Track[], target: Track | null | undefined): number {
  if (!target) return -1
  return tracks.findIndex((track) => tracksShareIdentity(track, target))
}

function buildPinnedShuffleQueue(primaryTracks: Track[], currentTrack: Track): Track[] {
  const units = buildPlaybackUnits(primaryTracks)
  const currentUnitIndex = units.findIndex((unit) => unit.some((track) => tracksShareIdentity(track, currentTrack)))
  if (currentUnitIndex < 0) return shuffleTrackUnits(primaryTracks)

  const currentUnit = units[currentUnitIndex] ?? []
  const currentTrackIndex = currentUnit.findIndex((track) => tracksShareIdentity(track, currentTrack))
  if (currentTrackIndex < 0) return shuffleTrackUnits(primaryTracks)

  const currentTail = currentUnit.slice(currentTrackIndex)
  const currentHead = currentUnit.slice(0, currentTrackIndex)
  const remainingUnits = units.filter((_, index) => index !== currentUnitIndex)
  if (currentHead.length > 0) {
    remainingUnits.push(currentHead)
  }

  return [...currentTail, ...fisherYatesShuffle(remainingUnits).flat()]
}

function withPlaybackContext(
  tracks: Track[],
  playbackContext?: PlaybackContext | null,
): Track[] {
  if (playbackContext === undefined) return tracks
  return tracks.map((track) => ({
    ...track,
    playbackContext,
  }))
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  playbackRequestId: 0,
  formatInfo: null,
  outputMode: 'SHARED',
  deviceName: null,

  audioDevice: null,
  audioMode: 'closed',
  audioError: null,
  playbackDecision: null,
  deviceCapabilities: null,
  deviceFormat: null,
  bluetoothInfo: null,
  processingSpeed: null,
  resolvedDeviceName: null,
  notification: null,
  bufferProgress: null,
  playbackSource: null,

  isPlaying: false,
  position: 0,
  duration: 0,
  volume: 1,
  volumeControl: { configured: 'auto', effective: 'system', hardwareAvailable: false, hardware: null },

  queue: [],
  queuePrimaryLength: 0,
  radioArtistName: null,
  queueIndex: -1,
  shuffle: false,
  shuffledQueue: [],
  repeat: 'off',

  setTrack: (track) => set({
    currentTrack: track,
    playbackRequestId: ++playbackRequestSequence,
    position: 0,
    duration: Math.max(track.duration ?? 0, 0),
    formatInfo: track.formatInfo ?? null,
    bufferProgress: null,
    processingSpeed: null,
  }),

  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  togglePlayPause: () => set((s) => ({ isPlaying: !s.isPlaying })),

  seek: (position) => set({ position }),
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
  setVolumeControl: (volumeControl) => set({ volumeControl }),

  next: () => {
    const { queue, shuffledQueue, queueIndex, shuffle, repeat } = get()
    const activeQueue = shuffle ? shuffledQueue : queue
    if (activeQueue.length === 0) return

    const nextIndex = findPlayableIndex(activeQueue, queueIndex, 1, repeat === 'all')
    if (nextIndex < 0) return

    set({
      queueIndex: nextIndex,
      currentTrack: activeQueue[nextIndex],
      playbackRequestId: ++playbackRequestSequence,
      position: 0,
      duration: Math.max(activeQueue[nextIndex]?.duration ?? 0, 0),
      formatInfo: activeQueue[nextIndex].formatInfo ?? null,
      bufferProgress: null,
      processingSpeed: null,
    })
  },

  previous: () => {
    const { queue, shuffledQueue, queueIndex, shuffle, position } = get()
    const activeQueue = shuffle ? shuffledQueue : queue

    // If more than 3 seconds in, restart current track
    if (position > 3) {
      set({ position: 0 })
      return
    }

    // With nothing playable before it, restart the current entry as before.
    const earlier = findPlayableIndex(activeQueue, queueIndex, -1, false)
    const prevIndex = earlier >= 0 ? earlier : Math.max(0, queueIndex)
    set({
      queueIndex: prevIndex,
      currentTrack: activeQueue[prevIndex],
      playbackRequestId: ++playbackRequestSequence,
      position: 0,
      duration: Math.max(activeQueue[prevIndex]?.duration ?? 0, 0),
      formatInfo: activeQueue[prevIndex]?.formatInfo ?? null,
      bufferProgress: null,
      processingSpeed: null,
    })
  },

  setQueue: (tracks, startIndex = 0, playbackContext) => {
    const shuffleEnabled = get().shuffle
    // Unavailable tracks never enter a queue; start from the requested track,
    // or the first playable one after it.
    const requested = tracks.findIndex((track, index) => index >= startIndex && !track.unavailableReason)
    const playable = tracks.filter((track) => !track.unavailableReason)
    startIndex = requested < 0 ? 0 : tracks.slice(0, requested).filter((track) => !track.unavailableReason).length
    const queueTracks = withPlaybackContext(playable, playbackContext)
    const requestedStartTrack = queueTracks[startIndex] ?? queueTracks[0] ?? null
    const shuffled = requestedStartTrack
      ? buildPinnedShuffleQueue(queueTracks, requestedStartTrack)
      : shuffleTrackUnits(queueTracks)
    const activeQueue = shuffleEnabled ? shuffled : queueTracks
    const activeIndex = shuffleEnabled ? 0 : startIndex
    console.info('[PlaylistDebug] setQueue', {
      startIndex,
      shuffleEnabled,
      activeIndex,
      currentTitle: activeQueue[activeIndex]?.title ?? null,
    })
    set({
      queue: queueTracks,
      queuePrimaryLength: queueTracks.length,
      radioArtistName: null,
      shuffledQueue: shuffled,
      queueIndex: activeIndex,
      currentTrack: activeQueue[activeIndex] ?? null,
      playbackRequestId: ++playbackRequestSequence,
      position: 0,
      duration: Math.max(activeQueue[activeIndex]?.duration ?? 0, 0),
      formatInfo: activeQueue[activeIndex]?.formatInfo ?? null,
      bufferProgress: null,
      processingSpeed: null,
    })
  },

  jumpToQueueIndex: (index) => set((s) => {
    const activeQueue = s.shuffle ? s.shuffledQueue : s.queue
    const nextTrack = activeQueue[index]
    if (!nextTrack) return {}
    return {
      queueIndex: index,
      currentTrack: nextTrack,
      playbackRequestId: ++playbackRequestSequence,
      position: 0,
      duration: Math.max(nextTrack.duration ?? 0, 0),
      formatInfo: nextTrack.formatInfo ?? null,
      bufferProgress: null,
      processingSpeed: null,
    }
  }),

  appendRadioQueue: (tracks, artistName, artistId = null) => set((s) => {
    tracks = tracks.filter((track) => !track.unavailableReason)
    if (tracks.length === 0 || s.queue.length !== s.queuePrimaryLength) return {}
    const radioContext: PlaybackContext = {
      kind: 'artist-radio',
      label: `${artistName} Radio`,
      catalogArtistId: artistId,
    }
    const radioTracks = withPlaybackContext(tracks, radioContext)
    return {
      queue: [...s.queue, ...radioTracks],
      shuffledQueue: [...s.shuffledQueue, ...radioTracks],
      radioArtistName: artistName,
    }
  }),

  addToQueue: (track) => set((s) => {
    if (track.unavailableReason) return {}
    const queueInsertIndex = Math.max(0, Math.min(s.queuePrimaryLength, s.queue.length))
    const shuffledInsertIndex = Math.max(0, Math.min(s.shuffledQueue.length - (s.queue.length - s.queuePrimaryLength), s.shuffledQueue.length))
    const nextQueue = [...s.queue]
    nextQueue.splice(queueInsertIndex, 0, track)
    const nextShuffledQueue = [...s.shuffledQueue]
    nextShuffledQueue.splice(shuffledInsertIndex, 0, track)
    return {
      queue: nextQueue,
      queuePrimaryLength: s.queuePrimaryLength + 1,
      shuffledQueue: nextShuffledQueue,
    }
  }),

  reorderQueue: (fromIndex, toIndex) => set((s) => {
    if (s.shuffle) return {}
    if (fromIndex === toIndex) return {}
    if (fromIndex < 0 || toIndex < 0) return {}
    if (fromIndex >= s.queue.length || toIndex >= s.queue.length) return {}
    if (fromIndex <= s.queueIndex || toIndex <= s.queueIndex) return {}

    const fromIsPrimary = fromIndex < s.queuePrimaryLength
    const toIsPrimary = toIndex < s.queuePrimaryLength
    if (fromIsPrimary !== toIsPrimary) return {}

    const nextQueue = [...s.queue]
    const [moved] = nextQueue.splice(fromIndex, 1)
    if (!moved) return {}
    nextQueue.splice(toIndex, 0, moved)

    return {
      queue: nextQueue,
    }
  }),

  removeFromQueue: (index) => set((s) => {
    const activeQueue = s.shuffle ? s.shuffledQueue : s.queue
    const trackToRemove = activeQueue[index]
    if (!trackToRemove) return {}

    const queueRemoveIndex = findTrackIndex(s.queue, trackToRemove)
    const shuffledRemoveIndex = findTrackIndex(s.shuffledQueue, trackToRemove)
    if (queueRemoveIndex < 0 || shuffledRemoveIndex < 0) return {}

    const queue = s.queue.filter((_, i) => i !== queueRemoveIndex)
    const shuffledQueue = s.shuffledQueue.filter((_, i) => i !== shuffledRemoveIndex)
    const queuePrimaryLength = queueRemoveIndex < s.queuePrimaryLength
      ? Math.max(0, s.queuePrimaryLength - 1)
      : s.queuePrimaryLength
    const radioArtistName = queue.length > queuePrimaryLength ? s.radioArtistName : null
    return {
      queue,
      queuePrimaryLength,
      radioArtistName,
      shuffledQueue,
      queueIndex: index < s.queueIndex ? s.queueIndex - 1 : s.queueIndex,
    }
  }),

  clearQueue: () => set({
    queue: [],
    queuePrimaryLength: 0,
    radioArtistName: null,
    shuffledQueue: [],
    queueIndex: -1,
    currentTrack: null,
    isPlaying: false,
    position: 0,
    bufferProgress: null,
    processingSpeed: null,
  }),

  restoreSession: (session) => set({
    queue: session.queue,
    queuePrimaryLength: session.queuePrimaryLength,
    radioArtistName: session.radioArtistName,
    shuffledQueue: session.shuffledQueue,
    queueIndex: session.queueIndex,
    shuffle: session.shuffle,
    repeat: session.repeat,
    currentTrack: session.currentTrack,
    playbackRequestId: ++playbackRequestSequence,
    isPlaying: false,
    position: session.position,
    duration: Math.max(session.currentTrack.duration ?? 0, 0),
    formatInfo: session.currentTrack.formatInfo ?? null,
    bufferProgress: null,
    processingSpeed: null,
  }),

  toggleShuffle: () => set((s) => {
    const newShuffle = !s.shuffle

    if (newShuffle) {
      const currentTrack = s.currentTrack
      const primaryTracks = s.queue.slice(0, s.queuePrimaryLength)
      const radioTracks = s.queue.slice(s.queuePrimaryLength)
      if (!currentTrack || s.queue.length === 0) {
        return {
          shuffle: true,
          shuffledQueue: [
            ...shuffleTrackUnits(primaryTracks),
            ...radioTracks,
          ],
        }
      }

      const isPrimaryTrack = primaryTracks.some((track) => tracksShareIdentity(track, currentTrack))
      const remainingRadioTracks = radioTracks.filter((track) => !tracksShareIdentity(track, currentTrack))
      return {
        shuffle: true,
        queueIndex: 0,
        shuffledQueue: isPrimaryTrack
          ? [...buildPinnedShuffleQueue(primaryTracks, currentTrack), ...remainingRadioTracks]
          : [currentTrack, ...shuffleTrackUnits(primaryTracks), ...remainingRadioTracks],
      }
    }

    const currentTrack = s.currentTrack
    const restoredIndex = currentTrack
      ? findTrackIndex(s.queue, currentTrack)
      : s.queueIndex

    return {
      shuffle: false,
      queueIndex: restoredIndex >= 0 ? restoredIndex : s.queueIndex,
      shuffledQueue: s.shuffledQueue,
    }
  }),

  cycleRepeat: () => set((s) => ({
    repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off',
  })),

  setFormatInfo: (info) => set({ formatInfo: info }),
  setOutputMode: (mode) => set({ outputMode: mode }),
  setDeviceName: (name) => set({ deviceName: name }),
  setPosition: (pos) => set({ position: pos }),
  setDuration: (dur) => set({ duration: dur }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setAudioDevice: (deviceUid) => set({ audioDevice: deviceUid }),
  setAudioMode: (mode) => set({ audioMode: mode, audioError: null }),
  setAudioError: (error) => set({ audioError: error }),
  setDeviceFormat: (fmt) => set({ deviceFormat: fmt }),
  setPlaybackDecision: (decision) => set({ playbackDecision: decision }),
  setDeviceCapabilities: (caps) => set({ deviceCapabilities: caps }),
  setCurrentTrackArtwork: (url) => set((s) =>
    s.currentTrack ? { currentTrack: { ...s.currentTrack, coverUrl: url } } : {}
  ),
  hydrateQueueTrack: (target, data) => set((s) => {
    // Merge resolved data into the exact lazy queue entry being prepared.
    // Apple/catalog source IDs are not a unique queue-entry key, so matching by
    // id can accidentally update the currently playing item during prefetch.
    const apply = (track: Track): Track => (track === target ? { ...track, ...data, id: target.id } : track)
    return {
      queue: s.queue.map(apply),
      shuffledQueue: s.shuffledQueue.map(apply),
      currentTrack: s.currentTrack === target ? apply(s.currentTrack) : s.currentTrack,
    }
  }),
  markTrackUnavailable: (target, reason) => set((s) => {
    const sameSource = (track: Track) => track === target || (
      !!target.sourceId && track.sourceId === target.sourceId && (track.provider ?? track.sourceType) === (target.provider ?? target.sourceType)
    )
    const apply = (track: Track): Track => (sameSource(track) ? { ...track, unavailableReason: reason } : track)
    return {
      queue: s.queue.map(apply),
      shuffledQueue: s.shuffledQueue.map(apply),
      currentTrack: s.currentTrack && sameSource(s.currentTrack) ? apply(s.currentTrack) : s.currentTrack,
    }
  }),
  setBluetoothInfo: (info) => set({ bluetoothInfo: info }),
  setProcessingSpeed: (speed) => set({ processingSpeed: speed }),
  setResolvedDeviceName: (name) => set({ resolvedDeviceName: name }),
  setNotification: (msg) => {
    if (notificationTimer) clearTimeout(notificationTimer)
    set({ notification: msg })
    if (msg !== null) {
      notificationTimer = setTimeout(() => {
        set({ notification: null })
        notificationTimer = null
      }, 3000)
    }
  },
  setBufferProgress: (progress) => set({ bufferProgress: progress }),
  setPlaybackSource: (source) => set({ playbackSource: source }),
  markPlaybackSourceComplete: (trackIdentity, path) => {
    const source = get().playbackSource
    if (source?.growing && source.trackIdentity === trackIdentity) {
      set({ playbackSource: { ...source, path, growing: false } })
    }
  },
}))
