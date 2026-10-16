import { useCatalogStore } from './catalogStore'
/**
 * Playlist store — Zustand store for sidebar playlist management.
 */

import { create } from 'zustand'
import type { PlaylistFolderInfo, PlaylistInfo } from '../../electron/preload'

export type { PlaylistFolderInfo, PlaylistInfo }

type SortOrder = 'name-asc' | 'name-desc' | 'date-desc' | 'date-asc'

const SORT_CYCLE: SortOrder[] = ['name-asc', 'name-desc', 'date-desc', 'date-asc']

export const SORT_LABELS: Record<SortOrder, string> = {
  'name-asc':  'A → Z',
  'name-desc': 'Z → A',
  'date-desc': 'Newest first',
  'date-asc':  'Oldest first',
}

function sortPlaylists(playlists: PlaylistInfo[], order: SortOrder): PlaylistInfo[] {
  return [...playlists].sort((a, b) => {
    switch (order) {
      case 'name-asc':  return a.name.localeCompare(b.name)
      case 'name-desc': return b.name.localeCompare(a.name)
      case 'date-desc': return b.created_at - a.created_at
      case 'date-asc':  return a.created_at - b.created_at
    }
  })
}

interface PlaylistState {
  playlists: PlaylistInfo[]
  folders: PlaylistFolderInfo[]
  sortOrder: SortOrder
  isLoading: boolean

  loadPlaylists: () => Promise<void>
  createPlaylist: (name: string, folderId?: number | null) => Promise<PlaylistInfo>
  renamePlaylist: (id: number, newName: string) => Promise<void>
  deletePlaylist: (id: number) => Promise<void>
  duplicatePlaylist: (id: number) => Promise<PlaylistInfo | null>
  createFolder: (name: string, parentId?: number | null) => Promise<PlaylistFolderInfo>
  renameFolder: (id: number, newName: string) => Promise<void>
  deleteFolder: (id: number) => Promise<void>
  movePlaylistToFolder: (playlistId: number, folderId?: number | null) => Promise<void>
  cycleSortOrder: () => void
}

export const usePlaylistStore = create<PlaylistState>((set, get) => ({
  playlists: [],
  folders: [],
  sortOrder: 'name-asc',
  isLoading: false,

  loadPlaylists: async () => {
    set({ isLoading: true })
    try {
      const [rawPlaylists, folders] = await Promise.all([
        window.puros.playlists.getAll(),
        window.puros.playlists.getFolders(),
      ])
      set({ playlists: sortPlaylists(rawPlaylists, get().sortOrder), folders })
    } finally {
      set({ isLoading: false })
    }
  },

  createPlaylist: async (name, folderId) => {
    const playlist = await window.puros.playlists.create(name, folderId ?? null, useCatalogStore.getState().activeProviderId)
    await get().loadPlaylists()
    return playlist
  },

  renamePlaylist: async (id, newName) => {
    await window.puros.playlists.rename(id, newName)
    await get().loadPlaylists()
  },

  deletePlaylist: async (id) => {
    await window.puros.playlists.delete(id)
    await get().loadPlaylists()
  },

  duplicatePlaylist: async (id) => {
    const playlist = await window.puros.playlists.duplicate(id)
    await get().loadPlaylists()
    return playlist
  },

  createFolder: async (name, parentId) => {
    const folder = await window.puros.playlists.createFolder(name, parentId ?? null)
    await get().loadPlaylists()
    return folder
  },

  renameFolder: async (id, newName) => {
    await window.puros.playlists.renameFolder(id, newName)
    await get().loadPlaylists()
  },

  deleteFolder: async (id) => {
    await window.puros.playlists.deleteFolder(id)
    await get().loadPlaylists()
  },

  movePlaylistToFolder: async (playlistId, folderId) => {
    await window.puros.playlists.moveToFolder(playlistId, folderId ?? null)
    await get().loadPlaylists()
  },

  cycleSortOrder: () => {
    const { sortOrder, playlists } = get()
    const next = SORT_CYCLE[(SORT_CYCLE.indexOf(sortOrder) + 1) % SORT_CYCLE.length]
    set({ sortOrder: next, playlists: sortPlaylists(playlists, next) })
  },
}))
