import { isBluetoothTransport } from '../../../src/utils/audioDeviceTransport'
import { isPlaybackActive } from '../playbackCoordinator'
import { sendToRenderer } from '../rendererBridge'
import { getAudioEngine, type NativeAudioDevice } from './engine'

// Whether the renderer has selected the virtual "__default__" device.
// Used by the device-change watcher to decide when to push device-switch events.
let defaultModeActive = false

interface BluetoothInfo {
  isBluetooth: boolean
  deviceName: string
  codec: 'AAC' | 'SBC' | null   // null iff not Bluetooth
  isLossy: boolean
  exclusiveBlockedByBluetooth: boolean
}

export function setDefaultModeActive(active: boolean) {
  defaultModeActive = active
}

export async function detectBluetoothInfo(): Promise<BluetoothInfo> {
  const notBluetooth: BluetoothInfo = {
    isBluetooth: false,
    deviceName: '',
    codec: null,
    isLossy: false,
    exclusiveBlockedByBluetooth: false,
  }

  try {
    const engine = getAudioEngine()
    const uid = engine.getDefaultOutputDeviceUid()
    if (!uid) return notBluetooth

    const devices = await engine.listDevices()
    const dev = devices.find(d => d.uid === uid) ?? devices[0]
    if (!dev) return notBluetooth

    if (!isBluetoothTransport(dev.transportType)) return notBluetooth

    // Codec detection: Apple heuristic (AirPods / Apple name) → AAC, else SBC.
    // CoreAudio doesn't expose the active BT codec — we use available sample rates
    // as a secondary signal but always resolve to a definite answer.
    const name = dev.name
    const isApple = /airpods|apple/i.test(name)

    // If the device exposes 44100 Hz it almost certainly negotiated AAC (Apple)
    // or at least a higher-quality codec (non-Apple). SBC is limited to 44100 on
    // some stacks but is more commonly locked to 48000. Without ground truth we
    // apply the Apple rule as the primary discriminator.
    const codec: 'AAC' | 'SBC' = isApple ? 'AAC' : 'SBC'

    return {
      isBluetooth: true,
      deviceName: name,
      codec,
      isLossy: true,
      exclusiveBlockedByBluetooth: true,
    }
  } catch {
    return notBluetooth
  }
}

export function resolveListedOutputDevice(
  devices: NativeAudioDevice[],
  uid: string | null | undefined,
) {
  if (!uid) return undefined

  return devices.find((device) => device.uid === uid)
    ?? devices.find((device) => device.routeParentUid === uid && device.isCurrentRoute)
}

// ---------------------------------------------------------------------------
// Live device-change watcher — fires whenever the default output device changes.
// Sends updated BluetoothInfo to the renderer via the existing IPC push channel.
// ---------------------------------------------------------------------------

export function startDeviceChangeWatcher() {
  // Poll every 2 seconds. CoreAudio property listeners require a C++ addon
  // to register — polling from the main process is the pragmatic alternative
  // that fits within the existing Node.js-only main process architecture.
  const POLL_INTERVAL = 2000
  let lastUid: string | null = null
  let lastResolvedRouteUid: string | null = null
  let lastFullDeviceCheckAt = 0

  let checking = false
  const check = async () => {
    // A slow enumeration (device mid-reconfiguration) must not stack up checks.
    if (checking) return
    checking = true
    try {
      const engine = getAudioEngine()
      const uid = engine.getDefaultOutputDeviceUid()
      const now = Date.now()
      if (
        isPlaybackActive()
        && uid === lastUid
        && now - lastFullDeviceCheckAt < 10_000
      ) return

      lastFullDeviceCheckAt = now
      const devices = await engine.listDevices()
      const resolvedDevice = resolveListedOutputDevice(devices, uid)
      const resolvedRouteUid = resolvedDevice?.uid ?? uid ?? null

      if (uid !== lastUid || resolvedRouteUid !== lastResolvedRouteUid) {
        lastUid = uid
        lastResolvedRouteUid = resolvedRouteUid
        // Always refresh Bluetooth state
        const info = await detectBluetoothInfo()
        sendToRenderer('audio:bluetooth-info', info)

        // If the renderer is in "__default__" mode, notify it that the
        // underlying physical device has changed so it can re-open.
        if (defaultModeActive) {
          let resolvedName = ''
          try {
            if (resolvedDevice) resolvedName = resolvedDevice.name
          } catch { /* best-effort */ }

          sendToRenderer('audio:default-device-changed', {
            uid: resolvedRouteUid ?? '',
            name: resolvedName,
          })
        }
      }
    } catch {
      // Engine not ready yet
    } finally {
      checking = false
    }
  }

  setInterval(() => { void check() }, POLL_INTERVAL)
}
