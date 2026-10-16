import { describe, expect, it } from 'vitest'
import {
  TRANSPORT,
  applyDeviceFormatLimits,
  deviceDisplayName,
  deviceGroupForTransport,
  dsdRateLimitsFor,
  editableDeviceConfig,
  groupDevicesByType,
  isDeviceEnabled,
  resolvePreferredAudioMode,
  sanitizeAudioSetup,
  sanitizeDeviceConfig,
  type AudioSetupState,
} from './audioDeviceConfig'
import { buildDeviceCapabilities } from './formatCompatibility'
import { DEFAULT_RESAMPLING } from './resamplingSettings'
import { kTransportAirPlay, kTransportBluetooth } from '../utils/audioDeviceTransport'

const format = (sampleRate: number, bitDepth: number, isFloat = false) =>
  ({ sampleRate, bitDepth, isFloat, channels: 2 })

const dac = buildDeviceCapabilities({
  id: 'dac',
  name: 'USB DAC',
  dopCapability: 'DoP128',
  supportedFormats: [
    format(44100, 24), format(48000, 24), format(96000, 24),
    format(176400, 32), format(192000, 32), format(352800, 32), format(384000, 32),
  ],
})

const setup = (patch: Partial<AudioSetupState> = {}): AudioSetupState => ({
  autoEnableNewDevices: true,
  resampling: DEFAULT_RESAMPLING,
  devices: {},
  ...patch,
})

describe('sanitizeDeviceConfig', () => {
  it('keeps only valid, non-default values', () => {
    expect(sanitizeDeviceConfig({
      enabled: false,
      displayName: '  Desk DAC  ',
      exclusive: 'remember',
      dsdStrategy: 'dop',
      maxSampleRate: 96000,
      maxBitDepth: -1,
      maxDsdRate: 'DoP512',
      resyncDelayMs: 99999,
      maxHardwareBuffer: true,
      powerOfTwoBuffer: 'yes',
      unknown: 1,
    })).toEqual({
      enabled: false,
      displayName: 'Desk DAC',
      maxSampleRate: 96000,
      resyncDelayMs: 3000,
      maxHardwareBuffer: true,
    })
  })

  it('treats garbage as an empty config', () => {
    expect(sanitizeDeviceConfig(null)).toEqual({})
    expect(sanitizeDeviceConfig('x')).toEqual({})
  })
})

describe('sanitizeAudioSetup', () => {
  it('drops the virtual default device and restores defaults', () => {
    expect(sanitizeAudioSetup({
      devices: { __default__: { enabled: false }, dac: { enabled: true } },
    })).toEqual({ autoEnableNewDevices: true, resampling: DEFAULT_RESAMPLING, devices: { dac: { enabled: true } } })
    expect(sanitizeAudioSetup(undefined)).toEqual({ autoEnableNewDevices: true, resampling: DEFAULT_RESAMPLING, devices: {} })
  })
})

describe('isDeviceEnabled', () => {
  it('follows auto-enable for unknown devices and explicit flags otherwise', () => {
    expect(isDeviceEnabled(setup(), 'new')).toBe(true)
    expect(isDeviceEnabled(setup({ autoEnableNewDevices: false }), 'new')).toBe(false)
    expect(isDeviceEnabled(setup({ autoEnableNewDevices: false, devices: { dac: { enabled: true } } }), 'dac')).toBe(true)
    expect(isDeviceEnabled(setup({ devices: { dac: { enabled: false } } }), 'dac')).toBe(false)
  })

  it('never disables the system default output', () => {
    expect(isDeviceEnabled(setup({ autoEnableNewDevices: false }), '__default__')).toBe(true)
  })
})

describe('deviceDisplayName / editableDeviceConfig', () => {
  it('prefers the alias', () => {
    const state = setup({ devices: { dac: { displayName: 'Desk' } } })
    expect(deviceDisplayName(state, { uid: 'dac', name: 'USB DAC' })).toBe('Desk')
    expect(deviceDisplayName(state, { uid: 'other', name: 'Speakers' })).toBe('Speakers')
  })

  it('strips last-seen bookkeeping', () => {
    expect(editableDeviceConfig({ enabled: true, lastSeenName: 'X', lastSeenAt: 1, lastSeenTransport: 2 }))
      .toEqual({ enabled: true })
  })
})

describe('resolvePreferredAudioMode', () => {
  it('uses the per-device preference over the remembered mode', () => {
    expect(resolvePreferredAudioMode({}, 'exclusive')).toBe('exclusive')
    expect(resolvePreferredAudioMode({ exclusive: 'shared' }, 'exclusive')).toBe('shared')
    expect(resolvePreferredAudioMode({ exclusive: 'exclusive' }, 'shared')).toBe('exclusive')
  })
})

describe('applyDeviceFormatLimits', () => {
  it('returns the same capabilities without limits', () => {
    expect(applyDeviceFormatLimits(dac, {})).toBe(dac)
  })

  it('caps PCM rate and depth but keeps DoP carriers available', () => {
    const limited = applyDeviceFormatLimits(dac, { maxSampleRate: 96000, maxBitDepth: 24 })
    expect(limited.supportedFormats.map((f) => f.sampleRate)).toEqual([44100, 48000, 96000])
    expect(limited.maxSampleRate).toBe(96000)
    expect(limited.maxBitDepth).toBe(24)
    expect(limited.dopCapability).toBe('DoP128')
    expect(limited.dopCarrierFormats).toBe(dac.supportedFormats)
  })

  it('ignores a limit that would leave no playable format', () => {
    const limited = applyDeviceFormatLimits(dac, { maxBitDepth: 16 })
    expect(limited.supportedFormats).toBe(dac.supportedFormats)
  })

  it('caps or disables DoP', () => {
    expect(applyDeviceFormatLimits(dac, { maxDsdRate: 'DoP64' }).dopCapability).toBe('DoP64')
    expect(applyDeviceFormatLimits(dac, { maxDsdRate: 'DoP256' }).dopCapability).toBe('DoP128')
    expect(applyDeviceFormatLimits(dac, { dsdStrategy: 'pcm' }).dopCapability).toBe('FallbackPCM')
  })
})

describe('device grouping', () => {
  it('maps CoreAudio transport types to groups', () => {
    expect(deviceGroupForTransport(TRANSPORT.usb)).toBe('usb')
    expect(deviceGroupForTransport(TRANSPORT.builtIn)).toBe('built-in')
    expect(deviceGroupForTransport(TRANSPORT.hdmi)).toBe('display')
    expect(deviceGroupForTransport(kTransportBluetooth)).toBe('bluetooth')
    expect(deviceGroupForTransport(kTransportAirPlay)).toBe('airplay')
    expect(deviceGroupForTransport(TRANSPORT.aggregate)).toBe('virtual')
    expect(deviceGroupForTransport(undefined)).toBe('other')
  })

  it('orders groups and skips empty ones', () => {
    const groups = groupDevicesByType([
      { uid: 'bt', transportType: kTransportBluetooth },
      { uid: 'usb', transportType: TRANSPORT.usb },
      { uid: 'mac', transportType: TRANSPORT.builtIn },
    ])
    expect(groups.map((group) => group.id)).toEqual(['usb', 'built-in', 'bluetooth'])
  })

  it('lists DSD rate limits up to the device capability', () => {
    expect(dsdRateLimitsFor('DoP128')).toEqual(['DoP64', 'DoP128'])
    expect(dsdRateLimitsFor('FallbackPCM')).toEqual([])
  })
})
