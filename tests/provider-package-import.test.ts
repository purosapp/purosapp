import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import * as packer from '../scripts/provider-package.mjs'
import { discoverProviders } from '../scripts/providers.mjs'
import * as format from '../electron/main/providers/packages/format'
import { ProviderPackageInstaller } from '../electron/main/providers/packages/installer'
import { PREVIOUS_STATE_FILE, STATE_FILE } from '../electron/main/providers/packages/installState'
import type { CodeSignatureInspector } from '../electron/main/providers/packages/trust'
import { validateProviderPackage, type PackageValidationContext } from '../electron/main/providers/packages/validatePackage'
import { readPackageArchive } from '../electron/main/providers/packages/zipReader'
import { verifyInstalledPackage } from '../electron/main/providers/packages/installed'
import { ProviderPackageService } from '../electron/main/providers/packages/service'
import type { ProviderDefinition } from '../electron/main/providers/loader'
import { ProviderRegistry } from '../electron/main/providers/registry'

const temporaryRoots: string[] = []
function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `puros-import-${label}-`))
  temporaryRoots.push(directory)
  return directory
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const context: PackageValidationContext = { platform: 'darwin', arch: 'arm64', isPackaged: true, bundledProviderIds: new Set() }
const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex')

type Entry = { path: string; data: Buffer; mode: number }

function machO(dylib?: string, cpuType = 0x0100000c): Buffer {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpuType, 4)
  if (!dylib) return header
  header.writeUInt32LE(1, 16)
  const command = Buffer.alloc(24 + Math.ceil((dylib.length + 1) / 8) * 8)
  command.writeUInt32LE(0xc, 0)
  command.writeUInt32LE(command.length, 4)
  command.writeUInt32LE(24, 8)
  command.write(`${dylib}\0`, 24)
  return Buffer.concat([header, command])
}

function generateKey(): string {
  const file = path.join(temporaryDirectory('key'), 'publisher.pem')
  fs.writeFileSync(file, crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  return file
}

interface FixtureOptions {
  id?: string
  version?: string
  extraFiles?: Entry[]
  manifest?: Record<string, unknown>
  descriptor?: (descriptor: Record<string, unknown>) => void
  platform?: { os: string; arch: string[] } | null
  signingKey?: string
  mutateEntries?: (entries: Entry[]) => void
}

/** Builds a package the way the packer does (same ZIP writer), with optional deliberate defects. */
function buildPackage(options: FixtureOptions = {}): Buffer {
  const id = options.id ?? 'demo'
  const manifest = {
    schemaVersion: 1, apiVersion: 1, id, version: options.version ?? '1.0.0', displayName: 'Demo',
    icon: 'assets/icon.svg', brandColor: '#123456', defaultPriority: 5, capabilities: [],
    ...options.manifest,
  }
  const entries: Entry[] = [
    { path: 'assets/icon.svg', data: Buffer.from('<svg/>\n'), mode: 0o644 },
    { path: 'dist/index.mjs', data: Buffer.from('export default {}\n'), mode: 0o644 },
    { path: 'provider.manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 },
    ...(options.extraFiles ?? []),
  ].sort((left, right) => (left.path < right.path ? -1 : 1))
  const descriptor: Record<string, unknown> = {
    format: 'puros-provider-package', formatVersion: 1,
    provider: { id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion },
    manifest: 'provider.manifest.json', entry: 'dist/index.mjs',
    platform: options.platform ?? null,
    toolchain: { vite: 'test', rolldown: null, zlib: 'test' },
    files: entries.map((entry) => ({ path: entry.path, size: entry.data.length, sha256: sha256(entry.data), mode: entry.mode === 0o755 ? '0755' : '0644' })),
  }
  options.descriptor?.(descriptor)
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
  const all: Entry[] = [
    { path: 'puros-provider.json', data: descriptorBytes, mode: 0o644 },
    ...(options.signingKey ? [{ path: 'puros-provider.sig', data: packer.signDescriptor(descriptorBytes, options.signingKey), mode: 0o644 }] : []),
    ...entries,
  ]
  options.mutateEntries?.(all)
  return packer.createDeterministicZip(all)
}

const validate = (archive: Buffer, overrides: Partial<PackageValidationContext> = {}) => validateProviderPackage(readPackageArchive(archive), { ...context, ...overrides })

/** Offsets of each entry's local and central headers in a packer-written archive. */
function headers(archive: Buffer): Array<{ local: number; central: number }> {
  const end = archive.length - 22
  let central = archive.readUInt32LE(end + 16)
  const result = []
  for (let index = 0; index < archive.readUInt16LE(end + 10); index += 1) {
    result.push({ local: archive.readUInt32LE(central + 42), central })
    central += 46 + archive.readUInt16LE(central + 28)
  }
  return result
}

function patched(archive: Buffer, patch: (copy: Buffer, offsets: ReturnType<typeof headers>) => void): Buffer {
  const copy = Buffer.from(archive)
  patch(copy, headers(copy))
  return copy
}

describe('package format parity', () => {
  it('uses exactly the packer constants', () => {
    expect(format.PACKAGE_LIMITS).toEqual(packer.PACKAGE_LIMITS)
    expect([format.PACKAGE_FORMAT, format.PACKAGE_FORMAT_VERSION, format.PACKAGE_DESCRIPTOR_PATH, format.PACKAGE_SIGNATURE_PATH, format.PACKAGE_MANIFEST_PATH, format.PACKAGE_ENTRY_PATH])
      .toEqual([packer.PACKAGE_FORMAT, packer.PACKAGE_FORMAT_VERSION, packer.PACKAGE_DESCRIPTOR_PATH, packer.PACKAGE_SIGNATURE_PATH, packer.PACKAGE_MANIFEST_PATH, packer.PACKAGE_ENTRY_PATH])
    for (const sample of ['a/b', '../x', 'a//b', 'x\\y', 'é', 'ok.json']) {
      expect(format.validatePackagePath(sample)).toBe(packer.validatePackagePath(sample))
    }
  })

  it('accepts the real example package unsigned and signed, reproducibly', async () => {
    const example = discoverProviders().find(({ manifest }) => manifest.id === 'example')!
    const unsigned = await packer.packProvider(example, { skipBuild: true, outputRoot: temporaryDirectory('out') })
    expect(validate(fs.readFileSync(unsigned.zipPath), { isPackaged: false }).signature).toBeNull()
    const key = generateKey()
    const signedA = await packer.packProvider(example, { skipBuild: true, outputRoot: temporaryDirectory('out'), signingKeyPath: key })
    const signedB = await packer.packProvider(example, { skipBuild: true, outputRoot: temporaryDirectory('out'), signingKeyPath: key })
    const bytes = fs.readFileSync(signedA.zipPath)
    expect(fs.readFileSync(signedB.zipPath).equals(bytes)).toBe(true)
    const validated = validate(bytes, { isPackaged: false })
    expect(validated.signature?.keyId).toMatch(/^[0-9a-f]{32}$/)
    expect(validated.manifest).toEqual(example.manifest)
    expect(() => validate(bytes)).toThrow('development fixture')
  }, 60_000)

  it('refuses to sign with a key stored inside the repository', () => {
    expect(() => packer.signDescriptor(Buffer.from('{}'), path.join(process.cwd(), 'key.pem'))).toThrow('outside the repository')
  })
})

describe('strict ZIP reader', () => {
  const valid = buildPackage()

  it('accepts a packer-written package', () => {
    expect(readPackageArchive(valid).map((entry) => entry.path)).toEqual(['puros-provider.json', 'assets/icon.svg', 'dist/index.mjs', 'provider.manifest.json'])
  })

  const corpus: Array<[string, () => Buffer, string]> = [
    ['empty input', () => Buffer.alloc(0), 'not a ZIP'],
    ['archive comment', () => {
      const copy = Buffer.concat([valid, Buffer.from('hi')])
      copy.writeUInt16LE(2, valid.length - 2)
      return copy
    }, 'end record'],
    ['traversal path', () => buildPackage({ mutateEntries: (entries) => { entries.push({ path: '../evil', data: Buffer.from('x'), mode: 0o644 }) } }), 'unsafe path'],
    ['absolute path', () => buildPackage({ mutateEntries: (entries) => { entries.push({ path: '/etc/evil', data: Buffer.from('x'), mode: 0o644 }) } }), 'unsafe path'],
    ['backslash path', () => buildPackage({ mutateEntries: (entries) => { entries.push({ path: 'a\\..\\b', data: Buffer.from('x'), mode: 0o644 }) } }), 'unsafe path'],
    ['directory entry', () => buildPackage({ mutateEntries: (entries) => { entries.push({ path: 'dir/', data: Buffer.alloc(0), mode: 0o755 }) } }), 'unsafe path'],
    ['duplicate name', () => buildPackage({ mutateEntries: (entries) => { entries.push({ ...entries[1] }) } }), 'duplicated'],
    ['case-insensitive duplicate', () => buildPackage({ mutateEntries: (entries) => { entries.push({ path: 'ASSETS/icon.svg', data: Buffer.from('x'), mode: 0o644 }) } }), 'case-insensitively'],
    ['symlink mode', () => patched(valid, (copy, [, icon]) => { copy.writeUInt32LE(((0o120777) << 16) >>> 0, icon.central + 38) }), 'regular file'],
    ['setuid mode', () => patched(valid, (copy, [, icon]) => { copy.writeUInt32LE(((0o104755) << 16) >>> 0, icon.central + 38) }), 'regular file'],
    ['encryption flag', () => patched(valid, (copy, [first]) => { copy.writeUInt16LE(0x0801, first.central + 8); copy.writeUInt16LE(0x0801, first.local + 6) }), 'flags'],
    ['data descriptor flag', () => patched(valid, (copy, [first]) => { copy.writeUInt16LE(0x0808, first.central + 8); copy.writeUInt16LE(0x0808, first.local + 6) }), 'flags'],
    ['unsupported method', () => patched(valid, (copy, [first]) => { copy.writeUInt16LE(12, first.central + 10); copy.writeUInt16LE(12, first.local + 8) }), 'compression method'],
    ['CRC mismatch', () => patched(valid, (copy, [first]) => { copy.writeUInt32LE(1, first.central + 16); copy.writeUInt32LE(1, first.local + 14) }), 'CRC-32'],
    ['local/central disagreement', () => patched(valid, (copy, [first]) => { copy.writeUInt32LE(1, first.local + 14) }), 'disagrees'],
    ['overlapping entries', () => patched(valid, (copy, [first, second]) => { copy.writeUInt32LE(first.local, second.central + 42) }), 'contiguous'],
    ['declared size larger than data', () => patched(valid, (copy, [first]) => {
      const size = copy.readUInt32LE(first.central + 24) + 10
      copy.writeUInt32LE(size, first.central + 24)
      copy.writeUInt32LE(size, first.local + 22)
    }), 'size or CRC'],
    ['non-UTF-8 name', () => patched(valid, (copy, [, icon]) => {
      copy[icon.central + 46] = 0xff
      copy[icon.local + 30] = 0xff
    }), 'UTF-8'],
    ['too many entries', () => patched(valid, (copy) => { copy.writeUInt16LE(0xffff, copy.length - 12); copy.writeUInt16LE(0xffff, copy.length - 14) }), 'too many entries'],
    ['NUL in a name', () => buildPackage({ mutateEntries: (entries) => { entries.push({ path: 'a\u0000b', data: Buffer.from('x'), mode: 0o644 }) } }), 'unsafe path'],
    ['ZIP64 locator', () => {
      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(0x07064b50, 0)
      const end = valid.subarray(valid.length - 22)
      return Buffer.concat([valid.subarray(0, valid.length - 22), locator, end])
    }, 'ZIP64'],
    ['hidden bytes between entries', () => {
      const [, second] = headers(valid)
      const gapped = Buffer.concat([valid.subarray(0, second.local), Buffer.from('HIDDEN'), valid.subarray(second.local)])
      // Shift every later offset so only the gap itself is wrong.
      const end = gapped.length - 22
      gapped.writeUInt32LE(gapped.readUInt32LE(end + 16) + 6, end + 16)
      let central = gapped.readUInt32LE(end + 16)
      for (let index = 0; index < gapped.readUInt16LE(end + 10); index += 1) {
        const local = gapped.readUInt32LE(central + 42)
        if (local >= second.local) gapped.writeUInt32LE(local + 6, central + 42)
        central += 46 + gapped.readUInt16LE(central + 28)
      }
      return gapped
    }, 'not contiguous'],
  ]
  for (const [name, build, message] of corpus) {
    it(`rejects ${name}`, () => {
      expect(() => readPackageArchive(build())).toThrow(message)
    })
  }

  it('bounds a compression bomb by the declared size', () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(16 * 1024 * 1024), { level: 9 })
    const name = Buffer.from('bomb.bin')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(bomb.length, 18)
    local.writeUInt32LE(100, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(bomb.length, 20)
    central.writeUInt32LE(100, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((0o100644) << 16) >>> 0, 38)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(1, 8)
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(46 + name.length, 12)
    end.writeUInt32LE(30 + name.length + bomb.length, 16)
    expect(() => readPackageArchive(Buffer.concat([local, name, bomb, central, name, end]))).toThrow('corrupt or oversized')
  })
})

describe('package validation', () => {
  const cases: Array<[string, FixtureOptions, string, Partial<PackageValidationContext>?]> = [
    ['unknown descriptor field', { descriptor: (d) => { d.extra = true } }, 'missing or unknown fields'],
    ['newer package format', { descriptor: (d) => { d.formatVersion = 2 } }, 'Unsupported package format'],
    ['tampered file', { mutateEntries: (entries) => { entries[1] = { ...entries[1], data: Buffer.from('<svg>evil</svg>') } } }, 'disagrees'],
    ['hash mismatch', { descriptor: (d) => { (d.files as Array<{ sha256: string }>)[0].sha256 = '0'.repeat(64) } }, 'recorded SHA-256'],
    ['undeclared extra file', { mutateEntries: (entries) => { entries.push({ path: 'zz.txt', data: Buffer.from('x'), mode: 0o644 }) } }, 'file list does not match'],
    ['identity mismatch', { descriptor: (d) => { (d.provider as { id: string }).id = 'other' } }, 'disagree'],
    ['future API version', { manifest: { apiVersion: 2 }, descriptor: (d) => { (d.provider as { apiVersion: number }).apiVersion = 2 } }, 'manifest is invalid'],
    ['reserved local ID', { id: 'local' }, 'manifest is invalid'],
    ['reserved m3u ID', { id: 'm3u' }, 'manifest is invalid'],
    ['bundled provider ID', { id: 'tidal' }, 'built into this Puros', { bundledProviderIds: new Set(['tidal']) }],
    ['dotenv file', { extraFiles: [{ path: 'config/.env', data: Buffer.from('A=1'), mode: 0o644 }] }, 'secret-bearing'],
    ['private key marker', { extraFiles: [{ path: 'notes.txt', data: Buffer.from(`-----BEGIN ${'PRIVATE KEY'}-----`), mode: 0o644 }] }, 'private-key material'],
    ['missing icon', { manifest: { icon: 'assets/missing.svg' } }, 'manifest icon'],
    ['non-executable helper', {
      manifest: { permissions: { helpers: [{ id: 'bridge', executable: 'helper/run.sh' }] } },
      extraFiles: [{ path: 'helper/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o644 }],
    }, 'not executable'],
    ['binary linking Homebrew', {
      manifest: { build: { binaries: ['providers/demo/bin/tool'] } }, platform: { os: 'darwin', arch: ['arm64'] },
      extraFiles: [{ path: 'bin/tool', data: machO('/opt/homebrew/lib/libx.dylib'), mode: 0o755 }],
    }, 'outside macOS'],
    ['platform claim beyond the binary', {
      manifest: { build: { binaries: ['providers/demo/bin/tool'] } }, platform: { os: 'darwin', arch: ['arm64', 'x86_64'] },
      extraFiles: [{ path: 'bin/tool', data: machO(), mode: 0o755 }],
    }, 'every architecture'],
    ['wrong CPU architecture', {
      manifest: { build: { binaries: ['providers/demo/bin/tool'] } }, platform: { os: 'darwin', arch: ['x86_64'] },
      extraFiles: [{ path: 'bin/tool', data: machO(undefined, 0x01000007), mode: 0o755 }],
    }, 'cannot run on this Mac'],
  ]
  for (const [name, options, message, overrides] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => validate(buildPackage(options), overrides)).toThrow(message)
    })
  }

  it('rejects signatures that do not match the descriptor', () => {
    const key = generateKey()
    const signed = buildPackage({ signingKey: key })
    expect(validate(signed).signature).not.toBeNull()
    const otherDescriptor = buildPackage({ signingKey: key, mutateEntries: (entries) => {
      entries[0] = { ...entries[0], data: Buffer.from(entries[0].data.toString('utf8').replace('"test"', '"TEST"')) }
    } })
    expect(() => validate(otherDescriptor)).toThrow('modified after signing')
  })

  it('accepts a portable binary for this Mac', () => {
    const validated = validate(buildPackage({
      manifest: { build: { binaries: ['providers/demo/bin/tool'] } }, platform: { os: 'darwin', arch: ['arm64'] },
      extraFiles: [{ path: 'bin/tool', data: machO('/usr/lib/libSystem.B.dylib'), mode: 0o755 }],
    }))
    expect(validated.binaries).toEqual(['bin/tool'])
  })
})

describe('provider package installer', () => {
  function setup(inspect: CodeSignatureInspector = () => 'ad-hoc') {
    const userData = temporaryDirectory('userdata')
    const root = path.join(userData, 'provider-packages')
    const dataRoot = path.join(userData, 'providers', 'demo')
    fs.mkdirSync(dataRoot, { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'state.json'), '{"keep":true}')
    let clock = 1_000
    const installer = new ProviderPackageInstaller({ root, context, inspectCodeSignature: inspect, trustedKeys: [], now: () => clock })
    const write = (archive: Buffer) => {
      const file = path.join(temporaryDirectory('zip'), 'package.zip')
      fs.writeFileSync(file, archive)
      return file
    }
    const install = (archive: Buffer) => {
      const summary = installer.inspect(write(archive))
      return { summary, result: installer.commit(summary.token, summary.trust.warnings) }
    }
    return { installer, root, dataRoot, write, install, advance: (ms: number) => { clock += ms } }
  }

  it('installs only after every warning is accepted, with exact files and modes', () => {
    const { installer, root, write } = setup()
    const summary = installer.inspect(write(buildPackage({
      manifest: { permissions: { helpers: [{ id: 'bridge', executable: 'helper/run.sh' }], networkOrigins: ['https://api.example.com'] } },
      extraFiles: [{ path: 'helper/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 }],
    })))
    expect(summary).toMatchObject({ providerId: 'demo', relation: 'new', installedVersion: null })
    expect(summary.permissions).toMatchObject({ networkOrigins: ['https://api.example.com'], helpers: [{ id: 'bridge', executable: 'helper/run.sh' }] })
    expect(summary.trust.warnings).toEqual(['runs-with-user-privileges', 'unsigned-package'])
    expect(() => installer.commit(summary.token, ['runs-with-user-privileges'])).toThrow('requires accepting: unsigned-package')
    expect(installer.list()).toEqual({})
    const result = installer.commit(summary.token, summary.trust.warnings)
    expect(result.status).toBe('installed')
    const packageRoot = installer.activePackageRoot('demo')!
    expect(packageRoot).toBe(path.join(root, 'packages', 'demo', result.active.directory))
    expect(fs.statSync(path.join(packageRoot, 'helper', 'run.sh')).mode & 0o7777).toBe(0o755)
    expect(fs.statSync(path.join(packageRoot, 'dist', 'index.mjs')).mode & 0o7777).toBe(0o644)
    expect(fs.readdirSync(path.join(root, '.staging'))).toEqual([])
    expect(installer.list().demo).toMatchObject({ enabled: true, previous: null, active: { version: '1.0.0', publisherKeyId: null } })
    expect(() => installer.commit(summary.token, summary.trust.warnings)).toThrow('expired or was already used')
  })

  it('handles same, upgrade, downgrade with warning, and rollback while keeping provider data', () => {
    const { installer, root, dataRoot, write, install } = setup()
    const v1 = buildPackage({ version: '1.0.0' })
    install(v1)
    const same = installer.inspect(write(v1))
    expect(same.relation).toBe('same')
    expect(installer.commit(same.token, same.trust.warnings).status).toBe('already-installed')

    const upgrade = install(buildPackage({ version: '1.2.0' }))
    expect(upgrade.summary.relation).toBe('upgrade')
    expect(upgrade.result.previous?.version).toBe('1.0.0')

    const downgrade = installer.inspect(write(buildPackage({ version: '1.1.0' })))
    expect(downgrade.relation).toBe('downgrade')
    expect(downgrade.trust.warnings).toContain('downgrade')
    expect(() => installer.commit(downgrade.token, downgrade.trust.warnings.filter((warning) => warning !== 'downgrade'))).toThrow('downgrade')
    const reInspect = installer.inspect(write(buildPackage({ version: '1.1.0' })))
    installer.commit(reInspect.token, reInspect.trust.warnings)
    expect(installer.list().demo).toMatchObject({ active: { version: '1.1.0' }, previous: { version: '1.2.0' } })
    // Only active and previous versions stay on disk.
    expect(fs.readdirSync(path.join(root, 'packages', 'demo')).sort()).toEqual(
      [installer.list().demo.active.directory, installer.list().demo.previous!.directory].sort(),
    )

    expect(installer.rollback('demo')?.version).toBe('1.2.0')
    expect(installer.list().demo.previous).toBeNull()
    expect(installer.rollback('demo')).toBeNull()
    expect(installer.list()).toEqual({})
    expect(fs.existsSync(path.join(root, 'packages', 'demo'))).toBe(false)
    expect(fs.readFileSync(path.join(dataRoot, 'state.json'), 'utf8')).toBe('{"keep":true}')
  })

  it('pins publishers and warns when the key changes or the signature disappears', () => {
    const { installer, write, install } = setup()
    const keyA = generateKey()
    install(buildPackage({ version: '1.0.0', signingKey: keyA }))
    expect(installer.list().demo.active.publisherKeyId).toMatch(/^[0-9a-f]{32}$/)
    expect(installer.inspect(write(buildPackage({ version: '1.1.0', signingKey: keyA }))).trust.warnings).toEqual(['runs-with-user-privileges'])
    expect(installer.inspect(write(buildPackage({ version: '1.1.0', signingKey: generateKey() }))).trust.warnings).toContain('publisher-changed')
    expect(installer.inspect(write(buildPackage({ version: '1.1.0' }))).trust.warnings).toContain('signed-to-unsigned')
  })

  it('warns about ad-hoc native code and refuses unsigned native code without leaving staging behind', () => {
    const nativePackage = buildPackage({
      manifest: { build: { binaries: ['providers/demo/bin/tool'] } }, platform: { os: 'darwin', arch: ['arm64'] },
      extraFiles: [{ path: 'bin/tool', data: machO(), mode: 0o755 }],
    })
    const adHoc = setup(() => 'ad-hoc')
    expect(adHoc.installer.inspect(adHoc.write(nativePackage)).trust).toMatchObject({ nativeCode: 'ad-hoc' })
    expect(adHoc.installer.inspect(adHoc.write(nativePackage)).trust.warnings).toContain('native-code-not-notarized')
    const developerId = setup(() => 'developer-id')
    expect(developerId.installer.inspect(developerId.write(nativePackage)).trust.warnings).not.toContain('native-code-not-notarized')
    const unsigned = setup(() => 'unsigned')
    expect(() => unsigned.installer.inspect(unsigned.write(nativePackage))).toThrow('no code signature')
    expect(fs.readdirSync(path.join(unsigned.root, '.staging'))).toEqual([])
  })

  it('leaves state untouched when a package is rejected, expires inspections, and refuses stale commits', () => {
    const { installer, root, write, install, advance } = setup()
    expect(() => installer.inspect(write(Buffer.from('not a zip at all, definitely')))).toThrow()
    expect(fs.existsSync(path.join(root, STATE_FILE))).toBe(false)
    const stale = installer.inspect(write(buildPackage({ version: '2.0.0' })))
    advance(31 * 60_000)
    expect(() => installer.commit(stale.token, stale.trust.warnings)).toThrow('expired')
    expect(fs.readdirSync(path.join(root, '.staging'))).toEqual([])

    const first = installer.inspect(write(buildPackage({ version: '3.0.0' })))
    install(buildPackage({ version: '3.1.0' }))
    expect(() => installer.commit(first.token, first.trust.warnings)).toThrow('changed since this package was inspected')
    expect(installer.list().demo.active.version).toBe('3.1.0')
  })

  it('recovers from a crash at each install step and from a corrupt state file', () => {
    const { installer, root, write, install } = setup()
    install(buildPackage({ version: '1.0.0' }))
    install(buildPackage({ version: '1.1.0' }))
    // Crash after staging: leftovers are removed.
    installer.inspect(write(buildPackage({ version: '1.2.0' })))
    // Crash after the directory rename but before the state write: an unreferenced version dir.
    const orphan = path.join(root, 'packages', 'demo', '9.9.9-deadbeefcafe')
    fs.mkdirSync(orphan)
    fs.writeFileSync(path.join(orphan, 'puros-provider.json'), '{}')
    const recovered = new ProviderPackageInstaller({ root, context, inspectCodeSignature: () => 'ad-hoc', trustedKeys: [] })
    expect(recovered.recover()).toMatchObject({ stateSource: 'current', repairedProviders: [] })
    expect(fs.existsSync(orphan)).toBe(false)
    expect(fs.readdirSync(path.join(root, '.staging'))).toEqual([])
    expect(recovered.list().demo.active.version).toBe('1.1.0')

    // A torn/corrupt current state falls back to the previous good copy.
    fs.writeFileSync(path.join(root, STATE_FILE), '{"formatVersion":1,"providers":')
    expect(recovered.recover().stateSource).toBe('previous')
    expect(recovered.list().demo.active.version).toBe('1.0.0')
    expect(JSON.parse(fs.readFileSync(path.join(root, PREVIOUS_STATE_FILE), 'utf8')).providers.demo.active.version).toBe('1.0.0')

    // A missing active directory falls back to the previous version when one exists.
    install(buildPackage({ version: '2.0.0' }))
    fs.rmSync(recovered.activePackageRoot('demo')!, { recursive: true })
    expect(recovered.recover().repairedProviders).toEqual(['demo'])
    expect(recovered.list().demo.active.version).toBe('1.0.0')
  })
})

describe('installed package re-verification', () => {
  function installed(options: FixtureOptions = {}) {
    const root = temporaryDirectory('installed')
    const installer = new ProviderPackageInstaller({ root, context, inspectCodeSignature: () => 'ad-hoc', trustedKeys: [] })
    const file = path.join(temporaryDirectory('zip'), 'p.zip')
    fs.writeFileSync(file, buildPackage(options))
    const summary = installer.inspect(file)
    installer.commit(summary.token, summary.trust.warnings)
    return { installer, packageRoot: installer.activePackageRoot('demo')!, record: installer.list().demo.active }
  }

  it('accepts an untouched install and returns its entry', () => {
    const { packageRoot, record } = installed({ signingKey: generateKey() })
    const verified = verifyInstalledPackage(packageRoot, record, context)
    expect(verified.entryPath).toBe(path.join(fs.realpathSync(packageRoot), 'dist', 'index.mjs'))
    expect(verified.manifest.id).toBe('demo')
  })

  it('refuses modified, added, linked files and a signature swapped after install', () => {
    const modified = installed()
    const entry = path.join(modified.packageRoot, 'dist', 'index.mjs')
    const code = fs.readFileSync(entry)
    code[0] = code[0] === 0x65 ? 0x66 : 0x65
    fs.writeFileSync(entry, code)
    expect(() => verifyInstalledPackage(modified.packageRoot, modified.record, context)).toThrow('recorded SHA-256')

    const added = installed()
    fs.writeFileSync(path.join(added.packageRoot, 'dist', 'extra.mjs'), 'x')
    expect(() => verifyInstalledPackage(added.packageRoot, added.record, context)).toThrow('differ from its descriptor')

    const linked = installed()
    fs.symlinkSync('/etc/hosts', path.join(linked.packageRoot, 'assets', 'hosts'))
    expect(() => verifyInstalledPackage(linked.packageRoot, linked.record, context)).toThrow('link or special file')

    const resigned = installed({ signingKey: generateKey() })
    expect(() => verifyInstalledPackage(resigned.packageRoot, { ...resigned.record, publisherKeyId: 'f'.repeat(32) }, context)).toThrow('publisher recorded at install')
  })
})

describe('installed provider service (hot install/update/enable/remove)', () => {
  function setup(failingVersions: string[] = []) {
    const userData = temporaryDirectory('service')
    const root = path.join(userData, 'provider-packages')
    const dataFile = path.join(userData, 'providers', 'demo', 'data.json')
    fs.mkdirSync(path.dirname(dataFile), { recursive: true })
    fs.writeFileSync(dataFile, 'keep')
    const registry = new ProviderRegistry()
    const started: string[] = []
    const start = async (definition: ProviderDefinition, target: ProviderRegistry) => {
      target.addManifest(definition.manifest, definition.providerRoot)
      if (failingVersions.includes(definition.manifest.version)) {
        target.markError(definition.manifest.id, new Error(`activation of ${definition.manifest.version} failed`))
        throw new Error(`activation of ${definition.manifest.version} failed`)
      }
      started.push(`${definition.manifest.id}@${definition.manifest.version}:${definition.origin}:${path.basename(definition.entryPath!)}`)
      target.updateStatus(definition.manifest.id, { state: 'ready', updatedAt: 1 })
    }
    const installer = new ProviderPackageInstaller({ root, context, inspectCodeSignature: () => 'ad-hoc', trustedKeys: [] })
    const service = new ProviderPackageService(registry, { root, context, installer, start })
    const install = async (archive: Buffer) => {
      const file = path.join(temporaryDirectory('zip'), 'p.zip')
      fs.writeFileSync(file, archive)
      const summary = service.inspect(file)
      return service.install(summary.token, summary.trust.warnings)
    }
    return { registry, service, started, install, dataFile, root }
  }

  it('installs, updates in place, and rolls back to the previous version when activation fails', async () => {
    const { registry, service, started, install, dataFile } = setup(['3.0.0'])
    expect(await install(buildPackage({ version: '1.0.0' }))).toMatchObject({ status: 'installed', activated: true, rolledBack: false })
    expect(registry.getStatus('demo').state).toBe('ready')
    expect(await install(buildPackage({ version: '2.0.0' }))).toMatchObject({ activated: true })
    expect(started).toEqual(['demo@1.0.0:installed:index.mjs', 'demo@2.0.0:installed:index.mjs'])

    const failed = await install(buildPackage({ version: '3.0.0' }))
    expect(failed).toMatchObject({ activated: false, rolledBack: true, error: 'activation of 3.0.0 failed' })
    expect(service.list().demo.active.version).toBe('2.0.0')
    expect(registry.getStatus('demo').state).toBe('ready')
    expect(started.at(-1)).toBe('demo@2.0.0:installed:index.mjs')
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('removes a failed first install entirely and reports the error', async () => {
    const { registry, service, install } = setup(['1.0.0'])
    expect(await install(buildPackage({ version: '1.0.0' }))).toMatchObject({ activated: false, rolledBack: true })
    expect(service.list()).toEqual({})
    expect(registry.has('demo')).toBe(false)
  })

  it('scopes an update file to the selected provider and discards mismatched packages', async () => {
    const { service, install, dataFile, root } = setup()
    await install(buildPackage({ version: '1.0.0' }))
    const file = path.join(temporaryDirectory('update'), 'update.zip')
    fs.writeFileSync(file, buildPackage({ id: 'other', version: '2.0.0' }))
    expect(() => service.inspect(file, 'demo')).toThrow('select an update for demo')
    expect(fs.readdirSync(path.join(root, '.staging'))).toEqual([])
    expect(service.list().demo.active.version).toBe('1.0.0')
    expect(service.list().other).toBeUndefined()
    expect(() => service.inspect(file, 'not-installed')).toThrow('not installed')

    fs.writeFileSync(file, buildPackage({ version: '2.0.0' }))
    const update = service.inspect(file, 'demo')
    expect(update).toMatchObject({ providerId: 'demo', relation: 'upgrade', installedVersion: '1.0.0', version: '2.0.0' })
    expect(await service.install(update.token, update.trust.warnings)).toMatchObject({ activated: true, rolledBack: false })
    expect(service.list().demo.active.version).toBe('2.0.0')
    expect(service.list().demo.previous?.version).toBe('1.0.0')
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('updates a disabled provider without enabling it or changing its data', async () => {
    const { service, registry, started, install, dataFile } = setup()
    await install(buildPackage())
    await service.setEnabled('demo', false)
    const file = path.join(temporaryDirectory('disabled-update'), 'update.zip')
    fs.writeFileSync(file, buildPackage({ version: '2.0.0' }))
    const update = service.inspect(file, 'demo')
    expect(await service.install(update.token, update.trust.warnings)).toMatchObject({ activated: false, rolledBack: false })
    expect(service.list().demo).toMatchObject({ enabled: false, active: { version: '2.0.0' } })
    expect(registry.has('demo')).toBe(false)
    expect(started).toHaveLength(1)
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('disables, re-enables and removes code without touching provider data', async () => {
    const { registry, service, install, dataFile, root } = setup()
    await install(buildPackage({ version: '1.0.0' }))
    expect(await service.setEnabled('demo', false)).toMatchObject({ activated: false })
    expect(registry.has('demo')).toBe(false)
    expect(service.list().demo.enabled).toBe(false)
    expect(await service.activateInstalled()).toEqual([])
    expect(registry.has('demo')).toBe(false)
    expect(await service.setEnabled('demo', true)).toMatchObject({ activated: true })
    expect(registry.getStatus('demo').state).toBe('ready')
    expect(await service.removeCode('demo')).toBe(true)
    expect(registry.has('demo')).toBe(false)
    expect(fs.existsSync(path.join(root, 'packages', 'demo'))).toBe(false)
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
    expect(await service.setEnabled('demo', true)).toBeNull()
  })

  it('starts enabled packages at startup, skips bundled IDs, and reports integrity failures without blocking others', async () => {
    const { registry, service, install, root } = setup()
    await install(buildPackage({ version: '1.0.0' }))
    await service.setEnabled('demo', false)
    await service.setEnabled('demo', true)
    await registry.deactivate('demo')
    registry.remove('demo')
    const entry = path.join(service.installer.activePackageRoot('demo')!, 'dist', 'index.mjs')
    const code = fs.readFileSync(entry)
    code[0] = code[0] === 0x65 ? 0x66 : 0x65
    fs.writeFileSync(entry, code)
    const failures = await service.activateInstalled()
    expect(failures).toEqual([{ providerId: 'demo', error: expect.stringContaining('recorded SHA-256') }])
    expect(service.lastError('demo')).toContain('recorded SHA-256')
    expect(registry.has('demo')).toBe(false)

    const bundled = new ProviderPackageService(new ProviderRegistry(), {
      root, context: { ...context, bundledProviderIds: new Set(['demo']) }, installer: service.installer, start: async () => { throw new Error('must not start') },
    })
    expect(await bundled.activateInstalled()).toEqual([{ providerId: 'demo', error: expect.stringContaining('built into this Puros') }])
  })
})
