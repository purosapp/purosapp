import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HomeProviderCollectionBundle, HomeProviderCollectionItem, HomeProviderTrack } from '../services/homeProviderShelves'
import { usePlayerStore, waitForPlaybackStart, type PlaybackContext, type Track } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import { ExternalLink, ListMusic, Lock, Play, Shuffle } from 'lucide-react'
import ProviderBadge from './ProviderBadge'
import CollectionView, { type CollectionAction } from './CollectionView'
import TrackList, { TrackListSkeleton, type TrackListRow } from './TrackList'
import { PageStatus } from './ui'
import { formatTrackDuration } from '../utils/formatTime'
import { fisherYatesShuffle } from '../services/local/scanner'
import { recordRecentlyPlayedPlaylist } from '../services/homeRecents'
import type { CatalogResolvedPlaybackTrack } from '../services/catalog/types'
import { getProviderTrackShareUrl } from '../utils/providerShare'
import { showContextMenu } from '../utils/contextMenu'
import { useProviderStatusStore } from '../store/providerStatusStore'
import { unavailableTrackLabel } from '../utils/trackAvailability'

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
    unavailableReason: row.unavailableReason ?? null,
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
    unavailableReason: row.unavailableReason ?? null,
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
  // Monotonic token so a newer play action cancels in-flight background queue
  // hydration from a previous one.
  const playbackRequestRef = useRef(0)
  const { setQueue, addToQueue, setNotification } = usePlayerStore()
  const currentTrackId = usePlayerStore((state) => state.currentTrack?.id)
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
  const startPlaybackFromRows = useCallback(async (rowsToPlay: HomeProviderTrack[], startIndex: number) => {
    // Greyed-out rows are never queued; start at the clicked row or the next playable one.
    const requestedRow = rowsToPlay.slice(Math.max(0, startIndex)).find((row) => !row.unavailableReason)
    const orderedRows = rowsToPlay.filter((row) => !row.unavailableReason)
    if (!orderedRows.length) {
      if (rowsToPlay.length) setNotification('None of these tracks are available')
      return
    }
    const safeStartIndex = requestedRow ? orderedRows.indexOf(requestedRow) : 0
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
  }, [addToQueue, playbackContext, resolvePlaybackTrack, setNotification, setQueue])

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

  const handleContextMenu = useCallback((rowIndex: number) => {
    const row = visibleRows[rowIndex]
    if (!row) return
    const shareUrl = getProviderTrackShareUrl({
      providerUrl: row.providerUrl,
    })

    void showContextMenu([
      !row.unavailableReason && {
        label: 'Add to Queue',
        onClick: () => {
          void (async () => {
            const track = await resolvePlaybackTrack(row)
            addToQueue(track)
            setNotification(`Added to queue: ${row.title ?? 'Track'}`)
          })()
        },
      },
      shareUrl ? {
        label: 'Share Song Link',
        onClick: () => {
          void window.puros.app.copyToClipboard(shareUrl).then(() => setNotification('Song link copied'))
        },
      } : null,
    ])
  }, [addToQueue, resolvePlaybackTrack, setNotification, visibleRows])

  const handleOpenArtist = useCallback(async (row: HomeProviderTrack) => {
    const artistId = row.catalogArtistId
      ?? (row.catalogTrackId ? (await window.puros.catalog.getTrack(row.catalogTrackId))?.primaryArtistId : null)
    if (artistId) {
      await openCatalogArtist(artistId)
    }
  }, [openCatalogArtist])

  const handleOpenAlbum = useCallback(async (row: HomeProviderTrack) => {
    const albumId = row.catalogAlbumId
      ?? (row.catalogTrackId ? (await window.puros.catalog.getTrack(row.catalogTrackId))?.albumId : null)
    if (albumId) {
      await openCatalogAlbum(albumId)
    }
  }, [openCatalogAlbum])

  const kindLabel = collection.sourceType === 'station' ? 'Station' : collection.sourceType === 'mix' ? 'Mix' : 'Playlist'
  const providerUrl = bundle?.providerUrl ?? collection.providerUrl
  const actions: CollectionAction[] = [
    { id: 'play', label: 'Play', icon: Play, variant: 'primary', onClick: () => { void handlePlayCollection() }, disabled: !rows.length },
    { id: 'shuffle', label: 'Shuffle', icon: Shuffle, onClick: () => { void handleShuffleCollection() }, disabled: !rows.length },
  ]
  if (providerUrl) {
    actions.push({
      id: 'open-source',
      label: `Open in ${providerDisplayName}`,
      icon: ExternalLink,
      variant: 'quiet',
      align: 'end',
      onClick: () => { void window.puros.app.openExternal(providerUrl) },
    })
  }

  return (
    <CollectionView
      kind={kindLabel}
      title={bundle?.title ?? collection.title}
      artworkSrc={bundle?.artworkUrl ?? collection.artworkUrl ?? null}
      byline={<ProviderBadge provider={collection.provider} compact />}
      chips={[
        { id: 'tracks', icon: ListMusic, label: `${rows.length} ${rows.length === 1 ? 'track' : 'tracks'}` },
        { id: 'read-only', icon: Lock, label: 'Read-only' },
      ]}
      description={bundle?.subtitle ?? collection.subtitle}
      actions={actions}
      search={{
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: `Search inside this ${collection.sourceType === 'station' ? 'station' : collection.sourceType}...`,
      }}
    >
      {loading ? (
        <TrackListSkeleton rows={8} />
      ) : rows.length === 0 ? (
        <PageStatus title="This collection is empty" />
      ) : visibleRows.length === 0 ? (
        <PageStatus title="No matching tracks" hint="Try a different title, artist, or album search." />
      ) : (
        <TrackList
          rows={visibleRows.map((row, index): TrackListRow => ({
            key: row.id,
            number: index + 1,
            title: row.title,
            artworkSrc: row.artworkUrl,
            artist: row.artist,
            onOpenArtist: row.catalogTrackId || row.catalogArtistId ? () => { void handleOpenArtist(row) } : undefined,
            album: row.album,
            onOpenAlbum: row.catalogTrackId || row.catalogAlbumId ? () => { void handleOpenAlbum(row) } : undefined,
            trailing: formatTrackDuration(row.duration || 0),
            active: row.id === currentTrackId,
            unavailable: row.unavailableReason ? unavailableTrackLabel(row.unavailableReason) : null,
          }))}
          onPlay={(index) => { void handlePlayTrack(index) }}
          onContextMenu={handleContextMenu}
        />
      )}
    </CollectionView>
  )
}
