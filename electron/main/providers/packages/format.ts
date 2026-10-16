/**
 * Provider package format v1, as written by `scripts/provider-package.mjs`.
 * A test keeps these values identical to the packer's.
 */
export const PACKAGE_FORMAT = 'puros-provider-package'
export const PACKAGE_FORMAT_VERSION = 1
export const PACKAGE_DESCRIPTOR_PATH = 'puros-provider.json'
export const PACKAGE_SIGNATURE_PATH = 'puros-provider.sig'
export const PACKAGE_SIGNATURE_FORMAT = 'puros-provider-signature'
export const PACKAGE_MANIFEST_PATH = 'provider.manifest.json'
export const PACKAGE_ENTRY_PATH = 'dist/index.mjs'

export const PACKAGE_LIMITS = Object.freeze({
  maxEntries: 4_096,
  maxPathBytes: 240,
  maxPathDepth: 16,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
})

/** Metadata files are parsed as JSON and must stay small. */
export const MAX_METADATA_BYTES = 1024 * 1024
/** Stored entries are not larger than their data, so the archive cannot exceed this. */
export const MAX_ARCHIVE_BYTES = PACKAGE_LIMITS.maxTotalBytes + 64 * 1024 * 1024

export const MODE_FILE = 0o644
export const MODE_EXECUTABLE = 0o755

export class ProviderPackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderPackageError'
  }
}

export function packageError(message: string): never {
  throw new ProviderPackageError(message)
}

/** Same rules as the packer: NFC, bounded, relative, no dot segments or separators that APFS/Windows reinterpret. */
export function validatePackagePath(value: string): string | null {
  if (value.length === 0) return 'empty path'
  if (value !== value.normalize('NFC')) return 'path is not NFC-normalized'
  if (Buffer.byteLength(value, 'utf8') > PACKAGE_LIMITS.maxPathBytes) return 'path is too long'
  if (/[\u0000-\u001f\u007f\\:]/.test(value)) return 'path contains a control character, backslash or colon'
  const segments = value.split('/')
  if (segments.length > PACKAGE_LIMITS.maxPathDepth) return 'path is too deep'
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'path has an empty, "." or ".." segment'
  return null
}
