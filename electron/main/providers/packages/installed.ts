import fs from 'node:fs'
import path from 'node:path'
import type { ProviderManifestV1 } from '../../../../src/provider-api/v1'
import { PACKAGE_DESCRIPTOR_PATH, PACKAGE_ENTRY_PATH, PACKAGE_SIGNATURE_PATH, packageError } from './format'
import type { InstalledPackageVersion } from './installState'
import { validateProviderPackage, type PackageValidationContext } from './validatePackage'
import type { PackageArchiveEntry } from './zipReader'

export interface VerifiedInstalledPackage {
  manifest: ProviderManifestV1
  providerRoot: string
  entryPath: string
}

function listTree(root: string, relative = ''): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...listTree(root, child))
    else if (entry.isFile()) files.push(child)
    else packageError(`Installed package contains a link or special file: ${child}`)
  }
  return files
}

/**
 * Re-verifies an installed version before its code runs: exactly the recorded
 * files (no additions, links, or special files), every hash and mode, the
 * manifest, platform, binaries, and the signature against the pinned key.
 */
export function verifyInstalledPackage(
  packageRoot: string,
  version: InstalledPackageVersion,
  context: PackageValidationContext,
): VerifiedInstalledPackage {
  const root = fs.realpathSync(packageRoot)
  const read = (relative: string): PackageArchiveEntry => {
    const filePath = path.join(root, ...relative.split('/'))
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) packageError(`Installed package file is not a regular file: ${relative}`)
    return { path: relative, mode: stat.mode & 0o7777, data: fs.readFileSync(filePath) }
  }
  const descriptor = read(PACKAGE_DESCRIPTOR_PATH)
  let payloadPaths: string[]
  try {
    payloadPaths = (JSON.parse(descriptor.data.toString('utf8')) as { files: Array<{ path: string }> }).files.map((file) => file.path)
  } catch {
    packageError('Installed package descriptor is unreadable')
  }
  const hasSignature = fs.existsSync(path.join(root, PACKAGE_SIGNATURE_PATH))
  const expected = [PACKAGE_DESCRIPTOR_PATH, ...(hasSignature ? [PACKAGE_SIGNATURE_PATH] : []), ...payloadPaths]
  const actual = listTree(root).sort()
  if (actual.join('\n') !== [...expected].sort().join('\n')) packageError('Installed package files differ from its descriptor')

  const validated = validateProviderPackage(expected.map(read), context)
  if ((validated.signature?.keyId ?? null) !== version.publisherKeyId) packageError('Installed package signature does not match the publisher recorded at install')
  if (validated.manifest.version !== version.version) packageError('Installed package version differs from the install record')
  return { manifest: validated.manifest, providerRoot: root, entryPath: path.join(root, ...PACKAGE_ENTRY_PATH.split('/')) }
}
