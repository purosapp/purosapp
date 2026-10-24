import { ipcMain, type BrowserWindow } from 'electron'
import { isValidProviderId, PROVIDER_SESSION_ID_PATTERN, type ProviderCapabilityV1, type ProviderValueV1 } from '../../../src/provider-api/v1'
import { ProviderRegistry } from './registry'
import { ProviderLibrarySyncCoordinator } from './librarySync'
import { validateInvokeInput } from './validation'
import { getDb } from '../db'
import { emitLibraryCatalogChanged } from '../rendererBridge'
import { unavailableReasonFromProviderError } from '../../../src/utils/trackAvailability'
import { setProviderTrackUnavailableReason } from './catalogData'
import {
  deleteProviderSecret,
  deleteProviderSetting,
  getProviderSetting,
  hasProviderSecret,
  listRetainedProviderData,
  removeProviderData,
  setProviderSecret,
  setProviderSetting,
} from './config'

function isPlaybackResolve(capability: string, method: string): boolean {
  return (capability === 'playback.resolve' && method === 'resolve')
    || (capability === 'playback.prefetch' && method === 'prefetch')
}

/** Playback is the last word on whether the account can stream a track. */
function recordPlaybackAvailability(
  providerId: string,
  request: unknown,
  result: Awaited<ReturnType<ProviderRegistry['invoke']>>,
): void {
  const sourceId = (request as { sourceId?: unknown } | null)?.sourceId
  if (typeof sourceId !== 'string' || !sourceId) return
  // A prefetch may decline with null; only a returned artifact proves the track plays.
  if (result.ok && result.value == null) return
  const reason = result.ok ? null : unavailableReasonFromProviderError(result.error)
  if (!result.ok && !reason) return
  try {
    if (setProviderTrackUnavailableReason(getDb(), providerId, sourceId, reason)) emitLibraryCatalogChanged()
  } catch (error) {
    console.warn(`[Puros][Provider:${providerId}] Could not record track availability:`, error)
  }
}

export function registerProviderIpc(
  registry: ProviderRegistry,
  getMainWindow: () => BrowserWindow | null,
  librarySync: ProviderLibrarySyncCoordinator,
): () => void {
  ipcMain.handle('provider:list', () => registry.list())
  ipcMain.handle('provider:status', (_event, providerId: unknown) => {
    if (!isValidProviderId(providerId)) throw new TypeError('Invalid provider ID')
    return registry.getStatus(providerId)
  })
  ipcMain.handle('provider:cancel-session', (_event, providerId: unknown, sessionId: unknown) => {
    if (!isValidProviderId(providerId) || typeof sessionId !== 'string' || !PROVIDER_SESSION_ID_PATTERN.test(sessionId)) {
      throw new TypeError('Invalid provider session cancellation request')
    }
    return registry.cancelSession(providerId, sessionId)
  })
  ipcMain.handle(
    'provider:invoke',
    async (_event, providerId: unknown, capability: unknown, method: unknown, args: unknown) => {
      const input = validateInvokeInput(providerId, capability, method, args)
      if (input.capability === 'library.sync' && input.method === 'enumerate' && librarySync.isHostManaged(input.providerId)) {
        const request = input.args[0] as { fullResync?: unknown } | null | undefined
        return librarySync.sync(input.providerId, { fullResync: request?.fullResync === true })
      }
      if (input.capability === 'auth' && input.method === 'logout' && librarySync.isHostManaged(input.providerId)) {
        librarySync.cancelPending()
        await librarySync.waitFor(input.providerId)
      }
      const result = await registry.invoke(
        input.providerId,
        input.capability as ProviderCapabilityV1,
        input.method,
        input.args as ProviderValueV1[],
      )
      if (isPlaybackResolve(input.capability, input.method)) {
        recordPlaybackAvailability(input.providerId, input.args[0], result)
      }
      // A login step that did not end signed in (e.g. one that only opens a browser page) has nothing to sync yet.
      const signedIn = result.ok && (result.value as { status?: { authenticated?: unknown } } | undefined)?.status?.authenticated !== false
      if (signedIn && input.capability === 'auth' && input.method === 'login' && librarySync.isHostManaged(input.providerId)) {
        const synced = await librarySync.sync(input.providerId)
        if (!synced.ok) console.warn(`[Puros][Provider:${input.providerId}] Initial library sync failed:`, synced.error.message)
      }
      return result
    },
  )
  ipcMain.handle('provider:setting:get', (_event, providerId: unknown, key: unknown) => {
    if (!isValidProviderId(providerId) || typeof key !== 'string') throw new TypeError('Invalid provider setting request')
    return getProviderSetting(registry.getEntry(providerId).manifest, key)
  })
  ipcMain.handle('provider:setting:set', (_event, providerId: unknown, key: unknown, value: unknown) => {
    if (!isValidProviderId(providerId) || typeof key !== 'string') throw new TypeError('Invalid provider setting request')
    setProviderSetting(registry.getEntry(providerId).manifest, key, value as never)
  })
  ipcMain.handle('provider:setting:delete', (_event, providerId: unknown, key: unknown) => {
    if (!isValidProviderId(providerId) || typeof key !== 'string') throw new TypeError('Invalid provider setting request')
    deleteProviderSetting(registry.getEntry(providerId).manifest, key)
  })
  ipcMain.handle('provider:secret:has', (_event, providerId: unknown, key: unknown) => {
    if (!isValidProviderId(providerId) || typeof key !== 'string') throw new TypeError('Invalid provider secret request')
    return hasProviderSecret(getDb(), registry.getEntry(providerId).manifest, key)
  })
  ipcMain.handle('provider:secret:set', (_event, providerId: unknown, key: unknown, value: unknown) => {
    if (!isValidProviderId(providerId) || typeof key !== 'string' || typeof value !== 'string') throw new TypeError('Invalid provider secret request')
    setProviderSecret(getDb(), registry.getEntry(providerId).manifest, key, value)
  })
  ipcMain.handle('provider:secret:delete', (_event, providerId: unknown, key: unknown) => {
    if (!isValidProviderId(providerId) || typeof key !== 'string') throw new TypeError('Invalid provider secret request')
    deleteProviderSecret(getDb(), registry.getEntry(providerId).manifest, key)
  })
  // Data of providers that are not running here (disabled, code removed, or not in this build).
  ipcMain.handle('provider:retained-data', () => listRetainedProviderData(getDb()).filter(({ providerId }) => !registry.has(providerId)))
  ipcMain.handle('provider:remove-data', async (_event, providerId: unknown) => {
    if (!isValidProviderId(providerId)) throw new TypeError('Invalid provider ID')
    if (!registry.has(providerId)) {
      // No runtime to sign out through; only data this profile actually holds for that ID can be removed.
      if (!listRetainedProviderData(getDb()).some((entry) => entry.providerId === providerId)) throw new Error(`No data is stored for provider ${providerId}`)
      const removed = removeProviderData(getDb(), providerId)
      emitLibraryCatalogChanged()
      return removed
    }
    if (librarySync.isHostManaged(providerId)) {
      librarySync.cancelPending()
      await librarySync.waitFor(providerId)
    }
    const entry = registry.getEntry(providerId)
    if (entry.manifest.capabilities.includes('auth')) {
      const logout = await registry.invoke(providerId, 'auth', 'logout', [])
      if (!logout.ok) console.warn(`[Puros][Provider:${providerId}] Logout before data removal failed:`, logout.error.message)
    }
    return removeProviderData(getDb(), entry.manifest.id)
  })
  return registry.subscribe((event) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('provider:event', event)
  })
}
