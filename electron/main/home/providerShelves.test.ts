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
const catalog = vi.hoisted(() => ({
  ingested: [] as Array<{ provider: string; sourceId: string; playable?: boolean; unavailableReason?: string | null }>,
}))
vi.mock('../catalog/services', () => ({
  ensureCatalogReady: vi.fn(async () => {}),
  getCatalogIngestService: () => ({
    ingestProviderTrack: vi.fn(async (track: { provider: string; sourceId: string; playable?: boolean; unavailableReason?: string | null }) => {
      catalog.ingested.push(track)
      return `catalog-track:${track.sourceId}`
    }),
  }),
  getCatalogBrowseService: () => ({
    getTrackSummary: (id: string) => ({ albumId: `${id}:album`, primaryArtistId: `${id}:artist` }),
  }),
}))

describe('generic provider home mapping', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE playlists (id INTEGER PRIMARY KEY, source TEXT, source_id TEXT);
      CREATE TABLE tracks (
        source TEXT, source_id TEXT, format TEXT, sample_rate INTEGER, bit_depth INTEGER,
        bitrate INTEGER, channels INTEGER, lossless INTEGER, stream_info_fetched_at INTEGER,
        unavailable_reason TEXT
      );
      CREATE TABLE catalog_track_sources (provider TEXT, source_id TEXT, unavailable_reason TEXT);
    `)
    state.db = db
    vi.mocked(invokeProvider).mockReset()
    vi.mocked(listProviderDescriptors).mockReset()
    catalog.ingested.length = 0
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

  it('greys collection tracks the listing or an earlier playback marked unavailable', async () => {
    db.exec(`
      INSERT INTO tracks (source, source_id, unavailable_reason) VALUES ('service-a', 'stored', 'region'), ('service-a', 'cleared', 'region');
      INSERT INTO catalog_track_sources (provider, source_id, unavailable_reason) VALUES ('service-a', 'catalog-only', 'removed');
    `)
    const track = (sourceId: string, extra: Record<string, unknown> = {}) => ({ sourceId, title: sourceId, durationMs: 1000, ...extra })
    vi.mocked(invokeProvider).mockResolvedValue({
      ok: true,
      value: {
        title: 'Collection',
        tracks: [
          track('listed', { playable: false, unavailableReason: 'subscription' }),
          track('listed-no-reason', { playable: false }),
          track('stored'),
          track('catalog-only'),
          track('cleared', { playable: true }),
          track('fine'),
        ],
      },
    })

    const collection = await getProviderCollection('service-a', 'playlist', 'playlist-1')
    expect(collection?.tracks.map((row) => [row.sourceId, row.unavailableReason])).toEqual([
      ['listed', 'subscription'],
      ['listed-no-reason', 'other'],
      ['stored', 'region'],
      ['catalog-only', 'removed'],
      ['cleared', null],
      ['fine', null],
    ])
    // The catalog keeps the reason this view settled on, not just what the listing said.
    expect(catalog.ingested.map((row) => [row.sourceId, row.playable, row.unavailableReason])).toEqual([
      ['listed', false, 'subscription'],
      ['listed-no-reason', false, 'other'],
      ['stored', false, 'region'],
      ['catalog-only', false, 'removed'],
      ['cleared', true, null],
      ['fine', undefined, null],
    ])
  })

  it('links collection tracks to their catalog artist and album', async () => {
    vi.mocked(invokeProvider).mockResolvedValue({
      ok: true,
      value: {
        title: 'Collection',
        tracks: [{
          sourceId: 'track-1', title: 'Song', durationMs: 1000,
          primaryArtistName: 'Artist', primaryArtistSourceId: 'artist-1', albumTitle: 'Album', albumSourceId: 'album-1',
        }],
      },
    })

    const collection = await getProviderCollection('service-a', 'playlist', 'playlist-1')
    expect(catalog.ingested[0]).toMatchObject({ provider: 'service-a', sourceId: 'track-1', albumSourceId: 'album-1' })
    expect(collection?.tracks[0]).toMatchObject({
      catalogTrackId: 'catalog-track:track-1',
      catalogAlbumId: 'catalog-track:track-1:album',
      catalogArtistId: 'catalog-track:track-1:artist',
    })
  })
})
