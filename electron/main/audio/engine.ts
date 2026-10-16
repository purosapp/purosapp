import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AudioPlugin, AudioPluginParameter } from '../../../src/types/plugins'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

interface SupportedFormat {
  sampleRate: number
  bitDepth: number
  isFloat: boolean
  channels: number
}

export type DoPCapability = 'DoP64' | 'DoP128' | 'DoP256' | 'FallbackPCM'


import type {
  FirPreview,
  ImpulseResponseInspection,
  NativeFirDesign,
  NativeResamplerConfig,
  ResamplerStatus,
} from '../../../src/services/resamplingSettings'

export type { FirPreview, ImpulseResponseInspection, NativeFirDesign, NativeResamplerConfig, ResamplerStatus }

export interface HardwareVolumeInfo {
  supported: boolean
  scalar: number
  decibels: number | null
  minDecibels: number | null
  maxDecibels: number | null
  muteSupported: boolean
  muted: boolean
}

export type NativeAudioDevice = {
    id: string; name: string; uid: string; channels: number; sampleRate: number
    transportType: number
    routeParentUid?: string
    routeDataSourceId?: number
    isRouteEndpoint?: boolean
    isCurrentRoute?: boolean
    dopCapability: DoPCapability
    hardwareVolume: boolean
    supportedFormats: SupportedFormat[]
    sampleRates: number[]; bitDepths: number[]
  }

export interface NativeAudioEngine {
  /** Runs off the JS thread: the HAL blocks while a device is being reconfigured. */
  listDevices(): Promise<NativeAudioDevice[]>
  // Device/playback control runs on the addon's control thread and resolves when done.
  openExclusive(deviceUid: string, sampleRate: number, bitDepth: number, preferNonMixableInteger?: boolean): Promise<{ success: boolean; error?: string }>
  openShared(deviceUid: string): Promise<{ success: boolean; error?: string }>
  getDefaultOutputDeviceUid(): string | null
  playFile(filePath: string, allowResample?: boolean, deemphasis?: boolean, dsdOutputRate?: number): Promise<{ success: boolean; error?: string }>
  startPcmStream(): Promise<{ success: boolean; error?: string }>
  queueNextFile(filePath: string, allowResample?: boolean, deemphasis?: boolean, dsdOutputRate?: number): Promise<{ success: boolean; error?: string }>
  clearQueuedFile(): Promise<void>
  stopPlayback(): Promise<void>
  pause(): void
  resume(): void
  seek(position: number): Promise<void>
  write(buffer: Buffer): void
  getMode(): 'exclusive' | 'shared' | 'closed'
  getPosition(): number
  getDuration(): number
  isTrackEnded(): boolean
  consumeQueuedAdvance(): boolean
  getCurrentFormat(): { sampleRate: number; bitDepth: number; channels: number }
  setResamplerConfig(config: NativeResamplerConfig): void
  getResamplerStatus(): ResamplerStatus
  previewFirFilter(design: NativeFirDesign, inputRate: number, outputRate: number): Promise<FirPreview>
  inspectImpulseResponse(filePath: string): Promise<ImpulseResponseInspection>
  getProcessingStats(): { speed: number; active: boolean }
  getVisualizerSnapshot(): {
    left: Float32Array
    right: Float32Array
    sampleRate: number
    valid: boolean
    peak: number
    rms: number
    paused: boolean
    active: boolean
  }
  setVolume(gain: number): Promise<void>
  setDigitalVolume(gain: number): void
  getHardwareVolume(deviceUid: string): HardwareVolumeInfo
  setHardwareVolume(deviceUid: string, scalar: number): { success: boolean; error?: string }
  setHardwareMute(deviceUid: string, muted: boolean): { success: boolean; error?: string }
  setHardwareBufferOptions(deviceUid: string, useMax: boolean, powerOfTwo: boolean): void
  setEQProfile(bands: Array<{type: string; freq: number; gain: number; q: number}>, preampGainDb: number): void
  setCrossfeed(enabled: boolean, cutoffFrequency: number, feedLevelDb: number): void
  probePlugin(path: string): string
  setPlugins(plugins: AudioPlugin[]): void
  getPluginParameters(index: number): AudioPluginParameter[]
  setPluginParameter(index: number, id: number, value: number): void
  openPluginEditor(index: number): void
  registerPluginChangeHandler(callback: (index: number, id: number, value: number) => void): void
  registerPluginDisableHandler(callback: (index: number) => void): void
  setEQEnabled(enabled: boolean): void
  getEQEnabled(): boolean
  clearEQProfile(): void
  setNowPlayingInfo(payload: {
    title: string
    artist: string
    album: string
    duration: number
    position: number
    artworkMimeType?: string
    artworkData?: Buffer
  }): void
  updateNowPlayingPlaybackState(state: 'playing' | 'paused' | 'stopped', position: number, duration: number): void
  clearNowPlayingInfo(): void
  registerRemoteCommandHandler(callback: (command: string) => void): void
  close(): Promise<void>
  /** Blocking close for app shutdown only. */
  closeSync(): void
}

let audioEngine: NativeAudioEngine | null = null

export function getAudioEngine(): NativeAudioEngine {
  if (!audioEngine) {
    const nativePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'puros_audio.node')
      : path.join(process.env.APP_ROOT!, 'native', 'build', 'Release', 'puros_audio.node')
    try {
      // In production the .node file is in extraResources
      audioEngine = require(nativePath) as NativeAudioEngine
    } catch (err) {
      console.error('Native audio engine not available:', err)
      const message = err instanceof Error ? err.message : String(err)
      const looksLikeArchMismatch = /incompatible architecture|wrong architecture|bad cpu type|x86_64|arm64/i.test(message)
      if (looksLikeArchMismatch) {
        throw new Error(
          `Native audio engine architecture mismatch for ${process.arch}. ` +
          `Addon path: ${nativePath}. Original error: ${message}`,
        )
      }
      throw new Error(
        `Native audio engine not available at ${nativePath}. ` +
        `Build the native addon for ${process.arch}. Original error: ${message}`,
      )
    }
  }
  return audioEngine
}

export async function openSystemSoundOutputPicker() {
  const scriptLines = [
    'on clickMenuBarItem(targetProcess, targetDescription)',
    '  tell application "System Events"',
    '    if not (exists process targetProcess) then return false',
    '    tell process targetProcess',
    '      repeat with itemRef in every menu bar item of menu bar 1',
    '        try',
    '          if (description of itemRef as text) is targetDescription then',
    '            click itemRef',
    '            return true',
    '          end if',
    '        end try',
    '      end repeat',
    '    end tell',
    '  end tell',
    '  return false',
    'end clickMenuBarItem',
    '',
    'if clickMenuBarItem("Control Center", "Sound") then return "sound-menu-bar"',
    'if clickMenuBarItem("SystemUIServer", "Sound") then return "sound-menu-bar"',
    '',
    'tell application "System Events"',
    '  if exists process "Control Center" then',
    '    tell process "Control Center"',
    '      repeat with itemRef in every menu bar item of menu bar 1',
    '        try',
    '          if (description of itemRef as text) is "Control Center" then',
    '            click itemRef',
    '            exit repeat',
    '          end if',
    '        end try',
    '      end repeat',
    '      delay 0.3',
    '      try',
    '        repeat with elementRef in entire contents of window 1',
    '          try',
    '            if (description of elementRef as text) is "Sound" then',
    '              click elementRef',
    '              return "control-center-sound"',
    '            end if',
    '          end try',
    '          try',
    '            if (title of elementRef as text) is "Sound" then',
    '              click elementRef',
    '              return "control-center-sound"',
    '            end if',
    '          end try',
    '        end repeat',
    '      end try',
    '    end tell',
    '  end if',
    'end tell',
    '',
    'tell application "System Settings"',
    '  activate',
    '  reveal pane id "com.apple.Sound-Settings.extension"',
    'end tell',
    'return "sound-settings"',
  ]

  const args = scriptLines.flatMap((line) => ['-e', line])
  const { stdout } = await execFileAsync('osascript', args)
  return stdout.trim()
}
