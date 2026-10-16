import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeProvider, listProviderDescriptors } from '../providers'
import { getProviderCollection, getProviderShelves } from './providerShelves'

const state = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../db', () => ({ getDb: () => state.db }))
vi.mock('../providers', () => ({ invokeProvider: vi.fn(), listProviderDescriptors: vi.fn() }))
vi.mock('../artwork/cache', () => ({
  resolveArtworkCacheUrl: vi.fn(async (url: string | null) => url ? `cached:${url}` : null),
}))

describe('generic provider home mapping', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE playlists (id INTEGER PRIMARY KEY, source TEXT, source_id TEXT);
      CREATE TABLE tracks (
        source TEXT, source_id TEXT, format TEXT, sample_rate INTEGER, bit_depth INTEGER,
        bitrate INTEGER, channels INTEGER, lossless INTEGER, stream_info_fetched_at INTEGER
      );
    `)
    state.db = db
    vi.mocked(invokeProvider).mockReset()
    vi.mocked(listProviderDescriptors).mockReset()
  })

  afterEach(() => { db.close(); state.db = null })

  it('preserves cached shelf artwork and synced playlist IDs from provider-neutral rows', async () => {
    db.prepare(`INSERT INTO playlists (id, source, source_id) VALUES (7, 'service-a', 'playlist-1')`).run()
    vi.mocked(listProviderDescriptors).mockReturnValue([{
      manifest: { id: 'service-a', capabilities: ['catalog.home'] },
      status: { state: 'ready', authenticated: true },
    }] as ReturnType<typeof listProviderDescriptors>)
    vi.mocked(invokeProvider).mockResolvedValue({
      ok: true,
      value: { items: [{
        id: 'featured', title: 'Featured', kind: 'playlists', items: [{
          sourceId: 'playlist-1', title: 'Playlist', artworkUrl: 'https://example.invalid/cover',
          collectionRef: { type: 'playlist', sourceId: 'playlist-1' },
        }],
      }] },
    })

    const shelves = await getProviderShelves()
    expect(shelves[0]?.items[0]).toMatchObject({
      provider: 'service-a', sourceId: 'playlist-1', syncedPlaylistId: 7,
      artworkUrl: 'cached:https://example.invalid/cover',
    })
  })

  it('recovers stored source format and caches collection artwork', async () => {
    db.prepare(`
      INSERT INTO tracks (source, source_id, format, sample_rate, bit_depth, bitrate, channels, lossless, stream_info_fetched_at)
      VALUES ('service-a', 'track-1', 'FLAC_HIRES', 96000, 24, 2500, 2, 1, 123)
    `).run()
    vi.mocked(invokeProvider).mockResolvedValue({
      ok: true,
      value: {
        title: 'Collection', artworkUrl: 'https://example.invalid/collection',
        tracks: [{
          sourceId: 'track-1', title: 'Song', durationMs: 123000,
          artworkUrl: 'https://example.invalid/track',
          providerUrl: 'https://example.invalid/song/track-1', format: null,
        }],
      },
    })

    const collection = await getProviderCollection('service-a', 'playlist', 'playlist-1')
    expect(collection?.artworkUrl).toBe('cached:https://example.invalid/collection')
    expect(collection?.tracks[0]).toMatchObject({
      artworkUrl: 'cached:https://example.invalid/track',
      discordArtworkUrl: 'https://example.invalid/track',
      providerUrl: 'https://example.invalid/song/track-1',
      formatInfo: { format: 'FLAC_HIRES', sampleRate: 96000, bitDepth: 24, isHiRes: true },
    })
  })
})
