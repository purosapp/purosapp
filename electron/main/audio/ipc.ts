import {
  dialog,
  ipcMain,
  type BrowserWindow,
} from 'electron'
import { prepareLocalPlaybackFile, resolveDsdPcmTarget, sanitizeDsdConversionOptions } from './localPlayback'
import type { NativeFirDesign, NativeResamplerConfig } from './engine'
import { isRestoreSourceHint, isValidNativeRestoreConfig } from '../../../src/services/restoreSettings'
import { detectPreEmphasis } from './emphasis'
import { listInstalledAudioPlugins } from './pluginDiscovery'
import { cancelAllWaveforms, cancelWaveform, finishWaveformSource, startWaveform } from './waveform'
import {
  buildAutoEQIndex,
  clearAudioEqProfile,
  clearQueuedAudioFile,
  closeAudio,
  consumeQueuedAudioAdvance,
  fetchAutoEQPreset,
  getAudioBluetoothInfo,
  getAudioDuration,
  getAudioEqEnabled,
  getAudioPluginParameters,
  getAudioMode,
  getAudioPosition,
  getAudioProcessingStats,
  getAudioRestoreStatus,
  getAudioVisualizerFrame,
  getCurrentAudioFormat,
  isAudioTrackEnded,
  listAudioDevices,
  onAudioPluginChange,
  onAudioPluginDisable,
  openAudioPluginEditor,
  openExclusiveAudio,
  openSharedAudio,
  pauseAudioPlayback,
  probeAudioPlugin,
  playAudioFile,
  queueNextAudioFile,
  readAudioEqFile,
  resumeAudioPlayback,
  seekAudioPlayback,
  setAudioCrossfeed,
  setAudioPlugins,
  setAudioPluginParameter,
  setAudioEqEnabled,
  setAudioEqProfile,
  setAudioVolume,
  setAudioDigitalVolume,
  getAudioHardwareVolume,
  setAudioHardwareVolume,
  setAudioHardwareMute,
  setAudioHardwareBufferOptions,
  setAudioResamplerConfig,
  setAudioRestoreConfig,
  getAudioResamplerStatus,
  inspectAudioImpulseResponse,
  previewAudioFirFilter,
  stopAudioPlayback,
  writeAudioBuffer,
} from './workflows'

function isValidSoxrFilter(filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return false
  const f = filter as Record<string, unknown>
  return ['recipe', 'precision', 'phaseResponse', 'passbandEnd', 'stopbandBegin']
    .every((key) => typeof f[key] === 'number' && Number.isFinite(f[key])) &&
    typeof f.steepFilter === 'boolean' && typeof f.allowAliasing === 'boolean'
}

function isValidFirDesign(design: unknown): design is NativeFirDesign {
  if (!design || typeof design !== 'object') return false
  const d = design as Record<string, unknown>
  return ['kaiser', 'blackman-harris', 'gauss'].includes(d.window as string) &&
    ['tapsPerPhase', 'cutoff', 'attenuationDb'].every((key) => typeof d[key] === 'number' && Number.isFinite(d[key])) &&
    typeof d.minimumPhase === 'boolean' && typeof d.apodizing === 'boolean'
}

function isValidConvolution(convolution: unknown): boolean {
  if (convolution === null) return true
  if (!convolution || typeof convolution !== 'object') return false
  const c = convolution as Record<string, unknown>
  return typeof c.path === 'string' && c.path.length > 0 &&
    typeof c.gainDb === 'number' && Number.isFinite(c.gainDb) && typeof c.compensateDelay === 'boolean'
}

function isValidResamplerConfig(config: NativeResamplerConfig): boolean {
  return !!config && typeof config === 'object' &&
    ['soxr', 'fir', 'apple'].includes(config.engine) &&
    isValidSoxrFilter(config.filter1x) && isValidSoxrFilter(config.filterNx) &&
    isValidFirDesign(config.fir1x) && isValidFirDesign(config.firNx) && isValidConvolution(config.convolution) &&
    Number.isFinite(config.appleQuality) && Number.isFinite(config.headroomDb) &&
    typeof config.headroomAuto === 'boolean' &&
    ['linear', 'normal', 'mastering'].includes(config.appleComplexity) &&
    ['none', 'tpdf', 'gauss', 'shaped', 'shaped5', 'shaped9'].includes(config.dither) &&
    ['sdm5', 'sdm7', 'sdm7ec'].includes(config.modulator)
}

const DSD_OUTPUT_RATES = new Set([2822400, 5644800, 11289600])

function validDsdOutputRate(rate: unknown): number {
  return typeof rate === 'number' && DSD_OUTPUT_RATES.has(rate) ? rate : 0
}

type AudioIpcDeps = {
  readonly win: BrowserWindow | null
}

export function registerAudioIpc(deps: AudioIpcDeps): void {
  // Start discovery at app launch; opening the VST tab awaits the same scan.
  void listInstalledAudioPlugins()
  onAudioPluginChange((index, id, value) =>
    deps.win?.webContents.send('dsp:plugin-parameter-changed', index, id, value))
  onAudioPluginDisable((index) => deps.win?.webContents.send('dsp:plugin-disabled', index))
  const onModeChanged = (mode: 'exclusive' | 'shared' | 'closed') =>
    deps.win?.webContents.send('audio:mode-changed', mode)

  ipcMain.handle('audio:list-devices', () => listAudioDevices())
  ipcMain.handle('audio:open-exclusive', (
    _event,
    deviceUid: string,
    sampleRate: number,
    bitDepth: number,
    preferNonMixableInteger = false,
  ) => openExclusiveAudio(deviceUid, sampleRate, bitDepth, preferNonMixableInteger, onModeChanged))
  ipcMain.handle('audio:open-shared', (_event, deviceUid: string) =>
    openSharedAudio(deviceUid, onModeChanged))
  ipcMain.handle('audio:play-file', async (
    _event,
    filePath: string,
    allowResample = false,
    deemphasis = false,
    dsdOutputRate = 0,
    sourceHint: unknown = 'unknown',
  ) => playAudioFile(filePath, allowResample === true, deemphasis === true, validDsdOutputRate(dsdOutputRate),
    isRestoreSourceHint(sourceHint) ? sourceHint : 'unknown'))
  ipcMain.handle('audio:prepare-local-file', async (
    _event,
    filePath: string,
    sourceFormat?: { sampleRate?: number; dsdRate?: number; channels?: number; isDsd?: boolean } | null,
    dsdOptions?: unknown,
  ) => prepareLocalPlaybackFile(filePath, sourceFormat ?? null, sanitizeDsdConversionOptions(dsdOptions)))
  ipcMain.handle('audio:queue-next-file', (
    _event,
    filePath: string,
    allowResample = false,
    deemphasis = false,
    dsdOutputRate = 0,
    sourceHint: unknown = 'unknown',
  ) => queueNextAudioFile(filePath, allowResample === true, deemphasis === true, validDsdOutputRate(dsdOutputRate),
    isRestoreSourceHint(sourceHint) ? sourceHint : 'unknown'))
  ipcMain.handle('audio:set-resampler-config', (_event, config: NativeResamplerConfig) => {
    if (!isValidResamplerConfig(config)) throw new Error('Invalid resampler config')
    setAudioResamplerConfig(config)
  })
  ipcMain.handle('audio:detect-pre-emphasis', (
    _event,
    filePath: string,
    cueSheetPath?: string | null,
    startOffsetMs?: number | null,
  ) => {
    if (typeof filePath !== 'string' || !filePath) return false
    return detectPreEmphasis(
      filePath,
      typeof cueSheetPath === 'string' ? cueSheetPath : null,
      typeof startOffsetMs === 'number' && Number.isFinite(startOffsetMs) ? startOffsetMs : null,
    )
  })
  ipcMain.handle('audio:get-resampler-status', () => getAudioResamplerStatus())
  ipcMain.handle('audio:preview-fir-filter', (_event, design: NativeFirDesign, inputRate: number, outputRate: number) => {
    if (!isValidFirDesign(design) || !Number.isFinite(inputRate) || !Number.isFinite(outputRate) ||
        inputRate <= 0 || outputRate <= 0) {
      throw new Error('Invalid FIR preview request')
    }
    return previewAudioFirFilter(design, inputRate, outputRate)
  })
  ipcMain.handle('audio:inspect-impulse-response', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid impulse response path')
    return inspectAudioImpulseResponse(filePath)
  })
  ipcMain.handle('audio:pick-impulse-response', async () => {
    const result = await dialog.showOpenDialog(deps.win!, {
      title: 'Choose a room-correction filter',
      properties: ['openFile'],
      filters: [{ name: 'Impulse response', extensions: ['wav', 'aif', 'aiff', 'flac', 'caf'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle('audio:clear-queued-file', () => clearQueuedAudioFile())
  ipcMain.handle('audio:stop-playback', () => stopAudioPlayback())
  ipcMain.handle('audio:pause', () => pauseAudioPlayback())
  ipcMain.handle('audio:resume', () => resumeAudioPlayback())
  ipcMain.handle('audio:seek', (_event, position: number) => seekAudioPlayback(position))
  ipcMain.handle('audio:write', (_event, buffer: Buffer) => writeAudioBuffer(buffer))
  ipcMain.handle('audio:get-mode', () => getAudioMode())
  ipcMain.handle('audio:get-position', () => getAudioPosition())
  ipcMain.handle('audio:get-duration', () => getAudioDuration())
  ipcMain.handle('audio:is-track-ended', () => isAudioTrackEnded())
  ipcMain.handle('audio:consume-queued-advance', () => consumeQueuedAudioAdvance())
  ipcMain.handle('audio:get-current-format', () => getCurrentAudioFormat())
  ipcMain.handle('audio:get-processing-stats', () => getAudioProcessingStats())
  ipcMain.handle('audio:get-visualizer-frame', () => getAudioVisualizerFrame())
  ipcMain.handle('waveform:start', (event, requestId: unknown, request: unknown) => {
    // ffmpeg reads the DSD file itself, not the engine's DSD → PCM target.
    const target = request && typeof request === 'object' ? (request as { path?: unknown }).path : null
    const dsdPcm = typeof target === 'string' ? resolveDsdPcmTarget(target) : null
    return startWaveform(event.sender, requestId, dsdPcm ? { ...request as object, path: dsdPcm.sourcePath } : request)
  })
  ipcMain.handle('waveform:finish-source', (_event, requestId: unknown) => finishWaveformSource(requestId))
  ipcMain.handle('waveform:cancel', (_event, requestId: unknown) => cancelWaveform(requestId))
  deps.win?.on('closed', cancelAllWaveforms)
  ipcMain.handle('audio:set-volume', (_event, gain: number) => setAudioVolume(gain))
  ipcMain.handle('audio:set-digital-volume', (_event, gain: number) => {
    if (typeof gain !== 'number' || !Number.isFinite(gain)) throw new Error('Invalid volume')
    setAudioDigitalVolume(Math.max(0, Math.min(1, gain)))
  })
  ipcMain.handle('audio:get-hardware-volume', (_event, deviceUid: string) => {
    if (typeof deviceUid !== 'string') throw new Error('Invalid device')
    return getAudioHardwareVolume(deviceUid)
  })
  ipcMain.handle('audio:set-hardware-volume', (_event, deviceUid: string, scalar: number) => {
    if (typeof deviceUid !== 'string' || typeof scalar !== 'number' || !Number.isFinite(scalar)) {
      throw new Error('Invalid volume')
    }
    return setAudioHardwareVolume(deviceUid, Math.max(0, Math.min(1, scalar)))
  })
  ipcMain.handle('audio:set-hardware-mute', (_event, deviceUid: string, muted: boolean) => {
    if (typeof deviceUid !== 'string' || typeof muted !== 'boolean') throw new Error('Invalid mute')
    return setAudioHardwareMute(deviceUid, muted)
  })
  ipcMain.handle('audio:set-hardware-buffer-options', (
    _event,
    deviceUid: string,
    useMax: boolean,
    powerOfTwo: boolean,
  ) => {
    if (typeof deviceUid !== 'string' || !deviceUid || typeof useMax !== 'boolean' || typeof powerOfTwo !== 'boolean') {
      throw new Error('Invalid hardware buffer options')
    }
    setAudioHardwareBufferOptions(deviceUid, useMax, powerOfTwo)
  })
  ipcMain.handle('dsp:set-eq-profile', (
    _event,
    bands: Array<{type: string; freq: number; gain: number; q: number}>,
    preampGainDb: number,
  ) => setAudioEqProfile(bands, preampGainDb))
  ipcMain.handle('dsp:set-crossfeed', (
    _event,
    enabled: boolean,
    cutoffFrequency: number,
    feedLevelDb: number,
  ) => setAudioCrossfeed(enabled, cutoffFrequency, feedLevelDb))
  ipcMain.handle('dsp:set-eq-enabled', (_event, enabled: boolean) =>
    setAudioEqEnabled(enabled))
  ipcMain.handle('dsp:get-eq-enabled', () => getAudioEqEnabled())
  ipcMain.handle('dsp:clear-eq-profile', () => clearAudioEqProfile())
  ipcMain.handle('dsp:set-restore-config', (_event, config: unknown) => {
    if (!isValidNativeRestoreConfig(config)) throw new Error('Invalid restore config')
    setAudioRestoreConfig(config)
  })
  ipcMain.handle('dsp:get-restore-status', () => getAudioRestoreStatus())
  ipcMain.handle('dsp:list-installed-plugins', (_event, refresh = false) =>
    listInstalledAudioPlugins(refresh === true))
  ipcMain.handle('dsp:add-installed-plugin', async (_event, filePath: string) => {
    const installed = await listInstalledAudioPlugins()
    if (typeof filePath !== 'string' || !installed.some((plugin) => plugin.path === filePath)) {
      throw new Error('Plug-in is not in the installed list')
    }
    return { path: filePath, name: probeAudioPlugin(filePath), enabled: true }
  })
  ipcMain.handle('dsp:add-plugin', async () => {
    const result = await dialog.showOpenDialog(deps.win!, {
      title: 'Add VST effect',
      properties: ['openFile'],
      filters: [{ name: 'VST plug-ins', extensions: ['vst', 'vst3'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    return { path: filePath, name: probeAudioPlugin(filePath), enabled: true }
  })
  ipcMain.handle('dsp:set-plugins', (_event, plugins: Array<{ path: string; name: string; enabled: boolean }>) => {
    if (!Array.isArray(plugins) || plugins.length > 16 || plugins.some((plugin) =>
      typeof plugin.path !== 'string' || !/\.vst3?$/.test(plugin.path) ||
      typeof plugin.name !== 'string' || typeof plugin.enabled !== 'boolean')) {
      throw new Error('Invalid plug-in stack')
    }
    setAudioPlugins(plugins)
  })
  ipcMain.handle('dsp:get-plugin-parameters', (_event, index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= 16) throw new Error('Invalid plug-in index')
    return getAudioPluginParameters(index)
  })
  ipcMain.handle('dsp:set-plugin-parameter', (_event, index: number, id: number, value: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= 16 ||
        !Number.isInteger(id) || id < 0 || id > 0xffffffff ||
        !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('Invalid plug-in parameter')
    }
    setAudioPluginParameter(index, id, value)
  })
  ipcMain.handle('dsp:open-plugin-editor', (_event, index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= 16) throw new Error('Invalid plug-in index')
    openAudioPluginEditor(index)
  })
  ipcMain.handle('dsp:load-eq-file', async () => {
    const result = await dialog.showOpenDialog(deps.win!, {
      properties: ['openFile'],
      title: 'Load AutoEQ Profile',
      filters: [{ name: 'AutoEQ Text', extensions: ['txt'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return readAudioEqFile(result.filePaths[0])
  })
  ipcMain.handle('autoeq:build-index', async () => buildAutoEQIndex())
  ipcMain.handle('autoeq:fetch-preset', async (_event, downloadUrl: string) =>
    fetchAutoEQPreset(downloadUrl))
  ipcMain.handle('audio:close', () => closeAudio(onModeChanged))
  ipcMain.handle('audio:get-bluetooth-info', () => getAudioBluetoothInfo())
}
