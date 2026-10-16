import { ArrowUpDown, Music } from 'lucide-react'
import { useCatalogStore } from '../store/catalogStore'

import { useEffect, useMemo, useState, useCallback } from 'react'
import type { CatalogAlbumSummary, CatalogSourceLink } from '../services/catalog/types'
import { useAppShellStore } from '../store/appShellStore'
import { artworkUrl } from '../utils/artworkUrl'
import ProviderBadge from './ProviderBadge'
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

function dedupeSourcesByProvider(sourceLinks: CatalogSourceLink[]): CatalogSourceLink[] {
  const seen = new Set<string>()
  return sourceLinks.filter((source) => {
    if (seen.has(source.provider)) return false
    seen.add(source.provider)
    return true
  })
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
  const cover = resolveArtwork(album)
  const sources = dedupeSourcesByProvider(album.sourceLinks)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className="group flex flex-col text-left focus:outline-none"
    >
      {/* Cover */}
      <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-zinc-800 mb-2">
        {cover ? (
          <img
            src={cover}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              const el = e.currentTarget as HTMLImageElement
              el.style.display = 'none'
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Music className="w-10 h-10 text-zinc-600" strokeWidth={1.5} />
          </div>
        )}
        <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/5 group-hover:ring-white/20 transition-shadow" />
        {onTogglePin && (
          <div className="absolute top-1.5 left-1.5">
            <PinButton pinned={!!pinned} onToggle={onTogglePin} />
          </div>
        )}
        {sources.length > 0 && (
          <div className="absolute top-1.5 right-1.5 flex flex-wrap justify-end gap-1">
            {sources.map((source, index) => (
              <ProviderBadge
                key={`${source.provider}:${source.sourceId ?? 'missing'}:${index}`}
                provider={source.provider}
                compact
                iconOnly
                className={source.inLibrary ? 'border-white/15 bg-black/50' : 'border-white/10 bg-black/40'}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-sm text-zinc-200 truncate w-full group-hover:text-white transition-colors leading-tight">
        {album.title}
      </p>
      <p className="text-xs text-zinc-500 truncate w-full mt-0.5">
        {albumArtist(album)}
        {album.year ? ` · ${album.year}` : ''}
      </p>
    </div>
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
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-3 shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Albums</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {isLoading ? 'Loading…' : `${albums.length} ${albums.length === 1 ? 'album' : 'albums'} in this provider`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter albums"
            className="w-44 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/20"
          />
          <button
            onClick={cycleSort}
            title={`Sort: ${SORT_LABELS[sort]}`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-zinc-400 border border-white/10 hover:text-zinc-200 hover:bg-white/5 transition-colors"
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            {SORT_LABELS[sort]}
          </button>
        </div>
      </div>

      {/* Grid */}
      {isLoading && albums.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-zinc-500">Loading…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-sm text-zinc-500 text-center">
            {filter.trim()
              ? `No albums match “${filter.trim()}”.`
              : 'No albums in your library yet. Add music or sync a provider to get started.'}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6">
            {visible.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onOpen={() => { void openCatalogAlbum(album.id, 'library') }}
                pinned={pinnedAlbums.includes(album.id)}
                onTogglePin={() => togglePin('albums', album.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
