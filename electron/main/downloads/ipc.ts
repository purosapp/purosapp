import { ipcMain } from 'electron'
import {
  enablePlaylistDownload,
  getDownloadsOverview,
  getPlaylistDownloadState,
  markTrackDownloaded,
  pruneOrphanedDownloads,
  removeAllDownloads,
  removePlaylistDownload,
} from './'

function playlistIdArg(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError('Invalid playlist ID')
  return value as number
}

export function registerDownloadsIpc(): void {
  ipcMain.handle('downloads:get-overview', () => getDownloadsOverview())
  ipcMain.handle('downloads:get-playlist-state', (_event, playlistId: unknown) =>
    getPlaylistDownloadState(playlistIdArg(playlistId)))
  ipcMain.handle('downloads:enable-playlist', (_event, playlistId: unknown) =>
    enablePlaylistDownload(playlistIdArg(playlistId)))
  ipcMain.handle('downloads:remove-playlist', (_event, playlistId: unknown) =>
    removePlaylistDownload(playlistIdArg(playlistId)))
  ipcMain.handle('downloads:mark-track', (_event, provider: unknown, sourceId: unknown, artifactPath: unknown) =>
    markTrackDownloaded(provider as string, sourceId as string, artifactPath as string))
  ipcMain.handle('downloads:prune-orphans', () => pruneOrphanedDownloads())
  ipcMain.handle('downloads:remove-all', () => removeAllDownloads())
}
