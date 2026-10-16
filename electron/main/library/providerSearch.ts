import type { ProviderSearchResultsV1, ProviderTrackV1 } from '../../../src/provider-api/v1'
import { cacheRemoteArtwork } from '../artwork/cache'
import { invokeProvider, listProviderDescriptors } from '../providers'
import { sha256 } from '../shared/normalize'

async function mapRemoteTrack(providerId: string, track: ProviderTrackV1): Promise<Record<string, unknown>> {
  const artworkId = await cacheRemoteArtwork(track.artworkUrl)
  return {
    id: sha256(`${providerId}-search:${track.sourceId}`),
    file_path: `${providerId}://track/${encodeURIComponent(track.sourceId)}`,
    source: providerId,
    source_id: track.sourceId,
    title: track.title,
    track_number: track.trackNumber ?? null,
    disc_number: track.discNumber ?? 1,
    duration: track.durationMs,
    format: track.format?.format ?? null,
    sample_rate: track.format?.sampleRate ?? null,
    bit_depth: track.format?.bitDepth ?? null,
    bitrate: track.format?.bitrate ?? null,
    channels: track.format?.channels ?? null,
    lossless: track.format?.isLossless ? 1 : 0,
    year: null,
    file_size: null,
    modified_at: null,
    has_embedded_art: 0,
    art_hash: null,
    album_id: null,
    artist_id: null,
    artist_name: track.primaryArtistName ?? null,
    album_title: track.albumTitle ?? null,
    album_art_path: null,
    album_artwork_id: artworkId,
  }
}

export async function searchRemoteLibraryTracks(query: string): Promise<Array<Record<string, unknown>>> {
  const descriptors = listProviderDescriptors().filter(({ manifest, status }) => (
    manifest.capabilities.includes('catalog.search')
    && (status.state === 'ready' || status.state === 'degraded')
    && status.authenticated !== false
  ))
  const results = await Promise.all(descriptors.map(async ({ manifest }) => {
    try {
      const response = await invokeProvider(manifest.id, 'catalog.search', 'search', [{ query, limit: 10, types: ['track'] }])
      if (!response.ok) throw new Error(response.error.message)
      const page = response.value as unknown as ProviderSearchResultsV1
      if (!Array.isArray(page?.tracks)) return []
      return await Promise.all(page.tracks.filter((track) => (
        typeof track?.sourceId === 'string' && !!track.sourceId && typeof track.title === 'string'
      )).map((track) => mapRemoteTrack(manifest.id, track)))
    } catch (error) {
      console.warn(`[Puros][Library] ${manifest.id} quick search failed:`, error)
      return []
    }
  }))
  return results.flat()
}
