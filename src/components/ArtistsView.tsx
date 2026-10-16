import { ArrowUpDown, User } from 'lucide-react'
import { useCatalogStore } from '../store/catalogStore'

import { useEffect, useMemo, useState, useCallback } from 'react'
import type { CatalogArtistSummary, CatalogSourceLink } from '../services/catalog/types'
import { useAppShellStore } from '../store/appShellStore'
import { artworkUrl } from '../utils/artworkUrl'
import ProviderBadge from './ProviderBadge'
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

function dedupeSourcesByProvider(sourceLinks: CatalogSourceLink[]): CatalogSourceLink[] {
  const seen = new Set<string>()
  return sourceLinks.filter((source) => {
    if (seen.has(source.provider)) return false
    seen.add(source.provider)
    return true
  })
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
  const cover = resolveArtwork(artist)
  const stats = formatStats(artist.albumCount, artist.trackCount)
  const sources = dedupeSourcesByProvider(artist.sourceLinks)

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
      className="group flex flex-col items-center text-center focus:outline-none"
    >
      {/* Circular cover */}
      <div className="relative w-full aspect-square rounded-full overflow-hidden bg-zinc-800 mb-3">
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
            <User className="w-10 h-10 text-zinc-600" strokeWidth={1.5} />
          </div>
        )}
        <div className="absolute inset-0 rounded-full ring-1 ring-inset ring-white/5 group-hover:ring-white/20 transition-shadow" />
        {onTogglePin && (
          <div className="absolute top-1 right-1">
            <PinButton pinned={!!pinned} onToggle={onTogglePin} />
          </div>
        )}
      </div>

      <p className="text-sm text-zinc-200 truncate w-full group-hover:text-white transition-colors leading-tight">
        {artist.name}
      </p>
      {stats && <p className="text-xs text-zinc-500 truncate w-full mt-0.5">{stats}</p>}
      {sources.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1 mt-2">
          {sources.map((source, index) => (
            <ProviderBadge
              key={`${source.provider}:${source.sourceId ?? 'missing'}:${index}`}
              provider={source.provider}
              compact
              iconOnly
              className={source.inLibrary ? 'border-white/15 bg-white/10' : 'border-white/10 bg-white/5'}
            />
          ))}
        </div>
      )}
    </div>
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
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-3 shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Artists</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {isLoading ? 'Loading…' : `${artists.length} ${artists.length === 1 ? 'artist' : 'artists'} in this provider`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter artists"
            className="w-44 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/20"
          />
          <button
            onClick={() => setSort((s) => (s === 'name' ? 'albums' : 'name'))}
            title={`Sort: ${SORT_LABELS[sort]}`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-zinc-400 border border-white/10 hover:text-zinc-200 hover:bg-white/5 transition-colors"
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            {SORT_LABELS[sort]}
          </button>
        </div>
      </div>

      {/* Grid */}
      {isLoading && artists.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-zinc-500">Loading…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-sm text-zinc-500 text-center">
            {filter.trim()
              ? `No artists match “${filter.trim()}”.`
              : 'No artists in your library yet. Add music or sync a provider to get started.'}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-6">
            {visible.map((artist) => (
              <ArtistCard
                key={artist.id}
                artist={artist}
                onOpen={() => { void openCatalogArtist(artist.id, 'library') }}
                pinned={pinnedArtists.includes(artist.id)}
                onTogglePin={() => togglePin('artists', artist.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
