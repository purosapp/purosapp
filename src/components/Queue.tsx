/**
 * Queue sidebar — a docked column along the window's right edge, like
 * Music's Playing Next: playback toggles, the playing track, what plays
 * next, AutoPlay, and when the queue will finish.
 *
 * It mirrors the left sidebar: the window's native glass shows through it
 * (App clears the black backdrop under the column), behind the same light
 * tint and hairline, with sidebar-style headings and rows. It runs the full
 * window height, so its toolbar sits in the title bar.
 */

import { Clock3, History, Infinity as InfinityIcon, Music, Repeat, Repeat1, Shuffle, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { usePlayerStore, type Track } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import { useSettingsStore } from '../store/settingsStore'
import NowPlayingBars from './NowPlayingBars'
import { formatTotalDuration, formatTrackDuration } from '../utils/formatTime'
import { unavailableTrackLabel } from '../utils/trackAvailability'

/** Width of the queue column, in px. */
export const QUEUE_WIDTH = 320
const ROW_ARTWORK = 40

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

/** Same rows as the left sidebar: soft grey hover, a brighter grey for the playing track. */
const ROW_CLASS = 'group relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors'
const ROW_ACTIVE = 'bg-white/12'
const ROW_IDLE = 'cursor-pointer hover:bg-white/5'

export default function Queue({ onToggle }: { onToggle: () => void }) {
  const {
    queue,
    queuePrimaryLength,
    radioArtistName,
    shuffledQueue,
    queueIndex,
    shuffle,
    repeat,
    currentTrack,
    removeFromQueue,
    clearQueue,
    jumpToQueueIndex,
    reorderQueue,
    toggleShuffle,
    cycleRepeat,
    setNotification,
  } = usePlayerStore()
  const autoPlay = useSettingsStore((s) => s.endlessPlaybackEnabled)
  const setAutoPlay = useSettingsStore((s) => s.setEndlessPlaybackEnabled)
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const [showHistory, setShowHistory] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const activeQueue = shuffle ? shuffledQueue : queue
  const firstUpcoming = queueIndex + 1
  const radioStart = Math.max(firstUpcoming, queuePrimaryLength)
  const historyTracks = queueIndex > 0 ? activeQueue.slice(0, queueIndex) : []
  const primaryUpcomingTracks = activeQueue.slice(firstUpcoming, radioStart)
  const radioUpcomingTracks = activeQueue.slice(radioStart)
  const hasUpcomingTracks = primaryUpcomingTracks.length > 0 || radioUpcomingTracks.length > 0
  const upcomingSeconds = useMemo(
    () => activeQueue.slice(firstUpcoming).reduce((sum, track) => sum + (track.unavailableReason ? 0 : track.duration || 0), 0),
    [activeQueue, firstUpcoming],
  )

  // "From <playlist>": the context the queue was started from. Artist radio
  // labels its own section, so fall back to the next queued track's context.
  const sourceContext = currentTrack?.playbackContext?.kind !== 'artist-radio'
    ? currentTrack?.playbackContext ?? primaryUpcomingTracks[0]?.playbackContext
    : primaryUpcomingTracks[0]?.playbackContext
  const inPrimary = queueIndex >= 0 && queueIndex < queuePrimaryLength

  const handleDragStart = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    if (shuffle) {
      event.preventDefault()
      setNotification('Turn shuffle off to reorder the queue')
      return
    }
    setDraggedIndex(index)
    setDragOverIndex(index)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }

  const handleDragOver = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    if (shuffle || draggedIndex === null || draggedIndex === index) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }

  const handleDrop = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    if (shuffle || draggedIndex === null) return
    event.preventDefault()
    reorderQueue(draggedIndex, index)
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const handleDragEnd = () => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const renderRow = (track: Track, absoluteIndex: number, indexLabel: number | null, played = false) => (
    <QueueRow
      key={`${track.id}-${absoluteIndex}`}
      track={track}
      indexLabel={indexLabel}
      played={played}
      draggable={!shuffle && !played}
      dragActive={dragOverIndex === absoluteIndex && draggedIndex !== absoluteIndex}
      onOpenArtist={openCatalogArtist}
      onOpenAlbum={openCatalogAlbum}
      onPlay={() => jumpToQueueIndex(absoluteIndex)}
      onRemove={played ? undefined : () => removeFromQueue(absoluteIndex)}
      onDragStart={handleDragStart(absoluteIndex)}
      onDragOver={handleDragOver(absoluteIndex)}
      onDrop={handleDrop(absoluteIndex)}
      onDragEnd={handleDragEnd}
    />
  )

  return (
    <aside aria-label="Queue" className="relative flex h-full flex-col">
      {/* Title bar: the column covers the title bar's own queue toggle, so it
          draws one in the same spot, next to the playback modes. */}
      <div className="flex h-17 shrink-0 items-center gap-2 pr-4 pl-3" style={drag}>
        <div className="flex h-9 shrink-0 items-center rounded-full bg-zinc-900/80" style={noDrag}>
          <ToolbarToggle active={shuffle} title="Shuffle" onClick={toggleShuffle}>
            <Shuffle className="h-3.75 w-3.75" />
          </ToolbarToggle>
          <ToolbarToggle active={repeat !== 'off'} title={`Repeat: ${repeat}`} onClick={cycleRepeat}>
            {repeat === 'one' ? <Repeat1 className="h-3.75 w-3.75" /> : <Repeat className="h-3.75 w-3.75" />}
          </ToolbarToggle>
          <ToolbarToggle
            active={autoPlay}
            title={autoPlay ? 'AutoPlay on' : 'AutoPlay off'}
            onClick={() => void setAutoPlay(!autoPlay)}
          >
            <InfinityIcon className="h-4 w-4" />
          </ToolbarToggle>
        </div>
        {queue.length > 0 && (
          <button
            type="button"
            onClick={clearQueue}
            className="h-9 rounded-full bg-zinc-900/80 px-3.5 text-[13px] text-zinc-200 transition-colors hover:bg-white/8 hover:text-white"
            style={noDrag}
          >
            Clear
          </button>
        )}
        <div className="ml-auto">
          <QueueToggleButton open onToggle={onToggle} />
        </div>
      </div>

      {/* Rows fade out under the time-remaining capsule instead of running into it. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-16"
        style={{ maskImage: 'linear-gradient(to bottom, black calc(100% - 64px), transparent calc(100% - 8px))' }}
      >
        {showHistory && historyTracks.length > 0 && (
          <section className="pb-4">
            <SectionHeading title="History" />
            {historyTracks.map((track, i) => renderRow(track, i, null, true))}
          </section>
        )}

        {currentTrack && (
          <section>
            <SectionHeading
              title="Now Playing"
              accessory={historyTracks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHistory((value) => !value)}
                  aria-pressed={showHistory}
                  title={showHistory ? 'Hide history' : 'Show history'}
                  className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition-colors ${
                    showHistory ? 'bg-white/12 text-zinc-100' : 'text-zinc-500 hover:bg-white/6 hover:text-zinc-200'
                  }`}
                >
                  <History className="h-3 w-3" />
                  {historyTracks.length}
                </button>
              )}
            />
            <div className={`${ROW_CLASS} ${ROW_ACTIVE}`}>
              <div className="relative shrink-0">
                <QueueArtwork src={currentTrack.coverUrl ?? currentTrack.artworkUrl} />
                <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/45">
                  <NowPlayingBars />
                </div>
              </div>
              <TrackText
                track={currentTrack}
                onOpenArtist={openCatalogArtist}
                onOpenAlbum={openCatalogAlbum}
              />
            </div>
          </section>
        )}

        {!hasUpcomingTracks ? (
          <div className="px-4 pt-10 text-center">
            <p className="text-[13px] text-zinc-400">Nothing up next</p>
            <p className="mt-1 text-xs text-zinc-600">Add a playlist, album, or track to keep listening.</p>
            {autoPlay && currentTrack && (
              <p className="mt-3 text-xs text-zinc-500">AutoPlay will continue with similar music.</p>
            )}
          </div>
        ) : (
          <>
            {primaryUpcomingTracks.length > 0 && (
              <section className="pt-5">
                <SectionHeading
                  title="Playing Next"
                  subtitle={sourceContext ? `From ${sourceContext.label}` : undefined}
                  accessory={inPrimary && (
                    <span className="text-[11px] tabular-nums text-zinc-500">
                      {queueIndex + 1} of {queuePrimaryLength}
                    </span>
                  )}
                />
                {primaryUpcomingTracks.map((track, i) => renderRow(track, firstUpcoming + i, firstUpcoming + i + 1))}
              </section>
            )}

            {radioUpcomingTracks.length > 0 && (
              <section className="pt-5">
                <SectionHeading
                  icon={<InfinityIcon className="h-3.5 w-3.5" />}
                  title="AutoPlay"
                  subtitle={`${radioArtistName ?? 'Artist'} Radio`}
                />
                {radioUpcomingTracks.map((track, i) => renderRow(track, radioStart + i, null))}
              </section>
            )}
          </>
        )}
      </div>

      {currentTrack && <QueueFooter upcomingSeconds={upcomingSeconds} />}
    </aside>
  )
}

/** The title bar's queue toggle; the open queue draws its own copy in the same spot. */
export function QueueToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      title="Toggle queue"
      className={`group flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
        open ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:bg-white/6 hover:text-zinc-200'
      }`}
      style={noDrag}
    >
      <QueueIcon />
    </button>
  )
}

function QueueIcon() {
  return (
    <svg
      className="queue-icon h-4.5 w-4.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path className="queue-icon-line" d="M16 5H3" />
      <path className="queue-icon-line" d="M11 12H3" />
      <path className="queue-icon-line" d="M11 19H3" />
      <g className="queue-icon-note">
        <path d="M21 16V5" />
        <circle cx="18" cy="16" r="3" />
      </g>
    </svg>
  )
}

/** "1 hr 25 min → 11:08 PM": time left in the queue and when it will end. */
function QueueFooter({ upcomingSeconds }: { upcomingSeconds: number }) {
  const position = usePlayerStore((s) => s.position)
  const duration = usePlayerStore((s) => s.duration)
  const trackDuration = usePlayerStore((s) => s.currentTrack?.duration ?? 0)
  const repeat = usePlayerStore((s) => s.repeat)
  if (repeat !== 'off') return null

  const remaining = Math.max(0, (duration || trackDuration) - position) + upcomingSeconds
  if (remaining < 60) return null
  const endsAt = new Date(Date.now() + remaining * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <div className="flex h-8 items-center gap-1.5 rounded-full bg-zinc-900/80 px-3 text-[11px] tabular-nums text-zinc-300">
        <Clock3 className="h-3 w-3 text-zinc-500" />
        <span>{formatTotalDuration(remaining)}</span>
        <span className="text-zinc-600">→</span>
        <span>{endsAt}</span>
      </div>
    </div>
  )
}

/** One segment of the toolbar capsule; styled like the title bar's back/forward pair. */
function ToolbarToggle({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`flex h-full w-9 items-center justify-center rounded-full transition-colors ${
        active ? 'bg-accent-400/15 text-accent-400' : 'text-zinc-300 hover:bg-white/8 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

/** Section title in the left sidebar's style ("Library", "Playlists"). */
function SectionHeading({
  title,
  subtitle,
  icon,
  accessory,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  accessory?: ReactNode
}) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-3 px-2 pb-1.5">
      <div className="min-w-0">
        <p className="flex items-center gap-1 text-[11px] font-semibold text-zinc-500">
          {icon}
          {title}
        </p>
        {subtitle && <p className="mt-0.5 truncate text-[13px] text-zinc-200">{subtitle}</p>}
      </div>
      {accessory && <div className="shrink-0">{accessory}</div>}
    </div>
  )
}

/**
 * Lazy, decode-off-thread artwork for queue rows. Queues can hold whole
 * playlists, so rows skip ArtworkThumbnail's preload-and-crossfade.
 */
function QueueArtwork({ src, size = ROW_ARTWORK }: { src: string | null | undefined; size?: number }) {
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md bg-zinc-800"
      style={{ width: size, height: size }}
    >
      <Music className="absolute inset-0 m-auto text-zinc-600" style={{ width: size * 0.4, height: size * 0.4 }} />
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </div>
  )
}

function TrackText({
  track,
  onOpenArtist,
  onOpenAlbum,
}: {
  track: Track
  onOpenArtist: (catalogArtistId: string) => Promise<void>
  onOpenAlbum: (catalogAlbumId: string) => Promise<void>
}) {
  const { catalogArtistId, catalogAlbumId } = track
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-[13px] text-zinc-100">{track.title}</p>
      {/* One line that truncates as a whole, so the album isn't cut short
          while the artist still fits. The links are inline spans for that. */}
      <p className="mt-0.5 truncate text-xs text-zinc-500">
        <TextLink onClick={catalogArtistId ? () => void onOpenArtist(catalogArtistId) : undefined}>
          {track.artist}
        </TextLink>
        <span className="text-zinc-600"> – </span>
        <TextLink onClick={catalogAlbumId ? () => void onOpenAlbum(catalogAlbumId) : undefined}>
          {track.album}
        </TextLink>
      </p>
    </div>
  )
}

function TextLink({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  if (!onClick) return <span>{children}</span>
  return (
    <span
      role="link"
      tabIndex={0}
      className="cursor-pointer transition-colors hover:text-zinc-200 hover:underline"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </span>
  )
}

function QueueRow({
  track,
  indexLabel,
  played,
  draggable,
  dragActive,
  onOpenArtist,
  onOpenAlbum,
  onPlay,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  track: Track
  indexLabel: number | null
  played: boolean
  draggable: boolean
  dragActive: boolean
  onOpenArtist: (catalogArtistId: string) => Promise<void>
  onOpenAlbum: (catalogAlbumId: string) => Promise<void>
  onPlay: () => void
  onRemove?: () => void
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={track.unavailableReason ? undefined : onPlay}
      title={track.unavailableReason ? unavailableTrackLabel(track.unavailableReason) : undefined}
      className={`${ROW_CLASS} ${ROW_IDLE} [contain-intrinsic-size:auto_52px] [content-visibility:auto] ${
        track.unavailableReason ? 'cursor-default opacity-40' : played ? 'opacity-50 hover:opacity-100' : ''
      }`}
    >
      {/* Drop indicator: an accent line above the row being dragged over. */}
      {dragActive && <span className="absolute inset-x-2 -top-px h-0.5 rounded-full bg-accent-400" />}
      {indexLabel !== null && (
        <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">{indexLabel}</span>
      )}
      <QueueArtwork src={track.coverUrl ?? track.artworkUrl} />
      <TrackText track={track} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} />
      <span className="shrink-0 text-[11px] tabular-nums text-zinc-500 group-hover:hidden">
        {formatTrackDuration(track.duration)}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 group-hover:flex"
          title="Remove from queue"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
