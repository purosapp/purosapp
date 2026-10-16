import type { BrowserWindow } from 'electron'
import type { CatalogProviderName } from '../../src/services/catalog/types'

export type ProviderWarningPayload = {
  provider: CatalogProviderName | 'wikipedia'
  code: 'rate_limited' | 'auth_expired' | 'provider_unavailable' | 'partial_results' | 'sync_failed' | 'playback_failed'
  message: string
  scope?: string | null
  retryable?: boolean
}

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null) {
  mainWindow = win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function emitProviderWarning(payload: ProviderWarningPayload) {
  mainWindow?.webContents.send('provider:warning', payload)
}

export function sendToRenderer(channel: string, ...args: unknown[]) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, ...args)
}

export function emitLibraryCatalogChanged(): void {
  sendToRenderer('playlists:changed')
  sendToRenderer('library:changed')
  sendToRenderer('catalog:changed')
}
