import { ipcMain } from 'electron'
import {
  deleteSettingForIpc,
  getSettingForIpc,
  setSettingForIpc,
  type SettingSideEffectDeps,
} from './store'

export function registerSettingsIpc(deps: SettingSideEffectDeps): void {
  ipcMain.handle('settings:get', (_event, key: string) => getSettingForIpc(key))
  ipcMain.handle('settings:set', (_event, key: string, value: string) =>
    setSettingForIpc(key, value, deps))
  ipcMain.handle('settings:delete', (_event, key: string) =>
    deleteSettingForIpc(key, deps))
}
