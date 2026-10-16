import { app, globalShortcut } from 'electron'
import { getAudioEngine } from './audio/engine'
import { getMainWindow } from './rendererBridge'

let mediaShortcutsRegistered = false
let nativeRemoteBridgeReady = false

function sendMediaCommand(command: 'play' | 'pause' | 'play-pause' | 'next' | 'previous' | 'stop'): void {
  getMainWindow()?.webContents.send('player:media-command', command)
}

export function registerNativeRemoteCommandBridge(): boolean {
  try {
    const engine = getAudioEngine()
    if (typeof engine.registerRemoteCommandHandler !== 'function') return false

    engine.registerRemoteCommandHandler((command: string) => {
      const normalized = command === 'toggle' ? 'play-pause' : command
      if (
        normalized === 'play' ||
        normalized === 'pause' ||
        normalized === 'play-pause' ||
        normalized === 'next' ||
        normalized === 'previous' ||
        normalized === 'stop'
      ) {
        sendMediaCommand(normalized)
      }
    })

    nativeRemoteBridgeReady = true
    return true
  } catch (err) {
    console.warn('[Puros] Native remote command bridge unavailable:', err)
    nativeRemoteBridgeReady = false
    return false
  }
}

export function registerMediaKeyShortcuts(): void {
  if (mediaShortcutsRegistered || nativeRemoteBridgeReady) return

  const shortcuts: Array<[string, 'play' | 'pause' | 'play-pause' | 'next' | 'previous' | 'stop']> = [
    ['MediaPlayPause', 'play-pause'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous'],
    ['MediaStop', 'stop'],
  ]

  for (const [accelerator, command] of shortcuts) {
    try {
      const registered = globalShortcut.register(accelerator, () => sendMediaCommand(command))
      if (!registered) {
        console.warn(`[Puros] Failed to register media shortcut: ${accelerator}`)
      }
    } catch (err) {
      console.warn(`[Puros] Error registering media shortcut ${accelerator}:`, err)
    }
  }

  mediaShortcutsRegistered = true
}

export function unregisterMediaKeyShortcuts(): void {
  if (app.isReady()) {
    try {
      globalShortcut.unregisterAll()
    } catch (error) {
      console.warn('[Puros] Failed to unregister media shortcuts:', error)
    }
  }
  mediaShortcutsRegistered = false
}
