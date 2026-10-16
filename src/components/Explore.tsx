import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PlaylistInfo } from '../../electron/preload'
import type {
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
import { fisherYatesShuffle } from '../services/local/scanner'
import MediaTabs from './MediaTabs'
import ProviderBadge from './ProviderBadge'

function formatDuration(ms: number) {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatYear(year: number | null | undefined) {
  return year ? String(year) : 'Unknown year'
}

function formatArtistStats(albumCount: number, trackCount: number) {
  if (albumCount > 0 && trackCount > 0) return `${albumCount} albums • ${trackCount} tracks`
  if (albumCount > 0) return `${albumCount} albums`
  if (trackCount > 0) return `${trackCount} tracks`
  return null
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

function Card({
  title,
  subtitle,
  image,
  meta,
  onClick,
  contextActions,
}: {
  title: string
  subtitle?: string | null
  image?: string | null
  meta?: ReactNode
  onClick: () => void
  contextActions?: Array<{
    label: string
    onClick: () => void
    tone?: 'default' | 'danger'
  }>
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

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

  return (
    <>
      <button
        onClick={onClick}
        onContextMenu={(event) => {
          if (!contextActions?.length) return
          event.preventDefault()
          event.stopPropagation()
          const menuW = 220
          const menuH = Math.max(44, contextActions.length * 36 + 8)
          setContextMenu({
            x: Math.min(event.clientX, window.innerWidth - menuW - 8),
            y: Math.min(event.clientY, window.innerHeight - menuH - 8),
          })
        }}
        className="w-full text-left flex items-center gap-3 p-3 rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/10 transition-colors"
      >
        {image ? (
          <img src={image} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0 bg-zinc-900" />
        ) : (
          <div className="w-14 h-14 rounded-lg shrink-0 bg-zinc-900 flex items-center justify-center text-zinc-600 text-lg font-semibold">
            {title.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-zinc-100 truncate">{title}</p>
          {subtitle && <p className="text-xs text-zinc-500 truncate mt-0.5">{subtitle}</p>}
          {meta && <div className="mt-2">{meta}</div>}
        </div>
      </button>

      {contextMenu && contextActions?.length ? (
        <div
          className="fixed z-50 min-w-56 py-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextActions.map((action) => (
            <button
              key={action.label}
              className={`w-full text-left px-4 py-2 text-sm transition-colors hover:bg-zinc-800 ${
                action.tone === 'danger' ? 'text-red-400' : 'text-zinc-300'
              }`}
              onClick={() => {
                setContextMenu(null)
                action.onClick()
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{title}</h2>
      </div>
      {children}
    </section>
  )
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
          className="rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] transition-colors p-3 text-left"
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

function TrackTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-2xl border border-white/5 overflow-hidden">
      <div className="bg-white/[0.03]">
        <div className="grid grid-cols-[1fr_auto] gap-4 px-4 py-3 text-[11px] uppercase tracking-wider text-zinc-500">
          <div>Title</div>
          <div className="text-right">Time</div>
        </div>
      </div>
      <div className="divide-y divide-white/[0.04]">
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="grid grid-cols-[1fr_auto] gap-4 px-4 py-4 items-center">
            <div className="min-w-0">
              <div className="h-4 w-56 max-w-full rounded-full bg-white/[0.06] animate-pulse" />
              <div className="h-3 w-36 rounded-full bg-white/[0.04] animate-pulse mt-2" />
            </div>
            <div className="h-3 w-10 rounded-full bg-white/[0.04] animate-pulse justify-self-end" />
          </div>
        ))}
      </div>
    </div>
  )
}

function CardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 p-3 rounded-xl border border-white/5 bg-white/[0.03]"
        >
          <div className="w-14 h-14 rounded-lg bg-white/[0.06] animate-pulse shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="h-4 w-40 max-w-full rounded-full bg-white/[0.06] animate-pulse" />
            <div className="h-3 w-28 rounded-full bg-white/[0.04] animate-pulse mt-2" />
            <div className="h-5 w-16 rounded-full bg-white/[0.04] animate-pulse mt-3" />
          </div>
        </div>
      ))}
    </div>
  )
}

function PageLoadingShell({
  entityType,
  title,
  subtitle,
}: {
  entityType: 'artist' | 'album'
  title: string
  subtitle: string
}) {
  const heading = entityType === 'artist' ? 'Artist' : 'Album'
  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      <div className="flex flex-col xl:flex-row gap-6">
        <div className="w-44 h-44 shrink-0 rounded-3xl border border-white/5 bg-white/[0.04] overflow-hidden">
          <div className="w-full h-full bg-gradient-to-br from-white/[0.09] via-white/[0.04] to-transparent animate-pulse" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">{heading}</p>
          <h1 className="text-4xl font-semibold text-zinc-100 mt-2">{title}</h1>
          <p className="text-sm text-zinc-500 mt-3">{subtitle}</p>
          <div className="mt-5 max-w-2xl">
            <div className="h-4 w-full max-w-xl rounded-full bg-white/[0.06] animate-pulse" />
            <div className="h-4 w-full max-w-lg rounded-full bg-white/[0.05] animate-pulse mt-3" />
            <div className="h-4 w-full max-w-md rounded-full bg-white/[0.04] animate-pulse mt-3" />
          </div>
          <div className="mt-5">
            <p className="text-sm text-zinc-400">
              Loading {entityType} details…
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/5 overflow-hidden">
        <div className="bg-white/[0.03] px-4 py-3 text-[11px] uppercase tracking-wider text-zinc-500">
          {entityType === 'artist' ? 'Top Tracks' : 'Tracks'}
        </div>
        <div className="divide-y divide-white/[0.04]">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="px-4 py-4 flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="h-4 rounded-full bg-white/[0.06] animate-pulse w-56 max-w-full" />
                <div className="h-3 rounded-full bg-white/[0.04] animate-pulse w-36 mt-2" />
              </div>
              <div className="hidden lg:flex gap-2 shrink-0">
                <div className="h-6 w-16 rounded-lg bg-white/[0.05] animate-pulse" />
                <div className="h-6 w-14 rounded-lg bg-white/[0.04] animate-pulse" />
                <div className="h-6 w-20 rounded-lg bg-white/[0.04] animate-pulse" />
              </div>
              <div className="h-3 w-10 rounded-full bg-white/[0.04] animate-pulse shrink-0" />
            </div>
          ))}
        </div>
      </div>
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
  isTrackPinned,
  onTogglePin,
}: {
  tracks: CatalogTrackSummary[]
  onPlayTrack: (track: CatalogTrackSummary, index: number) => void
  onQueueTrack?: (track: CatalogTrackSummary, index: number) => void
  onOpenArtist?: (artistId: string) => void
  onOpenAlbum?: (albumId: string) => void
  showTrackNumber?: boolean
  isTrackPinned?: (track: CatalogTrackSummary) => boolean
  onTogglePin?: (track: CatalogTrackSummary) => void
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null)
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([])
  const [isAddToPlaylistMenuOpen, setIsAddToPlaylistMenuOpen] = useState(false)
  const addToPlaylistCloseTimerRef = useRef<number | null>(null)
  const setNotification = usePlayerStore((state) => state.setNotification)

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

  const contextTrack = contextMenu ? tracks[contextMenu.rowIndex] ?? null : null
  const contextTrackLocalId = contextTrack ? getLocalTrackIdForCatalogTrack(contextTrack) : null
  const contextTrackShareUrl = contextTrack ? getShareUrlForCatalogTrack(contextTrack) : null
  const canAddContextTrackToPlaylist = !!contextTrack?.availability.playable
  const canShareContextTrack = !!contextTrackShareUrl
  const localDestinationPlaylists = useMemo(
    () => playlists.filter((playlist) => playlist.management === 'app' && playlist.read_only === 0 && !playlist.legacy_mixed && playlist.playback_provider_id === contextTrack?.sourceLinks[0]?.provider),
    [playlists, contextTrack],
  )

  const handleAddTrackToPlaylist = async (playlist: PlaylistInfo) => {
    if (!contextTrack) return
    const result = contextTrackLocalId
      ? await window.puros.playlists.addTrack(playlist.id, contextTrackLocalId)
      : await window.puros.playlists.addCatalogTrack(
          playlist.id,
          contextTrack.id,
          contextTrack.preferredProvider ?? null,
          contextTrack.preferredSourceId ?? null,
        )
    setContextMenu(null)
    setIsAddToPlaylistMenuOpen(false)
    if (result.alreadyPresent) return
  }

  const handleCreatePlaylistAndAddTrack = async () => {
    if (!contextTrack) return
    const playlistName = window.prompt('New playlist name')
    if (!playlistName?.trim()) return

    const playlist = await window.puros.playlists.create(playlistName.trim(), undefined, contextTrack.sourceRef.providerId)
    await handleAddTrackToPlaylist(playlist)
  }

  const handleShareTrackLink = async () => {
    if (!contextTrackShareUrl) return
    await window.puros.app.copyToClipboard(contextTrackShareUrl)
    setContextMenu(null)
    setIsAddToPlaylistMenuOpen(false)
    setNotification('Song link copied')
  }

  const addToPlaylistSubmenuLeft = contextMenu
    ? Math.min(contextMenu.x + 174, window.innerWidth - 248)
    : 0
  const addToPlaylistSubmenuTop = contextMenu
    ? Math.min(contextMenu.y + 36, window.innerHeight - Math.min(360, localDestinationPlaylists.length * 36 + 88))
    : 0

  return (
    <div className="relative rounded-2xl border border-white/5 overflow-hidden">
      <table className="w-full">
        <thead className="bg-white/[0.03]">
          <tr className="text-[11px] uppercase tracking-wider text-zinc-500">
            {showTrackNumber && <th className="text-left px-4 py-3 font-medium w-10">#</th>}
            <th className="text-left px-4 py-3 font-medium">Title</th>
            <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Artist</th>
            <th className="text-right px-4 py-3 font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track, index) => (
            <tr
              key={`${track.id}:${track.preferredSourceId ?? 'default'}`}
              onClick={() => onPlayTrack(track, index)}
              onContextMenu={(event) => {
                if (!onQueueTrack && !onTogglePin) return
                event.preventDefault()
                event.stopPropagation()
                const canAddTrackToPlaylist = track.availability.playable
                const canShareTrack = !!getShareUrlForCatalogTrack(track)
                const menuW = 180
                const menuH = 52 + (canAddTrackToPlaylist ? 36 : 0) + (canShareTrack ? 36 : 0) + (onTogglePin ? 36 : 0)
                setIsAddToPlaylistMenuOpen(false)
                setContextMenu({
                  x: Math.min(event.clientX, window.innerWidth - menuW - 8),
                  y: Math.min(event.clientY, window.innerHeight - menuH - 8),
                  rowIndex: index,
                })
              }}
              className="border-t border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors"
            >
              {showTrackNumber && (
                <td className="px-4 py-3 text-xs text-zinc-500 font-mono">
                  {track.trackNumber ?? index + 1}
                </td>
              )}
              <td className="px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-100 truncate">{track.title}</p>
                  <div className="flex items-center gap-2 mt-0.5 min-w-0">
                    {track.albumId && onOpenAlbum ? (
                      <button
                        className="text-xs text-zinc-500 hover:text-zinc-300 truncate transition-colors"
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenAlbum(track.albumId!)
                        }}
                      >
                        {track.albumTitle ?? 'Unknown album'}
                      </button>
                    ) : (
                      <p className="text-xs text-zinc-500 truncate">
                        {track.albumTitle ?? 'Unknown album'}
                      </p>
                    )}
                    <div className="flex items-center gap-1 shrink-0">
                      {getVisibleTrackSourceLinks(track.sourceLinks, track.preferredProvider).map((source, index) => (
                        <ProviderBadge
                          key={`${track.id}:${source.provider}:${source.sourceId ?? 'missing'}:${index}`}
                          provider={source.provider}
                          compact
                          className="rounded-md bg-white/[0.05] border-white/10 text-zinc-500"
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </td>
              <td className="px-4 py-3 hidden md:table-cell">
                {track.primaryArtistId && onOpenArtist ? (
                  <button
                    className="text-sm text-zinc-300 hover:text-white transition-colors"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenArtist(track.primaryArtistId!)
                    }}
                  >
                    {track.artistCreditName ?? track.primaryArtistName ?? 'Unknown Artist'}
                  </button>
                ) : (
                  <span className="text-sm text-zinc-400">{track.artistCreditName ?? track.primaryArtistName ?? 'Unknown Artist'}</span>
                )}
              </td>
              <td className="px-4 py-3 text-right text-xs text-zinc-500 font-mono">
                {formatDuration(track.durationMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {contextMenu && (onQueueTrack || onTogglePin) && (
        <div
          className="fixed z-50 min-w-44 py-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onMouseEnter={clearAddToPlaylistCloseTimer}
          onMouseLeave={scheduleAddToPlaylistClose}
        >
          {onQueueTrack && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
              onClick={() => {
                const track = tracks[contextMenu.rowIndex]
                setContextMenu(null)
                if (track) onQueueTrack(track, contextMenu.rowIndex)
              }}
            >
              Add to Queue
            </button>
          )}
          {onTogglePin && contextTrack && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
              onClick={() => {
                const track = tracks[contextMenu.rowIndex]
                setContextMenu(null)
                if (track) onTogglePin(track)
              }}
            >
              {isTrackPinned?.(contextTrack) ? 'Unpin from Pins' : 'Pin to Pins'}
            </button>
          )}
          {canShareContextTrack && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
              onClick={() => { void handleShareTrackLink() }}
            >
              Share Song Link
            </button>
          )}
          {canAddContextTrackToPlaylist && (
            <button
              className="w-full flex items-center justify-between text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
              onMouseEnter={() => {
                clearAddToPlaylistCloseTimer()
                setIsAddToPlaylistMenuOpen(true)
              }}
              onClick={(event) => event.preventDefault()}
            >
              <span>Add to Playlist</span>
              <span className="text-zinc-500">›</span>
            </button>
          )}
        </div>
      )}
      {contextMenu && isAddToPlaylistMenuOpen && canAddContextTrackToPlaylist && (
        <div
          className="fixed z-[60] min-w-60 max-h-80 overflow-y-auto py-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl"
          style={{ left: addToPlaylistSubmenuLeft, top: addToPlaylistSubmenuTop }}
          onClick={(event) => event.stopPropagation()}
          onMouseEnter={clearAddToPlaylistCloseTimer}
          onMouseLeave={scheduleAddToPlaylistClose}
        >
          <div className="px-4 py-2 border-b border-zinc-800">
            <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Add to Playlist</p>
            <p className="mt-1 text-xs text-zinc-400 truncate">{contextTrack?.title ?? 'Track'}</p>
          </div>
          <button
            className="w-full text-left px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 transition-colors"
            onClick={() => { void handleCreatePlaylistAndAddTrack() }}
          >
            Create New Playlist…
          </button>
          {localDestinationPlaylists.length > 0 ? (
            localDestinationPlaylists.map((playlist) => (
              <button
                key={playlist.id}
                className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
                onClick={() => { void handleAddTrackToPlaylist(playlist) }}
              >
                {playlist.name}
              </button>
            ))
          ) : (
            <p className="px-4 py-2 text-sm text-zinc-500">No compatible playlists yet</p>
          )}
        </div>
      )}
    </div>
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
    pendingArtistId,
    pendingAlbumId,
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
  const canExpandBio = artistBio.length > 280

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
      <div className="px-6 py-4 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">
              {activeScope === 'library' ? 'Library' : 'Explore'}
            </p>
            <h1 className="truncate text-xl font-semibold text-zinc-100">
              {query.trim() ? `Results for “${query.trim()}”` : activeScope === 'library' ? 'Your library' : 'Browse'}
            </h1>
          </div>
        </div>
      </div>
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

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {error && <p className="text-sm text-rose-400 mb-4">{error}</p>}

          {view === 'search' && (
          <div className="space-y-8">
            {(results.artists.length > 0 || results.albums.length > 0 || results.tracks.length > 0 || results.playlists.length > 0) ? (
              <>
                {(resultTab === 'all' || resultTab === 'artists') && results.artists.length > 0 && (
                  <Section title="Artists">
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                      {results.artists.map((artist) => (
                        <Card
                          key={artist.id}
                          title={artist.name}
                          subtitle={formatArtistSearchStats(artist.albumCount, artist.trackCount)}
                          image={resolveArtwork({ artworkId: artist.artworkId, artworkUrl: artist.artworkUrl })}
                          meta={
                            <div className="space-y-2">
                              <SourcePills sourceLinks={artist.sourceLinks} />
                            </div>
                          }
                          onClick={() => void openArtist(artist.id)}
                        />
                      ))}
                    </div>
                  </Section>
                )}

                {(resultTab === 'all' || resultTab === 'albums') && results.albums.length > 0 && (
                  <Section title="Albums">
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                      {results.albums.map((album) => (
                        <Card
                          key={album.id}
                          title={album.title}
                          subtitle={`${album.artistCreditName ?? album.primaryArtistName ?? 'Unknown Artist'} • ${formatYear(album.year)}`}
                          image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                          meta={
                            <div className="space-y-2">
                              <ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} />
                              <SourcePills sourceLinks={album.sourceLinks} />
                            </div>
                          }
                          contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                          onClick={() => void openAlbum(album.id)}
                        />
                      ))}
                    </div>
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
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                      {results.playlists.map((playlist) => (
                        <Card
                          key={playlist.id}
                          title={playlist.title}
                          subtitle={playlist.trackCount ? `${playlist.trackCount} tracks` : `${getProviderDisplayName(playlist.provider)} playlist`}
                          image={playlist.artworkUrl}
                          meta={<ProviderBadge provider={playlist.provider} />}
                          onClick={() => {
                            openProviderCollection(playlistCollectionItem(playlist))
                          }}
                        />
                      ))}
                    </div>
                  </Section>
                )}


              </>
            ) : (
              <div className="h-full min-h-80 flex items-center justify-center text-center">
                <div className="max-w-md">
                  <p className="text-lg text-zinc-200">{isLoading ? 'Searching…' : emptyState}</p>
                  <p className="text-sm text-zinc-500 mt-3">
                    Choose a provider above to browse its artists, albums, tracks and playlists.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'artist' && !currentArtist && (
          <PageLoadingShell
            entityType="artist"
            title="Opening artist…"
            subtitle={
              pendingArtistId
                ? 'You are already on the artist page. Details are loading in the background.'
                : 'Preparing artist details…'
            }
          />
        )}

        {view === 'artist' && currentArtist && (
          <div className="space-y-8">
            <div className="flex flex-col xl:flex-row gap-6">
              <div className="w-44 h-44 shrink-0 rounded-3xl overflow-hidden bg-white/[0.04] border border-white/5">
                {resolveArtwork({ artworkId: currentArtist.artworkId, artworkUrl: currentArtist.artworkUrl }) ? (
                  <img
                    src={resolveArtwork({ artworkId: currentArtist.artworkId, artworkUrl: currentArtist.artworkUrl })!}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-6xl text-zinc-600 font-semibold">
                    {currentArtist.name.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Artist</p>
                <h1 className="text-4xl font-semibold text-zinc-100 mt-2">{currentArtist.name}</h1>
                {formatArtistStats(currentArtist.albumCount, currentArtist.trackCount) && (
                  <p className="text-sm text-zinc-500 mt-3">
                    {formatArtistStats(currentArtist.albumCount, currentArtist.trackCount)}
                  </p>
                )}

                <div className="mt-3">
                  <SourcePills sourceLinks={currentArtist.sourceLinks} preferredProvider={currentArtist.preferredProvider} />
                </div>
                <div className="mt-4 max-w-3xl">
                  <div className="flex items-center gap-2">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Genres</p>
                    {!isEditingArtistGenres && (
                      <button
                        type="button"
                        onClick={() => {
                          setArtistGenreDraft(currentArtist.genres.join(', '))
                          setIsEditingArtistGenres(true)
                        }}
                        className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {genreStatus && <p role="status" className="text-xs text-zinc-400 mt-2">{genreStatus}</p>}
                  {isEditingArtistGenres ? (
                    <div className="mt-2 flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        value={artistGenreDraft}
                        onChange={(event) => setArtistGenreDraft(event.target.value)}
                        placeholder="metal, progressive metal, rock"
                        className="min-w-0 flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-white/25"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => { void saveArtistGenres() }}
                          disabled={artistGenreSaving}
                          className="px-3 py-2 rounded-lg bg-white text-zinc-950 text-xs font-medium hover:bg-zinc-200 transition-colors disabled:opacity-50"
                        >
                          {artistGenreSaving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setArtistGenreDraft(currentArtist.genres.join(', '))
                            setIsEditingArtistGenres(false)
                          }}
                          disabled={artistGenreSaving}
                          className="px-3 py-2 rounded-lg border border-white/10 text-xs text-zinc-300 hover:text-white hover:bg-white/[0.05] transition-colors disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : currentArtist.genres.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {currentArtist.genres.map((genre) => (
                        <span
                          key={genre}
                          className="px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.04] text-xs text-zinc-300"
                        >
                          {genre}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-zinc-500">No genres set</p>
                  )}
                </div>
                <div className="mt-5 max-w-4xl">
                  <p className={`text-sm text-zinc-300 leading-7 ${bioExpanded ? '' : 'line-clamp-4'}`}>
                    {artistBio}
                  </p>
                  {canExpandBio && (
                    <button
                      onClick={() => setBioExpanded((value) => !value)}
                      className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      {bioExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 mt-5">
                  <button
                    onClick={() => void playTracks(currentArtist.topTracks)}
                    className="px-4 py-2 rounded-xl bg-white text-zinc-950 text-sm font-medium hover:bg-zinc-200 transition-colors"
                  >
                    Play Top Tracks
                  </button>
                  <button
                    onClick={() => void addTracksToQueue(currentArtist.topTracks)}
                    className="px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-zinc-100 text-sm hover:bg-white/[0.1] transition-colors"
                  >
                    Add Top Tracks to Queue
                  </button>
                  <button
                    onClick={() => void playTracks(fisherYatesShuffle(currentArtist.topTracks))}
                    className="px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-zinc-100 text-sm hover:bg-white/[0.1] transition-colors"
                  >
                    Shuffle
                  </button>
                  {!currentArtist.availability.inLibrary && (
                    <button
                      onClick={() => void addToLibrary('artist', currentArtist.id, currentArtist.preferredProvider ?? null)}
                      className="px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-zinc-100 text-sm hover:bg-white/[0.1] transition-colors"
                    >
                      Add to Library
                    </button>
                  )}
                  <button
                    onClick={() => void openFirstProviderUrl(currentArtist.sourceLinks, currentArtist.preferredProvider)}
                    className="px-4 py-2 rounded-xl bg-transparent border border-white/10 text-zinc-300 text-sm hover:text-white hover:bg-white/[0.05] transition-colors"
                  >
                    Open Source
                  </button>
                </div>
              </div>
            </div>



            {currentArtist.topTracks.length > 0 && (
              <Section title="Top Tracks">
                <div className="space-y-3">
                  <TrackTable
                    tracks={visibleTopTracks}
                    onPlayTrack={(_, index) => void playTracks(visibleTopTracks, index)}
                    onQueueTrack={(track) => void addTrackToQueue(track)}
                    onOpenArtist={(artistId) => void openArtist(artistId)}
                    onOpenAlbum={(albumId) => void openAlbum(albumId)}
                  />
                  {currentArtist.topTracks.length > 5 && (
                    <button
                      onClick={() => setShowAllTopTracks((value) => !value)}
                      className="px-4 py-2 rounded-xl bg-white/[0.04] border border-white/10 text-zinc-300 text-sm hover:bg-white/[0.08] hover:text-white transition-colors"
                    >
                      {showAllTopTracks ? 'Show less' : `Show more (${currentArtist.topTracks.length - 5} more)`}
                    </button>
                  )}
                </div>
              </Section>
            )}

            {currentArtist.topTracks.length === 0 && artistSectionLoading.topTracks && (
              <Section title="Top Tracks">
                <TrackTableSkeleton rows={5} />
              </Section>
            )}

            {groupedArtistReleases.albums.length > 0 && (
              <Section title="Albums">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {groupedArtistReleases.albums.map((album) => (
                    <Card
                      key={album.id}
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      meta={<div className="space-y-2"><ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} /><SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentArtist.preferredProvider} /></div>}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onClick={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {currentArtist.releases.length === 0 && artistSectionLoading.releases && (
              <Section title="Discography">
                <CardGridSkeleton count={6} />
              </Section>
            )}

            {groupedArtistReleases.eps.length > 0 && (
              <Section title="EPs">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {groupedArtistReleases.eps.map((album) => (
                    <Card
                      key={album.id}
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      meta={<div className="space-y-2"><ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} /><SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentArtist.preferredProvider} /></div>}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onClick={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {groupedArtistReleases.singles.length > 0 && (
              <Section title="Singles">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {groupedArtistReleases.singles.map((album) => (
                    <Card
                      key={album.id}
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      meta={<div className="space-y-2"><ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} /><SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentArtist.preferredProvider} /></div>}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onClick={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {groupedArtistReleases.compilations.length > 0 && (
              <Section title="Compilations">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {groupedArtistReleases.compilations.map((album) => (
                    <Card
                      key={album.id}
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      meta={<div className="space-y-2"><ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} /><SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentArtist.preferredProvider} /></div>}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onClick={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {groupedArtistReleases.live.length > 0 && (
              <Section title="Live Albums">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {groupedArtistReleases.live.map((album) => (
                    <Card
                      key={album.id}
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      meta={<div className="space-y-2"><ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} /><SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentArtist.preferredProvider} /></div>}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onClick={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {groupedArtistReleases.other.length > 0 && (
              <Section title="Other Albums">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {groupedArtistReleases.other.map((album) => (
                    <Card
                      key={album.id}
                      title={album.title}
                      subtitle={formatAlbumMeta(album.year, album.totalTracks)}
                      image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      meta={<div className="space-y-2"><SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentArtist.preferredProvider} /></div>}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onClick={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {currentArtist.playlists.length > 0 && (
              <Section title="Playlists">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {currentArtist.playlists.map((playlist) => (
                    <Card
                      key={playlist.id}
                      title={playlist.title}
                      subtitle={playlist.trackCount ? `${playlist.trackCount} tracks` : `${getProviderDisplayName(playlist.provider)} playlist`}
                      image={playlist.artworkUrl}
                      meta={<ProviderBadge provider={playlist.provider} />}
                      onClick={() => {
                        openProviderCollection(playlistCollectionItem(playlist))
                      }}
                    />
                  ))}
                </div>
              </Section>
            )}

            {currentArtist.playlists.length === 0 && artistSectionLoading.playlists && (
              <Section title="Playlists">
                <CardGridSkeleton count={4} />
              </Section>
            )}

            {currentArtist.localAlbums.length > 0 && (
              <Section title="In Your Library">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {currentArtist.localAlbums.map((album) => (
                    <Card
                      key={album.id}
                      title={album.title}
                      subtitle={`${formatYear(album.year)} • Local`}
                      image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      meta={null}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onClick={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {currentArtist.roleSummary.length > 0 && (
              <Section title="Roles">
                <ArtistRoleSummaryList roles={currentArtist.roleSummary} />
              </Section>
            )}

            {currentArtist.appearsOn.length > 0 && (
              <Section title="Appears On">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {currentArtist.appearsOn.map((album) => (
                    <Card
                      key={album.id}
                      title={album.title}
                      subtitle={`${album.artistCreditName ?? album.primaryArtistName ?? 'Various Artists'} • ${formatYear(album.year)}`}
                      image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                      meta={<div className="space-y-2"><ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} /><SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentArtist.preferredProvider} /></div>}
                      contextActions={[{ label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) }]}
                      onClick={() => void openAlbumFromArtistContext(album)}
                    />
                  ))}
                </div>
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
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {currentArtist.relatedArtists.map((artist) => (
                    <Card
                      key={artist.id}
                      title={artist.name}
                      subtitle={`${artist.albumCount} albums`}
                      image={resolveArtwork({ artworkId: artist.artworkId, artworkUrl: artist.artworkUrl })}
                      meta={<SourcePills sourceLinks={artist.sourceLinks} />}
                      onClick={() => void openArtist(artist.id)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {currentArtist.relatedArtists.length === 0 && artistSectionLoading.relatedArtists && (
              <Section title="Related Artists">
                <CardGridSkeleton count={4} />
              </Section>
            )}
          </div>
        )}

        {view === 'album' && !currentAlbum && (
          <PageLoadingShell
            entityType="album"
            title="Opening album…"
            subtitle={
              pendingAlbumId
                ? 'You are already on the album page. Tracks and metadata are loading in the background.'
                : 'Preparing album details…'
            }
          />
        )}

        {view === 'album' && currentAlbum && (
          <div className="space-y-8">
            {(() => {
              const albumSourceBusy = albumSectionLoading.tracks

              return (
              <>
            <div className="flex flex-col xl:flex-row gap-6">
              <div className="w-44 h-44 shrink-0 rounded-3xl overflow-hidden bg-white/[0.04] border border-white/5">
                {resolveArtwork({ artworkId: currentAlbum.artworkId, artworkUrl: currentAlbum.artworkUrl }) ? (
                  <img
                    src={resolveArtwork({ artworkId: currentAlbum.artworkId, artworkUrl: currentAlbum.artworkUrl })!}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-6xl text-zinc-600 font-semibold">
                    {currentAlbum.title.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Album</p>
                <h1 className="text-4xl font-semibold text-zinc-100 mt-2">{currentAlbum.title}</h1>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                  {currentAlbum.primaryArtistId ? (
                    <button
                      onClick={() => void openArtist(currentAlbum.primaryArtistId!)}
                      className="text-zinc-200 hover:text-white transition-colors"
                    >
                      {currentAlbum.artistCreditName ?? currentAlbum.primaryArtistName ?? 'Unknown Artist'}
                    </button>
                  ) : (
                    <span>{currentAlbum.artistCreditName ?? currentAlbum.primaryArtistName ?? 'Unknown Artist'}</span>
                  )}
                  <span>•</span>
                  <span>{formatYear(currentAlbum.year)}</span>
                  {currentAlbum.releaseType && (
                    <>
                      <span>•</span>
                      <span>{formatReleaseType(currentAlbum.releaseType, currentAlbum.releaseSection)}</span>
                    </>
                  )}
                  <span>•</span>
                  <span>{currentAlbum.totalTracks ?? currentAlbum.tracks.length} tracks</span>
                </div>
                <div className="mt-3">
                  <SourcePills sourceLinks={currentAlbum.sourceLinks} preferredProvider={currentAlbum.preferredProvider} />
                </div>

                <div className="flex flex-wrap gap-2 mt-5">
                  <button
                    onClick={() => void playTracks(currentAlbum.tracks)}
                    disabled={albumSourceBusy}
                    className="px-4 py-2 rounded-xl bg-white text-zinc-950 text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-40"
                  >
                    {albumSourceBusy ? 'Loading Tracks…' : 'Play Album'}
                  </button>
                  <button
                    onClick={() => void addAlbumToQueue(currentAlbum.id)}
                    disabled={albumSourceBusy}
                    className="px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-zinc-100 text-sm hover:bg-white/[0.1] transition-colors disabled:opacity-40"
                  >
                    Add Album to Queue
                  </button>
                  <button
                    onClick={() => void playTracks(fisherYatesShuffle(currentAlbum.tracks))}
                    disabled={albumSourceBusy}
                    className="px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-zinc-100 text-sm hover:bg-white/[0.1] transition-colors disabled:opacity-40"
                  >
                    Shuffle
                  </button>
                  {!currentAlbum.availability.inLibrary && (
                    <button
                      onClick={() => void addToLibrary('album', currentAlbum.id, currentAlbum.preferredProvider ?? null)}
                      className="px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-zinc-100 text-sm hover:bg-white/[0.1] transition-colors"
                    >
                      Add to Library
                    </button>
                  )}
                  <button
                    onClick={() => void openFirstProviderUrl(currentAlbum.sourceLinks, currentAlbum.preferredProvider)}
                    disabled={albumSourceBusy}
                    className="px-4 py-2 rounded-xl bg-transparent border border-white/10 text-zinc-300 text-sm hover:text-white hover:bg-white/[0.05] transition-colors disabled:opacity-40"
                  >
                    Open Source
                  </button>
                </div>

                {getAlbumVersionOptions(currentAlbum).length > 1 && (
                  <div className="mt-5 space-y-2">
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
                )}
              </div>
            </div>
                </>
              )
            })()}



            {currentAlbum.tracks.length > 0 && (
              <Section title="Tracks">
                <TrackTable
                  tracks={currentAlbum.tracks}
                  showTrackNumber
                  onPlayTrack={(_, index) => void playTracks(currentAlbum.tracks, index)}
                  onQueueTrack={(track) => void addTrackToQueue(track)}
                  onOpenArtist={(artistId) => void openArtist(artistId)}
                  onOpenAlbum={(albumId) => void openAlbum(albumId)}
                />
              </Section>
            )}

            {currentAlbum.tracks.length === 0 && albumSectionLoading.tracks && (
              <Section title="Tracks">
                <TrackTableSkeleton rows={8} />
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
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {currentAlbum.versions.map((album) => {
                    const preferred = album.id === currentAlbum.id
                    return (
                      <Card
                        key={album.id}
                        title={album.title}
                        subtitle={preferred ? `${formatAlbumMeta(album.year, album.totalTracks)} • Selected` : formatAlbumMeta(album.year, album.totalTracks)}
                        image={resolveArtwork({ artworkId: album.artworkId, artworkUrl: album.artworkUrl })}
                        meta={<div className="space-y-2"><ReleaseTypePill releaseType={album.releaseType} releaseSection={album.releaseSection} /><SourcePills sourceLinks={album.sourceLinks} preferredProvider={currentAlbum.preferredProvider} /></div>}
                        contextActions={[
                          { label: 'Add Album to Queue', onClick: () => void addAlbumToQueue(album.id) },
                        ]}
                        onClick={() => void openAlbum(album.id)}
                      />
                    )
                  })}
                </div>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
