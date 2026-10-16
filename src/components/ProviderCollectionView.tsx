import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HomeProviderCollectionBundle, HomeProviderCollectionItem, HomeProviderTrack } from '../services/homeProviderShelves'
import { usePlayerStore, waitForPlaybackStart, type PlaybackContext, type Track } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import ProviderBadge from './ProviderBadge'
import ArtworkThumbnail from './ArtworkThumbnail'
import { fisherYatesShuffle } from '../services/local/scanner'
import { recordRecentlyPlayedPlaylist } from '../services/homeRecents'
import type { CatalogResolvedPlaybackTrack } from '../services/catalog/types'
import { getProviderTrackShareUrl } from '../utils/providerShare'
import { useProviderStatusStore } from '../store/providerStatusStore'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function providerTrackToPlaybackTrack(row: HomeProviderTrack): Track {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    catalogTrackId: row.catalogTrackId ?? undefined,
    catalogAlbumId: row.catalogAlbumId ?? null,
    catalogArtistId: row.catalogArtistId ?? null,
    sourceType: String(row.provider),
    sourceId: row.sourceId,
    streamId: row.sourceId,
    provider: String(row.provider),
    coverUrl: row.artworkUrl,
    artworkUrl: row.artworkUrl,
    discordArtworkUrl: row.discordArtworkUrl ?? null,
    formatInfo: row.formatInfo ?? undefined,
  }
}

function resolvedPlaybackToTrack(row: HomeProviderTrack, resolved: CatalogResolvedPlaybackTrack): Track {
  return {
    id: resolved.id,
    title: row.title || resolved.title,
    artist: row.artist || resolved.artist,
    album: row.album || resolved.album,
    duration: row.duration || resolved.duration,
    catalogTrackId: resolved.catalogTrackId ?? row.catalogTrackId ?? undefined,
    catalogAlbumId: resolved.catalogAlbumId ?? null,
    catalogArtistId: resolved.catalogArtistId ?? null,
    sourceType: resolved.sourceType,
    sourceId: resolved.sourceId,
    displayMetadataSource: resolved.displayMetadataSource,
    filePath: resolved.filePath,
    playbackFilePath: resolved.playbackFilePath,
    streamId: resolved.streamId,
    fallbackStreamIds: resolved.fallbackStreamIds,
    provider: resolved.provider,
    coverUrl: row.artworkUrl ?? resolved.coverUrl ?? null,
    artworkUrl: row.artworkUrl ?? resolved.artworkUrl ?? null,
    discordArtworkUrl: row.discordArtworkUrl ?? resolved.discordArtworkUrl ?? null,
    formatInfo: resolved.formatInfo ?? row.formatInfo ?? undefined,
    startOffsetMs: resolved.startOffsetMs ?? 0,
    endOffsetMs: resolved.endOffsetMs ?? null,
    cueSheetPath: resolved.cueSheetPath ?? null,
  }
}

export default function ProviderCollectionView({
  collection,
}: {
  collection: HomeProviderCollectionItem
}) {
  const [bundle, setBundle] = useState<HomeProviderCollectionBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  // Monotonic token so a newer play action cancels in-flight background queue
  // hydration from a previous one.
  const playbackRequestRef = useRef(0)
  const { setQueue, addToQueue, setNotification } = usePlayerStore()
  const providerDisplayName = useProviderStatusStore((state) => (
    state.providers.find(({ manifest }) => manifest.id === String(collection.provider))?.manifest.displayName
      ?? String(collection.provider)
  ))
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)

  const loadBundle = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.puros.home.getProviderCollection(
        String(collection.provider),
        collection.sourceType,
        collection.sourceId,
      )
      setBundle(next)
    } finally {
      setLoading(false)
    }
  }, [collection.provider, collection.sourceId, collection.sourceType])

  useEffect(() => {
    void loadBundle()
  }, [loadBundle])

  const rows = useMemo(() => bundle?.tracks ?? [], [bundle?.tracks])
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const visibleRows = useMemo(
    () => normalizedSearch
      ? rows.filter((row) => [row.title, row.artist, row.album].join(' ').toLowerCase().includes(normalizedSearch))
      : rows,
    [normalizedSearch, rows],
  )
  const playbackContext: PlaybackContext = useMemo(() => ({
    kind: 'provider-playlist',
    label: bundle?.title ?? collection.title,
    provider: String(collection.provider),
    sourceType: collection.sourceType,
    sourceId: collection.sourceId,
    itemId: collection.id,
    subtitle: bundle?.subtitle ?? collection.subtitle,
    artworkUrl: bundle?.artworkUrl ?? collection.artworkUrl,
    providerUrl: bundle?.providerUrl ?? collection.providerUrl,
    trackCount: rows.length > 0 ? rows.length : (collection.trackCount ?? null),
    syncedPlaylistId: collection.syncedPlaylistId ?? null,
  }), [
    bundle?.artworkUrl,
    bundle?.providerUrl,
    bundle?.subtitle,
    bundle?.title,
    collection.artworkUrl,
    collection.id,
    collection.provider,
    collection.providerUrl,
    collection.sourceId,
    collection.sourceType,
    collection.subtitle,
    collection.syncedPlaylistId,
    collection.title,
    collection.trackCount,
    rows.length,
  ])

  const resolvePlaybackTrack = useCallback(async (
    row: HomeProviderTrack,
    options?: { allowDiscovery?: boolean },
  ) => {
    if (!row.catalogTrackId) return providerTrackToPlaybackTrack(row)
    try {
      const playback = await window.puros.catalog.resolvePlayback(row.catalogTrackId, row.provider, row.sourceId, options)
      return playback ? resolvedPlaybackToTrack(row, playback) : providerTrackToPlaybackTrack(row)
    } catch (error) {
      console.warn('[Puros][Home] Failed to resolve provider collection playback row:', error)
      return providerTrackToPlaybackTrack(row)
    }
  }, [])

  // Resolve and play ONLY the selected track up front, then hydrate the rest of
  // the queue lazily in the background. Resolving every visible row before
  // playback (the old Promise.all) fired a per-track source lookup for the
  // whole list, stalling the song the user actually clicked. Mirrors
  // catalogStore.playTracks — the shared catalog/library playback path.
  const startPlaybackFromRows = useCallback(async (orderedRows: HomeProviderTrack[], startIndex: number) => {
    if (!orderedRows.length) return
    const safeStartIndex = Math.max(0, Math.min(startIndex, orderedRows.length - 1))
    const selectedRow = orderedRows[safeStartIndex]
    if (!selectedRow) return

    const requestId = ++playbackRequestRef.current
    const resolvedSelected = await resolvePlaybackTrack(selectedRow)
    if (requestId !== playbackRequestRef.current) return
    setQueue([resolvedSelected], 0, playbackContext)

    const remainingRows = [
      ...orderedRows.slice(safeStartIndex + 1),
      ...orderedRows.slice(0, safeStartIndex),
    ]
    void (async () => {
      // Hold queue hydration until the clicked track is actually playing.
      await waitForPlaybackStart(resolvedSelected.id, () => requestId === playbackRequestRef.current)
      for (const row of remainingRows) {
        if (requestId !== playbackRequestRef.current) return
        // Known sources only for background queue rows — no per-track network
        // discovery while the selected track is starting up.
        const next = await resolvePlaybackTrack(row, { allowDiscovery: false })
        if (requestId !== playbackRequestRef.current) return
        addToQueue(next)
      }
    })()
  }, [addToQueue, playbackContext, resolvePlaybackTrack, setQueue])

  useEffect(() => {
    if (!contextMenu) return

    const handlePointerDown = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return
      setContextMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu, contextMenuRef])

  const handlePlayTrack = useCallback(async (index: number) => {
    void recordRecentlyPlayedPlaylist({
      entryKind: 'provider-playlist',
      name: playbackContext.label,
      artworkUrl: playbackContext.artworkUrl ?? null,
      source: String(collection.provider),
      trackCount: playbackContext.trackCount ?? rows.length,
      provider: String(collection.provider),
      sourceType: collection.sourceType,
      sourceId: collection.sourceId,
      itemId: collection.id,
      subtitle: playbackContext.subtitle ?? null,
      providerUrl: playbackContext.providerUrl ?? null,
      syncedPlaylistId: collection.syncedPlaylistId ?? null,
    }).catch(() => {
      // Best effort only.
    })
    await startPlaybackFromRows(visibleRows, index)
  }, [collection.id, collection.provider, collection.sourceId, collection.sourceType, collection.syncedPlaylistId, playbackContext, rows.length, startPlaybackFromRows, visibleRows])

  const handlePlayCollection = useCallback(async () => {
    if (!visibleRows.length) return
    void recordRecentlyPlayedPlaylist({
      entryKind: 'provider-playlist',
      name: playbackContext.label,
      artworkUrl: playbackContext.artworkUrl ?? null,
      source: String(collection.provider),
      trackCount: playbackContext.trackCount ?? rows.length,
      provider: String(collection.provider),
      sourceType: collection.sourceType,
      sourceId: collection.sourceId,
      itemId: collection.id,
      subtitle: playbackContext.subtitle ?? null,
      providerUrl: playbackContext.providerUrl ?? null,
      syncedPlaylistId: collection.syncedPlaylistId ?? null,
    }).catch(() => {
      // Best effort only.
    })
    await startPlaybackFromRows(visibleRows, 0)
  }, [collection.id, collection.provider, collection.sourceId, collection.sourceType, collection.syncedPlaylistId, playbackContext, rows.length, startPlaybackFromRows, visibleRows])

  const handleShuffleCollection = useCallback(async () => {
    if (!visibleRows.length) return
    void recordRecentlyPlayedPlaylist({
      entryKind: 'provider-playlist',
      name: playbackContext.label,
      artworkUrl: playbackContext.artworkUrl ?? null,
      source: String(collection.provider),
      trackCount: playbackContext.trackCount ?? rows.length,
      provider: String(collection.provider),
      sourceType: collection.sourceType,
      sourceId: collection.sourceId,
      itemId: collection.id,
      subtitle: playbackContext.subtitle ?? null,
      providerUrl: playbackContext.providerUrl ?? null,
      syncedPlaylistId: collection.syncedPlaylistId ?? null,
    }).catch(() => {
      // Best effort only.
    })
    await startPlaybackFromRows(fisherYatesShuffle(visibleRows), 0)
  }, [collection.id, collection.provider, collection.sourceId, collection.sourceType, collection.syncedPlaylistId, playbackContext, rows.length, startPlaybackFromRows, visibleRows])

  const handleContextMenu = useCallback((event: React.MouseEvent, rowIndex: number) => {
    event.preventDefault()
    event.stopPropagation()
    const menuW = 220
    const row = visibleRows[rowIndex]
    const itemCount = row && getProviderTrackShareUrl({
      providerUrl: row.providerUrl,
    }) ? 2 : 1
    const menuH = itemCount * 36 + 12
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - menuW - 8),
      y: Math.min(event.clientY, window.innerHeight - menuH - 8),
      rowIndex,
    })
  }, [visibleRows])

  const handleAddTrackToQueue = useCallback(async () => {
    if (!contextMenu) return
    const row = visibleRows[contextMenu.rowIndex]
    if (!row) return
    setContextMenu(null)
    const track = await resolvePlaybackTrack(row)
    addToQueue(track)
    setNotification(`Added to queue: ${row.title ?? 'Track'}`)
  }, [addToQueue, contextMenu, resolvePlaybackTrack, setNotification, visibleRows])

  const handleShareTrackLink = useCallback(async () => {
    if (!contextMenu) return
    const row = visibleRows[contextMenu.rowIndex]
    if (!row) return
    const shareUrl = getProviderTrackShareUrl({
      providerUrl: row.providerUrl,
    })
    if (!shareUrl) return
    await window.puros.app.copyToClipboard(shareUrl)
    setContextMenu(null)
    setNotification('Song link copied')
  }, [contextMenu, setNotification, visibleRows])

  const handleOpenArtist = useCallback(async (event: React.MouseEvent, row: HomeProviderTrack) => {
    event.stopPropagation()
    const artistId = row.catalogArtistId
      ?? (row.catalogTrackId ? (await window.puros.catalog.getTrack(row.catalogTrackId))?.primaryArtistId : null)
    if (artistId) {
      await openCatalogArtist(artistId)
    }
  }, [openCatalogArtist])

  const handleOpenAlbum = useCallback(async (event: React.MouseEvent, row: HomeProviderTrack) => {
    event.stopPropagation()
    const albumId = row.catalogAlbumId
      ?? (row.catalogTrackId ? (await window.puros.catalog.getTrack(row.catalogTrackId))?.albumId : null)
    if (albumId) {
      await openCatalogAlbum(albumId)
    }
  }, [openCatalogAlbum])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-6 shrink-0 border-b border-white/5">
        <div className="flex flex-col xl:flex-row gap-6">
          {bundle?.artworkUrl || collection.artworkUrl ? (
            <img
              src={bundle?.artworkUrl ?? collection.artworkUrl ?? ''}
              alt=""
              className="w-40 h-40 rounded-3xl object-cover shrink-0 bg-zinc-900 border border-white/5"
            />
          ) : (
            <div className="w-40 h-40 rounded-3xl shrink-0 bg-white/[0.04] border border-white/5 flex items-center justify-center text-zinc-600 text-5xl font-semibold">
              {collection.title.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">
                {collection.sourceType === 'station' ? 'Station' : collection.sourceType === 'mix' ? 'Mix' : 'Playlist'}
              </p>
            </div>
            <h1 className="text-4xl font-semibold text-zinc-100 mt-2 truncate">{bundle?.title ?? collection.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
              <ProviderBadge provider={collection.provider} compact />
              <span>•</span>
              <span>{rows.length} {rows.length === 1 ? 'track' : 'tracks'}</span>
              <span>•</span>
              <span>Read-only</span>
            </div>
            {(bundle?.subtitle ?? collection.subtitle) ? (
              <p className="mt-4 max-w-2xl text-sm text-zinc-500">
                {bundle?.subtitle ?? collection.subtitle}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 mt-5">
              <button
                onClick={handlePlayCollection}
                disabled={!rows.length}
                className="px-4 py-2 rounded-xl bg-white text-zinc-950 text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-40"
              >
                Play
              </button>
              <button
                onClick={handleShuffleCollection}
                disabled={!rows.length}
                className="px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-zinc-100 text-sm hover:bg-white/[0.1] transition-colors disabled:opacity-40"
              >
                Shuffle
              </button>
              {(bundle?.providerUrl ?? collection.providerUrl) ? (
                <button
                  onClick={() => { void window.puros.app.openExternal(bundle?.providerUrl ?? collection.providerUrl ?? '') }}
                  className="px-4 py-2 rounded-xl bg-white/[0.03] border border-white/10 text-zinc-300 text-sm hover:bg-white/[0.08] transition-colors"
                >
                  Open in {providerDisplayName}
                </button>
              ) : null}
            </div>
            <div className="mt-5 max-w-xl">
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={`Search inside this ${collection.sourceType === 'station' ? 'station' : collection.sourceType}...`}
                className="w-full px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/10 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-white/20"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-zinc-500">Loading...</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <p className="text-sm text-zinc-500">This collection is empty</p>
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
                {visibleRows.map((row, index) => (
                  <tr
                    key={row.id}
                    onClick={() => handlePlayTrack(index)}
                    onContextMenu={(event) => handleContextMenu(event, index)}
                    className="group border-t border-white/[0.04] cursor-pointer hover:bg-white/[0.04] transition-colors"
                  >
                    <td className="px-4 py-3 text-xs text-zinc-500 font-mono">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <ArtworkThumbnail src={row.artworkUrl} size={40} />
                        <div className="min-w-0">
                          <p className="text-sm text-zinc-100 truncate">{row.title}</p>
                          <div className="flex items-center gap-2 mt-0.5 min-w-0 md:hidden">
                            <span className="text-xs text-zinc-500 truncate">{row.artist}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400 truncate hidden md:table-cell">
                      {row.catalogTrackId || row.catalogArtistId ? (
                        <button
                          className="truncate text-zinc-400 hover:text-zinc-100 transition-colors"
                          onClick={(event) => { void handleOpenArtist(event, row) }}
                        >
                          {row.artist}
                        </button>
                      ) : (
                        row.artist
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400 truncate hidden lg:table-cell">
                      {row.catalogTrackId || row.catalogAlbumId ? (
                        <button
                          className="truncate text-zinc-400 hover:text-zinc-100 transition-colors"
                          onClick={(event) => { void handleOpenAlbum(event, row) }}
                        >
                          {row.album}
                        </button>
                      ) : (
                        row.album
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500 font-mono text-right">
                      {formatDuration(row.duration || 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={(node) => { contextMenuRef.current = node }}
          className="fixed z-50 min-w-52 py-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
            onClick={() => { void handleAddTrackToQueue() }}
          >
            Add to Queue
          </button>
          {getProviderTrackShareUrl({
            providerUrl: visibleRows[contextMenu.rowIndex]?.providerUrl,
          }) && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
              onClick={() => { void handleShareTrackLink() }}
            >
              Share Song Link
            </button>
          )}
        </div>
      )}
    </div>
  )
}
