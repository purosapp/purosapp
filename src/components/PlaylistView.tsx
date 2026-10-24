/**
 * PlaylistView — shows tracks in a playlist with drag-to-reorder,
 * native context menu actions, and click-to-play.
 */

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { usePlayerStore, type PlaybackContext, type Track } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import type { TrackRow, PlaylistInfo } from '../../electron/preload'
import TrackList, { TrackListSkeleton, type TrackListRow } from './TrackList'
import { PageStatus } from './ui'
import { formatTrackDuration } from '../utils/formatTime'
import { ArrowDownCircle, Download, HardDrive, ImageOff, ImagePlus, Layers, ListMusic, Lock, Play, Shuffle, X } from 'lucide-react'
import ProviderBadge from './ProviderBadge'
import CollectionView, { type CollectionAction, type CollectionMetaChip } from './CollectionView'
import { trackRowToTrack } from '../store/libraryStore'
import { artworkUrl } from '../utils/artworkUrl'
import { showContextMenu } from '../utils/contextMenu'
import { recordRecentlyPlayedPlaylist } from '../services/homeRecents'
import { unavailableTrackLabel } from '../utils/trackAvailability'
import { isPlaylistDownloadActive, useDownloadStore, usePlaylistDownloadState } from '../store/downloadStore'
import { formatBytes } from '../utils/formatBytes'

interface PlaylistViewProps {
  playlistId: number
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
  const [selectedPlaylistItemIds, setSelectedPlaylistItemIds] = useState<number[]>([])
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null)

  const dragIndexRef = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const { setQueue, addToQueue, setNotification } = usePlayerStore()
  const currentTrackId = usePlayerStore((state) => state.currentTrack?.id)
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const downloadState = usePlaylistDownloadState(playlistId)
  const downloadJob = useDownloadStore((state) => state.jobs[playlistId])
  const downloadedKeys = useMemo(() => new Set(downloadState?.downloadedKeys ?? []), [downloadState])

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
    event: React.MouseEvent<HTMLDivElement>,
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

  const addRowsToPlaylist = useCallback(async (contextRows: TrackRow[], targetPlaylist: PlaylistInfo) => {
    if (contextRows.length === 0) return

    let addedCount = 0
    let skippedCount = 0
    for (const row of contextRows) {
      const result = await window.puros.playlists.addTrack(targetPlaylist.id, row.id)
      if (result.alreadyPresent) skippedCount += 1
      else addedCount += 1
    }

    if (addedCount > 0 && skippedCount > 0) {
      setNotification(`Added ${addedCount} track${addedCount === 1 ? '' : 's'} to "${targetPlaylist.name}" • ${skippedCount} already there`)
      return
    }
    if (addedCount > 0) {
      setNotification(`Added ${addedCount} track${addedCount === 1 ? '' : 's'} to "${targetPlaylist.name}"`)
      return
    }
    setNotification(`Already in "${targetPlaylist.name}"`)
  }, [setNotification])

  const createPlaylistAndAddRows = useCallback(async (contextRows: TrackRow[]) => {
    if (contextRows.length === 0) return

    const playlistName = window.prompt('New playlist name')
    if (!playlistName?.trim()) return

    const newPlaylist = await window.puros.playlists.create(playlistName.trim(), undefined, playlistSource)
    await addRowsToPlaylist(contextRows, newPlaylist)
  }, [addRowsToPlaylist, playlistSource])

  const createSmartStack = useCallback(async (playlistItemIds: number[]) => {
    await window.puros.playlists.createSmartStack(playlistId, playlistItemIds)
    setNotification('Created Smart Stack')
  }, [playlistId, setNotification])

  const removeFromStack = useCallback(async (playlistItemId: number) => {
    await window.puros.playlists.removeFromSmartStack(playlistId, playlistItemId)
    setNotification('Removed from Smart Stack')
  }, [playlistId, setNotification])

  const dissolveStack = useCallback(async (stackId: number) => {
    await window.puros.playlists.dissolveSmartStack(playlistId, stackId)
    setNotification('Dissolved Smart Stack')
  }, [playlistId, setNotification])

  const removeTrack = useCallback(async (row: TrackRow) => {
    const playlistItemId = getPlaylistItemId(row)
    await window.puros.playlists.removeTrack(playlistId, playlistItemId ?? row.id)
    setRows((prev) => prev.filter((entry) => entry !== row))
    if (playlistItemId != null) {
      setSelectedPlaylistItemIds((prev) => prev.filter((value) => value !== playlistItemId))
      setSelectionAnchorId((prev) => (prev === playlistItemId ? null : prev))
    }
  }, [playlistId])

  const handleContextMenu = useCallback((e: React.MouseEvent, rowIndex: number) => {
    e.preventDefault()
    e.stopPropagation()

    const row = rows[rowIndex]
    if (!row) return
    const playlistItemId = getPlaylistItemId(row)
    const isRowSelected = playlistItemId != null && selectedPlaylistItemIdSet.has(playlistItemId)
    // Right-clicking outside the selection makes that row the selection.
    if (isLocalPlaylist && playlistItemId != null && !isRowSelected) {
      setSelectedPlaylistItemIds([playlistItemId])
      setSelectionAnchorId(playlistItemId)
    }

    const contextRows = isRowSelected
      ? rows.filter((entry) => {
          const entryPlaylistItemId = getPlaylistItemId(entry)
          return entryPlaylistItemId != null && selectedPlaylistItemIdSet.has(entryPlaylistItemId)
        })
      : [row]
    const stackId = isLocalPlaylist ? row.playlist_stack_id ?? null : null
    const stackPlaylistItemIds = selectedPlaylistItemIds

    void showContextMenu([
      {
        label: 'Add to Queue',
        onClick: () => {
          addToQueue(rowToTrack(row))
          setNotification(`Added to queue: ${row.title ?? 'Track'}`)
        },
      },
      {
        label: contextRows.length > 1 ? `Add ${contextRows.length} Tracks to Playlist` : 'Add to Playlist',
        submenu: [
          { label: 'Create New Playlist…', onClick: () => { void createPlaylistAndAddRows(contextRows) } },
          { type: 'separator' },
          ...(localDestinationPlaylists.length > 0
            ? localDestinationPlaylists.map((playlist) => ({
                label: playlist.name,
                onClick: () => { void addRowsToPlaylist(contextRows, playlist) },
              }))
            : [{ label: 'No other local playlists', enabled: false }]),
        ],
      },
      canCreateSmartStack && (isRowSelected || playlistItemId == null) && {
        label: 'Create Smart Stack',
        onClick: () => { void createSmartStack(stackPlaylistItemIds) },
      },
      stackId != null && playlistItemId != null && {
        label: 'Remove from Stack',
        onClick: () => { void removeFromStack(playlistItemId) },
      },
      stackId != null && {
        label: 'Dissolve Stack',
        onClick: () => { void dissolveStack(stackId) },
      },
      !playlistReadOnly && { type: 'separator' },
      !playlistReadOnly && { label: 'Remove from playlist', onClick: () => { void removeTrack(row) } },
    ])
  }, [
    addRowsToPlaylist,
    addToQueue,
    canCreateSmartStack,
    createPlaylistAndAddRows,
    createSmartStack,
    dissolveStack,
    isLocalPlaylist,
    localDestinationPlaylists,
    playlistReadOnly,
    removeFromStack,
    removeTrack,
    rows,
    selectedPlaylistItemIdSet,
    selectedPlaylistItemIds,
    setNotification,
  ])

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

  const clearSelection = () => {
    setSelectedPlaylistItemIds([])
    setSelectionAnchorId(null)
  }
  const actions: CollectionAction[] = [
    { id: 'play', label: 'Play', icon: Play, variant: 'primary', onClick: () => { void handlePlayPlaylist() }, disabled: !rows.length },
    { id: 'shuffle', label: 'Shuffle', icon: Shuffle, onClick: () => { void handleShufflePlaylist() }, disabled: !rows.length },
  ]
  if (isLocalPlaylist && selectedPlaylistItemIds.length > 0) {
    actions.push(
      {
        id: 'smart-stack',
        label: 'Create Smart Stack',
        icon: Layers,
        onClick: () => { void createSmartStack(selectedPlaylistItemIds) },
        disabled: !canCreateSmartStack,
        title: canCreateSmartStack ? 'Create Smart Stack' : 'Select adjacent playlist items to create a Smart Stack',
      },
      { id: 'clear-selection', label: 'Clear Selection', icon: X, variant: 'quiet', onClick: clearSelection },
    )
  }
  if (isLocalPlaylist) {
    actions.push({ id: 'set-cover', label: 'Set Cover', icon: ImagePlus, variant: 'quiet', align: 'end', onClick: () => { void handleSetPlaylistArtwork() } })
    if (playlistArtworkId) {
      actions.push({ id: 'reset-cover', label: 'Reset Cover', icon: ImageOff, variant: 'quiet', align: 'end', onClick: () => { void handleResetPlaylistArtwork() } })
    }
  }

  const chips: CollectionMetaChip[] = [
    { id: 'tracks', icon: ListMusic, label: `${rows.length} ${rows.length === 1 ? 'track' : 'tracks'}` },
  ]
  if (playlistReadOnly) chips.push({ id: 'read-only', icon: Lock, label: 'Read-only' })
  if (isLocalPlaylist) chips.push({ id: 'smart-stacks', icon: Layers, label: 'Smart Stacks' })
  if (isPlaylistDownloadActive(downloadJob) && downloadJob) {
    const done = downloadJob.completed + downloadJob.failed + downloadJob.skipped
    chips.push({
      id: 'downloaded',
      icon: Download,
      label: downloadJob.status === 'queued' || downloadJob.total === 0
        ? 'Download queued'
        : downloadJob.waitingUntil ? `Download paused ${done}/${downloadJob.total} • rate limited` : `Downloading ${done}/${downloadJob.total}`,
    })
  } else if (downloadState?.enabled) {
    chips.push({
      id: 'downloaded',
      icon: HardDrive,
      label: `${downloadState.downloaded}/${downloadState.total} downloaded • ${formatBytes(downloadState.totalBytes)}`,
    })
  }

  return (
    <CollectionView
      kind="Playlist"
      title={playlistName || 'Playlist'}
      artworkSrc={playlistArtworkSrc}
      byline={<ProviderBadge provider={playlistSource || 'local'} compact />}
      chips={chips}
      actions={actions}
      heroExtra={isLocalPlaylist ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          {selectedPlaylistItemIds.length > 0 && (
            <span className="text-zinc-300">{selectedPlaylistItemIds.length} selected</span>
          )}
          <span>Cmd/Ctrl-click or Shift-click to select adjacent tracks for Smart Stacks.</span>
        </div>
      ) : undefined}
      search={{ value: searchQuery, onChange: setSearchQuery, placeholder: 'Search inside this playlist...' }}
    >
      {isLoading ? (
        <TrackListSkeleton rows={8} />
      ) : rows.length === 0 ? (
        <PageStatus title="This playlist is empty" hint="Drag tracks from your library" />
      ) : visibleRows.length === 0 ? (
        <PageStatus title="No matching tracks" hint="Try a different title, artist, or album search." />
      ) : (
        <TrackList
          rows={visibleRows.map(({ row, originalIndex }, visibleIndex): TrackListRow => {
            const track = rowToTrack(row)
            const stackLabel = getSmartStackLabel(row)
            const isDownloaded = !!row.source_id && downloadedKeys.has(`${row.source}:${row.source_id}`)
            return {
              key: String(getPlaylistItemId(row) ?? `${row.id}-${originalIndex}`),
              number: normalizedSearch ? originalIndex + 1 : visibleIndex + 1,
              title: row.title ?? 'Unknown Track',
              artworkSrc: track.coverUrl,
              artist: rowArtistName(row),
              onOpenArtist: row.catalog_artist_id ? () => { void openCatalogArtist(row.catalog_artist_id!) } : undefined,
              album: row.album_title || '—',
              onOpenAlbum: row.catalog_album_id ? () => { void openCatalogAlbum(row.catalog_album_id!) } : undefined,
              badges: stackLabel || isDownloaded ? (
                <>
                  {isDownloaded && (
                    <span title="Downloaded" className="shrink-0 text-accent-300/80">
                      <ArrowDownCircle size={13} aria-label="Downloaded" />
                    </span>
                  )}
                  {stackLabel && (
                    <span className="shrink-0 rounded-full border border-accent-300/20 bg-accent-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-accent-200">
                      {stackLabel}
                    </span>
                  )}
                </>
              ) : undefined,
              trailing: formatTrackDuration(track.duration || 0),
              active: row.id === currentTrackId,
              unavailable: row.unavailable_reason ? unavailableTrackLabel(row.unavailable_reason) : null,
            }
          })}
          onPlay={(visibleIndex, event) => {
            const entry = visibleRows[visibleIndex]
            if (entry) void handlePlayTrack(event, entry.originalIndex)
          }}
          onContextMenu={(visibleIndex, event) => {
            const entry = visibleRows[visibleIndex]
            if (entry) handleContextMenu(event, entry.originalIndex)
          }}
          getRowProps={(visibleIndex) => {
            const entry = visibleRows[visibleIndex]
            if (!entry) return {}
            const { row, originalIndex } = entry
            const playlistItemId = getPlaylistItemId(row)
            const isSelected = isLocalPlaylist && playlistItemId != null && selectedPlaylistItemIdSet.has(playlistItemId)
            const previousStackId = originalIndex > 0 ? rows[originalIndex - 1]?.playlist_stack_id ?? null : null
            const nextStackId = originalIndex < rows.length - 1 ? rows[originalIndex + 1]?.playlist_stack_id ?? null : null
            const isStackStart = row.playlist_stack_id != null && previousStackId !== row.playlist_stack_id
            const isStackEnd = row.playlist_stack_id != null && nextStackId !== row.playlist_stack_id
            return {
              draggable: !playlistReadOnly,
              onDragStart: (event) => handleDragStart(event, originalIndex),
              onDragOver: (event) => handleDragOver(event, originalIndex),
              onDrop: (event) => { void handleDrop(event, originalIndex) },
              onDragEnd: handleDragEnd,
              className: [
                dragOverIndex === originalIndex && dragIndexRef.current !== originalIndex ? 'border-t-2 !border-t-accent-400' : '',
                isSelected ? '!bg-emerald-400/[0.08]' : '',
                row.playlist_stack_id != null ? 'bg-accent-400/[0.03]' : '',
                isStackStart ? '!border-t-accent-300/25' : '',
                isStackEnd ? 'shadow-[inset_0_-1px_0_color-mix(in_oklab,var(--accent)_25%,transparent)]' : '',
              ].join(' '),
            }
          }}
        />
      )}
    </CollectionView>
  )
}
