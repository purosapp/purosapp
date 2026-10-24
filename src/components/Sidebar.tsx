/**
 * Sidebar — left nav with home/explore
 * and the playlists section with create/sort/DnD.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, Ellipsis, Folder, Music } from 'lucide-react'
import {
  ChevronRightIcon,
  CompassIcon,
  Disc3Icon,
  HistoryIcon,
  HouseIcon,
  MusicIcon,
  PinIcon,
  PlusIcon,
  RadioIcon,
  TagsIcon,
  UserIcon,
} from '@animateicons/react/lucide'
import { usePlaylistStore, SORT_LABELS, SORT_ORDERS, type PlaylistFolderInfo, type PlaylistInfo } from '../store/playlistStore'
import { usePlayerStore } from '../store/playerStore'
import { getPlaylistDownloadMenuEntries } from '../store/downloadStore'
import { trackRowToTrack } from '../store/libraryStore'
import { artworkUrl } from '../utils/artworkUrl'
import { showContextMenu } from '../utils/contextMenu'
import { getBooleanSetting, getJsonSetting, setBooleanSetting, setJsonSetting } from '../utils/appSettings'
import { ProviderIcon, useProviderPresentation } from './ProviderBadge'
import { Button } from './ui'
import { useSettingsStore } from '../store/settingsStore'
import type { AppShellView } from '../store/appShellStore'
import { usePinsStore, PIN_CATEGORIES, PIN_CATEGORY_LABELS, type PinCategory } from '../store/pinsStore'
import { isLiveRadioTrack } from '../services/liveRadio/track'

export type ActiveView = AppShellView

interface SidebarProps {
  activeView: ActiveView
  onViewChange: (view: ActiveView) => void
}

const CLOSED_PLAYLIST_FOLDERS_SETTING_KEY = 'ui:closedPlaylistFolderIds'
const CLOSED_PROVIDER_GROUPS_SETTING_KEY = 'ui:closedPlaylistProviderGroups'

// ---------------------------------------------------------------------------
// Icons — nav icons are animated Lucide icons driven by the row's hover, so
// the whole row (not just the 14px glyph) triggers the animation.
// ---------------------------------------------------------------------------

interface AnimatedIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

type AnimatedIcon = React.ForwardRefExoticComponent<
  { size?: number; className?: string } & React.RefAttributes<AnimatedIconHandle>
>

function useIconHover() {
  const ref = useRef<AnimatedIconHandle>(null)
  const hoverProps = {
    onMouseEnter: () => ref.current?.startAnimation(),
    onMouseLeave: () => ref.current?.stopAnimation(),
  }
  return { ref, hoverProps }
}

function NavIcon({
  icon: Icon,
  iconRef,
  indicator = false,
  tinted = true,
}: {
  icon: AnimatedIcon
  iconRef: React.Ref<AnimatedIconHandle>
  indicator?: boolean
  /** Nav rows get full-size white icons; small header actions stay grey and smaller. */
  tinted?: boolean
}) {
  return (
    <span className={`relative flex shrink-0 items-center justify-center ${tinted ? 'h-5 w-5 text-white' : 'h-3.5 w-3.5'}`}>
      <Icon ref={iconRef} size={tinted ? 16 : 14} />
      {indicator && (
        <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.9)] animate-pulse" />
      )}
    </span>
  )
}

type NavEntry = { view: Exclude<ActiveView, number>; label: string; icon: AnimatedIcon }

/** Grouped like Music on macOS: listening destinations, then the library. */
const NAV_TOP: NavEntry[] = [
  { view: 'library', label: 'Home', icon: HouseIcon },
  { view: 'explore', label: 'Explore', icon: CompassIcon },
  { view: 'live-radio', label: 'Live Radio', icon: RadioIcon },
]

const NAV_LIBRARY: NavEntry[] = [
  { view: 'pins', label: 'Pins', icon: PinIcon },
  { view: 'artists', label: 'Artists', icon: UserIcon },
  { view: 'albums', label: 'Albums', icon: Disc3Icon },
  { view: 'tracks', label: 'Tracks', icon: MusicIcon },
  { view: 'genres', label: 'Genres', icon: TagsIcon },
  { view: 'history', label: 'History', icon: HistoryIcon },
]

/** macOS sidebar rows: white labels and icons, a soft grey selection. */
const ROW_CLASS = 'w-full flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13px] transition-colors text-left'
const ROW_ACTIVE = 'bg-white/[0.12] text-white'
const ROW_IDLE = 'text-zinc-100 hover:bg-white/[0.05]'

/** Section title ("Library", "Playlists") in the macOS sidebar style. */
function SidebarHeading({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-semibold text-zinc-500">{children}</span>
}

function IconFolder() {
  return <Folder className="w-4 h-4 text-zinc-100" />
}

/** Disclosure chevron at the end of a folder row, as in Music's sidebar. */
function IconChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={`w-3.5 h-3.5 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}
      strokeWidth={2.25}
    />
  )
}

// ---------------------------------------------------------------------------
// Nav item
// ---------------------------------------------------------------------------

function NavItem({
  icon,
  indicator,
  label,
  active,
  onClick,
}: {
  icon: AnimatedIcon
  indicator?: boolean
  label: string
  active: boolean
  onClick: () => void
}) {
  const { ref, hoverProps } = useIconHover()
  return (
    <button
      onClick={onClick}
      {...hoverProps}
      className={`${ROW_CLASS} ${active ? ROW_ACTIVE : ROW_IDLE}`}
    >
      <NavIcon icon={icon} iconRef={ref} indicator={indicator} />
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Pins — nav entry whose hover reveals the four pinned categories
// ---------------------------------------------------------------------------

function PinsFlyout({
  anchor,
  onPick,
  onMouseEnter,
  onMouseLeave,
}: {
  anchor: { left: number; top: number }
  onPick: (category: PinCategory) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  const albums = usePinsStore((s) => s.albums.length)
  const artists = usePinsStore((s) => s.artists.length)
  const tracks = usePinsStore((s) => s.tracks.length)
  const playlists = usePinsStore((s) => s.playlists.length)
  const counts: Record<PinCategory, number> = { albums, artists, tracks, playlists }

  return (
    <div
      className="fixed z-50 min-w-44 py-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl"
      style={{ left: anchor.left, top: anchor.top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p className="px-3 pt-1 pb-1.5 text-[11px] font-semibold text-zinc-500">Pinned</p>
      {PIN_CATEGORIES.map((category) => (
        <button
          key={category}
          onClick={() => onPick(category)}
          className="w-full flex items-center justify-between px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <span>{PIN_CATEGORY_LABELS[category]}</span>
          <span className="text-xs text-zinc-500 tabular-nums">{counts[category]}</span>
        </button>
      ))}
    </div>
  )
}

function PinsNavItem({
  active,
  onPick,
}: {
  active: boolean
  onPick: (category: PinCategory) => void
}) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const category = usePinsStore((s) => s.category)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pinIcon = useIconHover()
  const chevronRef = useRef<AnimatedIconHandle>(null)

  const open = useCallback(() => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ left: rect.right + 4, top: rect.top })
  }, [])

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => setAnchor(null), 120)
  }, [])

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current) }, [])

  return (
    <div ref={wrapperRef} className="relative" onMouseEnter={open} onMouseLeave={scheduleClose}>
      <button
        onClick={() => onPick(category)}
        onMouseEnter={() => { pinIcon.hoverProps.onMouseEnter(); chevronRef.current?.startAnimation() }}
        onMouseLeave={() => { pinIcon.hoverProps.onMouseLeave(); chevronRef.current?.stopAnimation() }}
        className={`${ROW_CLASS} ${active ? ROW_ACTIVE : ROW_IDLE}`}
      >
        <NavIcon icon={PinIcon} iconRef={pinIcon.ref} />
        <span className="flex-1">Pins</span>
        <ChevronRightIcon ref={chevronRef} size={12} className="text-zinc-500" />
      </button>
      {anchor && (
        <PinsFlyout
          anchor={anchor}
          onPick={(category) => { setAnchor(null); onPick(category) }}
          onMouseEnter={open}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Playlist artwork thumbnail — fetches lazily, shows folder placeholder
// ---------------------------------------------------------------------------

function PlaylistArtwork({
  playlistId,
  artworkId,
  refreshKey,
}: {
  playlistId: number
  artworkId: string | null
  refreshKey: number
}) {
  const [src, setSrc] = useState<string | null>(artworkUrl(artworkId, null) ?? null)

  useEffect(() => {
    let cancelled = false
    const directArtwork = artworkUrl(artworkId, null)
    if (directArtwork) {
      setSrc(directArtwork)
      return () => { cancelled = true }
    }
    setSrc(null)
    window.puros.playlists.getArtwork(playlistId).then((url) => {
      if (!cancelled) setSrc(url)
    })
    return () => { cancelled = true }
  }, [artworkId, playlistId, refreshKey])

  if (src) {
    return (
      <img
        src={src}
        className="w-5 h-5 rounded-[5px] object-cover shrink-0"
        alt=""
      />
    )
  }
  return (
    <div className="w-5 h-5 rounded-[5px] bg-white/10 flex items-center justify-center shrink-0">
      <Music className="w-3 h-3 text-zinc-400" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// New / Rename playlist modal
// ---------------------------------------------------------------------------

function PlaylistModal({
  title,
  initialValue,
  placeholder = 'Playlist name',
  onConfirm,
  onCancel,
}: {
  title: string
  initialValue?: string
  placeholder?: string
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initialValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = () => {
    if (value.trim()) onConfirm(value.trim())
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-80 shadow-2xl">
        <h2 className="text-sm font-semibold text-zinc-100 mb-4">{title}</h2>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder={placeholder}
          className="h-9 w-full rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-sm text-zinc-100 placeholder-zinc-500 transition-colors hover:border-white/15 focus:outline-none focus:border-white/20"
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" label="Cancel" onClick={onCancel} />
          <Button variant="primary" label={initialValue !== undefined ? 'Save' : 'Create'} onClick={submit} disabled={!value.trim()} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Playlist row — with context menu and DnD drop target
// ---------------------------------------------------------------------------

function PlaylistRow({
  playlist,
  active,
  onClick,
  onDrop,
  onRename,
  onDelete,
  onDuplicate,
  onAddToQueue,
  onMoveToRoot,
  pinned,
  onTogglePin,
  artworkRefreshKey,
}: {
  playlist: PlaylistInfo
  active: boolean
  onClick: () => void
  onDrop: (trackId: number) => void
  onRename: () => void
  onDelete: () => void
  onDuplicate: () => void
  onAddToQueue: () => void
  onMoveToRoot: () => void
  pinned: boolean
  onTogglePin: () => void
  artworkRefreshKey: number
}) {
  const [isDragOver, setIsDragOver] = useState(false)
  const isReadOnly = playlist.read_only === 1
  const provider = playlist.playback_provider_id || 'local'
  const { label: providerLabel } = useProviderPresentation(provider)

  return (
    <>
      <div
        onClick={onClick}
        title={`${playlist.name}\n${providerLabel} · ${playlist.track_count} ${playlist.track_count === 1 ? 'track' : 'tracks'}`}
        draggable={!isReadOnly}
        onDragStart={(e) => {
          if (isReadOnly) return
          e.dataTransfer.setData('application/x-puros-playlist-id', String(playlist.id))
          e.dataTransfer.effectAllowed = 'move'
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void getPlaylistDownloadMenuEntries(playlist.id, playlist.name).then((downloadEntries) => showContextMenu([
            !isReadOnly && { label: 'Rename', onClick: onRename },
            { label: 'Duplicate', onClick: onDuplicate },
            { label: 'Add to queue', onClick: onAddToQueue },
            { label: pinned ? 'Unpin from Pins' : 'Pin to Pins', onClick: onTogglePin },
            !isReadOnly && playlist.folder_id != null && { label: 'Move to top level', onClick: onMoveToRoot },
            downloadEntries.length > 0 && { type: 'separator' },
            ...downloadEntries,
            !isReadOnly && { type: 'separator' },
            !isReadOnly && { label: 'Delete', onClick: onDelete },
          ]))
        }}
        onDragOver={(e) => {
          if (isReadOnly) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          if (isReadOnly) return
          e.preventDefault()
          setIsDragOver(false)
          const raw = e.dataTransfer.getData('text/plain')
          const id = parseInt(raw, 10)
          if (!isNaN(id)) onDrop(id)
        }}
        className={`flex items-center gap-2.5 h-8 px-2.5 rounded-lg cursor-pointer transition-colors ${
          active ? 'bg-white/[0.12]' : 'hover:bg-white/[0.05]'
        } ${isDragOver ? 'ring-1 ring-accent-400 ring-inset' : ''}`}
      >
        <PlaylistArtwork playlistId={playlist.id} artworkId={playlist.artwork_id} refreshKey={artworkRefreshKey} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-100">{playlist.name}</span>
      </div>
    </>
  )
}

function FolderRow({
  folder,
  depth,
  children,
  open,
  onOpenChange,
  onCreatePlaylist,
  onCreateFolder,
  onRename,
  onDelete,
  onMovePlaylist,
}: {
  folder: PlaylistFolderInfo
  depth: number
  children: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreatePlaylist: () => void
  onCreateFolder: () => void
  onRename: () => void
  onDelete: () => void
  onMovePlaylist: (playlistId: number) => void
}) {
  const [isDragOver, setIsDragOver] = useState(false)
  const isReadOnly = folder.read_only === 1
  const provider = folder.source || 'local'
  const { label: providerLabel } = useProviderPresentation(provider)

  return (
    <div>
      <div
        title={`${folder.name}\n${providerLabel} folder`}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void showContextMenu(isReadOnly
            ? [{ label: 'Synced folder', enabled: false }]
            : [
                { label: 'New playlist', onClick: onCreatePlaylist },
                { label: 'New folder', onClick: onCreateFolder },
                { label: 'Rename', onClick: onRename },
                { type: 'separator' },
                { label: 'Delete', onClick: onDelete },
              ])
        }}
        onDragOver={(e) => {
          if (isReadOnly || !Array.from(e.dataTransfer.types).includes('application/x-puros-playlist-id')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setIsDragOver(true)
          if (!open) onOpenChange(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          if (isReadOnly) return
          const raw = e.dataTransfer.getData('application/x-puros-playlist-id')
          const playlistId = parseInt(raw, 10)
          if (!Number.isFinite(playlistId)) return
          e.preventDefault()
          setIsDragOver(false)
          onMovePlaylist(playlistId)
        }}
        className={`flex items-center gap-2.5 h-8 pr-2.5 rounded-lg cursor-pointer transition-colors ${
          isDragOver ? 'bg-accent-400/10 ring-1 ring-accent-400/50' : 'hover:bg-white/[0.05]'
        }`}
        style={{ paddingLeft: 10 + depth * 12 }}
        onClick={() => onOpenChange(!open)}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center"><IconFolder /></span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-100">{folder.name}</span>
        <IconChevron open={open} />
      </div>

      {open && <div className="space-y-px">{children}</div>}
    </div>
  )
}

// Virtual folder shown when playlists are grouped by provider. It isn't a
// stored folder, so it has no context menu and isn't a drop target.
function ProviderGroupRow({
  provider,
  playlistCount,
  open,
  onOpenChange,
  children,
}: {
  provider: string
  playlistCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  const { label } = useProviderPresentation(provider)

  return (
    <div>
      <div
        title={`${label}\n${playlistCount} ${playlistCount === 1 ? 'playlist' : 'playlists'}`}
        className="flex items-center gap-2.5 h-8 px-2.5 rounded-lg cursor-pointer transition-colors hover:bg-white/[0.05]"
        onClick={() => onOpenChange(!open)}
      >
        <span className="w-5 h-5 flex items-center justify-center shrink-0">
          <ProviderIcon provider={provider} monochrome className="w-4 h-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-100">{label}</span>
        <IconChevron open={open} />
      </div>

      {open && <div className="space-y-px">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export default function Sidebar({ activeView, onViewChange }: SidebarProps) {
  const {
    playlists,
    folders,
    sortOrder,
    loadPlaylists,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    duplicatePlaylist,
    createFolder,
    renameFolder,
    deleteFolder,
    movePlaylistToFolder,
    setSortOrder,
  } = usePlaylistStore()
  const { addToQueue } = usePlayerStore()
  const liveRadioPlaying = usePlayerStore((state) => state.isPlaying && isLiveRadioTrack(state.currentTrack))
  const loadPins = usePinsStore((s) => s.load)
  const setPinCategory = usePinsStore((s) => s.setCategory)
  const togglePin = usePinsStore((s) => s.toggle)
  const pinnedPlaylists = usePinsStore((s) => s.playlists)
  const groupByProvider = useSettingsStore((s) => s.groupPlaylistsByProvider)
  const providerPriority = useSettingsStore((s) => s.catalogSourcePriority)

  const pickPins = useCallback((category: PinCategory) => {
    setPinCategory(category)
    onViewChange('pins')
  }, [setPinCategory, onViewChange])

  useEffect(() => { void loadPins() }, [loadPins])

  const [playlistsCollapsed, setPlaylistsCollapsed] = useState(false)
  const [playlistsCollapsedLoaded, setPlaylistsCollapsedLoaded] = useState(false)
  const [closedFolderIds, setClosedFolderIds] = useState<Set<number>>(() => new Set())
  const [folderStateLoaded, setFolderStateLoaded] = useState(false)
  const [closedProviderGroups, setClosedProviderGroups] = useState<Set<string>>(() => new Set())
  const [providerGroupStateLoaded, setProviderGroupStateLoaded] = useState(false)
  const [createPlaylistFolderId, setCreatePlaylistFolderId] = useState<number | null | undefined>(undefined)
  const [createFolderParentId, setCreateFolderParentId] = useState<number | null | undefined>(undefined)
  const [renameTarget, setRenameTarget] = useState<PlaylistInfo | null>(null)
  const [renameFolderTarget, setRenameFolderTarget] = useState<PlaylistFolderInfo | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [artworkRefreshKey, setArtworkRefreshKey] = useState(0)
  const [isRootDragOver, setIsRootDragOver] = useState(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2000)
  }, [])

  useEffect(() => {
    let cancelled = false
    void getBooleanSetting('ui:playlistsCollapsed', false).then((value) => {
      if (cancelled) return
      setPlaylistsCollapsed(value)
      setPlaylistsCollapsedLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (playlistsCollapsedLoaded) void setBooleanSetting('ui:playlistsCollapsed', playlistsCollapsed)
  }, [playlistsCollapsed, playlistsCollapsedLoaded])

  const showPlaylistsMenu = () => {
    void showContextMenu([
      { label: 'New Playlist', onClick: () => setCreatePlaylistFolderId(null) },
      { label: 'New Folder', onClick: () => setCreateFolderParentId(null) },
      { type: 'separator' },
      {
        label: 'Sort By',
        submenu: SORT_ORDERS.map((order) => ({
          label: `${order === sortOrder ? '✓ ' : '\u2003'}${SORT_LABELS[order]}`,
          onClick: () => setSortOrder(order),
        })),
      },
    ])
  }

  // Initial load + subscribe to server-pushed changes
  useEffect(() => {
    loadPlaylists()
    const unsub = window.puros.on('playlists:changed', () => {
      loadPlaylists()
      setArtworkRefreshKey((k) => k + 1)
    })
    return unsub
  }, [loadPlaylists])

  useEffect(() => {
    let cancelled = false
    void getJsonSetting<unknown>(CLOSED_PLAYLIST_FOLDERS_SETTING_KEY, []).then((value) => {
      if (cancelled) return
      const folderIds = Array.isArray(value)
        ? value.filter(
            (folderId): folderId is number =>
              typeof folderId === 'number' && Number.isInteger(folderId) && folderId > 0,
          )
        : []
      setClosedFolderIds(new Set(folderIds))
      setFolderStateLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!folderStateLoaded) return
    void setJsonSetting(
      CLOSED_PLAYLIST_FOLDERS_SETTING_KEY,
      [...closedFolderIds].sort((left, right) => left - right),
    )
  }, [closedFolderIds, folderStateLoaded])

  useEffect(() => {
    let cancelled = false
    void getJsonSetting<unknown>(CLOSED_PROVIDER_GROUPS_SETTING_KEY, []).then((value) => {
      if (cancelled) return
      const providers = Array.isArray(value)
        ? value.filter((provider): provider is string => typeof provider === 'string' && provider.length > 0)
        : []
      setClosedProviderGroups(new Set(providers))
      setProviderGroupStateLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!providerGroupStateLoaded) return
    void setJsonSetting(CLOSED_PROVIDER_GROUPS_SETTING_KEY, [...closedProviderGroups].sort())
  }, [closedProviderGroups, providerGroupStateLoaded])

  const setProviderGroupOpen = useCallback((provider: string, open: boolean) => {
    setClosedProviderGroups((current) => {
      const next = new Set(current)
      if (open) next.delete(provider)
      else next.add(provider)
      return next
    })
  }, [])

  const setFolderOpen = useCallback((folderId: number, open: boolean) => {
    setClosedFolderIds((current) => {
      const next = new Set(current)
      if (open) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  const handleCreate = useCallback(async (name: string) => {
    const folderId = createPlaylistFolderId ?? null
    setCreatePlaylistFolderId(undefined)
    const playlist = await createPlaylist(name, folderId)
    onViewChange(playlist.id)
  }, [createPlaylist, createPlaylistFolderId, onViewChange])

  const handleCreateFolder = useCallback(async (name: string) => {
    const parentId = createFolderParentId ?? null
    setCreateFolderParentId(undefined)
    await createFolder(name, parentId)
  }, [createFolder, createFolderParentId])

  const handleRename = useCallback(async (name: string) => {
    if (!renameTarget) return
    setRenameTarget(null)
    await renamePlaylist(renameTarget.id, name)
  }, [renameTarget, renamePlaylist])

  const handleRenameFolder = useCallback(async (name: string) => {
    if (!renameFolderTarget) return
    setRenameFolderTarget(null)
    await renameFolder(renameFolderTarget.id, name)
  }, [renameFolderTarget, renameFolder])

  const handleDelete = useCallback(async (playlist: PlaylistInfo) => {
    if (!window.confirm(`Delete playlist "${playlist.name}"?`)) return
    await deletePlaylist(playlist.id)
    if (activeView === playlist.id) onViewChange('library')
  }, [deletePlaylist, activeView, onViewChange])

  const handleDeleteFolder = useCallback(async (folder: PlaylistFolderInfo) => {
    if (!window.confirm(`Delete folder "${folder.name}"? Playlists inside it will move to the top level.`)) return
    await deleteFolder(folder.id)
  }, [deleteFolder])

  const handleDuplicate = useCallback(async (playlist: PlaylistInfo) => {
    const duplicated = await duplicatePlaylist(playlist.id)
    if (!duplicated) return

    onViewChange(duplicated.id)
    showToast(
      `Duplicated "${playlist.name}"`
    )
  }, [duplicatePlaylist, onViewChange, showToast])

  const handleAddToQueue = useCallback(async (playlist: PlaylistInfo) => {
    const rows = await window.puros.playlists.getTracks(playlist.id)
    for (const row of rows) {
      addToQueue(trackRowToTrack(row))
    }
    showToast(`Added ${rows.length} ${rows.length === 1 ? 'track' : 'tracks'} to queue`)
  }, [addToQueue, showToast])

  const handleDrop = useCallback(async (playlist: PlaylistInfo, trackId: number) => {
    if (playlist.read_only) {
      showToast(`"${playlist.name}" is synced and is read-only`)
      return
    }
    const result = await window.puros.playlists.addTrack(playlist.id, trackId)
    if (result.alreadyPresent) {
      showToast(`Already in "${playlist.name}"`)
    } else {
      showToast(`Added to "${playlist.name}"`)
      setArtworkRefreshKey((k) => k + 1)
    }
  }, [showToast])

  const handleMovePlaylistToFolder = useCallback(async (playlistId: number, folderId: number | null) => {
    const playlist = playlists.find((item) => item.id === playlistId)
    if (!playlist || playlist.read_only) return
    await movePlaylistToFolder(playlistId, folderId)
    showToast(folderId == null ? `Moved "${playlist.name}" to the top level` : `Moved "${playlist.name}"`)
  }, [movePlaylistToFolder, playlists, showToast])

  const folderIds = new Set(folders.map((folder) => folder.id))
  const foldersByParent = new Map<number | null, PlaylistFolderInfo[]>()
  const playlistsByFolder = new Map<number | null, PlaylistInfo[]>()

  for (const folder of folders) {
    const parentId = folder.parent_id != null && folderIds.has(folder.parent_id) ? folder.parent_id : null
    const bucket = foldersByParent.get(parentId) ?? []
    bucket.push(folder)
    foldersByParent.set(parentId, bucket)
  }
  for (const folderList of foldersByParent.values()) {
    folderList.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  }
  for (const playlist of playlists) {
    const folderId = playlist.folder_id != null && folderIds.has(playlist.folder_id) ? playlist.folder_id : null
    const bucket = playlistsByFolder.get(folderId) ?? []
    bucket.push(playlist)
    playlistsByFolder.set(folderId, bucket)
  }

  // Provider grouping: a top-level playlist belongs to its playback provider; a
  // top-level folder to its sync source, or — for folders made in the app — to
  // the one provider all of its playlists share (Local when they're mixed).
  const playlistProvider = (playlist: PlaylistInfo) => playlist.playback_provider_id || 'local'
  const collectFolderProviders = (folderId: number, into: Set<string>, seen = new Set<number>()) => {
    if (seen.has(folderId)) return into
    seen.add(folderId)
    for (const playlist of playlistsByFolder.get(folderId) ?? []) into.add(playlistProvider(playlist))
    for (const child of foldersByParent.get(folderId) ?? []) collectFolderProviders(child.id, into, seen)
    return into
  }
  const folderProvider = (folder: PlaylistFolderInfo) => {
    if (folder.source && folder.source !== 'local') return folder.source
    const providers = collectFolderProviders(folder.id, new Set())
    return providers.size === 1 ? [...providers][0] : 'local'
  }
  const countFolderPlaylists = (folderId: number, seen = new Set<number>()): number => {
    if (seen.has(folderId)) return 0
    seen.add(folderId)
    return (playlistsByFolder.get(folderId) ?? []).length
      + (foldersByParent.get(folderId) ?? []).reduce((sum, child) => sum + countFolderPlaylists(child.id, seen), 0)
  }

  const providerGroups = new Map<string, { folders: PlaylistFolderInfo[]; playlists: PlaylistInfo[]; playlistCount: number }>()
  const providerGroup = (provider: string) => {
    let group = providerGroups.get(provider)
    if (!group) {
      group = { folders: [], playlists: [], playlistCount: 0 }
      providerGroups.set(provider, group)
    }
    return group
  }
  if (groupByProvider) {
    for (const folder of foldersByParent.get(null) ?? []) {
      const group = providerGroup(folderProvider(folder))
      group.folders.push(folder)
      group.playlistCount += countFolderPlaylists(folder.id)
    }
    for (const playlist of playlistsByFolder.get(null) ?? []) {
      const group = providerGroup(playlistProvider(playlist))
      group.playlists.push(playlist)
      group.playlistCount += 1
    }
  }
  const providerRank = (provider: string) => {
    const index = providerPriority.indexOf(provider)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  const orderedProviderGroups = [...providerGroups.entries()].sort(([left], [right]) => (
    providerRank(left) - providerRank(right) || left.localeCompare(right)
  ))


  const renderPlaylistRow = (playlist: PlaylistInfo, depth = 0) => (
    <div key={playlist.id} style={{ marginLeft: depth * 12 }}>
      <PlaylistRow
        playlist={playlist}
        active={activeView === playlist.id}
        onClick={() => onViewChange(playlist.id)}
        onDrop={(trackId) => handleDrop(playlist, trackId)}
        onRename={() => setRenameTarget(playlist)}
        onDelete={() => handleDelete(playlist)}
        onDuplicate={() => handleDuplicate(playlist)}
        onAddToQueue={() => handleAddToQueue(playlist)}
        onMoveToRoot={() => { void handleMovePlaylistToFolder(playlist.id, null) }}
        pinned={pinnedPlaylists.includes(playlist.id)}
        onTogglePin={() => togglePin('playlists', playlist.id)}
        artworkRefreshKey={artworkRefreshKey}
      />
    </div>
  )

  const renderFolder = (folder: PlaylistFolderInfo, depth = 0): React.ReactNode => (
    <FolderRow
      key={folder.id}
      folder={folder}
      depth={depth}
      open={!closedFolderIds.has(folder.id)}
      onOpenChange={(open) => setFolderOpen(folder.id, open)}
      onCreatePlaylist={() => setCreatePlaylistFolderId(folder.id)}
      onCreateFolder={() => setCreateFolderParentId(folder.id)}
      onRename={() => setRenameFolderTarget(folder)}
      onDelete={() => handleDeleteFolder(folder)}
      onMovePlaylist={(playlistId) => { void handleMovePlaylistToFolder(playlistId, folder.id) }}
    >
      {(foldersByParent.get(folder.id) ?? []).map((child) => renderFolder(child, depth + 1))}
      {(playlistsByFolder.get(folder.id) ?? []).map((playlist) => renderPlaylistRow(playlist, depth + 1))}
    </FolderRow>
  )

  return (
    <>
      <div
        className="shrink-0 h-full w-52 flex flex-col pt-1 border-r border-transparent overflow-hidden"
      >
        <nav className="px-2 pb-1 shrink-0">
          {[{ title: null, items: NAV_TOP }, { title: 'Library', items: NAV_LIBRARY }].map((group) => (
            <div key={group.title ?? 'top'} className="space-y-px">
              {group.title && <div className="px-2.5 pt-4 pb-1"><SidebarHeading>{group.title}</SidebarHeading></div>}
              {group.items.map((item) => item.view === 'pins' ? (
                <PinsNavItem key={item.view} active={activeView === 'pins'} onPick={pickPins} />
              ) : (
                <NavItem
                  key={item.view}
                  icon={item.icon}
                  indicator={item.view === 'live-radio' && liveRadioPlaying}
                  label={item.label}
                  active={activeView === item.view}
                  onClick={() => onViewChange(item.view)}
                />
              ))}
            </div>
          ))}
        </nav>

        {/* Playlists section header */}
        <div className="flex items-center justify-between pl-[18px] pr-2.5 pt-4 pb-1 shrink-0">
          <SidebarHeading>Playlists</SidebarHeading>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={showPlaylistsMenu}
              title="Playlist options"
              aria-label="Playlist options"
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
            >
              <Ellipsis className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPlaylistsCollapsed((value) => !value)}
              title={playlistsCollapsed ? 'Show playlists' : 'Hide playlists'}
              aria-label={playlistsCollapsed ? 'Show playlists' : 'Hide playlists'}
              aria-expanded={!playlistsCollapsed}
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${playlistsCollapsed ? '-rotate-90' : ''}`} />
            </button>
          </div>
        </div>

        {/* Playlist list */}
        <div className={`flex-1 overflow-y-auto px-2 pb-2 space-y-px ${playlistsCollapsed ? 'hidden' : ''}`}>
          <NavItem icon={PlusIcon} label="New Playlist" active={false} onClick={() => setCreatePlaylistFolderId(null)} />
          {playlists.length === 0 && folders.length === 0 ? (
            <p className="text-[11px] text-zinc-600 px-3 py-2">No playlists</p>
          ) : (
            <div
              className={`space-y-px rounded-lg ${isRootDragOver ? 'ring-1 ring-accent-400/50 bg-accent-400/5' : ''}`}
              onDragOver={(e) => {
                if (!Array.from(e.dataTransfer.types).includes('application/x-puros-playlist-id')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setIsRootDragOver(true)
              }}
              onDragLeave={() => setIsRootDragOver(false)}
              onDrop={(e) => {
                const raw = e.dataTransfer.getData('application/x-puros-playlist-id')
                const playlistId = parseInt(raw, 10)
                if (!Number.isFinite(playlistId)) return
                e.preventDefault()
                setIsRootDragOver(false)
                void handleMovePlaylistToFolder(playlistId, null)
              }}
            >
              {groupByProvider ? (
                orderedProviderGroups.map(([provider, group]) => (
                  <ProviderGroupRow
                    key={provider}
                    provider={provider}
                    playlistCount={group.playlistCount}
                    open={!closedProviderGroups.has(provider)}
                    onOpenChange={(open) => setProviderGroupOpen(provider, open)}
                  >
                    {group.folders.map((folder) => renderFolder(folder, 1))}
                    {group.playlists.map((playlist) => renderPlaylistRow(playlist, 1))}
                  </ProviderGroupRow>
                ))
              ) : (
                <>
                  {(foldersByParent.get(null) ?? []).map((folder) => renderFolder(folder, 0))}
                  {(playlistsByFolder.get(null) ?? []).map((playlist) => renderPlaylistRow(playlist, 0))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {createPlaylistFolderId !== undefined && (
        <PlaylistModal
          title="New Playlist"
          onConfirm={handleCreate}
          onCancel={() => setCreatePlaylistFolderId(undefined)}
        />
      )}
      {createFolderParentId !== undefined && (
        <PlaylistModal
          title="New Folder"
          placeholder="Folder name"
          onConfirm={handleCreateFolder}
          onCancel={() => setCreateFolderParentId(undefined)}
        />
      )}
      {renameTarget && (
        <PlaylistModal
          title="Change playlist name"
          initialValue={renameTarget.name}
          onConfirm={handleRename}
          onCancel={() => setRenameTarget(null)}
        />
      )}
      {renameFolderTarget && (
        <PlaylistModal
          title="Change folder name"
          placeholder="Folder name"
          initialValue={renameFolderTarget.name}
          onConfirm={handleRenameFolder}
          onCancel={() => setRenameFolderTarget(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm text-zinc-100 shadow-xl pointer-events-none whitespace-nowrap">
          {toast}
        </div>
      )}
    </>
  );
}
