import { ArrowUpDown } from 'lucide-react'
import { useCatalogStore } from '../store/catalogStore'

import { useEffect, useMemo, useState, useCallback } from 'react'
import type { CatalogArtistSummary } from '../services/catalog/types'
import { useAppShellStore } from '../store/appShellStore'
import { artworkUrl } from '../utils/artworkUrl'
import { MediaGrid, MediaGridSkeleton, MediaTile, SourceBadges } from './MediaTile'
import { Button, PageHeader, PageStatus, SearchField } from './ui'
import PinButton from './PinButton'
import { usePinsStore } from '../store/pinsStore'

type ArtistSort = 'name' | 'albums'

const SORT_LABELS: Record<ArtistSort, string> = {
  name: 'Name',
  albums: 'Most albums',
}

function resolveArtwork(artist: CatalogArtistSummary): string | null {
  return artworkUrl(artist.artworkId, null) ?? artist.artworkUrl ?? null
}

function formatStats(albumCount: number, trackCount: number): string | null {
  if (albumCount > 0) return `${albumCount} ${albumCount === 1 ? 'album' : 'albums'}`
  if (trackCount > 0) return `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}`
  return null
}

export function ArtistCard({
  artist,
  onOpen,
  pinned,
  onTogglePin,
}: {
  artist: CatalogArtistSummary
  onOpen: () => void
  pinned?: boolean
  onTogglePin?: () => void
}) {
  return (
    <MediaTile
      kind="artist"
      title={artist.name}
      subtitle={formatStats(artist.albumCount, artist.trackCount)}
      artworkSrc={resolveArtwork(artist)}
      onOpen={onOpen}
      topLeft={onTogglePin ? <PinButton pinned={!!pinned} onToggle={onTogglePin} /> : undefined}
      topRight={<SourceBadges sourceLinks={artist.sourceLinks} />}
    />
  )
}

export default function ArtistsView() {
  const providerId = useCatalogStore(s => s.activeProviderId)
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const pinnedArtists = usePinsStore((s) => s.artists)
  const togglePin = usePinsStore((s) => s.toggle)
  const [artists, setArtists] = useState<CatalogArtistSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [sort, setSort] = useState<ArtistSort>('name')
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    const rows = await window.puros.catalog.browseArtists(providerId, 'library')
    if (useCatalogStore.getState().activeProviderId !== providerId) return
    setArtists(rows)
    setIsLoading(false)
  }, [providerId])

  useEffect(() => {
    let cancelled = false
    void window.puros.catalog.browseArtists(providerId, 'library').then((rows) => {
      if (cancelled) return
      setArtists(rows)
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
    const filtered = term
      ? artists.filter((artist) => artist.name.toLowerCase().includes(term))
      : artists
    const sorted = [...filtered]
    if (sort === 'albums') {
      sorted.sort((a, b) => b.albumCount - a.albumCount || b.trackCount - a.trackCount || a.name.localeCompare(b.name))
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    }
    return sorted
  }, [artists, filter, sort])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PageHeader
        kicker="Library"
        title="Artists"
        subtitle={isLoading ? 'Loading…' : `${artists.length} ${artists.length === 1 ? 'artist' : 'artists'} in this provider`}
        actions={(
          <>
            <SearchField value={filter} onChange={setFilter} placeholder="Filter artists" />
            <Button
              icon={ArrowUpDown}
              label={SORT_LABELS[sort]}
              title={`Sort: ${SORT_LABELS[sort]}`}
              onClick={() => setSort((s) => (s === 'name' ? 'albums' : 'name'))}
            />
          </>
        )}
      />

      {isLoading && artists.length === 0 ? (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <MediaGridSkeleton count={12} kind="artist" />
        </div>
      ) : visible.length === 0 ? (
        <PageStatus
          fill
          title={filter.trim() ? `No artists match “${filter.trim()}”.` : 'No artists in your library yet.'}
          hint={filter.trim() ? undefined : 'Add music or sync a provider to get started.'}
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <MediaGrid>
            {visible.map((artist) => (
              <ArtistCard
                key={artist.id}
                artist={artist}
                onOpen={() => { void openCatalogArtist(artist.id, 'library') }}
                pinned={pinnedArtists.includes(artist.id)}
                onTogglePin={() => togglePin('artists', artist.id)}
              />
            ))}
          </MediaGrid>
        </div>
      )}
    </div>
  )
}
