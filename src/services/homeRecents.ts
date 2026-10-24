import type { Track } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import { deleteSetting, getJsonSetting, setJsonSetting } from '../utils/appSettings'

const RECENTLY_PLAYED_KEY = 'home:recentlyPlayed'
const RECENTLY_PLAYED_PLAYLISTS_KEY = 'home:recentlyPlayedPlaylists'
const MAX_RECENTLY_PLAYED = 40
const MAX_RECENTLY_PLAYED_PLAYLISTS = 20
export const HOME_RECENTS_CHANGED_EVENT = 'puros:home-recents-changed'

export interface RecentPlayedEntry {
  playedAt: number
  track: Track
}

export interface RecentPlaylistEntry {
  playedAt: number
  entryKind?: 'local-playlist' | 'provider-playlist'
  playlistId?: number | null
  name: string
  artworkId: string | null
  artworkUrl: string | null
  source: string
  trackCount: number
  provider?: string | null
  sourceType?: 'playlist' | 'mix' | 'station' | null
  sourceId?: string | null
  itemId?: string | null
  subtitle?: string | null
  providerUrl?: string | null
  syncedPlaylistId?: number | null
}

function isVisibleRecentSource(source: string | null | undefined, availableProviders: ReadonlySet<string>, showUnavailable: boolean): boolean {
  return showUnavailable || !source || source === 'local' || source === 'live-radio' || availableProviders.has(source)
}

export function filterVisibleRecentTracks(
  entries: RecentPlayedEntry[],
  availableProviders: ReadonlySet<string>,
  showUnavailable: boolean,
): RecentPlayedEntry[] {
  return entries.filter(({ track }) => isVisibleRecentSource(
    track.provider ?? track.sourceType,
    availableProviders,
    showUnavailable,
  ))
}

export function filterVisibleRecentPlaylists(
  entries: RecentPlaylistEntry[],
  availableProviders: ReadonlySet<string>,
  showUnavailable: boolean,
): RecentPlaylistEntry[] {
  return entries.filter((entry) => isVisibleRecentSource(
    entry.entryKind === 'provider-playlist' ? entry.provider ?? entry.source : entry.source,
    availableProviders,
    showUnavailable,
  ))
}

function isRecentProviderPlaylistEntry(row: RecentPlaylistEntry | null | undefined): row is RecentPlaylistEntry {
  return (
    typeof row?.name === 'string' &&
    row.entryKind === 'provider-playlist' &&
    typeof row?.provider === 'string' &&
    typeof row?.sourceType === 'string' &&
    typeof row?.sourceId === 'string' &&
    typeof row?.itemId === 'string'
  )
}

function isRecentLocalPlaylistEntry(row: RecentPlaylistEntry | null | undefined): row is RecentPlaylistEntry {
  return typeof row?.playlistId === 'number' && typeof row?.name === 'string'
}

export function getRecentPlaylistDedupeKey(entry: Pick<
  RecentPlaylistEntry,
  'entryKind' | 'playlistId' | 'provider' | 'sourceType' | 'sourceId' | 'itemId'
>) {
  if (entry.entryKind === 'provider-playlist') {
    return `provider:${entry.provider ?? ''}:${entry.sourceType ?? ''}:${entry.sourceId ?? ''}:${entry.itemId ?? ''}`
  }
  return `local:${entry.playlistId ?? 'missing'}`
}

function isProviderPlaylistRecent(
  entry: RecentPlaylistEntry,
): entry is RecentPlaylistEntry & {
  entryKind: 'provider-playlist'
  provider: string
  sourceType: 'playlist' | 'mix' | 'station'
  sourceId: string
  itemId: string
} {
  return (
    entry.entryKind === 'provider-playlist' &&
    typeof entry.provider === 'string' &&
    typeof entry.sourceType === 'string' &&
    typeof entry.sourceId === 'string' &&
    typeof entry.itemId === 'string'
  )
}

/** Shows a recently played playlist: its synced local copy when there is one, else the provider collection. */
export function openRecentPlaylist(playlist: RecentPlaylistEntry): void {
  const { openProviderCollection, setActiveView } = useAppShellStore.getState()
  if (isProviderPlaylistRecent(playlist)) {
    if (typeof playlist.syncedPlaylistId === 'number') {
      setActiveView(playlist.syncedPlaylistId)
      return
    }

    openProviderCollection({
      id: playlist.itemId,
      provider: playlist.provider,
      sourceType: playlist.sourceType,
      sourceId: playlist.sourceId,
      title: playlist.name,
      subtitle: playlist.subtitle ?? null,
      artworkUrl: playlist.artworkUrl ?? null,
      providerUrl: playlist.providerUrl ?? null,
      trackCount: playlist.trackCount ?? null,
      syncedPlaylistId: playlist.syncedPlaylistId ?? null,
    })
    return
  }

  if (typeof playlist.playlistId === 'number') {
    setActiveView(playlist.playlistId)
  }
}

function emitHomeRecentsChanged() {
  window.dispatchEvent(new Event(HOME_RECENTS_CHANGED_EVENT))
}

export async function loadRecentlyPlayed(): Promise<RecentPlayedEntry[]> {
  const rows = await getJsonSetting<RecentPlayedEntry[]>(RECENTLY_PLAYED_KEY, [])
  return Array.isArray(rows)
    ? rows.filter((row): row is RecentPlayedEntry => !!row?.track?.id && typeof row?.playedAt === 'number')
    : []
}

export async function recordRecentlyPlayed(track: Track): Promise<void> {
  const prev = await loadRecentlyPlayed()
  const dedupeKey = `${track.provider ?? 'local'}:${track.streamId ?? track.filePath ?? track.id}`
  const next: RecentPlayedEntry[] = [
    {
      playedAt: Date.now(),
      track,
    },
    ...prev.filter((entry) => `${entry.track.provider ?? 'local'}:${entry.track.streamId ?? entry.track.filePath ?? entry.track.id}` !== dedupeKey),
  ].slice(0, MAX_RECENTLY_PLAYED)

  await setJsonSetting(RECENTLY_PLAYED_KEY, next)
  emitHomeRecentsChanged()
}

export async function loadRecentlyPlayedPlaylists(): Promise<RecentPlaylistEntry[]> {
  const rows = await getJsonSetting<RecentPlaylistEntry[]>(RECENTLY_PLAYED_PLAYLISTS_KEY, [])
  return Array.isArray(rows)
    ? rows.filter((row): row is RecentPlaylistEntry => isRecentLocalPlaylistEntry(row) || isRecentProviderPlaylistEntry(row))
    : []
}

export async function recordRecentlyPlayedPlaylist(playlist: {
  playlistId?: number | null
  name: string
  artworkId?: string | null
  artworkUrl?: string | null
  source?: string
  trackCount?: number
  entryKind?: 'local-playlist' | 'provider-playlist'
  provider?: string | null
  sourceType?: 'playlist' | 'mix' | 'station' | null
  sourceId?: string | null
  itemId?: string | null
  subtitle?: string | null
  providerUrl?: string | null
  syncedPlaylistId?: number | null
}): Promise<void> {
  const prev = await loadRecentlyPlayedPlaylists()
  const nextEntry: RecentPlaylistEntry = {
    playedAt: Date.now(),
    entryKind: playlist.entryKind ?? 'local-playlist',
    playlistId: playlist.playlistId ?? null,
    name: playlist.name,
    artworkId: playlist.artworkId ?? null,
    artworkUrl: playlist.artworkUrl ?? null,
    source: playlist.source ?? 'local',
    trackCount: playlist.trackCount ?? 0,
    provider: playlist.provider ?? null,
    sourceType: playlist.sourceType ?? null,
    sourceId: playlist.sourceId ?? null,
    itemId: playlist.itemId ?? null,
    subtitle: playlist.subtitle ?? null,
    providerUrl: playlist.providerUrl ?? null,
    syncedPlaylistId: playlist.syncedPlaylistId ?? null,
  }
  const nextDedupeKey = getRecentPlaylistDedupeKey(nextEntry)
  const next: RecentPlaylistEntry[] = [
    nextEntry,
    ...prev.filter((entry) => getRecentPlaylistDedupeKey(entry) !== nextDedupeKey),
  ].slice(0, MAX_RECENTLY_PLAYED_PLAYLISTS)

  await setJsonSetting(RECENTLY_PLAYED_PLAYLISTS_KEY, next)
  emitHomeRecentsChanged()
}

export async function clearRecentlyPlayedHistory(): Promise<void> {
  await Promise.all([
    deleteSetting(RECENTLY_PLAYED_KEY),
    deleteSetting(RECENTLY_PLAYED_PLAYLISTS_KEY),
  ])
  emitHomeRecentsChanged()
}
