import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../../../electron/main/db/schema'
import { CatalogBrowseService } from './CatalogBrowseService'
import { CatalogIngestService } from './CatalogIngestService'
import { CatalogRegistry } from './CatalogRegistry'
import { CatalogSearchService } from './CatalogSearchService'
import type { CatalogProvider } from './CatalogProvider'
import type { CatalogProviderSearchResults } from './types'
import { sourceEntityId } from './sourceIdentity'

const databases: Database.Database[] = []
const folders: string[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })) })
function fixture() {
  const db = new Database(':memory:'); databases.push(db)
  db.pragma('foreign_keys = ON'); initSchema(db, () => {})
  const folder = mkdtempSync(join(tmpdir(), 'purist-provider-')); folders.push(folder)
  const file = join(folder, 'song.flac'); writeFileSync(file, 'fixture')
  db.prepare(`INSERT INTO artists (id, name, normalized_name, genres) VALUES ('local-artist', 'Artist', 'artist', '["Local genre"]')`).run()
  db.prepare(`INSERT INTO albums (id, title, normalized_title, album_artist_id, album_artist_name) VALUES ('local-album', 'Album', 'album', 'local-artist', 'Artist')`).run()
  db.prepare(`INSERT INTO tracks (id, file_path, title, artist_id, album_id, isrc, duration_ms, start_offset_ms, end_offset_ms, cue_sheet_path) VALUES ('local-track', ?, 'Song', 'local-artist', 'local-album', 'IDENTICAL', 100000, 500, 100500, '/music/album.cue')`).run(file)
  const registry = new CatalogRegistry()
  const ingest = new CatalogIngestService({ dbContext: { db, rebuildSearchIndex() {} }, artworkCache: { cacheRemoteArtwork: async () => null }, getLocalCreditGuidanceMode: () => 'local_only', isProviderAvailable: () => true })
  const browse = new CatalogBrowseService({ db, registry, ingest })
  const search = new CatalogSearchService({ db, registry, ingest, browse })
  return { db, registry, ingest, browse, search, file }
}
function results(provider: string): CatalogProviderSearchResults {
  return {
    artists: [{ provider, sourceId: '1', name: 'Artist', genres: [`${provider} genre`], inLibrary: true }],
    albums: [{ provider, sourceId: '2', title: 'Album', primaryArtistSourceId: '1', primaryArtistName: 'Artist', upc: 'SAMEUPC', inLibrary: true }],
    tracks: [{ provider, sourceId: '3', title: 'Song', isrc: 'IDENTICAL', durationMs: 100000, albumSourceId: '2', albumTitle: 'Album', primaryArtistSourceId: '1', primaryArtistName: 'Artist', inLibrary: true }], playlists: [],
  }
}
function plugin(provider: string) {
  const data = results(provider)
  return {
    name: provider,
    capabilities: { search: true, artistProfile: true, artistDiscography: true, albumDetails: true, trackPlayback: true, relatedArtists: true, similarAlbums: false, addToLibrary: false },
    isAuthenticated: vi.fn(async () => true), search: vi.fn(async () => data),
    getArtistBundle: vi.fn(async () => ({ artist: data.artists[0], releases: data.albums, topTracks: data.tracks, relatedArtists: [], playlists: [] })),
    getAlbumBundle: vi.fn(async () => ({ album: data.albums[0], tracks: data.tracks })),
    resolvePlayback: vi.fn(async (catalogTrackId: string, sourceId: string) => ({ catalogTrackId, sourceType: provider, sourceId, provider, id: catalogTrackId, displayMetadataSource: provider, title: 'Song', artist: 'Artist', album: 'Album', duration: 100, streamId: sourceId })),
  } as unknown as CatalogProvider
}
const id = (providerId: string, entityType: 'artist' | 'album' | 'track', sourceId: string) => sourceEntityId({ providerId, entityType, sourceId })

describe('provider-owned catalog', () => {
  it('keeps identical names, UPCs, ISRCs and source IDs separate', async () => {
    const f = fixture(); await f.ingest.rebuildFromLibrarySources()
    await f.ingest.ingestProviderSearchResults(results('tidal')); await f.ingest.ingestProviderSearchResults(results('apple'))
    for (const kind of ['artists', 'albums', 'tracks']) expect(f.db.prepare(`SELECT COUNT(*) as count FROM catalog_${kind}`).get()).toEqual({ count: 3 })
    expect(f.search.browseTracks('tidal').map(t => t.sourceRef)).toEqual([{ providerId: 'tidal', entityType: 'track', sourceId: '3' }])
    expect(f.search.browseGenres('tidal').map(g => g.genre)).toEqual(['tidal genre'])
    expect(f.search.browseArtistsByGenre('apple', 'tidal genre')).toEqual([])
    expect(f.search.searchLocalOnly('local', 'Song').tracks[0].sourceRef.providerId).toBe('local')
  })
  it('searches only the requested plugin and never sends Local searches online', async () => {
    const f = fixture(); const tidal = plugin('tidal'); const apple = plugin('apple'); f.registry.register(tidal); f.registry.register(apple)
    await f.search.searchRemote('tidal', 'Song')
    expect(tidal.search).toHaveBeenCalledOnce(); expect(apple.search).not.toHaveBeenCalled()
    await f.search.searchRemote('local', 'Song')
    expect(tidal.search).toHaveBeenCalledOnce(); expect(apple.search).not.toHaveBeenCalled()
    expect(() => f.search.browse('all')).toThrow('Choose a provider')
  })
  it('loads artist and album sections from their owner only', async () => {
    const f = fixture(); const tidal = plugin('tidal'); const apple = plugin('apple'); f.registry.register(tidal); f.registry.register(apple)
    await f.ingest.ingestProviderSearchResults(results('tidal')); await f.ingest.ingestProviderSearchResults(results('apple'))
    const artist = await f.browse.getArtistPage(id('tidal', 'artist', '1'))
    expect(artist?.releases.every(a => a.sourceRef.providerId === 'tidal')).toBe(true)
    expect(artist?.topTracks.every(t => t.sourceRef.providerId === 'tidal')).toBe(true)
    const album = await f.browse.getAlbumPage(id('tidal', 'album', '2'))
    expect(album?.tracks.map(t => t.id)).toEqual([id('tidal', 'track', '3')])
    expect(apple.getArtistBundle).not.toHaveBeenCalled(); expect(apple.getAlbumBundle).not.toHaveBeenCalled()
  })
  it('plays the exact requested source even when a local equivalent exists', async () => {
    const f = fixture(); const tidal = plugin('tidal'); const apple = plugin('apple'); f.registry.register(tidal); f.registry.register(apple)
    await f.ingest.rebuildFromLibrarySources(); await f.ingest.ingestProviderSearchResults(results('tidal')); await f.ingest.ingestProviderSearchResults(results('apple'))
    expect((await f.browse.resolvePlayback({ providerId: 'tidal', entityType: 'track', sourceId: '3' }))?.provider).toBe('tidal')
    expect(tidal.resolvePlayback).toHaveBeenCalledWith(id('tidal', 'track', '3'), '3'); expect(apple.resolvePlayback).not.toHaveBeenCalled()
    expect(await f.browse.resolvePlayback(id('tidal', 'track', '3'), 'apple', '3')).toBeNull()
    const local = await f.browse.resolvePlayback(id('local', 'track', 'local-track'))
    expect(local).toMatchObject({ provider: 'local', filePath: f.file, startOffsetMs: 500, endOffsetMs: 100500, cueSheetPath: '/music/album.cue' })
    rmSync(f.file)
    expect(await f.browse.resolvePlayback(id('local', 'track', 'local-track'))).toBeNull()
    expect(tidal.resolvePlayback).toHaveBeenCalledOnce()
  })
  it('does not substitute another source when its provider is unavailable', async () => {
    const f = fixture(); const tidal = plugin('tidal'); const apple = plugin('apple'); f.registry.register(tidal); f.registry.register(apple)
    await f.ingest.ingestProviderSearchResults(results('tidal')); await f.ingest.ingestProviderSearchResults(results('apple'))
    vi.mocked(tidal.isAuthenticated).mockResolvedValue(false)
    expect(await f.browse.resolvePlayback(id('tidal', 'track', '3'))).toBeNull()
    expect(apple.resolvePlayback).not.toHaveBeenCalled(); expect(apple.search).not.toHaveBeenCalled()
  })
  it('rejects cross-provider relationships in both ingestion and SQL', async () => {
    const f = fixture(); await f.ingest.ingestProviderSearchResults(results('tidal')); await f.ingest.ingestProviderSearchResults(results('apple'))
    await expect(f.ingest.ingestProviderAlbumBundle({ album: results('tidal').albums[0], tracks: results('apple').tracks })).rejects.toThrow('crosses provider')
    expect(() => f.db.prepare(`INSERT INTO catalog_artist_album_edges (catalog_artist_id, catalog_album_id, provider) VALUES (?, ?, 'tidal')`).run(id('tidal', 'artist', '1'), id('apple', 'album', '2'))).toThrow('crosses providers')
  })
  it('retains another provider’s online catalog through a library rebuild', async () => {
    const f = fixture(); const data = results('tidal'); data.artists[0].inLibrary = false; data.albums[0].inLibrary = false; data.tracks[0].inLibrary = false
    await f.ingest.ingestProviderSearchResults(data); await f.ingest.rebuildFromLibrarySources()
    expect(f.search.browseTracks('tidal', 'all')).toHaveLength(1)
    expect(f.search.browseTracks('tidal', 'library')).toHaveLength(0)
    expect(f.search.browseTracks('local')).toHaveLength(1)
  })
})
