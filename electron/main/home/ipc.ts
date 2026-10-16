import { ipcMain } from 'electron'
import {
  getProviderCollection,
  getProviderShelves,
} from './providerShelves'

export function registerHomeIpc(): void {
  ipcMain.handle('home:get-provider-shelves', async () => getProviderShelves())

  ipcMain.handle('home:get-provider-collection', async (_event, provider: string, sourceType: 'playlist' | 'mix' | 'station', sourceId: string) =>
    getProviderCollection(provider, sourceType, sourceId))
}
