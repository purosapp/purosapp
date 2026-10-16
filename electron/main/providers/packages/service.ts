import path from 'node:path'
import { startProviderDefinition, type ProviderDefinition } from '../loader'
import type { ProviderRegistry } from '../registry'
import { ProviderPackageInstaller, type PackageInspectionSummary } from './installer'
import type { InstalledProviderRecord } from './installState'
import { verifyInstalledPackage } from './installed'
import type { PackageTrustWarning } from './trust'
import type { PackageValidationContext } from './validatePackage'

export interface ProviderPackageServiceOptions {
  /** `<userData>/provider-packages` */
  root: string
  context: PackageValidationContext
  installer?: ProviderPackageInstaller
  /** Launches a verified definition; tests replace the utility-process launcher. */
  start?: (definition: ProviderDefinition, registry: ProviderRegistry) => Promise<void>
}

export interface InstallOutcome {
  providerId: string
  status: 'installed' | 'already-installed'
  /** False when the provider is disabled or activation failed. */
  activated: boolean
  /** True when the new version failed to activate and the previous state was restored. */
  rolledBack: boolean
  error?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Connects installed provider packages to the running registry: startup
 * discovery with re-verification, and hot install/update/enable/disable/remove
 * without restarting Puros. Provider data (SQLite rows, secrets, settings,
 * caches, `<userData>/providers/<id>`) is never touched here.
 */
export class ProviderPackageService {
  readonly installer: ProviderPackageInstaller
  /** Last start/verification failure per installed provider, for Settings to explain a missing provider. */
  private readonly lastErrors = new Map<string, string>()

  constructor(private readonly registry: ProviderRegistry, private readonly options: ProviderPackageServiceOptions) {
    this.installer = options.installer ?? new ProviderPackageInstaller({ root: options.root, context: options.context })
  }

  private launch(providerId: string): Promise<void> {
    return (this.options.start ?? startProviderDefinition)(this.definitionFor(providerId), this.registry)
  }

  list(): Readonly<Record<string, InstalledProviderRecord>> {
    return this.installer.list()
  }

  lastError(providerId: string): string | null {
    return this.lastErrors.get(providerId) ?? null
  }

  /** Verifies the active version and describes how to launch it. Throws on any integrity problem. */
  definitionFor(providerId: string): ProviderDefinition {
    const record = this.installer.list()[providerId]
    const packageRoot = this.installer.activePackageRoot(providerId)
    if (!record || !packageRoot) throw new Error(`Provider package ${providerId} is not installed`)
    const verified = verifyInstalledPackage(packageRoot, record.active, this.options.context)
    if (verified.manifest.id !== providerId) throw new Error(`Installed package directory does not hold provider ${providerId}`)
    return { manifest: verified.manifest, providerRoot: verified.providerRoot, entryPath: verified.entryPath, origin: 'installed' }
  }

  /**
   * Startup: recover interrupted installs, then start every enabled installed
   * provider. A package that fails verification or activation is reported and
   * never blocks the others.
   */
  async activateInstalled(): Promise<Array<{ providerId: string; error: string }>> {
    const recovery = this.installer.recover()
    if (recovery.repairedProviders.length > 0 || recovery.stateSource !== 'current') {
      console.warn('[Puros][ProviderPackages] Recovered install state:', recovery)
    }
    const failures: Array<{ providerId: string; error: string }> = []
    for (const [providerId, record] of Object.entries(this.installer.list())) {
      if (!record.enabled) continue
      if (this.options.context.bundledProviderIds.has(providerId)) {
        failures.push({ providerId, error: 'A provider with this ID is built into this Puros; the installed package is not started' })
        continue
      }
      try {
        await this.launch(providerId)
      } catch (error) {
        failures.push({ providerId, error: errorMessage(error) })
        await this.stop(providerId, { keepErrorEntry: true })
      }
    }
    for (const failure of failures) this.lastErrors.set(failure.providerId, failure.error)
    for (const failure of failures) console.error(`[Puros][Provider:${failure.providerId}] installed package failed to start: ${failure.error}`)
    return failures
  }

  inspect(archivePath: string, expectedProviderId?: string): PackageInspectionSummary {
    if (expectedProviderId !== undefined && !this.list()[expectedProviderId]) {
      throw new Error(`Provider package ${expectedProviderId} is not installed`)
    }
    const summary = this.installer.inspect(archivePath)
    if (expectedProviderId !== undefined && summary.providerId !== expectedProviderId) {
      this.installer.discard(summary.token)
      throw new Error(`This file contains provider ${summary.providerId}; select an update for ${expectedProviderId}`)
    }
    return summary
  }

  discard(token: string): void {
    this.installer.discard(token)
  }

  /**
   * Commits an inspected package and swaps the running provider to it. If the
   * new version cannot activate, the previous version (or nothing, for a first
   * install) is restored and restarted.
   */
  async install(token: string, acceptedWarnings: readonly PackageTrustWarning[]): Promise<InstallOutcome> {
    const result = this.installer.commit(token, acceptedWarnings)
    const { providerId } = result
    const enabled = this.installer.list()[providerId]?.enabled ?? false
    if (result.status === 'already-installed') {
      if (enabled && !this.registry.has(providerId)) return { ...await this.startOrReport(providerId), status: result.status }
      return { providerId, status: result.status, activated: this.registry.has(providerId), rolledBack: false }
    }
    await this.stop(providerId)
    if (!enabled) return { providerId, status: 'installed', activated: false, rolledBack: false }
    try {
      await this.launch(providerId)
      this.lastErrors.delete(providerId)
      return { providerId, status: 'installed', activated: true, rolledBack: false }
    } catch (error) {
      await this.stop(providerId)
      const restored = this.installer.rollback(providerId)
      if (restored) await this.startOrReport(providerId)
      else this.lastErrors.delete(providerId)
      return { providerId, status: 'installed', activated: false, rolledBack: true, error: errorMessage(error) }
    }
  }

  async setEnabled(providerId: string, enabled: boolean): Promise<InstallOutcome | null> {
    if (!this.installer.setEnabled(providerId, enabled)) return null
    if (!enabled) {
      await this.stop(providerId)
      return { providerId, status: 'already-installed', activated: false, rolledBack: false }
    }
    if (this.registry.has(providerId)) return { providerId, status: 'already-installed', activated: true, rolledBack: false }
    return { ...await this.startOrReport(providerId), status: 'already-installed' }
  }

  /** Stops the provider and deletes its installed code; its data is kept for a later reinstall. */
  async removeCode(providerId: string): Promise<boolean> {
    if (!this.installer.list()[providerId]) return false
    await this.stop(providerId)
    this.lastErrors.delete(providerId)
    return this.installer.removeCode(providerId)
  }

  private async startOrReport(providerId: string): Promise<InstallOutcome> {
    try {
      await this.launch(providerId)
      this.lastErrors.delete(providerId)
      return { providerId, status: 'installed', activated: true, rolledBack: false }
    } catch (error) {
      // Leave the entry in the registry with its error status so Settings can show why.
      await this.stop(providerId, { keepErrorEntry: true })
      this.lastErrors.set(providerId, errorMessage(error))
      return { providerId, status: 'installed', activated: false, rolledBack: false, error: errorMessage(error) }
    }
  }

  /** Deactivates the running process (cancelling any restart) and, unless asked to keep it, forgets the entry. */
  private async stop(providerId: string, options: { keepErrorEntry?: boolean } = {}): Promise<void> {
    if (!this.registry.has(providerId)) return
    const status = this.registry.getStatus(providerId)
    await this.registry.deactivate(providerId)
    if (options.keepErrorEntry) {
      if (status.state === 'error') this.registry.updateStatus(providerId, status)
      return
    }
    this.registry.remove(providerId)
  }
}

export function providerPackagesRoot(userDataPath: string): string {
  return path.join(userDataPath, 'provider-packages')
}
