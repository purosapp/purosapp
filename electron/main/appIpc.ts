import {
  ipcMain,
  type BrowserWindow,
} from 'electron'
import {
  copyAppTextToClipboard,
  getAppUserDataPath,
  isAppFullScreen,
  openAppAirplayPicker,
  openAppExternal,
  toggleAppFullScreen,
} from './appWorkflows'
import { convertVisualizerShaders } from './visualizerConverter'

type AppIpcDeps = {
  getMainWindow: () => BrowserWindow | null
  openVisualizerWindow: () => void
  clearAppCaches: () => void
  resetAppData: () => Promise<void>
  getStreamingAudioCacheStats: () => unknown
  openSystemSoundOutputPicker: () => Promise<unknown>
}

export function registerAppIpc(deps: AppIpcDeps): void {
  ipcMain.handle('app:convert-visualizer-shaders', (_event, shaders: unknown) => convertVisualizerShaders(shaders))
  ipcMain.handle('app:get-user-data-path', () => getAppUserDataPath())
  ipcMain.handle('app:is-full-screen', () => isAppFullScreen(deps.getMainWindow))
  ipcMain.handle('app:toggle-full-screen', () => toggleAppFullScreen(deps.getMainWindow))
  ipcMain.handle('app:open-external', (_event, url: string) => openAppExternal(url))
  ipcMain.handle('app:copy-to-clipboard', (_event, text: string) =>
    copyAppTextToClipboard(text))
  ipcMain.handle('app:open-airplay-picker', async () =>
    openAppAirplayPicker(deps.openSystemSoundOutputPicker))
  ipcMain.handle('app:clear-caches', async () => deps.clearAppCaches())
  ipcMain.handle('app:get-streaming-audio-cache-stats', async () =>
    deps.getStreamingAudioCacheStats())
  ipcMain.handle('app:reset-app-data', async () => deps.resetAppData())
  ipcMain.handle('app:open-visualizer-window', () => deps.openVisualizerWindow())
}
