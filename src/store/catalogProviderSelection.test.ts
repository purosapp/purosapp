import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceEntityId } from '../services/catalog/sourceIdentity'
import type { CatalogSearchResults, CatalogArtistPage } from '../services/catalog/types'
const empty = (): CatalogSearchResults => ({ artists: [], albums: [], tracks: [], playlists: [] })
const storage = new Map<string, string>()
beforeEach(() => {
  vi.resetModules(); storage.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
})
afterEach(() => vi.unstubAllGlobals())
describe('provider browsing state', () => {
  it('shares and persists provider selection without changing the playing queue', async () => {
    vi.stubGlobal('window', { puros: { catalog: {} } })
    const { useCatalogStore } = await import('./catalogStore')
    const { usePlayerStore } = await import('./playerStore')
    const song = { id: 'local-song', title: 'Song', artist: 'Artist', album: 'Album', duration: 100, provider: 'local', filePath: '/song.flac' }
    usePlayerStore.setState({ currentTrack: song, queue: [song] })
    expect(useCatalogStore.getState().activeProviderId).toBe('local')
    useCatalogStore.getState().setProvider('tidal', { browse: false })
    expect(storage.get('catalog:activeProvider')).toBe('tidal')
    expect(usePlayerStore.getState().currentTrack).toBe(song)
    expect(usePlayerStore.getState().queue).toEqual([song])
  })
  it('ignores delayed search responses after a provider switch', async () => {
    let resolveOld!: (results: CatalogSearchResults) => void
    const searchLocal = vi.fn((provider: string) => provider === 'local' ? new Promise<CatalogSearchResults>(resolve => { resolveOld = resolve }) : Promise.resolve(empty()))
    vi.stubGlobal('window', { puros: { catalog: { searchLocal, searchRemote: vi.fn(async () => empty()) } } })
    const { useCatalogStore } = await import('./catalogStore')
    const old = useCatalogStore.getState().search('old query')
    useCatalogStore.getState().setProvider('tidal', { browse: false })
    await useCatalogStore.getState().search('new query')
    resolveOld({ ...empty(), playlists: [{ id: 'old', provider: 'local', sourceId: 'old', title: 'Stale result', artworkUrl: null, trackCount: 0, providerUrl: null }] })
    await old
    expect(useCatalogStore.getState()).toMatchObject({ activeProviderId: 'tidal', query: 'new query', results: empty() })
    expect(searchLocal.mock.calls).toEqual([['local', 'old query', 12, 'all'], ['tidal', 'new query', 12, 'all']])
  })
  it('restores provider selection with navigation history', async () => {
    vi.stubGlobal('window', { puros: { catalog: {} } })
    const { useCatalogStore } = await import('./catalogStore')
    useCatalogStore.getState().setProvider('tidal', { browse: false })
    useCatalogStore.getState().setProvider('apple', { browse: false })
    useCatalogStore.getState().goBack()
    expect(useCatalogStore.getState().activeProviderId).toBe('tidal')
    expect(storage.get('catalog:activeProvider')).toBe('tidal')
  })
  it('opens a source-specific profile from a pin or playlist in its owner provider', async () => {
    const ref = { providerId: 'tidal', entityType: 'artist' as const, sourceId: 'artist-1' }
    const artist: CatalogArtistPage = { sourceRef: ref, id: sourceEntityId(ref), name: 'Artist', normalizedName: 'artist', artworkUrl: null, artworkId: null, availability: { inLibrary: true, availableProviderIds: ['tidal'], playable: true, unavailableReason: null }, sourceLinks: [], albumCount: 0, trackCount: 0, bio: null, bioSource: null, bioUrl: null, genres: [], topTracks: [], releases: [], playlists: [], relatedArtists: [], localAlbums: [], appearsOn: [], credits: [], roleSummary: [], collaborators: [] }
    vi.stubGlobal('window', { puros: { catalog: {
      getArtistPreview: vi.fn(async () => artist), getArtist: vi.fn(async () => artist),
      getArtistReleases: vi.fn(async () => []), getArtistTopTracks: vi.fn(async () => []), getArtistRelated: vi.fn(async () => []), getArtistPlaylists: vi.fn(async () => []),
    } } })
    const { useCatalogStore } = await import('./catalogStore')
    await useCatalogStore.getState().openArtist(artist.id)
    expect(useCatalogStore.getState().activeProviderId).toBe('tidal')
    expect(useCatalogStore.getState().currentArtist?.id).toBe(artist.id)
  })
})
