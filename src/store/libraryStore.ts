/**
 * Library state — Zustand store.
 * All DB queries go through IPC: renderer → main → better-sqlite3.
 */

import { create } from 'zustand'
import type { TrackRow, AlbumRow, ArtistRow, SearchResults } from '../../electron/preload'
import type { Track } from './playerStore'
import type { FormatInfo } from '../services/local/formats'
import { artworkUrl } from '../utils/artworkUrl'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { TrackRow, AlbumRow, ArtistRow, SearchResults }

export type AlbumSort = 'artist' | 'title' | 'year' | 'date_added'
export type ArtistSort = 'name' | 'album_count'

export interface ScanProgress {
  processed: number
  total: number
  currentFile: string
  phase: 'scanning' | 'normalizing' | 'fetching_bios' | 'done'
}

/** Convert a TrackRow from IPC into the player-compatible Track object */
export function getTrackRowFormatInfo(row: TrackRow): FormatInfo | null {
  const isStreaming = row.source !== 'local'
  const isInspected = !isStreaming || row.stream_info_fetched_at != null
  if (!isInspected || !row.format) return null

  const fmt = row.format
  return {
    format: fmt as FormatInfo['format'],
    sampleRate: row.sample_rate ?? 0,
    bitDepth: row.bit_depth ?? 0,
    bitrate: row.bitrate ?? 0,
    channels: row.channels ?? 2,
    isLossless: !!row.lossless,
    isHiRes: (row.bit_depth ?? 0) > 16 || (row.sample_rate ?? 0) > 48000,
    isMqa: fmt === 'MQA',
    isDsd: fmt === 'DSD',
    dsdRate: fmt === 'DSD' ? (row.sample_rate ?? undefined) : undefined,
  }
}

export function trackRowToTrack(row: TrackRow): Track {
  // Album cover first; a track without one (e.g. a video) falls back to its own thumbnail.
  const cover = artworkUrl(row.album_artwork_id, row.album_art_path) ?? artworkUrl(row.track_artwork_id) ?? null
  const provider = row.source || 'local'
  const isStreaming = provider !== 'local'
  const hasAlbumCover = !!(row.album_artwork_id || row.album_art_path)
  const discordArtworkUrl = isStreaming && row.album_artwork_url?.startsWith('http')
    ? row.album_artwork_url
    : isStreaming && !hasAlbumCover && row.track_art_path?.startsWith('http')
      ? row.track_art_path
      : null
  return {
    id: row.id,
    playlistItemId: row.playlist_item_id,
    smartStackId: row.playlist_stack_id ?? null,
    smartStackPosition: row.playlist_stack_position ?? null,
    catalogTrackId: row.catalog_track_id ?? undefined,
    catalogAlbumId: row.catalog_album_id ?? undefined,
    catalogArtistId: row.catalog_artist_id ?? undefined,
    title: row.title ?? 'Unknown',
    artist: row.artist_credit_name ?? row.artist_name ?? 'Unknown Artist',
    album: row.album_title ?? 'Unknown Album',
    duration: Math.round((row.duration ?? 0) / 1000),
    filePath: isStreaming ? undefined : row.file_path,
    playbackFilePath: isStreaming ? undefined : (row.playback_file_path ?? row.file_path),
    sourceType: provider,
    sourceId: row.source_id ?? undefined,
    streamId: isStreaming ? row.source_id ?? undefined : undefined,
    provider,
    coverUrl: cover,
    formatInfo: getTrackRowFormatInfo(row) ?? undefined,
    artworkUrl: cover,
    discordArtworkUrl,
    startOffsetMs: row.start_offset_ms ?? 0,
    endOffsetMs: row.end_offset_ms ?? null,
    cueSheetPath: row.cue_sheet_path ?? null,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface LibraryState {
  // Data
  tracks: TrackRow[]
  albums: AlbumRow[]
  artists: ArtistRow[]

  // Sort
  albumSort: AlbumSort
  artistSort: ArtistSort

  // Loading / scan
  isLoading: boolean
  isScanning: boolean
  scanProgress: ScanProgress | null

  // Actions — data
  loadTracks: (search?: string) => Promise<void>
  loadAlbums: (sort?: AlbumSort) => Promise<void>
  loadArtists: (sort?: ArtistSort) => Promise<void>
  setAlbumSort: (sort: AlbumSort) => void
  setArtistSort: (sort: ArtistSort) => void

  // Actions — scan
  scanFolder: () => Promise<void>
  rescan: () => Promise<void>
  removeTrack: (trackId: string) => Promise<void>
  clearLibrary: () => Promise<void>
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  albums: [],
  artists: [],

  albumSort: 'artist',
  artistSort: 'name',

  isLoading: false,
  isScanning: false,
  scanProgress: null,

  // --- Data ---

  setAlbumSort: (albumSort) => {
    set({ albumSort })
    get().loadAlbums(albumSort)
  },

  setArtistSort: (artistSort) => {
    set({ artistSort })
    get().loadArtists(artistSort)
  },
  loadTracks: async (search) => {
    set({ isLoading: true })
    try {
      const rows = await window.puros.library.getTracks({ search })
      set({ tracks: rows, isLoading: false })
    } catch (err) {
      console.error('[library] loadTracks:', err)
      set({ isLoading: false })
    }
  },

  loadAlbums: async (sort) => {
    set({ isLoading: true })
    try {
      const rows = await window.puros.library.getAlbums({ sort: sort ?? get().albumSort })
      set({ albums: rows, isLoading: false })
    } catch (err) {
      console.error('[library] loadAlbums:', err)
      set({ isLoading: false })
    }
  },

  loadArtists: async (sort) => {
    set({ isLoading: true })
    try {
      const rows = await window.puros.library.getArtists({ sort: sort ?? get().artistSort })
      set({ artists: rows, isLoading: false })
    } catch (err) {
      console.error('[library] loadArtists:', err)
      set({ isLoading: false })
    }
  },

  // --- Scan ---

  scanFolder: async () => {
    const { loadAlbums } = get()
    set({ isScanning: true, scanProgress: null })
    const unsub = window.puros.on('library:scan-progress', (data: unknown) => {
      set({ scanProgress: data as ScanProgress })
    })
    try {
      const folderPath = await window.puros.library.scanFolder()
      if (folderPath) await loadAlbums()
    } finally {
      unsub()
      set({ isScanning: false, scanProgress: null })
    }
  },

  rescan: async () => {
    const { loadAlbums } = get()
    set({ isScanning: true, scanProgress: null })
    const unsub = window.puros.on('library:scan-progress', (data: unknown) => {
      set({ scanProgress: data as ScanProgress })
    })
    try {
      await window.puros.library.rescan()
      await loadAlbums()
    } finally {
      unsub()
      set({ isScanning: false, scanProgress: null })
    }
  },

  removeTrack: async (trackId) => {
    await window.puros.library.removeTrack(trackId)
    set((s) => ({ tracks: s.tracks.filter((t) => t.id !== trackId) }))
  },

  clearLibrary: async () => {
    await window.puros.library.clearLibrary()
    set({ tracks: [], albums: [], artists: [] })
  },
}))
