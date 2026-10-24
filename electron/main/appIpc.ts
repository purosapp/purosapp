import {
  BrowserWindow,
  ipcMain,
  systemPreferences,
} from 'electron'
import {
  copyAppTextToClipboard,
  getAppUserDataPath,
  isAppFullScreen,
  openAppAirplayPicker,
  openAppExternal,
  toggleAppFullScreen,
} from './appWorkflows'
import { showNativeContextMenu } from './contextMenu'
import { setDockMenu } from './dockMenu'
import { convertVisualizerShaders } from './visualizerConverter'
import { getWindowActivity } from './windowActivity'

type AppIpcDeps = {
  getMainWindow: () => BrowserWindow | null
  openVisualizerWindow: () => void
  closeVisualizerWindow: () => void
  clearAppCaches: () => void
  resetAppData: () => Promise<void>
  getStreamingAudioCacheStats: () => unknown
  openSystemSoundOutputPicker: () => Promise<unknown>
}

/** The OS accent colour as #rrggbb, or null where it cannot be read. */
function getSystemAccentColor(): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null
  try {
    const value = systemPreferences.getAccentColor()
    return /^[0-9a-f]{6}/i.test(value) ? `#${value.slice(0, 6).toLowerCase()}` : null
  } catch {
    return null
  }
}

/** Tells every window when the user changes the accent colour in System Settings. */
function watchSystemAccentColor(): void {
  const broadcast = () => {
    const color = getSystemAccentColor()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('app:accent-color-changed', color)
    }
  }
  if (process.platform === 'darwin') {
    systemPreferences.subscribeNotification('AppleColorPreferencesChangedNotification', broadcast)
  } else if (process.platform === 'win32') {
    systemPreferences.on('accent-color-changed', broadcast)
  }
}

export function registerAppIpc(deps: AppIpcDeps): void {
  ipcMain.handle('app:get-system-accent-color', () => getSystemAccentColor())
  watchSystemAccentColor()
  ipcMain.handle('app:convert-visualizer-shaders', (_event, shaders: unknown) => convertVisualizerShaders(shaders))
  ipcMain.handle('app:get-user-data-path', () => getAppUserDataPath())
  ipcMain.handle('app:set-dock-menu', (_event, state: unknown) => setDockMenu(state))
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
  ipcMain.handle('app:close-visualizer-window', () => deps.closeVisualizerWindow())
  ipcMain.handle('app:get-window-activity', (event) =>
    getWindowActivity(BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('app:show-context-menu', (event, items: unknown) =>
    showNativeContextMenu(event.sender, items))
}
