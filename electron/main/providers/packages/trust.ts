import { spawnSync } from 'node:child_process'
import { formatKeyFingerprint, type PackageSignature } from './signature'
import { packageError } from './format'

/** Puros first-party publisher keys shipped with the app (raw Ed25519, base64). */
export interface TrustedPublisherKey {
  keyId: string
  publicKey: string
  label: string
}

// Empty until the owner generates the first-party key with `npm run providers:keygen`
// and adds its public half here; the private key never enters the repository.
export const FIRST_PARTY_PUBLISHER_KEYS: readonly TrustedPublisherKey[] = []

export type NativeCodeSigning = 'none' | 'developer-id' | 'ad-hoc'

export type PackageTrustWarning =
  /** Always present: provider code runs with the user's privileges; utilityProcess is not a sandbox. */
  | 'runs-with-user-privileges'
  | 'unsigned-package'
  | 'new-publisher'
  | 'publisher-changed'
  | 'signed-to-unsigned'
  | 'native-code-not-notarized'
  | 'downgrade'
  | 'unordered-version'
  | 'same-version-different-content'

export interface PackageTrustVerdict {
  signature: 'first-party' | 'publisher' | 'unsigned'
  publisher: { keyId: string; fingerprint: string; label: string | null } | null
  nativeCode: NativeCodeSigning
  warnings: PackageTrustWarning[]
}

export interface PinnedPublisher {
  /** Key pinned by the currently installed version; null when that version was unsigned. */
  keyId: string | null
}

export type CodeSignatureInspector = (filePath: string) => 'developer-id' | 'platform-signed' | 'ad-hoc' | 'unsigned' | 'invalid'

/** Classifies a Mach-O's code signature with macOS `codesign`. */
export const inspectCodeSignature: CodeSignatureInspector = (filePath) => {
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', filePath], { encoding: 'utf8', timeout: 30_000 })
  const details = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', filePath], { encoding: 'utf8', timeout: 30_000 })
  const text = `${details.stdout ?? ''}${details.stderr ?? ''}`
  if (/not signed at all/.test(text)) return 'unsigned'
  if (verify.status !== 0) return 'invalid'
  if (/^Signature=adhoc$/m.test(text)) return 'ad-hoc'
  if (/^Authority=Developer ID Application:/m.test(text)) return 'developer-id'
  if (/^Authority=(?:macOS )?Software Signing$/m.test(text)) return 'platform-signed'
  // Other certificate chains (for example Apple Development) are not distributable identities.
  return 'ad-hoc'
}

/**
 * Checks every declared binary: each must carry a valid signature (macOS will
 * not run unsigned arm64 code); anything short of Developer ID is reported so
 * the consent screen can warn, per the owner-approved policy.
 */
export function classifyNativeCode(binaryPaths: string[], inspect: CodeSignatureInspector = inspectCodeSignature): NativeCodeSigning {
  if (binaryPaths.length === 0) return 'none'
  let result: NativeCodeSigning = 'developer-id'
  for (const binary of binaryPaths) {
    const state = inspect(binary)
    if (state === 'unsigned') packageError(`Native binary ${binary} has no code signature; sign it at least ad hoc (codesign --sign - <file>)`)
    if (state === 'invalid') packageError(`Native binary ${binary} has a broken code signature; the package was modified after signing`)
    if (state === 'ad-hoc') result = 'ad-hoc'
  }
  return result
}

export function evaluatePackageTrust(options: {
  signature: PackageSignature | null
  pinned: PinnedPublisher | null
  nativeCode: NativeCodeSigning
  versionRelation: 'new' | 'upgrade' | 'same' | 'replace' | 'downgrade' | 'unordered'
  trustedKeys?: readonly TrustedPublisherKey[]
}): PackageTrustVerdict {
  const trustedKeys = options.trustedKeys ?? FIRST_PARTY_PUBLISHER_KEYS
  const warnings: PackageTrustWarning[] = ['runs-with-user-privileges']
  const firstParty = options.signature
    ? trustedKeys.find((key) => key.keyId === options.signature!.keyId && key.publicKey === options.signature!.publicKey)
    : undefined
  if (!options.signature) warnings.push('unsigned-package')
  if (options.pinned === null) {
    if (options.signature && !firstParty) warnings.push('new-publisher')
  } else if (options.pinned.keyId !== null && !options.signature) {
    warnings.push('signed-to-unsigned')
  } else if (options.signature && options.pinned.keyId !== null && options.pinned.keyId !== options.signature.keyId) {
    // Not refused: refusal could be bypassed by shipping unsigned, so the user decides with a strong warning.
    warnings.push('publisher-changed')
  } else if (options.signature && options.pinned.keyId === null && !firstParty) {
    warnings.push('new-publisher')
  }
  if (options.nativeCode === 'ad-hoc') warnings.push('native-code-not-notarized')
  if (options.versionRelation === 'downgrade') warnings.push('downgrade')
  if (options.versionRelation === 'unordered') warnings.push('unordered-version')
  if (options.versionRelation === 'replace') warnings.push('same-version-different-content')
  return {
    signature: firstParty ? 'first-party' : options.signature ? 'publisher' : 'unsigned',
    publisher: options.signature
      ? { keyId: options.signature.keyId, fingerprint: formatKeyFingerprint(options.signature.keyId), label: firstParty?.label ?? null }
      : null,
    nativeCode: options.nativeCode,
    warnings,
  }
}

/**
 * Orders provider version strings by their leading numeric dot components
 * (`1.10.0` > `1.9.2`). Returns null when either lacks one, so the caller can
 * treat the relation as unknown rather than guessing.
 */
export function compareProviderVersions(left: string, right: string): number | null {
  const parse = (value: string) => value.match(/^v?(\d+(?:\.\d+)*)/)?.[1].split('.').map(Number) ?? null
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return null
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return left === right ? 0 : null
}
