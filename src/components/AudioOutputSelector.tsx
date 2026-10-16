/**
 * Audio output device selector with exclusive/shared mode toggle.
 * Shows device capabilities, current format, and playback decision.
 *
 * The device list always begins with a virtual "Default System Settings" entry
 * (uid "__default__") that follows macOS's current default output device.
 */

import { Airplay, Check, ChevronDown, Headphones, Settings2, Speaker, Volume2 } from 'lucide-react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { useAudioSetupStore } from '../store/audioSetupStore'
import {
  deviceDisplayName,
  getDeviceConfig,
  isDeviceEnabled,
  resolvePreferredAudioMode,
} from '../services/audioDeviceConfig'
import { openSettings } from '../utils/openSettings'
import { audioService } from '../services/AudioService'
import type { AudioDevice } from '../../electron/preload'
import {
  VOLUME_MODE_SETTINGS,
  formatDecibels,
  gainToDecibels,
  isDspVolumeAttenuating,
  resolveVolumeMode,
  userVolumeToGain,
  volumeModeDescription,
  volumeModeLabel,
  type VolumeModeSetting,
} from '../services/volumeControl'
import {
  getTransportLabel,
  isBluetoothTransport,
  isAirPlayTransport,
  isSharedOnlyTransport,
} from '../utils/audioDeviceTransport'

function formatPlaybackSummary(
  audioMode: 'exclusive' | 'shared' | 'closed',
  playbackDecision: ReturnType<typeof usePlayerStore.getState>['playbackDecision'],
  dspVolumeDb: number | null,
): string | null {
  if (!playbackDecision) return null

  if (audioMode !== 'exclusive') {
    if (playbackDecision.mode === 'RESAMPLED') {
      return `SYSTEM MIXER ${playbackDecision.originalSampleRate / 1000}\u2192${playbackDecision.deviceSampleRate / 1000}kHz`
    }
    return `SYSTEM MIXER ${playbackDecision.deviceSampleRate / 1000}kHz`
  }

  if (playbackDecision.mode === 'BIT_PERFECT') {
    // Exclusive + DSP attenuation: the DAC still gets its native format, but not the original samples.
    return dspVolumeDb !== null ? `EXCLUSIVE · DSP VOLUME ${formatDecibels(dspVolumeDb)}` : 'BIT-PERFECT'
  }

  if (playbackDecision.mode === 'NATIVE_RATE') {
    return `NATIVE ${playbackDecision.deviceSampleRate / 1000}kHz (LOSSY SOURCE)`
  }

  if (playbackDecision.dsdOutputRate) {
    return `PCM ${playbackDecision.originalSampleRate / 1000}kHz \u2192 DSD${Math.round(playbackDecision.dsdOutputRate / 44100)} (DoP)`
  }

  return `RESAMPLED ${playbackDecision.originalSampleRate / 1000}\u2192${playbackDecision.deviceSampleRate / 1000}kHz`
}

function formatCapsSummary(fmts: AudioDevice['supportedFormats']): string {
  if (fmts.length === 0) return 'No formats reported'
  const rates = [...new Set(fmts.map(f => f.sampleRate))].sort((a, b) => a - b)
  const depths = [...new Set(fmts.map(f => f.bitDepth))].sort((a, b) => a - b)
  const hasInt = fmts.some(f => !f.isFloat)
  const maxRate = rates[rates.length - 1]
  const maxDepth = depths[depths.length - 1]
  return `Up to ${maxRate / 1000}kHz / ${maxDepth}bit${hasInt ? ' integer' : ' float'}`
}

function IconSpeaker({ className = 'w-4 h-4' }: { className?: string }) {
  return <Speaker className={className} />
}

function IconAirPlay({ className = 'w-4 h-4' }: { className?: string }) {
  return <Airplay className={className} />
}

function IconSystemDefault({ className = 'w-4 h-4' }: { className?: string }) {
  return <Volume2 className={className} />
}

function getAirPodsIconSrc(device: AudioDevice): string | null {
  if (!isBluetoothTransport(device.transportType)) return null

  const name = device.name.toLowerCase()
  if (!name.includes('airpods')) return null
  if (name.includes('airpods pro')) return '/airpods.pro.svg'
  if (name.includes('airpods max')) return '/airpods.max.svg'
  return '/airpods.svg'
}

function AudioDeviceIcon({ device, isAirPlay }: { device: AudioDevice; isAirPlay: boolean }) {
  const airPodsIconSrc = getAirPodsIconSrc(device)

  if (airPodsIconSrc) {
    return (
      <img
        src={airPodsIconSrc}
        alt=""
        aria-hidden="true"
        className="w-4 h-4 shrink-0 object-contain"
      />
    )
  }

  if (isAirPlay) {
    return <IconAirPlay className="w-4 h-4 shrink-0" />
  }

  return <IconSpeaker className="w-4 h-4 shrink-0" />
}

export default function AudioOutputSelector() {
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [expandedDevice, setExpandedDevice] = useState<string | null>(null)
  const [airPlayStatus, setAirPlayStatus] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const audioDevice = usePlayerStore((s) => s.audioDevice)
  const audioMode = usePlayerStore((s) => s.audioMode)
  const audioError = usePlayerStore((s) => s.audioError)
  const deviceName = usePlayerStore((s) => s.deviceName)
  const deviceFormat = usePlayerStore((s) => s.deviceFormat)
  const playbackDecision = usePlayerStore((s) => s.playbackDecision)
  const resolvedDeviceName = usePlayerStore((s) => s.resolvedDeviceName)
  const volume = usePlayerStore((s) => s.volume)
  const volumeControl = usePlayerStore((s) => s.volumeControl)
  const dspVolumeActive = isDspVolumeAttenuating(volumeControl, volume)
  const playbackSummary = formatPlaybackSummary(
    audioMode,
    playbackDecision,
    dspVolumeActive ? gainToDecibels(userVolumeToGain(volume)) : null,
  )
  const [volumeMode, setVolumeModeState] = useState<VolumeModeSetting>(() => audioService.getVolumeMode(audioDevice))
  const audioSetup = useAudioSetupStore((s) => s.setup)

  useEffect(() => {
    void useAudioSetupStore.getState().ensureLoaded()
  }, [])

  useEffect(() => {
    setVolumeModeState(audioService.getVolumeMode(audioDevice))
  }, [audioDevice, volumeControl.configured])

  const isDefaultDevice = audioDevice === '__default__'

  const refreshDevices = useCallback(async () => {
    const list = await window.puros.audio.listDevices()
    setDevices(list)
    return list
  }, [])

  useEffect(() => {
    refreshDevices()
  }, [refreshDevices])

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setIsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  const handleSelectDevice = async (device: AudioDevice) => {
    // Virtual default is always shared; physical devices follow their Audio Setup
    // exclusive preference, else the current mode
    const mode =
      device.isVirtual || isSharedOnlyTransport(device.transportType)
        ? 'shared'
        : resolvePreferredAudioMode(
            getDeviceConfig(audioSetup, device.uid),
            audioMode === 'exclusive' ? 'exclusive' : 'shared',
          )
    await audioService.setDevice(device.uid, mode)
    setIsOpen(false)
  }

  const handleToggleMode = async () => {
    if (exclusiveToggleDisabled) return
    const newMode = audioMode === 'exclusive' ? 'shared' : 'exclusive'
    const uid = audioDevice ?? 'default'
    await audioService.setDevice(uid, newMode)
  }

  const modeBadge = () => {
    switch (audioMode) {
      case 'exclusive':
        return (
          <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full bg-green-950 text-green-400">
            Exclusive
          </span>
        )
      case 'shared':
        return (
          <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full bg-orange-950 text-orange-400">
            Shared
          </span>
        )
      default:
        return (
          <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full bg-zinc-800 text-zinc-400">
            Closed
          </span>
        )
    }
  }

  // Partition into virtual (first) and physical devices; outputs disabled in Audio Setup are hidden
  const virtualDevice = devices.find(d => d.isVirtual)
  const connectedPhysicalDevices = devices.filter(d => !d.isVirtual)
  const physicalDevices = connectedPhysicalDevices.filter(d =>
    isDeviceEnabled(audioSetup, d.uid) || d.uid === audioDevice)
  const hiddenDeviceCount = connectedPhysicalDevices.length - physicalDevices.length
  const hasPhysical = physicalDevices.length > 0
  const hasAirPlayEntries = physicalDevices.some((device) => isAirPlayTransport(device.transportType))
  const activePhysicalDevice = !isDefaultDevice
    ? physicalDevices.find((device) => device.uid === audioDevice) ?? null
    : null
  const sharedOnlyTransportLabel = getTransportLabel(activePhysicalDevice?.transportType)
  const exclusiveToggleDisabled = isDefaultDevice || !!sharedOnlyTransportLabel
  const hardwareVolumeAvailable = audioMode === 'exclusive'
    ? volumeControl.hardwareAvailable
    : !!activePhysicalDevice?.hardwareVolume
  const volumeModePreview = resolveVolumeMode('exclusive', volumeMode, hardwareVolumeAvailable)

  const handleSelectVolumeMode = async (mode: VolumeModeSetting) => {
    if (!audioDevice || isDefaultDevice) return
    setVolumeModeState(mode)
    await audioService.setVolumeMode(audioDevice, mode)
  }

  const openAirPlayDiscovery = async () => {
    const resolveActiveAirPlayRoute = (list: AudioDevice[]) => {
      const physical = list.filter((device) => !device.isVirtual)
      const directRoute = physical.find((device) =>
        isAirPlayTransport(device.transportType) && device.isCurrentRoute
      )
      if (directRoute) return directRoute

      const virtual = list.find((device) => device.isVirtual)
      if (!virtual?.resolvedUid) return null
      const resolved = physical.find((device) => device.uid === virtual.resolvedUid) ?? null
      return resolved && isAirPlayTransport(resolved.transportType) ? resolved : null
    }

    const previousRoute = resolveActiveAirPlayRoute(devices)

    setAirPlayStatus(null)

    let pickerResult: Awaited<ReturnType<typeof window.puros.app.openAirPlayPicker>> | null = null
    try {
      pickerResult = await window.puros.app.openAirPlayPicker()
      if (pickerResult.requiresAccessibilityPermission) {
        setAirPlayStatus(
          'Grant Accessibility to your dev host (for example Terminal) for one-click route browsing, or pick the route manually in Sound settings.'
        )
      } else if (pickerResult.message) {
        setAirPlayStatus(pickerResult.message)
      }
    } catch (err) {
      console.warn('[Puros] System AirPlay picker failed, falling back to Sound settings:', err)
      await window.puros.app.openExternal('x-apple.systempreferences:com.apple.Sound-Settings.extension')
      setAirPlayStatus('Opened Sound settings. Select the AirPlay route there once and Puros will watch for it.')
    }

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const refreshedDevices = await refreshDevices()
      const nextRoute = resolveActiveAirPlayRoute(refreshedDevices)

      if (nextRoute && nextRoute.uid !== previousRoute?.uid && nextRoute.uid !== audioDevice) {
        if (!isDeviceEnabled(useAudioSetupStore.getState().setup, nextRoute.uid)) {
          setAirPlayStatus(`${nextRoute.name} is disabled in Audio Setup — enable it there to use it.`)
          return
        }
        try {
          await audioService.setDevice(nextRoute.uid, 'shared')
          setAirPlayStatus(`Switched to AirPlay route: ${deviceDisplayName(useAudioSetupStore.getState().setup, nextRoute)}`)
          setIsOpen(false)
        } catch (err) {
          console.warn('[Puros] Failed to switch to selected AirPlay route:', err)
          setAirPlayStatus('The AirPlay route appeared, but Puros could not switch to it automatically.')
        }
        return
      }

      await new Promise((resolve) => window.setTimeout(resolve, 750))
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      {/* Trigger button */}
      <button
        onClick={() => { setIsOpen((v) => !v); refreshDevices() }}
        className="p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
        title={`Output: ${deviceName ?? 'Default System Settings'} (${audioMode})`}
      >
        <Headphones className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-2 w-80 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50">
          {/* Header */}
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">Audio Output</h3>
            <div className="flex items-center gap-2">
              {modeBadge()}
              <button
                type="button"
                onClick={() => { setIsOpen(false); openSettings('audio') }}
                className="p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors"
                title="Audio Setup"
                aria-label="Open Audio Setup"
              >
                <Settings2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Exclusive mode toggle */}
          <div className="px-4 py-3 border-b border-white/10">
            <div className="flex items-center justify-between">
              <div>
                <p className={`text-sm ${isDefaultDevice ? 'text-zinc-500' : 'text-zinc-200'}`}>
                  Exclusive Mode
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {isDefaultDevice
                    ? 'Select a specific audio device to enable exclusive mode'
                    : sharedOnlyTransportLabel
                      ? `${sharedOnlyTransportLabel} outputs stay in shared mode on macOS`
                    : 'Bit-perfect output — takes full control of the DAC'}
                </p>
              </div>
              <button
                onClick={handleToggleMode}
                disabled={exclusiveToggleDisabled}
                title={
                  isDefaultDevice
                    ? 'Tryb ekskluzywny wymaga konkretnego urządzenia'
                    : sharedOnlyTransportLabel
                      ? `${sharedOnlyTransportLabel} uses shared mode`
                      : undefined
                }
                className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                  exclusiveToggleDisabled
                    ? 'opacity-40 cursor-not-allowed bg-zinc-800 border border-zinc-600'
                    : audioMode === 'exclusive'
                      ? 'bg-green-600'
                      : 'bg-zinc-800 border border-zinc-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200 ${
                    audioMode === 'exclusive' ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Volume control — how level is set in exclusive mode (Roon-style) */}
          {!exclusiveToggleDisabled && activePhysicalDevice && (
            <div className="px-4 py-3 border-b border-white/10">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-zinc-200">Volume Control</p>
                <div className="flex rounded-md border border-white/10 bg-white/[0.03] p-0.5">
                  {VOLUME_MODE_SETTINGS.map((mode) => {
                    const disabled = mode === 'device' && !hardwareVolumeAvailable
                    const selected = volumeMode === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        disabled={disabled}
                        onClick={() => void handleSelectVolumeMode(mode)}
                        title={disabled ? 'This device has no hardware volume control' : undefined}
                        className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                          selected
                            ? 'bg-white/15 text-zinc-100'
                            : disabled
                              ? 'text-zinc-600 cursor-not-allowed'
                              : 'text-zinc-400 hover:text-zinc-100'
                        }`}
                      >
                        {volumeModeLabel(mode)}
                      </button>
                    )
                  })}
                </div>
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                {volumeMode === 'auto' ? `${volumeModeLabel(volumeModePreview)}: ` : ''}
                {volumeModeDescription(volumeModePreview)}
                {audioMode !== 'exclusive' ? ' (applies in exclusive mode)' : ''}
              </p>
              {volumeModePreview === 'dsp' && (
                <p className="text-[11px] text-zinc-600 mt-0.5">DSD plays through PCM while DSP volume is active</p>
              )}
            </div>
          )}

          {/* Current device format + playback decision */}
          {deviceFormat && deviceFormat.sampleRate > 0 && (
            <div className="px-4 py-2 border-b border-white/10 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-500">Device Format</p>
                <span className="text-xs font-mono text-zinc-300">
                  {deviceFormat.bitDepth}bit / {deviceFormat.sampleRate / 1000}kHz / {deviceFormat.channels}ch
                </span>
              </div>
              {playbackDecision && (
                <div className="flex items-center justify-between">
                  <p className="text-xs text-zinc-500">Playback</p>
                  <span
                    className={`text-[10px] font-mono ${audioMode === 'exclusive' && playbackDecision.mode === 'BIT_PERFECT' ? (dspVolumeActive ? 'text-purple-300' : 'text-green-400') : audioMode === 'exclusive' && playbackDecision.mode === 'NATIVE_RATE' ? 'text-sky-300' : 'text-yellow-400'}`}
                    title={playbackDecision.reason}
                  >
                    {playbackSummary}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Error message */}
          {audioError && (
            <div className="px-4 py-2 bg-red-950/50 border-b border-red-900/30">
              <p className="text-xs text-red-400">{audioError}</p>
            </div>
          )}

          {/* Device list */}
          <div className="max-h-64 overflow-y-auto py-1">
            {devices.length === 0 ? (
              <p className="px-4 py-3 text-sm text-zinc-500">Brak urządzenia wyjściowego</p>
            ) : (
              <>
                {/* ── Virtual default entry ── */}
                {virtualDevice && (
                  <button
                    onClick={() => handleSelectDevice(virtualDevice)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/5 transition-colors ${
                      isDefaultDevice ? 'text-zinc-100' : 'text-zinc-400'
                    }`}
                  >
                    <IconSystemDefault className="w-4 h-4 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{virtualDevice.name}</p>
                      {/* Resolved physical device — shown when active or always as subtitle */}
                      {isDefaultDevice && resolvedDeviceName ? (
                        <p className="text-[10px] text-zinc-400 truncate">
                          Current Device: {resolvedDeviceName}
                        </p>
                      ) : (
                        <p className="text-[10px] text-zinc-500 truncate">
                          Follows system settings
                          {virtualDevice.resolvedName ? ` · ${virtualDevice.resolvedName}` : ''}
                        </p>
                      )}
                    </div>
                    {isDefaultDevice && (
                      <Check className="w-4 h-4 text-green-400 shrink-0" />
                    )}
                  </button>
                )}

                {/* Separator between virtual and physical devices */}
                {virtualDevice && hasPhysical && (
                  <div className="mx-4 my-1 border-t border-white/5" />
                )}

                {/* ── Physical devices ── */}
                {physicalDevices.map((device) => {
                  const isActive = !isDefaultDevice && device.uid === audioDevice
                  const isExpanded = expandedDevice === device.uid
                  const transportLabel = getTransportLabel(device.transportType)
                  const isAirPlay = isAirPlayTransport(device.transportType)
                  const sharedOnly = isSharedOnlyTransport(device.transportType)
                  return (
                    <div key={device.uid}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectDevice(device)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handleSelectDevice(device) } }}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/5 transition-colors cursor-pointer ${
                          isActive ? 'text-zinc-100' : 'text-zinc-400'
                        }`}
                      >
                        <AudioDeviceIcon device={device} isAirPlay={isAirPlay} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p className="text-sm truncate">{deviceDisplayName(audioSetup, device)}</p>
                            {transportLabel && (
                              <span className={`px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded-full shrink-0 ${
                                isAirPlay
                                  ? 'bg-sky-950 text-sky-300'
                                  : 'bg-zinc-800 text-zinc-300'
                              }`}>
                                {transportLabel}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-zinc-500">
                            {device.channels}ch &middot; {formatCapsSummary(device.supportedFormats)}
                            {sharedOnly ? ' · Shared only' : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {isActive && (
                            <Check className="w-4 h-4 text-green-400" />
                          )}
                          {device.supportedFormats.length > 0 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setExpandedDevice(isExpanded ? null : device.uid)
                              }}
                              className="p-0.5 text-zinc-600 hover:text-zinc-400"
                              title="Show supported formats"
                            >
                              <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Expanded format details */}
                      {isExpanded && device.supportedFormats.length > 0 && (
                        <div className="px-4 pb-2 pl-11">
                          <div className="flex flex-wrap gap-1">
                            {[...new Set(device.supportedFormats.map(f => f.sampleRate))].sort((a, b) => a - b).map(rate => (
                              <span key={rate} className="px-1.5 py-0.5 text-[9px] font-mono bg-zinc-800 text-zinc-400 rounded">
                                {rate / 1000}kHz
                              </span>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {[...new Set(device.supportedFormats.map(f => `${f.bitDepth}bit${f.isFloat ? ' float' : ''}`))]
                              .sort()
                              .map(label => (
                                <span key={label} className="px-1.5 py-0.5 text-[9px] font-mono bg-zinc-800 text-zinc-400 rounded">
                                  {label}
                                </span>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}

                {hiddenDeviceCount > 0 && (
                  <button
                    type="button"
                    onClick={() => { setIsOpen(false); openSettings('audio') }}
                    className="w-full px-4 py-2 text-left text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {hiddenDeviceCount} disabled {hiddenDeviceCount === 1 ? 'output' : 'outputs'} hidden · Audio Setup…
                  </button>
                )}
              </>
            )}
          </div>

          <div className="px-4 py-3 border-t border-white/10 bg-white/[0.02]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-zinc-200">
                  Browse AirPlay
                </p>
                <p className="text-[10px] text-zinc-500 mt-0.5">
                  {hasAirPlayEntries
                    ? 'Open the native AirPlay picker to wake additional routes and make them selectable here.'
                    : 'If a route like JacobHub is missing, open the native AirPlay picker once and Puros will refresh the route list.'}
                </p>
                {airPlayStatus && (
                  <p className="text-[10px] text-amber-300 mt-1 leading-relaxed">
                    {airPlayStatus}
                  </p>
                )}
              </div>
              <button
                onClick={() => { void openAirPlayDiscovery() }}
                className="shrink-0 px-2.5 py-1 text-[10px] font-medium rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                Browse
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
