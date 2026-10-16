/**
 * PlaylistView — shows tracks in a playlist with drag-to-reorder,
 * context menu actions, and click-to-play.
 */

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { usePlayerStore, type PlaybackContext, type Track } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import type { TrackRow, PlaylistInfo } from '../../electron/preload'
import ArtworkThumbnail from './ArtworkThumbnail'
import ProviderBadge from './ProviderBadge'
import { trackRowToTrack } from '../store/libraryStore'
import { artworkUrl } from '../utils/artworkUrl'
import { recordRecentlyPlayedPlaylist } from '../services/homeRecents'

interface PlaylistViewProps {
  playlistId: number
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function rowToTrack(row: TrackRow): Track {
  return trackRowToTrack(row)
}

function rowArtistName(row: TrackRow): string {
  return row.artist_credit_name ?? row.artist_name ?? '—'
}

function getPlaylistItemId(row: TrackRow): number | null {
  return typeof row.playlist_item_id === 'number' ? row.playlist_item_id : null
}

function getSmartStackLabel(row: TrackRow): string | null {
  if (row.playlist_stack_id == null || row.playlist_stack_size == null) return null
  const position = (row.playlist_stack_position ?? 0) + 1
  return `Stack ${position}/${row.playlist_stack_size}`
}

function arePlaylistItemsContiguous(rows: TrackRow[], playlistItemIds: number[]): boolean {
  if (playlistItemIds.length < 2) return false

  const orderedMatches = rows
    .map((row, index) => ({ playlistItemId: getPlaylistItemId(row), index }))
    .filter((entry): entry is { playlistItemId: number; index: number } => entry.playlistItemId != null && playlistItemIds.includes(entry.playlistItemId))

  if (orderedMatches.length !== playlistItemIds.length) return false
  const firstIndex = orderedMatches[0]?.index ?? 0
  return orderedMatches.every((entry, index) => entry.index === firstIndex + index)
}

export default function PlaylistView({ playlistId }: PlaylistViewProps) {
  const [rows, setRows] = useState<TrackRow[]>([])
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [playlistName, setPlaylistName] = useState('')
  const [playlistReadOnly, setPlaylistReadOnly] = useState(false)
  const [playlistSource, setPlaylistSource] = useState<string>('local')
  const [playlistArtworkId, setPlaylistArtworkId] = useState<string | null>(null)
  const [playlistArtworkSrc, setPlaylistArtworkSrc] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null)
  const [isAddToPlaylistMenuOpen, setIsAddToPlaylistMenuOpen] = useState(false)
  const [selectedPlaylistItemIds, setSelectedPlaylistItemIds] = useState<number[]>([])
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const addToPlaylistCloseTimerRef = useRef<number | null>(null)

  const dragIndexRef = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const { setQueue, addToQueue, setNotification } = usePlayerStore()
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)

  const applyPlaylistData = useCallback((trackRows: TrackRow[], playlists: PlaylistInfo[]) => {
    setRows(trackRows)
    setPlaylists(playlists)
    setSelectedPlaylistItemIds((prev) => {
      const availableIds = new Set(
        trackRows
          .map((row) => getPlaylistItemId(row))
          .filter((value): value is number => value != null),
      )
      return prev.filter((playlistItemId) => availableIds.has(playlistItemId))
    })
    setSelectionAnchorId((prev) => {
      if (prev == null) return null
      return trackRows.some((row) => getPlaylistItemId(row) === prev) ? prev : null
    })

    const playlist = playlists.find((entry) => entry.id === playlistId)
    if (playlist) {
      setPlaylistName(playlist.name)
      setPlaylistReadOnly(playlist.read_only === 1 || playlist.legacy_mixed === 1)
      setPlaylistSource(playlist.playback_provider_id)
      setPlaylistArtworkId(playlist.artwork_id)
    } else {
      setPlaylistReadOnly(false)
      setPlaylistSource('local')
      setPlaylistArtworkId(null)
    }
  }, [playlistId])

  const loadTracks = useCallback(async () => {
    setIsLoading(true)
    try {
      const [trackRows, playlists] = await Promise.all([
        window.puros.playlists.getTracks(playlistId),
        window.puros.playlists.getAll(),
      ])
      applyPlaylistData(trackRows, playlists)
    } finally {
      setIsLoading(false)
    }
  }, [playlistId, applyPlaylistData])

  const silentRefresh = useCallback(async () => {
    try {
      const [trackRows, playlists] = await Promise.all([
        window.puros.playlists.getTracks(playlistId),
        window.puros.playlists.getAll(),
      ])
      applyPlaylistData(trackRows, playlists)
    } catch {
      // best effort
    }
  }, [playlistId, applyPlaylistData])

  useEffect(() => {
    void loadTracks()
    const unsub = window.puros.on('playlists:changed', () => { void silentRefresh() })
    return unsub
  }, [loadTracks, silentRefresh])

  const recordPlaylistPlayback = useCallback(() => {
    if (!playlistName) return
    void recordRecentlyPlayedPlaylist({
      entryKind: 'local-playlist',
      playlistId,
      name: playlistName,
      artworkId: playlistArtworkId,
      artworkUrl: playlistArtworkSrc,
      source: playlistSource,
      trackCount: rows.length,
    }).catch(() => {
      // Best effort only.
    })
  }, [playlistArtworkId, playlistArtworkSrc, playlistId, playlistName, playlistSource, rows.length])

  useEffect(() => {
    let cancelled = false
    const directArtwork = artworkUrl(playlistArtworkId, null) ?? null
    if (directArtwork) {
      setPlaylistArtworkSrc(directArtwork)
      return () => { cancelled = true }
    }

    setPlaylistArtworkSrc(null)
    window.puros.playlists.getArtwork(playlistId).then((url) => {
      if (!cancelled) setPlaylistArtworkSrc(url)
    })

    return () => { cancelled = true }
  }, [playlistArtworkId, playlistId])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!contextMenu) {
      setIsAddToPlaylistMenuOpen(false)
    }
  }, [contextMenu])

  const clearAddToPlaylistCloseTimer = useCallback(() => {
    if (addToPlaylistCloseTimerRef.current != null) {
      window.clearTimeout(addToPlaylistCloseTimerRef.current)
      addToPlaylistCloseTimerRef.current = null
    }
  }, [])

  const scheduleAddToPlaylistClose = useCallback(() => {
    clearAddToPlaylistCloseTimer()
    addToPlaylistCloseTimerRef.current = window.setTimeout(() => {
      setIsAddToPlaylistMenuOpen(false)
      addToPlaylistCloseTimerRef.current = null
    }, 120)
  }, [clearAddToPlaylistCloseTimer])

  useEffect(() => () => {
    clearAddToPlaylistCloseTimer()
  }, [clearAddToPlaylistCloseTimer])

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const playbackContext: PlaybackContext = useMemo(() => ({
    kind: 'playlist',
    label: playlistName || 'Playlist',
    playlistId,
  }), [playlistId, playlistName])
  const visibleRows = normalizedSearch
    ? rows
        .map((row, originalIndex) => ({ row, originalIndex }))
        .filter(({ row }) => {
          const haystack = [
            row.title,
            row.artist_credit_name ?? row.artist_name,
            row.album_title,
          ].filter(Boolean).join(' ').toLowerCase()
          return haystack.includes(normalizedSearch)
        })
    : rows.map((row, originalIndex) => ({ row, originalIndex }))

  const selectedPlaylistItemIdSet = useMemo(
    () => new Set(selectedPlaylistItemIds),
    [selectedPlaylistItemIds],
  )
  const visiblePlaylistItemIds = useMemo(
    () => visibleRows
      .map(({ row }) => getPlaylistItemId(row))
      .filter((value): value is number => value != null),
    [visibleRows],
  )
  const isLocalPlaylist = playlistSource === 'local' && !playlistReadOnly
  const canCreateSmartStack = isLocalPlaylist && arePlaylistItemsContiguous(rows, selectedPlaylistItemIds)
  const localDestinationPlaylists = useMemo(
    () => playlists.filter((playlist) => playlist.management === 'app' && playlist.read_only === 0 && !playlist.legacy_mixed && playlist.playback_provider_id === playlistSource && playlist.id !== playlistId),
    [playlistId, playlists, playlistSource],
  )

  useEffect(() => {
    if (isLocalPlaylist) return
    setSelectedPlaylistItemIds([])
    setSelectionAnchorId(null)
  }, [isLocalPlaylist])

  const resolveAndPlay = useCallback(async (options?: {
    shuffle?: boolean
    startPlaylistItemId?: number
    startTrackId?: string
    playlistItemIds?: number[]
  }) => {
    const resolved = await window.puros.playlists.resolvePlayback(playlistId, options)
    if (resolved.skippedCount) setNotification(`Skipped ${resolved.skippedCount} unavailable tracks`)
    if (resolved.rows.length === 0) { setNotification('No available tracks in this playlist'); return }
    recordPlaylistPlayback()
    setQueue(resolved.rows.map(rowToTrack), resolved.startIndex, playbackContext)
  }, [playbackContext, playlistId, recordPlaylistPlayback, setQueue, setNotification])

  const selectPlaylistRange = useCallback((toPlaylistItemId: number) => {
    if (selectionAnchorId == null) {
      setSelectedPlaylistItemIds([toPlaylistItemId])
      setSelectionAnchorId(toPlaylistItemId)
      return
    }

    const anchorIndex = rows.findIndex((row) => getPlaylistItemId(row) === selectionAnchorId)
    const targetIndex = rows.findIndex((row) => getPlaylistItemId(row) === toPlaylistItemId)
    if (anchorIndex < 0 || targetIndex < 0) {
      setSelectedPlaylistItemIds([toPlaylistItemId])
      setSelectionAnchorId(toPlaylistItemId)
      return
    }

    const [start, end] = anchorIndex < targetIndex
      ? [anchorIndex, targetIndex]
      : [targetIndex, anchorIndex]
    const rangeIds = rows
      .slice(start, end + 1)
      .map((row) => getPlaylistItemId(row))
      .filter((value): value is number => value != null)
    setSelectedPlaylistItemIds(rangeIds)
  }, [rows, selectionAnchorId])

  const handlePlayTrack = useCallback(async (
    event: React.MouseEvent<HTMLTableRowElement>,
    originalIndex: number,
  ) => {
    const row = rows[originalIndex]
    if (!row) return

    const playlistItemId = getPlaylistItemId(row)
    if (!isLocalPlaylist) {
      await resolveAndPlay({
        startPlaylistItemId: playlistItemId ?? undefined,
        startTrackId: row.id,
      })
      return
    }

    const isModifierSelection = !!playlistItemId && (event.metaKey || event.ctrlKey)
    if (isModifierSelection) {
      setSelectedPlaylistItemIds((prev) =>
        prev.includes(playlistItemId)
          ? prev.filter((value) => value !== playlistItemId)
          : [...prev, playlistItemId],
      )
      setSelectionAnchorId(playlistItemId)
      return
    }

    if (event.shiftKey && playlistItemId != null) {
      selectPlaylistRange(playlistItemId)
      return
    }

    if (playlistItemId != null) {
      setSelectedPlaylistItemIds([playlistItemId])
      setSelectionAnchorId(playlistItemId)
    } else {
      setSelectedPlaylistItemIds([])
      setSelectionAnchorId(null)
    }

    await resolveAndPlay({
      startPlaylistItemId: playlistItemId ?? undefined,
      startTrackId: row.id,
    })
  }, [isLocalPlaylist, resolveAndPlay, rows, selectPlaylistRange])

  const handlePlayPlaylist = useCallback(async () => {
    if (!visibleRows.length) return
    await resolveAndPlay({
      playlistItemIds: normalizedSearch ? visiblePlaylistItemIds : undefined,
    })
  }, [normalizedSearch, resolveAndPlay, visiblePlaylistItemIds, visibleRows.length])

  const handleShufflePlaylist = useCallback(async () => {
    if (!visibleRows.length) return
    await resolveAndPlay({
      shuffle: true,
      playlistItemIds: normalizedSearch ? visiblePlaylistItemIds : undefined,
    })
  }, [normalizedSearch, resolveAndPlay, visiblePlaylistItemIds, visibleRows.length])

  const handleSetPlaylistArtwork = useCallback(async () => {
    const result = await window.puros.playlists.setArtwork(playlistId)
    if (!result.changed) return
    setNotification('Playlist cover updated')
  }, [playlistId, setNotification])

  const handleResetPlaylistArtwork = useCallback(async () => {
    const result = await window.puros.playlists.clearArtwork(playlistId)
    if (!result.changed) return
    setNotification('Playlist cover reset')
  }, [playlistId, setNotification])

  const handleContextMenu = useCallback((e: React.MouseEvent, rowIndex: number) => {
    e.preventDefault()
    e.stopPropagation()

    const row = rows[rowIndex]
    const playlistItemId = row ? getPlaylistItemId(row) : null
    if (isLocalPlaylist && playlistItemId != null && !selectedPlaylistItemIdSet.has(playlistItemId)) {
      setSelectedPlaylistItemIds([playlistItemId])
      setSelectionAnchorId(playlistItemId)
    }

    let itemCount = 2
    if (isLocalPlaylist && canCreateSmartStack) itemCount += 1
    if (isLocalPlaylist && row?.playlist_stack_id != null) itemCount += 2
    if (!playlistReadOnly) itemCount += 1

    const menuW = 220
    const menuH = itemCount * 36 + 12
    setIsAddToPlaylistMenuOpen(false)
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - menuW - 8),
      y: Math.min(e.clientY, window.innerHeight - menuH - 8),
      rowIndex,
    })
  }, [canCreateSmartStack, isLocalPlaylist, playlistReadOnly, rows, selectedPlaylistItemIdSet])

  const handleAddTrackToQueue = useCallback(() => {
    if (!contextMenu) return
    const row = rows[contextMenu.rowIndex]
    if (!row) return
    setContextMenu(null)
    addToQueue(rowToTrack(row))
    setNotification(`Added to queue: ${row.title ?? 'Track'}`)
  }, [addToQueue, contextMenu, rows, setNotification])

  const getContextRows = useCallback((): TrackRow[] => {
    if (!contextMenu) return []
    const row = rows[contextMenu.rowIndex]
    if (!row) return []

    const playlistItemId = getPlaylistItemId(row)
    if (playlistItemId != null && selectedPlaylistItemIdSet.has(playlistItemId)) {
      return rows.filter((entry) => {
        const entryPlaylistItemId = getPlaylistItemId(entry)
        return entryPlaylistItemId != null && selectedPlaylistItemIdSet.has(entryPlaylistItemId)
      })
    }

    return [row]
  }, [contextMenu, rows, selectedPlaylistItemIdSet])

  const addRowsToPlaylist = useCallback(async (targetPlaylist: PlaylistInfo) => {
    const contextRows = getContextRows()
    if (contextRows.length === 0) return

    let addedCount = 0
    let skippedCount = 0
    for (const row of contextRows) {
      const result = await window.puros.playlists.addTrack(targetPlaylist.id, row.id)
      if (result.alreadyPresent) skippedCount += 1
      else addedCount += 1
    }

    setContextMenu(null)
    setIsAddToPlaylistMenuOpen(false)

    if (addedCount > 0 && skippedCount > 0) {
      setNotification(`Added ${addedCount} track${addedCount === 1 ? '' : 's'} to "${targetPlaylist.name}" • ${skippedCount} already there`)
      return
    }
    if (addedCount > 0) {
      setNotification(`Added ${addedCount} track${addedCount === 1 ? '' : 's'} to "${targetPlaylist.name}"`)
      return
    }
    setNotification(`Already in "${targetPlaylist.name}"`)
  }, [getContextRows, setNotification])

  const handleCreatePlaylistAndAddTracks = useCallback(async () => {
    const contextRows = getContextRows()
    if (contextRows.length === 0) return

    const playlistName = window.prompt('New playlist name')
    if (!playlistName?.trim()) return

    const newPlaylist = await window.puros.playlists.create(playlistName.trim(), undefined, playlistSource)
    await addRowsToPlaylist(newPlaylist)
  }, [addRowsToPlaylist, getContextRows, playlistSource])

  const handleCreateSmartStack = useCallback(async () => {
    if (!canCreateSmartStack) return
    setContextMenu(null)
    await window.puros.playlists.createSmartStack(playlistId, selectedPlaylistItemIds)
    setNotification('Created Smart Stack')
  }, [canCreateSmartStack, playlistId, selectedPlaylistItemIds, setNotification])

  const handleRemoveFromStack = useCallback(async () => {
    if (!contextMenu) return
    const row = rows[contextMenu.rowIndex]
    const playlistItemId = row ? getPlaylistItemId(row) : null
    if (!row || playlistItemId == null) return
    setContextMenu(null)
    await window.puros.playlists.removeFromSmartStack(playlistId, playlistItemId)
    setNotification('Removed from Smart Stack')
  }, [contextMenu, playlistId, rows, setNotification])

  const handleDissolveStack = useCallback(async () => {
    if (!contextMenu) return
    const row = rows[contextMenu.rowIndex]
    if (!row || row.playlist_stack_id == null) return
    setContextMenu(null)
    await window.puros.playlists.dissolveSmartStack(playlistId, row.playlist_stack_id)
    setNotification('Dissolved Smart Stack')
  }, [contextMenu, playlistId, rows, setNotification])

  const handleRemoveTrack = useCallback(async () => {
    if (!contextMenu) return
    const row = rows[contextMenu.rowIndex]
    if (!row) return
    const playlistItemId = getPlaylistItemId(row)
    setContextMenu(null)
    await window.puros.playlists.removeTrack(playlistId, playlistItemId ?? row.id)
    setRows((prev) => prev.filter((_, index) => index !== contextMenu.rowIndex))
    if (playlistItemId != null) {
      setSelectedPlaylistItemIds((prev) => prev.filter((value) => value !== playlistItemId))
      if (selectionAnchorId === playlistItemId) setSelectionAnchorId(null)
    }
  }, [contextMenu, playlistId, rows, selectionAnchorId])

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    if (playlistReadOnly) {
      e.preventDefault()
      return
    }
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('playlist-track', String(index))
  }, [playlistReadOnly])

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (playlistReadOnly) return
    if (dragIndexRef.current === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }, [playlistReadOnly])

  const handleDrop = useCallback(async (e: React.DragEvent, toIndex: number) => {
    if (playlistReadOnly) return
    e.preventDefault()
    const fromIndex = dragIndexRef.current
    dragIndexRef.current = null
    setDragOverIndex(null)
    if (fromIndex === null || fromIndex === toIndex) return

    setRows((prev) => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      if (!moved) return prev
      next.splice(toIndex, 0, moved)
      return next
    })

    await window.puros.playlists.reorderTracks(playlistId, fromIndex, toIndex)
  }, [playlistId, playlistReadOnly])

  const handleDragEnd = useCallback(() => {
    dragIndexRef.current = null
    setDragOverIndex(null)
  }, [])

  const contextRows = getContextRows()
  const contextTrackCount = contextRows.length
  const addToPlaylistSubmenuLeft = contextMenu
    ? Math.min(contextMenu.x + 214, window.innerWidth - 248)
    : 0
  const addToPlaylistSubmenuTop = contextMenu
    ? Math.min(contextMenu.y + 36, window.innerHeight - Math.min(360, localDestinationPlaylists.length * 36 + 88))
    : 0

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-6 shrink-0 border-b border-white/5">
        <div className="flex flex-col xl:flex-row gap-6">
          {playlistArtworkSrc ? (
            <img
              src={playlistArtworkSrc}
              alt=""
              className="w-40 h-40 rounded-3xl object-cover shrink-0 bg-zinc-900 border border-white/5"
            />
          ) : (
            <div className="w-40 h-40 rounded-3xl shrink-0 bg-white/[0.04] border border-white/5 flex items-center justify-center text-zinc-600 text-5xl font-semibold">
              {(playlistName || 'P').charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Playlist</p>
            </div>
            <h1 className="text-4xl font-semibold text-zinc-100 mt-2 truncate">{playlistName || 'Playlist'}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
              <ProviderBadge provider={playlistSource || 'local'} compact />
              <span>•</span>
              <span>{rows.length} {rows.length === 1 ? 'track' : 'tracks'}</span>
              {playlistReadOnly && (
                <>
                  <span>•</span>
                  <span>Read-only</span>
                </>
              )}
              {isLocalPlaylist && (
                <>
                  <span>•</span>
                  <span>Smart Stacks enabled</span>
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-2 mt-5">
              <button
                onClick={() => { void handlePlayPlaylist() }}
                disabled={!rows.length}
                className="px-4 py-2 rounded-xl bg-white text-zinc-950 text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-40"
              >
                Play Playlist
              </button>
              <button
                onClick={() => { void handleShufflePlaylist() }}
                disabled={!rows.length}
                className="px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-zinc-100 text-sm hover:bg-white/[0.1] transition-colors disabled:opacity-40"
              >
                Shuffle
              </button>
              {isLocalPlaylist && (
                <>
                  <button
                    onClick={() => { void handleSetPlaylistArtwork() }}
                    className="px-4 py-2 rounded-xl bg-white/[0.04] border border-white/10 text-zinc-200 text-sm hover:bg-white/[0.08] transition-colors"
                  >
                    Set Cover
                  </button>
                  {playlistArtworkId && (
                    <button
                      onClick={() => { void handleResetPlaylistArtwork() }}
                      className="px-4 py-2 rounded-xl bg-white/[0.04] border border-white/10 text-zinc-400 text-sm hover:bg-white/[0.08] hover:text-zinc-200 transition-colors"
                    >
                      Reset Cover
                    </button>
                  )}
                </>
              )}
              {isLocalPlaylist && selectedPlaylistItemIds.length > 0 && (
                <>
                  <button
                    onClick={() => { void handleCreateSmartStack() }}
                    disabled={!canCreateSmartStack}
                    title={canCreateSmartStack ? 'Create Smart Stack' : 'Select adjacent playlist items to create a Smart Stack'}
                    className="px-4 py-2 rounded-xl bg-emerald-400/12 border border-emerald-300/20 text-emerald-100 text-sm hover:bg-emerald-400/18 transition-colors disabled:opacity-40"
                  >
                    Create Smart Stack
                  </button>
                  <button
                    onClick={() => {
                      setSelectedPlaylistItemIds([])
                      setSelectionAnchorId(null)
                    }}
                    className="px-4 py-2 rounded-xl bg-white/[0.04] border border-white/10 text-zinc-300 text-sm hover:bg-white/[0.08] transition-colors"
                  >
                    Clear Selection
                  </button>
                </>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              {isLocalPlaylist && selectedPlaylistItemIds.length > 0 && (
                <span>{selectedPlaylistItemIds.length} selected</span>
              )}
              {isLocalPlaylist && (
                <span>Cmd/Ctrl-click or Shift-click to select adjacent tracks for Smart Stacks.</span>
              )}
            </div>
            <div className="mt-5 max-w-xl">
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search inside this playlist..."
                className="w-full px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/10 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-white/20"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-zinc-500">Loading...</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <p className="text-sm text-zinc-500">This playlist is empty</p>
            <p className="text-xs text-zinc-600">Drag tracks from your library</p>
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <p className="text-sm text-zinc-500">No matching tracks</p>
            <p className="text-xs text-zinc-600">Try a different title, artist, or album search.</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/5 overflow-hidden">
            <table className="w-full">
              <thead className="bg-white/[0.03] sticky top-0">
                <tr className="text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className="text-left px-4 py-3 font-medium w-10">#</th>
                  <th className="text-left px-4 py-3 font-medium">Title</th>
                  <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Artist</th>
                  <th className="text-left px-4 py-3 font-medium hidden lg:table-cell">Album</th>
                  <th className="text-right px-4 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(({ row, originalIndex }, visibleIndex) => {
                  const track = rowToTrack(row)
                  const playlistItemId = getPlaylistItemId(row)
                  const isSelected = isLocalPlaylist && playlistItemId != null && selectedPlaylistItemIdSet.has(playlistItemId)
                  const stackLabel = getSmartStackLabel(row)
                  const previousStackId = originalIndex > 0 ? rows[originalIndex - 1]?.playlist_stack_id ?? null : null
                  const nextStackId = originalIndex < rows.length - 1 ? rows[originalIndex + 1]?.playlist_stack_id ?? null : null
                  const isStackStart = row.playlist_stack_id != null && previousStackId !== row.playlist_stack_id
                  const isStackEnd = row.playlist_stack_id != null && nextStackId !== row.playlist_stack_id

                  return (
                    <tr
                      key={playlistItemId ?? `${row.id}-${originalIndex}`}
                      draggable={!playlistReadOnly}
                      onClick={(event) => { void handlePlayTrack(event, originalIndex) }}
                      onContextMenu={(e) => handleContextMenu(e, originalIndex)}
                      onDragStart={(e) => handleDragStart(e, originalIndex)}
                      onDragOver={(e) => handleDragOver(e, originalIndex)}
                      onDrop={(e) => { void handleDrop(e, originalIndex) }}
                      onDragEnd={handleDragEnd}
                      className={`group border-t border-white/[0.04] cursor-pointer hover:bg-white/[0.04] transition-colors ${
                        dragOverIndex === originalIndex && dragIndexRef.current !== originalIndex
                          ? 'border-t-2 border-sky-400'
                          : ''
                      } ${
                        isSelected ? 'bg-emerald-400/[0.08]' : ''
                      } ${
                        row.playlist_stack_id != null ? 'bg-sky-400/[0.03]' : ''
                      } ${
                        isStackStart ? 'border-t border-sky-300/25' : ''
                      } ${
                        isStackEnd ? 'shadow-[inset_0_-1px_0_rgba(125,211,252,0.18)]' : ''
                      }`}
                    >
                      <td className="px-4 py-3 text-xs text-zinc-500 font-mono">
                        {normalizedSearch ? originalIndex + 1 : visibleIndex + 1}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <ArtworkThumbnail src={track.coverUrl} size={40} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="text-sm text-zinc-100 truncate">{row.title}</p>
                              {stackLabel && (
                                <span className="shrink-0 rounded-full border border-sky-300/20 bg-sky-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-sky-200">
                                  {stackLabel}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 min-w-0 md:hidden">
                              <span className="text-xs text-zinc-500 truncate">{rowArtistName(row)}</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-400 truncate hidden md:table-cell">
                        {row.catalog_artist_id ? (
                          <button
                            className="truncate text-zinc-400 hover:text-zinc-100 transition-colors"
                            onClick={(event) => {
                              event.stopPropagation()
                              void openCatalogArtist(row.catalog_artist_id!)
                            }}
                          >
                            {rowArtistName(row)}
                          </button>
                        ) : (
                          rowArtistName(row)
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-400 truncate hidden lg:table-cell">
                        {row.catalog_album_id ? (
                          <button
                            className="truncate text-zinc-400 hover:text-zinc-100 transition-colors"
                            onClick={(event) => {
                              event.stopPropagation()
                              void openCatalogAlbum(row.catalog_album_id!)
                            }}
                          >
                            {row.album_title || '—'}
                          </button>
                        ) : (
                          row.album_title || '—'
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500 font-mono text-right">
                        {formatDuration(track.duration || 0)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-52 py-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={clearAddToPlaylistCloseTimer}
          onMouseLeave={scheduleAddToPlaylistClose}
        >
          <button
            className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
            onClick={handleAddTrackToQueue}
          >
            Add to Queue
          </button>
          <button
            className="w-full flex items-center justify-between text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
            onMouseEnter={() => {
              clearAddToPlaylistCloseTimer()
              setIsAddToPlaylistMenuOpen(true)
            }}
            onClick={(e) => e.preventDefault()}
          >
            <span>Add to Playlist</span>
            <span className="text-zinc-500">›</span>
          </button>
          {isLocalPlaylist && canCreateSmartStack && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-emerald-300 hover:bg-zinc-800 transition-colors"
              onClick={() => { void handleCreateSmartStack() }}
            >
              Create Smart Stack
            </button>
          )}
          {isLocalPlaylist && rows[contextMenu.rowIndex]?.playlist_stack_id != null && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
              onClick={() => { void handleRemoveFromStack() }}
            >
              Remove from Stack
            </button>
          )}
          {isLocalPlaylist && rows[contextMenu.rowIndex]?.playlist_stack_id != null && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
              onClick={() => { void handleDissolveStack() }}
            >
              Dissolve Stack
            </button>
          )}
          {!playlistReadOnly && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-zinc-800 transition-colors"
              onClick={() => { void handleRemoveTrack() }}
            >
              Remove from playlist
            </button>
          )}
        </div>
      )}
      {contextMenu && isAddToPlaylistMenuOpen && (
        <div
          className="fixed z-[60] min-w-60 max-h-80 overflow-y-auto py-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl"
          style={{ left: addToPlaylistSubmenuLeft, top: addToPlaylistSubmenuTop }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={clearAddToPlaylistCloseTimer}
          onMouseLeave={scheduleAddToPlaylistClose}
        >
          <div className="px-4 py-2 border-b border-zinc-800">
            <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Add to Playlist</p>
            <p className="mt-1 text-xs text-zinc-400">
              {contextTrackCount} track{contextTrackCount === 1 ? '' : 's'}
            </p>
          </div>
          <button
            className="w-full text-left px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 transition-colors"
            onClick={() => { void handleCreatePlaylistAndAddTracks() }}
          >
            Create New Playlist…
          </button>
          {localDestinationPlaylists.length > 0 ? (
            localDestinationPlaylists.map((playlist) => (
              <button
                key={playlist.id}
                className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
                onClick={() => { void addRowsToPlaylist(playlist) }}
              >
                {playlist.name}
              </button>
            ))
          ) : (
            <p className="px-4 py-2 text-sm text-zinc-500">No other local playlists</p>
          )}
        </div>
      )}
    </div>
  )
}
