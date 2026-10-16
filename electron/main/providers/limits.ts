import { API_VERSION, PROVIDER_SESSION_ID_PATTERN, isValidProviderId, type ProviderWireMessageV1 } from '../../../src/provider-api/v1'
import { assertProviderValue, validateInvokeInput } from './validation'

export const PROVIDER_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
export const PROVIDER_MAX_EVENTS_PER_SECOND = 30

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/
const HOST_METHODS: Readonly<Record<string, readonly string[]>> = {
  settings: ['get', 'set', 'delete'],
  secrets: ['has', 'get', 'set', 'delete'],
  storage: ['get', 'set', 'delete', 'list'],
  paths: ['getCacheRoot', 'getDataRoot', 'getResourceRoot'],
  cache: ['get', 'inspectFormat', 'canPlayFormat', 'put', 'trim'],
  catalog: ['getStoredTrack', 'getPlaybackRecoverySeed', 'listTracksNeedingFormat', 'updateTrackFormat'],
  events: ['scheduleLibraryCatalogRefreshWhenIdle'],
  helpers: ['spawn', 'write', 'closeStdin', 'read', 'terminate'],
  logger: ['debug', 'info', 'warn', 'error'],
  host: ['openExternal', 'openAuthWindow'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate before dispatch on either side of the process boundary. */
export function assertProviderWireMessage(value: unknown): asserts value is ProviderWireMessageV1 {
  assertProviderValue(value, {
    allowUndefined: true,
    allowUint8Array: true,
    maxBytes: PROVIDER_MAX_MESSAGE_BYTES,
  })
  if (!isRecord(value) || value.apiVersion !== API_VERSION) throw new TypeError('Invalid provider wire version')
  if (value.type === 'provider.event') {
    if (!isRecord(value.envelope) || value.envelope.apiVersion !== API_VERSION
      || typeof value.envelope.providerId !== 'string' || !Number.isSafeInteger(value.envelope.sequence)
      || !isRecord(value.envelope.event) || typeof value.envelope.event.type !== 'string') {
      throw new TypeError('Invalid provider event envelope')
    }
    return
  }
  if (typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)) {
    throw new TypeError('Invalid provider request ID')
  }
  if (value.type === 'runtime.request') {
    if (!isValidProviderId(value.providerId)) throw new TypeError('Invalid provider ID')
    if (value.action === 'invoke') {
      validateInvokeInput(value.providerId, value.capability, value.method, value.args)
    } else if (value.action === 'cancelSession') {
      if (typeof value.sessionId !== 'string' || !PROVIDER_SESSION_ID_PATTERN.test(value.sessionId)) {
        throw new TypeError('Invalid provider session ID')
      }
    } else if (!['activate', 'getStatus', 'deactivate'].includes(String(value.action))) {
      throw new TypeError('Invalid provider runtime action')
    }
    return
  }
  if (value.type === 'host.request') {
    if (typeof value.namespace !== 'string' || !HOST_METHODS[value.namespace]?.includes(String(value.method))
      || !Array.isArray(value.args)) throw new TypeError('Invalid provider host method')
    return
  }
  if (value.type === 'rpc.response') {
    if (!isRecord(value.result) || typeof value.result.ok !== 'boolean') throw new TypeError('Invalid provider RPC response')
    return
  }
  throw new TypeError('Unknown provider wire message')
}

/** A rolling one-second budget; the caller decides whether to coalesce or terminate on overflow. */
export class ProviderEventBudget {
  private timestamps: number[] = []

  admit(now = Date.now()): boolean {
    this.timestamps = this.timestamps.filter((time) => now - time < 1000)
    if (this.timestamps.length >= PROVIDER_MAX_EVENTS_PER_SECOND) return false
    this.timestamps.push(now)
    return true
  }
}
