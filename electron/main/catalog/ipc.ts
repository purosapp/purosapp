import {
  ipcMain,
  type BrowserWindow,
} from 'electron'
import {
  type CatalogBrowseScope,
  type CatalogEntityType,
  type CatalogProviderName,
} from '../../../src/services/catalog'
import {
  addCatalogEntityToLibrary,
  browseCatalog,
  browseCatalogAlbums,
  browseCatalogArtists,
  browseCatalogTracks,
  clearCatalogMetadataCache,
  getCatalogAlbum,
  getCatalogAlbumPreview,
  getCatalogAlbumTracks,
  getCatalogArtist,
  getCatalogArtistCounts,
  getCatalogArtistPlaylists,
  getCatalogArtistPreview,
  getCatalogArtistRadioTracks,
  getCatalogArtistRelated,
  getCatalogArtistReleases,
  getCatalogArtistTopTracks,
  getCatalogTrack,
  ensureCatalogReady,
  getCatalogBrowseService,
  refreshCatalogEntity,
  resolveCatalogPlayback,
  searchCatalog,
  searchLocalCatalog,
  searchRemoteCatalog,
} from './services'
import { updateManualCatalogArtistGenres } from './genres'

type CatalogIpcDeps = {
  readonly win: BrowserWindow | null
}

export function registerCatalogIpc(deps: CatalogIpcDeps): void {
  const onChanged = () => deps.win?.webContents.send('catalog:changed')

  ipcMain.handle('catalog:browse', async (_event, providerId: string, scope?: CatalogBrowseScope, limit?: number) =>
    browseCatalog(providerId, scope, limit))

  ipcMain.handle('catalog:browse-artists', async (_event, providerId: string, scope?: CatalogBrowseScope, limit?: number) =>
    browseCatalogArtists(providerId, scope, limit))

  ipcMain.handle('catalog:browse-albums', async (_event, providerId: string, scope?: CatalogBrowseScope, limit?: number) =>
    browseCatalogAlbums(providerId, scope, limit))

  ipcMain.handle('catalog:browse-tracks', async (_event, providerId: string, scope?: CatalogBrowseScope, limit?: number) =>
    browseCatalogTracks(providerId, scope, limit))

  ipcMain.handle('catalog:search', async (_event, providerId: string, query: string, limit?: number, scope?: CatalogBrowseScope) =>
    searchCatalog(providerId, query, limit, scope))

  ipcMain.handle('catalog:search-local', async (_event, providerId: string, query: string, limit?: number, scope?: CatalogBrowseScope) =>
    searchLocalCatalog(providerId, query, limit, scope))

  ipcMain.handle('catalog:search-remote', async (_event, providerId: string, query: string, limit?: number, scope?: CatalogBrowseScope) =>
    searchRemoteCatalog(providerId, query, limit, scope))

  ipcMain.handle('catalog:artist-counts', async (_event, catalogArtistId: string) =>
    getCatalogArtistCounts(catalogArtistId))

  ipcMain.handle('catalog:artist', async (_event, catalogArtistId: string) =>
    getCatalogArtist(catalogArtistId))

  ipcMain.handle('catalog:set-artist-genres', async (_event, catalogArtistId: string, genres: unknown) =>
    updateManualCatalogArtistGenres(catalogArtistId, genres, onChanged))

  ipcMain.handle('catalog:artist-preview', async (_event, catalogArtistId: string) =>
    getCatalogArtistPreview(catalogArtistId, onChanged))

  ipcMain.handle('catalog:source-choices', async (_event, kind: CatalogEntityType, id: string) => {
    await ensureCatalogReady()
    return getCatalogBrowseService().getSourceChoices(kind, id)
  })

  ipcMain.handle('catalog:track', async (_event, catalogTrackId: string) =>
    getCatalogTrack(catalogTrackId))

  ipcMain.handle('catalog:artist-releases', async (_event, catalogArtistId: string) =>
    getCatalogArtistReleases(catalogArtistId))

  ipcMain.handle('catalog:artist-top-tracks', async (_event, catalogArtistId: string) =>
    getCatalogArtistTopTracks(catalogArtistId))

  ipcMain.handle('catalog:artist-related', async (_event, catalogArtistId: string) =>
    getCatalogArtistRelated(catalogArtistId))

  ipcMain.handle('catalog:artist-playlists', async (_event, catalogArtistId: string) =>
    getCatalogArtistPlaylists(catalogArtistId))

  ipcMain.handle(
    'catalog:artist-radio-tracks',
    async (
      _event,
      catalogArtistId?: string | null,
      artistName?: string | null,
      excludeTrackIds?: string[],
      providerId?: string,
    ) => getCatalogArtistRadioTracks({
      catalogArtistId: catalogArtistId ?? null,
      artistName: artistName ?? null,
      excludeTrackIds: excludeTrackIds ?? [],
      providerId,
    }),
  )

  ipcMain.handle('catalog:album', async (_event, catalogAlbumId: string) =>
    getCatalogAlbum(catalogAlbumId))

  ipcMain.handle('catalog:album-preview', async (_event, catalogAlbumId: string) =>
    getCatalogAlbumPreview(catalogAlbumId, onChanged))

  ipcMain.handle('catalog:album-tracks', async (_event, catalogAlbumId: string) =>
    getCatalogAlbumTracks(catalogAlbumId))

  ipcMain.handle(
    'catalog:resolve-playback',
    async (
      _event,
      catalogTrackId: string,
      preferredProvider?: CatalogProviderName | null,
      preferredSourceId?: string | null,
      options?: { allowDiscovery?: boolean },
    ) => resolveCatalogPlayback(catalogTrackId, preferredProvider, preferredSourceId, options),
  )

  ipcMain.handle('catalog:add-to-library', async (
    _event,
    entityType: CatalogEntityType,
    catalogId: string,
    preferredProvider?: CatalogProviderName | null,
  ) => addCatalogEntityToLibrary(entityType, catalogId, preferredProvider))

  ipcMain.handle('catalog:refresh-entity', async (
    _event,
    entityType: CatalogEntityType,
    catalogId: string,
  ) => refreshCatalogEntity(entityType, catalogId, onChanged))





  ipcMain.handle('catalog:clear-metadata-cache', async () => clearCatalogMetadataCache())


}
