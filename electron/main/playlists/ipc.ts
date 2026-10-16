import {
  dialog,
  ipcMain,
  type BrowserWindow,
} from 'electron'
import { type CatalogProviderName } from '../../../src/services/catalog'
import {
  addCatalogTrackToPlaylist,
  addPlaylistTrack,
  choosePlaylistArtwork,
  clearPlaylistArtwork,
  createPlaylist,
  createPlaylistFolder,
  createPlaylistSmartStack,
  deletePlaylist,
  deletePlaylistFolder,
  dissolvePlaylistSmartStack,
  duplicatePlaylist,
  getAllPlaylists,
  getPlaylistArtwork,
  getPlaylistFolders,
  getPlaylistTracks,
  movePlaylistToFolder,
  removeFromPlaylistSmartStack,
  removePlaylistTrack,
  renamePlaylist,
  renamePlaylistFolder,
  reorderPlaylistTracks,
  resolvePlaylistPlayback,
} from './workflows'

type PlaylistsIpcDeps = {
  readonly win: BrowserWindow | null
}

export function registerPlaylistsIpc(deps: PlaylistsIpcDeps): void {
  const onPlaylistsChanged = () => deps.win?.webContents.send('playlists:changed')
  const onLibraryChanged = () => deps.win?.webContents.send('library:changed')

  ipcMain.handle('playlists:getAll', () => getAllPlaylists())
  ipcMain.handle('playlists:getFolders', () => getPlaylistFolders())
  ipcMain.handle('playlists:create', (_event, name: string, folderId?: number | null, providerId?: string) =>
    createPlaylist(name, folderId, onPlaylistsChanged, providerId))
  ipcMain.handle('playlists:createFolder', (_event, name: string, parentId?: number | null) =>
    createPlaylistFolder(name, parentId, onPlaylistsChanged))
  ipcMain.handle('playlists:renameFolder', (_event, id: number, newName: string) =>
    renamePlaylistFolder(id, newName, onPlaylistsChanged))
  ipcMain.handle('playlists:deleteFolder', (_event, id: number) =>
    deletePlaylistFolder(id, onPlaylistsChanged))
  ipcMain.handle('playlists:moveToFolder', (_event, playlistId: number, folderId?: number | null) =>
    movePlaylistToFolder(playlistId, folderId, onPlaylistsChanged))
  ipcMain.handle('playlists:rename', (_event, id: number, newName: string) =>
    renamePlaylist(id, newName, onPlaylistsChanged))
  ipcMain.handle('playlists:delete', (_event, id: number) =>
    deletePlaylist(id, onPlaylistsChanged))
  ipcMain.handle('playlists:duplicate', (_event, id: number) =>
    duplicatePlaylist(id, onPlaylistsChanged))

  ipcMain.handle('playlists:setArtwork', async (_event, playlistId: number) => {
    if (!deps.win) return { changed: false, artworkId: null as string | null }
    return choosePlaylistArtwork(
      playlistId,
      async () => {
        const result = await dialog.showOpenDialog(deps.win!, {
          properties: ['openFile'],
          title: 'Choose Playlist Cover',
          filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
          ],
        })
        return result.canceled || result.filePaths.length === 0
          ? null
          : result.filePaths[0]!
      },
      onPlaylistsChanged,
    )
  })

  ipcMain.handle('playlists:clearArtwork', (_event, playlistId: number) =>
    clearPlaylistArtwork(playlistId, onPlaylistsChanged))
  ipcMain.handle('playlists:addTrack', (_event, playlistId: number, trackId: string | number) =>
    addPlaylistTrack(playlistId, trackId, onPlaylistsChanged))
  ipcMain.handle(
    'playlists:addCatalogTrack',
    async (
      _event,
      playlistId: number,
      catalogTrackId: string,
      preferredProvider?: CatalogProviderName | null,
      preferredSourceId?: string | null,
    ) => addCatalogTrackToPlaylist(
      playlistId,
      catalogTrackId,
      preferredProvider,
      preferredSourceId,
      onLibraryChanged,
      onPlaylistsChanged,
    ),
  )
  ipcMain.handle('playlists:removeTrack', (
    _event,
    playlistId: number,
    trackIdOrPlaylistItemId: string | number,
  ) => removePlaylistTrack(playlistId, trackIdOrPlaylistItemId, onPlaylistsChanged))
  ipcMain.handle('playlists:reorderTracks', (
    _event,
    playlistId: number,
    fromIndex: number,
    toIndex: number,
  ) => reorderPlaylistTracks(playlistId, fromIndex, toIndex, onPlaylistsChanged))
  ipcMain.handle('playlists:getTracks', async (_event, playlistId: number) =>
    getPlaylistTracks(playlistId))
  ipcMain.handle('playlists:createSmartStack', (
    _event,
    playlistId: number,
    playlistItemIds: number[],
  ) => createPlaylistSmartStack(playlistId, playlistItemIds, onPlaylistsChanged))
  ipcMain.handle('playlists:removeFromSmartStack', (
    _event,
    playlistId: number,
    playlistItemId: number,
  ) => removeFromPlaylistSmartStack(playlistId, playlistItemId, onPlaylistsChanged))
  ipcMain.handle('playlists:dissolveSmartStack', (
    _event,
    playlistId: number,
    stackId: number,
  ) => dissolvePlaylistSmartStack(playlistId, stackId, onPlaylistsChanged))
  ipcMain.handle('playlists:resolvePlayback', async (_event, playlistId: number, options?: {
    shuffle?: boolean
    startPlaylistItemId?: number
    startTrackId?: string
    playlistItemIds?: number[]
  }) => resolvePlaylistPlayback(playlistId, options))
  ipcMain.handle('playlists:getArtwork', async (_event, playlistId: number) =>
    getPlaylistArtwork(playlistId))
}
