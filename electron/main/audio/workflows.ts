import fs from 'node:fs'
import type { AudioPlugin } from '../../../src/types/plugins'
import type { NativeRestoreConfig, RestoreSourceHint, RestoreStatus } from '../../../src/services/restoreSettings'
import { extractArtwork } from '../artwork/cache'
import { stopLiveRadioNativePlayback } from '../liveRadio/nativePlayback'
import { setPlaybackState } from '../playbackCoordinator'
import { getAutoEQIndex } from './autoeq'
import { resolveDsdPcmTarget } from './localPlayback'
import {
  detectBluetoothInfo,
  resolveListedOutputDevice,
  setDefaultModeActive,
} from './devices'
import {
  getAudioEngine,
  type DoPCapability,
  type HardwareVolumeInfo,
  type NativeFirDesign,
  type NativeResamplerConfig,
  type ResamplerStatus,
} from './engine'

export async function listAudioDevices() {
  try {
    const engine = getAudioEngine()
    const devices = await engine.listDevices()

    // Resolve the current system default so the UI can display the name
    let defaultResolvedName = ''
    let defaultResolvedUid = ''
    try {
      const uid = engine.getDefaultOutputDeviceUid()
      if (uid) {
        const dev = resolveListedOutputDevice(devices, uid)
        defaultResolvedUid = dev?.uid ?? uid
        if (dev) defaultResolvedName = dev.name
      }
    } catch { /* engine may not be ready */ }

    // Virtual "__default__" entry — always first
    const virtualDefault = {
      id: '__default__',
      name: 'Default System Settings',
      uid: '__default__',
      channels: 2,
      sampleRate: 0,
      transportType: 0,
      dopCapability: 'FallbackPCM' as DoPCapability,
      hardwareVolume: false,
      supportedFormats: [],
      sampleRates: [],
      bitDepths: [],
      isVirtual: true,
      isDefault: true,
      resolvedName: defaultResolvedName,
      resolvedUid: defaultResolvedUid,
    }
    return [virtualDefault, ...devices]
  } catch {
    return []
  }
}

export async function openExclusiveAudio(
  deviceUid: string,
  sampleRate: number,
  bitDepth: number,
  preferNonMixableInteger: boolean,
  onModeChanged: (mode: 'exclusive') => void,
) {
  // The virtual default device must never enter exclusive mode
  if (deviceUid === '__default__') {
    return { success: false, error: 'DEFAULT_DEVICE_NO_EXCLUSIVE' }
  }
  const engine = getAudioEngine()
  const result = await engine.openExclusive(deviceUid, sampleRate, bitDepth, preferNonMixableInteger)
  if (result.success) {
    setDefaultModeActive(false)
    onModeChanged('exclusive')
  }
  return result
}

export async function openSharedAudio(
  deviceUid: string,
  onModeChanged: (mode: 'shared') => void,
) {
  const engine = getAudioEngine()
  // "__default__" → pass "default" so findDeviceByUid() resolves via CoreAudio
  const resolvedUid = deviceUid === '__default__' ? 'default' : deviceUid
  const result = await engine.openShared(resolvedUid)
  if (result.success) {
    setDefaultModeActive(deviceUid === '__default__')
    onModeChanged('shared')
  }
  return result
}

export async function playAudioFile(
  filePath: string,
  allowResample = false,
  deemphasis = false,
  dsdOutputRate = 0,
  sourceHint: RestoreSourceHint = 'unknown',
) {
  // A DSD file heard as PCM: the engine decodes it with the target's settings.
  const dsdPcm = resolveDsdPcmTarget(filePath)
  const sourcePath = dsdPcm?.sourcePath ?? filePath
  // Artwork is read while the engine opens the file, not after: playback start never waits on tag parsing.
  const artworkTask = extractArtwork(sourcePath).catch(() => null)
  const result = await getAudioEngine().playFile(sourcePath, allowResample, deemphasis, dsdOutputRate, sourceHint,
    dsdPcm?.options ?? null)
  if (result.success) setPlaybackState('playing')
  const artwork = result.success ? await artworkTask : null
  return { ...result, artwork }
}

export async function queueNextAudioFile(
  filePath: string,
  allowResample = false,
  deemphasis = false,
  dsdOutputRate = 0,
  sourceHint: RestoreSourceHint = 'unknown',
) {
  const dsdPcm = resolveDsdPcmTarget(filePath)
  return getAudioEngine().queueNextFile(dsdPcm?.sourcePath ?? filePath, allowResample, deemphasis, dsdOutputRate,
    sourceHint, dsdPcm?.options ?? null)
}

export function setAudioResamplerConfig(config: NativeResamplerConfig): void {
  getAudioEngine().setResamplerConfig(config)
}

export function previewAudioFirFilter(design: NativeFirDesign, inputRate: number, outputRate: number) {
  return getAudioEngine().previewFirFilter(design, inputRate, outputRate)
}

export function inspectAudioImpulseResponse(filePath: string) {
  return getAudioEngine().inspectImpulseResponse(filePath)
}

export function getAudioResamplerStatus(): ResamplerStatus {
  try {
    return getAudioEngine().getResamplerStatus()
  } catch {
    return {
      float64: false, sourceBits: 0, sourceFloat: false, outputBits: 0, outputFloat: false,
      resampling: false, engine: null, inputRate: 0, outputRate: 0, ditherBits: 0, dither: 'none',
      filter: '1x', deemphasis: false, headroomDb: 0, headroomAuto: false, peakDb: -200, clippedSamples: 0,
      firTaps: 0, convolutionTaps: 0, convolutionError: null,
      dsdOutputRate: 0, modulator: null, modulatorOverloads: 0,
      dsdSourceRate: 0, dsdStages: 0, dsdFilterHz: 0, dsdGainDb: 0,
    }
  }
}

export async function clearQueuedAudioFile(): Promise<void> {
  await getAudioEngine().clearQueuedFile()
}

export async function stopAudioPlayback(): Promise<void> {
  stopLiveRadioNativePlayback()
  await getAudioEngine().stopPlayback()
  setPlaybackState('stopped')
}

export function pauseAudioPlayback(): void {
  getAudioEngine().pause()
}

export function resumeAudioPlayback(): void {
  getAudioEngine().resume()
  setPlaybackState('playing')
}

export async function seekAudioPlayback(position: number): Promise<void> {
  await getAudioEngine().seek(position)
}

export function writeAudioBuffer(buffer: Buffer): void {
  getAudioEngine().write(buffer)
}

export function getAudioMode() {
  try { return getAudioEngine().getMode() } catch { return 'closed' }
}

export function getAudioPosition(): number {
  try { return getAudioEngine().getPosition() } catch { return 0 }
}

export function getAudioDuration(): number {
  try { return getAudioEngine().getDuration() } catch { return 0 }
}

export function isAudioTrackEnded(): boolean {
  try { return getAudioEngine().isTrackEnded() } catch { return false }
}

export function consumeQueuedAudioAdvance(): boolean {
  try { return getAudioEngine().consumeQueuedAdvance() } catch { return false }
}

export function getCurrentAudioFormat() {
  try {
    return getAudioEngine().getCurrentFormat()
  } catch {
    return { sampleRate: 0, bitDepth: 0, channels: 0 }
  }
}

export function getAudioProcessingStats() {
  try {
    return getAudioEngine().getProcessingStats()
  } catch {
    return { speed: 0, active: false }
  }
}

export function getAudioVisualizerFrame() {
  try {
    const snapshot = getAudioEngine().getVisualizerSnapshot()
    return {
      left: Array.from(snapshot.left ?? []),
      right: Array.from(snapshot.right ?? []),
      sampleRate: snapshot.sampleRate ?? 0,
      valid: !!snapshot.valid,
      peak: snapshot.peak ?? 0,
      rms: snapshot.rms ?? 0,
      paused: !!snapshot.paused,
      active: !!snapshot.active,
    }
  } catch {
    return {
      left: [],
      right: [],
      sampleRate: 0,
      valid: false,
      peak: 0,
      rms: 0,
      paused: true,
      active: false,
    }
  }
}

export async function setAudioVolume(gain: number): Promise<void> {
  try { await getAudioEngine().setVolume(gain) } catch {
    // The engine may already be closed during shutdown.
  }
}

export function setAudioDigitalVolume(gain: number): void {
  try { getAudioEngine().setDigitalVolume(gain) } catch {
    // The engine may already be closed during shutdown.
  }
}

const UNSUPPORTED_HARDWARE_VOLUME: HardwareVolumeInfo = {
  supported: false,
  scalar: 0,
  decibels: null,
  minDecibels: null,
  maxDecibels: null,
  muteSupported: false,
  muted: false,
}

export function getAudioHardwareVolume(deviceUid: string): HardwareVolumeInfo {
  if (deviceUid === '__default__') return UNSUPPORTED_HARDWARE_VOLUME
  try {
    return getAudioEngine().getHardwareVolume(deviceUid)
  } catch {
    return UNSUPPORTED_HARDWARE_VOLUME
  }
}

export function setAudioHardwareVolume(deviceUid: string, scalar: number) {
  if (deviceUid === '__default__') return { success: false, error: 'DEFAULT_DEVICE_NO_HARDWARE_VOLUME' }
  return getAudioEngine().setHardwareVolume(deviceUid, scalar)
}

export function setAudioHardwareMute(deviceUid: string, muted: boolean) {
  if (deviceUid === '__default__') return { success: false, error: 'DEFAULT_DEVICE_NO_HARDWARE_VOLUME' }
  return getAudioEngine().setHardwareMute(deviceUid, muted)
}

export function setAudioHardwareBufferOptions(deviceUid: string, useMax: boolean, powerOfTwo: boolean) {
  if (deviceUid === '__default__') return
  getAudioEngine().setHardwareBufferOptions(deviceUid, useMax, powerOfTwo)
}

export function setAudioEqProfile(
  bands: Array<{type: string; freq: number; gain: number; q: number}>,
  preampGainDb: number,
): void {
  getAudioEngine().setEQProfile(bands, preampGainDb)
}

export function setAudioCrossfeed(
  enabled: boolean,
  cutoffFrequency: number,
  feedLevelDb: number,
): void {
  getAudioEngine().setCrossfeed(enabled, cutoffFrequency, feedLevelDb)
}

export function probeAudioPlugin(filePath: string): string {
  return getAudioEngine().probePlugin(filePath)
}

export function setAudioPlugins(plugins: AudioPlugin[]): void {
  getAudioEngine().setPlugins(plugins)
}

export function getAudioPluginParameters(index: number) {
  return getAudioEngine().getPluginParameters(index)
}

export function setAudioPluginParameter(index: number, id: number, value: number): void {
  getAudioEngine().setPluginParameter(index, id, value)
}

export function openAudioPluginEditor(index: number): void {
  getAudioEngine().openPluginEditor(index)
}

export function onAudioPluginChange(callback: (index: number, id: number, value: number) => void): void {
  getAudioEngine().registerPluginChangeHandler(callback)
}

export function onAudioPluginDisable(callback: (index: number) => void): void {
  getAudioEngine().registerPluginDisableHandler(callback)
}

export function setAudioEqEnabled(enabled: boolean): void {
  getAudioEngine().setEQEnabled(enabled)
}

export function getAudioEqEnabled(): boolean {
  try { return getAudioEngine().getEQEnabled() } catch { return false }
}

export function clearAudioEqProfile(): void {
  try { getAudioEngine().clearEQProfile() } catch {
    // The engine may already be closed during shutdown.
  }
}

export function setAudioRestoreConfig(config: NativeRestoreConfig): void {
  getAudioEngine().setRestoreConfig(config)
}

const IDLE_RESTORE_STATUS: RestoreStatus = {
  mode: 'off', state: 'off', reason: '', sourceClass: 'unknown', codec: null, position: 'source',
  cutoffHz: 0, confidence: 0, severity: 0, mix: 0, latencyMs: 0, sampleRate: 0,
}

export function getAudioRestoreStatus(): RestoreStatus {
  try { return getAudioEngine().getRestoreStatus() } catch { return IDLE_RESTORE_STATUS }
}

export function readAudioEqFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

export async function buildAutoEQIndex() {
  try {
    const entries = await getAutoEQIndex()
    return { success: true, entries, count: entries.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, rateLimited: msg === 'RATE_LIMIT', error: msg }
  }
}

export async function fetchAutoEQPreset(downloadUrl: string) {
  try {
    const url = new URL(downloadUrl)
    if (url.hostname !== 'raw.githubusercontent.com') throw new Error('Invalid URL')
    const res = await fetch(downloadUrl, { headers: { 'User-Agent': 'Puros/1.0' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { success: true, text: await res.text() }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function closeAudio(onModeChanged: (mode: 'closed') => void): Promise<void> {
  try {
    await getAudioEngine().close()
    setPlaybackState('stopped')
    onModeChanged('closed')
  } catch {
    // The engine may already be closed during shutdown.
  }
}

export async function getAudioBluetoothInfo() {
  return detectBluetoothInfo()
}
