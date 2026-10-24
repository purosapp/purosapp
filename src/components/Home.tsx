import { useEffect, useMemo, useState } from 'react'
import type { HomeProviderCollectionItem, HomeProviderShelf } from '../services/homeProviderShelves'
import {
  HOME_RECENTS_CHANGED_EVENT,
  filterVisibleRecentPlaylists,
  filterVisibleRecentTracks,
  loadRecentlyPlayed,
  loadRecentlyPlayedPlaylists,
  openRecentPlaylist,
  type RecentPlayedEntry,
  type RecentPlaylistEntry,
} from '../services/homeRecents'
import { useSettingsStore } from '../store/settingsStore'
import { useProviderStatusStore } from '../store/providerStatusStore'
import { usePlayerStore } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import ProviderBadge from './ProviderBadge'
import ListeningActivity from './ListeningActivity'
import { Compass } from 'lucide-react'
import { useCatalogStore } from '../store/catalogStore'
import { formatPlayedAt } from '../utils/formatTime'
import { MediaGrid, MediaTile, useMediaGridColumns } from './MediaTile'
import TrackList, { type TrackListRow } from './TrackList'
import { Button, PageHeader, Section, SectionNotice } from './ui'

/** Collapsed tile shelves show one full row (see useMediaGridColumns); songs a short list. */
const COLLAPSED_SONG_COUNT = 5

function resolveCover(entry: RecentPlayedEntry) {
  return entry.track.coverUrl ?? entry.track.artworkUrl ?? null
}

function resolveProvider(entry: RecentPlayedEntry) {
  return entry.track.provider ?? 'local'
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

function collectionKindLabel(sourceType: HomeProviderCollectionItem['sourceType']) {
  return sourceType === 'station' ? 'Station' : sourceType === 'mix' ? 'Mix' : 'Playlist'
}

function ShowMoreButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return <Button variant="ghost" size="sm" label={expanded ? 'Show less' : 'Show more'} onClick={onToggle} />
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
  const [gridRef, columns] = useMediaGridColumns()
  const visibleItems = expanded ? shelf.items : shelf.items.slice(0, columns)

  return (
    <Section
      title={shelf.title}
      aside={<ProviderBadge provider={shelf.provider} compact />}
      action={shelf.items.length > columns ? <ShowMoreButton expanded={expanded} onToggle={onToggleExpanded} /> : undefined}
    >
      {shelf.subtitle ? <p className="-mt-1 max-w-2xl text-xs text-zinc-500">{shelf.subtitle}</p> : null}
      <MediaGrid ref={gridRef}>
        {visibleItems.map((item) => (
          <MediaTile
            key={item.id}
            kind="playlist"
            title={item.title}
            subtitle={item.trackCount ? `${collectionKindLabel(item.sourceType)} · ${item.trackCount} tracks` : collectionKindLabel(item.sourceType)}
            artworkSrc={item.artworkUrl}
            onOpen={() => onOpenCollection(item)}
            topRight={<ProviderBadge provider={item.provider} compact iconOnly className="border-white/15 bg-black/55 backdrop-blur-md" />}
          />
        ))}
      </MediaGrid>
    </Section>
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
  const playAlbum = useCatalogStore((s) => s.playAlbum)

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

  const [playlistGridRef, playlistColumns] = useMediaGridColumns()
  const [albumGridRef, albumColumns] = useMediaGridColumns()
  const visibleRecentPlaylists = useMemo(
    () => showAllPlaylists ? availableRecentPlaylists : availableRecentPlaylists.slice(0, playlistColumns),
    [availableRecentPlaylists, playlistColumns, showAllPlaylists],
  )
  const visibleRecentSongs = useMemo(
    () => showAllSongs ? visibleRecentEntries : visibleRecentEntries.slice(0, COLLAPSED_SONG_COUNT),
    [visibleRecentEntries, showAllSongs],
  )
  const visibleRecentAlbums = useMemo(
    () => showAllAlbums ? recentAlbums : recentAlbums.slice(0, albumColumns),
    [albumColumns, recentAlbums, showAllAlbums],
  )

  const greeting = useMemo(
    () => getGreeting(homeDisplayName, greetingBucket),
    [greetingBucket, homeDisplayName],
  )

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <PageHeader
        kicker="Home"
        title={greeting}
        subtitle="Pick up where you left off, or head into Explore to browse your library and connected providers."
        actions={<Button icon={Compass} label="Explore" onClick={() => setActiveView('explore')} />}
      />
      <div className="px-6 pb-6 space-y-10">
        <Section
          title="Recently Played Playlists"
          action={availableRecentPlaylists.length > playlistColumns
            ? <ShowMoreButton expanded={showAllPlaylists} onToggle={() => setShowAllPlaylists((value) => !value)} />
            : undefined}
        >
          {availableRecentPlaylists.length === 0 ? (
            <SectionNotice>Open or play a playlist and it will appear here.</SectionNotice>
          ) : (
            <MediaGrid ref={playlistGridRef}>
              {visibleRecentPlaylists.map((playlist) => (
                <MediaTile
                  key={`${playlist.entryKind ?? 'local-playlist'}:${playlist.playlistId ?? playlist.itemId ?? playlist.name}:${playlist.playedAt}`}
                  kind="playlist"
                  title={playlist.name}
                  subtitle={`${playlist.trackCount} tracks · ${formatPlayedAt(playlist.playedAt)}`}
                  artworkSrc={playlist.artworkUrl}
                  onOpen={() => openRecentPlaylist(playlist)}
                  topRight={<ProviderBadge provider={playlist.source || 'local'} compact iconOnly className="border-white/15 bg-black/55 backdrop-blur-md" />}
                />
              ))}
            </MediaGrid>
          )}
        </Section>

        <Section
          title="Recently Played Songs"
          action={visibleRecentEntries.length > COLLAPSED_SONG_COUNT
            ? <ShowMoreButton expanded={showAllSongs} onToggle={() => setShowAllSongs((value) => !value)} />
            : undefined}
        >
          {visibleRecentEntries.length === 0 ? (
            <SectionNotice>Start playing music and your recent tracks will appear here.</SectionNotice>
          ) : (
            <TrackList
              rows={visibleRecentSongs.map((entry, index): TrackListRow => ({
                key: `${entry.track.id}:${entry.playedAt}`,
                number: index + 1,
                title: entry.track.title,
                artworkSrc: resolveCover(entry),
                artist: entry.track.artist,
                onOpenArtist: entry.track.catalogArtistId ? () => { void openCatalogArtist(entry.track.catalogArtistId!) } : undefined,
                album: entry.track.album || null,
                onOpenAlbum: entry.track.catalogAlbumId ? () => { void openCatalogAlbum(entry.track.catalogAlbumId!) } : undefined,
                meta: <ProviderBadge provider={resolveProvider(entry)} compact iconOnly className="border-white/10 bg-white/[0.05]" />,
                trailing: formatPlayedAt(entry.playedAt),
                active: entry.track.id === currentTrackId,
              }))}
              trailingLabel="Played"
              onPlay={(index) => {
                const entry = visibleRecentSongs[index]
                if (entry) setQueue([entry.track], 0)
              }}
            />
          )}
        </Section>

        <Section
          title="Recently Played Albums"
          action={recentAlbums.length > albumColumns
            ? <ShowMoreButton expanded={showAllAlbums} onToggle={() => setShowAllAlbums((value) => !value)} />
            : undefined}
        >
          {recentAlbums.length === 0 ? (
            <SectionNotice>Album history will appear here once you start listening.</SectionNotice>
          ) : (
            <MediaGrid ref={albumGridRef}>
              {visibleRecentAlbums.map((entry) => (
                <MediaTile
                  key={`${resolveProvider(entry)}:${entry.track.catalogAlbumId ?? `${entry.track.album}:${entry.playedAt}`}`}
                  kind="album"
                  title={entry.track.album}
                  subtitle={entry.track.artist}
                  artworkSrc={resolveCover(entry)}
                  onOpen={() => {
                    if (entry.track.catalogAlbumId) void openCatalogAlbum(entry.track.catalogAlbumId)
                  }}
                  onPlay={entry.track.catalogAlbumId ? () => { void playAlbum(entry.track.catalogAlbumId!) } : undefined}
                  topRight={<ProviderBadge provider={resolveProvider(entry)} compact iconOnly className="border-white/15 bg-black/55 backdrop-blur-md" />}
                />
              ))}
            </MediaGrid>
          )}
        </Section>

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
