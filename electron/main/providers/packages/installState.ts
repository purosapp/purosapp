import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isValidProviderId } from '../../../../src/provider-api/v1'

export interface InstalledPackageVersion {
  /** Directory name under `packages/<id>/`. */
  directory: string
  version: string
  archiveSha256: string
  /** Publisher key that signed this version; null for an unsigned package. */
  publisherKeyId: string | null
  installedAt: number
}

export interface InstalledProviderRecord {
  active: InstalledPackageVersion
  /** The version replaced by the last install, kept for rollback. */
  previous: InstalledPackageVersion | null
  enabled: boolean
}

export interface InstallStateV1 {
  formatVersion: 1
  providers: Record<string, InstalledProviderRecord>
}

export const STATE_FILE = 'installed.json'
export const PREVIOUS_STATE_FILE = 'installed.previous.json'

export function emptyInstallState(): InstallStateV1 {
  return { formatVersion: 1, providers: {} }
}

function isVersion(value: unknown): value is InstalledPackageVersion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.directory === 'string' && /^[A-Za-z0-9._+-]{1,96}$/.test(record.directory) && !record.directory.startsWith('.')
    && typeof record.version === 'string' && record.version.length > 0 && record.version.length <= 64
    && typeof record.archiveSha256 === 'string' && /^[0-9a-f]{64}$/.test(record.archiveSha256)
    && (record.publisherKeyId === null || (typeof record.publisherKeyId === 'string' && /^[0-9a-f]{32}$/.test(record.publisherKeyId)))
    && Number.isSafeInteger(record.installedAt)
}

export function parseInstallState(text: string): InstallStateV1 | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Record<string, unknown>
  if (state.formatVersion !== 1 || !state.providers || typeof state.providers !== 'object' || Array.isArray(state.providers)) return null
  for (const [id, record] of Object.entries(state.providers as Record<string, unknown>)) {
    if (!isValidProviderId(id) || !record || typeof record !== 'object') return null
    const entry = record as Record<string, unknown>
    if (!isVersion(entry.active) || (entry.previous !== null && !isVersion(entry.previous)) || typeof entry.enabled !== 'boolean') return null
  }
  return value as InstallStateV1
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

/** Durable replace: temp file in the same directory, fsync, rename, fsync the directory. */
export function writeFileDurably(filePath: string, contents: string): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`)
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, contents)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, filePath)
  fsyncDirectory(path.dirname(filePath))
}

/**
 * Reads the install state, falling back to the last good copy when the
 * current file is missing or unreadable (for example after disk corruption).
 */
export function readInstallState(root: string): { state: InstallStateV1; source: 'current' | 'previous' | 'empty' } {
  for (const [file, source] of [[STATE_FILE, 'current'], [PREVIOUS_STATE_FILE, 'previous']] as const) {
    const filePath = path.join(root, file)
    if (!fs.existsSync(filePath)) continue
    const parsed = parseInstallState(fs.readFileSync(filePath, 'utf8'))
    if (parsed) return { state: parsed, source }
  }
  return { state: emptyInstallState(), source: 'empty' }
}

/** Each write first preserves the current good state, so a torn write can always fall back one step. */
export function writeInstallState(root: string, state: InstallStateV1): void {
  const current = path.join(root, STATE_FILE)
  if (fs.existsSync(current) && parseInstallState(fs.readFileSync(current, 'utf8'))) {
    writeFileDurably(path.join(root, PREVIOUS_STATE_FILE), fs.readFileSync(current, 'utf8'))
  }
  writeFileDurably(current, `${JSON.stringify(state, null, 2)}\n`)
}
