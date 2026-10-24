import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { DockMenuState } from '../../src/services/dockMenu'
import { getMainWindow } from './rendererBridge'

/**
 * The Dock icon's menu (macOS): playback controls, shuffle / repeat and recently
 * played playlists above the system items (Options, Show All Windows, Hide, Quit).
 * The renderer owns the player, so it pushes its state whenever it changes.
 */

export type DockMenuCommand = 'play-pause' | 'next' | 'previous' | 'toggle-shuffle' | 'cycle-repeat'

const MAX_RECENTS = 5
const MAX_TITLE = 60

export function sanitizeDockMenuState(raw: unknown): DockMenuState | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const recents = Array.isArray(input.recents)
    ? input.recents
      .filter((item): item is { id: string; title: string } =>
        !!item && typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { title?: unknown }).title === 'string' &&
        (item as { title: string }).title.trim().length > 0)
      .slice(0, MAX_RECENTS)
      .map(({ id, title }) => ({
        id: id.slice(0, 512),
        title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
      }))
    : []
  return {
    hasTrack: input.hasTrack === true,
    isPlaying: input.isPlaying === true,
    shuffle: input.shuffle === true,
    repeat: input.repeat === 'all' || input.repeat === 'one' ? input.repeat : 'off',
    recents,
  }
}

export function buildDockMenuTemplate(
  state: DockMenuState,
  actions: { command: (command: DockMenuCommand) => void; openRecent: (id: string) => void },
  /** macOS 14+: a section header, whose items the system indents beneath it. */
  sectionHeaders = false,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    {
      label: state.isPlaying ? 'Pause' : 'Play',
      enabled: state.hasTrack,
      click: () => actions.command('play-pause'),
    },
    { type: 'separator' },
    { label: 'Next', enabled: state.hasTrack, click: () => actions.command('next') },
    { label: 'Previous', enabled: state.hasTrack, click: () => actions.command('previous') },
    { type: 'separator' },
    { label: 'Shuffle', type: 'checkbox', checked: state.shuffle, click: () => actions.command('toggle-shuffle') },
    {
      // Same cycle as the player button: off → all → one → off.
      label: state.repeat === 'one' ? 'Repeat One' : 'Repeat',
      type: 'checkbox',
      checked: state.repeat !== 'off',
      click: () => actions.command('cycle-repeat'),
    },
  ]
  if (state.recents.length > 0) {
    template.push(
      { type: 'separator' },
      sectionHeaders ? { label: 'Recently Played', type: 'header' } : { label: 'Recently Played', enabled: false },
      ...state.recents.map(({ id, title }): MenuItemConstructorOptions => ({
        label: title,
        click: () => actions.openRecent(id),
      })),
    )
  }
  return template
}

function showMainWindow() {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return null
  if (win.isMinimized()) win.restore()
  win.show()
  app.focus({ steal: true })
  return win
}

function supportsSectionHeaders(): boolean {
  return Number.parseInt(process.getSystemVersion().split('.')[0] ?? '0', 10) >= 14
}

let lastState: string | null = null

export function setDockMenu(raw: unknown): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const state = sanitizeDockMenuState(raw)
  if (!state) return
  const serialized = JSON.stringify(state)
  if (serialized === lastState) return
  lastState = serialized
  app.dock.setMenu(Menu.buildFromTemplate(buildDockMenuTemplate(state, {
    command: (command) => getMainWindow()?.webContents.send('player:media-command', command),
    openRecent: (id) => showMainWindow()?.webContents.send('player:open-recent', id),
  }, supportsSectionHeaders())))
}

/** The renderer that drove the menu is gone (window closed): keep only the system items. */
export function clearDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  lastState = null
  app.dock.setMenu(Menu.buildFromTemplate([]))
}
