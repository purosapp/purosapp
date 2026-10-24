import type Database from 'better-sqlite3'
import {
  providerError,
  type ProviderLibraryRecordV1,
  type ProviderLibrarySyncPageV1,
  type ProviderResultV1,
  type ProviderValueV1,
} from '../../../src/provider-api/v1'
import { applyProviderLibraryUrls, mirrorProviderLibrary } from './libraryMirror'
import type { ProviderRegistry } from './registry'

const PAGE_LIMIT = 100
/** Same provider_kv row the legacy settings migration writes. */
const CHECKPOINT_KEY = 'lastSyncAt'

/**
 * The completed-sync checkpoint is core bookkeeping, so core writes it directly.
 * Routing it through the provider-facing `host.storage` applied that API's
 * lowercase key rule and rejected `lastSyncAt` after the library had already
 * been mirrored.
 */
function writeLibrarySyncCheckpoint(db: Database.Database, providerId: string, checkpoint: ProviderValueV1): void {
  db.prepare(`
    INSERT INTO provider_kv (provider, key, value, updated_at)
    VALUES (?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(provider, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(providerId, CHECKPOINT_KEY, JSON.stringify(checkpoint))
}
const MAX_PAGES = 5_000
const MAX_RECORDS = 500_000

export interface ProviderLibrarySyncDeps {
  getDb(): Database.Database
  cacheArtwork(url: string | null | undefined): Promise<string | null>
  beforeSync?(providerId: string): void
  afterSync(providerId: string): Promise<void>
}

function asPage(value: ProviderValueV1 | undefined): ProviderLibrarySyncPageV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid library sync page')
  const page = value as unknown as ProviderLibrarySyncPageV1
  if (!Array.isArray(page.records) || typeof page.complete !== 'boolean') throw new TypeError('Invalid library sync page')
  if (page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new TypeError('Invalid library cursor')
  if (page.complete !== (page.nextCursor === null)) throw new TypeError('Inconsistent library completion marker')
  for (const record of page.records) {
    if (!record || typeof record !== 'object' || !('value' in record) || !record.value || typeof record.value !== 'object') {
      throw new TypeError('Invalid library record')
    }
    if (!['artist', 'album', 'track', 'playlist', 'playlistFolder', 'playlistTrack'].includes(record.type)) {
      throw new TypeError('Invalid library record type')
    }
    if (record.type !== 'playlistTrack' && typeof record.value.sourceId !== 'string') throw new TypeError('Invalid library source ID')
    if (record.type === 'playlistTrack' && (
      typeof record.value.playlistSourceId !== 'string' || typeof record.value.trackSourceId !== 'string'
    )) throw new TypeError('Invalid playlist membership')
  }
  return page
}

/** The only core writer for providers that declare host-mirror library sync. */
export class ProviderLibrarySyncCoordinator {
  private deps: ProviderLibrarySyncDeps | null = null
  private readonly pending = new Map<string, Promise<ProviderResultV1<ProviderLibrarySyncPageV1>>>()
  private generation = 0

  constructor(private readonly registry: ProviderRegistry) {}

  configure(deps: ProviderLibrarySyncDeps): void { this.deps = deps }

  isHostManaged(providerId: string): boolean {
    return this.registry.has(providerId)
      && this.registry.getEntry(providerId).manifest.librarySyncMode === 'host-mirror'
  }

  getPending(providerId: string): Promise<unknown> | null { return this.pending.get(providerId) ?? null }

  getAnyPending(): Promise<unknown> | null { return this.pending.values().next().value ?? null }

  cancelPending(): void { this.generation += 1 }

  async waitFor(providerId: string): Promise<void> {
    const pending = this.pending.get(providerId)
    if (pending) await pending.catch(() => {})
  }

  async waitForAll(): Promise<void> {
    await Promise.all([...this.pending.values()].map((operation) => operation.catch(() => {})))
  }

  /** `fullResync` asks the provider not to reuse its own recent results (a user-requested sync). */
  sync(providerId: string, options: { fullResync?: boolean } = {}): Promise<ProviderResultV1<ProviderLibrarySyncPageV1>> {
    const pending = this.pending.get(providerId)
    if (pending) return pending
    const operation = this.run(providerId, options.fullResync === true)
    this.pending.set(providerId, operation)
    void operation.finally(() => {
      if (this.pending.get(providerId) === operation) this.pending.delete(providerId)
    })
    return operation
  }

  /**
   * Syncs every ready host-mirror provider; one failing does not stop the rest.
   * `skipSyncedWithinMs` leaves out providers whose last completed sync is that
   * recent (the boot sync: a full snapshot per provider on every launch costs
   * minutes of provider work and a catalog rebuild each).
   */
  async syncReadyManagedProviders(options: { skipSyncedWithinMs?: number } = {}): Promise<number> {
    let count = 0
    const failures: string[] = []
    for (const descriptor of this.registry.list()) {
      const providerId = descriptor.manifest.id
      if (!this.isHostManaged(providerId)) continue
      if (!['ready', 'degraded'].includes(descriptor.status.state) || descriptor.status.authenticated === false) continue
      if (options.skipSyncedWithinMs && this.syncedWithin(providerId, options.skipSyncedWithinMs)) continue
      const result = await this.sync(providerId)
      if (!result.ok) {
        failures.push(`${providerId}: ${result.error.message}`)
        continue
      }
      count += 1
    }
    if (failures.length > 0) throw new Error(failures.join('; '))
    return count
  }

  private syncedWithin(providerId: string, ms: number): boolean {
    if (!this.deps) return false
    const row = this.deps.getDb().prepare(`
      SELECT updated_at FROM provider_kv WHERE provider = ? AND key = ?
    `).get(providerId, CHECKPOINT_KEY) as { updated_at: number } | undefined
    return !!row && Date.now() - row.updated_at * 1000 < ms
  }

  private async run(providerId: string, fullResync = false): Promise<ProviderResultV1<ProviderLibrarySyncPageV1>> {
    if (!this.isHostManaged(providerId)) {
      return { ok: false, error: providerError('NOT_SUPPORTED', 'Provider does not declare host-managed library sync', { retryable: false }) }
    }
    if (!this.deps) {
      return { ok: false, error: providerError('INTERNAL', 'Library sync host is not configured', { retryable: false }) }
    }
    const generation = this.generation
    const deps = this.deps
    try {
      deps.beforeSync?.(providerId)
      const records: ProviderLibraryRecordV1[] = []
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      let checkpoint: ProviderValueV1 | undefined
      let complete = false
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
        if (generation !== this.generation) throw new Error('Library sync was cancelled')
        const request: { [key: string]: ProviderValueV1 } = { cursor, limit: PAGE_LIMIT }
        if (cursor === null && fullResync) request.fullResync = true
        const response = await this.registry.invoke(providerId, 'library.sync', 'enumerate', [request])
        if (!response.ok) return response
        const page = asPage(response.value)
        records.push(...page.records)
        if (records.length > MAX_RECORDS) throw new Error('Library snapshot exceeds the record limit')
        if (page.complete) {
          complete = true
          checkpoint = page.checkpoint
          break
        }
        if (!page.nextCursor || seenCursors.has(page.nextCursor)) throw new Error('Library cursor did not advance')
        seenCursors.add(page.nextCursor)
        cursor = page.nextCursor
      }
      if (!complete) throw new Error('Library snapshot exceeded the page limit')
      if (generation !== this.generation) throw new Error('Library sync was cancelled')
      const status = this.registry.getStatus(providerId)
      if (!['ready', 'degraded'].includes(status.state) || status.authenticated === false) {
        throw new Error('Provider became unavailable before library commit')
      }
      await mirrorProviderLibrary(deps.getDb(), providerId, records, deps.cacheArtwork, () => {
        if (generation !== this.generation) return false
        const current = this.registry.getStatus(providerId)
        return ['ready', 'degraded'].includes(current.state) && current.authenticated !== false
      })
      if (checkpoint !== undefined) writeLibrarySyncCheckpoint(deps.getDb(), providerId, checkpoint)
      await deps.afterSync(providerId)
      // After the catalog rebuild the source rows exist; give them the provider's links.
      applyProviderLibraryUrls(deps.getDb(), providerId, records)
      return { ok: true, value: { records: [], nextCursor: null, complete: true, ...(checkpoint !== undefined ? { checkpoint } : {}) } }
    } catch (error) {
      return { ok: false, error: providerError(
        generation !== this.generation ? 'CANCELLED' : 'INTERNAL',
        error instanceof Error ? error.message : 'Library sync failed',
        { retryable: true },
      ) }
    }
  }
}
