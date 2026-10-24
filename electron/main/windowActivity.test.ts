import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const app = Object.assign(new EventEmitter(), { isHidden: vi.fn(() => false) })
vi.mock('electron', () => ({ app, BrowserWindow: {} }))

const { getWindowActivity, trackWindowActivity } = await import('./windowActivity')

class FakeWindow extends EventEmitter {
  minimized = false
  visible = true
  focused = true
  sent: unknown[] = []
  webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (_channel: string, value: unknown) => { this.sent.push(value) },
  })
  isDestroyed = () => false
  isMinimized = () => this.minimized
  isVisible = () => this.visible
  isFocused = () => this.focused
}

function track() {
  const win = new FakeWindow()
  trackWindowActivity(win as unknown as Electron.BrowserWindow)
  return win
}

afterEach(() => {
  app.isHidden.mockReturnValue(false)
  vi.useRealTimers()
})

describe('window activity', () => {
  it('follows focus, minimize and restore, telling the renderer only on changes', () => {
    const win = track()
    win.focused = false
    win.emit('blur')
    win.emit('blur')
    win.minimized = true
    win.emit('minimize')
    win.minimized = false
    win.focused = true
    win.emit('restore')
    win.emit('focus')
    expect(win.sent).toEqual(['unfocused', 'hidden', 'active'])
  })

  it('counts a hidden app (Cmd+H) as hidden once macOS has settled', () => {
    vi.useFakeTimers()
    const win = track()
    win.focused = false
    app.emit('did-resign-active')
    expect(win.sent).toEqual(['unfocused'])
    app.isHidden.mockReturnValue(true)
    vi.runAllTimers()
    expect(win.sent).toEqual(['unfocused', 'hidden'])
  })

  it('reports a missing window as hidden', () => {
    expect(getWindowActivity(null)).toBe('hidden')
  })

  it('tells a reloaded renderer the current state', () => {
    const win = track()
    win.webContents.emit('did-finish-load')
    expect(win.sent).toEqual(['active'])
  })
})
