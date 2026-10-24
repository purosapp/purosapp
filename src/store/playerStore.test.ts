import { beforeEach, describe, expect, it } from 'vitest'
import { findPlayableIndex, usePlayerStore, type Track } from './playerStore'

const track = (id: string, unavailableReason: string | null = null): Track => ({
  id, title: id, artist: 'Artist', album: 'Album', duration: 1,
  provider: 'service-a', sourceType: 'service-a', sourceId: id, unavailableReason,
})

describe('unavailable tracks in the queue', () => {
  beforeEach(() => {
    usePlayerStore.setState({ queue: [], shuffledQueue: [], queueIndex: -1, currentTrack: null, shuffle: false, repeat: 'off', position: 0 })
  })

  it('finds the nearest playable entry in either direction', () => {
    const tracks = [track('a'), track('b', 'region'), track('c'), track('d', 'removed')]
    expect(findPlayableIndex(tracks, 0, 1, false)).toBe(2)
    expect(findPlayableIndex(tracks, 2, 1, false)).toBe(-1)
    expect(findPlayableIndex(tracks, 2, 1, true)).toBe(0)
    expect(findPlayableIndex(tracks, 2, -1, false)).toBe(0)
    expect(findPlayableIndex([track('only')], 0, 1, true)).toBe(0)
    expect(findPlayableIndex([track('only', 'region')], 0, 1, true)).toBe(-1)
  })

  it('leaves unavailable tracks out of a new queue and starts at the next playable one', () => {
    usePlayerStore.getState().setQueue([track('a'), track('b', 'region'), track('c'), track('d')], 1)
    const state = usePlayerStore.getState()
    expect(state.queue.map(({ id }) => id)).toEqual(['a', 'c', 'd'])
    expect(state.currentTrack?.id).toBe('c')
  })

  it('skips entries playback marked unavailable', () => {
    const store = usePlayerStore.getState()
    store.setQueue([track('a'), track('b'), track('c')], 0)
    store.markTrackUnavailable(usePlayerStore.getState().queue[1]!, 'subscription')
    expect(usePlayerStore.getState().queue[1]?.unavailableReason).toBe('subscription')

    usePlayerStore.getState().next()
    expect(usePlayerStore.getState().currentTrack?.id).toBe('c')
    usePlayerStore.getState().previous()
    expect(usePlayerStore.getState().currentTrack?.id).toBe('a')
  })

  it('does not add unavailable tracks to the queue', () => {
    usePlayerStore.getState().setQueue([track('a')], 0)
    usePlayerStore.getState().addToQueue(track('b', 'region'))
    expect(usePlayerStore.getState().queue.map(({ id }) => id)).toEqual(['a'])
  })
})
