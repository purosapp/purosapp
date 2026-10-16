import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProviderHelperOutputV1, ProviderHelpersHostV1, ProviderManifestV1 } from '../../../src/provider-api/v1'
import { canCorePlayFormat } from '../../../electron/main/providers/cacheFormat'
import { probeOggOpusDecoding } from '../../../electron/main/audio/oggOpusSupport'
import { resolveHelperArguments } from '../../../electron/main/providers/helperArguments'
import { providerHelperEnvironment } from '../../../electron/main/providers/environment'
import manifest from '../../../providers/youtube-music/provider.manifest.json'
import { YtmPlaybackRuntime } from '../../../providers/youtube-music/src/playback'
import { READY_SAMPLES } from '../../../providers/youtube-music/src/progressive'

/**
 * Opt-in network test (PUROS_YTM_NETWORK_TEST=1) of the real helper chain:
 * bundled yt-dlp + Deno → ffmpeg stream-copy remux → Opus end trim → decode
 * check → AudioToolbox. It uses no account: the cookie file is empty, so it
 * proves the pipeline, not the Google sign-in.
 */
const providerRoot = path.resolve(__dirname, '../../../providers/youtube-music')
const enabled = process.env.PUROS_YTM_NETWORK_TEST === '1' && fs.existsSync(path.join(providerRoot, 'helper', 'dist', 'deno'))
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

describe.runIf(enabled)('real yt-dlp playback chain (network, no account)', () => {
  it('streams Opus progressively: AudioToolbox reads the growing file, the final file is sample-exact', { timeout: 180_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-ytm-it-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'cache'), { recursive: true })
    const cacheRoot = fs.realpathSync(path.join(root, 'cache'))
    const dataRoot = path.join(root, 'data')
    fs.mkdirSync(dataRoot, { recursive: true })
    const sessions: Array<{ state: string; artifactPath?: string }> = []
    const runtime = new YtmPlaybackRuntime({
      host: {
        paths: { getCacheRoot: async () => cacheRoot, getDataRoot: async () => dataRoot, getResourceRoot: async () => providerRoot },
        helpers: helpersHost(cacheRoot, dataRoot),
        cache: { get: async () => null, inspectFormat: async () => null, canPlayFormat: async () => true, put: async () => {}, trim: async () => {} },
        catalog: { getStoredTrack: async () => null, getPlaybackRecoverySeed: async () => null, listTracksNeedingFormat: async () => [], updateTrackFormat: async () => {} },
        events: { emit: async (event) => { if (event.type === 'playback.session') sessions.push(event.session) } },
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      },
      session: {
        status: () => ({ state: 'connected', account: { name: 'integration', handle: null } }),
        accountKey: () => 'integration',
        markExpired: () => {},
        async withCookieFile(task) {
          const file = path.join(dataRoot, 'empty-cookies.txt')
          fs.writeFileSync(file, '# Netscape HTTP Cookie File\n', { mode: 0o600 })
          try { return await task(file) } finally { fs.rmSync(file, { force: true }) }
        },
      },
    })
    const started = Date.now()
    const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback', sessionId: 'integration-session' })
    console.info(`[integration] first artifact ${artifact.lifecycle} after ${Date.now() - started} ms`)
    const frames = (file: string) => Number(execFileSync('/usr/bin/afinfo', [file], { encoding: 'utf8' }).match(/audio (\d+) valid frames/)?.[1])
    if (artifact.lifecycle === 'growing') {
      // The engine's decoder opens the file while it is still being written.
      expect(frames(artifact.path)).toBeGreaterThanOrEqual(READY_SAMPLES)
    }
    const deadline = Date.now() + 120_000
    while (!sessions.some((session) => session.state === 'completed' || session.state === 'failed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const done = sessions.at(-1)!
    console.info(`[integration] completed after ${Date.now() - started} ms`)
    expect(done.state).toBe('completed')
    // Identical to decoding YouTube's WebM: pre-skip 312 and end padding 328 trimmed.
    expect(frames(done.artifactPath!)).toBe(26_142_080)
  })

  for (const allowOpus of [true, false]) {
    it(`prepares a verified ${allowOpus ? 'Opus' : 'AAC'} artifact`, { timeout: 180_000 }, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-ytm-it-'))
      roots.push(root)
      const cacheRoot = fs.realpathSync(fs.mkdirSync(path.join(root, 'cache'), { recursive: true }) ?? path.join(root, 'cache'))
      const dataRoot = fs.mkdirSync(path.join(root, 'data'), { recursive: true }) ?? path.join(root, 'data')
      const puts: unknown[] = []
      const runtime = new YtmPlaybackRuntime({
        host: {
          paths: { getCacheRoot: async () => cacheRoot, getDataRoot: async () => dataRoot, getResourceRoot: async () => providerRoot },
          helpers: helpersHost(cacheRoot, dataRoot),
          cache: {
            get: async () => null,
            inspectFormat: async () => null,
            canPlayFormat: async (format) => allowOpus && canCorePlayFormat(format, { oggVorbis: async () => false, oggOpus: () => probeOggOpusDecoding() }),
            put: async (entry) => { puts.push(entry) },
            trim: async () => {},
          },
          catalog: { getStoredTrack: async () => null, getPlaybackRecoverySeed: async () => null, listTracksNeedingFormat: async () => [], updateTrackFormat: async () => {} },
          events: { emit: async () => {} },
          logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
        },
        session: {
          status: () => ({ state: 'connected', account: { name: 'integration', handle: null } }),
          accountKey: () => 'integration',
          markExpired: () => {},
          async withCookieFile(task) {
            const file = path.join(dataRoot, 'empty-cookies.txt')
            fs.writeFileSync(file, '# Netscape HTTP Cookie File\n', { mode: 0o600 })
            try { return await task(file) } finally { fs.rmSync(file, { force: true }) }
          },
        },
      })
      const artifact = await runtime.resolve({ sourceId: 'ZFZM6jDTWd4', intent: 'playback' })
      expect(artifact.lifecycle).toBe('complete')
      expect(artifact.path.startsWith(cacheRoot)).toBe(true)
      expect(artifact.format).toMatchObject(allowOpus
        ? { format: 'OPUS', sampleRate: 48_000, bitDepth: 0, isLossless: false, isHiRes: false }
        : { format: 'AAC', bitDepth: 0, isLossless: false, isHiRes: false })
      expect(puts).toHaveLength(1)
      // AudioToolbox (the engine's decoder) must open it and agree on the length.
      const info = execFileSync('/usr/bin/afinfo', [artifact.path], { encoding: 'utf8' })
      const frames = Number(info.match(/audio (\d+) valid frames/)?.[1])
      const rate = Number(info.match(/(\d+) Hz/)?.[1])
      expect(rate).toBe(allowOpus ? 48_000 : 44_100)
      expect(Math.abs(frames / rate - 544.63)).toBeLessThan(0.2)
      expect(fs.readdirSync(path.join(cacheRoot, 'work')).length).toBe(0)
    })
  }
})
