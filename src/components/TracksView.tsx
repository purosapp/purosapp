
import { useEffect, useMemo, useState, useCallback } from 'react'
import type { CatalogTrackSummary } from '../services/catalog/types'
import { useCatalogStore } from '../store/catalogStore'
import { useAppShellStore } from '../store/appShellStore'
import { usePinsStore } from '../store/pinsStore'
import { TrackTable } from './Explore'
import { TrackListSkeleton } from './TrackList'
import { PageHeader, PageStatus, SearchField } from './ui'

export default function TracksView() {
  const providerId = useCatalogStore(s => s.activeProviderId)
  const playTracks = useCatalogStore((s) => s.playTracks)
  const addTrackToQueue = useCatalogStore((s) => s.addTrackToQueue)
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const pinnedTracks = usePinsStore((s) => s.tracks)
  const togglePin = usePinsStore((s) => s.toggle)

  const [tracks, setTracks] = useState<CatalogTrackSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    const rows = await window.puros.catalog.browseTracks(providerId, 'library')
    if (useCatalogStore.getState().activeProviderId !== providerId) return
    setTracks(rows)
    setIsLoading(false)
  }, [providerId])

  useEffect(() => {
    let cancelled = false
    void window.puros.catalog.browseTracks(providerId, 'library').then((rows) => {
      if (cancelled) return
      setTracks(rows)
      setIsLoading(false)
    })
    const unsub = window.puros.on('catalog:changed', () => { void load() })
    return () => {
      cancelled = true
      unsub()
    }
  }, [load])

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase()
    if (!term) return tracks
    return tracks.filter((track) =>
      track.title.toLowerCase().includes(term)
      || (track.artistCreditName ?? track.primaryArtistName ?? '').toLowerCase().includes(term)
      || (track.albumTitle ?? '').toLowerCase().includes(term))
  }, [tracks, filter])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PageHeader
        kicker="Library"
        title="Tracks"
        subtitle={isLoading ? 'Loading…' : `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} in this provider`}
        actions={<SearchField value={filter} onChange={setFilter} placeholder="Filter tracks" />}
      />

      {isLoading && tracks.length === 0 ? (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <TrackListSkeleton rows={12} />
        </div>
      ) : visible.length === 0 ? (
        <PageStatus
          fill
          title={filter.trim() ? `No tracks match “${filter.trim()}”.` : 'No tracks in your library yet.'}
          hint={filter.trim() ? undefined : 'Add music or sync a provider to get started.'}
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <TrackTable
            tracks={visible}
            onPlayTrack={(_, index) => void playTracks(visible, index)}
            onQueueTrack={(track) => void addTrackToQueue(track)}
            onOpenArtist={(artistId) => void openCatalogArtist(artistId, 'library')}
            onOpenAlbum={(albumId) => void openCatalogAlbum(albumId, 'library')}
            isTrackPinned={(track) => pinnedTracks.includes(track.id)}
            onTogglePin={(track) => togglePin('tracks', track.id)}
          />
        </div>
      )}
    </div>
  )
}
