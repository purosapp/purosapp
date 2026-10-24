/**
 * AudioService — singleton driving playback through the native CoreAudio engine.
 *
 * Before each track plays:
 *   1. Detect track format (from store formatInfo)
 *   2. Check DAC capabilities via listDevices()
 *   3. Resolve playback decision (bit-perfect or resampled)
 *   4. Open device at target format (exclusive) or let system handle (shared)
 *   5. Update store with decision for UI display
 *
 * Polls position from the native engine on a timer so queue advancement keeps
 * running while the Electron window is minimized (less often then, except near
 * the end of a track; see playbackPollDelayMs).
 *
 * "__default__" virtual device:
 *   - Always opened in shared mode
 *   - Resolves to kAudioHardwarePropertyDefaultOutputDevice at open time
 *   - Re-opened automatically when system default changes (audio:default-device-changed)
 *   - Preference persisted via settings:set('audioDevice', '__default__')
 */

import { getTrackIdentity, tracksShareIdentity, usePlayerStore, type RestoredPlayerSession, type Track } from '../store/playerStore'
import { useLastFmStore } from '../store/lastfmStore'
import { useSettingsStore } from '../store/settingsStore'
import { useAudioSetupStore } from '../store/audioSetupStore'
import type { AudioDevice } from '../../electron/preload'
import type { FormatInfo } from './local/formats'
import type { CatalogProviderName, CatalogResolvedPlaybackTrack } from './catalog/types'
import {
  buildDeviceCapabilities,
  isLossyCodec,
  requiresSampleRateConversion,
  resolvePlaybackFormat,
  formatDecisionLog,
  DEFAULT_OUTPUT_POLICY,
  type DeviceCapabilities,
  type OutputFormatPolicy,
  type PlaybackDecision,
  type TrackFormat,
} from './formatCompatibility'
import { recordRecentlyPlayed } from './homeRecents'
import {
  applyDeviceFormatLimits,
  deviceDisplayName,
  effectiveResampling,
  getDeviceConfig,
  isDeviceEnabled,
  resolvePreferredAudioMode,
  type AudioSetupState,
} from './audioDeviceConfig'
import {
  DSD_MODULATORS,
  describeResampler,
  dsdRateName,
  resolveDsdConversionOptions,
  resolveDsdOutputRate,
  toNativeResamplerConfig,
  type ResamplingSettings,
} from './resamplingSettings'

/** PCM rate the engine feeds its DSD modulator; DSD sources are decoded to it for remodulation. */
const DSD_INTERMEDIATE_RATE = 352800
import { getJsonSetting, getStringSetting, setJsonSetting, setStringSetting } from '../utils/appSettings'
import type { HardwareVolumeInfo } from '../../electron/preload'
import {
  hardwareVolumeToUserVolume,
  isVolumeModeSetting,
  resolveVolumeMode,
  userVolumeToGain,
  type EffectiveVolumeMode,
  type HardwareVolumeState,
  type VolumeControlState,
  type VolumeModeSetting,
} from './volumeControl'
import {
  getExclusiveBlockedTransportError,
  getExclusiveBlockedTransportLabel,
} from '../utils/audioDeviceTransport'
import { playbackPreparationService } from './playback/PlaybackPreparationService'
import { TrackUnavailableError } from './playback/types'
import { unavailableTrackLabel } from '../utils/trackAvailability'
import {
  StreamingSessionState,
  type StreamingSessionSnapshot,
} from './playback/streaming'
import { isLiveRadioTrack } from './liveRadio/track'
import { restoreSourceHint } from './restoreSettings'
import { useProviderStatusStore } from '../store/providerStatusStore'
import { getWindowActivity, isWindowHidden, useWindowActivityStore } from './windowActivity'

const DEFAULT_DEVICE_ID = '__default__'
const AUDIO_DEVICE_SETTING_KEY = 'audioDevice'
const AUDIO_MODE_SETTING_KEY = 'audioMode'
const AUDIO_VOLUME_MODES_SETTING_KEY = 'audioVolumeModes'
const HARDWARE_VOLUME_POLL_INTERVAL_MS = 1000
const HARDWARE_VOLUME_LOCAL_GRACE_MS = 1500
const NATIVE_QUEUE_LOOKAHEAD = 1
const NATIVE_QUEUE_URGENT_LEAD_SECONDS = 20
const TRACK_END_GUARD_MS = 1500
const PLAYBACK_POLL_INTERVAL_MS = 250
/** With another app focused only the progress bar is affected, and it barely moves in 500 ms. */
const UNFOCUSED_PLAYBACK_POLL_INTERVAL_MS = 500
/** Out of sight, polling only has to notice the track ending; see the lead below. */
const HIDDEN_PLAYBACK_POLL_INTERVAL_MS = 1000
/** Seconds before a track ends from which polling is back at full rate, so advancing stays prompt. */
const PLAYBACK_POLL_FULL_RATE_LEAD_SECONDS = 5
const STREAMING_RECOVERY_BYTES = 8 * 1024 * 1024
const STREAMING_RECOVERY_SEGMENTS = 2
const LIVE_RADIO_METADATA_POLL_INTERVAL_MS = 15_000
const LIVE_RADIO_RECONNECT_BASE_MS = 1_500
const LIVE_RADIO_RECONNECT_MAX_MS = 20_000

type ResolvedPlaybackTarget = {
  playbackTarget: string
  playbackFormatInfo: FormatInfo | null
  decisionFormat: TrackFormat | null
  /** The playable track when the queue entry was an unresolved catalog placeholder (CUE offsets, file path…). */
  track?: Track
}

type DeviceFormatSnapshot = { sampleRate: number; bitDepth: number; channels: number } | null | undefined
type CueSlice = { startSeconds: number; endSeconds: number | null; durationSeconds: number }
type StreamingBufferHealth = 'GOOD' | 'LOW'
type ActiveProgressivePlayback = {
  trackIdentity: string | null
  session: StreamingSessionSnapshot
  playbackPath: string
  recovering: boolean
  recoveryBytes: number
  recoverySegments: number
  recoveryRevision: number
  recoveryPosition: number
  openedRevision: number
  finalFileReopened: boolean
  bufferHealth: StreamingBufferHealth | null
}

function getTrackProviderName(track: Pick<Track, 'provider' | 'sourceType'> | null | undefined): string | null {
  const provider = String(track?.provider ?? track?.sourceType ?? '').trim().toLowerCase()
  return provider || null
}

function isBufferedStreamingTrack(track: Pick<Track, 'provider' | 'sourceType' | 'streamId'> | null | undefined): boolean {
  const provider = getTrackProviderName(track)
  return !!track?.streamId && !!provider && provider !== 'local' && provider !== 'live-radio'
}

function providerDisplayName(providerId: string | null): string {
  if (!providerId) return 'provider'
  return useProviderStatusStore.getState().providers
    .find(({ manifest }) => manifest.id === providerId)?.manifest.displayName ?? providerId
}

function isMediaSessionArtworkSrc(value: string | null | undefined): value is string {
  return /^(https?:|data:|blob:)/i.test(value ?? '')
}

function toHardwareVolumeState(info: HardwareVolumeInfo): HardwareVolumeState {
  return {
    scalar: info.scalar,
    decibels: info.decibels,
    minDecibels: info.minDecibels,
    maxDecibels: info.maxDecibels,
    muteSupported: info.muteSupported,
    muted: info.muted,
  }
}

function resolvedPlaybackToTrack(resolved: CatalogResolvedPlaybackTrack): Track {
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

class AudioService {
  private unsubscribe: (() => void) | null = null
  private ipcUnsubscribers: Array<() => void> = []
  private pollId: ReturnType<typeof setTimeout> | null = null
  private pollTick: (() => void | Promise<void>) | null = null
  private pollGeneration = 0
  private seekPending = false
  private notificationTimer: ReturnType<typeof setTimeout> | null = null
  private playToken = 0  // incremented on each playTrack call; stale calls bail out
  private lastMediaSessionPositionSync = 0
  private lastMediaSessionPosition = -1
  private mediaSessionBridgeElement: HTMLAudioElement | null = null
  private mediaSessionBridgeContext: AudioContext | null = null
  private autoResumeAfterBluetoothReconnect = false
  private queuePreparationToken = 0
  private nativeQueuedTrackId: string | null = null
  private nativeQueuedTrack: Track | null = null
  private nativeQueuedFormatInfo: FormatInfo | null = null
  /** File handed to queueNextFile() for nativeQueuedTrack. */
  private nativeQueuedPlaybackPath: string | null = null
  private nativeAdvancedFormatInfo: FormatInfo | null = null
  /** Source quality for display when the queued file is a provider conversion. */
  private nativeQueuedSourceFormatInfo: FormatInfo | null = null
  private nativeAdvancedSourceFormatInfo: FormatInfo | null = null
  private queuePreparingTrack: Track | null = null
  /** Next track prefetched while the current one still plays its growing file; queued natively once the finished file is open. */
  private queueDeferredForGrowingFile: string | null = null
  private queueBlockedTrackId: string | null = null
  private suppressPlayTrackForTrack: Track | null = null
  private initialDeviceOpen: Promise<void> | null = null
  /** True only while restoreSession() writes the store, so the subscriber leaves the engine idle. */
  private restoringSession = false
  /** Restored track that has not been loaded into the engine yet; play() loads it. */
  private pendingRestoreIdentity: string | null = null
  /** Position the next playTrack() call should start from (restored sessions). */
  private pendingStartPosition = 0
  private activePlaybackTrackId: string | null = null
  private suppressEndedUntil = 0
  private dsdStartupFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private liveRadioMetadataTimer: ReturnType<typeof setTimeout> | null = null
  private liveRadioReconnectAttempts = 0
  private endlessPlaybackSeedKey: string | null = null
  private activeProgressivePlayback: ActiveProgressivePlayback | null = null
  private volumeModes: Record<string, VolumeModeSetting> = {}
  /** DSD rate the current track is modulated to (0 = PCM output). */
  private currentDsdOutputRate = 0
  private volumeModesLoaded: Promise<void> | null = null
  // Last slider position under software control (system or DSP), restored when leaving device/fixed volume.
  private softwareVolume = 1
  private volumeSyncToken = 0
  private volumeControlDeviceUid: string | null = null
  private volumeFromEngine = false
  private lastLocalVolumeChangeAt = 0
  private hardwareVolumePollId: ReturnType<typeof setInterval> | null = null
  private pendingHardwareVolume: { deviceUid: string; volume: number } | null = null
  private hardwareVolumeWriting = false

  private getPreferredExclusiveFormat(device: AudioDevice): { sampleRate: number; bitDepth: number } {
    const formats = this.deviceCapabilities(device).supportedFormats
    const integerFormats = formats.filter((format) => !format.isFloat)
    const formatPool = integerFormats.length > 0 ? integerFormats : formats
    const preferredRates = [44100, 48000, 88200, 96000, 176400, 192000]

    const sampleRate =
      preferredRates.find((rate) => formatPool.some((format) => format.sampleRate === rate)) ??
      formatPool[0]?.sampleRate ??
      device.sampleRates[0] ??
      device.sampleRate ??
      44100

    const bitDepths = formatPool
      .filter((format) => format.sampleRate === sampleRate)
      .map((format) => format.bitDepth)
      .sort((a, b) => b - a)

    const bitDepth =
      (bitDepths.includes(24) ? 24 : bitDepths[0]) ??
      [...device.bitDepths].sort((a, b) => b - a)[0] ??
      16

    return { sampleRate, bitDepth }
  }

  // ---------------------------------------------------------------------------
  // Audio Setup (per-device configuration)
  // ---------------------------------------------------------------------------

  private async loadAudioSetup(): Promise<AudioSetupState> {
    await useAudioSetupStore.getState().ensureLoaded()
    return useAudioSetupStore.getState().setup
  }

  private get audioSetup(): AudioSetupState {
    return useAudioSetupStore.getState().setup
  }

  /** Device capabilities with the Audio Setup resolution and DSD limits applied. */
  private deviceCapabilities(device: AudioDevice): DeviceCapabilities {
    return applyDeviceFormatLimits(buildDeviceCapabilities(device), getDeviceConfig(this.audioSetup, device.uid))
  }

  private deviceDisplayName(device: AudioDevice): string {
    return deviceDisplayName(this.audioSetup, device)
  }

  /** Resync delay: let the DAC lock onto a freshly opened stream while the engine plays silence. */
  private async waitForResync(deviceUid: string | null | undefined) {
    const delayMs = getDeviceConfig(this.audioSetup, deviceUid).resyncDelayMs ?? 0
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  /** "Set max volume at playback start" for DSP/fixed volume: push the DAC's own control to 100%. */
  private async applyMaxVolumeAtStart(deviceUid: string, hardwareVolume: boolean | undefined) {
    if (!hardwareVolume || !getDeviceConfig(this.audioSetup, deviceUid).maxVolumeAtStart) return
    const mode = this.resolveExclusiveVolumeMode(deviceUid, hardwareVolume)
    if (mode !== 'dsp' && mode !== 'fixed') return
    try {
      const info = await window.puros.audio.getHardwareVolume(deviceUid)
      if (!info.supported) return
      if (info.muted && info.muteSupported) await window.puros.audio.setHardwareMute(deviceUid, false)
      if (info.scalar < 0.999) await window.puros.audio.setHardwareVolume(deviceUid, 1)
    } catch (error) {
      console.warn('[Puros] Could not set device volume to maximum:', error)
    }
  }

  /** Resampling settings for the active output (device override, else global). */
  private currentResampling(deviceUid = usePlayerStore.getState().audioDevice): ResamplingSettings {
    return effectiveResampling(this.audioSetup, deviceUid)
  }

  /**
   * Output-format policy for decisions. "Never resample in exclusive mode" wins
   * over upsampling / fixed-rate policies, which would always resample.
   */
  private outputPolicy(deviceUid = usePlayerStore.getState().audioDevice): OutputFormatPolicy {
    const settings = this.currentResampling(deviceUid)
    if (useSettingsStore.getState().strictSampleRate) {
      return { ...DEFAULT_OUTPUT_POLICY, outputBitDepth: settings.outputBitDepth }
    }
    return {
      targetRate: settings.targetRate,
      fixedSampleRate: settings.fixedSampleRate,
      upsampling: settings.upsampling,
      maxOutputRate: settings.maxOutputRate,
      outputBitDepth: settings.outputBitDepth,
    }
  }

  private decidePlaybackFormat(track: TrackFormat, caps: DeviceCapabilities, deviceUid?: string | null): PlaybackDecision {
    return resolvePlaybackFormat(track, caps, this.outputPolicy(deviceUid ?? usePlayerStore.getState().audioDevice))
  }

  /** Push the effective resampler / dither settings to the engine (used for tracks prepared next). */
  private async syncResamplerConfig(deviceUid = usePlayerStore.getState().audioDevice) {
    await this.loadAudioSetup()
    await window.puros.audio.setResamplerConfig(toNativeResamplerConfig(this.currentResampling(deviceUid)))
      .catch((error: unknown) => console.warn('[Puros] Could not apply resampler settings:', error))
  }

  /**
   * In exclusive mode the output was opened at the format chosen for this track,
   * so the engine resamples a different source rate instead of reopening at it.
   */
  private async playNativeFile(filePath: string, track: Track | null = usePlayerStore.getState().currentTrack) {
    const state = usePlayerStore.getState()
    const allowResample = state.audioMode === 'exclusive' && !!state.playbackDecision
    const deemphasis = await this.shouldDeemphasize(track, filePath)
    return window.puros.audio.playFile(filePath, allowResample, deemphasis, this.currentDsdOutputRate,
      restoreSourceHint(track?.formatInfo))
  }

  /**
   * PCM → DSD for this track, as a DSD rate (0 = play PCM). Needs exclusive mode,
   * a DoP-capable output, and a volume control that is not DSP (DoP cannot be
   * attenuated digitally). DSD sources are converted only when remodulation is on.
   */
  private dsdOutputPlan(
    track: Track | null | undefined,
    caps: DeviceCapabilities | null | undefined,
    deviceUid: string | null | undefined = usePlayerStore.getState().audioDevice,
    audioMode: 'exclusive' | 'shared' | 'closed' = usePlayerStore.getState().audioMode,
  ): number {
    if (!track || !caps || audioMode !== 'exclusive' || !deviceUid || deviceUid === DEFAULT_DEVICE_ID) return 0
    if (isLiveRadioTrack(track) || useSettingsStore.getState().strictSampleRate) return 0
    const settings = this.currentResampling(deviceUid)
    if (track.formatInfo?.isDsd && !settings.dsdRemodulate) return 0
    if (this.resolveExclusiveVolumeMode(deviceUid, caps.hardwareVolume) === 'dsp') return 0
    return resolveDsdOutputRate(settings.dsdOutput, caps.dopCapability)
  }

  private dsdOutputDecision(source: TrackFormat, sourceFormatInfo: FormatInfo | null | undefined, dsdRate: number,
    deviceUid?: string | null): PlaybackDecision {
    const settings = this.currentResampling(deviceUid ?? usePlayerStore.getState().audioDevice)
    const modulator = DSD_MODULATORS.find((entry) => entry.id === settings.dsdModulator)?.label ?? settings.dsdModulator
    const originalSampleRate = sourceFormatInfo?.isDsd ? (sourceFormatInfo.dsdRate ?? sourceFormatInfo.sampleRate) : source.sampleRate
    return {
      mode: 'RESAMPLED',
      deviceSampleRate: dsdRate / 16,
      deviceBitDepth: 32,
      originalSampleRate,
      originalBitDepth: sourceFormatInfo?.isDsd ? 1 : source.bitDepth,
      dsdOutputRate: dsdRate,
      reason: `${sourceFormatInfo?.isDsd ? `${dsdRateName(originalSampleRate)} remodulated` : `PCM ${source.sampleRate / 1000}kHz`} → ` +
        `${dsdRateName(dsdRate)} (DoP): ${describeResampler(settings)} to ${DSD_INTERMEDIATE_RATE / 1000}kHz, ${modulator} modulator.`,
    }
  }

  /**
   * CD pre-emphasis applies to the local file the flag was written for (CUE
   * `FLAGS PRE` or a tag); streams and converted temp files never carry it.
   */
  private async shouldDeemphasize(track: Track | null | undefined, playbackTarget: string): Promise<boolean> {
    if (!track || this.currentResampling().deemphasis === 'off') return false
    if (isLiveRadioTrack(track) || track.streamId) return false
    const source = this.getTrackPlaybackPath(track)
    if (!source || source !== playbackTarget) return false
    return window.puros.audio.detectPreEmphasis(source, track.cueSheetPath ?? null, track.startOffsetMs ?? null)
      .catch(() => false)
  }

  /** DSD → PCM conversion follows the resampling settings and the output's rates. */
  private prepareLocalFile(
    filePath: string,
    formatInfo: FormatInfo | null | undefined,
    caps?: DeviceCapabilities | null,
    deviceUid?: string | null,
    sampleRateOverride?: number,
  ) {
    const options = formatInfo?.isDsd
      ? resolveDsdConversionOptions(
          this.currentResampling(deviceUid ?? usePlayerStore.getState().audioDevice),
          caps ?? usePlayerStore.getState().deviceCapabilities,
        )
      : null
    // Remodulation decodes DSD straight to the modulator's input rate; no ultrasonic filter needed there.
    const dsdOptions = options && sampleRateOverride
      ? { ...options, sampleRate: sampleRateOverride, filterHz: 0 }
      : options
    return window.puros.audio.prepareLocalFile(filePath, formatInfo, dsdOptions)
  }

  /** React to Audio Setup edits: leave a disabled output, re-evaluate limits and names. */
  private async handleAudioSetupChanged() {
    const store = usePlayerStore.getState()
    const deviceUid = store.audioDevice
    if (deviceUid && deviceUid !== DEFAULT_DEVICE_ID && !isDeviceEnabled(this.audioSetup, deviceUid)) {
      await this.setDevice(DEFAULT_DEVICE_ID, 'shared')
      this.showNotification('Output disabled in Audio Setup — switched to system default output')
      return
    }

    if (deviceUid && deviceUid !== DEFAULT_DEVICE_ID) {
      const devices = await window.puros.audio.listDevices().catch(() => [])
      const device = devices.find((entry) => !entry.isVirtual && entry.uid === deviceUid)
      if (device) usePlayerStore.getState().setDeviceName(this.deviceDisplayName(device))
    }
    await this.syncResamplerConfig()
    await this.refreshDeviceCapabilities()
  }

  private getSharedOnlyTransportLabel(device: AudioDevice | null | undefined): string | null {
    if (!device) return null
    return getExclusiveBlockedTransportLabel(getExclusiveBlockedTransportError(device.transportType))
  }

  private async persistAudioRoute(deviceUid: string, mode: 'exclusive' | 'shared') {
    await Promise.all([
      setStringSetting(AUDIO_DEVICE_SETTING_KEY, deviceUid),
      setStringSetting(AUDIO_MODE_SETTING_KEY, mode),
    ])
  }

  private clearDsdStartupFallbackTimer() {
    if (this.dsdStartupFallbackTimer) {
      clearTimeout(this.dsdStartupFallbackTimer)
      this.dsdStartupFallbackTimer = null
    }
  }

  private clearLiveRadioMetadataTimer() {
    if (this.liveRadioMetadataTimer) {
      clearTimeout(this.liveRadioMetadataTimer)
      this.liveRadioMetadataTimer = null
    }
  }

  private getLiveRadioStreamUrl(track: Track | null | undefined): string | null {
    if (!isLiveRadioTrack(track)) return null
    return track?.streamId ?? track?.playbackFilePath ?? track?.filePath ?? null
  }

  private stopLiveRadioSession(track: Track | null | undefined) {
    if (!isLiveRadioTrack(track)) return
    this.clearLiveRadioMetadataTimer()
    this.liveRadioReconnectAttempts = 0
    void window.puros.liveRadio.stopPlayback(track?.sourceId ?? null).catch(() => undefined)
  }

  private getLastFm() {
    return useLastFmStore.getState().getService()
  }

  /** Start listening to store changes and driving playback. */
  init() {
    if (this.unsubscribe) return

    // Open device on startup using saved preference or __default__
    this.initialDeviceOpen = this.ensureDeviceOpen()
    this.ipcUnsubscribers.push(
      useAudioSetupStore.subscribe((state, prev) => {
        if (state.loaded && prev.loaded && state.setup !== prev.setup) void this.handleAudioSetupChanged()
      }),
    )
    this.initMediaSession()
    this.ipcUnsubscribers.push(
      useWindowActivityStore.subscribe((state, prev) => {
        if (prev.activity === 'hidden' && state.activity !== 'hidden') this.catchUpAfterHidden()
      }),
    )

    // Fetch initial Bluetooth info and keep it updated via push events
    this.refreshBluetoothInfo()
    this.ipcUnsubscribers.push(
      window.puros.on('audio:bluetooth-info', (info: unknown) => {
        const nextInfo = info as import('../../electron/preload').BluetoothInfo
        const store = usePlayerStore.getState()
        const previousInfo = store.bluetoothInfo

        store.setBluetoothInfo(nextInfo)

        const shouldPauseForRouteChange =
          store.audioDevice === DEFAULT_DEVICE_ID &&
          store.isPlaying &&
          previousInfo?.isBluetooth &&
          !nextInfo.isBluetooth

        if (shouldPauseForRouteChange) {
          this.autoResumeAfterBluetoothReconnect = true
          store.pause()
          this.showNotification('Playback paused after Bluetooth output disconnected')
        } else if (
          this.autoResumeAfterBluetoothReconnect &&
          store.audioDevice === DEFAULT_DEVICE_ID &&
          !store.isPlaying &&
          !!store.currentTrack &&
          !previousInfo?.isBluetooth &&
          nextInfo.isBluetooth
        ) {
          this.autoResumeAfterBluetoothReconnect = false
          setTimeout(() => {
            const latest = usePlayerStore.getState()
            if (!latest.currentTrack || latest.isPlaying) return
            latest.play()
            this.showNotification('Playback resumed on Bluetooth output reconnect')
          }, 350)
        }
      }),
    )

    // Listen for mode change events from main process
    this.ipcUnsubscribers.push(
      window.puros.on('audio:mode-changed', (mode: unknown) => {
        const store = usePlayerStore.getState()
        store.setAudioMode(mode as 'exclusive' | 'shared' | 'closed')
        store.setOutputMode(
          mode === 'exclusive' ? 'EXCLUSIVE' : mode === 'shared' ? 'SHARED' : 'SHARED'
        )
      }),
    )

    // When the system default device changes while "__default__" is active,
    // re-open on the new device and resume if a track was playing.
    this.ipcUnsubscribers.push(
      window.puros.on('audio:default-device-changed', (data: unknown) => {
        const { name } = data as { uid: string; name: string }
        const store = usePlayerStore.getState()

        // Update the resolved name immediately so the UI refreshes
        store.setResolvedDeviceName(name || null)

        if (store.audioDevice === DEFAULT_DEVICE_ID) {
          console.log(`[Puros] System default changed → reopening on new device: ${name}`)
          void this.setDevice(DEFAULT_DEVICE_ID, 'shared')
        }
      }),
    )

    this.ipcUnsubscribers.push(
      window.puros.on('player:media-command', (command: unknown) => {
        const store = usePlayerStore.getState()
        switch (command) {
          case 'play':
            if (store.currentTrack) store.play()
            break
          case 'pause':
            if (store.currentTrack) store.pause()
            break
          case 'play-pause':
            if (store.currentTrack) store.togglePlayPause()
            break
          case 'next':
            store.next()
            break
          case 'previous':
            store.previous()
            break
          case 'toggle-shuffle':
            store.toggleShuffle()
            break
          case 'cycle-repeat':
            store.cycleRepeat()
            break
          case 'stop':
            void this.cancelActiveProgressiveSessions()
            store.pause()
            store.seek(0)
            break
          default:
            break
        }
      }),
    )

    this.ipcUnsubscribers.push(window.puros.provider.onEvent((envelope) => {
      const active = this.activeProgressivePlayback
      if (!active || active.session.manifest.provider !== envelope.providerId) return
      if (envelope.event.type === 'playback.progress') {
        const event = envelope.event.progress
        if (active.session.sessionId !== event.sessionId) return
        active.session = {
          ...active.session,
          state: event.state as StreamingSessionState,
          bytesDownloaded: event.bytesCompleted ?? active.session.bytesDownloaded,
          completedSegments: event.itemsCompleted ?? active.session.completedSegments,
          totalSegments: event.itemsTotal ?? active.session.totalSegments,
          downloadRate: event.bytesPerSecond ?? active.session.downloadRate,
          estimatedRemaining: event.estimatedRemainingMs == null ? null : event.estimatedRemainingMs / 1000,
          playbackStarted: event.playbackStarted,
          playbackRevision: event.revision,
        }
        if (event.percent != null) usePlayerStore.getState().setBufferProgress(Math.max(0, Math.min(1, event.percent / 100)))
        this.updateStreamingBufferHealth(active)
      } else if (envelope.event.type === 'playback.session') {
        const event = envelope.event.session
        if (active.session.sessionId !== event.sessionId) return
        active.session = {
          ...active.session,
          state: event.state as StreamingSessionState,
          playbackStarted: event.playbackStarted,
          playbackRevision: event.revision,
          error: event.error?.message,
        }
        if (event.artifactPath) active.playbackPath = event.artifactPath
        if (event.state === 'completed' && active.trackIdentity) {
          usePlayerStore.getState().markPlaybackSourceComplete(active.trackIdentity, active.playbackPath)
        }
        if (event.state === 'completed' && (event.sourceFormat || event.format)
          && getTrackIdentity(usePlayerStore.getState().currentTrack) === active.trackIdentity) {
          // Display only: e.g. the average bitrate known once the whole file is on disk.
          usePlayerStore.getState().setFormatInfo(event.sourceFormat ?? event.format!)
        }
        if (event.state === 'completed') void this.finishProgressivePlayback(active)
      }
    }))

    this.ipcUnsubscribers.push(
      window.puros.liveRadio.onPlaybackStatus((status) => {
        const store = usePlayerStore.getState()
        const track = store.currentTrack
        if (!track || !isLiveRadioTrack(track)) return
        const stationId = track.sourceId
        if (!stationId || stationId !== status.stationId) return
        if (status.state === 'error') {
          void this.reconnectLiveRadio(track, status.message ?? 'stream process failed')
          return
        }
        if (status.state === 'reconnecting') {
          store.setNotification('Reconnecting live radio...')
          return
        }
        if (status.state === 'playing') {
          store.setNotification(null)
          store.setAudioError(null)
        }
      }),
    )

    this.unsubscribe = usePlayerStore.subscribe((state, prev) => {
      const currentTrackIdentity = getTrackIdentity(state.currentTrack)
      const previousTrackIdentity = getTrackIdentity(prev.currentTrack)
      const queueEntryChanged = state.queueIndex !== prev.queueIndex && state.currentTrack !== prev.currentTrack
      const playbackRequestChanged = state.playbackRequestId !== prev.playbackRequestId
      const playbackTrackChanged = currentTrackIdentity !== previousTrackIdentity || queueEntryChanged || playbackRequestChanged

      // Track changed — play the new file
      if (playbackTrackChanged) {
        console.info('[PlaylistDebug] subscriber playbackTrackChanged', {
          currentTrackIdentity,
          previousTrackIdentity,
          queueEntryChanged,
          playbackRequestChanged,
          queueIndex: state.queueIndex,
          prevQueueIndex: prev.queueIndex,
          currentTitle: state.currentTrack?.title ?? null,
          prevTitle: prev.currentTrack?.title ?? null,
          willSuppress: state.currentTrack === this.suppressPlayTrackForTrack,
        })
        void this.cancelActiveProgressiveSessions()
        this.activeProgressivePlayback = null
        if (prev.currentTrack) {
          if (!isLiveRadioTrack(prev.currentTrack)) {
            this.getLastFm()?.endTrack()
          }
          this.stopLiveRadioSession(prev.currentTrack)
        }
        this.autoResumeAfterBluetoothReconnect = false
        usePlayerStore.getState().setBufferProgress(null)
        if (!state.currentTrack) {
          this.pendingRestoreIdentity = null
          this.playToken++
          this.stopPolling()
          this.clearNativeQueueState()
          this.activePlaybackTrackId = null
          void window.puros.audio.stopPlayback().catch(() => {
            // The audio device may already be closed during shutdown.
          })
        } else if (this.restoringSession) {
          // Restored session: show the track paused and load it on the first play.
          this.playToken++
          this.stopPolling()
          this.clearNativeQueueState()
          this.activePlaybackTrackId = null
        } else {
          this.pendingRestoreIdentity = null
          if (state.currentTrack === this.suppressPlayTrackForTrack) {
            this.suppressPlayTrackForTrack = null
            this.nativeQueuedTrackId = null
            this.nativeQueuedTrack = null
            void this.refreshStateFromNativePlayback(state.currentTrack)
          } else {
            if ((queueEntryChanged || playbackRequestChanged) && currentTrackIdentity === previousTrackIdentity) {
              console.info('[Puros] Playback request changed without identity change; starting track explicitly')
            }
            this.playTrack(state)
          }
        }
      }

      // Play/pause toggled
      if (state.isPlaying !== prev.isPlaying && state.currentTrack) {
        if (state.isPlaying) {
          const streamingState = this.activeProgressivePlayback?.session.state
          if (this.pendingRestoreIdentity && this.pendingRestoreIdentity === currentTrackIdentity) {
            this.pendingRestoreIdentity = null
            this.pendingStartPosition = isLiveRadioTrack(state.currentTrack) ? 0 : state.position
            void this.playTrack(state)
          } else if (
            streamingState === StreamingSessionState.Cancelled
            || streamingState === StreamingSessionState.Failed
          ) {
            void this.playTrack(state)
          } else {
            if (isLiveRadioTrack(state.currentTrack)) {
              void this.playTrack(state)
            } else {
              window.puros.audio.resume()
              this.getLastFm()?.resumeTrack()
              this.startPolling()
            }
          }
        } else {
          window.puros.audio.pause()
          usePlayerStore.getState().setProcessingSpeed(null)
          if (isLiveRadioTrack(state.currentTrack)) {
            this.stopLiveRadioSession(state.currentTrack)
          } else {
            this.getLastFm()?.pauseTrack()
          }
          this.stopPolling()
        }
      }

      // Volume changed — routed to system mixer, DAC hardware, or exclusive DSP volume
      if (state.volume !== prev.volume) {
        if (!this.volumeFromEngine) this.lastLocalVolumeChangeAt = Date.now()
        this.applyVolume(state)
      }

      if (state.audioMode !== prev.audioMode || state.audioDevice !== prev.audioDevice) {
        void this.syncVolumeControl()
      }

      // Seek
      if (
        state.position !== prev.position &&
        tracksShareIdentity(state.currentTrack, prev.currentTrack) &&
        !playbackTrackChanged &&
        !this.seekPending &&
        !isLiveRadioTrack(state.currentTrack) &&
        // Not loaded yet: playTrack() starts from the store position instead.
        this.pendingRestoreIdentity !== currentTrackIdentity
      ) {
        const drift = Math.abs(state.position - prev.position)
        if (drift > 1.5) {
          this.seekPending = true
          const targetPosition = this.getCueSlice(state.currentTrack)
            ? this.getCueSlice(state.currentTrack)!.startSeconds + state.position
            : state.position
          this.getLastFm()?.updatePosition(state.position)
          const activeStreaming = this.activeProgressivePlayback
          if (
            activeStreaming?.session.state === StreamingSessionState.Completed
            && !activeStreaming.finalFileReopened
          ) {
            void this.seekCompletedProgressivePlayback(activeStreaming, targetPosition)
          } else if (
            activeStreaming
            && activeStreaming.session.playbackRevision > activeStreaming.openedRevision
          ) {
            void this.seekRefreshedProgressivePlayback(activeStreaming, targetPosition)
          } else {
            void window.puros.audio.seek(targetPosition)
              .catch((error) => {
                console.warn('[Puros] Seek failed:', error)
              })
              .finally(() => {
                this.seekPending = false
              })
          }
        }
      }

      if (
        playbackTrackChanged ||
        state.currentTrack?.coverUrl !== prev.currentTrack?.coverUrl ||
        state.currentTrack?.artworkUrl !== prev.currentTrack?.artworkUrl ||
        state.duration !== prev.duration
      ) {
        this.syncMediaSessionMetadata(state.currentTrack)
      }

      if (
        playbackTrackChanged ||
        state.isPlaying !== prev.isPlaying ||
        state.duration !== prev.duration ||
        Math.abs(state.position - prev.position) >= 1
      ) {
        this.syncMediaSessionPlayback(state)
      }

      this.syncMediaSessionBridge(state)

      if (
        playbackTrackChanged ||
        state.isPlaying !== prev.isPlaying ||
        state.queueIndex !== prev.queueIndex ||
        state.shuffle !== prev.shuffle ||
        state.repeat !== prev.repeat ||
        state.queue !== prev.queue ||
        state.shuffledQueue !== prev.shuffledQueue
      ) {
        this.maybeQueueUpcomingTrack(state)
      }
    })

    const initialState = usePlayerStore.getState()
    this.syncMediaSessionMetadata(initialState.currentTrack)
    this.syncMediaSessionPlayback(initialState)
    this.syncMediaSessionBridge(initialState)
  }

  private async refreshBluetoothInfo() {
    try {
      const info = await window.puros.audio.getBluetoothInfo()
      usePlayerStore.getState().setBluetoothInfo(info)
    } catch {
      // Not critical — UI simply won't show Bluetooth state
    }
  }

  /**
   * Show a transient info notification (auto-clears after 5 s).
   */
  private showNotification(msg: string) {
    if (this.notificationTimer) clearTimeout(this.notificationTimer)
    usePlayerStore.getState().setNotification(msg)
    this.notificationTimer = setTimeout(() => {
      usePlayerStore.getState().setNotification(null)
      this.notificationTimer = null
    }, 5000)
  }

  private getMediaSession(): MediaSession | null {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null
    return navigator.mediaSession
  }

  private initMediaSession() {
    const mediaSession = this.getMediaSession()
    if (!mediaSession) return

    this.ensureMediaSessionBridge()

    const bindAction = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        mediaSession.setActionHandler(action, handler)
      } catch {
        // Older Chromium builds may not support the full action set.
      }
    }

    bindAction('play', () => {
      const store = usePlayerStore.getState()
      if (store.currentTrack) store.play()
    })
    bindAction('pause', () => {
      const store = usePlayerStore.getState()
      if (store.currentTrack) store.pause()
    })
    bindAction('previoustrack', () => {
      usePlayerStore.getState().previous()
    })
    bindAction('nexttrack', () => {
      usePlayerStore.getState().next()
    })
    bindAction('seekbackward', (details) => {
      const store = usePlayerStore.getState()
      const offset = details.seekOffset ?? 10
      store.seek(Math.max(0, store.position - offset))
    })
    bindAction('seekforward', (details) => {
      const store = usePlayerStore.getState()
      const offset = details.seekOffset ?? 10
      const max = store.duration > 0 ? store.duration : Number.MAX_SAFE_INTEGER
      store.seek(Math.min(max, store.position + offset))
    })
    bindAction('seekto', (details) => {
      if (typeof details.seekTime !== 'number') return
      const store = usePlayerStore.getState()
      const max = store.duration > 0 ? store.duration : details.seekTime
      store.seek(Math.max(0, Math.min(details.seekTime, max)))
    })
    bindAction('stop', () => {
      void this.cancelActiveProgressiveSessions()
      const store = usePlayerStore.getState()
      store.pause()
      store.seek(0)
    })
  }

  private ensureMediaSessionBridge() {
    if (typeof window === 'undefined' || this.mediaSessionBridgeElement) return

    const AudioContextCtor = window.AudioContext
    if (!AudioContextCtor) return

    const bridgeElement = new Audio()
    bridgeElement.autoplay = false
    bridgeElement.preload = 'auto'
    bridgeElement.setAttribute('playsinline', 'true')
    bridgeElement.setAttribute('aria-hidden', 'true')
    bridgeElement.style.display = 'none'

    try {
      const context = new AudioContextCtor()
      const destination = context.createMediaStreamDestination()
      const source = context.createConstantSource()
      const gain = context.createGain()
      gain.gain.value = 0
      source.connect(gain)
      gain.connect(destination)
      source.start()
      bridgeElement.srcObject = destination.stream

      this.mediaSessionBridgeContext = context
      this.mediaSessionBridgeElement = bridgeElement
    } catch (err) {
      console.warn('[Puros] Failed to initialize Media Session bridge:', err)
    }
  }

  private syncMediaSessionMetadata(
    track: ReturnType<typeof usePlayerStore.getState>['currentTrack'],
  ) {
    if (!track) {
      void window.puros.player.clearNowPlaying().catch(() => {
        // Native now playing bridge is best effort only.
      })
    } else {
      const artworkUrl = track.coverUrl ?? track.artworkUrl ?? null
      void window.puros.player.setNowPlaying({
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: Math.max(track.duration, 0),
        position: 0,
        artworkUrl,
        discordArtworkUrl: track.discordArtworkUrl ?? null,
        sourceType: track.sourceType ?? null,
        sourceId: track.sourceId ?? null,
        provider: track.provider ?? null,
        catalogTrackId: track.catalogTrackId ?? null,
      }).catch(() => {
        // Native now playing bridge is best effort only.
      })
    }

    const mediaSession = this.getMediaSession()
    if (!mediaSession) return

    if (!track) {
      mediaSession.metadata = null
      return
    }

    try {
      const artworkSrc = track.coverUrl ?? track.artworkUrl ?? undefined
      mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: isMediaSessionArtworkSrc(artworkSrc) ? [{ src: artworkSrc }] : [],
      })
    } catch {
      // Best effort only — playback must not depend on Media Session support.
    }
  }

  private syncMediaSessionPlayback(state: ReturnType<typeof usePlayerStore.getState>) {
    void window.puros.player.updatePlaybackState({
      state: state.currentTrack
        ? (state.isPlaying ? 'playing' : 'paused')
        : 'stopped',
      position: Math.max(0, state.position),
      duration: Math.max(0, state.duration),
    }).catch(() => {
      // Native now playing bridge is best effort only.
    })

    const mediaSession = this.getMediaSession()
    if (!mediaSession) return

    mediaSession.playbackState = state.currentTrack
      ? (state.isPlaying ? 'playing' : 'paused')
      : 'none'

    if (!state.currentTrack || !Number.isFinite(state.duration) || state.duration <= 0) {
      this.lastMediaSessionPositionSync = 0
      this.lastMediaSessionPosition = -1
      return
    }

    const now = Date.now()
    const position = Math.max(0, Math.min(state.position, state.duration))
    const shouldSyncPosition =
      (Math.abs(position - this.lastMediaSessionPosition) >= 1 ||
        now - this.lastMediaSessionPositionSync >= 1000)

    if (!shouldSyncPosition) return

    try {
      mediaSession.setPositionState({
        duration: Math.max(state.duration, 0.001),
        playbackRate: 1,
        position,
      })
      this.lastMediaSessionPositionSync = now
      this.lastMediaSessionPosition = position
    } catch {
      // Some environments support metadata/commands without position updates.
    }
  }

  private syncMediaSessionBridge(state: ReturnType<typeof usePlayerStore.getState>) {
    const bridge = this.mediaSessionBridgeElement
    const context = this.mediaSessionBridgeContext
    if (!bridge || !context) return

    const shouldBeActive = !!state.currentTrack

    if (!shouldBeActive) {
      if (!bridge.paused) bridge.pause()
      return
    }

    if (state.isPlaying) {
      const resumePlayback = async () => {
        try {
          if (context.state === 'suspended') {
            await context.resume()
          }
          if (bridge.paused) {
            await bridge.play()
          }
        } catch (err) {
          console.warn('[Puros] Failed to activate Media Session bridge:', err)
        }
      }
      void resumePlayback()
      return
    }

    if (!bridge.paused) {
      bridge.pause()
    }
  }

  /**
   * Open the audio device on startup applying the saved preference.
   *
   * Priority:
   *   1. Saved device UID exists AND device is still connected → use it
   *   2. Saved UID is "__default__" → open default
   *   3. No saved preference → open "__default__"
   *   4. Saved device no longer connected → fall back to "__default__" + toast
   */
  private async ensureDeviceOpen() {
    const store = usePlayerStore.getState()
    if (store.audioMode !== 'closed') return

    // Read persisted preference
    const [savedId, savedMode, audioSetup] = await Promise.all([
      getStringSetting(AUDIO_DEVICE_SETTING_KEY),
      getStringSetting(AUDIO_MODE_SETTING_KEY),
      this.loadAudioSetup(),
      this.loadVolumeModes(),
    ])

    const devices = await window.puros.audio.listDevices()
    const physicalDevices = devices.filter(d => !d.isVirtual)

    let targetUid = DEFAULT_DEVICE_ID
    let fallbackToast: string | null = null

    if (savedId && savedId !== DEFAULT_DEVICE_ID) {
      // Saved physical device
      const found = physicalDevices.find(d => d.uid === savedId)
      if (found && isDeviceEnabled(audioSetup, savedId)) {
        targetUid = savedId
      } else {
        // Device no longer connected or disabled in Audio Setup — fall back
        targetUid = DEFAULT_DEVICE_ID
        fallbackToast = found
          ? 'Previous device is disabled in Audio Setup — switched to system default output'
          : 'Previous device unavailable — switched to system default output'
      }
    } else {
      // null (first launch) or "__default__"
      targetUid = DEFAULT_DEVICE_ID
    }

    await this.syncResamplerConfig(targetUid)

    const preferredMode: 'exclusive' | 'shared' = targetUid === DEFAULT_DEVICE_ID
      ? 'shared'
      : resolvePreferredAudioMode(
          getDeviceConfig(audioSetup, targetUid),
          savedMode === 'exclusive' ? 'exclusive' : 'shared',
        )
    const targetDevice = physicalDevices.find((device) => device.uid === targetUid)
    const forcedSharedTransport = this.getSharedOnlyTransportLabel(targetDevice)
    const effectivePreferredMode: 'exclusive' | 'shared' =
      preferredMode === 'exclusive' && forcedSharedTransport ? 'shared' : preferredMode

    let openedMode: 'exclusive' | 'shared' = 'shared'
    let result: { success: boolean; error?: string }

    if (effectivePreferredMode === 'exclusive') {
      if (targetDevice) {
        const { sampleRate, bitDepth } = this.getPreferredExclusiveFormat(targetDevice)
        await this.primeExclusiveVolume(targetUid, targetDevice.hardwareVolume)
        result = await window.puros.audio.openExclusive(targetUid, sampleRate, bitDepth)
        if (result.success) {
          openedMode = 'exclusive'
        } else {
          result = await window.puros.audio.openShared(targetUid)
        }
      } else {
        result = await window.puros.audio.openShared(targetUid)
      }
    } else {
      result = await window.puros.audio.openShared(targetUid)
    }

    if (result.success) {
      store.setAudioMode(openedMode)
      store.setOutputMode(openedMode === 'exclusive' ? 'EXCLUSIVE' : 'SHARED')
      store.setAudioError(null)
      store.setAudioDevice(targetUid)
      store.setDeviceName(
        targetUid === DEFAULT_DEVICE_ID ? 'Default System Settings' :
          targetDevice ? this.deviceDisplayName(targetDevice) : targetUid
      )
      await this.persistAudioRoute(targetUid, openedMode)
      try {
        const fmt = await window.puros.audio.getCurrentFormat()
        if (fmt.sampleRate > 0) store.setDeviceFormat(fmt)
      } catch {
        // Device format is best effort during startup.
      }
      await this.refreshDeviceCapabilities()
    }

    if (fallbackToast) {
      this.showNotification(fallbackToast)
    } else if (preferredMode === 'exclusive' && forcedSharedTransport) {
      this.showNotification(
        `${forcedSharedTransport} outputs use shared mode on macOS — restored in shared mode`
      )
    } else if (preferredMode === 'exclusive' && openedMode !== 'exclusive') {
      this.showNotification(
        'Could not restore exclusive mode — fell back to shared mode'
      )
    }
  }

  /**
   * Fetch current device capabilities and update the store.
   * Also syncs resolvedDeviceName when "__default__" is active.
   */
  private async refreshDeviceCapabilities() {
    const store = usePlayerStore.getState()
    const deviceUid = store.audioDevice ?? DEFAULT_DEVICE_ID

    try {
      await this.loadAudioSetup()
      const devices = await window.puros.audio.listDevices()
      const physicalDevices = devices.filter(d => !d.isVirtual)

      let targetDevice = physicalDevices.find(d => d.uid === deviceUid)

      if (deviceUid === DEFAULT_DEVICE_ID) {
        // Use the resolved physical device for capability reporting
        const virtualEntry = devices.find(d => d.isVirtual)
        store.setResolvedDeviceName(virtualEntry?.resolvedName || null)
        targetDevice = physicalDevices.find(d => d.uid === virtualEntry?.resolvedUid)
          ?? physicalDevices[0]
      }

      if (targetDevice) {
        const caps = this.deviceCapabilities(targetDevice)
        store.setDeviceCapabilities(caps)
        return caps
      }
    } catch {
      // Device enumeration failed
    }
    return null
  }

  /**
   * Build a TrackFormat from the current track's formatInfo.
   */
  private getTrackFormat(state: ReturnType<typeof usePlayerStore.getState>): TrackFormat | null {
    const track = state.currentTrack
    const fi = track?.formatInfo
    if (!fi) return null
    return {
      sampleRate: fi.sampleRate,
      bitDepth: fi.bitDepth,
      channels: fi.channels,
      codec: fi.format,
    }
  }

  private toTrackFormat(formatInfo: FormatInfo | null | undefined): TrackFormat | null {
    if (!formatInfo) return null
    return {
      sampleRate: formatInfo.sampleRate,
      bitDepth: formatInfo.bitDepth,
      channels: formatInfo.channels,
      codec: formatInfo.format,
    }
  }

  private createSharedPlaybackDecision(
    trackFormat: TrackFormat | null | undefined,
    deviceFormat: DeviceFormatSnapshot,
  ): PlaybackDecision | null {
    if (!trackFormat || !deviceFormat || deviceFormat.sampleRate <= 0) return null

    const deviceBitDepth =
      deviceFormat.bitDepth > 0
        ? deviceFormat.bitDepth
        : (trackFormat.bitDepth > 0 ? trackFormat.bitDepth : 16)

    if (trackFormat.sampleRate === deviceFormat.sampleRate && isLossyCodec(trackFormat.codec)) {
      return {
        mode: 'NATIVE_RATE',
        deviceSampleRate: deviceFormat.sampleRate,
        deviceBitDepth,
        reason:
          `Shared mode at the ${deviceFormat.sampleRate / 1000}kHz decode rate of this lossy ${trackFormat.codec} source via the macOS system mixer. ` +
          'No sample-rate conversion is required; bit-perfect does not apply to lossy sources.',
      }
    }

    if (trackFormat.sampleRate === deviceFormat.sampleRate) {
      return {
        mode: 'BIT_PERFECT',
        deviceSampleRate: deviceFormat.sampleRate,
        deviceBitDepth,
        reason:
          `Shared mode at ${deviceFormat.sampleRate / 1000}kHz via the macOS system mixer. ` +
          'No sample-rate conversion is required, but playback is not bit-perfect.',
      }
    }

    return {
      mode: 'RESAMPLED',
      deviceSampleRate: deviceFormat.sampleRate,
      deviceBitDepth,
      originalSampleRate: trackFormat.sampleRate,
      originalBitDepth: trackFormat.bitDepth,
      reason:
        `Shared mode — macOS system mixer converts ${trackFormat.sampleRate / 1000}kHz ` +
        `to ${deviceFormat.sampleRate / 1000}kHz before output.`,
    }
  }

  private getDsdCarrierRate(formatInfo: FormatInfo | null | undefined): number | null {
    if (!formatInfo?.isDsd) return null
    const dsdRate = formatInfo.dsdRate ?? formatInfo.sampleRate
    if (!dsdRate || dsdRate % 16 !== 0) return null
    return dsdRate / 16
  }

  private getDsdCarrierTrackFormat(formatInfo: FormatInfo | null | undefined): TrackFormat | null {
    const carrierRate = this.getDsdCarrierRate(formatInfo)
    if (!carrierRate || !formatInfo) return null
    return {
      sampleRate: carrierRate,
      bitDepth: 32,
      channels: 2,
      codec: 'DoP',
    }
  }

  private getRequiredDopCapability(
    formatInfo: FormatInfo | null | undefined,
  ): 'DoP64' | 'DoP128' | 'DoP256' | 'FallbackPCM' {
    if (!formatInfo?.isDsd) return 'FallbackPCM'
    const dsdRate = formatInfo.dsdRate ?? formatInfo.sampleRate ?? 0
    if (dsdRate >= 11_289_600) return 'DoP256'
    if (dsdRate >= 5_644_800) return 'DoP128'
    if (dsdRate >= 2_822_400) return 'DoP64'
    return 'FallbackPCM'
  }

  private createDsdPcmFallbackDecision(
    sourceFormat: FormatInfo | null | undefined,
    deviceDecision: PlaybackDecision | null,
    fallbackFormat: FormatInfo | null | undefined,
  ): PlaybackDecision | null {
    if (!sourceFormat?.isDsd) return deviceDecision

    const originalSampleRate = sourceFormat.dsdRate ?? sourceFormat.sampleRate
    const originalBitDepth = sourceFormat.bitDepth > 0 ? sourceFormat.bitDepth : 1
    const deviceSampleRate =
      deviceDecision?.deviceSampleRate ??
      fallbackFormat?.sampleRate ??
      sourceFormat.sampleRate
    const deviceBitDepth =
      deviceDecision?.deviceBitDepth ??
      fallbackFormat?.bitDepth ??
      32

    return {
      mode: 'RESAMPLED',
      deviceSampleRate,
      deviceBitDepth,
      originalSampleRate,
      originalBitDepth,
      reason: `DSD source converted to PCM fallback at ${deviceSampleRate / 1000}kHz / ${deviceBitDepth}bit${deviceDecision?.reason ? `. ${deviceDecision.reason}` : ' (not bit-perfect).'}`,
    }
  }

  private isActiveDeviceReadyForNativeDop(
    formatInfo: FormatInfo | null | undefined,
    deviceFormat: DeviceFormatSnapshot,
  ): boolean {
    const carrierRate = this.getDsdCarrierRate(formatInfo)
    if (!carrierRate || !deviceFormat) return false
    return deviceFormat.sampleRate === carrierRate && deviceFormat.bitDepth >= 32 && deviceFormat.channels >= 2
  }

  /** Tells the seek bar which file the engine reads for `track`. */
  private publishPlaybackSource(track: Track, path: string, growing: boolean) {
    const trackIdentity = getTrackIdentity(track)
    if (!trackIdentity || isLiveRadioTrack(track) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      usePlayerStore.getState().setPlaybackSource(null)
      return
    }
    const cueSlice = this.getCueSlice(track)
    usePlayerStore.getState().setPlaybackSource({
      trackIdentity,
      path,
      growing,
      startSeconds: cueSlice?.startSeconds ?? 0,
      durationSeconds: cueSlice?.endSeconds != null ? cueSlice.durationSeconds : null,
    })
  }

  private getTrackPlaybackPath(track: { playbackFilePath?: string | null; filePath?: string | null } | null | undefined): string | null {
    if (!track) return null
    return track.playbackFilePath ?? track.filePath ?? null
  }

  private getCueSlice(track: {
    playbackFilePath?: string | null
    startOffsetMs?: number | null
    endOffsetMs?: number | null
    duration?: number | null
  } | null | undefined): CueSlice | null {
    if (!track?.playbackFilePath) return null
    const startOffsetMs = Math.max(0, track.startOffsetMs ?? 0)
    const endOffsetMs = track.endOffsetMs ?? null
    if (startOffsetMs <= 0 && endOffsetMs == null) return null
    const durationSeconds = Math.max(
      0,
      (endOffsetMs != null ? endOffsetMs - startOffsetMs : Math.round((track.duration ?? 0) * 1000)) / 1000,
    )
    return {
      startSeconds: startOffsetMs / 1000,
      endSeconds: endOffsetMs != null ? endOffsetMs / 1000 : null,
      durationSeconds,
    }
  }

  private isCueSlicedTrack(track: {
    playbackFilePath?: string | null
    startOffsetMs?: number | null
    endOffsetMs?: number | null
  } | null | undefined): boolean {
    return this.getCueSlice(track) !== null
  }

  private async prepareDsdPcmFallback(
    track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>,
  ): Promise<ResolvedPlaybackTarget | null> {
    const playbackPath = this.getTrackPlaybackPath(track)
    if (!playbackPath || !track.formatInfo?.isDsd) return null
    const prepared = await this.prepareLocalFile(playbackPath, track.formatInfo)
    return {
      playbackTarget: prepared.playbackPath,
      playbackFormatInfo: prepared.outputFormat ?? track.formatInfo ?? null,
      decisionFormat: this.toTrackFormat(prepared.outputFormat) ?? this.toTrackFormat(track.formatInfo),
    }
  }

  private async switchCurrentDsdTrackToExclusivePcmFallback(
    track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>,
    caps: DeviceCapabilities | null,
  ): Promise<boolean> {
    const store = usePlayerStore.getState()
    if (!track.formatInfo?.isDsd) return false
    if (!tracksShareIdentity(store.currentTrack, track)) return false
    if (store.audioMode !== 'exclusive' || !store.audioDevice || store.audioDevice === DEFAULT_DEVICE_ID) {
      return false
    }

    const fallbackTarget = await this.prepareDsdPcmFallback(track).catch(() => null)
    if (!fallbackTarget?.decisionFormat || !caps) return false

    const fallbackDecision = this.createDsdPcmFallbackDecision(
      track.formatInfo,
      this.decidePlaybackFormat(fallbackTarget.decisionFormat, caps),
      fallbackTarget.playbackFormatInfo,
    )
    if (!fallbackDecision) return false

    usePlayerStore.getState().setPlaybackDecision(fallbackDecision)
    await this.openExclusiveAtDecision(store.audioDevice, fallbackDecision, {
      allowSharedFallback: false,
    })

    const playResult = await this.playNativeFile(fallbackTarget.playbackTarget)
    if (!playResult.success) return false

    const cueSlice = this.getCueSlice(track)
    if (cueSlice && cueSlice.startSeconds > 0) {
      await window.puros.audio.seek(cueSlice.startSeconds)
    }

    const [duration, fmt] = await Promise.all([
      window.puros.audio.getDuration().catch(() => 0),
      window.puros.audio.getCurrentFormat().catch(() => null),
    ])

    const latest = usePlayerStore.getState()
    if (!tracksShareIdentity(latest.currentTrack, track)) return true
    latest.setDuration(cueSlice ? cueSlice.durationSeconds : (duration > 0 ? duration : track.duration))
    if (fmt && fmt.sampleRate > 0) latest.setDeviceFormat(fmt)
    latest.setPosition(0)
    latest.play()
    this.showNotification('Playing DSD via exclusive PCM fallback (not bit-perfect)')
    this.maybeQueueUpcomingTrack(latest)
    this.startPolling()
    return true
  }

  private scheduleDsdExclusiveStartupFallback(
    track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>,
    caps: DeviceCapabilities | null,
    usedDsdPcmFallback: boolean,
  ) {
    this.clearDsdStartupFallbackTimer()
    const store = usePlayerStore.getState()
    if (!track.formatInfo?.isDsd || usedDsdPcmFallback || store.audioMode !== 'exclusive') return

    const token = this.playToken
    this.dsdStartupFallbackTimer = setTimeout(async () => {
      this.dsdStartupFallbackTimer = null
      if (token !== this.playToken) return

      const latest = usePlayerStore.getState()
      if (!latest.isPlaying || !tracksShareIdentity(latest.currentTrack, track)) return

      const [position, duration] = await Promise.all([
        window.puros.audio.getPosition().catch(() => 0),
        window.puros.audio.getDuration().catch(() => 0),
      ])
      if (token !== this.playToken) return
      if (position > 0.05 || duration <= 0) return

      console.warn(`[Puros] Native DSD exclusive start appears silent for ${track.title}, falling back to exclusive PCM`)
      await this.switchCurrentDsdTrackToExclusivePcmFallback(track, caps)
    }, 1500)
  }

  private canUseNativeDop(
    track: { filePath?: string | null; formatInfo?: FormatInfo | null },
    caps: DeviceCapabilities | null,
    audioMode: 'exclusive' | 'shared' | 'closed',
    deviceUid: string | null | undefined,
  ): boolean {
    const playbackPath = this.getTrackPlaybackPath(track)
    if (!playbackPath || !track.formatInfo?.isDsd) return false
    if (audioMode !== 'exclusive') return false
    if (!deviceUid || deviceUid === DEFAULT_DEVICE_ID) return false
    const carrierRate = this.getDsdCarrierRate(track.formatInfo)
    if (!carrierRate || !caps) return false
    // DoP cannot be attenuated digitally without destroying the DSD stream; DSP volume plays DSD as PCM.
    if (this.resolveExclusiveVolumeMode(deviceUid, caps.hardwareVolume) === 'dsp') return false
    const requiredCapability = this.getRequiredDopCapability(track.formatInfo)
    const capabilityRank = {
      FallbackPCM: 0,
      DoP64: 1,
      DoP128: 2,
      DoP256: 3,
    } as const
    if (capabilityRank[caps.dopCapability] < capabilityRank[requiredCapability]) return false
    return (caps.dopCarrierFormats ?? caps.supportedFormats).some((format) =>
      !format.isFloat &&
      format.bitDepth === 32 &&
      format.sampleRate === carrierRate &&
      format.channels >= 2
    )
  }

  private getUpcomingQueuedTracks(
    state: ReturnType<typeof usePlayerStore.getState>,
    limit = NATIVE_QUEUE_LOOKAHEAD,
  ) {
    const { queue, shuffledQueue, queueIndex, shuffle, repeat } = state
    if (repeat === 'one') return []
    const activeQueue = shuffle ? shuffledQueue : queue
    if (activeQueue.length === 0 || queueIndex < 0) return []

    const upcoming: typeof activeQueue = []
    let nextIndex = queueIndex + 1

    while (upcoming.length < limit) {
      if (nextIndex >= activeQueue.length) {
        if (repeat === 'all') {
          nextIndex = 0
        } else {
          break
        }
      }

      if (nextIndex === queueIndex) break

      const track = activeQueue[nextIndex]
      // The store's next() skips these too, so gapless handoff stays in step.
      if (track && !track.unavailableReason) {
        upcoming.push(track)
      }
      nextIndex += 1
    }

    return upcoming
  }

  private async resolveQueueTarget(
    track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>,
  ): Promise<{ playbackTarget: string; formatInfo: FormatInfo | null; sourceFormatInfo?: FormatInfo | null } | null> {
    // Resolve a lightweight placeholder just-in-time before prefetching the next
    // track for gapless — this is the "resolve the next song after the current
    // one is playing" step, leaving the rest of the queue untouched.
    const resolvedPlaceholder = await this.ensureCatalogTrackResolved(track)
    if (resolvedPlaceholder) {
      return this.resolveQueueTarget(resolvedPlaceholder)
    }
    if (isBufferedStreamingTrack(track)) {
      // Keep speculative queue preparation on the provider's prefetch surface.
      const prepared = await playbackPreparationService.prepareTrack(track, { intent: 'prefetch' })
      return prepared.playbackTarget
        ? { playbackTarget: prepared.playbackTarget, formatInfo: prepared.formatInfo, sourceFormatInfo: prepared.sourceFormatInfo ?? null }
        : null
    }
    const playbackPath = this.getTrackPlaybackPath(track)
    if (playbackPath && track.formatInfo?.isDsd) {
      const store = usePlayerStore.getState()
      if (this.dsdOutputPlan(track, store.deviceCapabilities) > 0) {
        const prepared = await this.prepareLocalFile(playbackPath, track.formatInfo, null, null, DSD_INTERMEDIATE_RATE)
        return { playbackTarget: prepared.playbackPath, formatInfo: prepared.outputFormat ?? track.formatInfo ?? null }
      }
      if (
        this.canUseNativeDop(track, store.deviceCapabilities, store.audioMode, store.audioDevice) &&
        this.isActiveDeviceReadyForNativeDop(track.formatInfo, store.deviceFormat)
      ) {
        return {
          playbackTarget: playbackPath,
          formatInfo: track.formatInfo ?? null,
        }
      }
      const prepared = await this.prepareLocalFile(playbackPath, track.formatInfo)
      return {
        playbackTarget: prepared.playbackPath,
        formatInfo: prepared.outputFormat ?? track.formatInfo ?? null,
      }
    }
    return playbackPath
      ? { playbackTarget: playbackPath, formatInfo: track.formatInfo ?? null }
      : null
  }

  private clearNativeQueueState(clearEngineQueue = true) {
    this.queuePreparationToken += 1
    this.nativeQueuedTrackId = null
    this.nativeQueuedTrack = null
    this.nativeQueuedFormatInfo = null
    this.nativeAdvancedFormatInfo = null
    this.nativeQueuedSourceFormatInfo = null
    this.nativeAdvancedSourceFormatInfo = null
    this.queuePreparingTrack = null
    this.queueBlockedTrackId = null
    this.queueDeferredForGrowingFile = null
    this.suppressPlayTrackForTrack = null

    if (clearEngineQueue) {
      void window.puros.audio.clearQueuedFile().catch(() => {
        // Best effort only.
      })
    }
  }

  /**
   * Gapless handoff across sample rates: allowed when the next track's own
   * decision targets the format the output already runs at (e.g. a 48 kHz-only
   * DAC, a fixed output rate, or upsampling), so no reopen is needed.
   */
  private canQueueWithResampling(formatInfo: FormatInfo | null | undefined): boolean {
    const state = usePlayerStore.getState()
    if (state.audioMode !== 'exclusive') return true
    const trackFormat = this.toTrackFormat(formatInfo)
    const caps = state.deviceCapabilities
    const current = state.deviceFormat
    if (!trackFormat || !caps || !current || formatInfo?.isDsd) return false
    const decision = this.decidePlaybackFormat(trackFormat, caps)
    return decision.deviceSampleRate === current.sampleRate && decision.deviceBitDepth <= current.bitDepth
  }

  private maybeQueueUpcomingTrack(state: ReturnType<typeof usePlayerStore.getState>) {
    if (isLiveRadioTrack(state.currentTrack)) {
      this.clearNativeQueueState()
      return
    }
    if (!state.currentTrack) {
      if (this.nativeQueuedTrackId) {
        this.clearNativeQueueState()
      }
      return
    }

    void this.maybeEnsureEndlessPlayback(state)

    if (!state.isPlaying) return
    if (this.activePlaybackTrackId !== getTrackIdentity(state.currentTrack)) return
    if (this.isCueSlicedTrack(state.currentTrack)) return
    const activeStreaming = this.activeProgressivePlayback
    if (activeStreaming?.session.state === StreamingSessionState.Running) return

    const nextTrack = this.getUpcomingQueuedTracks(state, 1)[0] ?? null
    if (!nextTrack) {
      if (this.nativeQueuedTrackId) {
        this.clearNativeQueueState()
      }
      return
    }
    if (isLiveRadioTrack(nextTrack)) return
    if (this.isCueSlicedTrack(nextTrack)) return
    // Prefetch the next track as soon as the current one is playing. While a
    // progressive session is still downloading the current track, the guard
    // above defers this so the next-track download
    // never contends with the active stream; once the current track's cache is
    // complete, the next track is fetched well before playback reaches its end,
    // giving gapless handoff instead of a last-second scramble near the end.
    const nextTrackIdentity = getTrackIdentity(nextTrack)

    if (this.queueBlockedTrackId && this.queueBlockedTrackId !== nextTrackIdentity) {
      this.queueBlockedTrackId = null
    }

    if (this.nativeQueuedTrack === nextTrack) return
    if (this.queuePreparingTrack === nextTrack) return
    if (this.queueBlockedTrackId === nextTrackIdentity) return
    if (this.isPlayingGrowingFile() && this.queueDeferredForGrowingFile === nextTrackIdentity) return

    if (this.nativeQueuedTrack && this.nativeQueuedTrack !== nextTrack) {
      this.clearNativeQueueState()
    }

    const requestToken = ++this.queuePreparationToken
    this.queuePreparingTrack = nextTrack
    void this.resolveQueueTarget(nextTrack)
      .then(async (resolvedTarget) => {
        if (!resolvedTarget) {
          if (requestToken === this.queuePreparationToken) {
            this.queuePreparingTrack = null
            this.queueBlockedTrackId = nextTrackIdentity
          }
          return
        }
        if (requestToken !== this.queuePreparationToken) return

        const latestState = usePlayerStore.getState()
        const latestNextTrack = this.getUpcomingQueuedTracks(latestState, 1)[0] ?? null
        if (!tracksShareIdentity(latestNextTrack, nextTrack)) return
        // A catalog placeholder only shows it is a CUE slice once resolved; slices play one by one.
        if (this.isCueSlicedTrack(latestNextTrack)) {
          this.queuePreparingTrack = null
          this.queueBlockedTrackId = nextTrackIdentity
          return
        }

        // The growing file ends where the download stood when it was opened,
        // so the engine would advance to a queued track there, mid-song. Keep
        // the prefetched track and queue it once the finished file is open.
        if (this.isPlayingGrowingFile()) {
          this.queuePreparingTrack = null
          this.queueDeferredForGrowingFile = nextTrackIdentity
          return
        }

        const result = await window.puros.audio.queueNextFile(
          resolvedTarget.playbackTarget,
          this.canQueueWithResampling(resolvedTarget.formatInfo),
          await this.shouldDeemphasize(nextTrack, resolvedTarget.playbackTarget),
          this.dsdOutputPlan(nextTrack, usePlayerStore.getState().deviceCapabilities),
          restoreSourceHint(resolvedTarget.sourceFormatInfo ?? nextTrack.formatInfo ?? resolvedTarget.formatInfo),
        )
        if (requestToken !== this.queuePreparationToken) return

        this.queuePreparingTrack = null
        if (result.success) {
          this.nativeQueuedTrackId = nextTrackIdentity
          this.nativeQueuedTrack = latestNextTrack
          this.nativeQueuedPlaybackPath = resolvedTarget.playbackTarget
          this.nativeQueuedFormatInfo = resolvedTarget.formatInfo ?? null
          this.nativeQueuedSourceFormatInfo = resolvedTarget.sourceFormatInfo ?? null
          this.queueBlockedTrackId = null
        } else {
          this.nativeQueuedTrackId = null
          this.nativeQueuedTrack = null
          this.nativeQueuedFormatInfo = null
          this.nativeQueuedSourceFormatInfo = null
          this.queueBlockedTrackId = nextTrackIdentity
          console.info('[Puros] Native next-track queue skipped for', nextTrack.title, `(${result.error ?? 'unknown reason'})`)
        }
      })
      .catch((error) => {
        if (requestToken !== this.queuePreparationToken) return
        this.queuePreparingTrack = null
        this.nativeQueuedTrackId = null
        this.nativeQueuedTrack = null
        this.nativeQueuedFormatInfo = null
        this.nativeQueuedSourceFormatInfo = null
        if (error instanceof TrackUnavailableError) {
          // Grey it out now; the next tick prepares the track after it instead.
          usePlayerStore.getState().markTrackUnavailable(nextTrack, error.reason)
          return
        }
        this.queueBlockedTrackId = nextTrackIdentity
        console.warn('[Puros] Failed to prepare native next track queue:', error)
      })
  }

  private shouldEnsureEndlessPlayback(state: ReturnType<typeof usePlayerStore.getState>) {
    if (!useSettingsStore.getState().endlessPlaybackEnabled) return false
    if (!state.currentTrack) return false
    if (state.repeat !== 'off') return false
    if (state.queuePrimaryLength <= 0) return false
    if (state.queue.length > state.queuePrimaryLength) return false
    if (state.queue.length === 0) return false
    return true
  }

  private async maybeEnsureEndlessPlayback(state: ReturnType<typeof usePlayerStore.getState>) {
    if (!this.shouldEnsureEndlessPlayback(state)) return

    const seedTrack = state.queue[Math.max(0, state.queuePrimaryLength - 1)] ?? state.currentTrack
    if (!seedTrack) return

    const artistId = seedTrack.catalogArtistId ?? null
    const artistName = seedTrack.artist?.trim() ?? ''
    if (!artistId && !artistName) return

    const seedKey = `${seedTrack.id}::${artistId ?? ''}::${artistName}::${state.queuePrimaryLength}`
    if (this.endlessPlaybackSeedKey === seedKey) return

    this.endlessPlaybackSeedKey = seedKey
    try {
      const excludeTrackIds = [...new Set(
        state.queue
          .map((track) => track.catalogTrackId)
          .filter((value): value is string => !!value),
      )]

      let radioCandidates = await window.puros.catalog.getArtistRadioTracks(
        artistId,
        artistName || null,
        excludeTrackIds,
        seedTrack.provider ?? seedTrack.sourceType ?? 'local',
      )

      if (radioCandidates.length === 0) {
        radioCandidates = await window.puros.catalog.getArtistRadioTracks(
          artistId,
          artistName || null,
          seedTrack.catalogTrackId ? [seedTrack.catalogTrackId] : [],
          seedTrack.provider ?? seedTrack.sourceType ?? 'local',
        )
      }

      if (radioCandidates.length === 0) return

      const resolvedTracks = await Promise.allSettled(
        radioCandidates.map((track) =>
          window.puros.catalog.resolvePlayback(
            track.id,
            track.preferredProvider ?? null,
            track.preferredSourceId ?? null,
          ),
        ),
      )

      const latest = usePlayerStore.getState()
      if (!this.shouldEnsureEndlessPlayback(latest)) return

      const existingTrackIds = new Set(latest.queue.map((track) => track.id))
      const radioTracks = resolvedTracks
        .flatMap((result) =>
          result.status === 'fulfilled' && result.value
            ? [resolvedPlaybackToTrack(result.value)]
            : [],
        )
        .filter((track) => !existingTrackIds.has(track.id))

      if (radioTracks.length === 0) return

      latest.appendRadioQueue(
        radioTracks,
        artistName || seedTrack.artist || latest.currentTrack?.artist || 'Artist',
        artistId,
      )
    } catch (error) {
      console.warn('[Puros] Failed to prepare endless playback:', error)
    } finally {
      if (this.endlessPlaybackSeedKey === seedKey) {
        this.endlessPlaybackSeedKey = null
      }
    }
  }

  /**
   * Resolve a lightweight catalog queue placeholder to its real source, artwork
   * and format just-in-time, and hydrate it into the store (keeping its id so
   * identity — and thus playback — isn't re-triggered). Returns the resolved
   * track, or null if the track wasn't an unresolved placeholder.
   */
  private async ensureCatalogTrackResolved(
    track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>,
  ): Promise<Track | null> {
    if (!track.unresolved || !track.catalogTrackId) return null
    const resolved = await window.puros.catalog.resolvePlayback(
      track.catalogTrackId,
      (track.provider as CatalogProviderName | undefined) ?? null,
      track.streamId ?? track.sourceId ?? null,
      { allowDiscovery: false },
    ).catch(() => null)
    if (!resolved) throw new Error('This track is unavailable from its provider')
    const data: Partial<Track> = {
      ...resolvedPlaybackToTrack(resolved),
      // Keep the queue entry's artwork when the resolver has none, so the
      // player doesn't blank the cover while the next track hydrates.
      coverUrl: resolved.coverUrl ?? track.coverUrl ?? null,
      artworkUrl: resolved.artworkUrl ?? track.artworkUrl ?? null,
      id: track.id,
      catalogTrackId: track.catalogTrackId,
      playbackContext: track.playbackContext,
      unresolved: false,
    }
    usePlayerStore.getState().hydrateQueueTrack(track, data)
    return { ...track, ...data }
  }

  /**
   * Playback found that the account cannot stream this track: grey it out in
   * the queue and move on, the way the services' own apps skip such tracks.
   */
  private skipUnavailableTrack(track: Track, reason: string) {
    const store = usePlayerStore.getState()
    store.setBufferProgress(null)
    store.markTrackUnavailable(track, reason)
    const before = usePlayerStore.getState().queueIndex
    usePlayerStore.getState().next()
    const after = usePlayerStore.getState()
    const notice = `“${track.title}”: ${unavailableTrackLabel(reason)}`
    if (after.queueIndex !== before) after.setNotification(`Skipped ${notice}`)
    else {
      after.setNotification(null)
      after.setAudioError(notice)
    }
  }

  private async resolvePlaybackTarget(
    track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>,
    caps: DeviceCapabilities | null,
    isCurrent: () => boolean = () => true,
  ): Promise<ResolvedPlaybackTarget | null> {
    const resolvedPlaceholder = await this.ensureCatalogTrackResolved(track)
    if (!isCurrent()) return null
    if (resolvedPlaceholder) {
      const target = await this.resolvePlaybackTarget(resolvedPlaceholder, caps, isCurrent)
      return target && { ...target, track: target.track ?? resolvedPlaceholder }
    }
    if (isBufferedStreamingTrack(track)) {
      const provider = getTrackProviderName(track)
      usePlayerStore.getState().setBufferProgress(0)
      const bufferingNoticeTrack = track
      const bufferingLabel = `Buffering ${providerDisplayName(provider)} track…`
      let receivedDownloadProgress = false
      const bufferingNoticeTimer = setTimeout(() => {
        const latest = usePlayerStore.getState()
        if (!tracksShareIdentity(latest.currentTrack, bufferingNoticeTrack) || receivedDownloadProgress) return
        latest.setNotification(bufferingLabel)
      }, 200)
      try {
        const prepared = await playbackPreparationService.prepareTrack(track, {
          intent: 'playback',
          onProgress: (progress) => {
            if (!isCurrent() || progress.percent == null) return
            receivedDownloadProgress = true
            const percent = Math.max(0, Math.min(100, progress.percent))
            const latest = usePlayerStore.getState()
            latest.setBufferProgress(percent / 100)
            latest.setNotification(`${bufferingLabel} ${Math.round(percent)}%`)
          },
        })
        if (!isCurrent()) return null
        if (prepared.isStreamingSession) {
          if (!prepared.playbackTarget || !prepared.formatInfo || !prepared.streamingSession) return null
          this.activeProgressivePlayback = {
            trackIdentity: getTrackIdentity(track),
            session: prepared.streamingSession,
            playbackPath: prepared.playbackTarget,
            recovering: false,
            recoveryBytes: 0,
            recoverySegments: 0,
            recoveryRevision: 0,
            recoveryPosition: 0,
            openedRevision: prepared.streamingSession.playbackRevision,
            finalFileReopened: prepared.streamingSession.state === StreamingSessionState.Completed,
            bufferHealth: null,
          }
        }
        if (!prepared.playbackTarget || !prepared.formatInfo) return null
        const playbackPath = prepared.playbackTarget
        const resolvedFormatInfo = prepared.formatInfo
        // Label the delivered quality (a lossy source stays lossy even in a FLAC artifact).
        usePlayerStore.getState().setFormatInfo(prepared.sourceFormatInfo ?? resolvedFormatInfo)
        usePlayerStore.getState().setNotification(null)
        usePlayerStore.getState().setBufferProgress(
          this.activeProgressivePlayback
            ? this.activeProgressivePlayback.session.completedSegments
              / Math.max(1, this.activeProgressivePlayback.session.totalSegments)
            : 1,
        )
        return {
          playbackTarget: playbackPath,
          playbackFormatInfo: resolvedFormatInfo,
          decisionFormat: this.toTrackFormat(resolvedFormatInfo),
        }
      } finally {
        clearTimeout(bufferingNoticeTimer)
      }
    }
    const playbackPath = this.getTrackPlaybackPath(track)
    if (!playbackPath) return null
    if (isLiveRadioTrack(track)) {
      usePlayerStore.getState().setBufferProgress(null)
      if (track.formatInfo) {
        usePlayerStore.getState().setFormatInfo(track.formatInfo)
      } else {
        usePlayerStore.setState({ formatInfo: null })
      }
      return {
        playbackTarget: playbackPath,
        playbackFormatInfo: track.formatInfo ?? null,
        decisionFormat: this.toTrackFormat(track.formatInfo),
      }
    }
    if (track.formatInfo?.isDsd) {
      const store = usePlayerStore.getState()
      if (this.dsdOutputPlan(track, caps) > 0) {
        // Remodulation: decode to the modulator's input rate.
        const prepared = await this.prepareLocalFile(playbackPath, track.formatInfo, caps, null, DSD_INTERMEDIATE_RATE)
        return {
          playbackTarget: prepared.playbackPath,
          playbackFormatInfo: prepared.outputFormat ?? track.formatInfo ?? null,
          decisionFormat: this.toTrackFormat(prepared.outputFormat) ?? this.toTrackFormat(track.formatInfo),
        }
      }
      if (this.canUseNativeDop(track, caps, store.audioMode, store.audioDevice)) {
        return {
          playbackTarget: playbackPath,
          playbackFormatInfo: track.formatInfo ?? null,
          decisionFormat: this.getDsdCarrierTrackFormat(track.formatInfo),
        }
      }
      const prepared = await this.prepareLocalFile(playbackPath, track.formatInfo)
      return {
        playbackTarget: prepared.playbackPath,
        playbackFormatInfo: prepared.outputFormat ?? track.formatInfo ?? null,
        decisionFormat: this.toTrackFormat(prepared.outputFormat) ?? this.toTrackFormat(track.formatInfo),
      }
    }
    return {
      playbackTarget: playbackPath,
      playbackFormatInfo: track.formatInfo ?? null,
      decisionFormat: this.toTrackFormat(track.formatInfo),
    }
  }

  private async refreshStateFromNativePlayback(track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>) {
    this.activePlaybackTrackId = getTrackIdentity(track)
    this.suppressEndedUntil = Date.now() + TRACK_END_GUARD_MS
    const store = usePlayerStore.getState()
    store.setPosition(0)
    this.getLastFm()?.startTrack(track)
    store.setIsPlaying(true)

    const queuedFormatInfo = this.nativeAdvancedFormatInfo
    const queuedSourceFormatInfo = this.nativeAdvancedSourceFormatInfo
    this.nativeAdvancedFormatInfo = null
    this.nativeAdvancedSourceFormatInfo = null
    if (queuedFormatInfo) {
      if (queuedSourceFormatInfo) {
        store.setFormatInfo(queuedSourceFormatInfo)
      } else if (track.formatInfo) {
        store.setFormatInfo(track.formatInfo)
      } else {
        store.setFormatInfo(queuedFormatInfo)
      }
      const caps = store.deviceCapabilities ?? await this.refreshDeviceCapabilities()
      if (caps) {
        const queuedTrackFormat = {
          sampleRate: queuedFormatInfo.sampleRate,
          bitDepth: queuedFormatInfo.bitDepth,
          channels: queuedFormatInfo.channels,
          codec: queuedFormatInfo.format,
        }
        // A gapless handoff keeps the output: PCM → DSD stays at the same DSD rate.
        const decision = this.currentDsdOutputRate > 0
          ? this.dsdOutputDecision(queuedTrackFormat, queuedSourceFormatInfo ?? track.formatInfo, this.currentDsdOutputRate)
          : this.decidePlaybackFormat(queuedTrackFormat, caps)
        store.setPlaybackDecision(decision)
      }
    } else {
      if (track.formatInfo) {
        store.setFormatInfo(track.formatInfo)
      } else {
        usePlayerStore.setState({ formatInfo: null })
      }
      store.setPlaybackDecision(null)
    }

    try {
      const [duration, fmt] = await Promise.all([
        window.puros.audio.getDuration(),
        window.puros.audio.getCurrentFormat(),
      ])
      const cueSlice = this.getCueSlice(track)
      store.setDuration(cueSlice ? cueSlice.durationSeconds : (duration > 0 ? duration : track.duration))
      if (fmt.sampleRate > 0) {
        store.setDeviceFormat(fmt)
        if (store.audioMode !== 'exclusive') {
          const sharedDecision = this.createSharedPlaybackDecision(
            this.toTrackFormat(queuedFormatInfo ?? track.formatInfo),
            fmt,
          )
          if (sharedDecision) {
            store.setPlaybackDecision(sharedDecision)
          }
        }
      }
    } catch {
      const cueSlice = this.getCueSlice(track)
      store.setDuration(cueSlice ? cueSlice.durationSeconds : track.duration)
    }

    void recordRecentlyPlayed(track).catch(() => {
      // Best effort only.
    })
  }

  private startLiveRadioMetadataPolling(track: Track) {
    this.clearLiveRadioMetadataTimer()
    if (!isLiveRadioTrack(track) || !track.sourceId) return
    const streamUrl = this.getLiveRadioStreamUrl(track)
    if (!streamUrl) return

    const poll = async () => {
      const latest = usePlayerStore.getState()
      if (!latest.isPlaying || !tracksShareIdentity(latest.currentTrack, track)) return

      try {
        const metadata = await window.puros.liveRadio.getNowPlaying(track.sourceId!, streamUrl)
        const current = usePlayerStore.getState().currentTrack
        if (!tracksShareIdentity(current, track)) return
        if (metadata.title || metadata.artist) {
          usePlayerStore.setState({
            currentTrack: {
              ...current!,
              title: metadata.title || track.title,
              artist: metadata.artist || track.artist,
              album: track.title,
            },
          })
          this.syncMediaSessionMetadata(usePlayerStore.getState().currentTrack)
        }
      } catch {
        // Live metadata is best effort. Station fallback remains visible.
      }

      this.liveRadioMetadataTimer = setTimeout(poll, LIVE_RADIO_METADATA_POLL_INTERVAL_MS)
    }

    this.liveRadioMetadataTimer = setTimeout(poll, 1200)
  }

  private async reconnectLiveRadio(track: Track, reason: string): Promise<boolean> {
    if (!isLiveRadioTrack(track)) return false
    const latest = usePlayerStore.getState()
    if (!tracksShareIdentity(latest.currentTrack, track)) return false

    this.liveRadioReconnectAttempts += 1
    const attempt = this.liveRadioReconnectAttempts
    if (attempt > 5) {
      latest.setNotification('Live radio stream is unavailable.')
      latest.setAudioError('Live radio stream is unavailable.')
      return false
    }
    const delay = Math.min(
      LIVE_RADIO_RECONNECT_MAX_MS,
      LIVE_RADIO_RECONNECT_BASE_MS * Math.max(1, attempt),
    )
    latest.setNotification('Reconnecting live radio...')
    if (track.sourceId) {
      await window.puros.liveRadio.stopPlayback(track.sourceId).catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
    const afterDelay = usePlayerStore.getState()
    if (!tracksShareIdentity(afterDelay.currentTrack, track)) return false
    console.warn(`[Puros][LiveRadio] Reconnecting after ${reason}`)
    void this.playTrack(afterDelay)
    return true
  }

  private async handleNativeQueuedAdvance(state: ReturnType<typeof usePlayerStore.getState>) {
    const upcomingTrack = this.getUpcomingQueuedTracks(state, 1)[0] ?? null
    const nextTrack = this.nativeQueuedTrack === upcomingTrack ? this.nativeQueuedTrack : upcomingTrack
    if (!nextTrack) return

    this.getLastFm()?.endTrack(true)

    // Claim the advanced track immediately so the next polling tick cannot
    // misinterpret the old engine "ended" state and fire a second next().
    this.activePlaybackTrackId = getTrackIdentity(nextTrack)
    this.suppressEndedUntil = Date.now() + TRACK_END_GUARD_MS
    this.suppressPlayTrackForTrack = nextTrack
    this.nativeAdvancedFormatInfo = this.nativeQueuedFormatInfo
    this.nativeAdvancedSourceFormatInfo = this.nativeQueuedSourceFormatInfo
    if (this.nativeQueuedTrack === nextTrack && this.nativeQueuedPlaybackPath) {
      this.publishPlaybackSource(nextTrack, this.nativeQueuedPlaybackPath, false)
    } else {
      usePlayerStore.getState().setPlaybackSource(null)
    }
    this.nativeQueuedTrackId = null
    this.nativeQueuedTrack = null
    this.nativeQueuedFormatInfo = null
    this.nativeQueuedSourceFormatInfo = null
    usePlayerStore.getState().next()
  }

  private async advanceToNextTrackFromEndedPlayback(): Promise<void> {
    const before = usePlayerStore.getState()
    const beforeTrack = before.currentTrack
    const beforeIdentity = getTrackIdentity(beforeTrack)
    const beforeQueueIndex = before.queueIndex

    before.next()

    const after = usePlayerStore.getState()
    const afterIdentity = getTrackIdentity(after.currentTrack)
    const advancedQueueEntry = after.queueIndex !== beforeQueueIndex || after.currentTrack !== beforeTrack
    if (!advancedQueueEntry || !after.currentTrack) return

    console.info(
      '[Puros] Ended playback advanced queue',
      `from=${beforeTrack?.title ?? 'none'} (${beforeIdentity ?? 'no-id'})`,
      `to=${after.currentTrack.title} (${afterIdentity ?? 'no-id'})`,
      `index=${beforeQueueIndex}->${after.queueIndex}`,
    )

    if (afterIdentity === beforeIdentity) {
      console.warn('[Puros] Queue advanced to a track with the same identity; playback refresh should be driven by queue entry change')
    }
  }

  private async playTrack(state: ReturnType<typeof usePlayerStore.getState>) {
    const queuedTrack = state.currentTrack
    if (!queuedTrack) return
    const startPosition = this.pendingStartPosition
    this.pendingStartPosition = 0
    this.clearNativeQueueState()
    this.clearDsdStartupFallbackTimer()

    // Claim this invocation; any previous in-flight call will see a stale token.
    const token = ++this.playToken

    // Stop any in-progress polling immediately so stale position ticks
    // from the previous track don't overwrite the reset position.
    this.stopPolling()

    // Ensure device is open
    if (state.audioMode === 'closed') {
      await this.ensureDeviceOpen()
      if (token !== this.playToken) return
    }

    if (isLiveRadioTrack(queuedTrack)) {
      const liveStore = usePlayerStore.getState()
      if (liveStore.audioMode === 'exclusive') {
        const deviceUid = liveStore.audioDevice ?? DEFAULT_DEVICE_ID
        const shared = await window.puros.audio.openShared(deviceUid)
        if (shared.success) {
          liveStore.setAudioMode('shared')
          liveStore.setOutputMode('SHARED')
          liveStore.setAudioError(null)
          const fmt = await window.puros.audio.getCurrentFormat().catch(() => null)
          if (fmt && fmt.sampleRate > 0) liveStore.setDeviceFormat(fmt)
          this.showNotification('Live radio uses shared output mode')
        } else {
          liveStore.setAudioError(shared.error ?? 'Could not open output for live radio')
          return
        }
      }
    }

    // Refresh device capabilities
    const caps = await this.refreshDeviceCapabilities()
    if (token !== this.playToken) return

    let resolvedPlaybackTarget: ResolvedPlaybackTarget | null = null
    try {
      resolvedPlaybackTarget = await this.resolvePlaybackTarget(queuedTrack, caps, () => token === this.playToken)
    } catch (err) {
      if (token !== this.playToken) return
      if (err instanceof Error && err.name === 'AbortError') {
        usePlayerStore.getState().setNotification(null)
        usePlayerStore.getState().setBufferProgress(null)
        return
      }
      if (err instanceof TrackUnavailableError) {
        this.skipUnavailableTrack(queuedTrack, err.reason)
        return
      }
      console.error('resolvePlaybackTarget failed:', err)
      usePlayerStore.getState().setNotification(null)
      usePlayerStore.getState().setBufferProgress(null)
      usePlayerStore.getState().setAudioError(
        err instanceof Error ? err.message : 'Unable to resolve playback source'
      )
      return
    }

    if (token !== this.playToken || !resolvedPlaybackTarget) return
    let { playbackTarget, playbackFormatInfo, decisionFormat } = resolvedPlaybackTarget
    // From here on the resolved track: a catalog placeholder carries no file path or CUE slice.
    const track = resolvedPlaybackTarget.track ?? queuedTrack
    const sourcePlaybackPath = this.getTrackPlaybackPath(track)
    let usedDsdPcmFallback = !!track.formatInfo?.isDsd && playbackTarget !== sourcePlaybackPath

    // Resolve playback format decision
    const trackFormat = decisionFormat ?? this.toTrackFormat(playbackFormatInfo) ?? this.getTrackFormat(usePlayerStore.getState())
    let decision: PlaybackDecision | null = null

    this.currentDsdOutputRate = 0
    if (trackFormat && caps && !isLiveRadioTrack(track)) {
      decision = this.decidePlaybackFormat(trackFormat, caps)
      const dsdRate = this.dsdOutputPlan(track, caps)
      if (dsdRate > 0) decision = this.dsdOutputDecision(trackFormat, track.formatInfo, dsdRate)

      // Log the decision
      const fileName = playbackTarget.split('/').pop() ?? playbackTarget
      console.log(formatDecisionLog(fileName, trackFormat, caps.name, decision))

      // In exclusive mode (only available on physical devices, never __default__)
      const currentStore = usePlayerStore.getState()
      if (currentStore.audioMode === 'exclusive' &&
          currentStore.audioDevice !== DEFAULT_DEVICE_ID) {
        // Strict mode never converts rates: refuse up front instead of opening a resampled path.
        const strictSampleRate = useSettingsStore.getState().strictSampleRate
        if (strictSampleRate && requiresSampleRateConversion(decision) && decision.mode === 'RESAMPLED') {
          currentStore.setNotification(null)
          currentStore.setBufferProgress(null)
          currentStore.setAudioError(
            `${caps.name} cannot play ${decision.originalSampleRate / 1000}kHz without sample-rate conversion, ` +
            'and "Never resample in exclusive mode" is on. Choose an output that supports this rate or turn the setting off.',
          )
          return
        }
        const dsdOutputRate = decision.mode === 'RESAMPLED' ? decision.dsdOutputRate ?? 0 : 0
        await this.openExclusiveAtDecision(currentStore.audioDevice ?? 'default', decision, {
          // A shared fallback would hand the stream to the system mixer, which may resample.
          allowSharedFallback: !strictSampleRate && dsdOutputRate === 0 &&
            !(track.formatInfo?.isDsd && playbackTarget === sourcePlaybackPath),
          // DoP needs the integer carrier — native DSD and PCM → DSD alike.
          preferNonMixableInteger: dsdOutputRate > 0 || (!!track.formatInfo?.isDsd && playbackTarget === sourcePlaybackPath),
        })
        this.currentDsdOutputRate = usePlayerStore.getState().audioMode === 'exclusive' ? dsdOutputRate : 0

        if (track.formatInfo?.isDsd && playbackTarget === sourcePlaybackPath) {
          const actualFmt = await window.puros.audio.getCurrentFormat().catch(() => null)
          if (!this.isActiveDeviceReadyForNativeDop(track.formatInfo, actualFmt)) {
            const fallbackTarget = await this.prepareDsdPcmFallback(track)
            if (fallbackTarget) {
              playbackTarget = fallbackTarget.playbackTarget
              playbackFormatInfo = fallbackTarget.playbackFormatInfo
              decisionFormat = fallbackTarget.decisionFormat
              usedDsdPcmFallback = true

              if (decisionFormat) {
                decision = this.decidePlaybackFormat(decisionFormat, caps)
                decision = this.createDsdPcmFallbackDecision(track.formatInfo, decision, playbackFormatInfo)
                console.log(
                  `[Puros] Native DoP carrier unavailable after exclusive open, falling back to PCM for ${track.title}`
                )
                if (decision) {
                  await this.openExclusiveAtDecision(currentStore.audioDevice ?? 'default', decision, {
                    allowSharedFallback: false,
                    preferNonMixableInteger: false,
                  })
                  this.showNotification('Playing DSD via exclusive PCM fallback (not bit-perfect)')
                }
              }
            }
          }
        }
      }
    }

    if (usedDsdPcmFallback && this.currentDsdOutputRate === 0) {
      decision = this.createDsdPcmFallbackDecision(track.formatInfo, decision, playbackFormatInfo)
    }

    // Preparation can finish out of order when playlist rows are clicked quickly.
    if (token !== this.playToken) return

    // Update store with decision
    usePlayerStore.getState().setPlaybackDecision(isLiveRadioTrack(track) ? null : decision)

    // Play the file, or start the live-radio decoder bridge.
    let result = isLiveRadioTrack(track) && track.sourceId
      ? await window.puros.liveRadio.startPlayback(track.sourceId, playbackTarget)
      : await this.playNativeFile(playbackTarget, track)

    if (token !== this.playToken) return

    if (!result.success && this.activeProgressivePlayback?.playbackPath === playbackTarget) {
      const fallback = await this.prepareProgressiveDownloadFirstFallback(track, result.error ?? 'growing file could not be opened')
      if (token !== this.playToken) return
      if (fallback) {
        playbackTarget = fallback.playbackTarget
        playbackFormatInfo = fallback.playbackFormatInfo
        decisionFormat = fallback.decisionFormat
        result = await this.playNativeFile(playbackTarget, track)
        if (token !== this.playToken) return
      }
    }

    if (!result.success && track.formatInfo?.isDsd && playbackTarget === sourcePlaybackPath) {
      try {
        const fallbackTarget = await this.prepareDsdPcmFallback(track)
        if (token !== this.playToken) return
        if (fallbackTarget) {
          playbackTarget = fallbackTarget.playbackTarget
          playbackFormatInfo = fallbackTarget.playbackFormatInfo
          decisionFormat = fallbackTarget.decisionFormat
          usedDsdPcmFallback = true

          if (decisionFormat && caps) {
            decision = this.decidePlaybackFormat(decisionFormat, caps)
            decision = this.createDsdPcmFallbackDecision(track.formatInfo, decision, playbackFormatInfo)
            usePlayerStore.getState().setPlaybackDecision(decision)
            const currentStore = usePlayerStore.getState()
            if (decision && currentStore.audioMode === 'exclusive' && currentStore.audioDevice !== DEFAULT_DEVICE_ID) {
              await this.openExclusiveAtDecision(currentStore.audioDevice ?? 'default', decision, {
                allowSharedFallback: false,
                preferNonMixableInteger: false,
              })
              this.showNotification('Playing DSD via exclusive PCM fallback (not bit-perfect)')
            }
          }

          result = await this.playNativeFile(playbackTarget, track)
          if (token !== this.playToken) return
        }
      } catch (fallbackErr) {
        console.warn('[Puros] DSD fallback playback preparation failed:', fallbackErr)
      }
    }

    // A newer track was selected while we were awaiting — discard this result.
    if (token !== this.playToken) return

    if (result.success) {
      const activeStreaming = this.activeProgressivePlayback
      // A session that finished meanwhile may have moved its file already.
      const progressive = activeStreaming?.trackIdentity === getTrackIdentity(track) ? activeStreaming : null
      this.publishPlaybackSource(
        track,
        progressive?.playbackPath ?? playbackTarget,
        !!progressive && progressive.session.state !== StreamingSessionState.Completed,
      )
      usePlayerStore.getState().setBufferProgress(
        activeStreaming
          ? activeStreaming.session.completedSegments / Math.max(1, activeStreaming.session.totalSegments)
          : isBufferedStreamingTrack(track) ? 1 : null,
      )
      if (activeStreaming?.playbackPath === playbackTarget) {
        activeStreaming.session.playbackStarted = true
        const providerId = activeStreaming.session.manifest.provider
        if (providerId) await window.puros.provider.invoke(
          providerId,
          'playback.progressive',
          'markPlaybackStarted',
          [{ sessionId: activeStreaming.session.sessionId }],
        ).catch((error) => {
            console.warn('[Streaming] Failed to mark playback started:', error)
          })
        console.info('[Streaming] Playback using growing file')
        console.info(`Path: ${playbackTarget}`)
      }
      // Set artwork immediately so it renders before audio starts
      if (result.artwork) {
        usePlayerStore.getState().setCurrentTrackArtwork(result.artwork)
      }
      const cueSlice = this.getCueSlice(track)
      if (cueSlice && cueSlice.startSeconds > 0 && startPosition <= 0) {
        await window.puros.audio.seek(cueSlice.startSeconds)
      }
      if (startPosition > 0) {
        await window.puros.audio.seek((cueSlice?.startSeconds ?? 0) + startPosition).catch((error) => {
          console.warn('[Puros] Could not seek to the restored position:', error)
        })
        if (token !== this.playToken) return
      }
      this.activePlaybackTrackId = getTrackIdentity(track)
      this.suppressEndedUntil = Date.now() + TRACK_END_GUARD_MS
      usePlayerStore.getState().setPosition(startPosition)
      if (isLiveRadioTrack(track)) {
        this.liveRadioReconnectAttempts = 0
        const streamUrl = this.getLiveRadioStreamUrl(track)
        if (track.sourceId && streamUrl) {
          await window.puros.liveRadio.markPlaybackStarted(track.sourceId, streamUrl).catch(() => undefined)
        }
        this.startLiveRadioMetadataPolling(track)
      } else {
        this.getLastFm()?.startTrack(track)
      }
      usePlayerStore.getState().play()
      // Get duration and current device format from native engine
      const [duration, fmt] = await Promise.all([
        window.puros.audio.getDuration(),
        window.puros.audio.getCurrentFormat(),
      ])
      if (token !== this.playToken) return
      const s = usePlayerStore.getState()
      if (track.formatInfo?.isDsd && duration <= 0 && s.audioMode === 'exclusive') {
        const fallbackTarget = await this.prepareDsdPcmFallback(track).catch(() => null)
        if (fallbackTarget) {
          if (fallbackTarget.decisionFormat && caps && s.audioDevice && s.audioDevice !== DEFAULT_DEVICE_ID) {
            const fallbackDecision = this.createDsdPcmFallbackDecision(
              track.formatInfo,
              this.decidePlaybackFormat(fallbackTarget.decisionFormat, caps),
              fallbackTarget.playbackFormatInfo,
            )
            usePlayerStore.getState().setPlaybackDecision(fallbackDecision)
            if (fallbackDecision) {
              await this.openExclusiveAtDecision(s.audioDevice, fallbackDecision, {
                allowSharedFallback: false,
                preferNonMixableInteger: false,
              })
              this.showNotification('Playing DSD via exclusive PCM fallback (not bit-perfect)')
              const retried = await this.playNativeFile(fallbackTarget.playbackTarget, track)
              if (retried.success) {
                const [retryDuration, retryFmt] = await Promise.all([
                  window.puros.audio.getDuration(),
                  window.puros.audio.getCurrentFormat(),
                ])
                const latest = usePlayerStore.getState()
                latest.setDuration(cueSlice ? cueSlice.durationSeconds : (retryDuration > 0 ? retryDuration : track.duration))
                if (retryFmt.sampleRate > 0) latest.setDeviceFormat(retryFmt)
                void recordRecentlyPlayed(latest.currentTrack ?? track).catch(() => {})
                this.maybeQueueUpcomingTrack(latest)
                this.startPolling()
                return
              }
            }
          }
        }
      }

      s.setDuration(
        cueSlice
          ? cueSlice.durationSeconds
          : activeStreaming && track.duration > 0
            ? track.duration
            : (duration > 0 ? duration : track.duration),
      )
      if (fmt.sampleRate > 0) {
        s.setDeviceFormat(fmt)
        if (s.audioMode !== 'exclusive') {
          if (!isLiveRadioTrack(track)) {
            const sharedDecision = this.createSharedPlaybackDecision(
              decisionFormat ?? this.toTrackFormat(playbackFormatInfo) ?? this.toTrackFormat(track.formatInfo),
              fmt,
            )
            if (sharedDecision) {
              s.setPlaybackDecision(sharedDecision)
            }
          }
        }
      }
      if (!isLiveRadioTrack(track)) {
        void recordRecentlyPlayed(s.currentTrack ?? track).catch(() => {
          // Best effort only.
        })
        this.maybeQueueUpcomingTrack(s)
      }
      this.startPolling()
      this.scheduleDsdExclusiveStartupFallback(track, caps, usedDsdPcmFallback)
    } else {
      this.clearDsdStartupFallbackTimer()
      usePlayerStore.getState().setBufferProgress(null)
      this.activePlaybackTrackId = null
      this.clearNativeQueueState()
      console.error('playFile failed:', result.error)
      if (isLiveRadioTrack(track)) {
        const scheduled = await this.reconnectLiveRadio(track, result.error ?? 'playback failed')
        if (!scheduled) {
          usePlayerStore.getState().setAudioError(result.error ?? 'Playback failed')
        }
      } else {
        usePlayerStore.getState().setAudioError(result.error ?? 'Playback failed')
      }
    }
  }

  /**
   * Open exclusive mode at the format specified by the playback decision.
   * If the device is already in exclusive at the right format, skip.
   * If exclusive fails, fall back to shared.
   */
  private async openExclusiveAtDecision(
    deviceUid: string,
    decision: PlaybackDecision,
    options?: { allowSharedFallback?: boolean; preferNonMixableInteger?: boolean },
  ) {
    const store = usePlayerStore.getState()
    const currentFmt = store.deviceFormat
    const allowSharedFallback = options?.allowSharedFallback ?? true
    const preferNonMixableInteger = options?.preferNonMixableInteger ?? false

    // Check if already at the right format
    if (
      store.audioMode === 'exclusive' &&
      currentFmt &&
      currentFmt.sampleRate === decision.deviceSampleRate &&
      currentFmt.bitDepth >= decision.deviceBitDepth
    ) {
      return // Already in correct exclusive format
    }

    // Reopen at the target format. On the device already held exclusively the engine
    // switches the format in place (keeps hog mode); otherwise it closes first itself.
    const result = await window.puros.audio.openExclusive(
      deviceUid,
      decision.deviceSampleRate,
      decision.deviceBitDepth,
      preferNonMixableInteger,
    )

    if (result.success) {
      store.setAudioMode('exclusive')
      store.setOutputMode('EXCLUSIVE')
      store.setAudioError(null)
      if (store.audioDevice) {
        await this.persistAudioRoute(store.audioDevice, 'exclusive')
      }
      await this.applyMaxVolumeAtStart(deviceUid, store.deviceCapabilities?.hardwareVolume)
      await this.waitForResync(deviceUid)
    } else {
      if (!allowSharedFallback) {
        store.setAudioMode('closed')
        store.setOutputMode('SHARED')
        store.setAudioError(result.error ?? 'Exclusive mode failed')
        return
      }
      const blockedTransport = getExclusiveBlockedTransportLabel(result.error)
      if (!blockedTransport) {
        console.warn('Exclusive mode failed, falling back to shared:', result.error)
      }
      // Fall back to shared silently for transports that macOS keeps shared-only.
      const fallback = await window.puros.audio.openShared(deviceUid)
      if (fallback.success) {
        store.setAudioMode('shared')
        store.setOutputMode('SHARED')
        store.setAudioError(
          blockedTransport
            ? null
            : `Exclusive mode failed (${result.error}). Fell back to shared mode.`
        )
        if (store.audioDevice) {
          await this.persistAudioRoute(store.audioDevice, 'shared')
        }
        if (result.error === 'BLUETOOTH_DEVICE') this.refreshBluetoothInfo()
        await this.waitForResync(deviceUid)
      } else {
        store.setAudioMode('closed')
        store.setAudioError(
          `Cannot open device: exclusive failed (${result.error}), shared failed (${fallback.error})`
        )
      }
    }
  }

  private updateStreamingBufferHealth(active: ActiveProgressivePlayback) {
    const store = usePlayerStore.getState()
    const downloadedFraction = active.session.totalSegments > 0
      ? active.session.completedSegments / active.session.totalSegments
      : 0
    const downloadedDuration = store.duration > 0 ? store.duration * downloadedFraction : 0
    const bufferedSeconds = Math.max(0, downloadedDuration - store.position)
    const nextHealth: StreamingBufferHealth = !active.session.playbackStarted || store.duration <= 0 || bufferedSeconds > 15
      ? 'GOOD'
      : 'LOW'
    if (active.bufferHealth === nextHealth) return
    active.bufferHealth = nextHealth
    console.info(`[Streaming] Buffer health: ${nextHealth}`)
    console.info(`Buffered seconds: ${bufferedSeconds.toFixed(1)}`)
  }

  private async handleStreamingStarvation(
    active: ActiveProgressivePlayback,
    position: number,
  ): Promise<void> {
    if (!active.recovering) {
      active.recovering = true
      active.recoveryBytes = active.session.bytesDownloaded
      active.recoverySegments = active.session.completedSegments
      active.recoveryRevision = active.session.playbackRevision
      active.recoveryPosition = position
      active.bufferHealth = 'LOW'
      console.warn('[Streaming] Buffer starvation detected')
      console.info('[Streaming] Buffer health: LOW')
      usePlayerStore.getState().setNotification('Buffering streaming audio…')
      await window.puros.audio.pause().catch(() => undefined)
      return
    }

    const enoughAdditionalData =
      active.session.bytesDownloaded - active.recoveryBytes >= STREAMING_RECOVERY_BYTES
      || active.session.completedSegments - active.recoverySegments >= STREAMING_RECOVERY_SEGMENTS
    const refreshedPlaybackFile = active.session.playbackRevision > active.recoveryRevision
    if (
      active.session.state !== StreamingSessionState.Completed
      && (!enoughAdditionalData || !refreshedPlaybackFile)
    ) return

    await this.reopenProgressivePlayback(active, active.recoveryPosition)
  }

  private async reopenProgressivePlayback(
    active: ActiveProgressivePlayback,
    position: number,
    resumePlayback = true,
  ): Promise<boolean> {
    if (!this.isCurrentProgressivePlayback(active)) return false

    const openingFinishedFile = active.session.state === StreamingSessionState.Completed
    const result = await this.playNativeFile(active.playbackPath)
    if (!this.isCurrentProgressivePlayback(active)) {
      if (result.success) {
        void this.restoreCurrentPlaybackAfterStaleStreamingSwitch(active.trackIdentity)
      }
      return false
    }
    if (!result.success) {
      console.warn('[Streaming] Growing file reopen deferred:', result.error)
      active.recoveryBytes = active.session.bytesDownloaded
      active.recoverySegments = active.session.completedSegments
      active.recoveryRevision = active.session.playbackRevision
      return false
    }

    if (position > 0) await window.puros.audio.seek(position)
    if (resumePlayback) {
      await window.puros.audio.resume()
    } else {
      await window.puros.audio.pause()
    }
    active.openedRevision = active.session.playbackRevision
    active.recovering = false
    active.bufferHealth = 'GOOD'
    this.suppressEndedUntil = Date.now() + TRACK_END_GUARD_MS
    usePlayerStore.getState().setNotification(null)
    console.info('[Streaming] Buffer health: GOOD')
    console.info('[Streaming] Playback resumed after buffering')
    if (openingFinishedFile) {
      active.finalFileReopened = true
      this.queueDeferredForGrowingFile = null
      this.maybeQueueUpcomingTrack(usePlayerStore.getState())
    }
    return true
  }

  /** Whether the engine still reads the provider's growing file rather than the finished one. */
  private isPlayingGrowingFile(): boolean {
    const active = this.activeProgressivePlayback
    return !!active && !active.finalFileReopened
  }

  private isCurrentProgressivePlayback(active: ActiveProgressivePlayback): boolean {
    return this.activeProgressivePlayback === active
      && getTrackIdentity(usePlayerStore.getState().currentTrack) === active.trackIdentity
  }

  private async restoreCurrentPlaybackAfterStaleStreamingSwitch(staleTrackIdentity: string | null): Promise<void> {
    const latest = usePlayerStore.getState()
    const currentIdentity = getTrackIdentity(latest.currentTrack)
    if (!latest.currentTrack || !latest.isPlaying || currentIdentity === staleTrackIdentity) return
    console.warn('[Streaming] Restoring current track after stale progressive playback switch')
    await this.playTrack(latest).catch((error) => {
      console.warn('[Streaming] Failed to restore current track after stale switch:', error)
    })
  }

  /** Cancel pending provider resolution or an active progressive session. */
  private async cancelActiveProgressiveSessions(): Promise<void> {
    await playbackPreparationService.cancelActiveSession()
  }

  private async finishProgressivePlayback(active: ActiveProgressivePlayback): Promise<void> {
    const store = usePlayerStore.getState()
    if (this.activeProgressivePlayback !== active || !store.currentTrack) return

    store.setBufferProgress(1)
    this.maybeQueueUpcomingTrack(store)
  }

  private async seekCompletedProgressivePlayback(
    active: ActiveProgressivePlayback,
    position: number,
  ): Promise<void> {
    const shouldResume = usePlayerStore.getState().isPlaying
    this.clearNativeQueueState()
    try {
      const reopened = await this.reopenProgressivePlayback(active, position, shouldResume)
      if (!reopened) return
      active.finalFileReopened = true
      const latest = usePlayerStore.getState()
      if (shouldResume) this.startPolling()
      this.maybeQueueUpcomingTrack(latest)
    } finally {
      this.seekPending = false
    }
  }

  private async seekRefreshedProgressivePlayback(
    active: ActiveProgressivePlayback,
    position: number,
  ): Promise<void> {
    const shouldResume = usePlayerStore.getState().isPlaying
    try {
      const reopened = await this.reopenProgressivePlayback(active, position, shouldResume)
      if (!reopened) {
        await window.puros.audio.seek(position).catch((error) => {
          console.warn('[Puros] Seek failed:', error)
        })
      }
    } finally {
      this.seekPending = false
    }
  }

  private async prepareProgressiveDownloadFirstFallback(
    track: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentTrack']>,
    reason: string,
  ): Promise<ResolvedPlaybackTarget | null> {
    console.info('[Streaming] Fallback to download-first')
    console.info(`Reason: ${reason}`)
    usePlayerStore.getState().setNotification('Finishing download before playback…')

    const prepared = await playbackPreparationService.prepareDownloadFirst(track).catch((error) => {
      console.error('[Streaming] Download-first fallback failed:', error)
      return null
    })
    if (!prepared?.playbackTarget || !prepared.formatInfo) return null
    this.activeProgressivePlayback = null
    usePlayerStore.getState().setFormatInfo(prepared.formatInfo)
    return {
      playbackTarget: prepared.playbackTarget,
      playbackFormatInfo: prepared.formatInfo,
      decisionFormat: this.toTrackFormat(prepared.formatInfo),
    }
  }

  private async recoverFailedStreamingSession(
    track: ReturnType<typeof usePlayerStore.getState>['currentTrack'],
    position: number,
  ): Promise<void> {
    if (!track) return
    const recoveryTrackIdentity = getTrackIdentity(track)
    const fallback = await this.prepareProgressiveDownloadFirstFallback(
      track,
      this.activeProgressivePlayback?.session.error ?? 'streaming session failed',
    )
    if (getTrackIdentity(usePlayerStore.getState().currentTrack) !== recoveryTrackIdentity) return
    if (!fallback) {
      usePlayerStore.getState().pause()
      usePlayerStore.getState().setNotification('Streaming interrupted. Playback is paused.')
      return
    }

    const result = await this.playNativeFile(fallback.playbackTarget)
    if (getTrackIdentity(usePlayerStore.getState().currentTrack) !== recoveryTrackIdentity) {
      if (result.success) {
        void this.restoreCurrentPlaybackAfterStaleStreamingSwitch(recoveryTrackIdentity)
      }
      return
    }
    if (!result.success) {
      usePlayerStore.getState().pause()
      usePlayerStore.getState().setNotification('Streaming interrupted. Playback is paused.')
      return
    }
    this.publishPlaybackSource(track, fallback.playbackTarget, false)
    if (position > 0) await window.puros.audio.seek(position)
    await window.puros.audio.resume()
    this.suppressEndedUntil = Date.now() + TRACK_END_GUARD_MS
    usePlayerStore.getState().setBufferProgress(null)
    usePlayerStore.getState().setNotification(null)
    this.startPolling()
  }

  private startPolling() {
    this.stopPolling()
    const generation = ++this.pollGeneration
    const tick = async () => {
      if (generation !== this.pollGeneration) return

      const store = usePlayerStore.getState()
      if (!store.isPlaying) return

      try {
        const [absolutePosition, ended, queuedAdvanced, processingStats] = await Promise.all([
          window.puros.audio.getPosition(),
          window.puros.audio.isTrackEnded(),
          window.puros.audio.consumeQueuedAdvance(),
          window.puros.audio.getProcessingStats().catch(() => ({ speed: 0, active: false })),
        ])

        if (generation !== this.pollGeneration) return

        const cueSlice = this.getCueSlice(store.currentTrack)
        const displayPosition = cueSlice
          ? Math.max(0, Math.min(absolutePosition - cueSlice.startSeconds, cueSlice.durationSeconds))
          : absolutePosition

        if (
          displayPosition > 0.05 &&
          store.bufferProgress != null &&
          isBufferedStreamingTrack(store.currentTrack) &&
          !this.activeProgressivePlayback
        ) {
          usePlayerStore.getState().setBufferProgress(null)
        }

        // A native advance off the growing file reports the next track's
        // position; the current song's is the last one shown.
        const advancedOffGrowingFile = queuedAdvanced && this.isPlayingGrowingFile()
        if (!this.seekPending && !advancedOffGrowingFile) {
          usePlayerStore.getState().setPosition(displayPosition)
        }
        usePlayerStore.getState().setProcessingSpeed(
          processingStats.active && processingStats.speed > 0.05
            ? processingStats.speed
            : null
        )
        if (!isLiveRadioTrack(store.currentTrack)) {
          this.getLastFm()?.updatePosition(displayPosition)
        }

        const latestState = usePlayerStore.getState()
        if (queuedAdvanced) {
          const activeStreaming = this.activeProgressivePlayback
          const currentSongPosition = advancedOffGrowingFile ? store.position : displayPosition
          // Once the growing file has been reopened against its finalized,
          // complete contents, native EOF/promotion is authoritative — same
          // trust boundary as the `ended` handling below. Without this check,
          // any mismatch between tag duration and real decoded length (common
          // with AAC encoder padding) makes every genuine gapless advance look
          // "premature" and reverts playback to the track that just finished.
          const advancedBeforeExpectedDuration = !!activeStreaming
            && !activeStreaming.finalFileReopened
            && latestState.duration > 0
            && currentSongPosition < latestState.duration - 2
          if (advancedBeforeExpectedDuration) {
            console.warn('[Streaming] Ignoring premature native queued advance before current progressive track ended')
            if (activeStreaming.session.state === StreamingSessionState.Completed) {
              const reopened = await this.reopenProgressivePlayback(activeStreaming, currentSongPosition)
              if (!reopened) {
                this.schedulePlaybackPoll(generation, tick)
                return
              }
              activeStreaming.finalFileReopened = true
              if (generation !== this.pollGeneration) return
              this.maybeQueueUpcomingTrack(usePlayerStore.getState())
            }
            this.schedulePlaybackPoll(generation, tick)
            return
          }

          await this.handleNativeQueuedAdvance(latestState)
          if (generation !== this.pollGeneration) return
          this.schedulePlaybackPoll(generation, tick)
          return
        }

        const remaining = latestState.duration - displayPosition
        if (
          latestState.isPlaying &&
          !isLiveRadioTrack(latestState.currentTrack) &&
          Number.isFinite(remaining) &&
          remaining <= NATIVE_QUEUE_URGENT_LEAD_SECONDS
        ) {
          this.maybeQueueUpcomingTrack(latestState)
        }

        const sliceEnded = cueSlice && cueSlice.endSeconds != null
          ? absolutePosition >= Math.max(cueSlice.endSeconds - 0.05, cueSlice.startSeconds)
          : false

        if (ended || sliceEnded) {
          const liveTrack = latestState.currentTrack
          if (ended && isLiveRadioTrack(liveTrack) && liveTrack) {
            const scheduled = await this.reconnectLiveRadio(liveTrack, 'stream ended')
            if (scheduled) return
          }
          const activeStreaming = this.activeProgressivePlayback
          if (ended && activeStreaming) {
            if (activeStreaming.finalFileReopened) {
              // The active file is now the finalized cache file. From here,
              // native EOF is the real end of the song, so fall through to the
              // normal queue advance path even if the next track is not queued.
            } else if (activeStreaming.session.state === StreamingSessionState.Running) {
              await this.handleStreamingStarvation(activeStreaming, displayPosition)
              if (generation !== this.pollGeneration) return
              this.schedulePlaybackPoll(generation, tick)
              return
            } else if (activeStreaming.session.state === StreamingSessionState.Failed) {
              await this.recoverFailedStreamingSession(store.currentTrack, displayPosition)
              return
            } else {
              const endedBeforeExpectedDuration = latestState.duration > 0
              && displayPosition < latestState.duration - 2
              if (
                activeStreaming.session.state === StreamingSessionState.Completed
                && endedBeforeExpectedDuration
              ) {
                const reopened = await this.reopenProgressivePlayback(activeStreaming, displayPosition)
                if (!reopened) {
                  this.schedulePlaybackPoll(generation, tick)
                  return
                }
                activeStreaming.finalFileReopened = true
                if (generation !== this.pollGeneration) return
                this.schedulePlaybackPoll(generation, tick)
                return
              }
            }
          }
          const stillWithinEndGuard =
            getTrackIdentity(latestState.currentTrack) === this.activePlaybackTrackId &&
            Date.now() < this.suppressEndedUntil &&
            displayPosition <= 0.25

          if (stillWithinEndGuard) {
            this.schedulePlaybackPoll(generation, tick)
            return
          }

          const { repeat } = usePlayerStore.getState()
          if (repeat === 'one') {
            const currentTrack = usePlayerStore.getState().currentTrack
            this.getLastFm()?.endTrack(true)
            await window.puros.audio.seek(0)
            await window.puros.audio.resume()
            if (currentTrack) {
              this.getLastFm()?.startTrack(currentTrack)
            }
          } else {
            await this.advanceToNextTrackFromEndedPlayback()
          }
          return
        }
      } catch {
        // Engine may not be ready yet
      }

      if (generation !== this.pollGeneration) return
      this.schedulePlaybackPoll(generation, tick)
    }
    this.schedulePlaybackPoll(generation, tick, 0)
  }

  private schedulePlaybackPoll(
    generation: number,
    tick: () => void | Promise<void>,
    delayMs = this.playbackPollDelayMs(),
  ) {
    if (generation !== this.pollGeneration) return
    if (this.pollId !== null) {
      clearTimeout(this.pollId)
    }
    this.pollTick = tick
    this.pollId = setTimeout(() => {
      this.pollId = null
      void tick()
    }, delayMs)
  }

  /** Full rate while the window is focused or the track is about to end; slower otherwise. */
  private playbackPollDelayMs(): number {
    const activity = getWindowActivity()
    if (activity === 'active') return PLAYBACK_POLL_INTERVAL_MS
    const { position, duration } = usePlayerStore.getState()
    if (duration > 0 && duration - position <= PLAYBACK_POLL_FULL_RATE_LEAD_SECONDS) return PLAYBACK_POLL_INTERVAL_MS
    return activity === 'hidden' ? HIDDEN_PLAYBACK_POLL_INTERVAL_MS : UNFOCUSED_PLAYBACK_POLL_INTERVAL_MS
  }

  /** Back in view: refresh what slowed or stopped polling while hidden left stale. */
  private catchUpAfterHidden() {
    if (this.pollId !== null && this.pollTick) {
      this.schedulePlaybackPoll(this.pollGeneration, this.pollTick, 0)
    }
    if (this.hardwareVolumePollId) void this.pollHardwareVolume()
  }

  private stopPolling() {
    this.clearDsdStartupFallbackTimer()
    this.pollGeneration += 1
    usePlayerStore.getState().setProcessingSpeed(null)
    if (this.pollId !== null) {
      clearTimeout(this.pollId)
      this.pollId = null
    }
    this.pollTick = null
  }

  /** Switch audio output device and mode. */
  // ---------------------------------------------------------------------------
  // Volume control (Roon-style: device / DSP / fixed per output device)
  // ---------------------------------------------------------------------------

  private loadVolumeModes(): Promise<void> {
    this.volumeModesLoaded ??= getJsonSetting<Record<string, unknown>>(AUDIO_VOLUME_MODES_SETTING_KEY, {})
      .then((raw) => {
        const modes: Record<string, VolumeModeSetting> = {}
        for (const [uid, mode] of Object.entries(raw ?? {})) {
          if (isVolumeModeSetting(mode)) modes[uid] = mode
        }
        this.volumeModes = modes
      })
    return this.volumeModesLoaded
  }

  getVolumeMode(deviceUid: string | null | undefined): VolumeModeSetting {
    if (!deviceUid || deviceUid === DEFAULT_DEVICE_ID) return 'auto'
    return this.volumeModes[deviceUid] ?? 'auto'
  }

  async setVolumeMode(deviceUid: string, mode: VolumeModeSetting): Promise<void> {
    if (deviceUid === DEFAULT_DEVICE_ID) return
    await this.loadVolumeModes()
    if (mode === 'auto') delete this.volumeModes[deviceUid]
    else this.volumeModes[deviceUid] = mode
    await setJsonSetting(AUDIO_VOLUME_MODES_SETTING_KEY, this.volumeModes)

    if (usePlayerStore.getState().audioDevice !== deviceUid) return
    await this.syncVolumeControl()

    // PCM → DSD cannot carry DSP volume either: replay the track as PCM.
    if (this.currentDsdOutputRate > 0 && usePlayerStore.getState().volumeControl.effective === 'dsp') {
      await this.reapplyOutput()
      return
    }

    // Native DoP cannot carry DSP volume — move a playing DSD track onto the PCM path.
    const latest = usePlayerStore.getState()
    if (latest.volumeControl.effective === 'dsp' && latest.currentTrack && this.isNativeDopPlayback(latest)) {
      await this.switchCurrentDsdTrackToExclusivePcmFallback(latest.currentTrack, latest.deviceCapabilities)
    }
  }

  private isNativeDopPlayback(state: ReturnType<typeof usePlayerStore.getState>): boolean {
    if (state.audioMode !== 'exclusive' || !state.currentTrack?.formatInfo?.isDsd) return false
    const decision = state.playbackDecision
    return !(decision?.mode === 'RESAMPLED' && decision.reason.includes('DSD source converted to PCM fallback'))
  }

  private resolveExclusiveVolumeMode(
    deviceUid: string | null | undefined,
    hardwareVolume: boolean | undefined,
  ): EffectiveVolumeMode {
    return resolveVolumeMode('exclusive', this.getVolumeMode(deviceUid), !!hardwareVolume)
  }

  private currentSoftwareVolume(): number {
    const state = usePlayerStore.getState()
    const effective = state.volumeControl.effective
    return effective === 'system' || effective === 'dsp' ? state.volume : this.softwareVolume
  }

  /**
   * Runs before an exclusive open so audio never starts louder than the slider:
   * DSP volume gets its gain up front, and a DAC taking over as volume control
   * is lowered to the current slider position if it sits higher.
   */
  private async primeExclusiveVolume(deviceUid: string, hardwareVolume: boolean | undefined) {
    const mode = this.resolveExclusiveVolumeMode(deviceUid, hardwareVolume)
    const softwareVolume = this.currentSoftwareVolume()
    await window.puros.audio.setDigitalVolume(mode === 'dsp' ? userVolumeToGain(softwareVolume) : 1)
      .catch(() => undefined)
    const current = usePlayerStore.getState().volumeControl.effective
    if (mode === 'device' && (current === 'system' || current === 'dsp')) {
      const info = await window.puros.audio.getHardwareVolume(deviceUid).catch(() => null)
      if (info?.supported) await this.carryVolumeToHardware(deviceUid, softwareVolume, info)
    }
    await this.applyMaxVolumeAtStart(deviceUid, hardwareVolume)
  }

  /** Lower the DAC to `volume` when it is louder; returns the resulting hardware state. */
  private async carryVolumeToHardware(
    deviceUid: string,
    volume: number,
    info: HardwareVolumeInfo,
  ): Promise<HardwareVolumeInfo> {
    if (hardwareVolumeToUserVolume(info) <= volume + 0.001) return info
    try {
      if (volume <= 0 && info.muteSupported) {
        await window.puros.audio.setHardwareMute(deviceUid, true)
      } else {
        await window.puros.audio.setHardwareVolume(deviceUid, volume)
      }
      return await window.puros.audio.getHardwareVolume(deviceUid)
    } catch (error) {
      console.warn('[Puros] Could not hand volume over to the device:', error)
      return info
    }
  }

  /** Store update that mirrors engine/DAC state; must not be written back to the device. */
  private setVolumeFromEngine(volume: number) {
    this.volumeFromEngine = true
    try {
      usePlayerStore.getState().setVolume(volume)
    } finally {
      this.volumeFromEngine = false
    }
  }

  private applyVolume(state: ReturnType<typeof usePlayerStore.getState>) {
    const { effective } = state.volumeControl
    const gain = userVolumeToGain(state.volume)

    switch (effective) {
      case 'system':
        this.softwareVolume = state.volume
        void window.puros.audio.setVolume(gain).catch(() => undefined)
        break
      case 'dsp':
        this.softwareVolume = state.volume
        void window.puros.audio.setDigitalVolume(gain).catch(() => undefined)
        break
      case 'device':
        void window.puros.audio.setDigitalVolume(1).catch(() => undefined)
        if (!this.volumeFromEngine && state.audioDevice) {
          this.queueHardwareVolumeWrite(state.audioDevice, state.volume)
        }
        break
      case 'fixed':
        void window.puros.audio.setDigitalVolume(1).catch(() => undefined)
        break
    }
  }

  private async syncVolumeControl(): Promise<void> {
    const token = ++this.volumeSyncToken
    await this.loadVolumeModes()
    const store = usePlayerStore.getState()
    const deviceUid = store.audioDevice
    const physicalDevice = !!deviceUid && deviceUid !== DEFAULT_DEVICE_ID
    let hardwareInfo = store.audioMode === 'exclusive' && physicalDevice
      ? await window.puros.audio.getHardwareVolume(deviceUid).catch(() => null)
      : null
    if (token !== this.volumeSyncToken) return

    const previous = usePlayerStore.getState().volumeControl
    const previousDeviceUid = this.volumeControlDeviceUid
    const configured = this.getVolumeMode(deviceUid)
    const hardwareAvailable = !!hardwareInfo?.supported
    const effective = resolveVolumeMode(usePlayerStore.getState().audioMode, configured, hardwareAvailable)
    const takesOverFromSoftware =
      effective === 'device' && (previous.effective === 'system' || previous.effective === 'dsp')

    // Never jump louder when the DAC takes over: lower it to the slider before digital gain goes to unity.
    if (takesOverFromSoftware && hardwareInfo?.supported && deviceUid) {
      hardwareInfo = await this.carryVolumeToHardware(deviceUid, this.softwareVolume, hardwareInfo)
      if (token !== this.volumeSyncToken) return
    }

    const next: VolumeControlState = {
      configured,
      effective,
      hardwareAvailable,
      hardware: hardwareInfo?.supported ? toHardwareVolumeState(hardwareInfo) : null,
    }
    this.volumeControlDeviceUid = deviceUid
    usePlayerStore.getState().setVolumeControl(next)

    if (next.effective === 'device' && next.hardware) {
      if (previous.effective !== 'device' || previousDeviceUid !== deviceUid) {
        this.setVolumeFromEngine(hardwareVolumeToUserVolume(next.hardware))
      }
    } else if (previous.effective !== next.effective) {
      if (next.effective === 'fixed') {
        this.setVolumeFromEngine(1)
      } else if (previous.effective === 'device' || previous.effective === 'fixed') {
        this.setVolumeFromEngine(this.softwareVolume)
      }
    }
    // Digital stage and mixer follow the new mode; device mode already mirrors the DAC, so no write-back.
    this.volumeFromEngine = next.effective === 'device'
    try {
      this.applyVolume(usePlayerStore.getState())
    } finally {
      this.volumeFromEngine = false
    }
    this.updateHardwareVolumePolling()
  }

  private queueHardwareVolumeWrite(deviceUid: string, volume: number) {
    this.pendingHardwareVolume = { deviceUid, volume }
    if (this.hardwareVolumeWriting) return
    this.hardwareVolumeWriting = true
    void (async () => {
      try {
        while (this.pendingHardwareVolume) {
          const pending = this.pendingHardwareVolume
          this.pendingHardwareVolume = null
          await this.writeHardwareVolume(pending.deviceUid, pending.volume)
        }
      } finally {
        this.hardwareVolumeWriting = false
      }
    })()
  }

  private async writeHardwareVolume(deviceUid: string, volume: number) {
    try {
      const hardware = usePlayerStore.getState().volumeControl.hardware
      const mute = volume <= 0
      if (hardware?.muteSupported && hardware.muted !== mute) {
        await window.puros.audio.setHardwareMute(deviceUid, mute)
      }
      if (!mute || !hardware?.muteSupported) {
        const result = await window.puros.audio.setHardwareVolume(deviceUid, volume)
        if (!result.success) console.warn('[Puros] Device volume change failed:', result.error)
      }
      const info = await window.puros.audio.getHardwareVolume(deviceUid)
      const latest = usePlayerStore.getState()
      if (info.supported && latest.audioDevice === deviceUid && latest.volumeControl.effective === 'device') {
        latest.setVolumeControl({ ...latest.volumeControl, hardware: toHardwareVolumeState(info) })
      }
    } catch (error) {
      console.warn('[Puros] Device volume change failed:', error)
    }
  }

  private updateHardwareVolumePolling() {
    const active = usePlayerStore.getState().volumeControl.effective === 'device'
    if (active && !this.hardwareVolumePollId) {
      this.hardwareVolumePollId = setInterval(() => void this.pollHardwareVolume(), HARDWARE_VOLUME_POLL_INTERVAL_MS)
    } else if (!active && this.hardwareVolumePollId) {
      clearInterval(this.hardwareVolumePollId)
      this.hardwareVolumePollId = null
    }
  }

  /** Mirror changes made on the DAC itself (knob, macOS volume keys) into the slider. */
  private async pollHardwareVolume() {
    const isQuiet = () =>
      !this.hardwareVolumeWriting && Date.now() - this.lastLocalVolumeChangeAt >= HARDWARE_VOLUME_LOCAL_GRACE_MS
    const deviceUid = usePlayerStore.getState().audioDevice
    // Nobody sees the slider while hidden; catchUpAfterHidden reads the DAC on return.
    if (!deviceUid || !isQuiet() || isWindowHidden()) return
    const info = await window.puros.audio.getHardwareVolume(deviceUid).catch(() => null)
    const latest = usePlayerStore.getState()
    if (!info?.supported || latest.audioDevice !== deviceUid || latest.volumeControl.effective !== 'device') return
    if (!isQuiet()) return

    const hardware = toHardwareVolumeState(info)
    const previous = latest.volumeControl.hardware
    if (
      !previous ||
      previous.scalar !== hardware.scalar ||
      previous.muted !== hardware.muted ||
      previous.decibels !== hardware.decibels
    ) {
      latest.setVolumeControl({ ...latest.volumeControl, hardware })
    }
    const volume = hardwareVolumeToUserVolume(hardware)
    if (Math.abs(volume - latest.volume) > 0.002) this.setVolumeFromEngine(volume)
  }

  /** Reopen the current output with the current settings, resuming playback where it was. */
  async reapplyOutput(): Promise<void> {
    const state = usePlayerStore.getState()
    if (!state.audioDevice || state.audioMode === 'closed') return
    await this.setDevice(state.audioDevice, state.audioMode)
  }

  async setDevice(deviceUid: string, mode: 'exclusive' | 'shared'): Promise<void> {
    const store = usePlayerStore.getState()
    const wasPlaying = store.isPlaying
    const currentTrack = store.currentTrack
    const currentPos = store.position
    this.clearNativeQueueState()

    // "__default__" is always shared — never exclusive
    const [devices, audioSetup] = await Promise.all([
      window.puros.audio.listDevices(),
      this.loadAudioSetup(),
    ])
    const physicalDevices = devices.filter(d => !d.isVirtual)
    const targetDevice = physicalDevices.find(d => d.uid === deviceUid)
    const forcedSharedTransport = this.getSharedOnlyTransportLabel(targetDevice)

    if (targetDevice && !isDeviceEnabled(audioSetup, deviceUid)) {
      this.showNotification(`${this.deviceDisplayName(targetDevice)} is disabled in Audio Setup`)
      return
    }
    await this.syncResamplerConfig(deviceUid)

    const effectiveMode: 'exclusive' | 'shared' =
      deviceUid === DEFAULT_DEVICE_ID || forcedSharedTransport ? 'shared' : mode

    // Set the exclusive DSP gain before the device starts so audio never starts at full scale.
    await this.loadVolumeModes()
    if (effectiveMode === 'exclusive') {
      await this.primeExclusiveVolume(deviceUid, targetDevice?.hardwareVolume)
    }

    // Stop current playback
    if (wasPlaying) {
      await window.puros.audio.stopPlayback()
    }

    // Close current device
    await window.puros.audio.close()

    // Open new device
    let result: { success: boolean; error?: string }
    if (effectiveMode === 'exclusive') {
      // Use format decision to pick the right format for the current track
      let trackFormat = this.getTrackFormat(store)
      const device = targetDevice ?? physicalDevices[0]
      const caps = device ? this.deviceCapabilities(device) : null

      const currentPlaybackPath = this.getTrackPlaybackPath(store.currentTrack)
      if (currentPlaybackPath && store.currentTrack?.formatInfo?.isDsd) {
        if (this.canUseNativeDop(store.currentTrack, caps, 'exclusive', deviceUid)) {
          trackFormat = this.getDsdCarrierTrackFormat(store.currentTrack.formatInfo) ?? trackFormat
        } else {
          try {
            const prepared = await this.prepareLocalFile(
              currentPlaybackPath,
              store.currentTrack.formatInfo,
              caps,
              deviceUid,
            )
            trackFormat = this.toTrackFormat(prepared.outputFormat) ?? trackFormat
          } catch (err) {
            store.setAudioError(err instanceof Error ? err.message : 'Failed to prepare DSD playback')
            return
          }
        }
      }

      const dsdRate = trackFormat && device
        ? this.dsdOutputPlan(store.currentTrack, caps ?? this.deviceCapabilities(device), deviceUid, 'exclusive')
        : 0
      this.currentDsdOutputRate = dsdRate
      if (trackFormat && device && dsdRate > 0) {
        const resolvedCaps = caps ?? this.deviceCapabilities(device)
        const decision = this.dsdOutputDecision(trackFormat, store.currentTrack?.formatInfo, dsdRate, deviceUid)
        store.setPlaybackDecision(decision)
        store.setDeviceCapabilities(resolvedCaps)
        result = await window.puros.audio.openExclusive(deviceUid, decision.deviceSampleRate, 32, true)
      } else if (trackFormat && device) {
        const resolvedCaps = caps ?? this.deviceCapabilities(device)
        const decision = store.currentTrack?.formatInfo?.isDsd && !this.canUseNativeDop(store.currentTrack, resolvedCaps, 'exclusive', deviceUid)
          ? this.createDsdPcmFallbackDecision(
              store.currentTrack.formatInfo,
              this.decidePlaybackFormat(trackFormat, resolvedCaps, deviceUid),
              {
                format: 'WAV',
                sampleRate: trackFormat.sampleRate,
                bitDepth: trackFormat.bitDepth,
                bitrate: 0,
                channels: trackFormat.channels,
                isLossless: true,
                isHiRes: trackFormat.sampleRate > 48_000 || trackFormat.bitDepth > 16,
                isMqa: false,
                isDsd: false,
              },
            ) ?? this.decidePlaybackFormat(trackFormat, resolvedCaps, deviceUid)
          : this.decidePlaybackFormat(trackFormat, resolvedCaps, deviceUid)
        store.setPlaybackDecision(decision)
        store.setDeviceCapabilities(resolvedCaps)
        result = await window.puros.audio.openExclusive(
          deviceUid,
          decision.deviceSampleRate,
          decision.deviceBitDepth,
          !!store.currentTrack?.formatInfo?.isDsd && this.canUseNativeDop(store.currentTrack, resolvedCaps, 'exclusive', deviceUid),
        )
      } else {
        // No track format info — use device defaults
        result = await window.puros.audio.openExclusive(deviceUid, 44100, 16, false)
      }
    } else {
      this.currentDsdOutputRate = 0
      result = await window.puros.audio.openShared(deviceUid)
    }

    if (result.success) {
      store.setAudioDevice(deviceUid)
      store.setAudioMode(effectiveMode)
      store.setAudioError(null)
      store.setOutputMode(effectiveMode === 'exclusive' ? 'EXCLUSIVE' : 'SHARED')

      // Device name
      if (deviceUid === DEFAULT_DEVICE_ID) {
        store.setDeviceName('Default System Settings')
      } else if (targetDevice) {
        store.setDeviceName(this.deviceDisplayName(targetDevice))
      }

      // Persist preference
      await this.persistAudioRoute(deviceUid, effectiveMode)

      // Update device format and capabilities (also refreshes resolvedDeviceName)
      try {
        const fmt = await window.puros.audio.getCurrentFormat()
        if (fmt.sampleRate > 0) store.setDeviceFormat(fmt)
      } catch {
        // Device format is best effort during route changes.
      }
      await this.refreshDeviceCapabilities()

      if (mode === 'exclusive' && forcedSharedTransport) {
        this.showNotification(`${forcedSharedTransport} outputs use shared mode on macOS`)
      }

      // Resume playback if we were playing
      if (wasPlaying && currentTrack) {
        await this.waitForResync(deviceUid)
        let playbackTarget: string | null = null
        let playedTrack = currentTrack
        try {
          const resolved = await this.resolvePlaybackTarget(currentTrack, usePlayerStore.getState().deviceCapabilities)
          playbackTarget = resolved?.playbackTarget ?? null
          playedTrack = resolved?.track ?? currentTrack
        } catch (err) {
          console.error('resolvePlaybackTarget during device switch failed:', err)
          store.setAudioError(
            err instanceof Error ? err.message : 'Unable to resume current track on the new output device'
          )
          return
        }
        if (!playbackTarget) return
        const playResult = await this.playNativeFile(playbackTarget, playedTrack)
        if (playResult.success) {
          const cueSlice = this.getCueSlice(playedTrack)
          const resumePosition = cueSlice ? cueSlice.startSeconds + currentPos : currentPos
          if (resumePosition > 0) await window.puros.audio.seek(resumePosition)
          store.play()
          this.startPolling()
        }
      }
    } else {
      store.setAudioError(result.error ?? 'Failed to open device')
      store.setAudioMode('closed')
      // Try to fallback to shared mode for physical devices
      if (effectiveMode === 'exclusive') {
        const blockedTransport = getExclusiveBlockedTransportLabel(result.error)
        const fallback = await window.puros.audio.openShared(deviceUid)
        if (fallback.success) {
          store.setAudioMode('shared')
          store.setOutputMode('SHARED')
          store.setAudioError(
            blockedTransport ? null : result.error + ' — fell back to shared mode'
          )
          await this.persistAudioRoute(deviceUid, 'shared')
          await this.refreshDeviceCapabilities()
          if (result.error === 'BLUETOOTH_DEVICE') this.refreshBluetoothInfo()
        }
      }
    }
  }

  /**
   * Put a saved session back into the player. The engine stays idle until play,
   * which then starts the track at the restored position.
   */
  async restoreSession(session: RestoredPlayerSession, options: { autoplay: boolean }) {
    this.pendingRestoreIdentity = getTrackIdentity(session.currentTrack)
    this.restoringSession = true
    try {
      usePlayerStore.getState().restoreSession(session)
    } finally {
      this.restoringSession = false
    }
    if (!options.autoplay) return
    await this.initialDeviceOpen?.catch(() => undefined)
    const latest = usePlayerStore.getState()
    if (getTrackIdentity(latest.currentTrack) === this.pendingRestoreIdentity && !latest.isPlaying) latest.play()
  }

  destroy() {
    if (this.hardwareVolumePollId) {
      clearInterval(this.hardwareVolumePollId)
      this.hardwareVolumePollId = null
    }
    void this.cancelActiveProgressiveSessions()
    this.getLastFm()?.endTrack()
    this.clearNativeQueueState()
    this.stopPolling()
    if (this.notificationTimer) clearTimeout(this.notificationTimer)
    this.unsubscribe?.()
    this.unsubscribe = null
    this.ipcUnsubscribers.forEach((unsubscribe) => unsubscribe())
    this.ipcUnsubscribers = []
    this.clearMediaSession()
    window.puros.audio.close()
  }

  private clearMediaSession() {
    const mediaSession = this.getMediaSession()
    if (!mediaSession) return

    try {
      mediaSession.metadata = null
      mediaSession.playbackState = 'none'
      const actions: MediaSessionAction[] = [
        'play',
        'pause',
        'previoustrack',
        'nexttrack',
        'seekbackward',
        'seekforward',
        'seekto',
        'stop',
      ]
      actions.forEach((action) => {
        try {
          mediaSession.setActionHandler(action, null)
        } catch {
          // Ignore unsupported actions.
        }
      })
    } catch {
      // Ignore teardown failures.
    }

    if (this.mediaSessionBridgeElement && !this.mediaSessionBridgeElement.paused) {
      this.mediaSessionBridgeElement.pause()
    }
    this.mediaSessionBridgeElement = null

    if (this.mediaSessionBridgeContext) {
      void this.mediaSessionBridgeContext.close()
      this.mediaSessionBridgeContext = null
    }
  }
}

// Singleton
export const audioService = new AudioService()
