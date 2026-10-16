import {
  dialog,
  ipcMain,
  type BrowserWindow,
} from 'electron'
import {
  clearLibrary,
  getLibraryAlbums,
  getLibraryAlbumTracks,
  getLibraryArtistProfile,
  getLibraryArtists,
  getLibraryArtistsByGenre,
  getLibraryArtistTracks,
  getLibraryFolders,
  getLibraryGenres,
  getLibraryTracks,
  removeLibraryFolder,
  removeLibraryTrack,
  rescanLibrary,
  scanLibraryFolder,
  searchLibrary,
} from './workflows'

type LibraryIpcDeps = {
  readonly win: BrowserWindow | null
}

export function registerLibraryIpc(deps: LibraryIpcDeps): void {
  const onCatalogChanged = () => deps.win?.webContents.send('catalog:changed')
  const onLibraryChanged = () => deps.win?.webContents.send('library:changed')
  const onPlaylistsChanged = () => deps.win?.webContents.send('playlists:changed')

  async function doScanFolder(): Promise<string | null> {
    const result = await dialog.showOpenDialog(deps.win!, {
      properties: ['openDirectory'],
      title: 'Select Music Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return scanLibraryFolder(
      result.filePaths[0],
      (progress) => deps.win?.webContents.send('library:scan-progress', progress),
      { onCatalogChanged, onLibraryChanged },
    )
  }

  ipcMain.handle('library:scan-folder', doScanFolder)
  ipcMain.handle('library:add-folder', doScanFolder)
  ipcMain.handle('library:get-folders', () => getLibraryFolders())
  ipcMain.handle('library:rescan', async () => rescanLibrary())
  ipcMain.handle('library:remove-folder', async (_event, folderId: string) =>
    removeLibraryFolder(folderId, { onCatalogChanged, onLibraryChanged, onPlaylistsChanged }))
  ipcMain.handle('library:get-tracks', (_event, options?: { search?: string; limit?: number; offset?: number }) =>
    getLibraryTracks(options))
  ipcMain.handle('library:albums', (_event, options?: { sort?: string; limit?: number; offset?: number }) =>
    getLibraryAlbums(options))
  ipcMain.handle('library:artists', (_event, options?: { sort?: string }) =>
    getLibraryArtists(options))
  ipcMain.handle('library:genres', async (_event, providerId: string) => getLibraryGenres(providerId))
  ipcMain.handle('library:artists-by-genre', async (_event, providerId: string, genre: string) =>
    getLibraryArtistsByGenre(providerId, genre))
  ipcMain.handle('library:artist-profile', async (_event, artistId: string) =>
    getLibraryArtistProfile(artistId))
  ipcMain.handle('library:tracks-album', (_event, albumId: string) =>
    getLibraryAlbumTracks(albumId))
  ipcMain.handle('library:tracks-artist', (_event, artistId: string) =>
    getLibraryArtistTracks(artistId))
  ipcMain.handle('library:search', async (_event, query: string) => searchLibrary(query))
  ipcMain.handle('library:remove-track', (_event, trackId: string) =>
    removeLibraryTrack(trackId, onCatalogChanged))
  ipcMain.handle('library:clear', () => clearLibrary(onCatalogChanged))
}
