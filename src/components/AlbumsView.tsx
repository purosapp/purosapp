import { ArrowUpDown } from 'lucide-react'
import { useCatalogStore } from '../store/catalogStore'

import { useEffect, useMemo, useState, useCallback } from 'react'
import type { CatalogAlbumSummary } from '../services/catalog/types'
import { useAppShellStore } from '../store/appShellStore'
import { artworkUrl } from '../utils/artworkUrl'
import { MediaGrid, MediaGridSkeleton, MediaTile, SourceBadges } from './MediaTile'
import { Button, PageHeader, PageStatus, SearchField } from './ui'
import PinButton from './PinButton'
import { usePinsStore } from '../store/pinsStore'

type AlbumSort = 'title' | 'artist' | 'year'

const SORT_LABELS: Record<AlbumSort, string> = {
  title: 'Title',
  artist: 'Artist',
  year: 'Newest',
}

const SORT_ORDER: AlbumSort[] = ['title', 'artist', 'year']

function resolveArtwork(album: CatalogAlbumSummary): string | null {
  return artworkUrl(album.artworkId, null) ?? album.artworkUrl ?? null
}

function albumArtist(album: CatalogAlbumSummary): string {
  return album.artistCreditName ?? album.primaryArtistName ?? 'Unknown Artist'
}

export function AlbumCard({
  album,
  onOpen,
  pinned,
  onTogglePin,
}: {
  album: CatalogAlbumSummary
  onOpen: () => void
  pinned?: boolean
  onTogglePin?: () => void
}) {
  const playAlbum = useCatalogStore((s) => s.playAlbum)
  return (
    <MediaTile
      kind="album"
      title={album.title}
      subtitle={`${albumArtist(album)}${album.year ? ` · ${album.year}` : ''}`}
      artworkSrc={resolveArtwork(album)}
      onOpen={onOpen}
      onPlay={() => { void playAlbum(album.id) }}
      topLeft={onTogglePin ? <PinButton pinned={!!pinned} onToggle={onTogglePin} /> : undefined}
      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
    />
  )
}

export default function AlbumsView() {
  const providerId = useCatalogStore(s => s.activeProviderId)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const pinnedAlbums = usePinsStore((s) => s.albums)
  const togglePin = usePinsStore((s) => s.toggle)
  const [albums, setAlbums] = useState<CatalogAlbumSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [sort, setSort] = useState<AlbumSort>('artist')
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    const rows = await window.puros.catalog.browseAlbums(providerId, 'library')
    if (useCatalogStore.getState().activeProviderId !== providerId) return
    setAlbums(rows)
    setIsLoading(false)
  }, [providerId])

  useEffect(() => {
    let cancelled = false
    void window.puros.catalog.browseAlbums(providerId, 'library').then((rows) => {
      if (cancelled) return
      setAlbums(rows)
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
      ? albums.filter((album) =>
          album.title.toLowerCase().includes(term) || albumArtist(album).toLowerCase().includes(term))
      : albums
    const sorted = [...filtered]
    if (sort === 'artist') {
      sorted.sort((a, b) => albumArtist(a).localeCompare(albumArtist(b)) || (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title))
    } else if (sort === 'year') {
      sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title))
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title))
    }
    return sorted
  }, [albums, filter, sort])

  const cycleSort = () => {
    setSort((current) => SORT_ORDER[(SORT_ORDER.indexOf(current) + 1) % SORT_ORDER.length])
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PageHeader
        kicker="Library"
        title="Albums"
        subtitle={isLoading ? 'Loading…' : `${albums.length} ${albums.length === 1 ? 'album' : 'albums'} in this provider`}
        actions={(
          <>
            <SearchField value={filter} onChange={setFilter} placeholder="Filter albums" />
            <Button icon={ArrowUpDown} label={SORT_LABELS[sort]} title={`Sort: ${SORT_LABELS[sort]}`} onClick={cycleSort} />
          </>
        )}
      />

      {isLoading && albums.length === 0 ? (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <MediaGridSkeleton count={12} />
        </div>
      ) : visible.length === 0 ? (
        <PageStatus
          fill
          title={filter.trim() ? `No albums match “${filter.trim()}”.` : 'No albums in your library yet.'}
          hint={filter.trim() ? undefined : 'Add music or sync a provider to get started.'}
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <MediaGrid>
            {visible.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onOpen={() => { void openCatalogAlbum(album.id, 'library') }}
                pinned={pinnedAlbums.includes(album.id)}
                onTogglePin={() => togglePin('albums', album.id)}
              />
            ))}
          </MediaGrid>
        </div>
      )}
    </div>
  )
}
