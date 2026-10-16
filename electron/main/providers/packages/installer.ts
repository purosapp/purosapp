import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderManifestV1 } from '../../../../src/provider-api/v1'
import { MAX_ARCHIVE_BYTES, MODE_FILE, PACKAGE_DESCRIPTOR_PATH, PACKAGE_SIGNATURE_PATH, packageError } from './format'
import {
  readInstallState,
  writeInstallState,
  type InstalledPackageVersion,
  type InstalledProviderRecord,
  type InstallStateV1,
} from './installState'
import {
  classifyNativeCode,
  compareProviderVersions,
  evaluatePackageTrust,
  inspectCodeSignature,
  type CodeSignatureInspector,
  type PackageTrustVerdict,
  type PackageTrustWarning,
  type TrustedPublisherKey,
} from './trust'
import { validateProviderPackage, type PackageValidationContext, type ValidatedPackage } from './validatePackage'
import { readPackageArchive } from './zipReader'

export type PackageVersionRelation = 'new' | 'upgrade' | 'same' | 'replace' | 'downgrade' | 'unordered'

/** What the consent screen shows before anything is installed. */
export interface PackageInspectionSummary {
  token: string
  providerId: string
  version: string
  displayName: string
  description: string | null
  homepage: string | null
  capabilities: string[]
  permissions: {
    networkOrigins: string[]
    externalOrigins: string[]
    secrets: string[]
    runtimeEnvironment: string[]
    authOrigins: string[]
    helpers: Array<{ id: string; executable: string }>
  }
  platform: { os: string; arch: string[] } | null
  archiveSha256: string
  relation: PackageVersionRelation
  installedVersion: string | null
  trust: PackageTrustVerdict
}

export interface PackageInstallResult {
  providerId: string
  status: 'installed' | 'already-installed'
  active: InstalledPackageVersion
  previous: InstalledPackageVersion | null
}

interface PendingInspection {
  summary: PackageInspectionSummary
  validated: ValidatedPackage
  stagingDirectory: string | null
  /** Active archive hash when inspected; commit refuses if another install happened meanwhile. */
  baseArchiveSha256: string | null
  createdAt: number
}

export interface ProviderPackageInstallerOptions {
  /** `<userData>/provider-packages`: code only. Provider data lives elsewhere and is never touched here. */
  root: string
  context: PackageValidationContext
  inspectCodeSignature?: CodeSignatureInspector
  trustedKeys?: readonly TrustedPublisherKey[]
  now?: () => number
}

const INSPECTION_TTL_MS = 30 * 60_000

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function versionDirectoryName(version: string, archiveSha256: string): string {
  const safeVersion = version.replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '_').slice(0, 64)
  return `${safeVersion}-${archiveSha256.slice(0, 12)}`
}

function fsyncPath(target: string): void {
  const descriptor = fs.openSync(target, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function summarize(manifest: ProviderManifestV1, validated: ValidatedPackage, archiveSha256: string, relation: PackageVersionRelation,
  installedVersion: string | null, trust: PackageTrustVerdict, token: string): PackageInspectionSummary {
  const permissions = manifest.permissions ?? {}
  return {
    token,
    providerId: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description ?? null,
    homepage: manifest.homepage ?? null,
    capabilities: [...manifest.capabilities],
    permissions: {
      networkOrigins: [...(permissions.networkOrigins ?? [])],
      externalOrigins: [...(permissions.externalOrigins ?? [])],
      secrets: [...(permissions.secrets ?? [])],
      runtimeEnvironment: [...(permissions.runtimeEnvironment ?? [])],
      authOrigins: [...new Set((permissions.authCollections ?? []).flatMap((collection) => collection.allowedOrigins))],
      helpers: (permissions.helpers ?? []).map((helper) => ({ id: helper.id, executable: helper.executable })),
    },
    platform: validated.descriptor.platform,
    archiveSha256,
    relation,
    installedVersion,
    trust,
  }
}

/**
 * Two-phase, crash-safe installation of provider packages.
 *
 * `inspect` fully validates an archive, extracts it into a private staging
 * directory, verifies what was written, inspects native code signatures, and
 * returns a summary plus trust warnings. Nothing becomes visible until
 * `commit` is called with every warning explicitly accepted; it then renames
 * the staged tree into place and atomically replaces `installed.json`.
 */
export class ProviderPackageInstaller {
  private readonly root: string
  private readonly packagesRoot: string
  private readonly stagingRoot: string
  private readonly trashRoot: string
  private readonly pending = new Map<string, PendingInspection>()

  constructor(private readonly options: ProviderPackageInstallerOptions) {
    this.root = path.resolve(options.root)
    this.packagesRoot = path.join(this.root, 'packages')
    this.stagingRoot = path.join(this.root, '.staging')
    this.trashRoot = path.join(this.root, '.trash')
    for (const directory of [this.root, this.packagesRoot, this.stagingRoot, this.trashRoot]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private state(): InstallStateV1 {
    return readInstallState(this.root).state
  }

  list(): Readonly<Record<string, InstalledProviderRecord>> {
    return this.state().providers
  }

  /** Absolute root of the active installed version, or null when the provider is not installed. */
  activePackageRoot(providerId: string): string | null {
    const record = this.state().providers[providerId]
    return record ? path.join(this.packagesRoot, providerId, record.active.directory) : null
  }

  /**
   * Startup recovery: drops abandoned staging/trash, falls back to the last good
   * state file, restores a missing active version from `previous`, and removes
   * package directories no record references (for example after a crash between
   * the directory rename and the state write).
   */
  recover(): { stateSource: 'current' | 'previous' | 'empty'; removedDirectories: number; repairedProviders: string[] } {
    this.pending.clear()
    let removedDirectories = 0
    for (const scratch of [this.stagingRoot, this.trashRoot]) {
      for (const entry of fs.readdirSync(scratch)) {
        fs.rmSync(path.join(scratch, entry), { recursive: true, force: true })
        removedDirectories += 1
      }
    }
    const { state, source } = readInstallState(this.root)
    const repairedProviders: string[] = []
    const exists = (id: string, version: InstalledPackageVersion | null) => version !== null
      && fs.existsSync(path.join(this.packagesRoot, id, version.directory, PACKAGE_DESCRIPTOR_PATH))
    for (const [id, record] of Object.entries(state.providers)) {
      if (exists(id, record.active)) {
        if (record.previous && !exists(id, record.previous)) {
          record.previous = null
          repairedProviders.push(id)
        }
        continue
      }
      repairedProviders.push(id)
      if (record.previous && exists(id, record.previous)) state.providers[id] = { ...record, active: record.previous, previous: null }
      else delete state.providers[id]
    }
    if (repairedProviders.length > 0 || source === 'previous') writeInstallState(this.root, state)
    for (const id of fs.readdirSync(this.packagesRoot)) {
      const providerRoot = path.join(this.packagesRoot, id)
      const keep = new Set([state.providers[id]?.active.directory, state.providers[id]?.previous?.directory].filter(Boolean))
      for (const directory of fs.readdirSync(providerRoot)) {
        if (keep.has(directory)) continue
        fs.rmSync(path.join(providerRoot, directory), { recursive: true, force: true })
        removedDirectories += 1
      }
      if (fs.readdirSync(providerRoot).length === 0) fs.rmdirSync(providerRoot)
    }
    return { stateSource: source, removedDirectories, repairedProviders }
  }

  inspect(archivePath: string): PackageInspectionSummary {
    this.expireInspections()
    const stat = fs.lstatSync(archivePath)
    if (!stat.isFile()) packageError('The selected package is not a regular file')
    if (stat.size > MAX_ARCHIVE_BYTES) packageError('The selected package is too large')
    const archive = fs.readFileSync(archivePath)
    const archiveSha256 = sha256(archive)
    const validated = validateProviderPackage(readPackageArchive(archive), this.options.context)
    const manifest = validated.manifest
    const installed = this.state().providers[manifest.id] ?? null

    let relation: PackageVersionRelation = 'new'
    if (installed) {
      const order = compareProviderVersions(manifest.version, installed.active.version)
      relation = installed.active.archiveSha256 === archiveSha256 ? 'same'
        : order === null ? (manifest.version === installed.active.version ? 'replace' : 'unordered')
          : order > 0 ? 'upgrade' : order < 0 ? 'downgrade' : 'replace'
    }
    const token = crypto.randomUUID()
    let stagingDirectory: string | null = null
    let nativeCode: ReturnType<typeof classifyNativeCode> = validated.binaries.length > 0 ? 'ad-hoc' : 'none'
    try {
      if (relation !== 'same') {
        stagingDirectory = path.join(this.stagingRoot, token)
        this.extract(validated, stagingDirectory)
        nativeCode = classifyNativeCode(
          validated.binaries.map((binary) => path.join(stagingDirectory!, binary)),
          this.options.inspectCodeSignature ?? inspectCodeSignature,
        )
      }
      const trust = evaluatePackageTrust({
        signature: validated.signature,
        pinned: installed ? { keyId: installed.active.publisherKeyId } : null,
        nativeCode,
        versionRelation: relation,
        trustedKeys: this.options.trustedKeys,
      })
      const summary = summarize(manifest, validated, archiveSha256, relation, installed?.active.version ?? null, trust, token)
      this.pending.set(token, {
        summary, validated, stagingDirectory,
        baseArchiveSha256: installed?.active.archiveSha256 ?? null,
        createdAt: this.now(),
      })
      return summary
    } catch (error) {
      if (stagingDirectory) fs.rmSync(stagingDirectory, { recursive: true, force: true })
      throw error
    }
  }

  discard(token: string): void {
    const inspection = this.pending.get(token)
    this.pending.delete(token)
    if (inspection?.stagingDirectory) fs.rmSync(inspection.stagingDirectory, { recursive: true, force: true })
  }

  commit(token: string, acceptedWarnings: readonly PackageTrustWarning[]): PackageInstallResult {
    this.expireInspections()
    const inspection = this.pending.get(token)
    if (!inspection) packageError('This package inspection expired or was already used; select the package again')
    const { summary } = inspection
    const accepted = new Set(acceptedWarnings)
    const missing = summary.trust.warnings.filter((warning) => !accepted.has(warning))
    if (missing.length > 0) packageError(`Installing requires accepting: ${missing.join(', ')}`)

    const state = this.state()
    const current = state.providers[summary.providerId] ?? null
    if ((current?.active.archiveSha256 ?? null) !== inspection.baseArchiveSha256) {
      this.discard(token)
      packageError('Installed providers changed since this package was inspected; select the package again')
    }
    this.pending.delete(token)
    if (summary.relation === 'same' && current) {
      return { providerId: summary.providerId, status: 'already-installed', active: current.active, previous: current.previous }
    }

    const directory = versionDirectoryName(summary.version, summary.archiveSha256)
    const providerRoot = path.join(this.packagesRoot, summary.providerId)
    const target = path.join(providerRoot, directory)
    try {
      fs.mkdirSync(providerRoot, { recursive: true, mode: 0o700 })
      if (fs.existsSync(target)) {
        // Only possible when reinstalling the byte-identical previous version; move it aside first.
        fs.renameSync(target, path.join(this.trashRoot, crypto.randomUUID()))
      }
      fs.renameSync(inspection.stagingDirectory!, target)
      fsyncPath(providerRoot)
    } catch (error) {
      if (inspection.stagingDirectory) fs.rmSync(inspection.stagingDirectory, { recursive: true, force: true })
      throw error
    }

    const active: InstalledPackageVersion = {
      directory,
      version: summary.version,
      archiveSha256: summary.archiveSha256,
      publisherKeyId: inspection.validated.signature?.keyId ?? null,
      installedAt: this.now(),
    }
    const previous = current && current.active.directory !== directory ? current.active : current?.previous ?? null
    state.providers[summary.providerId] = { active, previous, enabled: current?.enabled ?? true }
    // The state write is the commit point: before it the old version stays active; after it the new one is.
    writeInstallState(this.root, state)
    this.collectGarbage(summary.providerId, state)
    return { providerId: summary.providerId, status: 'installed', active, previous }
  }

  /**
   * Reverts a provider to its previous version (used when a new version fails
   * to activate). A first install without a previous version is removed; its
   * provider data is untouched either way.
   */
  rollback(providerId: string): InstalledPackageVersion | null {
    const state = this.state()
    const record = state.providers[providerId]
    if (!record) return null
    if (record.previous) state.providers[providerId] = { ...record, active: record.previous, previous: null }
    else delete state.providers[providerId]
    writeInstallState(this.root, state)
    this.collectGarbage(providerId, state)
    return state.providers[providerId]?.active ?? null
  }

  /** Persists the enabled flag; returns false when the provider is not installed. */
  setEnabled(providerId: string, enabled: boolean): boolean {
    const state = this.state()
    const record = state.providers[providerId]
    if (!record) return false
    if (record.enabled !== enabled) {
      state.providers[providerId] = { ...record, enabled }
      writeInstallState(this.root, state)
    }
    return true
  }

  /** Deletes an installed provider's code (all kept versions). Provider data lives elsewhere and is untouched. */
  removeCode(providerId: string): boolean {
    const state = this.state()
    if (!state.providers[providerId]) return false
    delete state.providers[providerId]
    writeInstallState(this.root, state)
    this.collectGarbage(providerId, state)
    return true
  }

  private extract(validated: ValidatedPackage, destination: string): void {
    fs.mkdirSync(destination, { mode: 0o700 })
    const root = fs.realpathSync(destination)
    // Descriptor and signature travel with the code so startup can re-verify the installed tree.
    const entries = [
      { path: PACKAGE_DESCRIPTOR_PATH, mode: MODE_FILE, data: validated.descriptorBytes },
      ...(validated.signatureBytes ? [{ path: PACKAGE_SIGNATURE_PATH, mode: MODE_FILE, data: validated.signatureBytes }] : []),
      ...validated.files,
    ]
    for (const entry of entries) {
      const target = path.join(root, ...entry.path.split('/'))
      const relative = path.relative(root, target)
      if (relative.startsWith('..') || path.isAbsolute(relative)) packageError(`Package path escapes its install directory: ${entry.path}`)
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
      if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) packageError(`Package directory for ${entry.path} is not a plain directory`)
      // 'wx' never follows or overwrites an existing path.
      const descriptor = fs.openSync(target, 'wx', entry.mode)
      try {
        fs.writeFileSync(descriptor, entry.data)
        fs.fchmodSync(descriptor, entry.mode)
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
    }
    // Re-read everything to catch disk or filesystem problems before the package can be committed.
    for (const entry of entries) {
      const target = path.join(root, ...entry.path.split('/'))
      const stat = fs.lstatSync(target)
      if (!stat.isFile() || (stat.mode & 0o7777) !== entry.mode || sha256(fs.readFileSync(target)) !== sha256(entry.data)) {
        packageError(`Extracted file ${entry.path} did not verify`)
      }
    }
    fsyncPath(root)
  }

  private collectGarbage(providerId: string, state: InstallStateV1): void {
    const providerRoot = path.join(this.packagesRoot, providerId)
    if (!fs.existsSync(providerRoot)) return
    const record = state.providers[providerId]
    const keep = new Set([record?.active.directory, record?.previous?.directory].filter(Boolean))
    for (const directory of fs.readdirSync(providerRoot)) {
      if (!keep.has(directory)) fs.rmSync(path.join(providerRoot, directory), { recursive: true, force: true })
    }
    if (!record && fs.readdirSync(providerRoot).length === 0) fs.rmdirSync(providerRoot)
  }

  private expireInspections(): void {
    const cutoff = this.now() - INSPECTION_TTL_MS
    for (const [token, inspection] of this.pending) if (inspection.createdAt < cutoff) this.discard(token)
  }
}

export { ProviderPackageError } from './format'
