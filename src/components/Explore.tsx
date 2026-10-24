import { useEffect, useMemo, useState } from 'react'
import type { PlaylistInfo } from '../../electron/preload'
import type {
  CatalogAlbumPage,
  CatalogArtistPage,
  CatalogAlbumSummary,
  CatalogArtistCollaboratorSummary,
  CatalogArtistRoleSummary,
  CatalogBrowseScope,
  CatalogCreditSummary,
  CatalogPlaylistSummary,
  CatalogProviderName,
  CatalogReleaseType,
  CatalogSourceLink,
  CatalogTrackSummary,
  MetadataSource,
} from '../services/catalog/types'
import type { HomeProviderCollectionItem } from '../services/homeProviderShelves'
import { useCatalogStore } from '../store/catalogStore'
import { useAppShellStore } from '../store/appShellStore'
import { usePlayerStore } from '../store/playerStore'
import { useProviderStatusStore } from '../store/providerStatusStore'
import { artworkUrl } from '../utils/artworkUrl'
import { showContextMenu } from '../utils/contextMenu'
import { fisherYatesShuffle } from '../services/local/scanner'
import { bioPlainText, parseBioText } from '../services/catalog/bioText'
import { sourceEntityId } from '../services/catalog/sourceIdentity'
import { Calendar, Check, Clock, Disc3, ExternalLink, ListMusic, ListPlus, Play, Plus, Shuffle, Tag, Tags, X } from 'lucide-react'
import MediaTabs from './MediaTabs'
import TrackList, { TrackListSkeleton, type TrackListRow } from './TrackList'
import { MediaGrid, MediaGridSkeleton, MediaTile, SourceBadges } from './MediaTile'
import { Button, PageHeader, PageStatus, Section } from './ui'
import { formatTotalDuration, formatTrackDuration } from '../utils/formatTime'
import { unavailableTrackLabel } from '../utils/trackAvailability'
import CollectionView, { CollectionSkeleton, type CollectionMetaChip } from './CollectionView'
import ProviderBadge from './ProviderBadge'

function formatYear(year: number | null | undefined) {
  return year ? String(year) : 'Unknown year'
}

function formatArtistSearchStats(albumCount: number, trackCount: number) {
  if (albumCount > 0) return `${albumCount} albums`
  if (trackCount > 0) return `${trackCount} tracks`
  return null
}

function formatAlbumMeta(year: number | null | undefined, totalTracks: number | null | undefined) {
  if ((totalTracks ?? 0) > 0) return `${formatYear(year)} • ${totalTracks} tracks`
  return formatYear(year)
}

function formatReleaseType(releaseType: CatalogReleaseType | null | undefined, releaseSection?: CatalogAlbumSummary['releaseSection']) {
  if (releaseSection === 'live') return 'Live Album'
  if (releaseSection === 'other') return 'Other Album'
  if (releaseType === 'ep') return 'EP'
  if (releaseType === 'single') return 'Single'
  if (releaseType === 'compilation') return 'Compilation'
  if (releaseType === 'album') return 'Album'
  return null
}

function albumChips(album: CatalogAlbumPage): CollectionMetaChip[] {
  const chips: CollectionMetaChip[] = []
  if (album.year) chips.push({ id: 'year', icon: Calendar, label: String(album.year) })
  const trackCount = album.totalTracks ?? album.tracks.length
  if (trackCount > 0) chips.push({ id: 'tracks', icon: ListMusic, label: `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}` })
  const totalMs = album.tracks.reduce((sum, track) => sum + (track.durationMs || 0), 0)
  if (totalMs > 0) chips.push({ id: 'duration', icon: Clock, label: formatTotalDuration(totalMs / 1000) })
  return chips
}

function artistChips(artist: CatalogArtistPage): CollectionMetaChip[] {
  const chips: CollectionMetaChip[] = []
  if (artist.albumCount > 0) chips.push({ id: 'albums', icon: Disc3, label: `${artist.albumCount} ${artist.albumCount === 1 ? 'album' : 'albums'}` })
  if (artist.trackCount > 0) chips.push({ id: 'tracks', icon: ListMusic, label: `${artist.trackCount} ${artist.trackCount === 1 ? 'track' : 'tracks'}` })
  for (const genre of artist.genres) chips.push({ id: `genre:${genre}`, icon: Tag, label: genre })
  return chips
}

function formatCreditRoleLabel(role: CatalogCreditSummary['role']) {
  if (role === 'primary') return 'Primary'
  if (role === 'main') return 'Main'
  if (role === 'featured') return 'Featured'
  if (role === 'composer') return 'Composer'
  if (role === 'producer') return 'Producer'
  if (role === 'conductor') return 'Conductor'
  if (role === 'performer') return 'Performer'
  return 'Related'
}

const METADATA_SOURCE_LABELS: Partial<Record<MetadataSource, string>> = {
  local: 'Local',
  embedded: 'Embedded',
  folder: 'Folder art',
  musicbrainz: 'MusicBrainz',
  coverartarchive: 'Cover Art Archive',
  wikipedia: 'Wikipedia',
  lastfm: 'Last.fm',
  discogs: 'Discogs',
  'metal-archives': 'Metal Archives',
}

function resolveArtwork(src?: { artworkId?: string | null; artworkUrl?: string | null }) {
  return artworkUrl(src?.artworkId, null) ?? src?.artworkUrl ?? null
}

function dedupeSourceLinksForDisplay(sourceLinks: CatalogSourceLink[]) {
  const seen = new Set<string>()
  return sourceLinks.filter((source) => {
    const key = source.provider
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getLocalTrackIdForCatalogTrack(track: CatalogTrackSummary): string | null {
  const preferredSource = track.sourceLinks.find((source) =>
    source.provider === (track.preferredProvider ?? null)
    && source.sourceId === (track.preferredSourceId ?? source.sourceId)
    && !!source.localId,
  )
  if (preferredSource?.localId) return preferredSource.localId

  const anyLinkedSource = track.sourceLinks.find((source) => !!source.localId)
  return anyLinkedSource?.localId ?? null
}

function getShareUrlForCatalogTrack(track: CatalogTrackSummary): string | null {
  const ordered = [...track.sourceLinks].sort((a, b) => {
    if (track.preferredProvider && a.provider === track.preferredProvider && b.provider !== track.preferredProvider) return -1
    if (track.preferredProvider && b.provider === track.preferredProvider && a.provider !== track.preferredProvider) return 1
    if (track.preferredSourceId) {
      const aSelected = a.sourceId === track.preferredSourceId
      const bSelected = b.sourceId === track.preferredSourceId
      if (aSelected !== bSelected) return aSelected ? -1 : 1
    }
    return 0
  })

  const directUrl = ordered.find((source) => source.providerUrl)?.providerUrl
  if (directUrl) return directUrl

  return null
}

function getProviderDisplayName(providerId: string): string {
  if (providerId === 'local') return 'Local'
  return useProviderStatusStore.getState().providers
    .find(({ manifest }) => manifest.id === providerId)?.manifest.displayName ?? providerId
}

function getAlbumVersionOptions(
  currentAlbum: CatalogAlbumSummary & { versions: CatalogAlbumSummary[] },
) {
  const seen = new Set<string>()
  return [currentAlbum, ...currentAlbum.versions].filter((album) => {
    if (seen.has(album.id)) return false
    seen.add(album.id)
    return true
  })
}

function SourcePills({
  sourceLinks,
  preferredProvider,
}: {
  sourceLinks: CatalogSourceLink[]
  preferredProvider?: CatalogProviderName | null
}) {
  const visibleSources = dedupeSourceLinksForDisplay(sourceLinks).sort((a, b) => {
    if (preferredProvider && a.provider === preferredProvider && b.provider !== preferredProvider) return -1
    if (preferredProvider && b.provider === preferredProvider && a.provider !== preferredProvider) return 1
    return 0
  })
  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleSources.map((source, index) => (
        <ProviderBadge
          key={`${source.provider}:${source.sourceId ?? 'missing'}:${index}`}
          provider={source.provider}
          compact
          className={source.inLibrary ? 'border-white/15 bg-white/10 text-zinc-200' : 'border-white/10 bg-white/5 text-zinc-400'}
        />
      ))}
    </div>
  )
}

function getVisibleTrackSourceLinks(
  sourceLinks: CatalogSourceLink[],
  preferredProvider?: CatalogProviderName | null,
) {
  return dedupeSourceLinksForDisplay(sourceLinks).sort((a, b) => {
    if (preferredProvider && a.provider === preferredProvider && b.provider !== preferredProvider) return -1
    if (preferredProvider && b.provider === preferredProvider && a.provider !== preferredProvider) return 1
    return 0
  })
}


function ReleaseTypePill({
  releaseType,
  releaseSection,
}: {
  releaseType: CatalogReleaseType | null | undefined
  releaseSection?: CatalogAlbumSummary['releaseSection']
}) {
  const label = formatReleaseType(releaseType, releaseSection)
  if (!label) return null
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider border border-white/10 bg-white/[0.05] text-zinc-300">
      {label}
    </span>
  )
}

/** Bio with its links: artists and albums of the bio's provider open in Puros, web links in the browser. */
function ArtistBio({
  text,
  providerId,
  className,
  onOpenArtist,
  onOpenAlbum,
}: {
  text: string
  providerId: string | null
  className: string
  onOpenArtist: (catalogArtistId: string) => void
  onOpenAlbum: (catalogAlbumId: string) => void
}) {
  const segments = useMemo(() => parseBioText(text), [text])
  const linkClass = 'text-zinc-100 underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-white/70'
  return (
    <p className={`whitespace-pre-line ${className}`}>
      {segments.map((segment, index) => {
        if (segment.type === 'external') {
          return (
            <a
              key={index}
              href={segment.url}
              onClick={(event) => {
                event.preventDefault()
                void window.puros.app.openExternal(segment.url)
              }}
              className={linkClass}
            >
              {segment.text}
            </a>
          )
        }
        if (segment.type === 'entity' && providerId && (segment.entityType === 'artist' || segment.entityType === 'album')) {
          const id = sourceEntityId({ providerId, entityType: segment.entityType, sourceId: segment.sourceId })
          return (
            <button
              key={index}
              type="button"
              onClick={() => (segment.entityType === 'artist' ? onOpenArtist(id) : onOpenAlbum(id))}
              className={linkClass}
            >
              {segment.text}
            </button>
          )
        }
        return <span key={index}>{segment.text}</span>
      })}
    </p>
  )
}

function groupArtistReleasesByType(releases: CatalogAlbumSummary[]) {
  return {
    albums: releases.filter((album): album is CatalogAlbumSummary => album.releaseSection === 'album'),
    eps: releases.filter((album): album is CatalogAlbumSummary => album.releaseSection === 'ep'),
    singles: releases.filter((album): album is CatalogAlbumSummary => album.releaseSection === 'single'),
    compilations: releases.filter((album): album is CatalogAlbumSummary => album.releaseSection === 'compilation'),
    live: releases.filter((album): album is CatalogAlbumSummary => album.releaseSection === 'live'),
    other: releases.filter((album): album is CatalogAlbumSummary => album.releaseSection === 'other' || !album.releaseSection),
  }
}

function playlistCollectionItem(playlist: CatalogPlaylistSummary): HomeProviderCollectionItem {
  return {
    id: playlist.id,
    provider: playlist.provider,
    sourceType: 'playlist',
    sourceId: playlist.sourceId,
    title: playlist.title,
    subtitle: playlist.trackCount ? `${playlist.trackCount} tracks` : null,
    description: null,
    artworkUrl: playlist.artworkUrl,
    providerUrl: playlist.providerUrl,
    trackCount: playlist.trackCount,
    syncedPlaylistId: null,
  }
}

function CreditsList({
  credits,
  onOpenArtist,
}: {
  credits: CatalogCreditSummary[]
  onOpenArtist?: (artistId: string) => void
}) {
  if (!credits.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {credits.map((credit) => (
        <button
          key={`${credit.artistId}:${credit.role}:${credit.position}`}
          onClick={() => onOpenArtist?.(credit.artistId)}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-colors"
        >
          <span>{credit.artistName}</span>
          <span className="text-zinc-500">{formatCreditRoleLabel(credit.role)}</span>
          <span className="text-zinc-600">{METADATA_SOURCE_LABELS[credit.source] ?? credit.source}</span>
        </button>
      ))}
    </div>
  )
}

function ArtistRoleSummaryList({ roles }: { roles: CatalogArtistRoleSummary[] }) {
  if (!roles.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {roles.map((role) => (
        <div
          key={role.role}
          className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300"
        >
          <span className="text-zinc-100">{formatCreditRoleLabel(role.role)}</span>
          <span className="text-zinc-500"> • {role.trackCount} tracks</span>
          {role.albumCount > 0 && <span className="text-zinc-500"> • {role.albumCount} albums</span>}
        </div>
      ))}
    </div>
  )
}

function CollaboratorsList({
  collaborators,
  onOpenArtist,
}: {
  collaborators: CatalogArtistCollaboratorSummary[]
  onOpenArtist: (artistId: string) => void
}) {
  if (!collaborators.length) return null
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      {collaborators.map((collaborator) => (
        <button
          key={collaborator.artistId}
          onClick={() => onOpenArtist(collaborator.artistId)}
          className="rounded-2xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] transition-colors px-4 py-3 text-left"
        >
          <p className="text-sm text-zinc-100">{collaborator.artistName}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {collaborator.trackCount} shared tracks{collaborator.albumCount > 0 ? ` • ${collaborator.albumCount} shared albums` : ''}
          </p>
        </button>
      ))}
    </div>
  )
}

export function TrackTable({
  tracks,
  onPlayTrack,
  onQueueTrack,
  onOpenArtist,
  onOpenAlbum,
  showTrackNumber = false,
  showArtwork = true,
  showAlbum = true,
  isTrackPinned,
  onTogglePin,
}: {
  tracks: CatalogTrackSummary[]
  onPlayTrack: (track: CatalogTrackSummary, index: number) => void
  onQueueTrack?: (track: CatalogTrackSummary, index: number) => void
  onOpenArtist?: (artistId: string) => void
  onOpenAlbum?: (albumId: string) => void
  /** # shows the album track number instead of the position. */
  showTrackNumber?: boolean
  /** Off on album pages, where every row has the same cover and album. */
  showArtwork?: boolean
  showAlbum?: boolean
  isTrackPinned?: (track: CatalogTrackSummary) => boolean
  onTogglePin?: (track: CatalogTrackSummary) => void
}) {
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([])
  const setNotification = usePlayerStore((state) => state.setNotification)
  const currentCatalogTrackId = usePlayerStore((state) => state.currentTrack?.catalogTrackId)

  useEffect(() => {
    let cancelled = false
    const loadPlaylists = async () => {
      try {
        const allPlaylists = await window.puros.playlists.getAll()
        if (!cancelled) setPlaylists(allPlaylists)
      } catch {
        // best effort
      }
    }

    void loadPlaylists()
    const offPlaylistsChanged = window.puros.on('playlists:changed', () => { void loadPlaylists() })
    return () => {
      cancelled = true
      offPlaylistsChanged()
    }
  }, [])

  const addTrackToPlaylist = async (track: CatalogTrackSummary, playlist: PlaylistInfo) => {
    const localTrackId = getLocalTrackIdForCatalogTrack(track)
    if (localTrackId) {
      await window.puros.playlists.addTrack(playlist.id, localTrackId)
      return
    }
    await window.puros.playlists.addCatalogTrack(
      playlist.id,
      track.id,
      track.preferredProvider ?? null,
      track.preferredSourceId ?? null,
    )
  }

  const createPlaylistAndAddTrack = async (track: CatalogTrackSummary) => {
    const playlistName = window.prompt('New playlist name')
    if (!playlistName?.trim()) return

    const playlist = await window.puros.playlists.create(playlistName.trim(), undefined, track.sourceRef.providerId)
    await addTrackToPlaylist(track, playlist)
  }

  const shareTrackLink = async (shareUrl: string) => {
    await window.puros.app.copyToClipboard(shareUrl)
    setNotification('Song link copied')
  }

  const showTrackContextMenu = (track: CatalogTrackSummary, index: number) => {
    const shareUrl = getShareUrlForCatalogTrack(track)
    const destinationPlaylists = playlists.filter((playlist) => playlist.management === 'app' && playlist.read_only === 0 && !playlist.legacy_mixed && playlist.playback_provider_id === track.sourceLinks[0]?.provider)
    void showContextMenu([
      onQueueTrack && track.availability.playable && { label: 'Add to Queue', onClick: () => onQueueTrack(track, index) },
      onTogglePin && { label: isTrackPinned?.(track) ? 'Unpin from Pins' : 'Pin to Pins', onClick: () => onTogglePin(track) },
      shareUrl ? { label: 'Share Song Link', onClick: () => { void shareTrackLink(shareUrl) } } : null,
      track.availability.playable && {
        label: 'Add to Playlist',
        submenu: [
          { label: 'Create New Playlist…', onClick: () => { void createPlaylistAndAddTrack(track) } },
          { type: 'separator' },
          ...(destinationPlaylists.length > 0
            ? destinationPlaylists.map((playlist) => ({ label: playlist.name, onClick: () => { void addTrackToPlaylist(track, playlist) } }))
            : [{ label: 'No compatible playlists yet', enabled: false }]),
        ],
      },
    ])
  }

  return (
    <TrackList
      rows={tracks.map((track, index): TrackListRow => ({
        key: `${track.id}:${track.preferredSourceId ?? 'default'}`,
        number: showTrackNumber ? (track.trackNumber ?? index + 1) : index + 1,
        title: track.title,
        artworkSrc: resolveArtwork({ artworkId: track.artworkId, artworkUrl: track.artworkUrl }),
        artist: track.artistCreditName ?? track.primaryArtistName ?? 'Unknown Artist',
        onOpenArtist: track.primaryArtistId && onOpenArtist ? () => onOpenArtist(track.primaryArtistId!) : undefined,
        album: track.albumTitle ?? 'Unknown album',
        onOpenAlbum: track.albumId && onOpenAlbum ? () => onOpenAlbum(track.albumId!) : undefined,
        meta: (
          <div className="flex shrink-0 items-center gap-1">
            {getVisibleTrackSourceLinks(track.sourceLinks, track.preferredProvider).map((source, sourceIndex) => (
              <ProviderBadge
                key={`${track.id}:${source.provider}:${source.sourceId ?? 'missing'}:${sourceIndex}`}
                provider={source.provider}
                compact
                iconOnly
                className="border-white/10 bg-white/[0.05]"
              />
            ))}
          </div>
        ),
        trailing: formatTrackDuration(track.durationMs / 1000),
        active: !!currentCatalogTrackId && currentCatalogTrackId === track.id,
        unavailable: track.availability.playable ? null : unavailableTrackLabel(track.availability.unavailableReason),
      }))}
      showArtwork={showArtwork}
      showAlbum={showAlbum}
      onPlay={(index) => onPlayTrack(tracks[index]!, index)}
      onContextMenu={onQueueTrack || onTogglePin ? (index) => showTrackContextMenu(tracks[index]!, index) : undefined}
    />
  )
}

export default function Explore({ scope = 'all' }: { scope?: CatalogBrowseScope }) {
  const {
    scope: activeScope,
    view,
    query,
    results,
    currentArtist,
    currentAlbum,
    artistSectionLoading,
    albumSectionLoading,
    isLoading,
    error,
    setScope,
    browse,
    search,
    openArtist,
    openAlbum,
    refreshCurrent,
    silentRefreshCurrent,
    addToLibrary,
    playTracks,
    addTrackToQueue,
    addTracksToQueue,
    addAlbumToQueue,
    playAlbum,
  } = useCatalogStore()
  const openProviderCollection = useAppShellStore((s) => s.openProviderCollection)
  const [resultTab, setResultTab] = useState<'all' | 'songs' | 'albums' | 'artists' | 'playlists'>('all')
  const [showAllTopTracks, setShowAllTopTracks] = useState(false)
  const [bioExpanded, setBioExpanded] = useState(false)
  const [isEditingArtistGenres, setIsEditingArtistGenres] = useState(false)
  const [genreStatus, setGenreStatus] = useState<string | null>(null)
  const [artistGenreDraft, setArtistGenreDraft] = useState('')
  const [artistGenreSaving, setArtistGenreSaving] = useState(false)

  useEffect(() => {
    void setScope(scope)
  }, [scope, setScope])

  // Typing happens in the title-bar search (TopBar); here we only load the
  // initial results when the view mounts.
  useEffect(() => {
    const state = useCatalogStore.getState()
    if (state.view !== 'search') return
    if (state.query.trim()) void search(state.query)
    else void browse()
  }, [browse, search])

  useEffect(() => {
    const unsub = window.puros.on('catalog:changed', () => {
      void silentRefreshCurrent()
    })
    return unsub
  }, [silentRefreshCurrent])

  useEffect(() => {
    setShowAllTopTracks(false)
  }, [currentArtist?.id])

  useEffect(() => {
    setBioExpanded(false)
  }, [currentArtist?.id])

  useEffect(() => {
    setIsEditingArtistGenres(false)
    setArtistGenreDraft((currentArtist?.genres ?? []).join(', '))
  }, [currentArtist?.id, currentArtist?.genres])

  const emptyState = useMemo(() => {
    if (query.trim()) {
      return activeScope === 'library'
        ? `No library results for "${query}".`
        : `No results for "${query}".`
    }
    return activeScope === 'library'
      ? 'Browse and search only the music already in your library.'
      : 'Search the selected provider.'
  }, [activeScope, query])

  const groupedArtistReleases = useMemo(
    () => groupArtistReleasesByType(currentArtist?.releases ?? []),
    [currentArtist?.releases],
  )
  const visibleTopTracks = currentArtist
    ? (showAllTopTracks ? currentArtist.topTracks : currentArtist.topTracks.slice(0, 5))
    : []
  const artistBio = currentArtist?.bio ?? 'No biography available yet for this artist.'
  const canExpandBio = useMemo(() => bioPlainText(artistBio).length > 280, [artistBio])

  const openFirstProviderUrl = async (
    sourceLinks: CatalogSourceLink[],
    preferredProvider?: CatalogProviderName | null,
  ) => {
    const ordered = [...sourceLinks].sort((a, b) => {
      if (preferredProvider && a.provider === preferredProvider && b.provider !== preferredProvider) return -1
      if (preferredProvider && b.provider === preferredProvider && a.provider !== preferredProvider) return 1
      return 0
    })
    const url = ordered.find((source) => source.providerUrl)?.providerUrl
    if (!url) return
    await window.puros.app.openExternal(url)
  }

  const saveArtistGenres = async () => {
    if (!currentArtist) return
    const genres = artistGenreDraft
      .split(',')
      .map((genre) => genre.trim())
      .filter(Boolean)
    setArtistGenreSaving(true)
    setGenreStatus(null)
    try {
      await window.puros.catalog.setArtistGenres(currentArtist.id, genres)
      await refreshCurrent()
      setIsEditingArtistGenres(false)
      setGenreStatus('Artist genres updated.')
    } catch (error) {
      setGenreStatus(error instanceof Error ? error.message : 'Failed to update artist genres.')
    } finally {
      setArtistGenreSaving(false)
    }
  }

  const openAlbumFromArtistContext = async (album: CatalogAlbumSummary) => {
    await openAlbum(album.id, { artistContext: currentArtist ? { id: currentArtist.id, name: currentArtist.name } : null })
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {view === 'search' && (
        <PageHeader
          kicker={activeScope === 'library' ? 'Library' : 'Explore'}
          title={query.trim() ? `Results for “${query.trim()}”` : activeScope === 'library' ? 'Your library' : 'Browse'}
        />
      )}

      {view === 'search' && (
        <MediaTabs
          value={resultTab}
          onChange={setResultTab}
          options={[
            { id: 'all', label: 'All' },
            { id: 'songs', label: 'Songs' },
            { id: 'albums', label: 'Albums' },
            { id: 'artists', label: 'Artists' },
            { id: 'playlists', label: 'Playlists' },
          ]}
        />
      )}

      {view === 'artist' && !currentArtist && !error ? (
        <CollectionSkeleton kind="Artist" artworkShape="backdrop" />
      ) : view === 'album' && !currentAlbum && !error ? (
        <CollectionSkeleton kind="Album" trackArtwork={false} />
      ) : view === 'artist' && currentArtist ? (
        <CollectionView
          kind="Artist"
          title={currentArtist.name}
          artworkSrc={resolveArtwork({ artworkId: currentArtist.artworkId, artworkUrl: currentArtist.artworkUrl }) ?? null}
          artworkShape="backdrop"
          byline={<SourcePills sourceLinks={currentArtist.sourceLinks} preferredProvider={currentArtist.preferredProvider} />}
          chips={artistChips(currentArtist)}
          description={(
            <div className="max-w-3xl">
              <ArtistBio
                text={artistBio}
                providerId={currentArtist.bioSource}
                className={`leading-6 text-zinc-300 ${bioExpanded ? '' : 'line-clamp-3'}`}
                onOpenArtist={(artistId) => void openArtist(artistId)}
                onOpenAlbum={(albumId) => void openAlbum(albumId)}
              />
              {canExpandBio && (
                <button
                  onClick={() => setBioExpanded((value) => !value)}
                  className="mt-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {bioExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}
          actions={[
            {
              id: 'play',
              label: 'Play',
              title: 'Play top tracks',
              icon: Play,
              variant: 'primary',
              disabled: currentArtist.topTracks.length === 0,
              onClick: () => void playTracks(currentArtist.topTracks),
            },
            {
              id: 'shuffle',
              label: 'Shuffle',
              icon: Shuffle,
              disabled: currentArtist.topTracks.length === 0,
              onClick: () => void playTracks(fisherYatesShuffle(currentArtist.topTracks)),
            },
            {
              id: 'queue',
              label: 'Add to Queue',
              title: 'Add top tracks to queue',
              icon: ListPlus,
              disabled: currentArtist.topTracks.length === 0,
              onClick: () => void addTracksToQueue(currentArtist.topTracks),
            },
            ...(!currentArtist.availability.inLibrary ? [{
              id: 'library',
              label: 'Add to Library',
              icon: Plus,
              align: 'end' as const,
              onClick: () => void addToLibrary('artist', currentArtist.id, currentArtist.preferredProvider ?? null),
            }] : []),
            {
              id: 'open-source',
              label: 'Open Source',
              icon: ExternalLink,
              variant: 'quiet',
              align: 'end',
              onClick: () => void openFirstProviderUrl(currentArtist.sourceLinks, currentArtist.preferredProvider),
            },
            {
              id: 'edit-genres',
              label: 'Edit genres',
              icon: Tags,
              variant: 'quiet',
              align: 'end',
              iconOnly: true,
              onClick: () => {
                setArtistGenreDraft(currentArtist.genres.join(', '))
                setIsEditingArtistGenres(true)
              },
            },
          ]}
          heroExtra={isEditingArtistGenres || genreStatus ? (
            <div className="max-w-2xl">
              {genreStatus && <p role="status" className="text-xs text-zinc-400 mb-2">{genreStatus}</p>}
              {isEditingArtistGenres && (
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={artistGenreDraft}
                    onChange={(event) => setArtistGenreDraft(event.target.value)}
                    placeholder="metal, progressive metal, rock"
                    autoFocus
                    className="min-w-0 flex-1 h-9 px-4 rounded-full bg-white/[0.04] border border-white/[0.08] text-sm text-zinc-100 placeholder-zinc-500 hover:border-white/15 focus:outline-none focus:border-white/20"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      variant="primary"
                      icon={Check}
                      label={artistGenreSaving ? 'Saving…' : 'Save'}
                      onClick={() => { void saveArtistGenres() }}
                      disabled={artistGenreSaving}
                    />
                    <Button
                      variant="quiet"
                      icon={X}
                      label="Cancel"
                      onClick={() => {
                        setArtistGenreDraft(currentArtist.genres.join(', '))
                        setIsEditingArtistGenres(false)
                      }}
                      disabled={artistGenreSaving}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : undefined}
        >
          {error && <p className="text-sm text-rose-400 mb-4">{error}</p>}
          <div className="space-y-8">
            {currentArtist.topTracks.length > 0 && (
              <Section
                title="Top Tracks"
                action={currentArtist.topTracks.length > 5 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    label={showAllTopTracks ? 'Show less' : `Show all ${currentArtist.topTracks.length}`}
                    onClick={() => setShowAllTopTracks((value) => !value)}
                  />
                ) : undefined}
              >
                <TrackTable
                  tracks={visibleTopTracks}
                  onPlayTrack={(_, index) => void playTracks(visibleTopTracks, index)}
                  onQueueTrack={(track) => void addTrackToQueue(track)}
                  onOpenArtist={(artistId) => void openArtist(artistId)}
                  onOpenAlbum={(albumId) => void openAlbum(albumId)}
                />
              </Section>
            )}

            {currentArtist.topTracks.length === 0 && artistSectionLoading.topTracks && (
              <Section title="Top Tracks">
                <TrackListSkeleton rows={5} />
              </Section>
            )}

            {groupedArtistReleases.albums.length > 0 && (
              <Section title="Albums">
                <MediaGrid>
                  {groupedArtistReleases.albums.map((album) => (
                    <MediaTile
                      key={album.id}
                      kind="album"
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      onPlay={() => void playAlbum(album.id)}
                      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onOpen={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {currentArtist.releases.length === 0 && artistSectionLoading.releases && (
              <Section title="Discography">
                <MediaGridSkeleton count={6} />
              </Section>
            )}

            {groupedArtistReleases.eps.length > 0 && (
              <Section title="EPs">
                <MediaGrid>
                  {groupedArtistReleases.eps.map((album) => (
                    <MediaTile
                      key={album.id}
                      kind="album"
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      onPlay={() => void playAlbum(album.id)}
                      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onOpen={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {groupedArtistReleases.singles.length > 0 && (
              <Section title="Singles">
                <MediaGrid>
                  {groupedArtistReleases.singles.map((album) => (
                    <MediaTile
                      key={album.id}
                      kind="album"
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      onPlay={() => void playAlbum(album.id)}
                      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onOpen={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {groupedArtistReleases.compilations.length > 0 && (
              <Section title="Compilations">
                <MediaGrid>
                  {groupedArtistReleases.compilations.map((album) => (
                    <MediaTile
                      key={album.id}
                      kind="album"
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      onPlay={() => void playAlbum(album.id)}
                      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onOpen={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {groupedArtistReleases.live.length > 0 && (
              <Section title="Live Albums">
                <MediaGrid>
                  {groupedArtistReleases.live.map((album) => (
                    <MediaTile
                      key={album.id}
                      kind="album"
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      onPlay={() => void playAlbum(album.id)}
                      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onOpen={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {groupedArtistReleases.other.length > 0 && (
              <Section title="Other Albums">
                <MediaGrid>
                  {groupedArtistReleases.other.map((album) => (
                    <MediaTile
                      key={album.id}
                      kind="album"
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      onPlay={() => void playAlbum(album.id)}
                      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onOpen={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {currentArtist.playlists.length > 0 && (
              <Section title="Playlists">
                <MediaGrid>
                  {currentArtist.playlists.map((playlist) => (
                    <MediaTile
                      key={playlist.id}
                      kind="playlist"
                      title={playlist.title}
                      subtitle={playlist.trackCount ? `${playlist.trackCount} tracks` : `${getProviderDisplayName(playlist.provider)} playlist`}
                      artworkSrc={playlist.artworkUrl}
                      topRight={<ProviderBadge provider={playlist.provider} compact iconOnly className="border-white/15 bg-black/55 backdrop-blur-md" />}
                      onOpen={() => {
                        openProviderCollection(playlistCollectionItem(playlist))
                      }}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {currentArtist.playlists.length === 0 && artistSectionLoading.playlists && (
              <Section title="Playlists">
                <MediaGridSkeleton count={6} />
              </Section>
            )}

            {currentArtist.localAlbums.length > 0 && (
              <Section title="In Your Library">
                <MediaGrid>
                  {currentArtist.localAlbums.map((album) => (
                    <MediaTile
                      key={album.id}
                      kind="album"
                      title={album.title}
                      subtitle={`${formatYear(album.year)} • Local`}
                      artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      onPlay={() => void playAlbum(album.id)}
                      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onOpen={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {currentArtist.roleSummary.length > 0 && (
              <Section title="Roles">
                <ArtistRoleSummaryList roles={currentArtist.roleSummary} />
              </Section>
            )}

            {currentArtist.appearsOn.length > 0 && (
              <Section title="Appears On">
                <MediaGrid>
                  {currentArtist.appearsOn.map((album) => (
                    <MediaTile
                      key={album.id}
                      kind="album"
                      title={album.title}
                      subtitle={`${album.artistCreditName ?? album.primaryArtistName ?? 'Various Artists'} • ${formatYear(album.year)}`}
                      artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      onPlay={() => void playAlbum(album.id)}
                      topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onOpen={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {currentArtist.collaborators.length > 0 && (
              <Section title="Collaborators">
                <CollaboratorsList
                  collaborators={currentArtist.collaborators}
                  onOpenArtist={(artistId) => void openArtist(artistId)}
                />
              </Section>
            )}

            {currentArtist.relatedArtists.length > 0 && (
              <Section title="Related Artists">
                <MediaGrid>
                  {currentArtist.relatedArtists.map((artist) => (
                    <MediaTile
                      key={artist.id}
                      kind="artist"
                      title={artist.name}
                      subtitle={`${artist.albumCount} albums`}
                      artworkSrc={resolveArtwork({ artworkId: artist.artworkId, artworkUrl: artist.artworkUrl })}
                      topRight={<SourceBadges sourceLinks={artist.sourceLinks} />}
                      onOpen={() => void openArtist(artist.id)}
                    />
                  ))}
                </MediaGrid>
              </Section>
            )}

            {currentArtist.relatedArtists.length === 0 && artistSectionLoading.relatedArtists && (
              <Section title="Related Artists">
                <MediaGridSkeleton count={6} kind="artist" />
              </Section>
            )}
          </div>
        </CollectionView>
      ) : view === 'album' && currentAlbum ? (
        <CollectionView
          kind={formatReleaseType(currentAlbum.releaseType, currentAlbum.releaseSection) ?? 'Album'}
          title={currentAlbum.title}
          artworkSrc={resolveArtwork({ artworkId: currentAlbum.artworkId, artworkUrl: currentAlbum.artworkUrl }) ?? null}
          byline={(
            <>
              {currentAlbum.primaryArtistId ? (
                <button
                  onClick={() => void openArtist(currentAlbum.primaryArtistId!)}
                  className="font-medium text-zinc-100 hover:text-white hover:underline transition-colors"
                >
                  {currentAlbum.artistCreditName ?? currentAlbum.primaryArtistName ?? 'Unknown Artist'}
                </button>
              ) : (
                <span className="font-medium">{currentAlbum.artistCreditName ?? currentAlbum.primaryArtistName ?? 'Unknown Artist'}</span>
              )}
              <SourcePills sourceLinks={currentAlbum.sourceLinks} preferredProvider={currentAlbum.preferredProvider} />
            </>
          )}
          chips={albumChips(currentAlbum)}
          actions={[
            {
              id: 'play',
              label: albumSectionLoading.tracks ? 'Loading Tracks…' : 'Play',
              icon: Play,
              variant: 'primary',
              disabled: albumSectionLoading.tracks,
              onClick: () => void playTracks(currentAlbum.tracks),
            },
            {
              id: 'shuffle',
              label: 'Shuffle',
              icon: Shuffle,
              disabled: albumSectionLoading.tracks,
              onClick: () => void playTracks(fisherYatesShuffle(currentAlbum.tracks)),
            },
            {
              id: 'queue',
              label: 'Add to Queue',
              icon: ListPlus,
              disabled: albumSectionLoading.tracks,
              onClick: () => void addAlbumToQueue(currentAlbum.id),
            },
            ...(!currentAlbum.availability.inLibrary ? [{
              id: 'library',
              label: 'Add to Library',
              icon: Plus,
              align: 'end' as const,
              onClick: () => void addToLibrary('album', currentAlbum.id, currentAlbum.preferredProvider ?? null),
            }] : []),
            {
              id: 'open-source',
              label: 'Open Source',
              icon: ExternalLink,
              variant: 'quiet',
              align: 'end',
              disabled: albumSectionLoading.tracks,
              onClick: () => void openFirstProviderUrl(currentAlbum.sourceLinks, currentAlbum.preferredProvider),
            },
          ]}
          heroExtra={getAlbumVersionOptions(currentAlbum).length > 1 ? (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Versions</p>
              <div className="flex flex-wrap gap-2">
                {getAlbumVersionOptions(currentAlbum).map((album) => {
                  const selected = album.id === currentAlbum.id
                  const preferred = album.id === currentAlbum.id
                  return (
                    <div
                      key={album.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (!selected) void openAlbum(album.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        if (!selected) void openAlbum(album.id)
                      }}
                      className={`max-w-[320px] rounded-2xl border px-3 py-2 text-left transition-colors ${
                        preferred
                          ? 'border-white bg-white text-zinc-950'
                          : 'border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className={`truncate text-sm ${preferred ? 'text-zinc-950' : 'text-zinc-100'}`}>
                            {album.title}
                          </p>
                          <p className={`truncate text-xs ${preferred ? 'text-zinc-700' : 'text-zinc-400'}`}>
                            {formatAlbumMeta(album.year, album.totalTracks)}
                          </p>
                        </div>
                        {preferred && (
                          <span className="shrink-0 rounded-full border border-zinc-900/10 bg-zinc-900/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-800">
                            Selected
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} />
                        <SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentAlbum.preferredProvider} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {!selected && (
                          <button
                            onClick={(event) => {
                              event.stopPropagation()
                              void openAlbum(album.id)
                            }}
                            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                              preferred
                                ? 'border-zinc-900/10 bg-zinc-900/10 text-zinc-800 hover:bg-zinc-900/15'
                                : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
                            }`}
                          >
                            View
                          </button>
                        )}

                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : undefined}
        >
          {error && <p className="text-sm text-rose-400 mb-4">{error}</p>}
          <div className="space-y-8">
            {currentAlbum.tracks.length > 0 && (
              <Section title="Tracks">
                <TrackTable
                  tracks={currentAlbum.tracks}
                  showTrackNumber
                  showArtwork={false}
                  showAlbum={false}
                  onPlayTrack={(_, index) => void playTracks(currentAlbum.tracks, index)}
                  onQueueTrack={(track) => void addTrackToQueue(track)}
                  onOpenArtist={(artistId) => void openArtist(artistId)}
                  onOpenAlbum={(albumId) => void openAlbum(albumId)}
                />
              </Section>
            )}

            {currentAlbum.tracks.length === 0 && albumSectionLoading.tracks && (
              <Section title="Tracks">
                <TrackListSkeleton rows={8} />
              </Section>
            )}

            {(currentAlbum.credits?.length ?? 0) > 0 && (
              <Section title="Credits">
                <CreditsList
                  credits={currentAlbum.credits ?? []}
                  onOpenArtist={(artistId) => void openArtist(artistId)}
                />
              </Section>
            )}

            {currentAlbum.versions.length > 0 && (
              <Section title="Other Versions">
                <MediaGrid>
                  {currentAlbum.versions.map((album) => {
                    const preferred = album.id === currentAlbum.id
                    return (
                      <MediaTile
                        key={album.id}
                        kind="album"
                        title={album.title}
                        subtitle={preferred ? `${formatAlbumMeta(album.year, album.totalTracks)} • Selected` : formatAlbumMeta(album.year, album.totalTracks)}
                        artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                        onPlay={() => void playAlbum(album.id)}
                        topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                        contextActions={[
                          { label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) },
                        ]}
                        onOpen={() => void openAlbum(album.id)}
                      />
                    )
                  })}
                </MediaGrid>
              </Section>
            )}
          </div>
        </CollectionView>
      ) : (
      <div className="flex-1 overflow-y-auto px-6 pt-3 pb-6">
        {error && <p className="text-sm text-rose-400 mb-4">{error}</p>}

          {view === 'search' && (
          <div className="space-y-8">
            {(results.artists.length > 0 || results.albums.length > 0 || results.tracks.length > 0 || results.playlists.length > 0) ? (
              <>
                {(resultTab === 'all' || resultTab === 'artists') && results.artists.length > 0 && (
                  <Section title="Artists">
                    <MediaGrid>
                      {results.artists.map((artist) => (
                        <MediaTile
                          key={artist.id}
                          kind="artist"
                          title={artist.name}
                          subtitle={formatArtistSearchStats(artist.albumCount, artist.trackCount)}
                          artworkSrc={resolveArtwork({ artworkId: artist.artworkId, artworkUrl: artist.artworkUrl })}
                          topRight={<SourceBadges sourceLinks={artist.sourceLinks} />}
                          onOpen={() => void openArtist(artist.id)}
                        />
                      ))}
                    </MediaGrid>
                  </Section>
                )}

                {(resultTab === 'all' || resultTab === 'albums') && results.albums.length > 0 && (
                  <Section title="Albums">
                    <MediaGrid>
                      {results.albums.map((album) => (
                        <MediaTile
                          key={album.id}
                          kind="album"
                          title={album.title}
                          subtitle={`${album.artistCreditName ?? album.primaryArtistName ?? 'Unknown Artist'} • ${formatYear(album.year)}`}
                          artworkSrc={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                          onPlay={() => void playAlbum(album.id)}
                          topRight={<SourceBadges sourceLinks={album.sourceLinks} />}
                          contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                          onOpen={() => void openAlbum(album.id)}
                        />
                      ))}
                    </MediaGrid>
                  </Section>
                )}

                {(resultTab === 'all' || resultTab === 'songs') && results.tracks.length > 0 && (
                  <Section title="Songs">
                    <TrackTable
                      tracks={results.tracks}
                      onPlayTrack={(_, index) => void playTracks(results.tracks, index)}
                      onQueueTrack={(track) => void addTrackToQueue(track)}
                      onOpenArtist={(artistId) => void openArtist(artistId)}
                      onOpenAlbum={(albumId) => void openAlbum(albumId)}
                    />
                  </Section>
                )}

                {(resultTab === 'all' || resultTab === 'playlists') && results.playlists.length > 0 && (
                  <Section title="Playlists">
                    <MediaGrid>
                      {results.playlists.map((playlist) => (
                        <MediaTile
                          key={playlist.id}
                          kind="playlist"
                          title={playlist.title}
                          subtitle={playlist.trackCount ? `${playlist.trackCount} tracks` : `${getProviderDisplayName(playlist.provider)} playlist`}
                          artworkSrc={playlist.artworkUrl}
                          topRight={<ProviderBadge provider={playlist.provider} compact iconOnly className="border-white/15 bg-black/55 backdrop-blur-md" />}
                          onOpen={() => {
                            openProviderCollection(playlistCollectionItem(playlist))
                          }}
                        />
                      ))}
                    </MediaGrid>
                  </Section>
                )}


              </>
            ) : (
              <PageStatus
                loading={isLoading}
                title={isLoading ? 'Searching…' : emptyState}
                hint={isLoading ? undefined : 'Choose a provider above to browse its artists, albums, tracks and playlists.'}
              />
            )}
          </div>
        )}


      </div>
      )}
    </div>
  )
}
