import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeProvider } from '../providers'
import { fetchOfficialArtistGenreMap } from './officialGenres'

vi.mock('../providers', () => ({ invokeProvider: vi.fn() }))

describe('provider official artist genre batches', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('deduplicates source IDs and returns normalized provider genres', async () => {
    vi.mocked(invokeProvider).mockResolvedValue({ ok: true, value: { 'artist-1': ['Rock', 'Rock'], 'artist-2': [] } })
    const genres = await fetchOfficialArtistGenreMap('service-a', [' artist-1 ', 'artist-1', 'artist-2'])
    expect(invokeProvider).toHaveBeenCalledWith('service-a', 'catalog.entities', 'getArtistGenres', [['artist-1', 'artist-2']])
    expect(genres?.get('artist-1')).toEqual(['Rock'])
    expect(genres?.has('artist-2')).toBe(false)
  })

  it('returns null when the optional method is absent', async () => {
    vi.mocked(invokeProvider).mockResolvedValue({
      ok: false,
      error: { code: 'NOT_SUPPORTED', message: 'not implemented', retryable: false },
    })
    expect(await fetchOfficialArtistGenreMap('service-b', ['artist-1'])).toBeNull()
  })
})
