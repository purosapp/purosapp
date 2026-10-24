import { app, BrowserWindow } from 'electron'

/**
 * How much of a window the user can see, so its renderer can scale back work:
 * - 'active': focused; everything runs at full rate.
 * - 'unfocused': visible behind another app's window; decorative work slows down.
 * - 'hidden': minimized, hidden, or the app is hidden (Cmd+H); only playback keeps running.
 *
 * Windows keep `backgroundThrottling: false` because the renderer drives queue
 * advancement, so Chromium never tells the page it is hidden; this does instead.
 */
export type WindowActivity = 'active' | 'unfocused' | 'hidden'

// macOS hides the app's windows after it resigns active; look again once that has settled.
const APP_HIDE_SETTLE_MS = 250

const trackedWindows = new Map<BrowserWindow, WindowActivity>()
let appListenersRegistered = false

function computeActivity(win: BrowserWindow): WindowActivity {
  if (win.isMinimized() || !win.isVisible()) return 'hidden'
  if (process.platform === 'darwin' && app.isHidden()) return 'hidden'
  return win.isFocused() ? 'active' : 'unfocused'
}

function refresh(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const next = computeActivity(win)
  if (trackedWindows.get(win) === next) return
  trackedWindows.set(win, next)
  win.webContents.send('app:window-activity-changed', next)
}

function refreshAll(): void {
  for (const win of trackedWindows.keys()) refresh(win)
}

export function getWindowActivity(win: BrowserWindow | null | undefined): WindowActivity {
  if (!win || win.isDestroyed()) return 'hidden'
  return computeActivity(win)
}

export function trackWindowActivity(win: BrowserWindow): void {
  if (!appListenersRegistered) {
    appListenersRegistered = true
    const settle = () => {
      refreshAll()
      setTimeout(refreshAll, APP_HIDE_SETTLE_MS)
    }
    app.on('did-become-active', settle)
    app.on('did-resign-active', settle)
  }

  trackedWindows.set(win, computeActivity(win))
  const update = () => refresh(win)
  win.on('focus', update)
  win.on('blur', update)
  win.on('minimize', update)
  win.on('restore', update)
  win.on('show', update)
  win.on('hide', update)
  // A reload starts a fresh renderer that has not been told yet.
  win.webContents.on('did-finish-load', () => {
    trackedWindows.delete(win)
    update()
  })
  win.on('closed', () => { trackedWindows.delete(win) })
}
