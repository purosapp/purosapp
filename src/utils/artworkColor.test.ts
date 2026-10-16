import { describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptorV1 } from '../provider-api/v1'
import type { Track } from '../store/playerStore'
import { resolveHighResolutionArtwork } from './artworkColor'

const savedArtworkUrl = 'https://resources.tidal.com/images/a/b/c/640x640.jpg'
const enlargedArtworkUrl = 'https://resources.tidal.com/images/a/b/c/1280x1280.jpg'

function track(provider: string, url = savedArtworkUrl): Track {
  return {
    id: 'track-1', title: 'Track', artist: 'Artist', album: 'Album', duration: 1,
    provider, coverUrl: 'artwork://cache/small', discordArtworkUrl: url,
  }
}

const descriptor = {
  manifest: { id: 'tidal', capabilities: ['metadata.artwork'] },
  status: { state: 'ready' },
} as ProviderDescriptorV1

describe('high-resolution artwork routing', () => {
  it('asks the owning provider to upgrade an existing saved URL', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, value: enlargedArtworkUrl }))
    expect(await resolveHighResolutionArtwork(track('tidal'), [descriptor], invoke)).toBe(enlargedArtworkUrl)
    expect(invoke).toHaveBeenCalledWith('tidal', 'metadata.artwork', 'getDisplayArtworkUrl', [savedArtworkUrl])
  })

  it('retains the saved URL when the provider is absent or its method fails', async () => {
    const invoke = vi.fn(async () => ({ ok: false as const, error: { code: 'NOT_SUPPORTED' as const, message: '', retryable: false } }))
    expect(await resolveHighResolutionArtwork(track('tidal'), [], invoke)).toBe(savedArtworkUrl)
    expect(invoke).not.toHaveBeenCalled()
    expect(await resolveHighResolutionArtwork(track('tidal'), [descriptor], invoke)).toBe(savedArtworkUrl)
  })

  it('keeps other existing artwork sizing and rejects unsafe provider URLs', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, value: 'file:///private/art.jpg' }))
    const appleArtwork = 'https://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg'
    expect(await resolveHighResolutionArtwork(track('apple', appleArtwork), [], invoke))
      .toBe('https://is1-ssl.mzstatic.com/image/thumb/a/3000x3000bb.jpg')
    expect(await resolveHighResolutionArtwork(track('tidal'), [descriptor], invoke)).toBe(savedArtworkUrl)
  })
})
