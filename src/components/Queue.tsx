/**
 * Queue panel — shows the current and upcoming tracks.
 */

import { X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function Queue({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const {
    queue,
    queuePrimaryLength,
    radioArtistName,
    shuffledQueue,
    queueIndex,
    shuffle,
    currentTrack,
    removeFromQueue,
    clearQueue,
    jumpToQueueIndex,
    reorderQueue,
    setNotification,
  } = usePlayerStore()
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const activeQueue = shuffle ? shuffledQueue : queue
  const primaryUpcomingTracks = activeQueue.slice(queueIndex + 1, Math.max(queueIndex + 1, queuePrimaryLength))
  const radioUpcomingTracks = activeQueue.slice(Math.max(queueIndex + 1, queuePrimaryLength))
  const hasUpcomingTracks = primaryUpcomingTracks.length > 0 || radioUpcomingTracks.length > 0

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

  return (
    <aside
      className={`flex h-full w-[23rem] flex-col overflow-hidden rounded-[30px] border border-white/8 bg-black/22 shadow-[0_24px_70px_rgba(0,0,0,0.3)] backdrop-blur-2xl transition-all duration-300 ease-out ${
        open ? 'scale-100' : 'scale-[0.985]'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/8 px-5 py-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">Queue</p>
          <p className="mt-1 text-sm text-zinc-200">
            {Math.max(activeQueue.length - Math.max(queueIndex + 1, 0), 0)} upcoming
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {queue.length > 0 && (
            <button
              onClick={clearQueue}
              className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] text-zinc-400 hover:border-white/15 hover:bg-white/[0.05] hover:text-zinc-100 transition-colors"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 text-zinc-500 hover:border-white/15 hover:bg-white/[0.05] hover:text-zinc-200 transition-colors"
            title="Close queue"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Now playing */}
      {currentTrack && (
        <div className="border-b border-white/8 px-5 py-4">
          <p className="mb-2 text-[10px] uppercase tracking-[0.22em] text-zinc-500">
            Now Playing
          </p>
          <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3">
            <p className="text-sm text-zinc-100 truncate">{currentTrack.title}</p>
            <div className="mt-1 text-xs text-zinc-400 truncate flex items-center gap-1.5">
              {currentTrack.catalogArtistId ? (
                <button
                  className="truncate hover:text-zinc-100 transition-colors"
                  onClick={() => void openCatalogArtist(currentTrack.catalogArtistId!)}
                >
                  {currentTrack.artist}
                </button>
              ) : (
                <span className="truncate">{currentTrack.artist}</span>
              )}
              <span>—</span>
              {currentTrack.catalogAlbumId ? (
                <button
                  className="truncate hover:text-zinc-100 transition-colors"
                  onClick={() => void openCatalogAlbum(currentTrack.catalogAlbumId!)}
                >
                  {currentTrack.album}
                </button>
              ) : (
                <span className="truncate">{currentTrack.album}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Upcoming */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {!hasUpcomingTracks ? (
          <div className="flex h-full items-center justify-center">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-5 py-6 text-center">
              <p className="text-sm text-zinc-400">Queue is empty</p>
              <p className="mt-1 text-xs text-zinc-600">Add a playlist, album, or track to keep listening.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {primaryUpcomingTracks.length > 0 && (
              <QueueSection
                title={`Next Up · ${primaryUpcomingTracks.length} track${primaryUpcomingTracks.length !== 1 ? 's' : ''}`}
              >
                {primaryUpcomingTracks.map((track, i) => {
                  const absoluteIndex = queueIndex + 1 + i
                  return (
                    <QueueRow
                      key={`${track.id}-${absoluteIndex}`}
                      track={track}
                      indexLabel={i + 1}
                      draggable={!shuffle}
                      dragActive={dragOverIndex === absoluteIndex && draggedIndex !== absoluteIndex}
                      onOpenArtist={openCatalogArtist}
                      onOpenAlbum={openCatalogAlbum}
                      onPlay={() => jumpToQueueIndex(absoluteIndex)}
                      onRemove={() => removeFromQueue(absoluteIndex)}
                      onDragStart={handleDragStart(absoluteIndex)}
                      onDragOver={handleDragOver(absoluteIndex)}
                      onDrop={handleDrop(absoluteIndex)}
                      onDragEnd={handleDragEnd}
                    />
                  )
                })}
              </QueueSection>
            )}

            {radioUpcomingTracks.length > 0 && (
              <QueueSection
                title={`${radioArtistName ?? 'Artist'} Radio · ${radioUpcomingTracks.length} track${radioUpcomingTracks.length !== 1 ? 's' : ''}`}
              >
                {radioUpcomingTracks.map((track, i) => {
                  const absoluteIndex = Math.max(queueIndex + 1, queuePrimaryLength) + i
                  return (
                    <QueueRow
                      key={`${track.id}-${absoluteIndex}`}
                      track={track}
                      indexLabel={i + 1}
                      draggable={!shuffle}
                      dragActive={dragOverIndex === absoluteIndex && draggedIndex !== absoluteIndex}
                      onOpenArtist={openCatalogArtist}
                      onOpenAlbum={openCatalogAlbum}
                      onPlay={() => jumpToQueueIndex(absoluteIndex)}
                      onRemove={() => removeFromQueue(absoluteIndex)}
                      onDragStart={handleDragStart(absoluteIndex)}
                      onDragOver={handleDragOver(absoluteIndex)}
                      onDrop={handleDrop(absoluteIndex)}
                      onDragEnd={handleDragEnd}
                    />
                  )
                })}
              </QueueSection>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

function QueueSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section>
      <p className="px-2 pb-2 text-[10px] uppercase tracking-[0.22em] text-zinc-500">
        {title}
      </p>
      <div className="overflow-hidden rounded-2xl border border-white/7 bg-white/[0.03]">
        {children}
      </div>
    </section>
  )
}

function QueueRow({
  track,
  indexLabel,
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
  track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>
  indexLabel: number
  draggable: boolean
  dragActive: boolean
  onOpenArtist: (catalogArtistId: string) => Promise<void>
  onOpenAlbum: (catalogAlbumId: string) => Promise<void>
  onPlay: () => void
  onRemove: () => void
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
      className={`group flex items-center gap-3 border-t border-white/[0.04] px-4 py-3 first:border-t-0 hover:bg-white/[0.04] transition-colors cursor-pointer ${
        dragActive ? 'border-t-2 border-sky-400 bg-white/[0.05]' : ''
      }`}
      onClick={onPlay}
    >
      <span className="w-6 shrink-0 text-right text-xs font-mono text-zinc-600">
        {indexLabel}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-zinc-200">{track.title}</p>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-zinc-500">
          {track.catalogArtistId ? (
            <button
              className="truncate hover:text-zinc-100 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                void onOpenArtist(track.catalogArtistId!)
              }}
            >
              {track.artist}
            </button>
          ) : (
            <span className="truncate">{track.artist}</span>
          )}
          <span>—</span>
          {track.catalogAlbumId ? (
            <button
              className="truncate hover:text-zinc-100 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                void onOpenAlbum(track.catalogAlbumId!)
              }}
            >
              {track.album}
            </button>
          ) : (
            <span className="truncate">{track.album}</span>
          )}
        </div>
      </div>
      <span className="shrink-0 text-xs font-mono text-zinc-600">
        {formatDuration(track.duration)}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="text-zinc-600 opacity-0 transition-all hover:text-zinc-300 group-hover:opacity-100"
        title="Remove from queue"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
