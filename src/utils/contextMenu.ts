import type { ContextMenuItemSpec } from '../../electron/preload'

export type ContextMenuItem =
  | { type: 'separator' }
  | { label: string; onClick?: () => void; enabled?: boolean; submenu?: ContextMenuEntry[] }

/** Falsy entries are skipped, so items can be listed conditionally inline. */
export type ContextMenuEntry = ContextMenuItem | false | null | undefined

/** Shows a native macOS context menu at the cursor and runs the chosen item's onClick. */
export async function showContextMenu(entries: ContextMenuEntry[]): Promise<void> {
  const actions = new Map<string, () => void>()

  const toSpecs = (list: ContextMenuEntry[]): ContextMenuItemSpec[] => list.flatMap((entry): ContextMenuItemSpec[] => {
    if (!entry) return []
    if ('type' in entry) return [entry]
    let id: string | undefined
    if (entry.onClick) {
      id = String(actions.size)
      actions.set(id, entry.onClick)
    }
    return [{
      id,
      label: entry.label,
      enabled: entry.enabled,
      submenu: entry.submenu ? toSpecs(entry.submenu) : undefined,
    }]
  })

  const chosen = await window.puros.app.showContextMenu(toSpecs(entries))
  if (chosen != null) actions.get(chosen)?.()
}
