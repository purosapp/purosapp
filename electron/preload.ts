import { ipcRenderer, contextBridge, webFrame } from 'electron'
import type { FormatInfo } from '../src/services/local/formats'
import type { AudioPlugin, AudioPluginParameter, InstalledAudioPlugin } from '../src/types/plugins'
import type { HomeProviderCollectionBundle, HomeProviderShelf } from '../src/services/homeProviderShelves'
import type { LastFmMethod } from '../src/services/lastfm/types'
import type {
  LyricsProviderFetchRequest,
  LyricsProviderFetchResult,
  LyricsProviderId,
  LyricsProviderTestResult,
} from '../src/renderer/components/NowPlaying/LyricsProviderService'
import type {
  LiveRadioBrowseOptions,
  LiveRadioDirectoryFilters,
  LiveRadioNowPlayingMetadata,
  LiveRadioPlaybackStatus,
  LiveRadioProbeResult,
  Station,
} from '../src/services/liveRadio/types'
import type {
  CatalogAlbumPage,
  CatalogAlbumSummary,
  CatalogArtistPage,
  CatalogArtistSummary,
  CatalogEntityType,
  CatalogGenreSummary,
  CatalogPlaylistSummary,
  CatalogProviderName,
  CatalogResolvedPlaybackTrack,
  CatalogSearchResults,
  CatalogTrackSummary,
} from '../src/services/catalog/types'
import type {
  ProviderCapabilityV1,
  ProviderDescriptorV1,
  ProviderEventEnvelopeV1,
  ProviderResultV1,
  ProviderStatusV1,
  ProviderPrimitiveV1,
  ProviderValueV1,
} from '../src/provider-api/v1'
import type { InstalledProviderPackageInfo, PackageIpcResult } from './main/providers/packages/ipc'
import type { RetainedProviderData } from './main/providers/config'
import type { PackageInspectionSummary } from './main/providers/packages/installer'
import type { InstallOutcome } from './main/providers/packages/service'
import type { PackageTrustWarning } from './main/providers/packages/trust'

// ---------------------------------------------------------------------------
// Typed API exposed to the renderer process via contextBridge
// ---------------------------------------------------------------------------

export interface SupportedFormat {
  sampleRate: number
  bitDepth: number
  isFloat: boolean
  channels: number
}

export interface AudioDevice {
  id: string
  name: string
  uid: string
  routeParentUid?: string
  routeDataSourceId?: number
  isRouteEndpoint?: boolean
  isCurrentRoute?: boolean
  channels: number
  sampleRate: number
  transportType: number
  dopCapability?: 'DoP64' | 'DoP128' | 'DoP256' | 'FallbackPCM'
  hardwareVolume?: boolean
  supportedFormats: SupportedFormat[]
  sampleRates: number[]
  bitDepths: number[]
  // Virtual "__default__" entry fields
  isVirtual?: boolean
  isDefault?: boolean
  resolvedName?: string   // physical device name currently used as system default
  resolvedUid?: string    // UID of the physical device currently used as system default
}

import type {
  FirPreview,
  ImpulseResponseInspection,
  NativeFirDesign,
  NativeResamplerConfig,
  ResamplerStatus,
} from '../src/services/resamplingSettings'

export type { FirPreview, ImpulseResponseInspection, NativeFirDesign, NativeResamplerConfig, ResamplerStatus }

import type { NativeRestoreConfig, RestoreSourceHint, RestoreStatus } from '../src/services/restoreSettings'
import type { DockMenuState } from '../src/services/dockMenu'

export type { NativeRestoreConfig, RestoreSourceHint, RestoreStatus }

import type { WaveformChunk, WaveformRequest } from './main/audio/waveform'
import type { WindowActivity } from './main/windowActivity'
import type { DownloadsOverview, PlaylistDownloadState } from './main/downloads'

export type { DownloadedPlaylistSummary, DownloadsOverview, PlaylistDownloadState } from './main/downloads'

export type { WaveformChunk, WaveformRequest, WindowActivity }

/** DSD → PCM conversion done by the audio engine as the file plays. */
export interface DsdConversionOptions {
  sampleRate: number
  filterHz: number
  gainDb: number
}

export interface HardwareVolumeInfo {
  supported: boolean
  scalar: number
  decibels: number | null
  minDecibels: number | null
  maxDecibels: number | null
  muteSupported: boolean
  muted: boolean
}

export interface AudioResult {
  success: boolean
  error?: string
  artwork?: string | null
}

export interface BluetoothInfo {
  isBluetooth: boolean
  deviceName: string
  codec: 'AAC' | 'SBC' | null
  isLossy: boolean
  exclusiveBlockedByBluetooth: boolean
}

export interface AudioVisualizerFrame {
  left: number[]
  right: number[]
  sampleRate: number
  valid: boolean
  peak: number
  rms: number
  paused: boolean
  active: boolean
}

export interface AudioProcessingStats {
  speed: number
  active: boolean
}

export interface TrackRow {
  id: string           // SHA-256 of file_path
  playlist_item_id?: number
  playlist_stack_id?: number | null
  playlist_stack_position?: number | null
  playlist_stack_size?: number | null
  file_path: string
  playback_file_path?: string | null
  source: string
  source_id: string | null
  catalog_track_id?: string | null
  catalog_album_id?: string | null
  catalog_artist_id?: string | null
  title: string
  track_number: number | null
  disc_number: number
  duration: number     // duration_ms
  format: string | null
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  lossless: number
  stream_info_fetched_at?: number | null
  /** Why the account cannot stream this provider track; null when it can. */
  unavailable_reason?: string | null
  year: number | null
  file_size: number | null
  modified_at: number | null
  has_embedded_art: number
  art_hash: string | null
  album_id: string | null
  artist_id: string | null
  artist_name: string | null
  artist_credit_name?: string | null
  album_title: string | null
  album_art_path: string | null
  album_artwork_id: string | null
  /** The track's own artwork (e.g. a provider thumbnail); shown only when the album has no cover. */
  track_artwork_id?: string | null
  /** Remote URL of the track's own artwork, for consumers that need a public link (Discord). */
  track_art_path?: string | null
  album_artwork_url?: string | null
  start_offset_ms?: number | null
  end_offset_ms?: number | null
  cue_sheet_path?: string | null
}

export interface AlbumRow {
  id: string
  source: string
  source_id: string | null
  catalog_album_id?: string | null
  catalog_artist_id?: string | null
  title: string
  year: number | null
  total_tracks: number | null
  total_discs: number | null
  album_artist_id: string | null
  album_artist_name: string | null
  art_path: string | null
  artwork_id: string | null
  art_source: string
  is_compilation: number
  artist_name: string | null
}

export interface ArtistRow {
  id: string
  catalog_artist_id?: string | null
  name: string
  normalized_name: string | null
  art_path: string | null
  artwork_id: string | null
  art_source: string | null
  bio: string | null
  bio_source: string | null
  bio_url: string | null
  bio_fetched_at: number | null
  genres: string | null    // JSON array string
  album_count: number
  track_count: number
}

export interface SearchResults {
  tracks: TrackRow[]
  albums: AlbumRow[]
  artists: ArtistRow[]
}

export type GenreSummary = CatalogGenreSummary

export interface PlaylistInfo {
  playback_provider_id: string
  management: 'app' | 'provider'
  legacy_mixed: number
  id: number
  name: string
  created_at: number
  track_count: number
  source: string
  source_id: string | null
  read_only: number
  artwork_id: string | null
  folder_id: number | null
  folder_position: number | null
}

export interface PlaylistFolderInfo {
  id: number
  name: string
  created_at: number
  source: string
  source_id: string | null
  parent_id: number | null
  read_only: number
  position: number
}

/** A native context menu item; `id` is echoed back when the item is chosen. */
export type ContextMenuItemSpec =
  | { type: 'separator' }
  | { id?: string; label: string; enabled?: boolean; submenu?: ContextMenuItemSpec[] }

export interface ResolvedPlaybackQueue {
  skippedCount?: number
  rows: TrackRow[]
  startIndex: number
}

export const GENERIC_EVENT_CHANNELS = [
  'app:accent-color-changed',
  'app:open-settings',
  'app:window-activity-changed',
  'audio:bluetooth-info',
  'audio:default-device-changed',
  'audio:mode-changed',
  'autoeq:index-updated',
  'catalog:changed',
  'dsp:plugin-disabled',
  'dsp:plugin-parameter-changed',
  'lastfm:auth-token',
  'library:scan-progress',
  'live-radio:changed',
  'player:media-command',
  'player:open-recent',
  'playlists:changed',
  'provider:warning',
  'visualizer:attached',
  'visualizer:detached',
] as const

export type GenericEventChannel = typeof GENERIC_EVENT_CHANNELS[number]
const genericEventChannels = new Set<string>(GENERIC_EVENT_CHANNELS)

/**
 * Corner radius of the main window, in px. Measured from AppKit on macOS 26:
 * windows with a toolbar (Electron's hiddenInset adds one) use 26pt, plain
 * titled windows 16pt. macOS 27 gives every window one uniform 20pt radius;
 * earlier releases used 10pt.
 */
function windowCornerRadius(): number {
  if (process.platform !== 'darwin') return 0
  const major = Number(process.getSystemVersion().split('.')[0])
  if (major >= 27) return 20
  if (major === 26) return 26
  return 10
}

const purosApi = {
  /** Installed (runtime-imported) provider packages; main owns file selection. */
  providerPackages: {
    list: (): Promise<PackageIpcResult<InstalledProviderPackageInfo[]>> =>
      ipcRenderer.invoke('provider-packages:list'),
    choose: (providerId?: string): Promise<PackageIpcResult<PackageInspectionSummary | null>> =>
      ipcRenderer.invoke('provider-packages:choose', providerId),
    install: (token: string, acceptedWarnings: PackageTrustWarning[]): Promise<PackageIpcResult<InstallOutcome>> =>
      ipcRenderer.invoke('provider-packages:install', token, acceptedWarnings),
    discard: (token: string): Promise<PackageIpcResult<void>> =>
      ipcRenderer.invoke('provider-packages:discard', token),
    setEnabled: (providerId: string, enabled: boolean): Promise<PackageIpcResult<InstallOutcome>> =>
      ipcRenderer.invoke('provider-packages:set-enabled', providerId, enabled),
    removeCode: (providerId: string): Promise<PackageIpcResult<void>> =>
      ipcRenderer.invoke('provider-packages:remove-code', providerId),
  },
  provider: {
    list: (): Promise<ProviderDescriptorV1[]> =>
      ipcRenderer.invoke('provider:list'),
    status: (providerId: string): Promise<ProviderStatusV1> =>
      ipcRenderer.invoke('provider:status', providerId),
    invoke: (
      providerId: string,
      capability: ProviderCapabilityV1,
      method: string,
      args: ProviderValueV1[] = [],
    ): Promise<ProviderResultV1<ProviderValueV1 | undefined>> =>
      ipcRenderer.invoke('provider:invoke', providerId, capability, method, args),
    cancelSession: (providerId: string, sessionId: string): Promise<ProviderResultV1<boolean>> =>
      ipcRenderer.invoke('provider:cancel-session', providerId, sessionId),
    getSetting: (providerId: string, key: string): Promise<ProviderPrimitiveV1 | undefined> =>
      ipcRenderer.invoke('provider:setting:get', providerId, key),
    setSetting: (providerId: string, key: string, value: ProviderPrimitiveV1): Promise<void> =>
      ipcRenderer.invoke('provider:setting:set', providerId, key, value),
    deleteSetting: (providerId: string, key: string): Promise<void> =>
      ipcRenderer.invoke('provider:setting:delete', providerId, key),
    hasSecret: (providerId: string, key: string): Promise<boolean> =>
      ipcRenderer.invoke('provider:secret:has', providerId, key),
    setSecret: (providerId: string, key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('provider:secret:set', providerId, key, value),
    deleteSecret: (providerId: string, key: string): Promise<void> =>
      ipcRenderer.invoke('provider:secret:delete', providerId, key),
    /** Providers that are not running here but still have data in this profile. */
    retainedData: (): Promise<RetainedProviderData[]> =>
      ipcRenderer.invoke('provider:retained-data'),
    removeData: (providerId: string): Promise<{
      providerId: string
      tracks: number
      albums: number
      artists: number
      playlists: number
      cacheEntries: number
    }> => ipcRenderer.invoke('provider:remove-data', providerId),
    onEvent: (callback: (event: ProviderEventEnvelopeV1) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, event: ProviderEventEnvelopeV1) => callback(event)
      ipcRenderer.on('provider:event', subscription)
      return () => { ipcRenderer.removeListener('provider:event', subscription) }
    },
  },

  // --- Audio Engine ---
  audio: {
    listDevices: (): Promise<AudioDevice[]> =>
      ipcRenderer.invoke('audio:list-devices'),
    openExclusive: (
      deviceUid: string,
      sampleRate: number,
      bitDepth: number,
      preferNonMixableInteger = false,
    ): Promise<AudioResult> =>
      ipcRenderer.invoke('audio:open-exclusive', deviceUid, sampleRate, bitDepth, preferNonMixableInteger),
    openShared: (deviceUid: string): Promise<AudioResult> =>
      ipcRenderer.invoke('audio:open-shared', deviceUid),
    /** allowResample: the output was opened at the format chosen for this track; resample instead of reopening. */
    /** dsdOutputRate > 0: modulate to DSD at that rate (DoP). */
    /** sourceHint: codec metadata for Puros Restore where the decoder sees only PCM. */
    playFile: (
      filePath: string,
      allowResample = false,
      deemphasis = false,
      dsdOutputRate = 0,
      sourceHint: RestoreSourceHint = 'unknown',
    ): Promise<AudioResult> =>
      ipcRenderer.invoke('audio:play-file', filePath, allowResample, deemphasis, dsdOutputRate, sourceHint),
    /** CD pre-emphasis flagged in the CUE sheet or tags of a local file. */
    detectPreEmphasis: (filePath: string, cueSheetPath?: string | null, startOffsetMs?: number | null): Promise<boolean> =>
      ipcRenderer.invoke('audio:detect-pre-emphasis', filePath, cueSheetPath ?? null, startOffsetMs ?? null),
    prepareLocalFile: (
      filePath: string,
      sourceFormat?: FormatInfo | null,
      dsdOptions?: DsdConversionOptions | null,
    ): Promise<{ playbackPath: string; outputFormat: FormatInfo | null }> =>
      ipcRenderer.invoke('audio:prepare-local-file', filePath, sourceFormat ?? null, dsdOptions ?? null),
    queueNextFile: (
      filePath: string,
      allowResample = false,
      deemphasis = false,
      dsdOutputRate = 0,
      sourceHint: RestoreSourceHint = 'unknown',
    ): Promise<AudioResult> =>
      ipcRenderer.invoke('audio:queue-next-file', filePath, allowResample, deemphasis, dsdOutputRate, sourceHint),
    setResamplerConfig: (config: NativeResamplerConfig): Promise<void> =>
      ipcRenderer.invoke('audio:set-resampler-config', config),
    getResamplerStatus: (): Promise<ResamplerStatus> =>
      ipcRenderer.invoke('audio:get-resampler-status'),
    previewFirFilter: (design: NativeFirDesign, inputRate: number, outputRate: number): Promise<FirPreview> =>
      ipcRenderer.invoke('audio:preview-fir-filter', design, inputRate, outputRate),
    inspectImpulseResponse: (filePath: string): Promise<ImpulseResponseInspection> =>
      ipcRenderer.invoke('audio:inspect-impulse-response', filePath),
    /** Native open dialog for a room-correction impulse; null when cancelled. */
    pickImpulseResponse: (): Promise<string | null> =>
      ipcRenderer.invoke('audio:pick-impulse-response'),
    clearQueuedFile: (): Promise<void> =>
      ipcRenderer.invoke('audio:clear-queued-file'),
    stopPlayback: (): Promise<void> =>
      ipcRenderer.invoke('audio:stop-playback'),
    pause: (): Promise<void> =>
      ipcRenderer.invoke('audio:pause'),
    resume: (): Promise<void> =>
      ipcRenderer.invoke('audio:resume'),
    seek: (position: number): Promise<void> =>
      ipcRenderer.invoke('audio:seek', position),
    write: (buffer: Buffer): Promise<void> =>
      ipcRenderer.invoke('audio:write', buffer),
    getMode: (): Promise<'exclusive' | 'shared' | 'closed'> =>
      ipcRenderer.invoke('audio:get-mode'),
    getPosition: (): Promise<number> =>
      ipcRenderer.invoke('audio:get-position'),
    getDuration: (): Promise<number> =>
      ipcRenderer.invoke('audio:get-duration'),
    isTrackEnded: (): Promise<boolean> =>
      ipcRenderer.invoke('audio:is-track-ended'),
    consumeQueuedAdvance: (): Promise<boolean> =>
      ipcRenderer.invoke('audio:consume-queued-advance'),
    getCurrentFormat: (): Promise<{ sampleRate: number; bitDepth: number; channels: number }> =>
      ipcRenderer.invoke('audio:get-current-format'),
    getProcessingStats: (): Promise<AudioProcessingStats> =>
      ipcRenderer.invoke('audio:get-processing-stats'),
    getVisualizerFrame: (): Promise<AudioVisualizerFrame> =>
      ipcRenderer.invoke('audio:get-visualizer-frame'),
    /** Seek-bar waveform of a file, delivered in chunks through onWaveformChunk. */
    startWaveform: (requestId: string, request: WaveformRequest): Promise<boolean> =>
      ipcRenderer.invoke('waveform:start', requestId, request),
    /** The growing file behind a waveform request has been fully written. */
    finishWaveformSource: (requestId: string): Promise<void> =>
      ipcRenderer.invoke('waveform:finish-source', requestId),
    cancelWaveform: (requestId: string): Promise<void> =>
      ipcRenderer.invoke('waveform:cancel', requestId),
    onWaveformChunk: (callback: (chunk: WaveformChunk) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, chunk: WaveformChunk) => callback(chunk)
      ipcRenderer.on('waveform:chunk', subscription)
      return () => { ipcRenderer.removeListener('waveform:chunk', subscription) }
    },
    setVolume: (gain: number): Promise<void> =>
      ipcRenderer.invoke('audio:set-volume', gain),
    setDigitalVolume: (gain: number): Promise<void> =>
      ipcRenderer.invoke('audio:set-digital-volume', gain),
    getHardwareVolume: (deviceUid: string): Promise<HardwareVolumeInfo> =>
      ipcRenderer.invoke('audio:get-hardware-volume', deviceUid),
    setHardwareVolume: (deviceUid: string, scalar: number): Promise<AudioResult> =>
      ipcRenderer.invoke('audio:set-hardware-volume', deviceUid, scalar),
    setHardwareMute: (deviceUid: string, muted: boolean): Promise<AudioResult> =>
      ipcRenderer.invoke('audio:set-hardware-mute', deviceUid, muted),
    setHardwareBufferOptions: (deviceUid: string, useMax: boolean, powerOfTwo: boolean): Promise<void> =>
      ipcRenderer.invoke('audio:set-hardware-buffer-options', deviceUid, useMax, powerOfTwo),
    close: (): Promise<void> =>
      ipcRenderer.invoke('audio:close'),
    getBluetoothInfo: (): Promise<BluetoothInfo> =>
      ipcRenderer.invoke('audio:get-bluetooth-info'),
  },

  // --- DSP / EQ ---
  dsp: {
    setEQProfile: (bands: Array<{type: string; freq: number; gain: number; q: number}>, preampGainDb: number): Promise<void> =>
      ipcRenderer.invoke('dsp:set-eq-profile', bands, preampGainDb),
    setCrossfeed: (enabled: boolean, cutoffFrequency: number, feedLevelDb: number): Promise<void> =>
      ipcRenderer.invoke('dsp:set-crossfeed', enabled, cutoffFrequency, feedLevelDb),
    setEQEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('dsp:set-eq-enabled', enabled),
    getEQEnabled: (): Promise<boolean> =>
      ipcRenderer.invoke('dsp:get-eq-enabled'),
    clearEQProfile: (): Promise<void> =>
      ipcRenderer.invoke('dsp:clear-eq-profile'),
    /** Puros Restore (native lossy-source restoration). */
    setRestoreConfig: (config: NativeRestoreConfig): Promise<void> =>
      ipcRenderer.invoke('dsp:set-restore-config', config),
    getRestoreStatus: (): Promise<RestoreStatus> =>
      ipcRenderer.invoke('dsp:get-restore-status'),
    loadEQFile: (): Promise<string | null> =>
      ipcRenderer.invoke('dsp:load-eq-file'),
    addPlugin: (): Promise<AudioPlugin | null> =>
      ipcRenderer.invoke('dsp:add-plugin'),
    listInstalledPlugins: (refresh = false): Promise<InstalledAudioPlugin[]> =>
      ipcRenderer.invoke('dsp:list-installed-plugins', refresh),
    addInstalledPlugin: (filePath: string): Promise<AudioPlugin> =>
      ipcRenderer.invoke('dsp:add-installed-plugin', filePath),
    setPlugins: (plugins: AudioPlugin[]): Promise<void> =>
      ipcRenderer.invoke('dsp:set-plugins', plugins),
    getPluginParameters: (index: number): Promise<AudioPluginParameter[]> =>
      ipcRenderer.invoke('dsp:get-plugin-parameters', index),
    setPluginParameter: (index: number, id: number, value: number): Promise<void> =>
      ipcRenderer.invoke('dsp:set-plugin-parameter', index, id, value),
    openPluginEditor: (index: number): Promise<void> =>
      ipcRenderer.invoke('dsp:open-plugin-editor', index),
  },

  // --- AutoEQ preset library ---
  autoeq: {
    buildIndex: (): Promise<{
      success: boolean
      entries?: Array<{ name: string; source: string; downloadUrl: string }>
      count?: number
      rateLimited?: boolean
      error?: string
    }> => ipcRenderer.invoke('autoeq:build-index'),
    fetchPreset: (downloadUrl: string): Promise<{ success: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke('autoeq:fetch-preset', downloadUrl),
  },

  // --- Library ---
  library: {
    scanFolder: (): Promise<string | null> =>
      ipcRenderer.invoke('library:scan-folder'),
    addFolder: (): Promise<string | null> =>
      ipcRenderer.invoke('library:add-folder'),
    getFolders: (): Promise<Array<{ id: string; path: string; last_scanned_at: number | null }>> =>
      ipcRenderer.invoke('library:get-folders'),
    rescan: (): Promise<void> =>
      ipcRenderer.invoke('library:rescan'),
    removeFolder: (folderId: string): Promise<boolean> =>
      ipcRenderer.invoke('library:remove-folder', folderId),
    getTracks: (options?: { search?: string; limit?: number; offset?: number }): Promise<TrackRow[]> =>
      ipcRenderer.invoke('library:get-tracks', options),
    getAlbums: (options?: { sort?: string; limit?: number; offset?: number }): Promise<AlbumRow[]> =>
      ipcRenderer.invoke('library:albums', options),
    getArtists: (options?: { sort?: string }): Promise<ArtistRow[]> =>
      ipcRenderer.invoke('library:artists', options),
    getGenres: (providerId: string): Promise<GenreSummary[]> =>
      ipcRenderer.invoke('library:genres', providerId),
    getArtistsByGenre: (providerId: string, genre: string): Promise<CatalogArtistSummary[]> =>
      ipcRenderer.invoke('library:artists-by-genre', providerId, genre),
    getArtistProfile: (artistId: string): Promise<ArtistRow | null> =>
      ipcRenderer.invoke('library:artist-profile', artistId),
    getTracksForAlbum: (albumId: string): Promise<TrackRow[]> =>
      ipcRenderer.invoke('library:tracks-album', albumId),
    getTracksForArtist: (artistId: string): Promise<TrackRow[]> =>
      ipcRenderer.invoke('library:tracks-artist', artistId),
    search: (query: string): Promise<SearchResults> =>
      ipcRenderer.invoke('library:search', query),
    removeTrack: (trackId: string): Promise<void> =>
      ipcRenderer.invoke('library:remove-track', trackId),
    clearLibrary: (): Promise<void> =>
      ipcRenderer.invoke('library:clear'),
  },

  // --- App ---
  app: {
    windowCornerRadius: windowCornerRadius(),
    convertVisualizerShaders: (shaders: { warp: string; comp: string }): Promise<{ warp: string; comp: string }> =>
      ipcRenderer.invoke('app:convert-visualizer-shaders', shaders),
    getUserDataPath: (): Promise<string> =>
      ipcRenderer.invoke('app:get-user-data-path'),
    /** macOS Dock icon menu: playback state and recently played playlists ('player:open-recent' on click). */
    setDockMenu: (state: DockMenuState): Promise<void> =>
      ipcRenderer.invoke('app:set-dock-menu', state),
    /** macOS / Windows accent colour as #rrggbb (null elsewhere); 'app:accent-color-changed' fires when it changes. */
    getSystemAccentColor: (): Promise<string | null> =>
      ipcRenderer.invoke('app:get-system-accent-color'),
    isFullScreen: (): Promise<boolean> =>
      ipcRenderer.invoke('app:is-full-screen'),
    toggleFullScreen: (): Promise<boolean> =>
      ipcRenderer.invoke('app:toggle-full-screen'),
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('app:open-external', url),
    copyToClipboard: (text: string): Promise<void> =>
      ipcRenderer.invoke('app:copy-to-clipboard', text),
    openAirPlayPicker: (): Promise<{
      success: boolean
      method?: 'system-picker' | 'sound-settings'
      requiresAccessibilityPermission?: boolean
      message?: string
    }> =>
      ipcRenderer.invoke('app:open-airplay-picker'),
    clearCaches: (): Promise<void> =>
      ipcRenderer.invoke('app:clear-caches'),
    getStreamingAudioCacheStats: (): Promise<{
      totalBytes: number
      totalGb: number
      fileCount: number
      limitGb: number
      limitBytes: number
    }> =>
      ipcRenderer.invoke('app:get-streaming-audio-cache-stats'),
    resetAppData: (): Promise<void> =>
      ipcRenderer.invoke('app:reset-app-data'),
    openVisualizerWindow: (): Promise<void> =>
      ipcRenderer.invoke('app:open-visualizer-window'),
    closeVisualizerWindow: (): Promise<void> =>
      ipcRenderer.invoke('app:close-visualizer-window'),
    /** 'active', 'unfocused' or 'hidden' for this window; 'app:window-activity-changed' fires when it changes. */
    getWindowActivity: (): Promise<WindowActivity> =>
      ipcRenderer.invoke('app:get-window-activity'),
    /** Drops Blink's in-memory caches (decoded images and such) while the window is out of sight. */
    releaseRendererCaches: (): void => webFrame.clearCache(),
    /** Shows a native menu at the cursor; resolves with the chosen item's id, or null. */
    showContextMenu: (items: ContextMenuItemSpec[]): Promise<string | null> =>
      ipcRenderer.invoke('app:show-context-menu', items),
  },

  home: {
    getProviderShelves: (): Promise<HomeProviderShelf[]> =>
      ipcRenderer.invoke('home:get-provider-shelves'),
    getProviderCollection: (
      provider: string,
      sourceType: 'playlist' | 'mix' | 'station',
      sourceId: string,
    ): Promise<HomeProviderCollectionBundle> =>
      ipcRenderer.invoke('home:get-provider-collection', provider, sourceType, sourceId),
  },

  player: {
    getVisualizerState: (): Promise<import('./main/nowPlaying/visualizerState').VisualizerPlaybackState> =>
      ipcRenderer.invoke('player:get-visualizer-state'),
    visualizerCommand: (command: 'play-pause' | 'next' | 'previous'): Promise<void> =>
      ipcRenderer.invoke('player:visualizer-command', command),
    setNowPlaying: (payload: {
      title: string
      artist: string
      album: string
      duration: number
      position: number
      artworkUrl?: string | null
      discordArtworkUrl?: string | null
      sourceType?: string | null
      sourceId?: string | null
      provider?: string | null
      catalogTrackId?: string | null
      providerLabel?: string | null
      providerTrackUrl?: string | null
    }): Promise<void> => ipcRenderer.invoke('player:set-now-playing', payload),
    updatePlaybackState: (payload: {
      state: 'playing' | 'paused' | 'stopped'
      position: number
      duration: number
    }): Promise<void> => ipcRenderer.invoke('player:update-playback-state', payload),
    clearNowPlaying: (): Promise<void> =>
      ipcRenderer.invoke('player:clear-now-playing'),
  },

  liveRadio: {
    browse: (options?: LiveRadioBrowseOptions): Promise<Station[]> =>
      ipcRenderer.invoke('live-radio:browse', options ?? {}),
    getFilters: (): Promise<LiveRadioDirectoryFilters> =>
      ipcRenderer.invoke('live-radio:filters'),
    search: (query: string, limit?: number): Promise<Station[]> =>
      ipcRenderer.invoke('live-radio:search', query, limit),
    getMyStations: (): Promise<Station[]> =>
      ipcRenderer.invoke('live-radio:my-stations'),
    saveStation: (station: Station): Promise<Station> =>
      ipcRenderer.invoke('live-radio:save-station', station),
    removeStation: (stationId: string): Promise<void> =>
      ipcRenderer.invoke('live-radio:remove-station', stationId),
    addCustomStream: (payload: { url: string; name?: string | null }): Promise<Station> =>
      ipcRenderer.invoke('live-radio:add-custom-stream', payload),
    probeStream: (url: string): Promise<LiveRadioProbeResult> =>
      ipcRenderer.invoke('live-radio:probe-stream', url),
    getNowPlaying: (stationId: string, streamUrl: string): Promise<LiveRadioNowPlayingMetadata> =>
      ipcRenderer.invoke('live-radio:get-now-playing', stationId, streamUrl),
    startPlayback: (stationId: string, streamUrl: string): Promise<AudioResult> =>
      ipcRenderer.invoke('live-radio:start-playback', stationId, streamUrl),
    stopPlayback: (stationId?: string | null): Promise<void> =>
      ipcRenderer.invoke('live-radio:stop-playback', stationId ?? null),
    markPlaybackStarted: (stationId: string, streamUrl: string): Promise<void> =>
      ipcRenderer.invoke('live-radio:playback-started', stationId, streamUrl),
    markPlaybackStopped: (stationId?: string | null): Promise<void> =>
      ipcRenderer.invoke('live-radio:playback-stopped', stationId ?? null),
    onPlaybackStatus: (callback: (status: LiveRadioPlaybackStatus) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, status: LiveRadioPlaybackStatus) => callback(status)
      ipcRenderer.on('live-radio:playback-status', subscription)
      return () => { ipcRenderer.removeListener('live-radio:playback-status', subscription) }
    },
  },

  lastfm: {
    apiCall: (payload: {
      method: LastFmMethod
      params: Record<string, string>
      sessionKey?: string
      sign?: boolean
      useSessionKey?: boolean
    }): Promise<unknown> => ipcRenderer.invoke('lastfm:api-call', payload),
    getAuthUrl: (): Promise<string | null> =>
      ipcRenderer.invoke('lastfm:get-auth-url'),
    getConfigStatus: (): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('lastfm:get-config-status'),
    completeAuth: (token: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('lastfm:complete-auth', token),
  },

  catalog: {
    browse: (providerId: string, scope?: 'all' | 'library', limit?: number): Promise<CatalogSearchResults> =>
      ipcRenderer.invoke('catalog:browse', providerId, scope, limit),
    browseArtists: (providerId: string, scope?: 'all' | 'library', limit?: number): Promise<CatalogArtistSummary[]> =>
      ipcRenderer.invoke('catalog:browse-artists', providerId, scope, limit),
    browseAlbums: (providerId: string, scope?: 'all' | 'library', limit?: number): Promise<CatalogAlbumSummary[]> =>
      ipcRenderer.invoke('catalog:browse-albums', providerId, scope, limit),
    browseTracks: (providerId: string, scope?: 'all' | 'library', limit?: number): Promise<CatalogTrackSummary[]> =>
      ipcRenderer.invoke('catalog:browse-tracks', providerId, scope, limit),
    search: (providerId: string, query: string, limit?: number, scope?: 'all' | 'library'): Promise<CatalogSearchResults> =>
      ipcRenderer.invoke('catalog:search', providerId, query, limit, scope),
    searchLocal: (providerId: string, query: string, limit?: number, scope?: 'all' | 'library'): Promise<CatalogSearchResults> =>
      ipcRenderer.invoke('catalog:search-local', providerId, query, limit, scope),
    searchRemote: (providerId: string, query: string, limit?: number, scope?: 'all' | 'library'): Promise<CatalogSearchResults> =>
      ipcRenderer.invoke('catalog:search-remote', providerId, query, limit, scope),
    getArtistCounts: (catalogArtistId: string): Promise<{ albumCount: number; trackCount: number }> =>
      ipcRenderer.invoke('catalog:artist-counts', catalogArtistId),
    getSourceChoices: (kind: CatalogEntityType, id: string): Promise<Array<{ id: string; providerId: string; sourceId: string; title: string }>> =>
      ipcRenderer.invoke('catalog:source-choices', kind, id),
    getTrack: (catalogTrackId: string): Promise<CatalogTrackSummary | null> =>
      ipcRenderer.invoke('catalog:track', catalogTrackId),
    getArtistPreview: (catalogArtistId: string): Promise<CatalogArtistPage | null> =>
      ipcRenderer.invoke('catalog:artist-preview', catalogArtistId),
    getArtist: (catalogArtistId: string): Promise<CatalogArtistPage | null> =>
      ipcRenderer.invoke('catalog:artist', catalogArtistId),
    setArtistGenres: (catalogArtistId: string, genres: string[]): Promise<CatalogArtistPage | null> =>
      ipcRenderer.invoke('catalog:set-artist-genres', catalogArtistId, genres),
    getArtistReleases: (catalogArtistId: string): Promise<CatalogArtistPage['releases']> =>
      ipcRenderer.invoke('catalog:artist-releases', catalogArtistId),
    getArtistTopTracks: (catalogArtistId: string): Promise<CatalogTrackSummary[]> =>
      ipcRenderer.invoke('catalog:artist-top-tracks', catalogArtistId),
    getArtistRelated: (catalogArtistId: string): Promise<CatalogArtistPage['relatedArtists']> =>
      ipcRenderer.invoke('catalog:artist-related', catalogArtistId),
    getArtistPlaylists: (catalogArtistId: string): Promise<CatalogPlaylistSummary[]> =>
      ipcRenderer.invoke('catalog:artist-playlists', catalogArtistId),
    getArtistRadioTracks: (
      catalogArtistId?: string | null,
      artistName?: string | null,
      excludeTrackIds?: string[],
      providerId?: string,
    ): Promise<CatalogTrackSummary[]> =>
      ipcRenderer.invoke('catalog:artist-radio-tracks', catalogArtistId ?? null, artistName ?? null, excludeTrackIds ?? [], providerId),
    getAlbumPreview: (catalogAlbumId: string): Promise<CatalogAlbumPage | null> =>
      ipcRenderer.invoke('catalog:album-preview', catalogAlbumId),
    getAlbum: (catalogAlbumId: string): Promise<CatalogAlbumPage | null> =>
      ipcRenderer.invoke('catalog:album', catalogAlbumId),
    getAlbumTracks: (catalogAlbumId: string): Promise<CatalogAlbumPage['tracks']> =>
      ipcRenderer.invoke('catalog:album-tracks', catalogAlbumId),
    resolvePlayback: (
      catalogTrackId: string,
      preferredProvider?: CatalogProviderName | null,
      preferredSourceId?: string | null,
      options?: { allowDiscovery?: boolean },
    ): Promise<CatalogResolvedPlaybackTrack | null> =>
      ipcRenderer.invoke('catalog:resolve-playback', catalogTrackId, preferredProvider, preferredSourceId, options),
    addToLibrary: (
      entityType: CatalogEntityType,
      catalogId: string,
      preferredProvider?: CatalogProviderName | null,
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('catalog:add-to-library', entityType, catalogId, preferredProvider),
    refreshEntity: (
      entityType: CatalogEntityType,
      catalogId: string,
    ): Promise<CatalogArtistPage | CatalogAlbumPage | null> =>
      ipcRenderer.invoke('catalog:refresh-entity', entityType, catalogId),
    clearMetadataCache: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('catalog:clear-metadata-cache'),
  },

  // --- Settings (key/value persistence) ---
  settings: {
    get: (key: string): Promise<string | null> =>
      ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('settings:set', key, value),
    delete: (key: string): Promise<void> =>
      ipcRenderer.invoke('settings:delete', key),
  },

  lyrics: {
    resolve: (payload: LyricsProviderFetchRequest): Promise<LyricsProviderFetchResult> =>
      ipcRenderer.invoke('lyrics:resolve', payload),
    testProvider: (provider: LyricsProviderId, apiKey?: string): Promise<LyricsProviderTestResult> =>
      ipcRenderer.invoke('lyrics:test-provider', provider, apiKey),
  },

  // --- Playlists ---
  playlists: {
    getAll: (): Promise<PlaylistInfo[]> =>
      ipcRenderer.invoke('playlists:getAll'),
    getFolders: (): Promise<PlaylistFolderInfo[]> =>
      ipcRenderer.invoke('playlists:getFolders'),
    create: (name: string, folderId?: number | null, providerId = 'local'): Promise<PlaylistInfo> =>
      ipcRenderer.invoke('playlists:create', name, folderId ?? null, providerId),
    rename: (id: number, newName: string): Promise<void> =>
      ipcRenderer.invoke('playlists:rename', id, newName),
    delete: (id: number): Promise<void> =>
      ipcRenderer.invoke('playlists:delete', id),
    duplicate: (id: number): Promise<PlaylistInfo | null> =>
      ipcRenderer.invoke('playlists:duplicate', id),
    createFolder: (name: string, parentId?: number | null): Promise<PlaylistFolderInfo> =>
      ipcRenderer.invoke('playlists:createFolder', name, parentId ?? null),
    renameFolder: (id: number, newName: string): Promise<void> =>
      ipcRenderer.invoke('playlists:renameFolder', id, newName),
    deleteFolder: (id: number): Promise<void> =>
      ipcRenderer.invoke('playlists:deleteFolder', id),
    moveToFolder: (playlistId: number, folderId?: number | null): Promise<void> =>
      ipcRenderer.invoke('playlists:moveToFolder', playlistId, folderId ?? null),
    addTrack: (playlistId: number, trackId: string | number): Promise<{ alreadyPresent: boolean }> =>
      ipcRenderer.invoke('playlists:addTrack', playlistId, trackId),
    addCatalogTrack: (
      playlistId: number,
      catalogTrackId: string,
      preferredProvider?: CatalogProviderName | null,
      preferredSourceId?: string | null,
    ): Promise<{ alreadyPresent: boolean; added: boolean }> =>
      ipcRenderer.invoke('playlists:addCatalogTrack', playlistId, catalogTrackId, preferredProvider ?? null, preferredSourceId ?? null),
    removeTrack: (playlistId: number, playlistItemId: string | number): Promise<void> =>
      ipcRenderer.invoke('playlists:removeTrack', playlistId, playlistItemId),
    reorderTracks: (playlistId: number, fromIndex: number, toIndex: number): Promise<void> =>
      ipcRenderer.invoke('playlists:reorderTracks', playlistId, fromIndex, toIndex),
    getTracks: (playlistId: number): Promise<TrackRow[]> =>
      ipcRenderer.invoke('playlists:getTracks', playlistId),
    createSmartStack: (playlistId: number, playlistItemIds: number[]): Promise<void> =>
      ipcRenderer.invoke('playlists:createSmartStack', playlistId, playlistItemIds),
    removeFromSmartStack: (playlistId: number, playlistItemId: number): Promise<void> =>
      ipcRenderer.invoke('playlists:removeFromSmartStack', playlistId, playlistItemId),
    dissolveSmartStack: (playlistId: number, stackId: number): Promise<void> =>
      ipcRenderer.invoke('playlists:dissolveSmartStack', playlistId, stackId),
    resolvePlayback: (
      playlistId: number,
      options?: { shuffle?: boolean; startPlaylistItemId?: number; startTrackId?: string; playlistItemIds?: number[] },
    ): Promise<ResolvedPlaybackQueue> =>
      ipcRenderer.invoke('playlists:resolvePlayback', playlistId, options),
    setArtwork: (playlistId: number): Promise<{ changed: boolean; artworkId: string | null }> =>
      ipcRenderer.invoke('playlists:setArtwork', playlistId),
    clearArtwork: (playlistId: number): Promise<{ changed: boolean }> =>
      ipcRenderer.invoke('playlists:clearArtwork', playlistId),
    getArtwork: (playlistId: number): Promise<string | null> =>
      ipcRenderer.invoke('playlists:getArtwork', playlistId),
  },

  // --- Playlist downloads (offline playback) ---
  downloads: {
    getOverview: (): Promise<DownloadsOverview> =>
      ipcRenderer.invoke('downloads:get-overview'),
    getPlaylistState: (playlistId: number): Promise<PlaylistDownloadState> =>
      ipcRenderer.invoke('downloads:get-playlist-state', playlistId),
    enablePlaylist: (playlistId: number): Promise<PlaylistDownloadState> =>
      ipcRenderer.invoke('downloads:enable-playlist', playlistId),
    /** Returns how many downloaded files were deleted. */
    removePlaylist: (playlistId: number): Promise<number> =>
      ipcRenderer.invoke('downloads:remove-playlist', playlistId),
    markTrack: (provider: string, sourceId: string, artifactPath: string): Promise<boolean> =>
      ipcRenderer.invoke('downloads:mark-track', provider, sourceId, artifactPath),
    pruneOrphans: (): Promise<number> =>
      ipcRenderer.invoke('downloads:prune-orphans'),
    removeAll: (): Promise<number> =>
      ipcRenderer.invoke('downloads:remove-all'),
  },

  // --- Generic IPC for events ---
  on: (channel: GenericEventChannel, callback: (...args: unknown[]) => void) => {
    if (!genericEventChannels.has(channel)) {
      throw new Error(`Renderer event channel is not allowed: ${channel}`)
    }
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => { ipcRenderer.removeListener(channel, subscription) }
  },
}

contextBridge.exposeInMainWorld('puros', purosApi)

export type PurosApi = typeof purosApi

declare global {
  interface Window {
    puros: PurosApi
  }
}

export type { InstalledProviderPackageInfo, PackageInspectionSummary, InstallOutcome, PackageTrustWarning, RetainedProviderData }
