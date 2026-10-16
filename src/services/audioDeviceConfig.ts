/**
 * Roon-style Audio Setup: per-output-device configuration.
 *
 * Every physical CoreAudio output can be enabled or disabled for Puros and
 * carries its own settings (display name, exclusive preference, DSD strategy,
 * resolution limits, resync delay, hardware buffer). Volume control mode is
 * stored separately by AudioService (`audioVolumeModes`) and edited here too.
 *
 * Only values that differ from the defaults are persisted, so "Restore
 * Defaults" is simply an empty config.
 */

import type { DeviceCapabilities } from './formatCompatibility'
import {
  DEFAULT_RESAMPLING,
  sanitizeResamplingSettings,
  type ResamplingSettings,
} from './resamplingSettings'
import {
  isAirPlayTransport,
  isBluetoothTransport,
} from '../utils/audioDeviceTransport'

export const AUDIO_DEVICE_CONFIG_SETTING_KEY = 'audioDeviceConfigs'
export const SYSTEM_DEFAULT_DEVICE_ID = '__default__'

export type ExclusivePreference = 'remember' | 'exclusive' | 'shared'
export type DsdPlaybackStrategy = 'dop' | 'pcm'
export type DsdRateLimit = 'DoP64' | 'DoP128' | 'DoP256'
export type DopCapability = DeviceCapabilities['dopCapability']

export interface AudioDeviceConfig {
  /** undefined → follows "Enable new devices automatically". */
  enabled?: boolean
  displayName?: string
  exclusive?: ExclusivePreference
  dsdStrategy?: DsdPlaybackStrategy
  maxSampleRate?: number
  maxBitDepth?: number
  maxDsdRate?: DsdRateLimit
  resyncDelayMs?: number
  /** CoreAudio exclusive: use the largest IO buffer the device allows. */
  maxHardwareBuffer?: boolean
  /** CoreAudio exclusive: round the IO buffer to a power of two (driver workaround). */
  powerOfTwoBuffer?: boolean
  maxVolumeAtStart?: boolean
  /** Device-specific resampling; undefined → the global Audio Setup settings. */
  resampling?: ResamplingSettings
  /** Remembered so disconnected devices can still be listed. */
  lastSeenName?: string
  lastSeenTransport?: number
  lastSeenAt?: number
}

export interface AudioSetupState {
  autoEnableNewDevices: boolean
  resampling: ResamplingSettings
  devices: Record<string, AudioDeviceConfig>
}

export const DEFAULT_AUDIO_SETUP: AudioSetupState = {
  autoEnableNewDevices: true,
  resampling: DEFAULT_RESAMPLING,
  devices: {},
}

export const RESYNC_DELAY_OPTIONS_MS = [0, 100, 250, 500, 750, 1000, 1500, 2000, 3000] as const
export const MAX_RESYNC_DELAY_MS = 3000

const EXCLUSIVE_PREFERENCES: readonly ExclusivePreference[] = ['remember', 'exclusive', 'shared']
const DSD_STRATEGIES: readonly DsdPlaybackStrategy[] = ['dop', 'pcm']
const DSD_RATE_LIMITS: readonly DsdRateLimit[] = ['DoP64', 'DoP128', 'DoP256']

const DOP_RANK: Record<DopCapability, number> = {
  FallbackPCM: 0,
  DoP64: 1,
  DoP128: 2,
  DoP256: 3,
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : undefined
}

/** Drop unknown keys and invalid values; the result only holds non-default settings. */
export function sanitizeDeviceConfig(raw: unknown): AudioDeviceConfig {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const config: AudioDeviceConfig = {}

  if (typeof input.enabled === 'boolean') config.enabled = input.enabled
  if (typeof input.displayName === 'string' && input.displayName.trim()) {
    config.displayName = input.displayName.trim().slice(0, 80)
  }
  const exclusive = oneOf(EXCLUSIVE_PREFERENCES, input.exclusive)
  if (exclusive && exclusive !== 'remember') config.exclusive = exclusive
  const dsdStrategy = oneOf(DSD_STRATEGIES, input.dsdStrategy)
  if (dsdStrategy && dsdStrategy !== 'dop') config.dsdStrategy = dsdStrategy
  const maxSampleRate = positiveInteger(input.maxSampleRate)
  if (maxSampleRate) config.maxSampleRate = maxSampleRate
  const maxBitDepth = positiveInteger(input.maxBitDepth)
  if (maxBitDepth) config.maxBitDepth = maxBitDepth
  const maxDsdRate = oneOf(DSD_RATE_LIMITS, input.maxDsdRate)
  if (maxDsdRate) config.maxDsdRate = maxDsdRate
  const resyncDelayMs = positiveInteger(input.resyncDelayMs)
  if (resyncDelayMs) config.resyncDelayMs = Math.min(resyncDelayMs, MAX_RESYNC_DELAY_MS)
  if (input.maxHardwareBuffer === true) config.maxHardwareBuffer = true
  if (input.powerOfTwoBuffer === true) config.powerOfTwoBuffer = true
  if (input.maxVolumeAtStart === true) config.maxVolumeAtStart = true
  if (input.resampling && typeof input.resampling === 'object') {
    config.resampling = sanitizeResamplingSettings(input.resampling)
  }
  if (typeof input.lastSeenName === 'string' && input.lastSeenName) config.lastSeenName = input.lastSeenName
  if (typeof input.lastSeenTransport === 'number') config.lastSeenTransport = input.lastSeenTransport
  const lastSeenAt = positiveInteger(input.lastSeenAt)
  if (lastSeenAt) config.lastSeenAt = lastSeenAt

  return config
}

export function sanitizeAudioSetup(raw: unknown): AudioSetupState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUDIO_SETUP, resampling: { ...DEFAULT_RESAMPLING }, devices: {} }
  const input = raw as Record<string, unknown>
  const devices: Record<string, AudioDeviceConfig> = {}
  if (input.devices && typeof input.devices === 'object') {
    for (const [uid, config] of Object.entries(input.devices as Record<string, unknown>)) {
      if (!uid || uid === SYSTEM_DEFAULT_DEVICE_ID) continue
      devices[uid] = sanitizeDeviceConfig(config)
    }
  }
  return {
    autoEnableNewDevices: typeof input.autoEnableNewDevices === 'boolean'
      ? input.autoEnableNewDevices
      : DEFAULT_AUDIO_SETUP.autoEnableNewDevices,
    resampling: sanitizeResamplingSettings(input.resampling),
    devices,
  }
}

/** The user-editable part of a config, without the "last seen" bookkeeping. */
export function hardwareBufferOptions(config: AudioDeviceConfig | undefined) {
  return { useMax: !!config?.maxHardwareBuffer, powerOfTwo: !!config?.powerOfTwoBuffer }
}

export function sameHardwareBufferOptions(a: AudioDeviceConfig | undefined, b: AudioDeviceConfig | undefined) {
  return !!a?.maxHardwareBuffer === !!b?.maxHardwareBuffer && !!a?.powerOfTwoBuffer === !!b?.powerOfTwoBuffer
}

export function editableDeviceConfig(config: AudioDeviceConfig | undefined): AudioDeviceConfig {
  const { lastSeenName: _name, lastSeenTransport: _transport, lastSeenAt: _at, ...editable } = config ?? {}
  return editable
}

export function isDeviceEnabled(
  setup: AudioSetupState,
  uid: string | null | undefined,
): boolean {
  if (!uid || uid === SYSTEM_DEFAULT_DEVICE_ID) return true
  return setup.devices[uid]?.enabled ?? setup.autoEnableNewDevices
}

export function getDeviceConfig(setup: AudioSetupState, uid: string | null | undefined): AudioDeviceConfig {
  if (!uid || uid === SYSTEM_DEFAULT_DEVICE_ID) return {}
  return setup.devices[uid] ?? {}
}

/** Resampling settings in effect for a device: its override, else the global ones. */
export function effectiveResampling(setup: AudioSetupState, uid: string | null | undefined): ResamplingSettings {
  return getDeviceConfig(setup, uid).resampling ?? setup.resampling
}

export function deviceDisplayName(
  setup: AudioSetupState,
  device: { uid: string; name: string },
): string {
  return getDeviceConfig(setup, device.uid).displayName || device.name
}

/**
 * Initial mode for a device when it is selected or restored at launch.
 * `remembered` is the last mode the user toggled in the output menu.
 */
export function resolvePreferredAudioMode(
  config: AudioDeviceConfig,
  remembered: 'exclusive' | 'shared',
): 'exclusive' | 'shared' {
  if (config.exclusive === 'exclusive') return 'exclusive'
  if (config.exclusive === 'shared') return 'shared'
  return remembered
}

function cappedDopCapability(capability: DopCapability, config: AudioDeviceConfig): DopCapability {
  if (config.dsdStrategy === 'pcm') return 'FallbackPCM'
  if (!config.maxDsdRate) return capability
  return DOP_RANK[capability] <= DOP_RANK[config.maxDsdRate] ? capability : config.maxDsdRate
}

/**
 * Apply the Advanced resolution limits. PCM formats above the limits are
 * hidden from the format decision, so higher-resolution content is converted
 * down; the unrestricted list is kept for DoP carrier detection, since DSD
 * has its own limit.
 */
export function applyDeviceFormatLimits(
  caps: DeviceCapabilities,
  config: AudioDeviceConfig,
): DeviceCapabilities {
  const { maxSampleRate, maxBitDepth } = config
  const limited = caps.supportedFormats.filter((format) =>
    (!maxSampleRate || format.sampleRate <= maxSampleRate) &&
    (!maxBitDepth || format.bitDepth <= maxBitDepth))
  // A limit below everything the device offers would leave nothing to play; ignore it then.
  const supportedFormats = limited.length > 0 && limited.length < caps.supportedFormats.length
    ? limited
    : caps.supportedFormats
  const dopCapability = cappedDopCapability(caps.dopCapability, config)

  if (supportedFormats === caps.supportedFormats && dopCapability === caps.dopCapability) return caps
  return {
    ...caps,
    dopCapability,
    supportedFormats,
    dopCarrierFormats: caps.dopCarrierFormats ?? caps.supportedFormats,
    maxSampleRate: supportedFormats.reduce((max, f) => Math.max(max, f.sampleRate), 0),
    maxBitDepth: supportedFormats.reduce((max, f) => Math.max(max, f.bitDepth), 0),
    supportsInteger: supportedFormats.some((f) => !f.isFloat),
  }
}

// ---------------------------------------------------------------------------
// Device grouping (Roon lists outputs by type)
// ---------------------------------------------------------------------------

export type AudioDeviceGroupId =
  | 'usb'
  | 'built-in'
  | 'display'
  | 'thunderbolt-pci'
  | 'network'
  | 'bluetooth'
  | 'airplay'
  | 'virtual'
  | 'other'

const fourCC = (code: string) =>
  code.split('').reduce((value, char) => (value << 8) | char.charCodeAt(0), 0) >>> 0

export const TRANSPORT = {
  builtIn: fourCC('bltn'),
  aggregate: fourCC('grup'),
  virtual: fourCC('virt'),
  pci: fourCC('pci '),
  usb: fourCC('usb '),
  fireWire: fourCC('1394'),
  hdmi: fourCC('hdmi'),
  displayPort: fourCC('dprt'),
  avb: fourCC('eavb'),
  thunderbolt: fourCC('thun'),
} as const

export const AUDIO_DEVICE_GROUPS: ReadonlyArray<{ id: AudioDeviceGroupId; label: string }> = [
  { id: 'usb', label: 'USB' },
  { id: 'thunderbolt-pci', label: 'Thunderbolt, PCI & FireWire' },
  { id: 'built-in', label: 'Built-in' },
  { id: 'display', label: 'HDMI & DisplayPort' },
  { id: 'network', label: 'Network (AVB)' },
  { id: 'bluetooth', label: 'Bluetooth' },
  { id: 'airplay', label: 'AirPlay' },
  { id: 'virtual', label: 'Virtual & Aggregate' },
  { id: 'other', label: 'Other' },
]

export function deviceGroupForTransport(transportType: number | null | undefined): AudioDeviceGroupId {
  if (isBluetoothTransport(transportType)) return 'bluetooth'
  if (isAirPlayTransport(transportType)) return 'airplay'
  switch (transportType) {
    case TRANSPORT.usb:
      return 'usb'
    case TRANSPORT.builtIn:
      return 'built-in'
    case TRANSPORT.hdmi:
    case TRANSPORT.displayPort:
      return 'display'
    case TRANSPORT.pci:
    case TRANSPORT.fireWire:
    case TRANSPORT.thunderbolt:
      return 'thunderbolt-pci'
    case TRANSPORT.avb:
      return 'network'
    case TRANSPORT.aggregate:
    case TRANSPORT.virtual:
      return 'virtual'
    default:
      return 'other'
  }
}

export function transportDisplayName(transportType: number | null | undefined): string {
  if (isBluetoothTransport(transportType)) return 'Bluetooth'
  if (isAirPlayTransport(transportType)) return 'AirPlay'
  switch (transportType) {
    case TRANSPORT.usb: return 'USB'
    case TRANSPORT.builtIn: return 'Built-in'
    case TRANSPORT.hdmi: return 'HDMI'
    case TRANSPORT.displayPort: return 'DisplayPort'
    case TRANSPORT.pci: return 'PCI'
    case TRANSPORT.fireWire: return 'FireWire'
    case TRANSPORT.thunderbolt: return 'Thunderbolt'
    case TRANSPORT.avb: return 'AVB'
    case TRANSPORT.aggregate: return 'Aggregate'
    case TRANSPORT.virtual: return 'Virtual'
    default: return 'Unknown'
  }
}

export function groupDevicesByType<T extends { transportType: number }>(
  devices: readonly T[],
): Array<{ id: AudioDeviceGroupId; label: string; devices: T[] }> {
  return AUDIO_DEVICE_GROUPS
    .map((group) => ({
      ...group,
      devices: devices.filter((device) => deviceGroupForTransport(device.transportType) === group.id),
    }))
    .filter((group) => group.devices.length > 0)
}

export function dsdRateLabel(rate: DsdRateLimit | DopCapability): string {
  switch (rate) {
    case 'DoP64': return 'DSD64'
    case 'DoP128': return 'DSD128'
    case 'DoP256': return 'DSD256'
    default: return 'PCM only'
  }
}

export function dsdRateLimitsFor(capability: DopCapability): DsdRateLimit[] {
  return DSD_RATE_LIMITS.filter((rate) => DOP_RANK[rate] <= DOP_RANK[capability])
}
