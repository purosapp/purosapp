/**
 * MediaTile — the one tile for albums, singles, playlists and artists: square
 * cover (round for artists), title and subtitle underneath, a play button on
 * hover, and optional corner badges. MediaGrid lays tiles out with the same
 * auto-fitting columns on every page.
 */

import { forwardRef, useLayoutEffect, useState, type ReactNode } from 'react'
import { ListMusic, Music, Play, User, type LucideIcon } from 'lucide-react'
import type { CatalogSourceLink } from '../services/catalog/types'
import { showContextMenu, type ContextMenuEntry } from '../utils/contextMenu'
import ProviderBadge from './ProviderBadge'

export type MediaTileKind = 'album' | 'playlist' | 'artist'

const FALLBACK_ICON: Record<MediaTileKind, LucideIcon> = {
  album: Music,
  playlist: ListMusic,
  artist: User,
}

export function MediaTile({
  kind,
  title,
  subtitle,
  artworkSrc,
  onOpen,
  onPlay,
  contextActions,
  topLeft,
  topRight,
}: {
  kind: MediaTileKind
  title: string
  subtitle?: ReactNode
  artworkSrc?: string | null
  onOpen: () => void
  /** Shows the hover play button. */
  onPlay?: () => void
  contextActions?: ContextMenuEntry[]
  /** Corner overlays on the cover (pin button, provider badges, "VA"). */
  topLeft?: ReactNode
  topRight?: ReactNode
}) {
  const round = kind === 'artist'
  const Fallback = FALLBACK_ICON[kind]
  const shape = round ? 'rounded-full' : 'rounded-xl'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
      onContextMenu={(event) => {
        if (!contextActions?.length) return
        event.preventDefault()
        event.stopPropagation()
        void showContextMenu(contextActions)
      }}
      className={`group flex min-w-0 flex-col focus:outline-none ${round ? 'items-center text-center' : 'text-left'}`}
    >
      <div className={`relative mb-2.5 aspect-square w-full overflow-hidden bg-zinc-800/80 ${shape}`}>
        {artworkSrc ? (
          <img
            src={artworkSrc}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            onError={(event) => { event.currentTarget.style.display = 'none' }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Fallback className="h-10 w-10 text-zinc-600" strokeWidth={1.5} />
          </div>
        )}
        <div className={`pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/5 transition-shadow group-hover:ring-white/20 group-focus-visible:ring-white/40 ${shape}`} />
        {onPlay && (
          <button
            type="button"
            aria-label={`Play ${title}`}
            onClick={(event) => {
              event.stopPropagation()
              onPlay()
            }}
            className={`absolute flex h-10 w-10 items-center justify-center rounded-full bg-white text-zinc-950 shadow-[0_8px_24px_rgba(0,0,0,0.45)] opacity-0 translate-y-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-y-0 hover:scale-105 ${
              round ? 'bottom-[8%] right-[8%]' : 'bottom-2 right-2'
            }`}
          >
            <Play size={16} strokeWidth={2.25} className="ml-0.5 fill-current" />
          </button>
        )}
        {topLeft && <div className="absolute left-2 top-2">{topLeft}</div>}
        {topRight && <div className="absolute right-2 top-2 flex flex-wrap justify-end gap-1">{topRight}</div>}
      </div>

      <p className="w-full truncate text-sm leading-tight text-zinc-100 transition-colors group-hover:text-white">{title}</p>
      {subtitle && <p className="mt-1 w-full truncate text-xs text-zinc-500">{subtitle}</p>}
    </div>
  )
}

/** Auto-fitting tile columns, shared by every grid of tiles. */
export const MediaGrid = forwardRef<HTMLDivElement, { children: ReactNode }>(function MediaGrid({ children }, ref) {
  return (
    <div ref={ref} className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-4 gap-y-6">
      {children}
    </div>
  )
})

/**
 * How many columns a MediaGrid has at its current width, so a collapsed shelf
 * can show exactly one full row. Pass the returned ref to the MediaGrid; the
 * count follows window and sidebar resizes and is measured before paint.
 */
export function useMediaGridColumns(fallback = 6): [(element: HTMLDivElement | null) => void, number] {
  const [grid, setGrid] = useState<HTMLDivElement | null>(null)
  const [columns, setColumns] = useState(fallback)

  useLayoutEffect(() => {
    if (!grid) return
    const measure = () => {
      // auto-fill resolves to every track that fits, including empty ones.
      const count = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
      if (count > 0) setColumns(count)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [grid])

  return [setGrid, columns]
}

/** Icon-only provider badges for a tile corner, one per provider. */
export function SourceBadges({ sourceLinks }: { sourceLinks: CatalogSourceLink[] }) {
  const seen = new Set<string>()
  const sources = sourceLinks.filter((source) => {
    if (seen.has(source.provider)) return false
    seen.add(source.provider)
    return true
  })
  return (
    <>
      {sources.map((source, index) => (
        <ProviderBadge
          key={`${source.provider}:${source.sourceId ?? 'missing'}:${index}`}
          provider={source.provider}
          compact
          iconOnly
          className={`backdrop-blur-md ${source.inLibrary ? 'border-white/15 bg-black/55' : 'border-white/10 bg-black/40'}`}
        />
      ))}
    </>
  )
}

/** Placeholder grid while tiles load. */
export function MediaGridSkeleton({ count = 6, kind = 'album' }: { count?: number; kind?: MediaTileKind }) {
  const round = kind === 'artist'
  return (
    <MediaGrid>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={`flex flex-col ${round ? 'items-center' : ''}`}>
          <div className={`mb-2.5 aspect-square w-full animate-pulse bg-white/[0.06] ${round ? 'rounded-full' : 'rounded-xl'}`} />
          <div className="h-3.5 w-3/4 animate-pulse rounded-full bg-white/[0.06]" />
          <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded-full bg-white/[0.04]" />
        </div>
      ))}
    </MediaGrid>
  )
}
