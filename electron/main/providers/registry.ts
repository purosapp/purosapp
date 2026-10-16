import {
  API_VERSION,
  PROVIDER_SESSION_ID_PATTERN,
  ProviderApiError,
  providerError,
  type ProviderCapabilityV1,
  type ProviderDescriptorV1,
  type ProviderErrorV1,
  type ProviderEventEnvelopeV1,
  type ProviderManifestV1,
  type ProviderResultV1,
  type ProviderRuntimeV1,
  type ProviderStatusV1,
  type ProviderValueV1,
} from '../../../src/provider-api/v1'
import type { ProviderHostController } from './ProviderHost'
import { assertProviderValue, toProviderError, validatePlaybackArtifact } from './validation'
import fs from 'node:fs'
import path from 'node:path'

export interface ProviderRegistryEntry {
  manifest: ProviderManifestV1
  status: ProviderStatusV1
  runtime: ProviderRuntimeV1 | null
  hostController: ProviderHostController | null
  iconUrl?: string
}

type ProviderEventListener = (event: ProviderEventEnvelopeV1) => void

function normalizeProviderError(error: unknown): ProviderErrorV1 {
  const typed = toProviderError(error)
  if (typed) return typed
  if (error instanceof Error && error.name === 'AbortError') {
    return providerError('CANCELLED', error.message || 'Provider operation was cancelled', { retryable: true })
  }
  if (error instanceof Error && /timed out/i.test(error.message)) {
    return providerError('TIMEOUT', error.message, { retryable: true })
  }
  return providerError('INTERNAL', error instanceof Error ? error.message : 'Provider operation failed', { retryable: false })
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    operation.then(resolve, reject).finally(() => clearTimeout(timeout))
  })
}

export function resolveProviderCallTimeoutMs(
  manifest: ProviderManifestV1,
  capability: ProviderCapabilityV1,
  method: string,
  override?: number,
): number {
  if (override !== undefined) return override
  if (capability === 'auth' && method === 'login') return 5 * 60_000
  if (capability === 'library.sync' || (capability === 'catalog.entities' && method === 'getArtistGenres')) return 15 * 60_000
  if (capability.startsWith('playback.')) return manifest.playbackTimeoutMs ?? 2 * 60_000
  return 30_000
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderRegistryEntry>()
  private readonly listeners = new Set<ProviderEventListener>()

  addManifest(manifest: ProviderManifestV1, providerRoot?: string): void {
    if (this.entries.has(manifest.id)) throw new Error(`Duplicate provider ID: ${manifest.id}`)
    let iconUrl: string | undefined
    if (providerRoot) {
      const iconPath = path.resolve(providerRoot, manifest.icon)
      const relative = path.relative(providerRoot, iconPath)
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(iconPath)) {
        const icon = fs.readFileSync(iconPath)
        if (icon.byteLength <= 256 * 1024) iconUrl = `data:image/svg+xml;base64,${icon.toString('base64')}`
      }
    }
    this.entries.set(manifest.id, {
      manifest,
      iconUrl,
      runtime: null,
      hostController: null,
      status: { state: 'inactive', updatedAt: Date.now() },
    })
  }

  setActivating(providerId: string): void {
    this.updateStatus(providerId, { state: 'activating', updatedAt: Date.now() })
  }

  setRuntime(providerId: string, runtime: ProviderRuntimeV1, hostController: ProviderHostController): void {
    const entry = this.requireEntry(providerId)
    entry.runtime = runtime
    entry.hostController = hostController
  }

  updateStatus(providerId: string, status: ProviderStatusV1): void {
    const entry = this.requireEntry(providerId)
    entry.status = structuredClone(status)
    this.emit({
      apiVersion: API_VERSION,
      providerId,
      sequence: 0,
      event: { type: 'status.changed', status: entry.status },
    })
  }

  markError(providerId: string, error: unknown): void {
    this.updateStatus(providerId, {
      state: 'error',
      updatedAt: Date.now(),
      error: normalizeProviderError(error),
    })
  }

  receiveEvent(envelope: ProviderEventEnvelopeV1): void {
    if (envelope.event.type === 'status.changed') {
      this.requireEntry(envelope.providerId).status = structuredClone(envelope.event.status)
    }
    this.emit(envelope)
  }

  subscribe(listener: ProviderEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): ProviderDescriptorV1[] {
    return [...this.entries.values()]
      .map(({ manifest, status, iconUrl }) => ({
        manifest: structuredClone(manifest),
        status: structuredClone(status),
        ...(iconUrl ? { iconUrl } : {}),
      }))
      .sort((left, right) => left.manifest.defaultPriority - right.manifest.defaultPriority || left.manifest.id.localeCompare(right.manifest.id))
  }

  getStatus(providerId: string): ProviderStatusV1 {
    return structuredClone(this.requireEntry(providerId).status)
  }

  has(providerId: string): boolean {
    return this.entries.has(providerId)
  }

  getEntry(providerId: string): ProviderRegistryEntry {
    return this.requireEntry(providerId)
  }

  async refreshStatus(providerId: string, timeoutMs = 5_000): Promise<ProviderStatusV1> {
    const entry = this.requireReadyEntry(providerId)
    try {
      const status = await withTimeout(entry.runtime.getStatus(), timeoutMs, `${providerId}.getStatus`)
      assertProviderValue(status)
      this.updateStatus(providerId, status)
    } catch (error) {
      this.markError(providerId, error)
    }
    return this.getStatus(providerId)
  }

  async invoke(
    providerId: string,
    capability: ProviderCapabilityV1,
    method: string,
    args: ProviderValueV1[],
    timeoutMs?: number,
  ): Promise<ProviderResultV1<ProviderValueV1 | undefined>> {
    try {
      const entry = this.requireReadyEntry(providerId)
      if (!entry.manifest.capabilities.includes(capability)) {
        return { ok: false, error: providerError('NOT_SUPPORTED', `${providerId} does not declare ${capability}`, { retryable: false }) }
      }
      const implementation = entry.runtime.capabilities[capability] as unknown as Record<string, unknown> | undefined
      const methodValue = implementation?.[method]
      if (typeof methodValue !== 'function') {
        return { ok: false, error: providerError('NOT_SUPPORTED', `${capability}.${method} is not implemented`, { retryable: false }) }
      }
      const effectiveTimeoutMs = resolveProviderCallTimeoutMs(entry.manifest, capability, method, timeoutMs)
      const rawResult = await withTimeout(
        Promise.resolve(methodValue.apply(implementation, args)),
        effectiveTimeoutMs,
        `${providerId}:${capability}.${method}`,
      ) as unknown
      assertProviderValue(rawResult, { allowUndefined: true })
      let result = rawResult as ProviderValueV1 | undefined
      if ((capability === 'playback.resolve' && method === 'resolve') || (capability === 'playback.prefetch' && method === 'prefetch' && result !== null)) {
        result = validatePlaybackArtifact(
          rawResult as never,
          entry.hostController.cacheRoot,
          entry.manifest.capabilities.includes('playback.progressive'),
        ) as unknown as ProviderValueV1
      }
      return { ok: true, value: result }
    } catch (error) {
      return { ok: false, error: normalizeProviderError(error) }
    }
  }

  async cancelSession(providerId: string, sessionId: string): Promise<ProviderResultV1<boolean>> {
    try {
      if (!PROVIDER_SESSION_ID_PATTERN.test(sessionId)) {
        return { ok: false, error: providerError('INVALID_ARGUMENT', 'Invalid provider session ID', { retryable: false }) }
      }
      const entry = this.requireReadyEntry(providerId)
      if (!entry.manifest.capabilities.some((capability) => capability.startsWith('playback.'))) {
        return { ok: false, error: providerError('NOT_SUPPORTED', `${providerId} has no playback capability`, { retryable: false }) }
      }
      if (!entry.runtime.cancelSession) return { ok: true, value: false }
      const cancelled = await withTimeout(entry.runtime.cancelSession(sessionId), 5_000, `${providerId}.cancelSession`)
      if (typeof cancelled !== 'boolean') throw new TypeError('Provider cancelSession must return a boolean')
      return { ok: true, value: cancelled }
    } catch (error) {
      return { ok: false, error: normalizeProviderError(error) }
    }
  }

  async deactivate(providerId: string, timeoutMs = 5_000): Promise<void> {
    const entry = this.requireEntry(providerId)
    const runtime = entry.runtime
    entry.runtime = null
    if (runtime) {
      try {
        await withTimeout(Promise.resolve(runtime.deactivate()), timeoutMs, `${providerId}.deactivate`)
      } catch (error) {
        console.warn(`[Puros][Provider:${providerId}] deactivate failed:`, error)
      }
    }
    await entry.hostController?.dispose().catch((error) => {
      console.warn(`[Puros][Provider:${providerId}] host cleanup failed:`, error)
    })
    entry.hostController = null
    this.updateStatus(providerId, { state: 'inactive', updatedAt: Date.now() })
  }

  /** Forgets a deactivated provider (disabled or code removed); its imported data stays in SQLite. */
  remove(providerId: string): void {
    const entry = this.entries.get(providerId)
    if (!entry) return
    if (entry.runtime || entry.hostController) throw new Error(`Provider ${providerId} must be deactivated before removal`)
    this.entries.delete(providerId)
  }

  async deactivateAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((providerId) => this.deactivate(providerId)))
  }

  private requireEntry(providerId: string): ProviderRegistryEntry {
    const entry = this.entries.get(providerId)
    if (!entry) throw new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', `Provider is not installed: ${providerId}`, { retryable: false }))
    return entry
  }

  private requireReadyEntry(providerId: string): ProviderRegistryEntry & { runtime: ProviderRuntimeV1; hostController: ProviderHostController } {
    const entry = this.requireEntry(providerId)
    if (!entry.runtime || !entry.hostController || (entry.status.state !== 'ready' && entry.status.state !== 'degraded')) {
      throw new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', `Provider is not ready: ${providerId}`, { retryable: true }))
    }
    return entry as ProviderRegistryEntry & { runtime: ProviderRuntimeV1; hostController: ProviderHostController }
  }

  private emit(event: ProviderEventEnvelopeV1): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)) } catch (error) { console.warn('[Puros][Providers] Event listener failed:', error) }
    }
  }
}
