import { create } from 'zustand'
import { parseSourceEntityId } from '../services/catalog/sourceIdentity'
import type {
  CatalogAlbumPage,
  CatalogArtistPage,
  CatalogBrowseScope,
  CatalogEntityType,
  CatalogProviderName,
  CatalogSearchResults,
  CatalogTrackSummary,
} from '../services/catalog/types'
import type { PlaybackContext, Track } from './playerStore'
import { usePlayerStore } from './playerStore'

type CatalogView = 'search' | 'artist' | 'album'

interface CatalogHistorySnapshot {
  activeProviderId: string
  view: CatalogView
  query: string
  results: CatalogSearchResults
  currentArtist: CatalogArtistPage | null
  currentAlbum: CatalogAlbumPage | null
  pendingArtistId: string | null
  pendingAlbumId: string | null
  artistSectionLoading: ArtistSectionLoadingState
  albumSectionLoading: AlbumSectionLoadingState
  isLoading: boolean
  error: string | null
}

interface ArtistSectionLoadingState {
  topTracks: boolean
  releases: boolean
  relatedArtists: boolean
  playlists: boolean
}

interface AlbumSectionLoadingState {
  tracks: boolean
}

interface CatalogState {
  activeProviderId: string
  setProvider: (providerId: string, options?: { browse?: boolean; pushHistory?: boolean }) => void
  scope: CatalogBrowseScope
  view: CatalogView
  history: CatalogHistorySnapshot[]
  canGoBack: boolean
  future: CatalogHistorySnapshot[]
  canGoForward: boolean
  query: string
  results: CatalogSearchResults
  currentArtist: CatalogArtistPage | null
  currentAlbum: CatalogAlbumPage | null
  pendingArtistId: string | null
  pendingAlbumId: string | null
  artistSectionLoading: ArtistSectionLoadingState
  albumSectionLoading: AlbumSectionLoadingState
  isLoading: boolean
  error: string | null

  setScope: (scope: CatalogBrowseScope) => Promise<void>
  setQuery: (query: string) => void
  browse: () => Promise<void>
  search: (query: string) => Promise<void>
  openArtist: (catalogArtistId: string, options?: { force?: boolean; pushHistory?: boolean }) => Promise<void>
  openAlbum: (
    catalogAlbumId: string,
    options?: {
      force?: boolean
      pushHistory?: boolean
      artistContext?: { id: string; name: string } | null
    },
  ) => Promise<void>
  goHome: () => void
  resetToDefault: () => void
  goBack: () => void
  goForward: () => void
  clearForward: () => void
  clearHistory: () => void
  refreshCurrent: () => Promise<void>
  silentRefreshCurrent: () => Promise<void>
  addToLibrary: (
    entityType: CatalogEntityType,
    catalogId: string,
    preferredProvider?: CatalogProviderName | null,
  ) => Promise<boolean>
  playTrack: (track: CatalogTrackSummary, preferredProvider?: CatalogProviderName | null) => Promise<void>
  playTracks: (tracks: CatalogTrackSummary[], startIndex?: number, preferredProvider?: CatalogProviderName | null) => Promise<void>
  addTrackToQueue: (track: CatalogTrackSummary, preferredProvider?: CatalogProviderName | null) => Promise<void>
  addTracksToQueue: (tracks: CatalogTrackSummary[], preferredProvider?: CatalogProviderName | null) => Promise<void>
  addAlbumToQueue: (catalogAlbumId: string, preferredProvider?: CatalogProviderName | null) => Promise<void>
}

function emptyResults(): CatalogSearchResults {
  return { artists: [], albums: [], tracks: [], playlists: [] }
}

function isPlaceholderArtistName(name: string | null | undefined) {
  const value = name?.trim().toLowerCase() ?? ''
  return !value || value === 'unknown artist' || value === 'unknown'
}

function applyArtistContextToAlbum<T extends CatalogAlbumPage>(
  album: T,
  artistContext: { id: string; name: string } | null,
): T {
  if (!artistContext) return album
  const needsName = isPlaceholderArtistName(album.primaryArtistName) && isPlaceholderArtistName(album.artistCreditName ?? null)
  const needsId = !album.primaryArtistId
  if (!needsName && !needsId) return album
  return {
    ...album,
    primaryArtistId: album.primaryArtistId ?? artistContext.id,
    primaryArtistName: needsName ? artistContext.name : album.primaryArtistName,
    artistCreditName: needsName ? artistContext.name : album.artistCreditName,
  }
}

function mergeSearchResults(prev: CatalogSearchResults, next: CatalogSearchResults): CatalogSearchResults {
  const merge = <T extends { id: string }>(a: T[], b: T[]): T[] => {
    const map = new Map<string, T>()
    for (const item of a) map.set(item.id, item)
    for (const item of b) {
      const existing = map.get(item.id)
      // Prefer the more recent record but preserve non-zero counts from prior.
      map.set(item.id, existing ? { ...item, ...preserveCounts(existing, item) } : item)
    }
    return [...map.values()]
  }
  return {
    artists: merge(prev.artists, next.artists),
    albums: merge(prev.albums, next.albums),
    tracks: merge(prev.tracks, next.tracks),
    playlists: merge(prev.playlists, next.playlists),
  }
}

function preserveCounts<T>(existing: T, incoming: T): Partial<T> {
  const out: Record<string, unknown> = {}
  const e = existing as unknown as Record<string, number | undefined>
  const i = incoming as unknown as Record<string, number | undefined>
  if (typeof e.albumCount === 'number' && e.albumCount > 0 && !(typeof i.albumCount === 'number' && i.albumCount > 0)) {
    out.albumCount = e.albumCount
  }
  if (typeof e.trackCount === 'number' && e.trackCount > 0 && !(typeof i.trackCount === 'number' && i.trackCount > 0)) {
    out.trackCount = e.trackCount
  }
  return out as Partial<T>
}

type CatalogSet = (partial: Partial<CatalogState> | ((state: CatalogState) => Partial<CatalogState>)) => void
type CatalogGet = () => CatalogState

function hydrateArtistCounts(
  artists: CatalogSearchResults['artists'],
  requestId: number,
  set: CatalogSet,
  get: CatalogGet,
) {
  const needsHydration = artists.filter((artist) => !artist.albumCount && !artist.trackCount)
  if (!needsHydration.length) return
  for (const artist of needsHydration) {
    const artistId = artist.id
    window.puros.catalog.getArtistCounts(artistId)
      .then((counts) => {
        if (!isActiveSearchRequest(requestId)) return
        if (get().view !== 'search') return
        set((current) => {
          const nextArtists = current.results.artists.map((a) =>
            a.id === artistId ? { ...a, albumCount: counts.albumCount, trackCount: counts.trackCount } : a,
          )
          return { results: { ...current.results, artists: nextArtists } }
        })
      })
      .catch(() => { /* best effort */ })
  }
}

function createArtistSectionLoading(value: boolean): ArtistSectionLoadingState {
  return {
    topTracks: value,
    releases: value,
    relatedArtists: value,
    playlists: value,
  }
}

function createAlbumSectionLoading(value: boolean): AlbumSectionLoadingState {
  return {
    tracks: value,
  }
}

function createHistorySnapshot(state: CatalogState): CatalogHistorySnapshot {
  return {
    activeProviderId: state.activeProviderId,
    view: state.view,
    query: state.query,
    results: state.results,
    currentArtist: state.currentArtist,
    currentAlbum: state.currentAlbum,
    pendingArtistId: state.pendingArtistId,
    pendingAlbumId: state.pendingAlbumId,
    artistSectionLoading: state.artistSectionLoading,
    albumSectionLoading: state.albumSectionLoading,
    isLoading: state.isLoading,
    error: state.error,
  }
}

// Simple SWR page cache: keeps last-known artist/album pages in memory so
// the UI paints instantly on revisit and backend refresh happens silently.
const artistPageCache = new Map<string, CatalogArtistPage>()
const albumPageCache = new Map<string, CatalogAlbumPage>()
const PAGE_CACHE_MAX = 64

function rememberArtistPage(artist: CatalogArtistPage) {
  artistPageCache.delete(artist.id)
  artistPageCache.set(artist.id, artist)
  while (artistPageCache.size > PAGE_CACHE_MAX) {
    const first = artistPageCache.keys().next().value
    if (!first) break
    artistPageCache.delete(first)
  }
}

function rememberAlbumPage(album: CatalogAlbumPage) {
  albumPageCache.delete(album.id)
  albumPageCache.set(album.id, album)
  while (albumPageCache.size > PAGE_CACHE_MAX) {
    const first = albumPageCache.keys().next().value
    if (!first) break
    albumPageCache.delete(first)
  }
}

let searchRequestSequence = 0
let playbackQueueRequestSequence = 0

function beginSearchRequest() {
  searchRequestSequence += 1
  return searchRequestSequence
}

function invalidateSearchRequests() {
  searchRequestSequence += 1
}

function isActiveSearchRequest(requestId: number) {
  return requestId === searchRequestSequence
}

/**
 * Build a lightweight, directly-playable queue entry from a catalog summary
 * without resolving anything. It carries display metadata and its exact
 * source, and is flagged `unresolved` so AudioService resolves its
 * source/artwork/format just-in-time when it becomes the current track. This
 * keeps "play one song from a playlist" from resolving the whole queue.
 */
function catalogSummaryToQueueTrack(summary: CatalogTrackSummary): Track {
  const ref = summary.sourceRef
  return {
    id: summary.id,
    catalogTrackId: summary.id,
    catalogAlbumId: summary.albumId ?? null,
    catalogArtistId: summary.primaryArtistId ?? null,
    title: summary.title,
    artist: summary.artistCreditName ?? summary.primaryArtistName ?? 'Unknown Artist',
    album: summary.albumTitle ?? 'Unknown Album',
    duration: Math.round((summary.durationMs ?? 0) / 1000),
    provider: ref.providerId,
    sourceType: ref.providerId,
    sourceId: ref.sourceId,
    streamId: ref.providerId !== 'local' ? ref.sourceId : undefined,
    formatInfo: summary.formatInfo ?? undefined,
    unresolved: true,
  }
}

async function resolveCatalogTrack(
  track: CatalogTrackSummary,
  preferredProvider?: CatalogProviderName | null,
  options?: { allowDiscovery?: boolean },
): Promise<Track | null> {
  const resolved = await window.puros.catalog.resolvePlayback(
    track.id,
    preferredProvider ?? track.preferredProvider ?? null,
    preferredProvider ? null : (track.preferredSourceId ?? null),
    options,
  )
  if (!resolved) return null
  return {
    catalogTrackId: resolved.catalogTrackId,
    catalogAlbumId: resolved.catalogAlbumId ?? null,
    catalogArtistId: resolved.catalogArtistId ?? null,
    sourceType: resolved.sourceType,
    sourceId: resolved.sourceId,
    displayMetadataSource: resolved.displayMetadataSource,
    id: resolved.id,
    title: resolved.title,
    artist: resolved.artist,
    album: resolved.album,
    duration: resolved.duration,
    filePath: resolved.filePath,
    playbackFilePath: resolved.playbackFilePath,
    streamId: resolved.streamId,
    fallbackStreamIds: resolved.fallbackStreamIds,
    provider: resolved.provider,
    coverUrl: resolved.coverUrl ?? null,
    artworkUrl: resolved.artworkUrl ?? null,
    discordArtworkUrl: resolved.discordArtworkUrl ?? null,
    formatInfo: resolved.formatInfo ?? undefined,
    startOffsetMs: resolved.startOffsetMs ?? 0,
    endOffsetMs: resolved.endOffsetMs ?? null,
    cueSheetPath: resolved.cueSheetPath ?? null,
  }
}

function getPlaybackContextForCatalogState(state: Pick<CatalogState, 'view' | 'currentArtist' | 'currentAlbum'>): PlaybackContext | null {
  if (state.view === 'artist' && state.currentArtist?.id) {
    return {
      kind: 'artist',
      label: state.currentArtist.name || 'Artist',
      catalogArtistId: state.currentArtist.id,
    }
  }

  if (state.view === 'album' && state.currentAlbum?.id) {
    return {
      kind: 'album',
      label: state.currentAlbum.title || 'Album',
      catalogAlbumId: state.currentAlbum.id,
    }
  }

  return null
}

function withCatalogPlaybackContext(
  track: Track,
  playbackContext: PlaybackContext | null,
): Track {
  if (!playbackContext) return track
  return {
    ...track,
    playbackContext,
  }
}

function storedProvider(): string {
  try { return localStorage.getItem('catalog:activeProvider') || 'local' } catch { return 'local' }
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  activeProviderId: storedProvider(),
  setProvider: (providerId, options) => {
    if (!providerId || get().activeProviderId === providerId) return
    invalidateSearchRequests()
    const state = get()
    const history = options?.pushHistory === false ? state.history : [...state.history, createHistorySnapshot(state)]
    try { localStorage.setItem('catalog:activeProvider', providerId) } catch { /* unavailable storage */ }
    set({ activeProviderId: providerId, history, canGoBack: history.length > 0, view: 'search', results: emptyResults(), currentArtist: null, currentAlbum: null, pendingArtistId: null, pendingAlbumId: null, artistSectionLoading: createArtistSectionLoading(false), albumSectionLoading: createAlbumSectionLoading(false), isLoading: false, error: null })
    if (options?.browse !== false) {
      if (state.query.trim()) void get().search(state.query)
      else void get().browse()
    }
  },
  scope: 'all',
  view: 'search',
  history: [],
  canGoBack: false,
  future: [],
  canGoForward: false,
  query: '',
  results: emptyResults(),
  currentArtist: null,
  currentAlbum: null,
  pendingArtistId: null,
  pendingAlbumId: null,
  artistSectionLoading: createArtistSectionLoading(false),
  albumSectionLoading: createAlbumSectionLoading(false),
  isLoading: false,
  error: null,

  setScope: async (scope) => {
    set({ scope })
  },

  setQuery: (query) => set({ query }),

  browse: async () => {
    const state = get()
    const nextHistory = state.view === 'search'
      ? state.history
      : [...state.history, createHistorySnapshot(state)]
    const requestId = beginSearchRequest()
    set({ isLoading: true, error: null })
    try {
      const results = await window.puros.catalog.browse(state.activeProviderId, state.scope, 24)
      if (!isActiveSearchRequest(requestId)) return
      set({
        results,
        view: 'search',
        history: nextHistory,
        canGoBack: nextHistory.length > 0,
        currentArtist: null,
        currentAlbum: null,
        pendingArtistId: null,
        pendingAlbumId: null,
        artistSectionLoading: createArtistSectionLoading(false),
        albumSectionLoading: createAlbumSectionLoading(false),
        isLoading: false,
      })
    } catch (error) {
      if (!isActiveSearchRequest(requestId)) return
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Browse failed',
      })
    }
  },

  search: async (query) => {
    const state = get()
    const nextHistory = state.view === 'search'
      ? state.history
      : [...state.history, createHistorySnapshot(state)]
    const requestId = beginSearchRequest()
    set({ isLoading: true, error: null, query })
    try {
      const localResults = await window.puros.catalog.searchLocal(state.activeProviderId, query, 12, state.scope)
      if (!isActiveSearchRequest(requestId)) return
      set({
        results: localResults,
        view: 'search',
        history: nextHistory,
        canGoBack: nextHistory.length > 0,
        currentArtist: null,
        currentAlbum: null,
        pendingArtistId: null,
        pendingAlbumId: null,
        artistSectionLoading: createArtistSectionLoading(false),
        albumSectionLoading: createAlbumSectionLoading(false),
        isLoading: false,
      })

      // Hydrate album/track counts lazily for the locally-known artists.
      hydrateArtistCounts(localResults.artists, requestId, set, get)

      if (get().scope === 'all') {
        window.puros.catalog.searchRemote(state.activeProviderId, query, 12, state.scope)
          .then((remoteResults) => {
            if (!isActiveSearchRequest(requestId)) return
            set((current) => ({
              results: mergeSearchResults(current.results, remoteResults),
            }))
            hydrateArtistCounts(remoteResults.artists, requestId, set, get)
          })
          .catch(() => { /* best effort */ })
      }
    } catch (error) {
      if (!isActiveSearchRequest(requestId)) return
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Search failed',
      })
    }
  },

  openArtist: async (catalogArtistId, options) => {
    const ref = parseSourceEntityId(catalogArtistId)
    if (ref && ref.providerId !== get().activeProviderId) get().setProvider(ref.providerId, { browse: false })
    invalidateSearchRequests()
    const state = get()
    const force = !!options?.force
    const shouldPushHistory = options?.pushHistory ?? true
    if (
      !force &&
      state.view === 'artist' &&
      (state.currentArtist?.id === catalogArtistId || state.pendingArtistId === catalogArtistId)
    ) {
      return
    }

    const nextHistory = shouldPushHistory
      ? [...state.history, createHistorySnapshot(state)]
      : state.history

    const cached = !force ? artistPageCache.get(catalogArtistId) ?? null : null

    set({
      view: 'artist',
      history: nextHistory,
      canGoBack: nextHistory.length > 0,
      currentArtist: cached,
      currentAlbum: null,
      pendingArtistId: catalogArtistId,
      pendingAlbumId: null,
      artistSectionLoading: createArtistSectionLoading(!cached),
      albumSectionLoading: createAlbumSectionLoading(false),
      isLoading: !cached,
      error: null,
    })
    try {
      const artist = await window.puros.catalog.getArtistPreview(catalogArtistId)
      if (get().pendingArtistId !== catalogArtistId) return
      if (!artist) {
        set({
          pendingArtistId: null,
          pendingAlbumId: null,
          artistSectionLoading: createArtistSectionLoading(false),
          isLoading: false,
          error: 'Failed to load artist',
        })
        return
      }

      const hydratedArtist = cached
        ? { ...cached, ...artist, topTracks: cached.topTracks, releases: cached.releases, playlists: cached.playlists, relatedArtists: cached.relatedArtists, localAlbums: cached.localAlbums, appearsOn: cached.appearsOn }
        : artist
      set({
        currentArtist: hydratedArtist,
        currentAlbum: null,
        view: 'artist',
        pendingArtistId: null,
        pendingAlbumId: null,
        isLoading: false,
      })
      rememberArtistPage(hydratedArtist)

      const artistId = artist.id

      const refreshArtistHeader = async () => {
        const refreshed = await window.puros.catalog.getArtistPreview(artistId)
        if (!refreshed) return
        set((state) => {
          if (state.view !== 'artist' || state.currentArtist?.id !== artistId) return state
          const next = {
            ...state.currentArtist,
            ...refreshed,
            topTracks: state.currentArtist.topTracks,
            releases: state.currentArtist.releases,
            playlists: state.currentArtist.playlists,
            relatedArtists: state.currentArtist.relatedArtists,
            localAlbums: state.currentArtist.localAlbums,
          }
          rememberArtistPage(next)
          return { currentArtist: next }
        })
      }

      void window.puros.catalog.getArtistTopTracks(artistId)
        .then((topTracks) => {
          set((state) => {
            if (state.view !== 'artist' || state.currentArtist?.id !== artistId) return state
            const next = { ...state.currentArtist, topTracks }
            rememberArtistPage(next)
            return {
              currentArtist: next,
              artistSectionLoading: { ...state.artistSectionLoading, topTracks: false },
            }
          })
        })
        .catch(() => {
          set((state) => ({
            artistSectionLoading: { ...state.artistSectionLoading, topTracks: false },
          }))
        })

      void window.puros.catalog.getArtistReleases(artistId)
        .then(async (releases) => {
          set((state) => {
            if (state.view !== 'artist' || state.currentArtist?.id !== artistId) return state
            const next = {
              ...state.currentArtist,
              releases,
              localAlbums: releases.filter((album) => album.availability.availableProviderIds.includes('local')),
              albumCount: releases.length,
            }
            rememberArtistPage(next)
            return {
              currentArtist: next,
              artistSectionLoading: { ...state.artistSectionLoading, releases: false },
            }
          })
          await refreshArtistHeader()
        })
        .catch(() => {
          set((state) => ({
            artistSectionLoading: { ...state.artistSectionLoading, releases: false },
          }))
        })

      void window.puros.catalog.getArtistRelated(artistId)
        .then((relatedArtists) => {
          set((state) => {
            if (state.view !== 'artist' || state.currentArtist?.id !== artistId) return state
            const next = { ...state.currentArtist, relatedArtists }
            rememberArtistPage(next)
            return {
              currentArtist: next,
              artistSectionLoading: { ...state.artistSectionLoading, relatedArtists: false },
            }
          })
        })
        .catch(() => {
          set((state) => ({
            artistSectionLoading: { ...state.artistSectionLoading, relatedArtists: false },
          }))
        })

      void window.puros.catalog.getArtistPlaylists(artistId)
        .then(async (playlists) => {
          set((state) => {
            if (state.view !== 'artist' || state.currentArtist?.id !== artistId) return state
            const next = { ...state.currentArtist, playlists }
            rememberArtistPage(next)
            return {
              currentArtist: next,
              artistSectionLoading: { ...state.artistSectionLoading, playlists: false },
            }
          })
          await refreshArtistHeader()
        })
        .catch(() => {
          set((state) => ({
            artistSectionLoading: { ...state.artistSectionLoading, playlists: false },
          }))
        })
    } catch (error) {
      if (get().pendingArtistId !== catalogArtistId) return
      set({
        pendingArtistId: null,
        pendingAlbumId: null,
        artistSectionLoading: createArtistSectionLoading(false),
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load artist',
      })
    }
  },

  openAlbum: async (catalogAlbumId, options) => {
    const ref = parseSourceEntityId(catalogAlbumId)
    if (ref && ref.providerId !== get().activeProviderId) get().setProvider(ref.providerId, { browse: false })
    invalidateSearchRequests()
    const state = get()
    const force = !!options?.force
    const shouldPushHistory = options?.pushHistory ?? true
    const artistContext = options?.artistContext ?? null
    if (
      !force &&
      state.view === 'album' &&
      (state.currentAlbum?.id === catalogAlbumId || state.pendingAlbumId === catalogAlbumId)
    ) {
      return
    }

    const nextHistory = shouldPushHistory
      ? [...state.history, createHistorySnapshot(state)]
      : state.history

    const cachedAlbum = !force ? albumPageCache.get(catalogAlbumId) ?? null : null

    set({
      view: 'album',
      history: nextHistory,
      canGoBack: nextHistory.length > 0,
      currentAlbum: cachedAlbum ? applyArtistContextToAlbum(cachedAlbum, artistContext) : null,
      currentArtist: null,
      pendingArtistId: null,
      pendingAlbumId: catalogAlbumId,
      artistSectionLoading: createArtistSectionLoading(false),
      albumSectionLoading: createAlbumSectionLoading(!cachedAlbum),
      isLoading: !cachedAlbum,
      error: null,
    })
    try {
      const album = await window.puros.catalog.getAlbumPreview(catalogAlbumId)
      if (get().pendingAlbumId !== catalogAlbumId) return
      if (!album) {
        set({
          pendingArtistId: null,
          pendingAlbumId: null,
          albumSectionLoading: createAlbumSectionLoading(false),
          isLoading: false,
          error: 'Failed to load album',
        })
        return
      }

      const patchedAlbum = applyArtistContextToAlbum(album, artistContext)
      const hydratedAlbum = cachedAlbum
        ? { ...cachedAlbum, ...patchedAlbum, tracks: cachedAlbum.tracks }
        : patchedAlbum

      set({
        currentAlbum: hydratedAlbum,
        currentArtist: null,
        view: 'album',
        pendingArtistId: null,
        pendingAlbumId: null,
        isLoading: false,
      })
      rememberAlbumPage(hydratedAlbum)

      const albumId = album.id
      void window.puros.catalog.getAlbumTracks(albumId)
        .then((tracks) => {
          set((state) => {
            if (state.view !== 'album' || state.currentAlbum?.id !== albumId) return state
            const next = { ...state.currentAlbum, tracks }
            rememberAlbumPage(next)
            return {
              currentAlbum: next,
              albumSectionLoading: { ...state.albumSectionLoading, tracks: false },
            }
          })
        })
        .catch(() => {
          set((state) => ({
            albumSectionLoading: { ...state.albumSectionLoading, tracks: false },
          }))
        })
    } catch (error) {
      if (get().pendingAlbumId !== catalogAlbumId) return
      set({
        pendingArtistId: null,
        pendingAlbumId: null,
        albumSectionLoading: createAlbumSectionLoading(false),
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load album',
      })
    }
  },

  goHome: () => {
    invalidateSearchRequests()
    set({
      view: 'search',
      history: [],
      canGoBack: false,
      future: [],
      canGoForward: false,
      currentArtist: null,
      currentAlbum: null,
      pendingArtistId: null,
      pendingAlbumId: null,
      artistSectionLoading: createArtistSectionLoading(false),
      albumSectionLoading: createAlbumSectionLoading(false),
      error: null,
    })
    if (get().query.trim()) {
      void get().search(get().query)
    } else {
      void get().browse()
    }
  },

  resetToDefault: () => {
    invalidateSearchRequests()
    set({
      view: 'search',
      query: '',
      results: emptyResults(),
      history: [],
      canGoBack: false,
      future: [],
      canGoForward: false,
      currentArtist: null,
      currentAlbum: null,
      pendingArtistId: null,
      pendingAlbumId: null,
      artistSectionLoading: createArtistSectionLoading(false),
      albumSectionLoading: createAlbumSectionLoading(false),
      isLoading: true,
      error: null,
    })
    void get().browse()
  },

  goBack: () => {
    invalidateSearchRequests()
    const state = get()
    const previous = state.history[state.history.length - 1]
    if (!previous) return
    const nextHistory = state.history.slice(0, -1)
    const nextFuture = [...state.future, createHistorySnapshot(state)]
    try { localStorage.setItem('catalog:activeProvider', previous.activeProviderId) } catch { /* unavailable storage */ }
    set({
      ...previous,
      history: nextHistory,
      canGoBack: nextHistory.length > 0,
      future: nextFuture,
      canGoForward: true,
    })
  },

  goForward: () => {
    invalidateSearchRequests()
    const state = get()
    const next = state.future[state.future.length - 1]
    if (!next) return
    const nextFuture = state.future.slice(0, -1)
    const nextHistory = [...state.history, createHistorySnapshot(state)]
    try { localStorage.setItem('catalog:activeProvider', next.activeProviderId) } catch { /* unavailable storage */ }
    set({
      ...next,
      history: nextHistory,
      canGoBack: true,
      future: nextFuture,
      canGoForward: nextFuture.length > 0,
    })
  },

  clearForward: () => {
    if (get().future.length > 0) set({ future: [], canGoForward: false })
  },

  clearHistory: () => {
    set({
      history: [],
      canGoBack: false,
      future: [],
      canGoForward: false,
    })
  },

  refreshCurrent: async () => {
    const { view, currentArtist, currentAlbum, query } = get()
    if (view === 'artist' && currentArtist) {
      await get().openArtist(currentArtist.id, { force: true })
      return
    }
    if (view === 'album' && currentAlbum) {
      await get().openAlbum(currentAlbum.id, { force: true })
      return
    }
    if (query.trim()) {
      await get().search(query)
      return
    }
    await get().browse()
  },

  // Merges updated header data without clearing sections or showing a loading state.
  // Used by background enrichment notifications (catalog:changed) so the page doesn't flash.
  silentRefreshCurrent: async () => {
    const { view, currentArtist, currentAlbum } = get()
    if (view === 'artist' && currentArtist) {
      const artistId = currentArtist.id
      try {
        const [refreshed, topTracks, releases, relatedArtists, playlists] = await Promise.all([
          window.puros.catalog.getArtistPreview(artistId),
          window.puros.catalog.getArtistTopTracks(artistId).catch(() => null),
          window.puros.catalog.getArtistReleases(artistId).catch(() => null),
          window.puros.catalog.getArtistRelated(artistId).catch(() => null),
          window.puros.catalog.getArtistPlaylists(artistId).catch(() => null),
        ])
        if (!refreshed) return
        set((state) => {
          if (state.view !== 'artist' || state.currentArtist?.id !== artistId) return state
          const nextReleases = releases ?? state.currentArtist.releases
          const next = {
            ...state.currentArtist,
            ...refreshed,
            topTracks: topTracks ?? state.currentArtist.topTracks,
            releases: nextReleases,
            playlists: playlists ?? state.currentArtist.playlists,
            relatedArtists: relatedArtists ?? state.currentArtist.relatedArtists,
            localAlbums: releases ? releases.filter((album) => album.availability.availableProviderIds.includes('local')) : state.currentArtist.localAlbums,
            appearsOn: state.currentArtist.appearsOn,
            credits: state.currentArtist.credits,
            roleSummary: state.currentArtist.roleSummary,
            collaborators: state.currentArtist.collaborators,
          }
          rememberArtistPage(next)
          return { currentArtist: next }
        })
      } catch { /* best effort */ }
      return
    }
    if (view === 'album' && currentAlbum) {
      const albumId = currentAlbum.id
      try {
        const [refreshed, tracks] = await Promise.all([
          window.puros.catalog.getAlbumPreview(albumId),
          window.puros.catalog.getAlbumTracks(albumId).catch(() => null),
        ])
        if (!refreshed) return
        set((state) => {
          if (state.view !== 'album' || state.currentAlbum?.id !== albumId) return state
          const knownArtistName = state.currentAlbum.artistCreditName ?? state.currentAlbum.primaryArtistName
          const refreshedArtistName = refreshed.artistCreditName ?? refreshed.primaryArtistName
          const next = {
            ...state.currentAlbum,
            ...refreshed,
            // Don't downgrade a known artist name to Unknown Artist on silent refresh
            primaryArtistId: refreshed.primaryArtistId ?? state.currentAlbum.primaryArtistId,
            primaryArtistName: (!isPlaceholderArtistName(knownArtistName) && isPlaceholderArtistName(refreshedArtistName))
              ? state.currentAlbum.primaryArtistName
              : refreshed.primaryArtistName,
            artistCreditName: (!isPlaceholderArtistName(knownArtistName) && isPlaceholderArtistName(refreshedArtistName))
              ? state.currentAlbum.artistCreditName
              : refreshed.artistCreditName,
            tracks: tracks ?? state.currentAlbum.tracks,
          }
          rememberAlbumPage(next)
          return { currentAlbum: next }
        })
      } catch { /* best effort */ }
    }
  },

  addToLibrary: async (entityType, catalogId, preferredProvider) => {
    const result = await window.puros.catalog.addToLibrary(entityType, catalogId, preferredProvider ?? null)
    if (result.success) {
      await get().refreshCurrent()
    }
    return result.success
  },

  playTrack: async (track, preferredProvider) => {
    const requestId = ++playbackQueueRequestSequence
    const playbackContext = getPlaybackContextForCatalogState(get())
    const resolved = await resolveCatalogTrack(track, preferredProvider)
    if (!resolved || requestId !== playbackQueueRequestSequence) return
    usePlayerStore.getState().setQueue([resolved], 0, playbackContext)
  },

  playTracks: async (tracks, startIndex = 0) => {
    if (tracks.length === 0) return
    ++playbackQueueRequestSequence

    // Fully lazy: build the whole queue as lightweight, directly-playable
    // entries with ZERO resolution. Only the track that becomes current is
    // resolved (by AudioService, just-in-time) for its real source, artwork and
    // format — so clicking one song in a playlist does no work for the others.
    const playbackContext = getPlaybackContextForCatalogState(get())
    const requested = tracks[Math.max(0, Math.min(startIndex, tracks.length - 1))]
    if (!requested?.availability.playable) { usePlayerStore.getState().setNotification('This track is unavailable from its provider'); return }
    const playable = tracks.filter(track => track.availability.playable)
    const queue = playable.map(catalogSummaryToQueueTrack)
    const safeStartIndex = playable.findIndex(track => track.id === requested.id)
    if (playable.length !== tracks.length) usePlayerStore.getState().setNotification(`Skipped ${tracks.length - playable.length} unavailable tracks`)
    usePlayerStore.getState().setQueue(queue, safeStartIndex, playbackContext)
  },

  addTrackToQueue: async (track, preferredProvider) => {
    const playbackContext = getPlaybackContextForCatalogState(get())
    const resolved = await resolveCatalogTrack(track, preferredProvider)
    if (!resolved) return
    const player = usePlayerStore.getState()
    player.addToQueue(withCatalogPlaybackContext(resolved, playbackContext))
    player.setNotification(`Added to queue: ${resolved.title}`)
  },

  addTracksToQueue: async (tracks, preferredProvider) => {
    const playbackContext = getPlaybackContextForCatalogState(get())
    const resolvedTracks = await Promise.all(
      tracks.map((track) => resolveCatalogTrack(track, preferredProvider)),
    )
    const queue = resolvedTracks.filter((track): track is Track => !!track)
    if (!queue.length) return

    const player = usePlayerStore.getState()
    queue.forEach((track) => player.addToQueue(withCatalogPlaybackContext(track, playbackContext)))
    player.setNotification(`Added ${queue.length} ${queue.length === 1 ? 'track' : 'tracks'} to queue`)
  },

  addAlbumToQueue: async (catalogAlbumId, preferredProvider) => {
    const [albumPreview, tracks] = await Promise.all([
      window.puros.catalog.getAlbumPreview(catalogAlbumId).catch(() => null),
      window.puros.catalog.getAlbumTracks(catalogAlbumId),
    ])
    if (!tracks.length) return

    const resolvedTracks = await Promise.all(
      tracks.map((track) => resolveCatalogTrack(track, preferredProvider)),
    )
    const queue = resolvedTracks.filter((track): track is Track => !!track)
    if (!queue.length) return

    const playbackContext: PlaybackContext = {
      kind: 'album',
      label: albumPreview?.title || get().currentAlbum?.title || 'Album',
      catalogAlbumId,
    }
    const player = usePlayerStore.getState()
    queue.forEach((track) => player.addToQueue(withCatalogPlaybackContext(track, playbackContext)))
    player.setNotification(`Added album to queue: ${playbackContext.label}`)
  },
}))
