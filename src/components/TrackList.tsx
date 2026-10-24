/**
 * TrackList — the one track list: playlists, albums, artist top tracks,
 * Tracks, Pins, History and Home all render rows through it. Callers map
 * their own track shape to TrackListRow and pick which columns to show; the
 * layout, hover, "now playing" and "…" menu behave the same everywhere.
 *
 * Below md the artist moves under the title; below lg the album column hides.
 * Rows the account cannot stream are greyed out like in the services' own
 * apps: clicking them does nothing, the reason shows on hover, and the "…"
 * menu still works.
 */

import type { CSSProperties, HTMLAttributes, MouseEvent, ReactNode } from 'react'
import { Ellipsis, Music, Play } from 'lucide-react'
import NowPlayingBars from './NowPlayingBars'

export interface TrackListRow {
  key: string
  title: string
  /** # column: track number or position. */
  number?: ReactNode
  artworkSrc?: string | null
  artist?: string | null
  onOpenArtist?: () => void
  album?: string | null
  onOpenAlbum?: () => void
  /** Inline after the title (Smart Stack label, explicit marker). */
  badges?: ReactNode
  /** Under the title (provider badges). */
  meta?: ReactNode
  /** Last column: duration, or "5 min ago" in history lists. */
  trailing: string
  /** The track that is playing now. */
  active?: boolean
  /** Set when the track cannot be played: the reason, shown on hover. */
  unavailable?: string | null
}

type RowProps = HTMLAttributes<HTMLDivElement> & { className?: string }

function columnTemplate(columns: { number: boolean; artist: boolean; album: boolean; more: boolean }) {
  return [
    columns.number ? '2.25rem' : null,
    'minmax(0,1.6fr)',
    columns.artist ? 'minmax(0,1fr)' : null,
    columns.album ? 'minmax(0,1fr)' : null,
    '4.75rem',
    columns.more ? '2rem' : null,
  ].filter(Boolean).join(' ')
}

function columnVars({
  showNumber,
  showArtist,
  showAlbum,
  hasMenu,
}: {
  showNumber: boolean
  showArtist: boolean
  showAlbum: boolean
  hasMenu: boolean
}): CSSProperties {
  return {
    '--tl-cols-sm': columnTemplate({ number: showNumber, artist: false, album: false, more: hasMenu }),
    '--tl-cols-md': columnTemplate({ number: showNumber, artist: showArtist, album: false, more: hasMenu }),
    '--tl-cols-lg': columnTemplate({ number: showNumber, artist: showArtist, album: showAlbum, more: hasMenu }),
  } as CSSProperties
}

const GRID = 'grid grid-cols-[var(--tl-cols-sm)] md:grid-cols-[var(--tl-cols-md)] lg:grid-cols-[var(--tl-cols-lg)] items-center gap-x-4 px-4'

function LinkText({ text, onOpen, className }: { text: string; onOpen?: () => void; className: string }) {
  if (!onOpen) return <span className={`truncate ${className}`}>{text}</span>
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
      className={`truncate text-left transition-colors hover:text-white hover:underline ${className}`}
    >
      {text}
    </button>
  )
}

export default function TrackList({
  rows,
  showNumber = true,
  showArtwork = true,
  showArtist = true,
  showAlbum = true,
  trailingLabel = 'Time',
  onPlay,
  onContextMenu,
  getRowProps,
}: {
  rows: TrackListRow[]
  showNumber?: boolean
  showArtwork?: boolean
  showArtist?: boolean
  showAlbum?: boolean
  trailingLabel?: string
  onPlay: (index: number, event: MouseEvent<HTMLDivElement>) => void
  /** Right-click and the "…" button. */
  onContextMenu?: (index: number, event: MouseEvent) => void
  /** Extra props per row: drag and drop, selection styling. */
  getRowProps?: (index: number) => RowProps
}) {
  const columns = columnVars({ showNumber, showArtist, showAlbum, hasMenu: !!onContextMenu })

  return (
    <div className="overflow-hidden rounded-2xl border border-white/5" style={columns} role="table">
      <div className={`${GRID} h-10 bg-white/[0.03] text-[11px] uppercase tracking-wider text-zinc-500`} role="row">
        {showNumber && <span>#</span>}
        <span>Title</span>
        {showArtist && <span className="hidden md:block">Artist</span>}
        {showAlbum && <span className="hidden lg:block">Album</span>}
        <span className="text-right">{trailingLabel}</span>
        {onContextMenu && <span />}
      </div>

      {rows.map((row, index) => {
        const { className: extraClassName = '', ...rowProps } = getRowProps?.(index) ?? {}
        const unavailable = !!row.unavailable
        return (
          <div
            key={row.key}
            role="row"
            aria-disabled={unavailable || undefined}
            title={row.unavailable ?? undefined}
            onClick={(event) => { if (!unavailable) onPlay(index, event) }}
            onContextMenu={onContextMenu ? (event) => {
              event.preventDefault()
              event.stopPropagation()
              onContextMenu(index, event)
            } : undefined}
            className={`group ${GRID} min-h-14 border-t border-white/[0.04] py-2 transition-colors ${
              unavailable ? 'cursor-default opacity-40' : 'cursor-pointer'
            } ${
              row.active ? 'bg-white/[0.06]' : unavailable ? '' : 'hover:bg-white/[0.04]'
            } ${extraClassName}`}
            {...rowProps}
          >
            {showNumber && (
              <span className="relative flex h-5 items-center font-mono text-xs text-zinc-500">
                {row.active ? (
                  <NowPlayingBars />
                ) : unavailable ? (
                  <span>{row.number}</span>
                ) : (
                  <>
                    <span className="group-hover:invisible">{row.number}</span>
                    <Play className="invisible absolute h-3.5 w-3.5 fill-current text-zinc-100 group-hover:visible" />
                  </>
                )}
              </span>
            )}

            <div className="flex min-w-0 items-center gap-3">
              {showArtwork && (
                <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-zinc-800/80">
                  {row.artworkSrc ? (
                    <img
                      src={row.artworkSrc}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                      onError={(event) => { event.currentTarget.style.display = 'none' }}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Music className="h-4 w-4 text-zinc-600" />
                    </div>
                  )}
                </div>
              )}
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <p className={`truncate text-sm ${row.active ? 'text-white' : 'text-zinc-100'}`}>{row.title}</p>
                  {row.badges}
                </div>
                {(row.meta || (showArtist && row.artist)) && (
                  <div className="mt-0.5 flex min-w-0 items-center gap-2">
                    {showArtist && row.artist && (
                      <LinkText text={row.artist} onOpen={row.onOpenArtist} className="text-xs text-zinc-500 md:hidden" />
                    )}
                    {row.meta}
                  </div>
                )}
              </div>
            </div>

            {showArtist && (
              <div className="hidden min-w-0 md:flex">
                {row.artist ? <LinkText text={row.artist} onOpen={row.onOpenArtist} className="text-sm text-zinc-400" /> : null}
              </div>
            )}
            {showAlbum && (
              <div className="hidden min-w-0 lg:flex">
                {row.album ? <LinkText text={row.album} onOpen={row.onOpenAlbum} className="text-sm text-zinc-400" /> : null}
              </div>
            )}

            <span className="text-right font-mono text-xs text-zinc-500">{row.trailing}</span>

            {onContextMenu && (
              <button
                type="button"
                aria-label={`More actions for ${row.title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onContextMenu(index, event)
                }}
                className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 opacity-0 transition-all hover:bg-white/[0.08] hover:text-zinc-100 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Ellipsis className="h-4 w-4" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Placeholder rows in the same layout while tracks load. */
export function TrackListSkeleton({ rows = 6, showArtwork = true }: { rows?: number; showArtwork?: boolean }) {
  const columns = columnVars({ showNumber: true, showArtist: true, showAlbum: true, hasMenu: false })
  return (
    <div className="overflow-hidden rounded-2xl border border-white/5" style={columns} aria-hidden>
      <div className={`${GRID} h-10 bg-white/[0.03] text-[11px] uppercase tracking-wider text-zinc-500`}>
        <span>#</span>
        <span>Title</span>
        <span className="hidden md:block">Artist</span>
        <span className="hidden lg:block">Album</span>
        <span className="text-right">Time</span>
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className={`${GRID} min-h-14 border-t border-white/[0.04] py-2`}>
          <span className="h-3 w-4 animate-pulse rounded-full bg-white/[0.05]" />
          <div className="flex min-w-0 items-center gap-3">
            {showArtwork && <div className="h-10 w-10 shrink-0 animate-pulse rounded-md bg-white/[0.06]" />}
            <div className="min-w-0 flex-1">
              <div className="h-3.5 w-48 max-w-full animate-pulse rounded-full bg-white/[0.06]" />
              <div className="mt-2 h-3 w-28 animate-pulse rounded-full bg-white/[0.04] md:hidden" />
            </div>
          </div>
          <div className="hidden h-3 w-28 animate-pulse rounded-full bg-white/[0.04] md:block" />
          <div className="hidden h-3 w-32 animate-pulse rounded-full bg-white/[0.04] lg:block" />
          <div className="h-3 w-9 animate-pulse justify-self-end rounded-full bg-white/[0.04]" />
        </div>
      ))}
    </div>
  )
}
