import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FormatInfoV1, ProviderHelperOutputV1, ProviderHelpersHostV1, ProviderManifestV1 } from '../../../src/provider-api/v1'
import { resolveHelperArguments } from '../../../electron/main/providers/helperArguments'
import { providerHelperEnvironment } from '../../../electron/main/providers/environment'
import manifest from '../../../providers/soundcloud/provider.manifest.json'
import { SoundCloudClient } from '../../../providers/soundcloud/src/api'
import { SoundCloudCatalog } from '../../../providers/soundcloud/src/catalog'
import { SoundCloudPlayback } from '../../../providers/soundcloud/src/playback'
import { memoryClientIds } from '../../../providers/soundcloud/src/testing'

/**
 * Opt-in network test (PUROS_SC_NETWORK_TEST=1) against live api-v2 without
 * an account: client ID scraping, search, sets with stub hydration, home,
 * and the real download → ffmpeg remux → decode-check chain for AAC (HLS) and
 * MP3 (progressive). Sign-in, the library and Go+ need manual QA.
 */
const providerRoot = path.resolve(__dirname, '../../../providers/soundcloud')
const enabled = process.env.PUROS_SC_NETWORK_TEST === '1' && fs.existsSync(path.join(providerRoot, 'helper', 'dist', 'ffmpeg'))
const roots: string[] = []
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) })

function helpersHost(cacheRoot: string, dataRoot: string): ProviderHelpersHostV1 {
  const handles = new Map<string, { child: ReturnType<typeof spawn>; queue: ProviderHelperOutputV1[]; waiter: ((event: ProviderHelperOutputV1) => void) | null }>()
  const push = (id: string, event: ProviderHelperOutputV1) => {
    const state = handles.get(id)!
    if (state.waiter) { const waiter = state.waiter; state.waiter = null; waiter(event) } else state.queue.push(event)
  }
  return {
    async spawn({ binaryId, args }) {
      const declaration = (manifest as unknown as ProviderManifestV1).permissions!.helpers!.find((helper) => helper.id === binaryId)!
      // The host's own argv validation: one existing cache input, one new cache output.
      const argv = resolveHelperArguments(declaration, args ?? [], cacheRoot)
      const child = spawn(path.join(providerRoot, declaration.executable), argv, { cwd: dataRoot, env: providerHelperEnvironment(dataRoot), stdio: ['pipe', 'pipe', 'pipe'] })
      const id = randomUUID()
      handles.set(id, { child, queue: [], waiter: null })
      child.stdout.on('data', (data: Buffer) => push(id, { type: 'stdout', data: new Uint8Array(data) }))
      child.stderr.on('data', (data: Buffer) => push(id, { type: 'stderr', data: new Uint8Array(data) }))
      child.once('close', (exitCode, signal) => push(id, { type: 'exit', exitCode, signal }))
      return { handleId: id }
    },
    async write({ handleId, data }) { handles.get(handleId)!.child.stdin!.write(data) },
    async closeStdin(handleId) { handles.get(handleId)!.child.stdin!.end() },
    async read(handleId) {
      const state = handles.get(handleId)!
      const next = state.queue.shift()
      if (next) return next
      return new Promise((resolve) => { state.waiter = resolve })
    },
    async terminate(handleId) { handles.get(handleId)?.child.kill('SIGTERM') },
  }
}

/** What core's music-metadata inspection reports, reduced to the fields this test checks. */
async function inspect(file: string): Promise<FormatInfoV1 | null> {
  const mm = await import('music-metadata')
  const { format } = await mm.parseFile(file, { duration: true, skipCovers: true })
  const codec = (format.codec ?? '').toUpperCase()
  const kind = codec.includes('AAC') || codec.includes('MP4A') ? 'AAC' : codec.includes('LAYER 3') || codec === 'MP3' ? 'MP3' : null
  if (!kind) return null
  return {
    format: kind, sampleRate: format.sampleRate ?? 0, bitDepth: 0, bitrate: Math.round((format.bitrate ?? 0) / 1000),
    channels: format.numberOfChannels ?? 0, isLossless: false, isHiRes: false, isMqa: false, isDsd: false,
    ...({ container: format.container } as object),
  }
}

describe.runIf(enabled)('live SoundCloud (network, no account)', () => {
  const client = new SoundCloudClient({ getToken: () => null, clientIds: memoryClientIds() })
  const catalog = new SoundCloudCatalog(client, () => null)

  it('searches, opens sets with hydrated stubs, and reads home', { timeout: 60_000 }, async () => {
    const results = await catalog.search({ query: 'bicep glue', limit: 5 })
    expect(results.tracks.length).toBeGreaterThan(0)
    expect(results.artists.length).toBeGreaterThan(0)
    expect(results.nextCursor).toBeTruthy()
    const more = await catalog.search({ query: '', cursor: results.nextCursor })
    expect(more.tracks.length + more.artists.length + more.albums.length + more.playlists.length).toBeGreaterThan(0)

    const albums = await catalog.search({ query: 'bicep isles', types: ['album'], limit: 3 })
    const bundle = await catalog.getAlbumBundle(albums.albums[0].sourceId)
    expect(bundle.tracks.length).toBe(bundle.album.totalTracks)
    expect(bundle.tracks.map((t) => t.trackNumber)).toEqual(bundle.tracks.map((_, i) => i + 1))

    const artist = await catalog.getArtistBundle(results.tracks[0].primaryArtistSourceId!)
    expect(artist.artist.name).toBeTruthy()
    expect(artist.topTracks.length).toBeGreaterThan(0)

    const shelves = await catalog.getShelves()
    expect(shelves.items.length).toBeGreaterThan(0)
    const mix = shelves.items.flatMap((shelf) => shelf.items).find((item) => 'collectionRef' in item && item.collectionRef?.type === 'mix') as { collectionRef: { type: 'mix'; sourceId: string } } | undefined
    if (mix) {
      const collection = await catalog.getCollection({ ...mix.collectionRef, limit: 60 })
      expect(collection.tracks.length).toBeGreaterThan(10)
    }
  })

  it('downloads, remuxes and verifies the best stream and the MP3 stream', { timeout: 180_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-sc-it-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'cache'))
    const cacheRoot = fs.realpathSync(path.join(root, 'cache'))
    const dataRoot = path.join(root, 'data')
    fs.mkdirSync(dataRoot)
    const results = await catalog.search({ query: 'bicep glue', types: ['track'], limit: 10 })
    const candidate = results.tracks.find((t) => t.durationMs > 60_000)!
    const make = (preferMp3: boolean) => new SoundCloudPlayback({
      host: {
        paths: { getCacheRoot: async () => cacheRoot, getDataRoot: async () => dataRoot, getResourceRoot: async () => providerRoot },
        helpers: helpersHost(cacheRoot, dataRoot),
        cache: { get: async () => null, inspectFormat: inspect, canPlayFormat: async () => true, put: async () => {}, trim: async () => {} },
        catalog: { getStoredTrack: async () => null, getPlaybackRecoverySeed: async () => null, listTracksNeedingFormat: async () => [], updateTrackFormat: async () => {} },
        events: { emit: async () => {} },
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      },
      session: { accountKey: () => (preferMp3 ? 'mp3' : 'guest'), getToken: () => null },
      client,
      catalog: preferMp3 ? {
        // Hide the AAC variants so the MP3 path runs against the same live track.
        async getTrackObject(id, signal) {
          const track = await catalog.getTrackObject(id, signal) as { media: { transcodings: Array<{ preset: string }> } }
          return { ...track, media: { transcodings: track.media.transcodings.filter((t) => t.preset.startsWith('mp3')) } }
        },
      } : catalog,
      audioSource: async () => 'stream',
    })

    const best = await make(false).resolve({ sourceId: candidate.sourceId, intent: 'playback' })
    expect(best.format).toMatchObject({ format: 'AAC', bitDepth: 0, isLossless: false })
    expect(best.format.bitrate).toBeGreaterThanOrEqual(96)
    expect(best.path.endsWith('.m4a')).toBe(true)
    const aac = await (await import('music-metadata')).parseFile(best.path, { duration: true })
    // A plain (non-fragmented) MP4 whose length matches SoundCloud's.
    expect(aac.format.container).toMatch(/M4A|mp4|isom|mp42/i)
    expect(Math.abs((aac.format.duration ?? 0) * 1000 - candidate.durationMs)).toBeLessThan(2_500)

    // AudioToolbox, which core plays through, opens it as AAC in an MPEG-4 audio file.
    const afinfo = execFileSync('/usr/bin/afinfo', [best.path], { encoding: 'utf8' })
    expect(afinfo).toMatch(/File type ID:\s+m4af/)
    expect(afinfo).toMatch(/Data format:.*aac/)

    const mp3 = await make(true).resolve({ sourceId: candidate.sourceId, intent: 'playback' })
    expect(mp3.format).toMatchObject({ format: 'MP3', bitrate: 128 })
    expect(execFileSync('/usr/bin/afinfo', [mp3.path], { encoding: 'utf8' })).toMatch(/Data format:.*\.mp3/)
    expect(fs.readdirSync(path.join(cacheRoot, 'work'))).toEqual([])
  })
})
