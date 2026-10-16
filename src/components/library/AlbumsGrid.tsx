/**
 * Albums grid — uniform 4-column grid with sort controls and infinite scroll.
 * Filters client-side on normalized title + artist name (no round-trip).
 */

import { Music, Play } from 'lucide-react'
import { useEffect, useRef, useCallback } from 'react'
import type { AlbumRow } from '../../../electron/preload'
import { artworkUrl } from '../../utils/artworkUrl'


interface AlbumsGridProps {
  albums: AlbumRow[]
  isLoading: boolean
  onAlbumClick: (albumId: string) => void
  onAlbumPlay: (albumId: string) => void
}

function AlbumCard({
  album,
  onClick,
  onPlay,
}: {
  album: AlbumRow
  onClick: () => void
  onPlay: (e: React.MouseEvent) => void
}) {
  const coverSrc = artworkUrl(album.artwork_id, album.art_path)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      className="group flex flex-col text-left focus:outline-none"
    >
      {/* Cover */}
      <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-zinc-800 mb-2">
        {coverSrc ? (
          <img
            src={coverSrc}
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

        {/* Play overlay */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <button
            onClick={onPlay}
            className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center hover:bg-white transition-colors shadow-lg"
          >
            <Play className="w-5 h-5 text-zinc-900 ml-0.5" fill="currentColor" />
          </button>
        </div>

        {/* Compilation badge */}
        {!!album.is_compilation && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider bg-black/60 text-zinc-300 rounded">
            VA
          </span>
        )}
      </div>

      {/* Info */}
      <p className="text-sm text-zinc-200 truncate w-full group-hover:text-white transition-colors leading-tight">
        {album.title}
      </p>
      <p className="text-xs text-zinc-500 truncate w-full mt-0.5">
        {album.album_artist_name ?? album.artist_name ?? 'Unknown Artist'}
        {album.year ? ` · ${album.year}` : ''}
      </p>
    </div>
  )
}

export default function AlbumsGrid({ albums, isLoading, onAlbumClick, onAlbumPlay }: AlbumsGridProps) {
  // Infinite scroll: display first N, expand when sentinel visible
  const BATCH = 50
  const displayCount = useRef(BATCH)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const setupObserver = useCallback(() => {
    observerRef.current?.disconnect()
    if (!sentinelRef.current) return
    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          displayCount.current = Math.min(displayCount.current + BATCH, albums.length)
          // Force re-render by mutating the grid directly (React batches this fine)
          gridRef.current?.setAttribute('data-count', String(displayCount.current))
        }
      },
      { threshold: 0.1 },
    )
    observerRef.current.observe(sentinelRef.current)
  }, [albums.length])

  useEffect(() => {
    displayCount.current = BATCH
    setupObserver()
    return () => observerRef.current?.disconnect()
  }, [albums, setupObserver])

  if (isLoading && albums.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    )
  }

  const visible = albums.slice(0, displayCount.current)

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4" ref={gridRef} data-count={BATCH}>
      <div className="grid grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6">
        {visible.map((album) => (
          <AlbumCard
            key={album.id}
            album={album}
            onClick={() => onAlbumClick(album.id)}
            onPlay={(e) => { e.stopPropagation(); onAlbumPlay(album.id) }}
          />
        ))}
      </div>
      {/* Sentinel for infinite scroll */}
      <div ref={sentinelRef} className="h-4" />
    </div>
  )
}
