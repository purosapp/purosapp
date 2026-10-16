import { ipcMain } from 'electron'
import { getMainWindow } from '../rendererBridge'
import { getVisualizerPlaybackState } from './visualizerState'
import {
  clearNowPlaying,
  setNowPlaying,
  updateNowPlayingPlaybackState,
  type NowPlayingPayload,
  type PlaybackStatePayload,
} from './'

export function registerNowPlayingIpc(): void {
  ipcMain.handle('player:get-visualizer-state', () => getVisualizerPlaybackState())
  ipcMain.handle('player:visualizer-command', (_event, command: unknown) => {
    if (command !== 'play-pause' && command !== 'next' && command !== 'previous') throw new Error('Invalid playback command')
    getMainWindow()?.webContents.send('player:media-command', command)
  })
  ipcMain.handle('player:set-now-playing', async (_event, payload: NowPlayingPayload) =>
    setNowPlaying(payload))

  ipcMain.handle('player:update-playback-state', (_event, payload: PlaybackStatePayload) => {
    updateNowPlayingPlaybackState(payload)
  })

  ipcMain.handle('player:clear-now-playing', () => {
    clearNowPlaying()
  })
}
