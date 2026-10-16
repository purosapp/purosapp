import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayerStore, type Track } from '../store/playerStore'
import { useSettingsStore } from '../store/settingsStore'

const restoreSession = vi.fn()
vi.mock('./AudioService', () => ({
  audioService: {
    restoreSession: (...args: Parameters<typeof restoreSession>) => {
      restoreSession(...args)
      usePlayerStore.getState().restoreSession(args[0])
    },
  },
}))

const { restorePlaybackSession, startPlaybackSessionPersistence } = await import('./playbackSession')

const settings = new Map<string, string>()
const track = (id: string, duration = 200): Track => ({ id, title: id, artist: 'A', album: 'B', duration, filePath: `/m/${id}.flac` })
const initialPlayerState = usePlayerStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  settings.clear()
  restoreSession.mockClear()
  usePlayerStore.setState(initialPlayerState, true)
  useSettingsStore.setState({ loaded: true, rememberPlaybackSession: true, resumePlaybackOnLaunch: false, resumeRewindSeconds: 0 })
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    puros: {
      settings: {
        get: async (key: string) => settings.get(key) ?? null,
        set: async (key: string, value: string) => { settings.set(key, value) },
        delete: async (key: string) => { settings.delete(key) },
      },
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function playAndQuit(position: number) {
  const stop = startPlaybackSessionPersistence()
  usePlayerStore.getState().setQueue([track('a'), track('b'), track('c')], 1)
  usePlayerStore.setState({ isPlaying: true, repeat: 'all' })
  usePlayerStore.getState().setPosition(position)
  stop()
  await vi.runAllTimersAsync()
  usePlayerStore.setState(initialPlayerState, true)
}

describe('playback session', () => {
  it('restores the queue, track and position paused, minus the rewind', async () => {
    useSettingsStore.setState({ resumeRewindSeconds: 5 })
    await playAndQuit(42)

    await restorePlaybackSession()

    const state = usePlayerStore.getState()
    expect(state.queue.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(state.currentTrack?.id).toBe('b')
    expect(state.queueIndex).toBe(1)
    expect(state.position).toBe(37)
    expect(state.repeat).toBe('all')
    expect(state.isPlaying).toBe(false)
    expect(restoreSession.mock.calls[0][1]).toEqual({ autoplay: false })
  })

  it('keeps the shuffled order', async () => {
    const stop = startPlaybackSessionPersistence()
    usePlayerStore.setState({ shuffle: true })
    usePlayerStore.getState().setQueue([track('a'), track('b'), track('c'), track('d')], 2)
    const shuffledIds = usePlayerStore.getState().shuffledQueue.map((t) => t.id)
    stop()
    await vi.runAllTimersAsync()
    usePlayerStore.setState(initialPlayerState, true)

    await restorePlaybackSession()

    const state = usePlayerStore.getState()
    expect(state.shuffle).toBe(true)
    expect(state.shuffledQueue.map((t) => t.id)).toEqual(shuffledIds)
    expect(state.currentTrack?.id).toBe('c')
  })

  it('starts a track saved near its end from the beginning', async () => {
    await playAndQuit(198)
    await restorePlaybackSession()
    expect(usePlayerStore.getState().position).toBe(0)
  })

  it('forgets the session when the setting is turned off', async () => {
    await playAndQuit(42)
    const stop = startPlaybackSessionPersistence()
    useSettingsStore.setState({ rememberPlaybackSession: false })
    await vi.runAllTimersAsync()
    stop()

    expect(settings.has('playbackSession')).toBe(false)
    expect(settings.has('playbackSessionPosition')).toBe(false)
    await restorePlaybackSession()
    expect(usePlayerStore.getState().currentTrack).toBeNull()
  })
})
