import { create } from 'zustand'
import {
  AUDIO_DEVICE_CONFIG_SETTING_KEY,
  DEFAULT_AUDIO_SETUP,
  SYSTEM_DEFAULT_DEVICE_ID,
  editableDeviceConfig,
  hardwareBufferOptions,
  sanitizeAudioSetup,
  sameHardwareBufferOptions,
  sanitizeDeviceConfig,
  type AudioDeviceConfig,
  type AudioSetupState,
} from '../services/audioDeviceConfig'
import { sanitizeResamplingSettings, type ResamplingSettings } from '../services/resamplingSettings'
import { getJsonSetting, setJsonSetting } from '../utils/appSettings'

type SeenDevice = { uid: string; name: string; transportType: number }

interface AudioSetupStore {
  setup: AudioSetupState
  loaded: boolean
  /** Resolves once the persisted setup is in memory; safe to call repeatedly. */
  ensureLoaded: () => Promise<AudioSetupState>
  /**
   * Turning auto-enable off keeps every currently connected device as it is
   * (enabled), so only devices seen for the first time afterwards start disabled.
   */
  setAutoEnableNewDevices: (enabled: boolean, connectedDevices: readonly SeenDevice[]) => Promise<void>
  /** `connected: false` toggles a remembered device without touching its "last seen" info. */
  setDeviceEnabled: (device: SeenDevice, enabled: boolean, options?: { connected?: boolean }) => Promise<void>
  /** Replace the user-editable settings of a device (Save Settings / Restore Defaults). */
  saveDeviceConfig: (device: SeenDevice, config: AudioDeviceConfig) => Promise<void>
  forgetDevice: (uid: string) => Promise<void>
  setGlobalResampling: (settings: ResamplingSettings) => Promise<void>
}

let loadPromise: Promise<AudioSetupState> | null = null

function syncHardwareBuffer(uid: string, config: AudioDeviceConfig | undefined) {
  const { useMax, powerOfTwo } = hardwareBufferOptions(config)
  void window.puros.audio.setHardwareBufferOptions(uid, useMax, powerOfTwo).catch((error: unknown) => {
    console.warn('[Puros] Could not apply hardware buffer options:', error)
  })
}

function seenFields(device: SeenDevice): AudioDeviceConfig {
  return { lastSeenName: device.name, lastSeenTransport: device.transportType, lastSeenAt: Date.now() }
}

export const useAudioSetupStore = create<AudioSetupStore>((set, get) => {
  const persist = async (setup: AudioSetupState) => {
    set({ setup })
    await setJsonSetting(AUDIO_DEVICE_CONFIG_SETTING_KEY, setup)
  }

  return {
    setup: DEFAULT_AUDIO_SETUP,
    loaded: false,

    ensureLoaded: () => {
      loadPromise ??= getJsonSetting<unknown>(AUDIO_DEVICE_CONFIG_SETTING_KEY, null).then((raw) => {
        const setup = sanitizeAudioSetup(raw)
        set({ setup, loaded: true })
        for (const [uid, config] of Object.entries(setup.devices)) {
          if (config.maxHardwareBuffer || config.powerOfTwoBuffer) syncHardwareBuffer(uid, config)
        }
        return setup
      })
      return loadPromise
    },

    setAutoEnableNewDevices: async (enabled, connectedDevices) => {
      await get().ensureLoaded()
      const setup = get().setup
      const devices = { ...setup.devices }
      if (!enabled) {
        for (const device of connectedDevices) {
          if (device.uid === SYSTEM_DEFAULT_DEVICE_ID || devices[device.uid]?.enabled !== undefined) continue
          devices[device.uid] = { ...devices[device.uid], ...seenFields(device), enabled: setup.autoEnableNewDevices }
        }
      }
      await persist({ ...setup, autoEnableNewDevices: enabled, devices })
    },

    setDeviceEnabled: async (device, enabled, options) => {
      if (device.uid === SYSTEM_DEFAULT_DEVICE_ID) return
      await get().ensureLoaded()
      const setup = get().setup
      const current = setup.devices[device.uid] ?? {}
      const seen = options?.connected === false ? {} : seenFields(device)
      await persist({
        ...setup,
        devices: { ...setup.devices, [device.uid]: { ...current, ...seen, enabled } },
      })
    },

    saveDeviceConfig: async (device, config) => {
      if (device.uid === SYSTEM_DEFAULT_DEVICE_ID) return
      await get().ensureLoaded()
      const setup = get().setup
      const previous = setup.devices[device.uid]
      const next = sanitizeDeviceConfig({ ...editableDeviceConfig(config), ...seenFields(device) })
      await persist({ ...setup, devices: { ...setup.devices, [device.uid]: next } })
      if (!sameHardwareBufferOptions(previous, next)) syncHardwareBuffer(device.uid, next)
    },

    setGlobalResampling: async (settings) => {
      await get().ensureLoaded()
      await persist({ ...get().setup, resampling: sanitizeResamplingSettings(settings) })
    },

    forgetDevice: async (uid) => {
      await get().ensureLoaded()
      const setup = get().setup
      if (!setup.devices[uid]) return
      const { [uid]: removed, ...devices } = setup.devices
      await persist({ ...setup, devices })
      if (!sameHardwareBufferOptions(removed, undefined)) syncHardwareBuffer(uid, undefined)
    },
  }
})
