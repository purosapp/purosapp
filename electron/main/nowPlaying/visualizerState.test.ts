import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearVisualizerTrack, getVisualizerPlaybackState, setVisualizerPlaying, setVisualizerTrack } from './visualizerState'

const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), send: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } }))
vi.mock('../rendererBridge', () => ({ getMainWindow: () => ({ webContents: { send } }) }))
vi.mock('./', () => ({ clearNowPlaying: vi.fn(), setNowPlaying: vi.fn(), updateNowPlayingPlaybackState: vi.fn() }))
import { registerNowPlayingIpc } from './ipc'

beforeEach(() => { clearVisualizerTrack(); send.mockClear(); registerNowPlayingIpc() })

describe('detached visualizer playback bridge', () => {
  it('provides the latest track and play/pause state even when the window opens later', () => {
    setVisualizerTrack({ title: 'Track', artist: 'Artist', album: 'Album', catalogTrackId: '42' })
    setVisualizerPlaying(true)
    expect(handlers.get('player:get-visualizer-state')!()).toEqual({
      track: { id: '42', title: 'Track', artist: 'Artist' }, isPlaying: true,
    })
    setVisualizerPlaying(false)
    expect(getVisualizerPlaybackState().isPlaying).toBe(false)
    clearVisualizerTrack()
    expect(getVisualizerPlaybackState()).toEqual({ track: null, isPlaying: false })
  })

  it('forwards transport controls to the main player and rejects unknown commands', () => {
    const command = handlers.get('player:visualizer-command')!
    for (const value of ['play-pause', 'next', 'previous']) {
      command({}, value)
      expect(send).toHaveBeenLastCalledWith('player:media-command', value)
    }
    expect(() => command({}, 'quit')).toThrow('Invalid playback command')
    expect(send).toHaveBeenCalledTimes(3)
  })
})
