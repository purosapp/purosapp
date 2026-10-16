/**
 * Pins — a manually curated shortlist the user keeps for quick access, grouped
 * by category (albums, artists, tracks, playlists). Albums/artists/tracks are
 * stored as source-specific catalog IDs; playlists as local playlist ids.
 * Persisted to app settings so pins survive restarts.
 */

import { create } from 'zustand'
import { getJsonSetting, setJsonSetting } from '../utils/appSettings'

export type PinCategory = 'albums' | 'artists' | 'tracks' | 'playlists'

export const PIN_CATEGORIES: PinCategory[] = ['albums', 'artists', 'tracks', 'playlists']

export const PIN_CATEGORY_LABELS: Record<PinCategory, string> = {
  albums: 'Albums',
  artists: 'Artists',
  tracks: 'Tracks',
  playlists: 'Playlists',
}

interface PinsData {
  albums: string[]
  artists: string[]
  tracks: string[]
  playlists: number[]
}

const SETTINGS_KEY = 'pins:v1'

const EMPTY: PinsData = { albums: [], artists: [], tracks: [], playlists: [] }

interface PinsState extends PinsData {
  loaded: boolean
  category: PinCategory
  load: () => Promise<void>
  setCategory: (category: PinCategory) => void
  isPinned: (category: PinCategory, id: string | number) => boolean
  toggle: (category: PinCategory, id: string | number) => void
  replace: (category: PinCategory, oldId: string, newId: string) => void
  count: (category: PinCategory) => number
}

function sanitize(value: unknown): PinsData {
  const data = (value ?? {}) as Partial<PinsData>
  return {
    albums: Array.isArray(data.albums) ? data.albums.filter((x): x is string => typeof x === 'string') : [],
    artists: Array.isArray(data.artists) ? data.artists.filter((x): x is string => typeof x === 'string') : [],
    tracks: Array.isArray(data.tracks) ? data.tracks.filter((x): x is string => typeof x === 'string') : [],
    playlists: Array.isArray(data.playlists) ? data.playlists.filter((x): x is number => typeof x === 'number') : [],
  }
}

export const usePinsStore = create<PinsState>((set, get) => ({
  ...EMPTY,
  loaded: false,
  category: 'albums',

  load: async () => {
    const stored = sanitize(await getJsonSetting<unknown>(SETTINGS_KEY, EMPTY))
    set({ ...stored, loaded: true })
  },

  setCategory: (category) => set({ category }),

  isPinned: (category, id) => {
    const list = get()[category] as Array<string | number>
    return list.includes(id)
  },

  toggle: (category, id) => {
    set((state) => {
      const list = state[category] as Array<string | number>
      const next = list.includes(id)
        ? list.filter((existing) => existing !== id)
        : [id, ...list]
      const updated = { ...state, [category]: next } as PinsState
      const data: PinsData = {
        albums: updated.albums,
        artists: updated.artists,
        tracks: updated.tracks,
        playlists: updated.playlists,
      }
      void setJsonSetting(SETTINGS_KEY, data)
      return { [category]: next } as Partial<PinsState>
    })
  },

  replace: (category, oldId, newId) => {
    if (category === 'playlists') return
    const next = [...new Set((get()[category] as string[]).map(id => id === oldId ? newId : id))]
    set({ [category]: next })
    const { albums, artists, tracks, playlists } = get()
    void setJsonSetting(SETTINGS_KEY, { albums, artists, tracks, playlists })
  },

  count: (category) => (get()[category] as Array<string | number>).length,
}))
