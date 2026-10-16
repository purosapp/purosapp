import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  API_VERSION,
  type ProviderHostV1,
  type ProviderManifestV1,
  type ProviderPluginV1,
  type ProviderPrimitiveV1,
  type ProviderValueV1,
} from '../src/provider-api/v1'
import { assertProviderValue, validatePlaybackArtifact, validateProviderManifest } from '../electron/main/providers/validation'
import { extractTestZip } from './support/zip'

const providerRoot = path.resolve(process.cwd(), 'providers')
const selectedId = process.env.PUROS_CONTRACT_PROVIDER
// Comma-separated provider package ZIPs; when set, only those compiled packages are checked.
const packagedArchives = (process.env.PUROS_CONTRACT_PACKAGES ?? '').split(',').map((value) => value.trim()).filter(Boolean)
const modules = import.meta.glob<{ default: ProviderPluginV1 }>('../providers/*/src/index.ts')
const temporaryRoots: string[] = []
const requiredMethods: Record<string, string[]> = {
  auth: ['getStatus', 'login', 'logout'],
  'catalog.search': ['search'],
  'catalog.entities': ['getArtist', 'getArtistBundle', 'getAlbum', 'getAlbumBundle', 'getTrack'],
  'catalog.home': ['getShelves', 'getCollection'],
  'library.sync': ['enumerate'],
  playlists: ['list', 'get', 'getTracks'],
  'playback.resolve': ['resolve'],
  'playback.prefetch': ['prefetch'],
  'playback.progressive': ['markPlaybackStarted', 'cancel'],
  'quality.tiers': ['list', 'getSelected', 'select'],
  'metadata.artwork': ['getArtwork'],
  'metadata.bio': ['getBio'],
  'metadata.credits': ['getCredits'],
}

function discover() {
  if (packagedArchives.length > 0 || !fs.existsSync(providerRoot)) return []
  const found = fs.readdirSync(providerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const root = path.join(providerRoot, entry.name)
      const manifestPath = path.join(root, 'provider.manifest.json')
      if (!fs.existsSync(manifestPath)) return []
      return [{ root, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ProviderManifestV1 }]
    })
  if (selectedId && !found.some(({ manifest }) => manifest.id === selectedId)) {
    throw new Error(`Provider contract target is not installed: ${selectedId}`)
  }
  return selectedId ? found.filter(({ manifest }) => manifest.id === selectedId) : found
}

function mockHost(id: string, root: string, resourceRoot: string): ProviderHostV1 {
  const cacheRoot = path.join(root, 'cache')
  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(cacheRoot)
  fs.mkdirSync(dataRoot)
  const settings = new Map<string, ProviderPrimitiveV1>()
  const secrets = new Map<string, string>()
  const storage = new Map<string, ProviderValueV1>()
  const unavailable = async (): Promise<never> => { throw new Error('Offline contract host: operation unavailable') }
  return {
    apiVersion: API_VERSION,
    providerId: id,
    settings: {
      async get(key) { return settings.get(key) },
      async set(key, value) { settings.set(key, value) },
      async delete(key) { settings.delete(key) },
    },
    secrets: {
      async has(key) { return secrets.has(key) },
      async get(key) { return secrets.get(key) },
      async set(key, value) { secrets.set(key, value) },
      async delete(key) { secrets.delete(key) },
    },
    storage: {
      async get(key) { return storage.get(key) },
      async set(key, value) { storage.set(key, value) },
      async delete(key) { storage.delete(key) },
      async list(prefix = '') { return [...storage.keys()].filter((key) => key.startsWith(prefix)) },
    },
    paths: {
      async getCacheRoot() { return cacheRoot },
      async getDataRoot() { return dataRoot },
      async getResourceRoot() { return resourceRoot },
    },
    cache: { get: async () => null, inspectFormat: async () => null, canPlayFormat: async () => false, put: async () => {}, trim: async () => {} },
    catalog: {
      getStoredTrack: async () => null,
      getPlaybackRecoverySeed: async () => null,
      listTracksNeedingFormat: async () => [],
      updateTrackFormat: async () => {},
    },
    events: { emit: async (event) => { assertProviderValue(event) }, scheduleLibraryCatalogRefreshWhenIdle: async () => {} },
    helpers: {
      spawn: unavailable,
      write: unavailable,
      closeStdin: unavailable,
      read: unavailable,
      terminate: unavailable,
    },
    logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
    openExternal: unavailable,
    openAuthWindow: unavailable,
  }
}

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded the offline contract deadline`)), 5_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

async function runProviderContract(root: string, manifest: ProviderManifestV1, loadPlugin: () => Promise<ProviderPluginV1>) {
  const schema = JSON.parse(fs.readFileSync(path.resolve('provider-sdk/src/provider-manifest.schema.json'), 'utf8')) as {
    $schema: string
    required: string[]
    $defs: { capability: { enum: string[] } }
  }
  expect(schema.$schema).toContain('2020-12')
  expect(schema.required.every((key) => Object.hasOwn(manifest, key))).toBe(true)
  expect(manifest.capabilities.every((capability) => schema.$defs.capability.enum.includes(capability))).toBe(true)
  expect(validateProviderManifest(manifest)).toMatchObject({ ok: true })
  expect(fs.existsSync(path.join(root, manifest.icon))).toBe(true)

  const plugin = await loadPlugin()
  expect(plugin.apiVersion).toBe(API_VERSION)
  expect(plugin.manifest).toEqual(manifest)

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `puros-contract-${manifest.id}-`))
  temporaryRoots.push(temporaryRoot)
  const host = mockHost(manifest.id, temporaryRoot, root)
  const runtime = await within(plugin.activate(host), 'activate')
  try {
    expect(Object.keys(runtime.capabilities).sort()).toEqual([...manifest.capabilities].sort())
    for (const capability of manifest.capabilities) {
      const implementation = runtime.capabilities[capability] as unknown as Record<string, unknown>
      for (const method of requiredMethods[capability] ?? []) expect(implementation[method]).toBeTypeOf('function')
    }
    for (const setting of manifest.settings ?? []) {
      const target = setting.type === 'action' ? setting.action : setting.type === 'form' ? setting.submit : null
      if (!target) continue
      expect(manifest.capabilities).toContain(target.capability)
      expect((runtime.capabilities[target.capability] as unknown as Record<string, unknown>)[target.method]).toBeTypeOf('function')
    }

    const status = await within(runtime.getStatus(), 'getStatus')
    expect(['ready', 'degraded']).toContain(status.state)
    expect(status.updatedAt).toBeGreaterThan(0)
    assertProviderValue(status)
    expect(structuredClone(status)).toEqual(status)
    if (runtime.capabilities.auth) {
      const auth = await within(runtime.capabilities.auth.getStatus(), 'auth.getStatus')
      assertProviderValue(auth)
      expect(typeof auth.authenticated).toBe('boolean')
    }

    if (manifest.id === 'example') {
      const search = await runtime.capabilities['catalog.search']!.search({ query: 'contract' })
      assertProviderValue(search)
      expect(search.tracks[0]?.sourceId).toBe('example-track')
      const artifact = await runtime.capabilities['playback.resolve']!.resolve({ sourceId: 'example-track', intent: 'playback' })
      assertProviderValue(artifact)
      expect(validatePlaybackArtifact(artifact, await host.paths.getCacheRoot(), false).lifecycle).toBe('complete')
    }

    const outside = path.join(temporaryRoot, 'outside.wav')
    fs.writeFileSync(outside, 'fixture')
    const cacheRoot = await host.paths.getCacheRoot()
    expect(() => validatePlaybackArtifact({
      path: outside, lifecycle: 'complete',
      format: { format: 'WAV', sampleRate: 48_000, bitDepth: 16, bitrate: 768_000, channels: 1,
        isLossless: true, isHiRes: false, isMqa: false, isDsd: false },
    }, cacheRoot, false)).toThrow('outside the provider cache root')

    if (runtime.capabilities['catalog.entities']) {
      await expect(within(runtime.capabilities['catalog.entities'].getTrack('__missing__'), 'missing entity'))
        .rejects.toBeInstanceOf(Error)
    }
  } finally {
    await within(runtime.deactivate(), 'deactivate')
  }
  expect((await within(runtime.getStatus(), 'status after deactivate')).state).toBe('inactive')
}

for (const { root, manifest } of discover()) {
  describe(`${manifest.id} ProviderPluginV1 contract`, () => {
    it('matches the v1 manifest schema surface and activates with exact capabilities', async () => {
      await runProviderContract(root, manifest, async () => {
        const modulePath = `../providers/${path.basename(root)}/src/index.ts`
        const load = modules[modulePath]
        expect(load, `Missing provider entrypoint ${modulePath}`).toBeTypeOf('function')
        return (await load()).default
      })
    })
  })
}

for (const archive of packagedArchives) {
  describe(`packaged ${path.basename(archive)} ProviderPluginV1 contract`, () => {
    it('runs the same contract against the compiled entry and packaged resources', async () => {
      const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-contract-package-'))
      temporaryRoots.push(extractionRoot)
      const packageRoot = path.join(extractionRoot, 'package')
      extractTestZip(path.resolve(archive), packageRoot)
      const descriptor = JSON.parse(fs.readFileSync(path.join(packageRoot, 'puros-provider.json'), 'utf8')) as { entry: string; manifest: string }
      const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, descriptor.manifest), 'utf8')) as ProviderManifestV1
      await runProviderContract(packageRoot, manifest, async () => {
        const entry = pathToFileURL(path.join(packageRoot, descriptor.entry)).href
        return (await import(/* @vite-ignore */ entry) as { default: ProviderPluginV1 }).default
      })
    })
  })
}
