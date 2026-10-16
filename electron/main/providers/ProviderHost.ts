import { app, BrowserWindow, safeStorage, shell, session } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  API_VERSION,
  type ProviderAuthCollectDescriptorV1,
  type ProviderAuthWindowResultV1,
  type ProviderEventEnvelopeV1,
  type ProviderEventV1,
  type ProviderHostV1,
  type ProviderManifestV1,
  type FormatInfoV1,
  type ProviderPrimitiveV1,
  type ProviderValueV1,
} from '../../../src/provider-api/v1'
import { getSettingForIpc, setSettingValue, deleteSettingValue } from '../settings/store'
import { getDb } from '../db'
import { isPathInsideRoot } from '../security/pathPolicy'
import {
  getCachedStreamingAudio,
  getStreamingAudioCacheDir,
  registerStreamingAudioCacheEntry,
  scheduleStreamingAudioCacheTrim,
} from '../streamingCache'
import { assertProviderValue, validateFormatInfo } from './validation'
import { HelperOutputQueue } from './helperOutput'
import { resolveHelperArguments } from './helperArguments'
import { applyDeclaredHelperPriority } from './helperPriority'
import { getStoredProviderTrack, getProviderPlaybackRecoverySeed, listProviderTracksNeedingFormat, updateProviderTrackFormat } from './catalogData'
import { authNavigationOrigin, isAllowedExternalUrl } from './originPolicy'
import {
  FIREFOX_USER_AGENT,
  authPartitionKind,
  browserUserAgent,
  googleChromeMetadata,
  hasRequiredCookies,
  lowEntropyClientHints,
  serializeCookieJar,
  type NativeUserAgentData,
} from './authWindow'
import { schedulePlaybackIdleRefresh } from '../playbackCoordinator'
import { inspectPlaybackFileFormat } from '../audio/localPlayback'
import { canCorePlayFormat, inspectProviderCacheFormat } from './cacheFormat'
import { canDecodeOggVorbis } from '../audio/oggVorbisSupport'
import { canDecodeOggOpus } from '../audio/oggOpusSupport'
import { providerHelperEnvironment } from './environment'

type ProviderEventSink = (envelope: ProviderEventEnvelopeV1) => void

export interface ProviderHostController {
  host: ProviderHostV1
  cacheRoot: string
  dataRoot: string
  dispose(): Promise<void>
}

const KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/

function ensureDirectory(directoryPath: string): string {
  fs.mkdirSync(directoryPath, { recursive: true })
  return fs.realpathSync.native(directoryPath)
}

function ensureKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new TypeError(`Invalid provider key: ${key}`)
}

function ensureNonemptyString(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new TypeError(`Invalid ${label}`)
  }
}

function ensureFormat(format: FormatInfoV1): void {
  validateFormatInfo(format)
}

function ensureDeclaredSecret(manifest: ProviderManifestV1, key: string): void {
  ensureKey(key)
  if (!(manifest.permissions?.secrets ?? []).includes(key)) {
    throw new Error(`Provider ${manifest.id} did not declare secret ${key}`)
  }
}

function getDeclaredSetting(manifest: ProviderManifestV1, key: string, storage: 'setting' | 'secret') {
  return manifest.settings?.find((setting) => (
    'key' in setting && setting.key === key && setting.storage === storage
  ))
}

function providerSettingKey(providerId: string, key: string): string {
  return `provider.${providerId}.${key}`
}

function parseStoredPrimitive(raw: string | null): ProviderPrimitiveV1 | undefined {
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      return value as ProviderPrimitiveV1
    }
  } catch {
    // Legacy/non-provider values are never returned through the provider host.
  }
  return undefined
}

const EPHEMERAL_REWIPE_MS = 2_000

let nativeUserAgentData: Promise<NativeUserAgentData> | null = null

/**
 * The engine's client hints need a secure context. A hidden window in a
 * throwaway partition loads an https page its own protocol handler serves, so
 * no request leaves the machine. Read once per run.
 */
function probeNativeUserAgentData(): Promise<NativeUserAgentData> {
  nativeUserAgentData ??= (async () => {
    const probeSession = session.fromPartition('puros-user-agent-probe')
    if (!probeSession.protocol.isProtocolHandled('https')) {
      probeSession.protocol.handle('https', () => new Response('<!doctype html><title>probe</title>', { headers: { 'content-type': 'text/html' } }))
    }
    const probe = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, session: probeSession } })
    try {
      await probe.loadURL('https://user-agent-probe.invalid/')
      return await probe.webContents.executeJavaScript(`navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'wow64'])
        .then((values) => ({ ...values, brands: navigator.userAgentData.brands, platform: navigator.userAgentData.platform, mobile: navigator.userAgentData.mobile }))`) as NativeUserAgentData
    } finally {
      if (!probe.isDestroyed()) probe.destroy()
    }
  })()
  nativeUserAgentData.catch(() => { nativeUserAgentData = null })
  return nativeUserAgentData
}

/** User agent and client hints of Google Chrome on this Chromium, applied before the first request. */
async function presentAsGoogleChrome(authWindow: BrowserWindow): Promise<void> {
  const metadata = googleChromeMetadata(await probeNativeUserAgentData())
  if (authWindow.isDestroyed()) return
  const hints = lowEntropyClientHints(metadata)
  const requests = authWindow.webContents.session.webRequest
  requests.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const present = Object.keys(details.requestHeaders).some((name) => name.toLowerCase() === 'sec-ch-ua')
    callback({ requestHeaders: present ? details.requestHeaders : { ...details.requestHeaders, ...hints } })
  })
  authWindow.once('closed', () => requests.onBeforeSendHeaders(null))
  await authWindow.loadURL('about:blank')
  if (authWindow.isDestroyed()) return
  const devtools = authWindow.webContents.debugger
  if (!devtools.isAttached()) devtools.attach('1.3')
  await devtools.sendCommand('Emulation.setUserAgentOverride', {
    userAgent: browserUserAgent(app.userAgentFallback),
    userAgentMetadata: metadata,
  })
}

/**
 * A user-agent override without client-hint metadata makes Chromium drop
 * `Sec-CH-UA*` headers and `navigator.userAgentData` brands, which would
 * otherwise contradict a Firefox user agent. The DevTools target needs a
 * document first; the override then survives cross-site navigations.
 */
async function presentAsFirefox(authWindow: BrowserWindow): Promise<void> {
  await authWindow.loadURL('about:blank')
  if (authWindow.isDestroyed()) return
  const devtools = authWindow.webContents.debugger
  if (!devtools.isAttached()) devtools.attach('1.3')
  await devtools.sendCommand('Emulation.setUserAgentOverride', { userAgent: FIREFOX_USER_AGENT })
}

function descriptorsEqual(left: ProviderAuthCollectDescriptorV1, right: ProviderAuthCollectDescriptorV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertAuthRequestAllowed(manifest: ProviderManifestV1, request: Parameters<ProviderHostV1['openAuthWindow']>[0]): void {
  const declared = manifest.permissions?.authCollections ?? []
  const matching = declared.find((collection) => (
    request.allowedOrigins.every((origin) => collection.allowedOrigins.includes(origin))
    && request.collect.every((descriptor) => collection.values.some((value) => descriptorsEqual(value, descriptor)))
  ))
  if (!matching) throw new Error(`Provider ${manifest.id} requested an undeclared auth collection`)
  const initialOrigin = authNavigationOrigin(request.url)
  if (!initialOrigin || !request.allowedOrigins.includes(initialOrigin)) throw new Error('Auth URL origin is not allowed')
  if (!authPartitionKind(manifest.id, request.partition)) throw new Error('Auth partition is outside the provider namespace')
  if (request.userAgent !== undefined && request.userAgent !== 'browser' && request.userAgent !== 'firefox') throw new Error('Auth user agent is not supported')
}

async function collectAuthValues(
  authWindow: BrowserWindow,
  request: Parameters<ProviderHostV1['openAuthWindow']>[0],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  const currentUrl = authWindow.webContents.getURL()
  const currentOrigin = authNavigationOrigin(currentUrl)
  for (const descriptor of request.collect) {
    if (descriptor.source === 'cookie') {
      const cookies = await authWindow.webContents.session.cookies.get({
        name: descriptor.cookieName,
        domain: descriptor.domain,
        path: descriptor.path,
      })
      if (cookies[0]?.value) values[descriptor.name] = cookies[0].value
    } else if (descriptor.source === 'cookieJar') {
      if (currentOrigin !== descriptor.origin) continue
      const cookies = (await Promise.all(descriptor.domains.map((domain) => authWindow.webContents.session.cookies.get({ domain })))).flat()
      if (hasRequiredCookies(cookies, descriptor.domains, descriptor.requiredCookies)) {
        values[descriptor.name] = serializeCookieJar(cookies, descriptor.domains)
      }
    } else if (descriptor.source === 'url.searchParam') {
      if (currentOrigin !== descriptor.origin) continue
      const value = new URL(currentUrl).searchParams.get(descriptor.key)
      if (value !== null) values[descriptor.name] = value
    } else if (currentOrigin === descriptor.origin) {
      const key = JSON.stringify(descriptor.key)
      const value = await authWindow.webContents.executeJavaScript(`localStorage.getItem(${key})`, true) as unknown
      if (typeof value === 'string') values[descriptor.name] = value
    }
  }
  return values
}

export function createProviderHost(
  manifest: ProviderManifestV1,
  providerRoot: string,
  emitEnvelope: ProviderEventSink,
): ProviderHostController {
  const cacheRoot = ensureDirectory(getStreamingAudioCacheDir(manifest.id))
  const dataRoot = ensureDirectory(path.join(app.getPath('userData'), 'providers', manifest.id))
  // The loader supplies the provider's code/resource root: the source tree in
  // development, Resources/providers/<id> when bundled, or the installed package directory.
  const resourceRoot = providerRoot
  const sourceRoot = fs.existsSync(resourceRoot) ? fs.realpathSync.native(resourceRoot) : path.resolve(resourceRoot)
  const developmentSecrets = new Map<string, string>()
  const helperProcesses = new Map<string, {
    child: ReturnType<typeof spawn>
    output: HelperOutputQueue
    stdinClosed: boolean
  }>()
  const authWindows = new Set<BrowserWindow>()
  let sequence = 0

  const emit = async (event: ProviderEventV1): Promise<void> => {
    assertProviderValue(event)
    emitEnvelope({ apiVersion: API_VERSION, providerId: manifest.id, sequence: ++sequence, event })
  }

  const logger = (level: 'debug' | 'info' | 'warn' | 'error') => async (
    message: string,
    fields?: Record<string, ProviderValueV1>,
  ) => {
    if (fields) assertProviderValue(fields)
    const method = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error
    method(`[Puros][Provider:${manifest.id}] ${message}`, fields ?? '')
  }

  const host: ProviderHostV1 = {
    apiVersion: API_VERSION,
    providerId: manifest.id,
    settings: {
      async get(key) {
        ensureKey(key)
        if (!getDeclaredSetting(manifest, key, 'setting')) throw new Error(`Undeclared provider setting: ${key}`)
        return parseStoredPrimitive(getSettingForIpc(providerSettingKey(manifest.id, key)))
      },
      async set(key, value) {
        ensureKey(key)
        if (!getDeclaredSetting(manifest, key, 'setting')) throw new Error(`Undeclared provider setting: ${key}`)
        if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Provider setting numbers must be finite')
        setSettingValue(providerSettingKey(manifest.id, key), JSON.stringify(value))
      },
      async delete(key) {
        ensureKey(key)
        if (!getDeclaredSetting(manifest, key, 'setting')) throw new Error(`Undeclared provider setting: ${key}`)
        deleteSettingValue(providerSettingKey(manifest.id, key))
      },
    },
    secrets: {
      async has(key) {
        ensureDeclaredSecret(manifest, key)
        if (!app.isPackaged && !safeStorage.isEncryptionAvailable()) return developmentSecrets.has(key)
        const row = getDb().prepare(`SELECT 1 FROM provider_secrets WHERE provider = ? AND key = ?`).get(manifest.id, key)
        return !!row
      },
      async get(key) {
        ensureDeclaredSecret(manifest, key)
        if (!app.isPackaged && !safeStorage.isEncryptionAvailable()) return developmentSecrets.get(key)
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure provider secret storage is unavailable')
        const row = getDb().prepare(
          `SELECT ciphertext FROM provider_secrets WHERE provider = ? AND key = ?`,
        ).get(manifest.id, key) as { ciphertext: Buffer } | undefined
        return row ? safeStorage.decryptString(row.ciphertext) : undefined
      },
      async set(key, value) {
        ensureDeclaredSecret(manifest, key)
        if (!safeStorage.isEncryptionAvailable()) {
          if (app.isPackaged) throw new Error('Secure provider secret storage is unavailable')
          console.warn(`[Puros][Provider:${manifest.id}] safeStorage unavailable; keeping secret in memory only`)
          developmentSecrets.set(key, value)
          return
        }
        const ciphertext = safeStorage.encryptString(value)
        getDb().prepare(`
          INSERT INTO provider_secrets (provider, key, ciphertext, encryption_version, updated_at)
          VALUES (?, ?, ?, 1, strftime('%s', 'now'))
          ON CONFLICT(provider, key) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            encryption_version = excluded.encryption_version,
            updated_at = excluded.updated_at
        `).run(manifest.id, key, ciphertext)
      },
      async delete(key) {
        ensureDeclaredSecret(manifest, key)
        developmentSecrets.delete(key)
        getDb().prepare(`DELETE FROM provider_secrets WHERE provider = ? AND key = ?`).run(manifest.id, key)
      },
    },
    storage: {
      async get(key) {
        ensureKey(key)
        const row = getDb().prepare(`SELECT value FROM provider_kv WHERE provider = ? AND key = ?`).get(manifest.id, key) as { value: string } | undefined
        if (!row) return undefined
        const value = JSON.parse(row.value) as unknown
        assertProviderValue(value)
        return value
      },
      async set(key, value) {
        ensureKey(key)
        assertProviderValue(value)
        getDb().prepare(`
          INSERT INTO provider_kv (provider, key, value, updated_at)
          VALUES (?, ?, ?, strftime('%s', 'now'))
          ON CONFLICT(provider, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(manifest.id, key, JSON.stringify(value))
      },
      async delete(key) {
        ensureKey(key)
        getDb().prepare(`DELETE FROM provider_kv WHERE provider = ? AND key = ?`).run(manifest.id, key)
      },
      async list(prefix = '') {
        const rows = getDb().prepare(
          `SELECT key FROM provider_kv WHERE provider = ? ORDER BY key`,
        ).all(manifest.id) as Array<{ key: string }>
        return rows.map(({ key }) => key).filter((key) => key.startsWith(prefix))
      },
    },
    paths: {
      async getCacheRoot() { return cacheRoot },
      async getDataRoot() { return dataRoot },
      async getResourceRoot() { return sourceRoot },
    },
    cache: {
      async inspectFormat(filePath) {
        return inspectProviderCacheFormat(filePath, cacheRoot, inspectPlaybackFileFormat)
      },
      async canPlayFormat(format) {
        return canCorePlayFormat(format, { oggVorbis: canDecodeOggVorbis, oggOpus: canDecodeOggOpus })
      },
      async get({ sourceId, qualityKey, requireLossless }) {
        ensureNonemptyString(sourceId, 'cache source ID')
        ensureNonemptyString(qualityKey, 'cache quality key')
        const cached = getCachedStreamingAudio(manifest.id, sourceId, qualityKey, requireLossless)
        if (!cached) return null
        const realPath = fs.realpathSync.native(cached.playbackPath)
        if (!isPathInsideRoot(realPath, cacheRoot)) throw new Error('Cached provider audio escaped its cache root')
        return {
          path: realPath,
          format: cached.quality,
          ...(cached.sourceQuality ? { sourceFormat: cached.sourceQuality } : {}),
          resolvedSourceId: cached.resolvedTrackId ?? sourceId,
          resolvedQuality: cached.resolvedQuality,
        }
      },
      async put({ sourceId, qualityKey, path: filePath, format, sourceFormat, resolvedSourceId, resolvedQuality, requireLossless }) {
        ensureNonemptyString(sourceId, 'cache source ID')
        ensureNonemptyString(qualityKey, 'cache quality key')
        if (resolvedSourceId !== undefined) ensureNonemptyString(resolvedSourceId, 'resolved source ID')
        if (resolvedQuality !== undefined) ensureNonemptyString(resolvedQuality, 'resolved quality')
        ensureFormat(format)
        if (sourceFormat !== undefined) ensureFormat(sourceFormat)
        const realPath = fs.realpathSync.native(filePath)
        if (!isPathInsideRoot(realPath, cacheRoot) || !fs.statSync(realPath).isFile()) {
          throw new Error('Provider audio path is outside its cache root')
        }
        registerStreamingAudioCacheEntry(manifest.id, sourceId, qualityKey, {
          playbackPath: realPath,
          quality: format,
          sourceQuality: sourceFormat,
          resolvedTrackId: resolvedSourceId ?? sourceId,
          resolvedQuality,
          recoveryTrace: [],
        }, requireLossless)
      },
      async trim() { scheduleStreamingAudioCacheTrim(manifest.id) },
    },
    catalog: {
      async getStoredTrack(sourceId) {
        ensureNonemptyString(sourceId, 'catalog source ID')
        return getStoredProviderTrack(getDb(), manifest.id, sourceId)
      },
      async getPlaybackRecoverySeed(sourceId) {
        ensureNonemptyString(sourceId, 'playback source ID')
        return getProviderPlaybackRecoverySeed(getDb(), manifest.id, sourceId)
      },
      async listTracksNeedingFormat(limit) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid format batch limit')
        return listProviderTracksNeedingFormat(getDb(), manifest.id, limit)
      },
      async updateTrackFormat({ sourceId, format }) {
        ensureNonemptyString(sourceId, 'catalog source ID')
        ensureFormat(format)
        updateProviderTrackFormat(getDb(), manifest.id, sourceId, format)
      },
    },
    events: {
      emit,
      async scheduleLibraryCatalogRefreshWhenIdle() { schedulePlaybackIdleRefresh() },
    },
    helpers: {
      async spawn(request) {
        const declaration = manifest.permissions?.helpers?.find((helper) => helper.id === request.binaryId)
        if (!declaration) throw new Error(`Undeclared provider helper: ${request.binaryId}`)
        const args = resolveHelperArguments(declaration, request.args ?? [], cacheRoot)
        const executable = fs.realpathSync.native(path.resolve(sourceRoot, declaration.executable))
        if (!isPathInsideRoot(executable, sourceRoot)) throw new Error('Provider helper path escaped its source root')
        const child = spawn(executable, args, {
          cwd: dataRoot,
          env: providerHelperEnvironment(dataRoot) as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        applyDeclaredHelperPriority(declaration, child.pid)
        const handleId = randomUUID()
        const output = new HelperOutputQueue()
        const state = { child, output, stdinClosed: false }
        helperProcesses.set(handleId, state)
        const enqueue = (type: 'stdout' | 'stderr', data: Buffer) => {
          if (!output.push({ type, data: new Uint8Array(data) })) {
            output.fail('Helper output exceeded the private buffer limit')
            child.kill('SIGTERM')
          }
        }
        child.stdout.on('data', (data: Buffer) => enqueue('stdout', data))
        child.stderr.on('data', (data: Buffer) => enqueue('stderr', data))
        child.once('error', (error) => output.fail(error.message))
        child.once('close', (exitCode, signal) => {
          output.push({ type: 'exit', exitCode, signal })
        })
        return { handleId }
      },
      async write({ handleId, data }) {
        const state = helperProcesses.get(handleId)
        if (!state || state.stdinClosed) throw new Error('Unknown or closed provider helper handle')
        state.child.stdin!.write(typeof data === 'string' ? data : Buffer.from(data))
      },
      async closeStdin(handleId) {
        const state = helperProcesses.get(handleId)
        if (!state || state.stdinClosed) throw new Error('Unknown or closed provider helper handle')
        state.stdinClosed = true
        state.child.stdin!.end()
      },
      async read(handleId) {
        const state = helperProcesses.get(handleId)
        if (!state) throw new Error('Unknown provider helper handle')
        const event = await state.output.read()
        if (event.type === 'exit' || event.type === 'error') helperProcesses.delete(handleId)
        return event
      },
      async terminate(handleId) {
        helperProcesses.get(handleId)?.child.kill('SIGTERM')
      },
    },
    logger: {
      debug: logger('debug'),
      info: logger('info'),
      warn: logger('warn'),
      error: logger('error'),
    },
    async openExternal(url) {
      if (!isAllowedExternalUrl(url, manifest.permissions?.externalOrigins ?? [])) {
        throw new Error(`Provider ${manifest.id} requested an undeclared external origin`)
      }
      await shell.openExternal(url)
    },
    async openAuthWindow(request): Promise<ProviderAuthWindowResultV1> {
      assertAuthRequestAllowed(manifest, request)
      const authSession = session.fromPartition(request.partition)
      // An in-memory sign-in starts empty and is wiped once the window is gone.
      const ephemeral = authPartitionKind(manifest.id, request.partition) === 'memory'
      const wipe = () => authSession.clearStorageData().then(() => authSession.clearCache()).catch(() => {})
      if (ephemeral) await wipe()
      const userAgent = request.userAgent === 'browser' ? browserUserAgent(app.userAgentFallback)
        : request.userAgent === 'firefox' ? FIREFOX_USER_AGENT : undefined
      const authWindow = new BrowserWindow({
        width: 520,
        height: 720,
        show: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          session: authSession,
        },
      })
      authWindows.add(authWindow)
      if (userAgent) authWindow.webContents.setUserAgent(userAgent)
      authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      return await new Promise<ProviderAuthWindowResultV1>((resolve, reject) => {
        let settled = false
        let inspecting = false
        const blockedOrigins = new Set<string>()
        const pollTimer = setInterval(() => { void inspect().catch(fail) }, 1000)
        const timeoutTimer = setTimeout(() => fail(new Error('Provider authorization timed out')), 5 * 60_000)
        const cleanup = () => {
          clearInterval(pollTimer)
          clearTimeout(timeoutTimer)
        }
        const finish = (result: ProviderAuthWindowResultV1) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(result)
        }
        const fail = (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          if (!authWindow.isDestroyed()) authWindow.close()
          reject(error)
        }
        const inspect = async () => {
          if (settled || inspecting || authWindow.isDestroyed()) return
          inspecting = true
          try {
            const origin = authNavigationOrigin(authWindow.webContents.getURL())
            if (!origin || !request.allowedOrigins.includes(origin)) return
            const values = await collectAuthValues(authWindow, request)
            if (request.collect.every(({ name }) => Object.prototype.hasOwnProperty.call(values, name))) {
              finish({ completed: true, values })
              if (!authWindow.isDestroyed()) authWindow.close()
            }
          } finally {
            inspecting = false
          }
        }
        const rejectUndeclaredNavigation = (event: Electron.Event, url: string) => {
          const origin = authNavigationOrigin(url)
          if (origin && request.allowedOrigins.includes(origin)) return
          event.preventDefault()
          const safeOrigin = origin ?? '(non-HTTPS origin)'
          if (blockedOrigins.has(safeOrigin)) return
          blockedOrigins.add(safeOrigin)
          console.warn(`[Puros][Provider:${manifest.id}] Blocked undeclared auth navigation origin: ${safeOrigin}`)
        }
        authWindow.webContents.on('will-navigate', rejectUndeclaredNavigation)
        authWindow.webContents.on('will-redirect', rejectUndeclaredNavigation)
        authWindow.webContents.on('did-navigate', () => { void inspect().catch(fail) })
        authWindow.webContents.on('did-navigate-in-page', () => { void inspect().catch(fail) })
        authWindow.webContents.on('did-finish-load', () => { void inspect().catch(fail) })
        authWindow.on('closed', () => {
          authWindows.delete(authWindow)
          if (ephemeral) {
            // Requests still in flight when the page unloads (beacons) can set cookies after the first wipe.
            void wipe()
            setTimeout(() => { void wipe() }, EPHEMERAL_REWIPE_MS)
          }
          finish({ completed: false, values: {} })
        })
        void (async () => {
          if (request.userAgent === 'firefox') await presentAsFirefox(authWindow)
          if (request.userAgent === 'browser') await presentAsGoogleChrome(authWindow)
          if (!authWindow.isDestroyed()) await authWindow.loadURL(request.url)
        })().catch(fail)
      })
    },
  }

  return {
    host,
    cacheRoot,
    dataRoot,
    async dispose() {
      for (const authWindow of authWindows) if (!authWindow.isDestroyed()) authWindow.close()
      authWindows.clear()
      for (const { child, output } of helperProcesses.values()) {
        output.fail('Provider host was disposed')
        child.kill('SIGTERM')
      }
      helperProcesses.clear()
      developmentSecrets.clear()
    },
  }
}
