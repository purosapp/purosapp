import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  API_VERSION,
  isProviderApiCompatible,
  ProviderApiError,
  providerError,
  type ProviderHostV1,
  type ProviderManifestV1,
  type ProviderPluginV1,
  type ProviderRuntimeRequestV1,
  type ProviderRuntimeV1,
  type ProviderWireValueV1,
} from '../src/provider-api/v1'
import { generatedRuntimePlugins } from './generated-provider-runtime'
import { ProviderRpcPeer } from './main/providers/rpc'
import { ProviderEventCoalescer } from './main/providers/eventCoalescer'
import { assertProviderValue, validateProviderManifest } from './main/providers/validation'

const HOST_CALL_TIMEOUT_MS = 30_000
const LONG_HOST_CALL_TIMEOUT_MS = 5 * 60_000

function createHostProxy(providerId: string, peer: ProviderRpcPeer): ProviderHostV1 {
  let sequence = 0
  const events = new ProviderEventCoalescer((event) => {
    peer.notify({
      type: 'provider.event', apiVersion: API_VERSION,
      envelope: { apiVersion: API_VERSION, providerId, sequence: ++sequence, event },
    })
  })
  const call = async <T>(namespace: 'settings' | 'secrets' | 'storage' | 'paths' | 'cache' | 'catalog' | 'events' | 'helpers' | 'logger' | 'host', method: string, args: unknown[], timeoutMs = HOST_CALL_TIMEOUT_MS): Promise<T> => {
    return await peer.request({
      type: 'host.request', apiVersion: API_VERSION, requestId: randomUUID(), namespace, method, args: args as ProviderWireValueV1[],
    }, timeoutMs) as T
  }
  const emit: ProviderHostV1['events']['emit'] = async (event) => {
    events.publish(event)
  }
  return {
    apiVersion: API_VERSION,
    providerId,
    settings: {
      get: (key) => call('settings', 'get', [key]),
      set: (key, value) => call('settings', 'set', [key, value]),
      delete: (key) => call('settings', 'delete', [key]),
    },
    secrets: {
      has: (key) => call('secrets', 'has', [key]),
      get: (key) => call('secrets', 'get', [key]),
      set: (key, value) => call('secrets', 'set', [key, value]),
      delete: (key) => call('secrets', 'delete', [key]),
    },
    storage: {
      get: (key) => call('storage', 'get', [key]),
      set: (key, value) => call('storage', 'set', [key, value]),
      delete: (key) => call('storage', 'delete', [key]),
      list: (prefix) => call('storage', 'list', [prefix]),
    },
    paths: {
      getCacheRoot: () => call('paths', 'getCacheRoot', []),
      getDataRoot: () => call('paths', 'getDataRoot', []),
      getResourceRoot: () => call('paths', 'getResourceRoot', []),
    },
    cache: {
      get: (request) => call('cache', 'get', [request]),
      inspectFormat: (path) => call('cache', 'inspectFormat', [path]),
      canPlayFormat: (format) => call('cache', 'canPlayFormat', [format]),
      put: (request) => call('cache', 'put', [request]),
      trim: () => call('cache', 'trim', []),
    },
    catalog: {
      getStoredTrack: (sourceId) => call('catalog', 'getStoredTrack', [sourceId]),
      getPlaybackRecoverySeed: (sourceId) => call('catalog', 'getPlaybackRecoverySeed', [sourceId]),
      listTracksNeedingFormat: (limit) => call('catalog', 'listTracksNeedingFormat', [limit]),
      updateTrackFormat: (request) => call('catalog', 'updateTrackFormat', [request]),
    },
    events: {
      emit,
      scheduleLibraryCatalogRefreshWhenIdle: () => call('events', 'scheduleLibraryCatalogRefreshWhenIdle', []),
    },
    helpers: {
      spawn: (request) => call('helpers', 'spawn', [request]),
      write: (request) => call('helpers', 'write', [request]),
      closeStdin: (handleId) => call('helpers', 'closeStdin', [handleId]),
      read: (handleId) => call('helpers', 'read', [handleId], LONG_HOST_CALL_TIMEOUT_MS),
      terminate: (handleId) => call('helpers', 'terminate', [handleId]),
    },
    logger: {
      debug: (message, fields) => call('logger', 'debug', [message, fields]),
      info: (message, fields) => call('logger', 'info', [message, fields]),
      warn: (message, fields) => call('logger', 'warn', [message, fields]),
      error: (message, fields) => call('logger', 'error', [message, fields]),
    },
    openExternal: (url) => call('host', 'openExternal', [url]),
    openAuthWindow: (request) => call('host', 'openAuthWindow', [request], LONG_HOST_CALL_TIMEOUT_MS),
  }
}

function sameManifest(left: ProviderManifestV1, right: ProviderManifestV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Loads an installed package's compiled entry; main has already verified the path and every file hash. */
async function loadInstalledPlugin(entry: string): Promise<ProviderPluginV1 | undefined> {
  if (!path.isAbsolute(entry) || path.basename(entry) !== 'index.mjs' || path.basename(path.dirname(entry)) !== 'dist') {
    throw new TypeError('Installed provider entry path is invalid')
  }
  const module = await import(/* @vite-ignore */ pathToFileURL(entry).href) as { default?: ProviderPluginV1 }
  return module.default
}

function startRuntime(providerId: string, expectedManifest: ProviderManifestV1, port: Electron.MessagePortMain, plugin: ProviderPluginV1 | undefined): void {
  if (!plugin || !isProviderApiCompatible(plugin) || plugin.apiVersion !== API_VERSION) {
    throw new ProviderApiError(providerError('INCOMPATIBLE_API', 'Provider plugin is missing or incompatible', { retryable: false }))
  }
  const validation = validateProviderManifest(plugin.manifest)
  if (!validation.ok || !sameManifest(plugin.manifest, expectedManifest)) {
    throw new ProviderApiError(providerError('INCOMPATIBLE_API', 'Provider manifest differs from generated definition', { retryable: false }))
  }
  let runtime: ProviderRuntimeV1 | null = null
  const peer = new ProviderRpcPeer(
    port,
    'runtime.request',
    async (message) => {
      if (message.type !== 'runtime.request' || message.providerId !== providerId) {
        throw new ProviderApiError(providerError('INVALID_ARGUMENT', 'Wrong provider process target', { retryable: false }))
      }
      const request: ProviderRuntimeRequestV1 = message
      if (request.action === 'activate') {
        if (runtime) throw new ProviderApiError(providerError('INVALID_ARGUMENT', 'Provider is already active', { retryable: false }))
        runtime = await plugin.activate(createHostProxy(providerId, peer))
        const declared = [...plugin.manifest.capabilities].sort()
        const implemented = Object.keys(runtime.capabilities).sort()
        if (JSON.stringify(declared) !== JSON.stringify(implemented)) {
          await runtime.deactivate()
          runtime = null
          throw new ProviderApiError(providerError('INCOMPATIBLE_API', 'Provider capability implementations differ from manifest', { retryable: false }))
        }
        const status = await runtime.getStatus()
        assertProviderValue(status)
        return status as unknown as ProviderWireValueV1
      }
      if (!runtime) throw new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', 'Provider is not active', { retryable: true }))
      if (request.action === 'getStatus') return await runtime.getStatus() as unknown as ProviderWireValueV1
      if (request.action === 'cancelSession') return await runtime.cancelSession?.(request.sessionId) ?? false
      if (request.action === 'deactivate') {
        await runtime.deactivate()
        runtime = null
        return undefined
      }
      if (!plugin.manifest.capabilities.includes(request.capability)) {
        throw new ProviderApiError(providerError('NOT_SUPPORTED', 'Capability is not declared', { retryable: false }))
      }
      const implementation = runtime.capabilities[request.capability] as unknown as Record<string, unknown> | undefined
      const method = implementation?.[request.method]
      if (typeof method !== 'function') {
        throw new ProviderApiError(providerError('NOT_SUPPORTED', 'Capability method is not implemented', { retryable: false }))
      }
      const result = await method.apply(implementation, request.args) as unknown
      assertProviderValue(result, { allowUndefined: true })
      return result as ProviderWireValueV1
    },
    () => { throw new Error('Utility process cannot receive provider events from main') },
    () => { process.exitCode = 1; peer.close() },
    () => { process.exitCode = 1 },
  )
}

const parentPort = process.parentPort
if (parentPort) {
  parentPort.once('message', (event) => {
    const [port] = event.ports
    const data = event.data as { apiVersion?: unknown; providerId?: unknown; manifest?: unknown; entry?: unknown }
    if (!port || data?.apiVersion !== API_VERSION || typeof data.providerId !== 'string' || (data.entry !== undefined && typeof data.entry !== 'string')) {
      process.exitCode = 1
      return
    }
    void (async () => {
      const providerId = data.providerId as string
      const validation = validateProviderManifest(data.manifest)
      if (!validation.ok || validation.manifest.id !== providerId) throw new TypeError('Invalid provider process handshake')
      // Main decides the origin: an installed package entry, or the bundled generated plugin.
      const plugin = typeof data.entry === 'string' ? await loadInstalledPlugin(data.entry) : generatedRuntimePlugins[providerId]
      startRuntime(providerId, validation.manifest, port, plugin)
    })().catch((error: unknown) => {
      console.error('[Puros][ProviderRuntime] startup failed:', error)
      process.exitCode = 1
      port.close()
    })
  })
}
