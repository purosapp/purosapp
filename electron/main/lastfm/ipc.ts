import { ipcMain } from 'electron'
import {
  callLastFmApi,
  completeLastFmAuth,
  getLastFmAuthenticationUrl,
  getLastFmConfigStatus,
  type LastFmApiCallPayload,
} from './'

export function registerLastFmIpc(): void {
  ipcMain.handle('lastfm:api-call', async (_event, payload: LastFmApiCallPayload) =>
    callLastFmApi(payload))
  ipcMain.handle('lastfm:get-auth-url', async () => getLastFmAuthenticationUrl())
  ipcMain.handle('lastfm:get-config-status', () => getLastFmConfigStatus())
  ipcMain.handle('lastfm:complete-auth', async () => completeLastFmAuth())
}
