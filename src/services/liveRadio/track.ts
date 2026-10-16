import type { Track } from '../../store/playerStore'
import type { FormatInfo } from '../local/formats'
import type { Station } from './types'

function normalizeLiveRadioFormat(codec?: string | null, bitrate?: number | null, url?: string | null): FormatInfo {
  const haystack = `${codec ?? ''} ${url ?? ''}`.toLowerCase()
  const format = haystack.includes('flac')
    ? 'FLAC'
    : haystack.includes('aac') || haystack.includes('m3u8') || haystack.includes('m4a')
      ? 'AAC'
      : 'MP3'
  const normalizedBitrate = Math.max(0, Math.round(Number(bitrate ?? 0)))
  return {
    format,
    sampleRate: 44_100,
    bitDepth: format === 'FLAC' ? 16 : 0,
    bitrate: normalizedBitrate,
    channels: 2,
    isLossless: format === 'FLAC',
    isHiRes: false,
    isMqa: false,
    isDsd: false,
  }
}

export function getStationDefaultStream(station: Station) {
  return station.streams[station.defaultStreamIndex] ?? station.streams[0] ?? null
}

export function stationToTrack(station: Station): Track | null {
  const stream = getStationDefaultStream(station)
  if (!stream?.url) return null
  const formatInfo = normalizeLiveRadioFormat(stream.codec ?? station.codec, stream.bitrate ?? station.bitrate, stream.url)
  return {
    id: `live-radio:${station.id}`,
    title: station.name,
    artist: station.country || station.language || 'Live Radio',
    album: 'Live Radio',
    duration: 0,
    sourceType: 'live-radio',
    sourceId: station.id,
    filePath: stream.url,
    playbackFilePath: stream.url,
    streamId: stream.url,
    provider: 'live-radio',
    coverUrl: station.logoUrl ?? null,
    artworkUrl: station.logoUrl ?? null,
    formatInfo,
    playbackContext: {
      kind: 'live-radio',
      label: station.name,
      stationId: station.id,
    },
  }
}

export function isLiveRadioTrack(track: Pick<Track, 'provider' | 'sourceType'> | null | undefined): boolean {
  const provider = String(track?.provider ?? track?.sourceType ?? '').trim().toLowerCase()
  return provider === 'live-radio'
}
