import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderLibraryRecordV1, ProviderManifestV1 } from '../../../src/provider-api/v1'
import { initSchema } from '../db/schema'
import { mirrorProviderLibrary } from './libraryMirror'
import { ProviderLibrarySyncCoordinator } from './librarySync'
import type { ProviderRegistry } from './registry'

const artist: ProviderLibraryRecordV1 = { type: 'artist', value: { sourceId: 'a', name: 'Artist' } }
const track: ProviderLibraryRecordV1 = { type: 'track', value: { sourceId: 't', title: 'Track', durationMs: 1_000 } }

function fixture(responses: unknown[], managed = true) {
  const manifest = { id: 'service-a', capabilities: ['library.sync'], ...(managed ? { librarySyncMode: 'host-mirror' } : {}) } as ProviderManifestV1
  // A host storage that enforces the real provider key rule, so a core write routed through it would fail.
  const storageSet = vi.fn(async (key: string) => { if (!/^[a-z][a-z0-9._-]{0,63}$/.test(key)) throw new TypeError(`Invalid provider key: ${key}`) })
  const invoke = vi.fn(async (..._args: unknown[]) => {
    const next = responses.shift()
    if (next && typeof next === 'object' && !Array.isArray(next) && 'error' in next) {
      return { ok: false as const, error: { code: 'NETWORK' as const, message: String(next.error), retryable: true } }
    }
    return { ok: true as const, value: next }
  })
  const registry = {
    has: (id: string) => id === manifest.id,
    getEntry: () => ({ manifest, hostController: { host: { storage: { set: storageSet } } } }),
    getStatus: () => ({ state: 'ready', authenticated: true, updatedAt: 1 }),
    list: () => [{ manifest, status: { state: 'ready', authenticated: true, updatedAt: 1 } }],
    invoke,
  } as unknown as ProviderRegistry
  const db = new Database(':memory:')
  initSchema(db, () => {})
  const coordinator = new ProviderLibrarySyncCoordinator(registry)
  const afterSync = vi.fn(async () => {})
  coordinator.configure({ getDb: () => db, cacheArtwork: async () => null, afterSync })
  return { coordinator, db, invoke, afterSync, storageSet }
}

describe('host-managed provider library sync', () => {
  it('coalesces callers and commits only after all pages complete', async () => {
    const test = fixture([
      { records: [artist], nextCursor: 'next', complete: false },
      { records: [track], nextCursor: null, complete: true, checkpoint: 123 },
    ])
    try {
      const first = test.coordinator.sync('service-a')
      const second = test.coordinator.sync('service-a')
      expect(second).toBe(first)
      expect(await first).toMatchObject({ ok: true, value: { complete: true, checkpoint: 123 } })
      expect(test.invoke).toHaveBeenCalledTimes(2)
      expect(test.invoke.mock.calls[1]?.[3]).toEqual([{ cursor: 'next', limit: 100 }])
      expect(test.db.prepare(`SELECT id FROM artists WHERE source = 'service-a'`).get()).toBeDefined()
      expect(test.db.prepare(`SELECT id FROM tracks WHERE source = 'service-a'`).get()).toBeDefined()
      expect(test.storageSet).not.toHaveBeenCalled()
      expect(test.db.prepare(`SELECT value FROM provider_kv WHERE provider = 'service-a' AND key = 'lastSyncAt'`).get()).toEqual({ value: '123' })
      expect(test.afterSync).toHaveBeenCalledOnce()
    } finally { test.db.close() }
  })

  it('asks for a full resync on the first page only when the sync was requested as one', async () => {
    const test = fixture([
      { records: [artist], nextCursor: 'next', complete: false },
      { records: [track], nextCursor: null, complete: true },
      { records: [artist, track], nextCursor: null, complete: true },
    ])
    try {
      expect((await test.coordinator.sync('service-a', { fullResync: true })).ok).toBe(true)
      expect(test.invoke.mock.calls[0]?.[3]).toEqual([{ cursor: null, limit: 100, fullResync: true }])
      expect(test.invoke.mock.calls[1]?.[3]).toEqual([{ cursor: 'next', limit: 100 }])
      expect((await test.coordinator.sync('service-a')).ok).toBe(true)
      expect(test.invoke.mock.calls[2]?.[3]).toEqual([{ cursor: null, limit: 100 }])
    } finally { test.db.close() }
  })

  it('keeps populated rows untouched when a later page fails or repeats a cursor', async () => {
    for (const second of [{ error: 'offline' }, { records: [], nextCursor: 'next', complete: false }]) {
      const test = fixture([
        { records: [track], nextCursor: 'next', complete: false },
        second,
      ])
      try {
        await mirrorProviderLibrary(test.db, 'service-a', [artist], async () => null)
        expect((await test.coordinator.sync('service-a')).ok).toBe(false)
        expect(test.db.prepare(`SELECT name FROM artists WHERE source = 'service-a'`).get()).toEqual({ name: 'Artist' })
        expect(test.db.prepare(`SELECT 1 FROM tracks WHERE source = 'service-a'`).get()).toBeUndefined()
        expect(test.afterSync).not.toHaveBeenCalled()
      } finally { test.db.close() }
    }
  })

  it('does not mirror legacy side-effect adapters without manifest opt-in', async () => {
    const test = fixture([{ records: [], nextCursor: null, complete: true }], false)
    try {
      expect((await test.coordinator.sync('service-a')).ok).toBe(false)
      expect(test.invoke).not.toHaveBeenCalled()
    } finally { test.db.close() }
  })

  it('abandons a complete snapshot when logout/reset cancels during artwork preparation', async () => {
    const test = fixture([{
      records: [{ type: 'album', value: { sourceId: 'album', title: 'Album', artworkUrl: 'https://example.invalid/art.jpg' } }],
      nextCursor: null,
      complete: true,
      checkpoint: 123,
    }])
    let enterArtwork!: () => void
    let releaseArtwork!: () => void
    const artworkStarted = new Promise<void>((resolve) => { enterArtwork = resolve })
    const artworkReleased = new Promise<void>((resolve) => { releaseArtwork = resolve })
    test.coordinator.configure({
      getDb: () => test.db,
      cacheArtwork: async () => { enterArtwork(); await artworkReleased; return null },
      afterSync: test.afterSync,
    })
    try {
      const pending = test.coordinator.sync('service-a')
      await artworkStarted
      test.coordinator.cancelPending()
      releaseArtwork()
      expect((await pending).ok).toBe(false)
      expect(test.db.prepare(`SELECT 1 FROM albums WHERE source = 'service-a'`).get()).toBeUndefined()
      expect(test.storageSet).not.toHaveBeenCalled()
      expect(test.afterSync).not.toHaveBeenCalled()
    } finally { test.db.close() }
  })
})
