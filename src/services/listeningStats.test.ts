import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayerStore, type Track } from '../store/playerStore'
import { dayKey, loadListeningStats, startListeningStatsTracking } from './listeningStats'

const settings = new Map<string, string>()
const track = (id: string, duration = 200): Track => ({ id, title: id, artist: 'A', album: 'B', duration, filePath: `/m/${id}.flac` })
const initialPlayerState = usePlayerStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  settings.clear()
  usePlayerStore.setState(initialPlayerState, true)
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setInterval,
    clearInterval,
    puros: {
      settings: {
        get: async (key: string) => settings.get(key) ?? null,
        set: async (key: string, value: string) => { settings.set(key, value) },
      },
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function playTicks(from: number, to: number, step = 0.25) {
  for (let position = from + step; position <= to + 1e-9; position += step) {
    usePlayerStore.getState().setPosition(position)
  }
}

describe('listening stats', () => {
  it('counts played time, ignores seeks and counts a play after 30 s', async () => {
    const stop = startListeningStatsTracking()
    usePlayerStore.getState().setQueue([track('a')], 0)
    usePlayerStore.setState({ isPlaying: true })
    playTicks(0, 20)
    usePlayerStore.getState().setPosition(120) // seek forward
    playTicks(120, 135)
    stop()
    await vi.runAllTimersAsync()

    const today = (await loadListeningStats())[dayKey(new Date())]
    expect(today.seconds).toBeCloseTo(35, 5)
    expect(today.plays).toBe(1)
  })

  it('does not count time while paused and keeps adding to saved days', async () => {
    settings.set('stats:listeningDaily', JSON.stringify({ [dayKey(new Date())]: { seconds: 100, plays: 2 } }))
    const stop = startListeningStatsTracking()
    usePlayerStore.getState().setQueue([track('a', 40)], 0)
    usePlayerStore.getState().setPosition(10) // paused: ignored
    usePlayerStore.setState({ isPlaying: true })
    playTicks(10, 30)
    stop()
    await vi.runAllTimersAsync()

    const today = (await loadListeningStats())[dayKey(new Date())]
    expect(today.seconds).toBeCloseTo(120, 5)
    expect(today.plays).toBe(3) // 20 s is half of a 40 s track
  })
})
