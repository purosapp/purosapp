import { ipcMain } from 'electron'
import {
  type LyricsProviderFetchRequest,
  type LyricsProviderId,
} from '../../../src/renderer/components/NowPlaying/LyricsProviderService'
import {
  resolveLyrics,
  testLyricsProvider,
} from './providers'

export function registerLyricsIpc(): void {
  ipcMain.handle('lyrics:resolve', async (_event, payload: LyricsProviderFetchRequest) =>
    resolveLyrics(payload))
  ipcMain.handle('lyrics:test-provider', async (_event, provider: LyricsProviderId, apiKey?: string) =>
    testLyricsProvider(provider, apiKey))
}
