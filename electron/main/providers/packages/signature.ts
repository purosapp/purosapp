import crypto from 'node:crypto'
import { MAX_METADATA_BYTES, PACKAGE_SIGNATURE_FORMAT, packageError } from './format'

// DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface PackageSignature {
  keyId: string
  publicKey: string
}

/** Stable publisher identifier: the first 16 bytes of SHA-256 over the raw public key, hex. */
export function publisherKeyId(rawPublicKey: Buffer): string {
  return crypto.createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 32)
}

/** Human-comparable fingerprint shown in the consent screen, e.g. `3F2A 9C01 …`. */
export function formatKeyFingerprint(keyId: string): string {
  return keyId.toUpperCase().match(/.{1,4}/g)!.join(' ')
}

function decodeBase64(value: unknown, bytes: number, label: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) packageError(`Package signature ${label} is not base64`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== bytes || decoded.toString('base64') !== value) packageError(`Package signature ${label} has the wrong length`)
  return decoded
}

/**
 * Verifies `puros-provider.sig` against the exact descriptor bytes. A present
 * but invalid signature is always fatal: it means the package was altered.
 */
export function verifyPackageSignature(signatureBytes: Buffer, descriptorBytes: Buffer): PackageSignature {
  if (signatureBytes.length > MAX_METADATA_BYTES) packageError('Package signature is too large')
  let parsed: unknown
  try {
    parsed = JSON.parse(signatureBytes.toString('utf8'))
  } catch {
    packageError('Package signature is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) packageError('Package signature must be an object')
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (keys !== 'algorithm,format,formatVersion,publicKey,signature') packageError('Package signature has missing or unknown fields')
  if (record.format !== PACKAGE_SIGNATURE_FORMAT || record.formatVersion !== 1 || record.algorithm !== 'ed25519') {
    packageError('Package signature format or algorithm is unsupported')
  }
  const rawPublicKey = decodeBase64(record.publicKey, 32, 'public key')
  const signature = decodeBase64(record.signature, 64, 'value')
  const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]), format: 'der', type: 'spki' })
  if (!crypto.verify(null, descriptorBytes, key, signature)) packageError('Package signature does not match its contents; the package was modified after signing')
  return { keyId: publisherKeyId(rawPublicKey), publicKey: record.publicKey as string }
}
