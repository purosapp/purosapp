import fs from 'node:fs'
import path from 'node:path'
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { isValidProviderId } from '../../../../src/provider-api/v1'
import type { ProviderRegistry } from '../registry'
import { validateProviderManifest } from '../validation'
import { PACKAGE_MANIFEST_PATH } from './format'
import type { InstallOutcome, ProviderPackageService } from './service'
import type { PackageInspectionSummary } from './installer'
import { formatKeyFingerprint } from './signature'
import { FIRST_PARTY_PUBLISHER_KEYS, type PackageTrustWarning } from './trust'

export type PackageIpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface InstalledProviderPackageInfo {
  providerId: string
  displayName: string
  description: string | null
  version: string
  previousVersion: string | null
  enabled: boolean
  installedAt: number
  signature: 'first-party' | 'publisher' | 'unsigned'
  publisherFingerprint: string | null
  /** Registry state when loaded; null when the provider is not running (disabled or failed before start). */
  state: string | null
  lastError: string | null
}

const WARNINGS: ReadonlySet<PackageTrustWarning> = new Set<PackageTrustWarning>([
  'runs-with-user-privileges', 'unsigned-package', 'new-publisher', 'publisher-changed', 'signed-to-unsigned',
  'native-code-not-notarized', 'downgrade', 'unordered-version', 'same-version-different-content',
])
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function guarded<T>(operation: () => T | Promise<T>): Promise<PackageIpcResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Display-only manifest read (the code is never executed from this path). */
function displayManifest(packageRoot: string | null): { displayName: string; description: string | null } | null {
  if (!packageRoot) return null
  try {
    const validation = validateProviderManifest(JSON.parse(fs.readFileSync(path.join(packageRoot, PACKAGE_MANIFEST_PATH), 'utf8')))
    return validation.ok ? { displayName: validation.manifest.displayName, description: validation.manifest.description ?? null } : null
  } catch {
    return null
  }
}

export function listInstalledProviderPackages(service: ProviderPackageService, registry: ProviderRegistry): InstalledProviderPackageInfo[] {
  return Object.entries(service.list())
    .map(([providerId, record]) => {
      const display = displayManifest(service.installer.activePackageRoot(providerId))
      const keyId = record.active.publisherKeyId
      return {
        providerId,
        displayName: display?.displayName ?? providerId,
        description: display?.description ?? null,
        version: record.active.version,
        previousVersion: record.previous?.version ?? null,
        enabled: record.enabled,
        installedAt: record.active.installedAt,
        signature: keyId === null ? 'unsigned' : FIRST_PARTY_PUBLISHER_KEYS.some((key) => key.keyId === keyId) ? 'first-party' : 'publisher',
        publisherFingerprint: keyId ? formatKeyFingerprint(keyId) : null,
        state: registry.has(providerId) ? registry.getStatus(providerId).state : null,
        lastError: service.lastError(providerId),
      } satisfies InstalledProviderPackageInfo
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
}

/**
 * Settings IPC for installed provider packages. The renderer never supplies a
 * filesystem path: main shows the open dialog and keeps the inspected package
 * behind an opaque token until the user accepts its warnings.
 */
let smokeDialogIndex = 0

export function registerProviderPackageIpc(
  getService: () => ProviderPackageService,
  registry: ProviderRegistry,
  getMainWindow: () => BrowserWindow | null,
): () => void {
  ipcMain.handle('provider-packages:list', () => guarded(() => listInstalledProviderPackages(getService(), registry)))
  ipcMain.handle('provider-packages:choose', (_event, providerId?: unknown) => guarded(async (): Promise<PackageInspectionSummary | null> => {
    if (providerId !== undefined && !isValidProviderId(providerId)) throw new TypeError('Invalid provider ID')
    const service = getService()
    const installed = providerId === undefined ? null : listInstalledProviderPackages(service, registry).find(item => item.providerId === providerId)
    if (providerId !== undefined && !installed) throw new Error(`Provider package ${providerId} is not installed`)
    // Packaged smoke tests only: stand in for the native dialog, which UI automation cannot drive.
    // A comma-separated list answers successive dialogs in order.
    const smokePaths = process.env.PUROS_RENDERER_SMOKE === '1' && process.env.PUROS_RENDERER_SMOKE_RESULT
      ? (process.env.PUROS_SMOKE_PACKAGE_DIALOG_PATH ?? '').split(',').filter(Boolean)
      : []
    const smokePath = smokePaths[smokeDialogIndex++]
    let filePath = smokePath
    if (!filePath) {
      const window = getMainWindow()
      const options: Electron.OpenDialogOptions = {
        title: installed ? `Update ${installed.displayName} (v${installed.version})` : 'Install a Puros provider',
        buttonLabel: 'Inspect',
        properties: ['openFile'],
        filters: [{ name: 'Puros provider package', extensions: ['zip'] }],
      }
      const selection = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      if (selection.canceled || !selection.filePaths[0]) return null
      filePath = selection.filePaths[0]
    }
    return service.inspect(filePath, providerId)
  }))
  ipcMain.handle('provider-packages:install', (_event, token: unknown, acceptedWarnings: unknown) => guarded(async (): Promise<InstallOutcome> => {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new TypeError('Invalid package inspection token')
    if (!Array.isArray(acceptedWarnings) || acceptedWarnings.length > WARNINGS.size
      || acceptedWarnings.some((warning) => typeof warning !== 'string' || !WARNINGS.has(warning as PackageTrustWarning))) {
      throw new TypeError('Invalid accepted warnings')
    }
    return getService().install(token, acceptedWarnings as PackageTrustWarning[])
  }))
  ipcMain.handle('provider-packages:discard', (_event, token: unknown) => guarded(() => {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new TypeError('Invalid package inspection token')
    getService().discard(token)
  }))
  ipcMain.handle('provider-packages:set-enabled', (_event, providerId: unknown, enabled: unknown) => guarded(async () => {
    if (!isValidProviderId(providerId) || typeof enabled !== 'boolean') throw new TypeError('Invalid provider package request')
    const outcome = await getService().setEnabled(providerId, enabled)
    if (!outcome) throw new Error(`Provider package ${providerId} is not installed`)
    return outcome
  }))
  ipcMain.handle('provider-packages:remove-code', (_event, providerId: unknown) => guarded(async () => {
    if (!isValidProviderId(providerId)) throw new TypeError('Invalid provider ID')
    if (!await getService().removeCode(providerId)) throw new Error(`Provider package ${providerId} is not installed`)
  }))
  return () => {
    for (const channel of ['list', 'choose', 'install', 'discard', 'set-enabled', 'remove-code']) ipcMain.removeHandler(`provider-packages:${channel}`)
  }
}
