import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeProvider, listProviderDescriptors } from '../providers'
import { sha256 } from '../shared/normalize'
import { searchRemoteLibraryTracks } from './providerSearch'

vi.mock('../providers', () => ({ invokeProvider: vi.fn(), listProviderDescriptors: vi.fn() }))
vi.mock('../artwork/cache', () => ({ cacheRemoteArtwork: vi.fn(async () => 'artwork-id') }))

describe('provider-neutral library quick search', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('retains the former Tidal row identity and format through track-only catalog search', async () => {
    vi.mocked(listProviderDescriptors).mockReturnValue([{
      manifest: { id: 'tidal', capabilities: ['catalog.search'] },
      status: { state: 'ready', authenticated: true },
    }] as ReturnType<typeof listProviderDescriptors>)
    vi.mocked(invokeProvider).mockResolvedValue({ ok: true, value: {
      artists: [], albums: [], playlists: [], tracks: [{
        sourceId: '123', title: 'Song', durationMs: 120000, discNumber: 1,
        primaryArtistName: 'Artist', albumTitle: 'Album', artworkUrl: 'https://example.invalid/cover',
        format: { format: 'FLAC', sampleRate: 44100, bitDepth: 16, bitrate: 900, channels: 2, isLossless: true, isHiRes: false, isMqa: false, isDsd: false },
      }],
    } })

    expect(await searchRemoteLibraryTracks('Song')).toEqual([expect.objectContaining({
      id: sha256('tidal-search:123'),
      file_path: 'tidal://track/123',
      source: 'tidal', source_id: '123', duration: 120000,
      format: 'FLAC', sample_rate: 44100, bit_depth: 16, lossless: 1,
      album_artwork_id: 'artwork-id',
    })])
    expect(invokeProvider).toHaveBeenCalledWith('tidal', 'catalog.search', 'search', [{ query: 'Song', limit: 10, types: ['track'] }])
  })

  it('does not call absent or unauthenticated providers', async () => {
    vi.mocked(listProviderDescriptors).mockReturnValue([{
      manifest: { id: 'service-a', capabilities: ['catalog.search'] },
      status: { state: 'inactive', authenticated: false },
    }] as ReturnType<typeof listProviderDescriptors>)
    expect(await searchRemoteLibraryTracks('Song')).toEqual([])
    expect(invokeProvider).not.toHaveBeenCalled()
  })
})
