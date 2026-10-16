import { useEffect, useMemo, useState } from 'react'
import type { HomeProviderCollectionItem, HomeProviderShelf } from '../services/homeProviderShelves'
import {
  HOME_RECENTS_CHANGED_EVENT,
  filterVisibleRecentPlaylists,
  filterVisibleRecentTracks,
  loadRecentlyPlayed,
  loadRecentlyPlayedPlaylists,
  type RecentPlayedEntry,
  type RecentPlaylistEntry,
} from '../services/homeRecents'
import { useSettingsStore } from '../store/settingsStore'
import { useProviderStatusStore } from '../store/providerStatusStore'
import { usePlayerStore } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import ProviderBadge from './ProviderBadge'
import ListeningActivity from './ListeningActivity'

const COLLAPSED_RECENTS_COUNT = 3

function formatPlayedAt(timestamp: number) {
  const deltaMs = Date.now() - timestamp
  const deltaMinutes = Math.max(1, Math.round(deltaMs / 60000))
  if (deltaMinutes < 60) return `${deltaMinutes} min ago`
  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours} hr ago`
  const deltaDays = Math.round(deltaHours / 24)
  return `${deltaDays} day${deltaDays === 1 ? '' : 's'} ago`
}

function resolveCover(entry: RecentPlayedEntry) {
  return entry.track.coverUrl ?? entry.track.artworkUrl ?? null
}

function resolveProvider(entry: RecentPlayedEntry) {
  return entry.track.provider ?? 'local'
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

type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'night'

function getGreetingPeriod(hour: number): GreetingPeriod {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 23) return 'evening'
  return 'night'
}

function hashGreetingSeed(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0)
}

function getGreeting(name: string, seedBucket: string) {
  const displayName = name.trim() || 'there'
  const now = new Date()
  const hour = now.getHours()
  const period = getGreetingPeriod(hour)
  const daySeed = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`

  const variants: Record<GreetingPeriod, string[]> = {
    morning: [
      `Good morning, ${displayName}`,
      `Morning, ${displayName}`,
      `Ready for a fresh start, ${displayName}?`,
      `A bright one for you, ${displayName}`,
      `Rise and shine, ${displayName}`,
    ],
    afternoon: [
      `Good afternoon, ${displayName}`,
      `Nice to see you, ${displayName}`,
      `Hope your day sounds good, ${displayName}`,
      `Back at it, ${displayName}`,
      `Hope the afternoon treats you well, ${displayName}`,
    ],
    evening: [
      `Good evening, ${displayName}`,
      `Evening, ${displayName}`,
      `Time to press play, ${displayName}`,
      `Settling in, ${displayName}?`,
      `An evening session for you, ${displayName}`,
    ],
    night: [
      `Working late, ${displayName}?`,
      `Late session, ${displayName}`,
      `Still up, ${displayName}`,
      `A quiet one tonight, ${displayName}`,
      `Burning the midnight oil, ${displayName}?`,
    ],
  }

  const pool = variants[period]
  const seedValue = hashGreetingSeed(`${period}:${displayName}:${daySeed}:${seedBucket}`)
  return pool[seedValue % pool.length]
}

function ProviderShelfRow({
  shelf,
  onOpenCollection,
  expanded,
  onToggleExpanded,
}: {
  shelf: HomeProviderShelf
  onOpenCollection: (item: HomeProviderCollectionItem) => void
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const visibleItems = expanded ? shelf.items : shelf.items.slice(0, COLLAPSED_RECENTS_COUNT)

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{shelf.title}</h2>
            <ProviderBadge provider={shelf.provider} compact />
          </div>
          {shelf.subtitle ? (
            <p className="mt-1 text-xs text-zinc-500 max-w-2xl">{shelf.subtitle}</p>
          ) : null}
        </div>
        {shelf.items.length > COLLAPSED_RECENTS_COUNT && (
          <button
            onClick={onToggleExpanded}
            className="shrink-0 text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {visibleItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onOpenCollection(item)}
            className="w-full text-left flex items-center gap-3 p-3 rounded-2xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/10 transition-colors"
          >
            {item.artworkUrl ? (
              <img
                src={item.artworkUrl}
                alt=""
                className="w-16 h-16 rounded-xl object-cover shrink-0 bg-zinc-900"
              />
            ) : (
              <div className="w-16 h-16 rounded-xl shrink-0 bg-zinc-900 flex items-center justify-center text-zinc-600 text-lg font-semibold">
                {item.title.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <ProviderBadge provider={item.provider} compact />
                <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">
                  {item.sourceType === 'station' ? 'Station' : item.sourceType === 'mix' ? 'Mix' : 'Playlist'}
                </span>
              </div>
              <p className="mt-2 text-sm text-zinc-100 truncate">{item.title}</p>
              {item.subtitle ? (
                <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{item.subtitle}</p>
              ) : null}
              {item.trackCount ? (
                <p className="mt-2 text-[11px] text-zinc-600">{item.trackCount} tracks</p>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

export default function Home() {
  const [recentEntries, setRecentEntries] = useState<RecentPlayedEntry[]>([])
  const [recentPlaylists, setRecentPlaylists] = useState<RecentPlaylistEntry[]>([])
  const [providerShelves, setProviderShelves] = useState<HomeProviderShelf[]>([])
  const [expandedProviderShelves, setExpandedProviderShelves] = useState<Record<string, boolean>>({})
  const [showAllPlaylists, setShowAllPlaylists] = useState(false)
  const [showAllSongs, setShowAllSongs] = useState(false)
  const [showAllAlbums, setShowAllAlbums] = useState(false)
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id)
  const setQueue = usePlayerStore((s) => s.setQueue)
  const homeDisplayName = useSettingsStore((s) => s.homeDisplayName)
  const showUnavailableSources = useSettingsStore((s) => s.showUnavailableSources)
  const providerDescriptors = useProviderStatusStore((state) => state.providers)
  const hasHomeProvider = useProviderStatusStore((state) => state.providers.some(({ manifest, status }) => (
    manifest.capabilities.includes('catalog.home')
    && (status.state === 'ready' || status.state === 'degraded')
    && status.authenticated !== false
  )))
  const providerEvents = useProviderStatusStore((state) => state.latestEvents)
  const openProviderCollection = useAppShellStore((s) => s.openProviderCollection)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const setActiveView = useAppShellStore((s) => s.setActiveView)

  useEffect(() => {
    const load = async () => {
      const [tracks, playlists] = await Promise.all([
        loadRecentlyPlayed(),
        loadRecentlyPlayedPlaylists(),
      ])
      setRecentEntries(tracks)
      setRecentPlaylists(playlists)
    }
    void load()

    const handleChange = () => { void load() }
    window.addEventListener(HOME_RECENTS_CHANGED_EVENT, handleChange)
    return () => window.removeEventListener(HOME_RECENTS_CHANGED_EVENT, handleChange)
  }, [currentTrackId])

  useEffect(() => {
    let cancelled = false

    const loadShelves = async () => {
      if (!hasHomeProvider) {
        if (!cancelled) setProviderShelves([])
        return
      }

      try {
        const shelves = await window.puros.home.getProviderShelves()
        if (!cancelled) setProviderShelves(shelves.filter((shelf) => shelf.items.length > 0))
      } catch (error) {
        console.warn('[Puros][Home] Failed to load provider shelves:', error)
        if (!cancelled) setProviderShelves([])
      }
    }

    void loadShelves()
    const offPlaylistsChanged = window.puros.on('playlists:changed', () => { void loadShelves() })
    return () => {
      cancelled = true
      offPlaylistsChanged()
    }
  }, [hasHomeProvider, providerEvents])

  const [greetingBucket, setGreetingBucket] = useState(() => {
    const now = new Date()
    return `${now.getHours()}-${Math.floor(now.getMinutes() / 15)}`
  })

  useEffect(() => {
    const updateBucket = () => {
      const now = new Date()
      setGreetingBucket(`${now.getHours()}-${Math.floor(now.getMinutes() / 15)}`)
    }

    const interval = window.setInterval(updateBucket, 60_000)
    return () => window.clearInterval(interval)
  }, [])

  const availableProviderIds = useMemo(() => new Set(providerDescriptors
    .filter(({ status }) => (status.state === 'ready' || status.state === 'degraded') && status.authenticated !== false)
    .map(({ manifest }) => manifest.id)), [providerDescriptors])
  const visibleRecentEntries = useMemo(
    () => filterVisibleRecentTracks(recentEntries, availableProviderIds, showUnavailableSources),
    [recentEntries, availableProviderIds, showUnavailableSources],
  )
  const availableRecentPlaylists = useMemo(
    () => filterVisibleRecentPlaylists(recentPlaylists, availableProviderIds, showUnavailableSources),
    [recentPlaylists, availableProviderIds, showUnavailableSources],
  )

  const recentAlbums = useMemo(() => {
    const seen = new Set<string>()
    return visibleRecentEntries.filter((entry) => {
      const key = `${resolveProvider(entry)}:${entry.track.catalogAlbumId ?? `${entry.track.album}:${entry.track.artist}`}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [visibleRecentEntries])

  const visibleRecentPlaylists = useMemo(
    () => showAllPlaylists ? availableRecentPlaylists : availableRecentPlaylists.slice(0, COLLAPSED_RECENTS_COUNT),
    [availableRecentPlaylists, showAllPlaylists],
  )
  const visibleRecentSongs = useMemo(
    () => showAllSongs ? visibleRecentEntries : visibleRecentEntries.slice(0, COLLAPSED_RECENTS_COUNT),
    [visibleRecentEntries, showAllSongs],
  )
  const visibleRecentAlbums = useMemo(
    () => showAllAlbums ? recentAlbums : recentAlbums.slice(0, COLLAPSED_RECENTS_COUNT),
    [recentAlbums, showAllAlbums],
  )

  const greeting = useMemo(
    () => getGreeting(homeDisplayName, greetingBucket),
    [greetingBucket, homeDisplayName],
  )

  const handleOpenRecentPlaylist = (playlist: RecentPlaylistEntry) => {
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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-10">
        <section className="rounded-[28px] border border-white/5 bg-gradient-to-br from-white/[0.06] via-white/[0.03] to-transparent p-8">
          <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Home</p>
          <h1 className="mt-3 text-4xl font-semibold text-zinc-100">{greeting}</h1>
          <p className="mt-3 max-w-2xl text-sm text-zinc-400">
            Pick up where you left off, jump back into recently played music, or head into Explore to browse your whole library and connected providers.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => setActiveView('explore')}
              className="px-4 py-2 rounded-xl bg-white text-zinc-950 text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Open Explore
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Recently Played Playlists</h2>
            {availableRecentPlaylists.length > COLLAPSED_RECENTS_COUNT && (
              <button
                onClick={() => setShowAllPlaylists((value) => !value)}
                className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                {showAllPlaylists ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
          {availableRecentPlaylists.length === 0 ? (
            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-5 text-sm text-zinc-500">
              Open or play a playlist and it will appear here.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visibleRecentPlaylists.map((playlist) => (
                <button
                  key={`${playlist.entryKind ?? 'local-playlist'}:${playlist.playlistId ?? playlist.itemId ?? playlist.name}:${playlist.playedAt}`}
                  onClick={() => handleOpenRecentPlaylist(playlist)}
                  className="text-left flex items-center gap-3 p-3 rounded-2xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/10 transition-colors"
                >
                  {playlist.artworkUrl ? (
                    <img
                      src={playlist.artworkUrl}
                      alt=""
                      className="w-16 h-16 rounded-xl object-cover shrink-0 bg-zinc-900"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-xl shrink-0 bg-zinc-900 flex items-center justify-center text-zinc-600 text-lg font-semibold">
                      {playlist.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-100 truncate">{playlist.name}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <ProviderBadge provider={playlist.source || 'local'} compact />
                      <span className="text-[11px] text-zinc-500">{playlist.trackCount} tracks</span>
                    </div>
                    <p className="text-[11px] text-zinc-600 mt-2">{formatPlayedAt(playlist.playedAt)}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Recently Played Songs</h2>
            {visibleRecentEntries.length > COLLAPSED_RECENTS_COUNT && (
              <button
                onClick={() => setShowAllSongs((value) => !value)}
                className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                {showAllSongs ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
          {visibleRecentEntries.length === 0 ? (
            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-5 text-sm text-zinc-500">
              Start playing music and your recent tracks will appear here.
            </div>
          ) : (
            <div className="rounded-2xl border border-white/5 overflow-hidden">
              <table className="w-full">
                <thead className="bg-white/[0.03]">
                  <tr className="text-[11px] uppercase tracking-wider text-zinc-500">
                    <th className="text-left px-4 py-3 font-medium">Title</th>
                    <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Artist</th>
                    <th className="text-right px-4 py-3 font-medium">Played</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecentSongs.map((entry) => (
                    <tr
                      key={`${entry.track.id}:${entry.playedAt}`}
                      onClick={() => setQueue([entry.track], 0)}
                      className="border-t border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="min-w-0">
                          <p className="text-sm text-zinc-100 truncate">{entry.track.title}</p>
                          <div className="flex items-center gap-2 mt-1 min-w-0">
                            <ProviderBadge provider={resolveProvider(entry)} compact className="shrink-0" />
                            {entry.track.catalogAlbumId ? (
                              <button
                                className="text-xs text-zinc-500 hover:text-zinc-300 truncate transition-colors"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void openCatalogAlbum(entry.track.catalogAlbumId!)
                                }}
                              >
                                {entry.track.album}
                              </button>
                            ) : (
                              <p className="text-xs text-zinc-500 truncate">{entry.track.album}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {entry.track.catalogArtistId ? (
                          <button
                            className="text-sm text-zinc-300 hover:text-white transition-colors"
                            onClick={(event) => {
                              event.stopPropagation()
                              void openCatalogArtist(entry.track.catalogArtistId!)
                            }}
                          >
                            {entry.track.artist}
                          </button>
                        ) : (
                          <span className="text-sm text-zinc-400">{entry.track.artist}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-zinc-500">
                        {formatPlayedAt(entry.playedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Recently Played Albums</h2>
            {recentAlbums.length > COLLAPSED_RECENTS_COUNT && (
              <button
                onClick={() => setShowAllAlbums((value) => !value)}
                className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                {showAllAlbums ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
          {recentAlbums.length === 0 ? (
            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-5 text-sm text-zinc-500">
              Album history will appear here once you start listening.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visibleRecentAlbums.map((entry) => (
                <button
                  key={`${resolveProvider(entry)}:${entry.track.catalogAlbumId ?? `${entry.track.album}:${entry.playedAt}`}`}
                  onClick={() => {
                    if (entry.track.catalogAlbumId) {
                      void openCatalogAlbum(entry.track.catalogAlbumId)
                    }
                  }}
                  className="text-left flex items-center gap-3 p-3 rounded-2xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/10 transition-colors"
                >
                  {resolveCover(entry) ? (
                    <img
                      src={resolveCover(entry)!}
                      alt=""
                      className="w-16 h-16 rounded-xl object-cover shrink-0 bg-zinc-900"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-xl shrink-0 bg-zinc-900 flex items-center justify-center text-zinc-600 text-lg font-semibold">
                      {entry.track.album.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-100 truncate">{entry.track.album}</p>
                    <div className="mt-1.5 flex items-center gap-2 min-w-0">
                      <ProviderBadge provider={resolveProvider(entry)} compact className="shrink-0" />
                      <span className="text-xs text-zinc-500 truncate">{entry.track.artist}</span>
                    </div>
                    <p className="text-[11px] text-zinc-600 mt-2">{formatPlayedAt(entry.playedAt)}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {providerShelves.map((shelf) => (
          <ProviderShelfRow
            key={shelf.id}
            shelf={shelf}
            onOpenCollection={openProviderCollection}
            expanded={!!expandedProviderShelves[shelf.id]}
            onToggleExpanded={() => {
              setExpandedProviderShelves((current) => ({
                ...current,
                [shelf.id]: !current[shelf.id],
              }))
            }}
          />
        ))}

        <ListeningActivity />
      </div>
    </div>
  )
}
