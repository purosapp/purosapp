import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDeterministicZip,
  detectMachOArchitectures,
  findNonPortableDylibs,
  packProvider,
  validatePackagePath,
} from './provider-package.mjs'
import { discoverProviders } from './providers.mjs'
import { readTestZip } from '../tests/support/zip'

const temporaryRoots: string[] = []

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `puros-package-test-${label}-`))
  temporaryRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  delete process.env.FIXTURE_PKG_TOKEN
})

function fixtureProvider(resources: Array<{ from: string; to: string; filter?: string[] }>, extra: Record<string, unknown> = {}) {
  const root = temporaryDirectory('provider')
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export default { apiVersion: 1 }\n')
  fs.writeFileSync(path.join(root, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  return {
    directoryName: 'fixture-pkg',
    root,
    manifest: {
      schemaVersion: 1, apiVersion: 1, id: 'fixture-pkg', version: '0.1.0', displayName: 'Fixture',
      icon: 'assets/icon.svg', brandColor: '#000000', defaultPriority: 1, capabilities: [],
      build: { extraResources: [{ from: 'assets', to: 'providers/fixture-pkg/assets', filter: ['icon.svg'] }, ...resources] },
      ...extra,
    },
  }
}

function dylibCommand(name: string): Buffer {
  const command = Buffer.alloc(24 + Math.ceil((name.length + 1) / 8) * 8)
  command.writeUInt32LE(0xc, 0)
  command.writeUInt32LE(command.length, 4)
  command.writeUInt32LE(24, 8)
  command.write(`${name}\0`, 24)
  return command
}

function machOHeader(cpuType: number): Buffer {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpuType, 4)
  return header
}

describe('deterministic provider ZIP writer', () => {
  it('produces byte-identical, standard archives with fixed metadata and UNIX modes', () => {
    const random = crypto.randomBytes(512)
    const entries = [
      { path: 'a.txt', data: Buffer.from('hello hello hello hello hello\n'), mode: 0o644 },
      { path: 'bin/tool', data: random, mode: 0o755 },
      { path: 'ünicode/ok.json', data: Buffer.from('{}\n'), mode: 0o644 },
    ]
    const first = createDeterministicZip(entries)
    expect(createDeterministicZip(entries).equals(first)).toBe(true)
    const read = readTestZip(first)
    expect(read.map((entry) => entry.path)).toEqual(entries.map((entry) => entry.path))
    for (const [index, entry] of read.entries()) {
      expect(entry.data.equals(entries[index].data)).toBe(true)
      expect(entry.mode).toBe(entries[index].mode)
      expect(entry.flags).toBe(0x0800)
      expect([entry.dosTime, entry.dosDate]).toEqual([0, 0x21])
      expect(entry.madeBy >> 8).toBe(3)
    }
    expect(read[0].method).toBe(8)
    expect(read[1].method).toBe(0)
  })

  it('rejects unsafe package paths', () => {
    for (const bad of ['', '/abs', 'a/../b', './a', 'a//b', 'a\\b', 'c:x', 'a\u0000b', 'é', 'x/'.repeat(17) + 'y']) {
      expect(validatePackagePath(bad), bad).not.toBeNull()
    }
    expect(validatePackagePath('helper/dist/ffmpeg')).toBeNull()
  })
})

describe('Mach-O inspection', () => {
  it('reports thin and universal architectures and ignores scripts', () => {
    expect(detectMachOArchitectures(machOHeader(0x0100000c))).toEqual(['arm64'])
    const fat = Buffer.alloc(48)
    fat.writeUInt32BE(0xcafebabe, 0)
    fat.writeUInt32BE(2, 4)
    fat.writeUInt32BE(0x01000007, 8)
    fat.writeUInt32BE(0x0100000c, 28)
    expect(detectMachOArchitectures(fat)).toEqual(['arm64', 'x86_64'])
    expect(detectMachOArchitectures(Buffer.from('#!/bin/zsh\nexit 0\n'))).toBeNull()
  })

  it('flags absolute non-system dylib dependencies', () => {
    const header = machOHeader(0x0100000c)
    header.writeUInt32LE(2, 16)
    const binary = Buffer.concat([header, dylibCommand('/opt/homebrew/lib/libavcodec.dylib'), dylibCommand('/usr/lib/libSystem.B.dylib')])
    expect(findNonPortableDylibs(binary)).toEqual(['/opt/homebrew/lib/libavcodec.dylib'])
  })
})

// Each case compiles a provider with Vite; under the full parallel suite that exceeds the 5 s default.
describe('provider package builder', { timeout: 60_000 }, () => {
  it('packs the example provider reproducibly with manifest, compiled entry and declared resources', async () => {
    const example = discoverProviders().find(({ manifest }) => manifest.id === 'example')
    expect(example).toBeDefined()
    const first = await packProvider(example!, { skipBuild: true, outputRoot: temporaryDirectory('out-a') })
    const second = await packProvider(example!, { skipBuild: true, outputRoot: temporaryDirectory('out-b') })
    const archive = fs.readFileSync(first.zipPath)
    expect(fs.readFileSync(second.zipPath).equals(archive)).toBe(true)
    expect(first.sha256).toBe(crypto.createHash('sha256').update(archive).digest('hex'))
    expect(fs.readFileSync(`${first.zipPath}.sha256`, 'utf8')).toBe(`${first.sha256}  puros-provider-example-1.0.0.zip\n`)

    const entries = readTestZip(archive)
    expect(entries.map((entry) => entry.path)).toEqual([
      'puros-provider.json', 'assets/example.wav', 'assets/icon.svg', 'dist/index.mjs', 'provider.manifest.json',
    ])
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))
    const descriptor = JSON.parse(byPath.get('puros-provider.json')!.data.toString('utf8'))
    expect(descriptor).toMatchObject({
      format: 'puros-provider-package', formatVersion: 1, platform: null,
      provider: { id: 'example', version: '1.0.0', apiVersion: 1 },
      manifest: 'provider.manifest.json', entry: 'dist/index.mjs',
    })
    expect(descriptor.files.map((file: { path: string }) => file.path)).toEqual(entries.slice(1).map((entry) => entry.path))
    for (const file of descriptor.files as Array<{ path: string; size: number; sha256: string }>) {
      const data = byPath.get(file.path)!.data
      expect(file.size).toBe(data.length)
      expect(file.sha256).toBe(crypto.createHash('sha256').update(data).digest('hex'))
    }
    expect(JSON.parse(byPath.get('provider.manifest.json')!.data.toString('utf8'))).toEqual(example!.manifest)
    expect(byPath.get('assets/example.wav')!.data.equals(fs.readFileSync(path.join(example!.root, 'assets', 'example.wav')))).toBe(true)
    const code = byPath.get('dist/index.mjs')!.data.toString('utf8')
    expect(code).not.toContain(process.cwd())
    expect(code).not.toMatch(/from\s+["'](?!node:)[^"']+["']/)
  })

  it('refuses dotenv files, private keys and leaked runtime environment values', async () => {
    const dotenv = fixtureProvider([{ from: 'secret.env', to: 'providers/fixture-pkg/.env' }])
    fs.writeFileSync(path.join(dotenv.root, 'secret.env'), 'X=1\n')
    await expect(packProvider(dotenv, { skipBuild: true, outputRoot: temporaryDirectory('out') })).rejects.toThrow('forbidden secret filename')

    const key = fixtureProvider([{ from: 'notes.txt', to: 'providers/fixture-pkg/notes.txt' }])
    fs.writeFileSync(path.join(key.root, 'notes.txt'), `-----${['BEGIN', 'PRIVATE KEY'].join(' ')}-----\n`)
    await expect(packProvider(key, { skipBuild: true, outputRoot: temporaryDirectory('out') })).rejects.toThrow('private-key marker')

    const leaked = fixtureProvider(
      [{ from: 'config.json', to: 'providers/fixture-pkg/config.json' }],
      { permissions: { runtimeEnvironment: ['FIXTURE_PKG_TOKEN'] } },
    )
    const secretValue = `value-${crypto.randomUUID()}`
    process.env.FIXTURE_PKG_TOKEN = secretValue
    fs.writeFileSync(path.join(leaked.root, 'config.json'), JSON.stringify({ token: secretValue }))
    const failure = await packProvider(leaked, { skipBuild: true, outputRoot: temporaryDirectory('out') }).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('FIXTURE_PKG_TOKEN')
    expect((failure as Error).message).not.toContain(secretValue)
  })

  it('refuses symlinks, escaping or undeclared layouts, and non-executable helpers', async () => {
    const outside = temporaryDirectory('outside')
    fs.writeFileSync(path.join(outside, 'data.txt'), 'outside\n')
    const linked = fixtureProvider([{ from: 'linked.txt', to: 'providers/fixture-pkg/linked.txt' }])
    fs.symlinkSync(path.join(outside, 'data.txt'), path.join(linked.root, 'linked.txt'))
    await expect(packProvider(linked, { skipBuild: true, outputRoot: temporaryDirectory('out') })).rejects.toThrow('symbolic link')

    const escaping = fixtureProvider([{ from: '../x', to: 'providers/fixture-pkg/x' }])
    await expect(packProvider(escaping, { skipBuild: true, outputRoot: temporaryDirectory('out') })).rejects.toThrow('escapes the provider directory')

    const foreign = fixtureProvider([{ from: 'assets/icon.svg', to: 'providers/other/icon.svg' }])
    await expect(packProvider(foreign, { skipBuild: true, outputRoot: temporaryDirectory('out') })).rejects.toThrow('must be inside providers/fixture-pkg/')

    const reserved = fixtureProvider([{ from: 'assets/icon.svg', to: 'providers/fixture-pkg/dist/index.mjs' }])
    await expect(packProvider(reserved, { skipBuild: true, outputRoot: temporaryDirectory('out') })).rejects.toThrow('reserved package path')

    const helper = fixtureProvider(
      [{ from: 'run.sh', to: 'providers/fixture-pkg/run.sh' }],
      { permissions: { helpers: [{ id: 'bridge', executable: 'run.sh' }] } },
    )
    fs.writeFileSync(path.join(helper.root, 'run.sh'), '#!/bin/zsh\n', { mode: 0o644 })
    await expect(packProvider(helper, { skipBuild: true, outputRoot: temporaryDirectory('out') })).rejects.toThrow('is not executable')

    const missing = fixtureProvider([{ from: 'helper/dist', to: 'providers/fixture-pkg/helper/dist' }])
    await expect(packProvider(missing, { skipBuild: true, outputRoot: temporaryDirectory('out') })).rejects.toThrow('run the provider build first')
  })

  it('refuses packaged binaries that link libraries outside macOS', async () => {
    const provider = fixtureProvider([{ from: 'bin', to: 'providers/fixture-pkg/bin' }])
    Object.assign(provider.manifest.build, { binaries: ['providers/fixture-pkg/bin/tool'] })
    fs.mkdirSync(path.join(provider.root, 'bin'))
    const header = machOHeader(0x0100000c)
    header.writeUInt32LE(1, 16)
    fs.writeFileSync(path.join(provider.root, 'bin', 'tool'), Buffer.concat([header, dylibCommand('/opt/homebrew/lib/libavutil.dylib')]), { mode: 0o755 })
    await expect(packProvider(provider, { skipBuild: true, outputRoot: temporaryDirectory('out') }))
      .rejects.toThrow('packaged binaries must be self-contained')
  })
})
