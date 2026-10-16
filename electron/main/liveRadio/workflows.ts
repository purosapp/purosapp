import {
  type LiveRadioBrowseOptions,
  type Station,
} from '../../../src/services/liveRadio/types'
import { setPlaybackState } from '../playbackCoordinator'
import {
  addCustomLiveRadioStream,
  browseLiveRadioDirectory,
  getLiveRadioDirectoryFilters,
  getMyLiveRadioStations,
  probeLiveRadioStream,
  removeLiveRadioStation,
  saveLiveRadioStation,
} from './directory'
import { fetchIcyNowPlaying } from './nowPlaying'
import {
  sendLiveRadioStatus,
  startLiveRadioNativePlayback,
  stopLiveRadioNativePlayback,
} from './nativePlayback'

export function browseLiveRadio(options?: LiveRadioBrowseOptions) {
  return browseLiveRadioDirectory(options ?? {})
}

export function getLiveRadioFilters() {
  return getLiveRadioDirectoryFilters()
}

export function searchLiveRadio(query: string, limit?: number) {
  const trimmed = String(query ?? '').trim()
  if (!trimmed) return []
  return browseLiveRadioDirectory({ query: trimmed, limit: limit ?? 8, sort: 'popular', hideBroken: true })
}

export function getSavedLiveRadioStations() {
  return getMyLiveRadioStations()
}

export function saveLiveRadio(
  station: Station,
  onChanged: () => void,
) {
  const saved = saveLiveRadioStation(station)
  onChanged()
  return saved
}

export function removeLiveRadio(
  stationId: string,
  onChanged: () => void,
): void {
  removeLiveRadioStation(stationId)
  onChanged()
}

export async function addCustomLiveRadio(
  payload: { url: string; name?: string | null },
  onChanged: () => void,
) {
  const station = await addCustomLiveRadioStream(payload)
  onChanged()
  return station
}

export function probeLiveRadio(url: string) {
  return probeLiveRadioStream(url)
}

export function getLiveRadioNowPlaying(stationId: string, streamUrl: string) {
  return fetchIcyNowPlaying(stationId, streamUrl)
}

export function startLiveRadioPlayback(stationId: string, streamUrl: string) {
  return startLiveRadioNativePlayback(stationId, streamUrl)
}

export function stopLiveRadioPlayback(stationId?: string | null): void {
  stopLiveRadioNativePlayback(stationId ?? null)
  setPlaybackState('stopped')
  sendLiveRadioStatus({
    stationId: stationId ?? '',
    state: 'stopped',
    message: null,
    attempt: 0,
  })
}

export function markLiveRadioPlaybackStarted(stationId: string, streamUrl: string): void {
  sendLiveRadioStatus({
    stationId,
    state: 'playing',
    message: streamUrl,
    attempt: 0,
  })
}
