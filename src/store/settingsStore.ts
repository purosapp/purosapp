import { create } from 'zustand'
import type {
  CatalogAlbumArtworkProvider,
  CatalogArtistArtworkProvider,
  CatalogBioProvider,
  CatalogLocalCreditGuidanceMode,
} from '../services/catalog/types'
import type { StreamingPlaybackMode } from '../services/playback/types'
import { DEFAULT_ACCENT, parseAccentSetting, type AccentSetting } from '../utils/accentColor'
import {
  DEFAULT_NOW_PLAYING_TABS,
  NOW_PLAYING_TABS_SETTING_KEY,
  parseNowPlayingTabs,
  type NowPlayingTabId,
  type NowPlayingTabs,
} from '../services/nowPlayingTabs'

// ---------------------------------------------------------------------------
// Player badge visibility
// ---------------------------------------------------------------------------

export interface PlayerTagSettings {
  format: boolean
  bitDepth: boolean
  sampleRate: boolean
  bitrate: boolean
  outputMode: boolean
  playbackDecision: boolean
  deviceName: boolean
  bluetooth: boolean
  streamingStatus: boolean
}

export const PLAYER_TAG_LABELS: Record<keyof PlayerTagSettings, string> = {
  format: 'Format (FLAC, MP3, DSD…)',
  bitDepth: 'Bit depth',
  sampleRate: 'Sample rate',
  bitrate: 'Bitrate',
  outputMode: 'Output mode (Exclusive / Shared)',
  playbackDecision: 'Playback quality (Bit-perfect / Resampled)',
  deviceName: 'Device name',
  bluetooth: 'Bluetooth codec',
  streamingStatus: 'Streaming status',
}

export type CatalogProviderPreference = string

export const ARTIST_BIO_SOURCE_LABELS: Record<CatalogBioProvider, string> = {
  wikipedia: 'Wikipedia (English)',
  'metal-archives': 'Metal Archives',
  none: 'Disabled',
}

export const ARTIST_ARTWORK_SOURCE_LABELS: Record<CatalogArtistArtworkProvider, string> = {
  wikipedia: 'Wikipedia',
  itunes: 'iTunes',
  none: 'Disabled',
}

export const ALBUM_ARTWORK_SOURCE_LABELS: Record<CatalogAlbumArtworkProvider, string> = {
  coverartarchive: 'Cover Art Archive',
  none: 'Disabled',
}

export const LOCAL_CREDIT_GUIDANCE_LABELS: Record<CatalogLocalCreditGuidanceMode, string> = {
  local_only: 'Local tags only',
  provider_when_matched: 'Use provider metadata when matched',
}

const DEFAULT_TAGS: PlayerTagSettings = {
  format: true,
  bitDepth: true,
  sampleRate: true,
  bitrate: false,
  outputMode: false,
  playbackDecision: false,
  deviceName: false,
  bluetooth: false,
  streamingStatus: false,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type DiscordArtworkUploadProvider = 'none' | 'cloudinary'
export type LyricsProviderId = 'lrclib' | 'musixmatch' | 'genius'
export type LyricsFontSize = 'small' | 'medium' | 'large'

export type ResumeRewindSeconds = 0 | 5 | 10

export interface LyricsProviderPreference {
  id: LyricsProviderId
  enabled: boolean
}

export const LYRICS_PROVIDER_LABELS: Record<LyricsProviderId, string> = {
  lrclib: 'LRCLIB',
  musixmatch: 'Musixmatch',
  genius: 'Genius',
}

const DEFAULT_LYRICS_PROVIDERS: LyricsProviderPreference[] = [
  { id: 'lrclib', enabled: true },
  { id: 'musixmatch', enabled: false },
  { id: 'genius', enabled: false },
]

const DEFAULT_LYRICS_API_KEYS: Record<Exclude<LyricsProviderId, 'lrclib'>, string> = {
  musixmatch: '',
  genius: '',
}

export type SeekBarStyle = 'bar' | 'waveform'

/** How the full-screen Now Playing view shows the cover: plain, or inside a 3D CD jewel case. */
export type NowPlayingArtworkStyle = 'flat' | 'jewelCase'

function normalizeResumeRewindSeconds(raw: unknown): ResumeRewindSeconds {
  const value = Number(raw)
  return value === 5 || value === 10 ? value : 0
}

interface SettingsState {
  playerTags: PlayerTagSettings
  /** Format/quality badges in the player bar. Off by default; the bar stays clean. */
  showPlayerBadges: boolean
  /** Plain progress bar, or a Roon-style waveform of the playing file. */
  seekBarStyle: SeekBarStyle
  /** App accent colour: follow macOS, one of its eight colours, or a custom hue. */
  accent: AccentSetting
  artistBioSourcePriority: CatalogBioProvider[]
  artistArtworkSourcePriority: CatalogArtistArtworkProvider[]
  albumArtworkSourcePriority: CatalogAlbumArtworkProvider[]
  catalogSourcePriority: CatalogProviderPreference[]
  showUnavailableSources: boolean
  localCreditGuidanceMode: CatalogLocalCreditGuidanceMode
  metadataMusicBrainzEnabled: boolean
  homeDisplayName: string
  /** Sidebar shows each provider's playlists and folders under a virtual provider folder. */
  groupPlaylistsByProvider: boolean
  discordRichPresenceEnabled: boolean
  discordArtworkUploadProvider: DiscordArtworkUploadProvider
  discordCloudinaryCloudName: string
  discordCloudinaryUploadPreset: string
  discordCloudinaryApiKey: string
  discordCloudinaryApiSecret: string
  streamingPlaybackMode: StreamingPlaybackMode
  streamingAudioCacheLimitGb: number
  endlessPlaybackEnabled: boolean
  /** Save the queue, current track and position, and put them back on the next launch. */
  rememberPlaybackSession: boolean
  /** Start the restored track right away instead of waiting paused. */
  resumePlaybackOnLaunch: boolean
  /** Seconds to step back when a restored track is started again. */
  resumeRewindSeconds: ResumeRewindSeconds
  /** Exclusive mode refuses any sample-rate conversion and reports an error instead. */
  strictSampleRate: boolean
  /** Which tabs the full-screen Now Playing view shows; none hides the tab column. */
  nowPlayingTabs: NowPlayingTabs
  lyricsProviderPriority: LyricsProviderPreference[]
  lyricsApiKeys: Record<Exclude<LyricsProviderId, 'lrclib'>, string>
  lyricsFontSize: LyricsFontSize
  dimAlbumArtWhenLyricsVisible: boolean
  nowPlayingArtworkStyle: NowPlayingArtworkStyle
  loaded: boolean
  load: () => Promise<void>
  setPlayerTag: (key: keyof PlayerTagSettings, value: boolean) => Promise<void>
  setShowPlayerBadges: (enabled: boolean) => Promise<void>
  setSeekBarStyle: (style: SeekBarStyle) => Promise<void>
  setAccent: (accent: AccentSetting) => Promise<void>
  setArtistBioSourcePriority: (priority: CatalogBioProvider[]) => Promise<void>
  setArtistArtworkSourcePriority: (priority: CatalogArtistArtworkProvider[]) => Promise<void>
  setAlbumArtworkSourcePriority: (priority: CatalogAlbumArtworkProvider[]) => Promise<void>
  setCatalogSourcePriority: (priority: CatalogProviderPreference[]) => Promise<void>
  setShowUnavailableSources: (show: boolean) => Promise<void>
  setLocalCreditGuidanceMode: (mode: CatalogLocalCreditGuidanceMode) => Promise<void>
  setMetadataMusicBrainzEnabled: (enabled: boolean) => Promise<void>
  setHomeDisplayName: (name: string) => Promise<void>
  setGroupPlaylistsByProvider: (enabled: boolean) => Promise<void>
  setDiscordRichPresenceEnabled: (enabled: boolean) => Promise<void>
  setDiscordArtworkUploadProvider: (provider: DiscordArtworkUploadProvider) => Promise<void>
  setDiscordCloudinaryCloudName: (cloudName: string) => Promise<void>
  setDiscordCloudinaryUploadPreset: (uploadPreset: string) => Promise<void>
  setDiscordCloudinaryApiKey: (apiKey: string) => Promise<void>
  setDiscordCloudinaryApiSecret: (apiSecret: string) => Promise<void>
  setStreamingPlaybackMode: (mode: StreamingPlaybackMode) => Promise<void>
  setStreamingAudioCacheLimitGb: (limitGb: number) => Promise<void>
  setEndlessPlaybackEnabled: (enabled: boolean) => Promise<void>
  setRememberPlaybackSession: (enabled: boolean) => Promise<void>
  setResumePlaybackOnLaunch: (enabled: boolean) => Promise<void>
  setResumeRewindSeconds: (seconds: ResumeRewindSeconds) => Promise<void>
  setStrictSampleRate: (enabled: boolean) => Promise<void>
  setNowPlayingTabEnabled: (tab: NowPlayingTabId, enabled: boolean) => Promise<void>
  setLyricsProviderPriority: (priority: LyricsProviderPreference[]) => Promise<void>
  setLyricsApiKey: (provider: Exclude<LyricsProviderId, 'lrclib'>, apiKey: string) => Promise<void>
  setLyricsFontSize: (size: LyricsFontSize) => Promise<void>
  setDimAlbumArtWhenLyricsVisible: (enabled: boolean) => Promise<void>
  setNowPlayingArtworkStyle: (style: NowPlayingArtworkStyle) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  playerTags: DEFAULT_TAGS,
  showPlayerBadges: false,
  seekBarStyle: 'bar',
  accent: DEFAULT_ACCENT,
  artistBioSourcePriority: ['wikipedia', 'none'],
  artistArtworkSourcePriority: ['wikipedia', 'itunes', 'none'],
  albumArtworkSourcePriority: ['coverartarchive', 'none'],
  catalogSourcePriority: ['local'],
  showUnavailableSources: false,
  localCreditGuidanceMode: 'provider_when_matched',
  metadataMusicBrainzEnabled: true,
  homeDisplayName: '',
  groupPlaylistsByProvider: false,
  discordRichPresenceEnabled: false,
  discordArtworkUploadProvider: 'none',
  discordCloudinaryCloudName: '',
  discordCloudinaryUploadPreset: '',
  discordCloudinaryApiKey: '',
  discordCloudinaryApiSecret: '',
  streamingPlaybackMode: 'progressive-cache',
  streamingAudioCacheLimitGb: 10,
  endlessPlaybackEnabled: true,
  rememberPlaybackSession: true,
  resumePlaybackOnLaunch: false,
  resumeRewindSeconds: 0,
  strictSampleRate: false,
  nowPlayingTabs: DEFAULT_NOW_PLAYING_TABS,
  lyricsProviderPriority: DEFAULT_LYRICS_PROVIDERS,
  lyricsApiKeys: DEFAULT_LYRICS_API_KEYS,
  lyricsFontSize: 'medium',
  dimAlbumArtWhenLyricsVisible: true,
  nowPlayingArtworkStyle: 'jewelCase',
  loaded: false,

  load: async () => {
    const [
      rawTags,
      rawArtistBioSourcePriority,
      rawLegacyArtistBioSource,
      rawArtistArtworkSourcePriority,
      rawAlbumArtworkSourcePriority,
      rawCatalogSourcePriority,
      rawLocalCreditGuidanceMode,
      rawMetadataMusicBrainzEnabled,
      rawHomeDisplayName,
      rawDiscordRichPresenceEnabled,
      rawDiscordArtworkUploadProvider,
      rawDiscordCloudinaryCloudName,
      rawDiscordCloudinaryUploadPreset,
      rawDiscordCloudinaryApiKey,
      rawDiscordCloudinaryApiSecret,
      rawStreamingPlaybackMode,
      rawStreamingAudioCacheLimitGb,
      rawEndlessPlaybackEnabled,
      rawStrictSampleRate,
      rawShowLyricsInNowPlaying,
      rawNowPlayingTabs,
      rawLyricsProviderPriority,
      rawLyricsMusixmatchApiKey,
      rawLyricsGeniusApiKey,
      rawLyricsFontSize,
      rawDimAlbumArtWhenLyricsVisible,
      rawShowUnavailableSources,
      rawGroupPlaylistsByProvider,
      rawRememberPlaybackSession,
      rawResumePlaybackOnLaunch,
      rawResumeRewindSeconds,
      rawSeekBarStyle,
      rawAccent,
      rawShowPlayerBadges,
      rawNowPlayingArtworkStyle,
      providerDescriptors,
    ] = await Promise.all([
      window.puros.settings.get('playerTags'),
      window.puros.settings.get('artistBioSourcePriority'),
      window.puros.settings.get('artistBioSource'),
      window.puros.settings.get('artistArtworkSourcePriority'),
      window.puros.settings.get('albumArtworkSourcePriority'),
      window.puros.settings.get('catalogSourcePriority'),
      window.puros.settings.get('localCreditGuidanceMode'),
      window.puros.settings.get('metadataMusicBrainzEnabled'),
      window.puros.settings.get('homeDisplayName'),
      window.puros.settings.get('discordRichPresenceEnabled'),
      window.puros.settings.get('discordArtworkUploadProvider'),
      window.puros.settings.get('discordCloudinaryCloudName'),
      window.puros.settings.get('discordCloudinaryUploadPreset'),
      window.puros.settings.get('discordCloudinaryApiKey'),
      window.puros.settings.get('discordCloudinaryApiSecret'),
      window.puros.settings.get('streamingPlaybackMode'),
      window.puros.settings.get('streamingAudioCacheLimitGb'),
      window.puros.settings.get('endlessPlaybackEnabled'),
      window.puros.settings.get('strictSampleRate'),
      window.puros.settings.get('lyricsShowInNowPlaying'),
      window.puros.settings.get(NOW_PLAYING_TABS_SETTING_KEY),
      window.puros.settings.get('lyricsProviderPriority'),
      window.puros.settings.get('lyricsMusixmatchApiKey'),
      window.puros.settings.get('lyricsGeniusApiKey'),
      window.puros.settings.get('lyricsFontSize'),
      window.puros.settings.get('lyricsDimAlbumArtWhenVisible'),
      window.puros.settings.get('showUnavailableSources'),
      window.puros.settings.get('groupPlaylistsByProvider'),
      window.puros.settings.get('playbackSessionRemember'),
      window.puros.settings.get('playbackSessionAutoplay'),
      window.puros.settings.get('playbackSessionRewindSeconds'),
      window.puros.settings.get('seekBarStyle'),
      window.puros.settings.get('accentColor'),
      window.puros.settings.get('showPlayerBadges'),
      window.puros.settings.get('nowPlayingArtworkStyle'),
      window.puros.provider.list().catch(() => []),
    ])

    if (rawTags) {
      try {
        const parsed = JSON.parse(rawTags) as Partial<PlayerTagSettings>
        set({ playerTags: { ...DEFAULT_TAGS, ...parsed } })
      } catch {
        /* fall through to defaults */
      }
    }

    const metadataProviderIds = (capability: 'metadata.bio' | 'metadata.artwork') => providerDescriptors
      .filter(({ manifest }) => manifest.capabilities.includes(capability))
      .sort((left, right) => left.manifest.defaultPriority - right.manifest.defaultPriority)
      .map(({ manifest }) => manifest.id)
    const bioDefaults: CatalogBioProvider[] = [...metadataProviderIds('metadata.bio'), 'wikipedia', 'metal-archives', 'none']
    const artistArtworkDefaults: CatalogArtistArtworkProvider[] = [...metadataProviderIds('metadata.artwork'), 'wikipedia', 'itunes', 'none']
    const albumArtworkDefaults: CatalogAlbumArtworkProvider[] = [...metadataProviderIds('metadata.artwork'), 'coverartarchive', 'none']
    const normalizePriority = <T extends string>(raw: unknown, defaults: T[]): T[] | null => {
      if (!Array.isArray(raw)) return null
      const allowed = new Set(defaults)
      const next = raw.filter((value): value is T => typeof value === 'string' && allowed.has(value as T))
      for (const source of defaults) if (!next.includes(source)) next.push(source)
      return [...new Set(next)]
    }

    const normalizeLyricsProviderPriority = (raw: unknown) => {
      if (!Array.isArray(raw)) return null

      const next: LyricsProviderPreference[] = []
      for (const entry of raw) {
        if (typeof entry === 'string') {
          if (entry === 'lrclib' || entry === 'musixmatch' || entry === 'genius') {
            next.push({ id: entry, enabled: entry === 'lrclib' })
          }
          continue
        }

        if (!entry || typeof entry !== 'object') continue
        const value = entry as { id?: unknown; enabled?: unknown }
        if (value.id !== 'lrclib' && value.id !== 'musixmatch' && value.id !== 'genius') continue
        next.push({
          id: value.id,
          enabled: value.enabled === undefined ? value.id === 'lrclib' : !!value.enabled,
        })
      }

      const deduped = next.filter((entry, index, array) =>
        array.findIndex((candidate) => candidate.id === entry.id) === index,
      )

      ;(['lrclib', 'musixmatch', 'genius'] as LyricsProviderId[]).forEach((provider) => {
        if (!deduped.some((entry) => entry.id === provider)) {
          deduped.push({
            id: provider,
            enabled: provider === 'lrclib',
          })
        }
      })

      return deduped
    }

    if (rawArtistBioSourcePriority) {
      try {
        const parsed = JSON.parse(rawArtistBioSourcePriority) as unknown
        const next = normalizePriority(parsed, bioDefaults)
        if (next) set({ artistBioSourcePriority: next })
      } catch {
        /* ignore malformed settings */
      }
    } else if (rawLegacyArtistBioSource === 'wikipedia' || rawLegacyArtistBioSource === 'none') {
      const next: CatalogBioProvider[] = rawLegacyArtistBioSource === 'none'
        ? ['none', ...bioDefaults.filter((source) => source !== 'none')]
        : ['wikipedia', ...bioDefaults.filter((source) => source !== 'wikipedia')]
      set({ artistBioSourcePriority: next })
    }

    if (rawArtistArtworkSourcePriority) {
      try {
        const parsed = JSON.parse(rawArtistArtworkSourcePriority) as unknown
        const next = normalizePriority(parsed, artistArtworkDefaults)
        if (next) set({ artistArtworkSourcePriority: next })
      } catch {
        /* ignore malformed settings */
      }
    }

    if (rawAlbumArtworkSourcePriority) {
      try {
        const parsed = JSON.parse(rawAlbumArtworkSourcePriority) as unknown
        const next = normalizePriority(parsed, albumArtworkDefaults)
        if (next) set({ albumArtworkSourcePriority: next })
      } catch {
        /* ignore malformed settings */
      }
    }

    const providerManifests = providerDescriptors
      .map(({ manifest }) => manifest)
      .sort((left, right) => left.defaultPriority - right.defaultPriority || left.id.localeCompare(right.id))
    const providerDefaults = providerManifests.map(({ id }) => id)
    const providerDefaultPriorities = new Map(providerManifests.map(({ id, defaultPriority }) => [id, defaultPriority]))
    const installedProviderIds = new Set(['local', ...providerDefaults])
    let catalogPriority: string[] = []
    if (rawCatalogSourcePriority) {
      try {
        const parsed = JSON.parse(rawCatalogSourcePriority) as unknown
        if (Array.isArray(parsed)) {
          catalogPriority = parsed.filter((value): value is string => (
            typeof value === 'string' && installedProviderIds.has(value)
          ))
        }
      } catch {
        /* ignore malformed settings */
      }
    }
    if (!catalogPriority.includes('local')) catalogPriority.unshift('local')
    for (const providerId of providerDefaults) {
      if (catalogPriority.includes(providerId)) continue
      const priority = providerDefaultPriorities.get(providerId) ?? Number.MAX_SAFE_INTEGER
      const insertionIndex = catalogPriority.findIndex((candidate) => (
        candidate !== 'local'
        && (providerDefaultPriorities.get(candidate) ?? Number.MAX_SAFE_INTEGER) > priority
      ))
      if (insertionIndex === -1) catalogPriority.push(providerId)
      else catalogPriority.splice(insertionIndex, 0, providerId)
    }
    set({ catalogSourcePriority: catalogPriority })

    if (rawLocalCreditGuidanceMode === 'local_only' || rawLocalCreditGuidanceMode === 'provider_when_matched') {
      set({ localCreditGuidanceMode: rawLocalCreditGuidanceMode === 'local_only' ? 'local_only' : 'provider_when_matched' })
    }

    if (rawMetadataMusicBrainzEnabled === 'true' || rawMetadataMusicBrainzEnabled === 'false') {
      set({ metadataMusicBrainzEnabled: rawMetadataMusicBrainzEnabled === 'true' })
    }

    if (typeof rawHomeDisplayName === 'string') {
      set({ homeDisplayName: rawHomeDisplayName })
    }

    set({
      discordRichPresenceEnabled: rawDiscordRichPresenceEnabled === 'true',
      discordArtworkUploadProvider: rawDiscordArtworkUploadProvider === 'cloudinary' ? 'cloudinary' : 'none',
      discordCloudinaryCloudName: typeof rawDiscordCloudinaryCloudName === 'string' ? rawDiscordCloudinaryCloudName : '',
      discordCloudinaryUploadPreset: typeof rawDiscordCloudinaryUploadPreset === 'string' ? rawDiscordCloudinaryUploadPreset : '',
      discordCloudinaryApiKey: typeof rawDiscordCloudinaryApiKey === 'string' ? rawDiscordCloudinaryApiKey : '',
      discordCloudinaryApiSecret: typeof rawDiscordCloudinaryApiSecret === 'string' ? rawDiscordCloudinaryApiSecret : '',
      streamingPlaybackMode: rawStreamingPlaybackMode === 'download-first'
        ? 'download-first'
        : 'progressive-cache',
      streamingAudioCacheLimitGb: Number.isFinite(Number(rawStreamingAudioCacheLimitGb))
        ? Math.max(1, Math.min(500, Number(rawStreamingAudioCacheLimitGb)))
        : 10,
      endlessPlaybackEnabled: rawEndlessPlaybackEnabled !== 'false',
      rememberPlaybackSession: rawRememberPlaybackSession !== 'false',
      resumePlaybackOnLaunch: rawResumePlaybackOnLaunch === 'true',
      resumeRewindSeconds: normalizeResumeRewindSeconds(rawResumeRewindSeconds),
      strictSampleRate: rawStrictSampleRate === 'true',
      nowPlayingTabs: parseNowPlayingTabs(rawNowPlayingTabs, rawShowLyricsInNowPlaying),
      lyricsApiKeys: {
        musixmatch: typeof rawLyricsMusixmatchApiKey === 'string' ? rawLyricsMusixmatchApiKey : '',
        genius: typeof rawLyricsGeniusApiKey === 'string' ? rawLyricsGeniusApiKey : '',
      },
      lyricsFontSize: rawLyricsFontSize === 'small' || rawLyricsFontSize === 'large'
        ? rawLyricsFontSize
        : 'medium',
      dimAlbumArtWhenLyricsVisible: rawDimAlbumArtWhenLyricsVisible !== 'false',
      nowPlayingArtworkStyle: rawNowPlayingArtworkStyle === 'flat' ? 'flat' : 'jewelCase',
      showUnavailableSources: rawShowUnavailableSources === 'true',
      groupPlaylistsByProvider: rawGroupPlaylistsByProvider === 'true',
      seekBarStyle: rawSeekBarStyle === 'waveform' ? 'waveform' : 'bar',
      showPlayerBadges: rawShowPlayerBadges === 'true',
      accent: parseAccentSetting(rawAccent),
    })

    if (rawLyricsProviderPriority) {
      try {
        const parsed = JSON.parse(rawLyricsProviderPriority) as unknown
        const next = normalizeLyricsProviderPriority(parsed)
        if (next) set({ lyricsProviderPriority: next })
      } catch {
        /* ignore malformed settings */
      }
    }

    set({ loaded: true })
  },

  setPlayerTag: async (key, value) => {
    const next = { ...get().playerTags, [key]: value }
    set({ playerTags: next })
    await window.puros.settings.set('playerTags', JSON.stringify(next))
  },

  setShowPlayerBadges: async (enabled) => {
    set({ showPlayerBadges: enabled })
    await window.puros.settings.set('showPlayerBadges', enabled ? 'true' : 'false')
  },

  setSeekBarStyle: async (style) => {
    const next: SeekBarStyle = style === 'waveform' ? 'waveform' : 'bar'
    set({ seekBarStyle: next })
    await window.puros.settings.set('seekBarStyle', next)
  },

  setAccent: async (accent) => {
    set({ accent })
    await window.puros.settings.set('accentColor', JSON.stringify(accent))
  },

  setArtistBioSourcePriority: async (priority) => {
    const descriptors = await window.puros.provider.list().catch(() => [])
    const defaults: CatalogBioProvider[] = [
      ...descriptors.filter(({ manifest }) => manifest.capabilities.includes('metadata.bio')).map(({ manifest }) => manifest.id),
      'wikipedia', 'metal-archives', 'none',
    ]
    const allowed = new Set(defaults)
    const deduped = [...new Set(priority)].filter((value) => allowed.has(value))
    for (const source of defaults) if (!deduped.includes(source)) deduped.push(source)
    set({ artistBioSourcePriority: deduped })
    await window.puros.settings.set('artistBioSourcePriority', JSON.stringify(deduped))
  },

  setArtistArtworkSourcePriority: async (priority) => {
    const descriptors = await window.puros.provider.list().catch(() => [])
    const defaults: CatalogArtistArtworkProvider[] = [
      ...descriptors.filter(({ manifest }) => manifest.capabilities.includes('metadata.artwork')).map(({ manifest }) => manifest.id),
      'wikipedia', 'itunes', 'none',
    ]
    const allowed = new Set(defaults)
    const deduped = [...new Set(priority)].filter((value) => allowed.has(value))
    for (const source of defaults) if (!deduped.includes(source)) deduped.push(source)
    set({ artistArtworkSourcePriority: deduped })
    await window.puros.settings.set('artistArtworkSourcePriority', JSON.stringify(deduped))
  },

  setAlbumArtworkSourcePriority: async (priority) => {
    const descriptors = await window.puros.provider.list().catch(() => [])
    const defaults: CatalogAlbumArtworkProvider[] = [
      ...descriptors.filter(({ manifest }) => manifest.capabilities.includes('metadata.artwork')).map(({ manifest }) => manifest.id),
      'coverartarchive', 'none',
    ]
    const allowed = new Set(defaults)
    const deduped = [...new Set(priority)].filter((value) => allowed.has(value))
    for (const source of defaults) if (!deduped.includes(source)) deduped.push(source)
    set({ albumArtworkSourcePriority: deduped })
    await window.puros.settings.set('albumArtworkSourcePriority', JSON.stringify(deduped))
  },

  setCatalogSourcePriority: async (priority) => {
    const descriptors = await window.puros.provider.list().catch(() => [])
    const installed = new Set(['local', ...descriptors.map(({ manifest }) => manifest.id)])
    const deduped = [...new Set(priority)].filter((value) => installed.has(value))
    if (!deduped.includes('local')) deduped.unshift('local')
    const persisted = await window.puros.settings.get('catalogSourcePriority')
    let unknown: string[] = []
    if (persisted) {
      try {
        const parsed = JSON.parse(persisted) as unknown
        if (Array.isArray(parsed)) {
          unknown = parsed.filter((value): value is string => (
            typeof value === 'string' && !installed.has(value)
          ))
        }
      } catch {
        // Replace malformed bytes with the validated priority below.
      }
    }
    set({ catalogSourcePriority: deduped })
    await window.puros.settings.set('catalogSourcePriority', JSON.stringify([...deduped, ...new Set(unknown)]))
  },

  setShowUnavailableSources: async (show) => {
    set({ showUnavailableSources: show })
    await window.puros.settings.set('showUnavailableSources', show ? 'true' : 'false')
  },

  setLocalCreditGuidanceMode: async (mode) => {
    const next: CatalogLocalCreditGuidanceMode = mode === 'local_only' ? 'local_only' : 'provider_when_matched'
    set({ localCreditGuidanceMode: next })
    await window.puros.settings.set('localCreditGuidanceMode', next)
  },

  setMetadataMusicBrainzEnabled: async (enabled) => {
    set({ metadataMusicBrainzEnabled: enabled })
    await window.puros.settings.set('metadataMusicBrainzEnabled', enabled ? 'true' : 'false')
  },

  setHomeDisplayName: async (name) => {
    const next = name.trim()
    set({ homeDisplayName: next })
    await window.puros.settings.set('homeDisplayName', next)
  },

  setGroupPlaylistsByProvider: async (enabled) => {
    set({ groupPlaylistsByProvider: enabled })
    await window.puros.settings.set('groupPlaylistsByProvider', enabled ? 'true' : 'false')
  },

  setDiscordRichPresenceEnabled: async (enabled) => {
    set({ discordRichPresenceEnabled: enabled })
    await window.puros.settings.set('discordRichPresenceEnabled', enabled ? 'true' : 'false')
  },

  setDiscordArtworkUploadProvider: async (provider) => {
    const next = provider === 'cloudinary' ? 'cloudinary' : 'none'
    set({ discordArtworkUploadProvider: next })
    await window.puros.settings.set('discordArtworkUploadProvider', next)
  },

  setDiscordCloudinaryCloudName: async (cloudName) => {
    const next = cloudName.trim()
    set({ discordCloudinaryCloudName: next })
    await window.puros.settings.set('discordCloudinaryCloudName', next)
  },

  setDiscordCloudinaryUploadPreset: async (uploadPreset) => {
    const next = uploadPreset.trim()
    set({ discordCloudinaryUploadPreset: next })
    await window.puros.settings.set('discordCloudinaryUploadPreset', next)
  },

  setDiscordCloudinaryApiKey: async (apiKey) => {
    const next = apiKey.trim()
    set({ discordCloudinaryApiKey: next })
    await window.puros.settings.set('discordCloudinaryApiKey', next)
  },

  setDiscordCloudinaryApiSecret: async (apiSecret) => {
    const next = apiSecret.trim()
    set({ discordCloudinaryApiSecret: next })
    await window.puros.settings.set('discordCloudinaryApiSecret', next)
  },

  setStreamingPlaybackMode: async (mode) => {
    const next: StreamingPlaybackMode = mode === 'download-first'
      ? 'download-first'
      : 'progressive-cache'
    set({ streamingPlaybackMode: next })
    await window.puros.settings.set('streamingPlaybackMode', next)
  },

  setStreamingAudioCacheLimitGb: async (limitGb) => {
    const next = Math.max(1, Math.min(500, Number.isFinite(limitGb) ? limitGb : 10))
    set({ streamingAudioCacheLimitGb: next })
    await window.puros.settings.set('streamingAudioCacheLimitGb', String(next))
  },

  setEndlessPlaybackEnabled: async (enabled) => {
    set({ endlessPlaybackEnabled: enabled })
    await window.puros.settings.set('endlessPlaybackEnabled', enabled ? 'true' : 'false')
  },

  setRememberPlaybackSession: async (enabled) => {
    set({ rememberPlaybackSession: enabled })
    await window.puros.settings.set('playbackSessionRemember', enabled ? 'true' : 'false')
  },

  setResumePlaybackOnLaunch: async (enabled) => {
    set({ resumePlaybackOnLaunch: enabled })
    await window.puros.settings.set('playbackSessionAutoplay', enabled ? 'true' : 'false')
  },

  setResumeRewindSeconds: async (seconds) => {
    const next = normalizeResumeRewindSeconds(seconds)
    set({ resumeRewindSeconds: next })
    await window.puros.settings.set('playbackSessionRewindSeconds', String(next))
  },

  setStrictSampleRate: async (enabled) => {
    set({ strictSampleRate: enabled })
    await window.puros.settings.set('strictSampleRate', enabled ? 'true' : 'false')
  },

  setNowPlayingTabEnabled: async (tab, enabled) => {
    const next = { ...get().nowPlayingTabs, [tab]: enabled }
    set({ nowPlayingTabs: next })
    // Off means off: a detached visualizer window would keep rendering otherwise.
    if (tab === 'visualizer' && !enabled) void window.puros.app.closeVisualizerWindow()
    await window.puros.settings.set(NOW_PLAYING_TABS_SETTING_KEY, JSON.stringify(next))
  },

  setLyricsProviderPriority: async (priority) => {
    const next = [...priority]
      .filter((entry): entry is LyricsProviderPreference =>
        !!entry && (entry.id === 'lrclib' || entry.id === 'musixmatch' || entry.id === 'genius'),
      )
      .filter((entry, index, array) => array.findIndex((candidate) => candidate.id === entry.id) === index)

    ;(['lrclib', 'musixmatch', 'genius'] as LyricsProviderId[]).forEach((provider) => {
      if (!next.some((entry) => entry.id === provider)) {
        next.push({
          id: provider,
          enabled: provider === 'lrclib',
        })
      }
    })

    set({ lyricsProviderPriority: next })
    await window.puros.settings.set('lyricsProviderPriority', JSON.stringify(next))
  },

  setLyricsApiKey: async (provider, apiKey) => {
    const next = apiKey.trim()
    set((state) => ({
      lyricsApiKeys: {
        ...state.lyricsApiKeys,
        [provider]: next,
      },
    }))
    await window.puros.settings.set(
      provider === 'musixmatch' ? 'lyricsMusixmatchApiKey' : 'lyricsGeniusApiKey',
      next,
    )
  },

  setLyricsFontSize: async (size) => {
    const next: LyricsFontSize = size === 'small' || size === 'large' ? size : 'medium'
    set({ lyricsFontSize: next })
    await window.puros.settings.set('lyricsFontSize', next)
  },

  setDimAlbumArtWhenLyricsVisible: async (enabled) => {
    set({ dimAlbumArtWhenLyricsVisible: enabled })
    await window.puros.settings.set('lyricsDimAlbumArtWhenVisible', enabled ? 'true' : 'false')
  },

  setNowPlayingArtworkStyle: async (style) => {
    const next: NowPlayingArtworkStyle = style === 'flat' ? 'flat' : 'jewelCase'
    set({ nowPlayingArtworkStyle: next })
    await window.puros.settings.set('nowPlayingArtworkStyle', next)
  },

}))
