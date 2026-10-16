import type {
  ProviderAlbumV1,
  ProviderArtistV1,
  ProviderHomeCollectionV1,
  ProviderHomeShelfV1,
  ProviderPlaylistV1,
  ProviderTrackV1,
} from '../../../src/provider-api/v1'
import type {
  HomeProviderCollectionBundle,
  HomeProviderCollectionItem,
  HomeProviderShelf,
  HomeProviderTrack,
} from '../../../src/services/homeProviderShelves'
import type { FormatInfo } from '../../../src/services/local/formats'
import { resolveArtworkCacheUrl } from '../artwork/cache'
import { getDb } from '../db'
import { invokeProvider, listProviderDescriptors } from '../providers'

function asPlaylist(item: ProviderHomeShelfV1['items'][number]): ProviderPlaylistV1 | null {
  return 'editable' in item || 'description' in item || 'trackCount' in item && !('durationMs' in item)
    ? item as ProviderPlaylistV1
    : null
}

function asAlbum(item: ProviderHomeShelfV1['items'][number]): ProviderAlbumV1 | null {
  return 'totalTracks' in item || 'releaseType' in item ? item as ProviderAlbumV1 : null
}

function asTrack(item: ProviderHomeShelfV1['items'][number]): ProviderTrackV1 | null {
  return 'durationMs' in item ? item as ProviderTrackV1 : null
}

function asArtist(item: ProviderHomeShelfV1['items'][number]): ProviderArtistV1 | null {
  return 'name' in item && !('title' in item) ? item as ProviderArtistV1 : null
}

function syncedPlaylistId(providerId: string, sourceId: string): number | null {
  const row = getDb().prepare(`
    SELECT id FROM playlists WHERE source = ? AND source_id = ? LIMIT 1
  `).get(providerId, sourceId) as { id: number } | undefined
  return row?.id ?? null
}

function mapShelfItem(providerId: string, shelf: ProviderHomeShelfV1, item: ProviderHomeShelfV1['items'][number]): HomeProviderCollectionItem | null {
  const playlist = asPlaylist(item)
  const album = asAlbum(item)
  const track = asTrack(item)
  const artist = asArtist(item)
  const collectionRef = ('collectionRef' in item ? item.collectionRef : undefined) ?? shelf.collectionRef
  const sourceType = collectionRef?.type ?? (playlist ? 'playlist' : null)
  const sourceId = collectionRef?.sourceId ?? item.sourceId
  if (!sourceType) return null

  return {
    id: `${providerId}:${shelf.id}:${item.sourceId}`,
    provider: providerId,
    sourceType,
    sourceId,
    title: playlist?.title ?? album?.title ?? track?.title ?? artist?.name ?? ('title' in item ? item.title : undefined) ?? 'Untitled',
    subtitle: playlist?.description ?? album?.primaryArtistName ?? track?.primaryArtistName ?? null,
    description: playlist?.description ?? null,
    artworkUrl: item.artworkUrl ?? null,
    providerUrl: item.providerUrl ?? null,
    trackCount: playlist?.trackCount ?? album?.totalTracks ?? null,
    syncedPlaylistId: sourceType === 'playlist' ? syncedPlaylistId(providerId, sourceId) : null,
  }
}

function mapTrack(providerId: string, track: ProviderTrackV1, storedFormat: FormatInfo | null): HomeProviderTrack {
  return {
    id: `${providerId}:${track.sourceId}`,
    provider: providerId,
    sourceId: track.sourceId,
    title: track.title,
    artist: track.primaryArtistName ?? 'Unknown Artist',
    album: track.albumTitle ?? 'Unknown Album',
    duration: Math.round(track.durationMs / 1000),
    artworkUrl: track.artworkUrl ?? null,
    providerUrl: track.providerUrl ?? null,
    trackNumber: track.trackNumber ?? null,
    formatInfo: track.format ?? storedFormat,
  }
}

function storedTrackFormats(providerId: string, sourceIds: string[]): Map<string, FormatInfo> {
  const formats = new Map<string, FormatInfo>()
  for (let offset = 0; offset < sourceIds.length; offset += 400) {
    const batch = sourceIds.slice(offset, offset + 400)
    const rows = getDb().prepare(`
      SELECT source_id, format, sample_rate, bit_depth, bitrate, channels, lossless, stream_info_fetched_at
      FROM tracks WHERE source = ? AND source_id IN (${batch.map(() => '?').join(', ')})
    `).all(providerId, ...batch) as Array<{
      source_id: string
      format: string | null
      sample_rate: number | null
      bit_depth: number | null
      bitrate: number | null
      channels: number | null
      lossless: number | null
      stream_info_fetched_at: number | null
    }>
    for (const row of rows) {
      if (!row.stream_info_fetched_at || !row.format) continue
      formats.set(row.source_id, {
        format: row.format as FormatInfo['format'],
        sampleRate: row.sample_rate ?? 0,
        bitDepth: row.bit_depth ?? 0,
        bitrate: row.bitrate ?? 0,
        channels: row.channels ?? 2,
        isLossless: !!row.lossless,
        isHiRes: (row.bit_depth ?? 0) > 16 || (row.sample_rate ?? 0) > 48_000,
        isMqa: row.format === 'MQA',
        isDsd: row.format === 'DSD',
        dsdRate: row.format === 'DSD' ? (row.sample_rate ?? undefined) : undefined,
      })
    }
  }
  return formats
}

export async function getProviderShelves(): Promise<HomeProviderShelf[]> {
  const descriptors = listProviderDescriptors().filter(({ manifest, status }) => (
    manifest.capabilities.includes('catalog.home')
    && (status.state === 'ready' || status.state === 'degraded')
    && status.authenticated !== false
  ))
  const results = await Promise.all(descriptors.map(async ({ manifest }) => {
    const response = await invokeProvider(manifest.id, 'catalog.home', 'getShelves', [{}])
    if (!response.ok || !response.value || typeof response.value !== 'object') return []
    const page = response.value as unknown as { items?: ProviderHomeShelfV1[] }
    return Promise.all((page.items ?? []).map(async (shelf) => ({
      id: `${manifest.id}:${shelf.id}`,
      provider: manifest.id,
      title: shelf.title,
      subtitle: null,
      items: (await Promise.all(shelf.items.map(async (item) => {
        const mapped = mapShelfItem(manifest.id, shelf, item)
        return mapped ? { ...mapped, artworkUrl: await resolveArtworkCacheUrl(mapped.artworkUrl) } : null
      }))).filter((item): item is HomeProviderCollectionItem => !!item),
    })))
  }))
  return results.flat().filter((shelf) => shelf.items.length > 0)
}

export async function getProviderCollection(
  providerId: string,
  sourceType: 'playlist' | 'mix' | 'station',
  sourceId: string,
): Promise<HomeProviderCollectionBundle | null> {
  const response = await invokeProvider(providerId, 'catalog.home', 'getCollection', [{ type: sourceType, sourceId }])
  if (!response.ok || !response.value || typeof response.value !== 'object') return null
  const collection = response.value as unknown as ProviderHomeCollectionV1
  const formats = storedTrackFormats(providerId, [...new Set(collection.tracks.map((track) => track.sourceId))])
  return {
    provider: providerId,
    sourceType,
    sourceId,
    title: collection.title,
    subtitle: collection.subtitle ?? null,
    description: collection.subtitle ?? null,
    artworkUrl: await resolveArtworkCacheUrl(collection.artworkUrl),
    providerUrl: null,
    tracks: await Promise.all(collection.tracks.map(async (track) => {
      const mapped = mapTrack(providerId, track, formats.get(track.sourceId) ?? null)
      return {
        ...mapped,
        discordArtworkUrl: mapped.artworkUrl,
        artworkUrl: await resolveArtworkCacheUrl(mapped.artworkUrl),
      }
    })),
  }
}
