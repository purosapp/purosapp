import {
  ipcMain,
  type BrowserWindow,
} from 'electron'
import {
  type LiveRadioBrowseOptions,
  type Station,
} from '../../../src/services/liveRadio/types'
import {
  addCustomLiveRadio,
  browseLiveRadio,
  getLiveRadioFilters,
  getLiveRadioNowPlaying,
  getSavedLiveRadioStations,
  markLiveRadioPlaybackStarted,
  probeLiveRadio,
  removeLiveRadio,
  saveLiveRadio,
  searchLiveRadio,
  startLiveRadioPlayback,
  stopLiveRadioPlayback,
} from './workflows'

type LiveRadioIpcDeps = {
  readonly win: BrowserWindow | null
}

export function registerLiveRadioIpc(deps: LiveRadioIpcDeps): void {
  const onChanged = () => deps.win?.webContents.send('live-radio:changed')

  ipcMain.handle('live-radio:browse', async (_event, options?: LiveRadioBrowseOptions) =>
    browseLiveRadio(options))
  ipcMain.handle('live-radio:filters', async () => getLiveRadioFilters())
  ipcMain.handle('live-radio:search', async (_event, query: string, limit?: number) =>
    searchLiveRadio(query, limit))
  ipcMain.handle('live-radio:my-stations', () => getSavedLiveRadioStations())
  ipcMain.handle('live-radio:save-station', (_event, station: Station) =>
    saveLiveRadio(station, onChanged))
  ipcMain.handle('live-radio:remove-station', (_event, stationId: string) =>
    removeLiveRadio(stationId, onChanged))
  ipcMain.handle('live-radio:add-custom-stream', async (
    _event,
    payload: { url: string; name?: string | null },
  ) => addCustomLiveRadio(payload, onChanged))
  ipcMain.handle('live-radio:probe-stream', async (_event, url: string) =>
    probeLiveRadio(url))
  ipcMain.handle('live-radio:get-now-playing', async (_event, stationId: string, streamUrl: string) =>
    getLiveRadioNowPlaying(stationId, streamUrl))
  ipcMain.handle('live-radio:start-playback', async (_event, stationId: string, streamUrl: string) =>
    startLiveRadioPlayback(stationId, streamUrl))
  ipcMain.handle('live-radio:stop-playback', (_event, stationId?: string | null) =>
    stopLiveRadioPlayback(stationId))
  ipcMain.handle('live-radio:playback-started', (_event, stationId: string, streamUrl: string) =>
    markLiveRadioPlaybackStarted(stationId, streamUrl))
  ipcMain.handle('live-radio:playback-stopped', (_event, stationId?: string | null) =>
    stopLiveRadioPlayback(stationId))
}
