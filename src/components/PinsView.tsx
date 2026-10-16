/**
 * Pins — full view of the user's manually pinned items, grouped by category.
 * The active category is driven by the sidebar Pins flyout (pinsStore.category)
 * and can also be switched here via the tab bar. Each category renders with the
 * same cards/table as its dedicated browse view, so pins behave like the rest
 * of the app and stay provider-agnostic.
 */

import { Music } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CatalogAlbumPage, CatalogArtistPage, CatalogTrackSummary } from '../services/catalog/types'
import type { PlaylistInfo } from '../../electron/preload'
import { usePinsStore, PIN_CATEGORIES, PIN_CATEGORY_LABELS } from '../store/pinsStore'
import { useAppShellStore } from '../store/appShellStore'
import { useCatalogStore } from '../store/catalogStore'
import { artworkUrl } from '../utils/artworkUrl'
import MediaTabs from './MediaTabs'
import ProviderBadge from './ProviderBadge'
import PinButton from './PinButton'
import { AlbumCard } from './AlbumsView'
import { ArtistCard } from './ArtistsView'
import { TrackTable } from './Explore'

/** Hydrate pinned ids into full entities, preserving pin order and dropping any that no longer resolve. */
function useHydratedPins() {
  const albumIds = usePinsStore((s) => s.albums)
  const artistIds = usePinsStore((s) => s.artists)
  const trackIds = usePinsStore((s) => s.tracks)
  const playlistIds = usePinsStore((s) => s.playlists)

  const [albums, setAlbums] = useState<CatalogAlbumPage[]>([])
  const [artists, setArtists] = useState<CatalogArtistPage[]>([])
  const [tracks, setTracks] = useState<CatalogTrackSummary[]>([])
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([])

  useEffect(() => {
    let cancelled = false
    void Promise.all(albumIds.map((id) => window.puros.catalog.getAlbumPreview(id).catch(() => null)))
      .then((rows) => { if (!cancelled) setAlbums(rows.filter((r): r is CatalogAlbumPage => !!r)) })
    return () => { cancelled = true }
  }, [albumIds])

  useEffect(() => {
    let cancelled = false
    void Promise.all(artistIds.map((id) => window.puros.catalog.getArtistPreview(id).catch(() => null)))
      .then((rows) => { if (!cancelled) setArtists(rows.filter((r): r is CatalogArtistPage => !!r)) })
    return () => { cancelled = true }
  }, [artistIds])

  useEffect(() => {
    let cancelled = false
    void Promise.all(trackIds.map((id) => window.puros.catalog.getTrack(id).catch(() => null)))
      .then((rows) => { if (!cancelled) setTracks(rows.filter((r): r is CatalogTrackSummary => !!r)) })
    return () => { cancelled = true }
  }, [trackIds])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void window.puros.playlists.getAll().then((all) => {
        if (cancelled) return
        const byId = new Map(all.map((p) => [p.id, p]))
        setPlaylists(playlistIds.map((id) => byId.get(id)).filter((p): p is PlaylistInfo => !!p))
      })
    }
    load()
    const unsub = window.puros.on('playlists:changed', load)
    return () => { cancelled = true; unsub() }
  }, [playlistIds])

  return { albums, artists, tracks, playlists }
}

function UnresolvedPin({ category, id }: { category: 'albums' | 'artists' | 'tracks'; id: string }) {
  const [choices, setChoices] = useState<Array<{ id: string; providerId: string; title: string }>>([])
  const replace = usePinsStore(s => s.replace)
  const toggle = usePinsStore(s => s.toggle)
  useEffect(() => {
    let cancelled = false
    const kind = category === 'artists' ? 'artist' : category === 'albums' ? 'album' : 'track'
    void window.puros.catalog.getSourceChoices(kind, id).then(rows => { if (!cancelled) setChoices(rows) })
    return () => { cancelled = true }
  }, [category, id])
  return <div className="mx-6 mt-3 rounded-xl border border-white/10 p-3 text-sm text-zinc-400">
    <p>{choices.length ? 'Choose a source for this saved item.' : 'This saved item is unavailable.'}</p>
    <div className="mt-2 flex flex-wrap gap-2">
      {choices.map(choice => <button key={choice.id} onClick={() => replace(category, id, choice.id)} className="rounded-lg bg-white/5 px-3 py-2 text-zinc-200 hover:bg-white/10"><ProviderBadge provider={choice.providerId} /> <span className="ml-2">{choice.title}</span></button>)}
      <button onClick={() => toggle(category, id)} className="px-2 text-xs text-zinc-500 hover:text-white">Remove pin</button>
    </div>
  </div>
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <p className="text-sm text-zinc-500 text-center">{message}</p>
    </div>
  )
}

function PlaylistCard({ playlist, onOpen, onUnpin }: { playlist: PlaylistInfo; onOpen: () => void; onUnpin: () => void }) {
  const cover = artworkUrl(playlist.artwork_id, null)
  const provider = playlist.source || 'local'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="group flex flex-col text-left focus:outline-none"
    >
      <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-zinc-800 mb-2">
        {cover ? (
          <img src={cover} className="w-full h-full object-cover" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Music className="w-10 h-10 text-zinc-600" strokeWidth={1.5} />
          </div>
        )}
        <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/5 group-hover:ring-white/20 transition-shadow" />
        <div className="absolute top-1.5 left-1.5">
          <PinButton pinned onToggle={onUnpin} />
        </div>
        <div className="absolute top-1.5 right-1.5">
          <ProviderBadge provider={provider} compact iconOnly className="border-white/15 bg-black/50" />
        </div>
      </div>
      <p className="text-sm text-zinc-200 truncate w-full group-hover:text-white transition-colors leading-tight">{playlist.name}</p>
      <p className="text-xs text-zinc-500 truncate w-full mt-0.5">
        {playlist.track_count} {playlist.track_count === 1 ? 'track' : 'tracks'}
      </p>
    </div>
  )
}

export default function PinsView() {
  const category = usePinsStore((s) => s.category)
  const setCategory = usePinsStore((s) => s.setCategory)
  const togglePin = usePinsStore((s) => s.toggle)
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const openPlaylist = useAppShellStore((s) => s.openPlaylist)
  const playTracks = useCatalogStore((s) => s.playTracks)
  const addTrackToQueue = useCatalogStore((s) => s.addTrackToQueue)

  const { albums, artists, tracks, playlists } = useHydratedPins()

  const albumCount = usePinsStore((s) => s.albums.length)
  const artistCount = usePinsStore((s) => s.artists.length)
  const trackCount = usePinsStore((s) => s.tracks.length)
  const playlistCount = usePinsStore((s) => s.playlists.length)

  const tabs = useMemo(() => {
    const counts: Record<typeof category, number> = {
      albums: albumCount,
      artists: artistCount,
      tracks: trackCount,
      playlists: playlistCount,
    }
    return PIN_CATEGORIES.map((id) => ({ id, label: `${PIN_CATEGORY_LABELS[id]} (${counts[id]})` }))
  }, [albumCount, artistCount, trackCount, playlistCount])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 pt-6 pb-1 shrink-0">
        <h1 className="text-xl font-semibold text-zinc-100">Pins</h1>
        <p className="text-xs text-zinc-500 mt-0.5">Your manually pinned items, across all providers.</p>
      </div>
      <MediaTabs value={category} options={tabs} onChange={setCategory} />
      {category !== 'playlists' && usePinsStore.getState()[category].filter(id => !(category === 'albums' ? albums : category === 'artists' ? artists : tracks).some(item => item.id === id)).map(id => <UnresolvedPin key={id} category={category} id={id} />)}

      {category === 'albums' && (
        albums.length === 0
          ? <EmptyState message="No pinned albums yet. Open Albums and use the pin button on a cover." />
          : (
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="grid grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6">
                {albums.map((album) => (
                  <AlbumCard
                    key={album.id}
                    album={album}
                    onOpen={() => { void openCatalogAlbum(album.id, 'library') }}
                    pinned
                    onTogglePin={() => togglePin('albums', album.id)}
                  />
                ))}
              </div>
            </div>
          )
      )}

      {category === 'artists' && (
        artists.length === 0
          ? <EmptyState message="No pinned artists yet. Open Artists and use the pin button on a card." />
          : (
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-6">
                {artists.map((artist) => (
                  <ArtistCard
                    key={artist.id}
                    artist={artist}
                    onOpen={() => { void openCatalogArtist(artist.id, 'library') }}
                    pinned
                    onTogglePin={() => togglePin('artists', artist.id)}
                  />
                ))}
              </div>
            </div>
          )
      )}

      {category === 'tracks' && (
        tracks.length === 0
          ? <EmptyState message="No pinned tracks yet. Right-click a track and choose Pin to Pins." />
          : (
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <TrackTable
                tracks={tracks}
                onPlayTrack={(_, index) => void playTracks(tracks, index)}
                onQueueTrack={(track) => void addTrackToQueue(track)}
                onOpenArtist={(artistId) => void openCatalogArtist(artistId, 'library')}
                onOpenAlbum={(albumId) => void openCatalogAlbum(albumId, 'library')}
                isTrackPinned={() => true}
                onTogglePin={(track) => togglePin('tracks', track.id)}
              />
            </div>
          )
      )}

      {category === 'playlists' && (
        playlists.length === 0
          ? <EmptyState message="No pinned playlists yet. Right-click a playlist in the sidebar and choose Pin to Pins." />
          : (
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="grid grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6">
                {playlists.map((playlist) => (
                  <PlaylistCard
                    key={playlist.id}
                    playlist={playlist}
                    onOpen={() => openPlaylist(playlist.id)}
                    onUnpin={() => togglePin('playlists', playlist.id)}
                  />
                ))}
              </div>
            </div>
          )
      )}
    </div>
  )
}
