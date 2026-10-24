import {
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'

const MAX_ITEMS = 500
const MAX_DEPTH = 4
// macOS reports the menu closing before the chosen item's click arrives, so a
// dismissal only counts once no click has followed it.
const DISMISS_GRACE_MS = 100

function toTemplate(
  items: unknown,
  depth: number,
  choose: (id: string) => void,
): MenuItemConstructorOptions[] {
  if (!Array.isArray(items) || depth > MAX_DEPTH) return []

  const template: MenuItemConstructorOptions[] = []
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (!item || typeof item !== 'object') continue
    const spec = item as Record<string, unknown>
    if (spec.type === 'separator') {
      template.push({ type: 'separator' })
      continue
    }
    if (typeof spec.label !== 'string') continue

    const id = typeof spec.id === 'string' ? spec.id : null
    if (spec.submenu !== undefined) {
      const submenu = toTemplate(spec.submenu, depth + 1, choose)
      template.push({
        label: spec.label,
        enabled: spec.enabled !== false && submenu.length > 0,
        submenu,
      })
      continue
    }
    template.push({
      label: spec.label,
      enabled: spec.enabled !== false && id != null,
      click: () => { if (id != null) choose(id) },
    })
  }
  return template
}

/** Pops a native menu at the cursor; resolves with the chosen item's id, or null when dismissed. */
export function showNativeContextMenu(sender: WebContents, items: unknown): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (id: string | null) => {
      if (settled) return
      settled = true
      resolve(id)
    }

    const window = BrowserWindow.fromWebContents(sender)
    const template = toTemplate(items, 0, settle)
    if (!window || template.length === 0) {
      settle(null)
      return
    }

    Menu.buildFromTemplate(template).popup({
      window,
      callback: () => { setTimeout(() => settle(null), DISMISS_GRACE_MS) },
    })
  })
}
