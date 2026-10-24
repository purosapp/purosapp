import type Database from 'better-sqlite3'
import { app } from 'electron'
import { generatedProviders } from './generated'
import { registerProviderIpc } from './ipc'
import { ProviderLifecycle } from './lifecycle'
import { ProviderRegistry } from './registry'
import { ProviderCatalogAdapter } from './catalogAdapter'
import { reconcileProviderAvailability as reconcileAvailability } from './availability'
import type { ProviderCapabilityV1, ProviderValueV1 } from '../../../src/provider-api/v1'
import { clearLegacyProviderAuthSessions as clearLegacyAuthSessions, migrateLegacyProviderState as migrateLegacyState } from './migrations'
import { ProviderLibrarySyncCoordinator, type ProviderLibrarySyncDeps } from './librarySync'
import { ProviderPackageService, providerPackagesRoot } from './packages/service'
import { registerProviderPackageIpc } from './packages/ipc'

export const providerRegistry = new ProviderRegistry()
export const providerLifecycle = new ProviderLifecycle(providerRegistry, generatedProviders, activateInstalledProviderPackages)

let providerPackageService: ProviderPackageService | null = null

/** Installed (runtime-imported) provider packages, under `<userData>/provider-packages`. */
export function getProviderPackageService(): ProviderPackageService {
  providerPackageService ??= new ProviderPackageService(providerRegistry, {
    root: providerPackagesRoot(app.getPath('userData')),
    context: {
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      bundledProviderIds: new Set(generatedProviders.map(({ manifest }) => manifest.id)),
    },
  })
  return providerPackageService
}

async function activateInstalledProviderPackages(): Promise<void> {
  const service = getProviderPackageService()
  // Packaged smoke tests only: install a package before startup, accepting its warnings,
  // to exercise the real import → discovery → launch path without UI automation.
  const smokePackage = process.env.PUROS_RENDERER_SMOKE === '1' && process.env.PUROS_RENDERER_SMOKE_RESULT
    ? process.env.PUROS_SMOKE_PROVIDER_PACKAGE
    : undefined
  if (smokePackage) {
    service.installer.recover()
    for (const packagePath of smokePackage.split(',').filter(Boolean)) {
      const summary = service.inspect(packagePath)
      service.installer.commit(summary.token, summary.trust.warnings)
    }
  }
  await service.activateInstalled()
}
export const providerLibrarySync = new ProviderLibrarySyncCoordinator(providerRegistry)

export function getSelectedProviderIds(): string[] {
  return generatedProviders.map(({ manifest }) => manifest.id)
}

export function configureProviderLibrarySync(deps: ProviderLibrarySyncDeps): void {
  providerLibrarySync.configure(deps)
}

export function registerProviderIpcHandlers(
  getMainWindow: Parameters<typeof registerProviderIpc>[1],
): () => void {
  const disposeProviderIpc = registerProviderIpc(providerRegistry, getMainWindow, providerLibrarySync)
  const disposePackageIpc = registerProviderPackageIpc(getProviderPackageService, providerRegistry, getMainWindow)
  return () => {
    disposePackageIpc()
    disposeProviderIpc()
  }
}

export function syncHostManagedLibraries(options?: { skipSyncedWithinMs?: number }): Promise<number> {
  return providerLibrarySync.syncReadyManagedProviders(options)
}

export function getActiveProviderLibrarySyncPromise(): Promise<unknown> | null {
  return providerLibrarySync.getAnyPending()
}

export function createCatalogProviderAdapters(db: Database.Database) {
  return providerRegistry.list().map(({ manifest }) => (
    new ProviderCatalogAdapter(providerRegistry, db, manifest.id)
  ))
}

export function getProviderPriorities() {
  return providerRegistry.list().map(({ manifest }) => ({
    id: manifest.id,
    defaultPriority: manifest.defaultPriority,
  }))
}

export function isProviderAvailable(providerId: string): boolean {
  if (!providerRegistry.has(providerId)) return false
  const status = providerRegistry.getStatus(providerId)
  return (status.state === 'ready' || status.state === 'degraded') && status.authenticated !== false
}

export function reconcileProviderAvailability(db: Database.Database): void {
  reconcileAvailability(db, providerRegistry)
}

export function watchProviderAvailability(
  db: Database.Database,
  onChanged: () => void,
): () => void {
  return providerRegistry.subscribe((envelope) => {
    if (envelope.event.type !== 'status.changed' && envelope.event.type !== 'auth.changed') return
    reconcileAvailability(db, providerRegistry)
    onChanged()
  })
}

export function migrateLegacyProviderState(db: Database.Database): void {
  migrateLegacyState(db)
}

export function clearLegacyProviderAuthSessions(): Promise<void> {
  return clearLegacyAuthSessions()
}

export function listProviderDescriptors() {
  return providerRegistry.list()
}

export function invokeProvider(
  providerId: string,
  capability: ProviderCapabilityV1,
  method: string,
  args: ProviderValueV1[] = [],
) {
  return providerRegistry.invoke(providerId, capability, method, args)
}
