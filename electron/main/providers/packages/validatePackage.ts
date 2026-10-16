import crypto from 'node:crypto'
import path from 'node:path'
import { API_VERSION, type ProviderManifestV1 } from '../../../../src/provider-api/v1'
import { validateProviderManifest } from '../validation'
import {
  MAX_METADATA_BYTES,
  MODE_EXECUTABLE,
  PACKAGE_DESCRIPTOR_PATH,
  PACKAGE_ENTRY_PATH,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_SIGNATURE_PATH,
  packageError,
} from './format'
import { machOArchitectures, nonSystemDylibs } from './macho'
import { verifyPackageSignature, type PackageSignature } from './signature'
import type { PackageArchiveEntry } from './zipReader'

export interface PackageDescriptorV1 {
  format: typeof PACKAGE_FORMAT
  formatVersion: typeof PACKAGE_FORMAT_VERSION
  provider: { id: string; version: string; apiVersion: number }
  manifest: typeof PACKAGE_MANIFEST_PATH
  entry: typeof PACKAGE_ENTRY_PATH
  platform: { os: 'darwin'; arch: string[] } | null
  toolchain: Record<string, string | null>
  files: Array<{ path: string; size: number; sha256: string; mode: '0644' | '0755' }>
}

export interface ValidatedPackage {
  descriptor: PackageDescriptorV1
  descriptorBytes: Buffer
  /** Exact `puros-provider.sig` bytes, kept so installed copies can be re-verified. */
  signatureBytes: Buffer | null
  manifest: ProviderManifestV1
  signature: PackageSignature | null
  /** Payload files (everything except descriptor and signature), in archive order. */
  files: PackageArchiveEntry[]
  /** Manifest-declared native binaries, as package-relative paths. */
  binaries: string[]
}

export interface PackageValidationContext {
  platform: NodeJS.Platform
  arch: string
  /** True in a packaged app: the development-only example fixture is then refused. */
  isPackaged: boolean
  /** Provider IDs compiled into the running build; importing one of them is refused. */
  bundledProviderIds: ReadonlySet<string>
}

const SUPPORTED_ARCHS = new Set(['arm64', 'x86_64'])
const PRIVATE_KEY_EXTENSIONS = new Set(['.key', '.p8', '.p12', '.pem'])
const PRIVATE_KEY_MARKERS = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'].map((kind) => `BEGIN ${kind}`)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    packageError(`${label} has missing or unknown fields`)
  }
}

function parseJson(entry: PackageArchiveEntry, label: string): unknown {
  if (entry.data.length > MAX_METADATA_BYTES) packageError(`${label} is too large`)
  try {
    return JSON.parse(entry.data.toString('utf8'))
  } catch {
    packageError(`${label} is not valid JSON`)
  }
}

function parseDescriptor(value: unknown): PackageDescriptorV1 {
  if (!isRecord(value)) packageError('Package descriptor must be an object')
  exactKeys(value, ['format', 'formatVersion', 'provider', 'manifest', 'entry', 'platform', 'toolchain', 'files'], 'Package descriptor')
  if (value.format !== PACKAGE_FORMAT || value.formatVersion !== PACKAGE_FORMAT_VERSION) {
    packageError(`Unsupported package format; this Puros reads ${PACKAGE_FORMAT} version ${PACKAGE_FORMAT_VERSION}`)
  }
  if (value.manifest !== PACKAGE_MANIFEST_PATH || value.entry !== PACKAGE_ENTRY_PATH) packageError('Package descriptor names a non-standard manifest or entry')
  const provider = value.provider
  if (!isRecord(provider)) packageError('Package descriptor provider must be an object')
  exactKeys(provider, ['id', 'version', 'apiVersion'], 'Package descriptor provider')
  if (typeof provider.id !== 'string' || typeof provider.version !== 'string' || typeof provider.apiVersion !== 'number') {
    packageError('Package descriptor provider fields have the wrong types')
  }
  const platform = value.platform
  if (platform !== null) {
    if (!isRecord(platform)) packageError('Package descriptor platform must be null or an object')
    exactKeys(platform, ['os', 'arch'], 'Package descriptor platform')
    if (platform.os !== 'darwin' || !Array.isArray(platform.arch) || platform.arch.length === 0
      || new Set(platform.arch).size !== platform.arch.length
      || platform.arch.some((arch) => typeof arch !== 'string' || !SUPPORTED_ARCHS.has(arch))) {
      packageError('Package descriptor platform is invalid')
    }
  }
  const toolchain = value.toolchain
  if (!isRecord(toolchain) || Object.entries(toolchain).some(([key, item]) => key.length > 32 || (item !== null && (typeof item !== 'string' || item.length > 100)))) {
    packageError('Package descriptor toolchain is invalid')
  }
  if (!Array.isArray(value.files)) packageError('Package descriptor files must be an array')
  for (const file of value.files) {
    if (!isRecord(file)) packageError('Package descriptor file record must be an object')
    exactKeys(file, ['path', 'size', 'sha256', 'mode'], 'Package descriptor file record')
    if (typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || (file.size as number) < 0
      || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
      || (file.mode !== '0644' && file.mode !== '0755')) {
      packageError('Package descriptor file record is invalid')
    }
  }
  return value as unknown as PackageDescriptorV1
}

function scanForSecrets(entry: PackageArchiveEntry): void {
  const baseName = path.posix.basename(entry.path).toLowerCase()
  if (baseName === '.env' || baseName.startsWith('.env.') || PRIVATE_KEY_EXTENSIONS.has(path.posix.extname(baseName))) {
    packageError(`Package contains a secret-bearing file name: ${entry.path}`)
  }
  if (PRIVATE_KEY_MARKERS.some((marker) => entry.data.includes(marker))) packageError(`Package contains private-key material in ${entry.path}`)
}

/**
 * Validates a read archive as a Puros provider package: signature (if any),
 * descriptor, exact file inventory and hashes, manifest, identity, platform,
 * native binaries, and secret hygiene. Throws ProviderPackageError on the first problem.
 */
export function validateProviderPackage(entries: PackageArchiveEntry[], context: PackageValidationContext): ValidatedPackage {
  const [descriptorEntry, ...rest] = entries
  if (!descriptorEntry || descriptorEntry.path !== PACKAGE_DESCRIPTOR_PATH) packageError(`The first package entry must be ${PACKAGE_DESCRIPTOR_PATH}`)
  const signatureEntry = rest[0]?.path === PACKAGE_SIGNATURE_PATH ? rest.shift()! : null
  if (rest.some((entry) => entry.path === PACKAGE_DESCRIPTOR_PATH || entry.path === PACKAGE_SIGNATURE_PATH)) {
    packageError('Package metadata entries are out of order')
  }
  const signature = signatureEntry ? verifyPackageSignature(signatureEntry.data, descriptorEntry.data) : null
  const descriptor = parseDescriptor(parseJson(descriptorEntry, 'Package descriptor'))

  // The descriptor must describe exactly the payload: same paths, order, sizes, modes, and SHA-256.
  if (descriptor.files.length !== rest.length) packageError('Package descriptor file list does not match the archive')
  for (const [index, entry] of rest.entries()) {
    const record = descriptor.files[index]
    if (record.path !== entry.path || record.size !== entry.data.length || Number.parseInt(record.mode, 8) !== entry.mode) {
      packageError(`Package descriptor disagrees with archive entry ${JSON.stringify(entry.path)}`)
    }
    if (crypto.createHash('sha256').update(entry.data).digest('hex') !== record.sha256) {
      packageError(`Package file ${JSON.stringify(entry.path)} does not match its recorded SHA-256`)
    }
    scanForSecrets(entry)
  }
  const byPath = new Map(rest.map((entry) => [entry.path, entry]))
  const manifestEntry = byPath.get(PACKAGE_MANIFEST_PATH)
  if (!manifestEntry) packageError('Package has no provider.manifest.json')
  if (!byPath.has(PACKAGE_ENTRY_PATH)) packageError('Package has no compiled entry dist/index.mjs')
  const validation = validateProviderManifest(parseJson(manifestEntry, 'Provider manifest'))
  if (!validation.ok) packageError(`Provider manifest is invalid: ${validation.errors.join('; ')}`)
  const manifest = validation.manifest
  if (manifest.id !== descriptor.provider.id || manifest.version !== descriptor.provider.version || manifest.apiVersion !== descriptor.provider.apiVersion) {
    packageError('Package descriptor and provider manifest disagree about identity or version')
  }
  if (manifest.apiVersion !== API_VERSION) packageError(`Provider targets API v${manifest.apiVersion}; this Puros supports v${API_VERSION}`)
  if (context.isPackaged && manifest.id === 'example') packageError('The example provider is a development fixture and cannot be installed')
  if (context.bundledProviderIds.has(manifest.id)) packageError(`Provider ${manifest.id} is built into this Puros and cannot also be installed`)

  if (!byPath.has(manifest.icon)) packageError(`Package is missing the manifest icon ${manifest.icon}`)
  for (const helper of manifest.permissions?.helpers ?? []) {
    const executable = byPath.get(helper.executable)
    if (!executable || executable.mode !== MODE_EXECUTABLE) packageError(`Helper ${helper.id} executable ${helper.executable} is missing or not executable`)
  }

  const resourcePrefix = `providers/${manifest.id}/`
  const binaries = (manifest.build?.binaries ?? []).map((binary) => {
    if (!binary.startsWith(resourcePrefix)) packageError(`Binary ${binary} is outside the provider's resource root`)
    return binary.slice(resourcePrefix.length)
  })
  if ((descriptor.platform === null) !== (binaries.length === 0)) packageError('Package platform does not match its declared native binaries')
  for (const binary of binaries) {
    const entry = byPath.get(binary)
    if (!entry || entry.mode !== MODE_EXECUTABLE) packageError(`Declared binary ${binary} is missing or not executable`)
    const archs = machOArchitectures(entry.data)
    if (!archs || descriptor.platform!.arch.some((arch) => !archs.includes(arch))) {
      packageError(`Declared binary ${binary} does not contain every architecture the package claims`)
    }
    const foreign = nonSystemDylibs(entry.data)
    if (foreign.length > 0) packageError(`Declared binary ${binary} links libraries outside macOS (${foreign[0]}) and would not run on another Mac`)
  }
  if (descriptor.platform) {
    const arch = context.arch === 'x64' ? 'x86_64' : context.arch
    if (context.platform !== 'darwin' || !descriptor.platform.arch.includes(arch)) {
      packageError(`Package is built for ${descriptor.platform.os}/${descriptor.platform.arch.join('+')} and cannot run on this Mac (${context.platform}/${arch})`)
    }
  }
  return { descriptor, descriptorBytes: descriptorEntry.data, signatureBytes: signatureEntry?.data ?? null, manifest, signature, files: rest, binaries }
}
