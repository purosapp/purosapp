export type SettingsTab = 'accounts' | 'player' | 'downloads' | 'audio' | 'appearance' | 'library' | 'visualizer'

const OPEN_SETTINGS_EVENT = 'puros:open-settings'

/** Ask the app shell to open the Settings modal, optionally on a specific tab. */
export function openSettings(tab?: SettingsTab) {
  window.dispatchEvent(new CustomEvent<{ tab?: SettingsTab }>(OPEN_SETTINGS_EVENT, { detail: { tab } }))
}

export function onOpenSettingsRequest(listener: (tab: SettingsTab | undefined) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<{ tab?: SettingsTab }>).detail?.tab)
  window.addEventListener(OPEN_SETTINGS_EVENT, handler)
  return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler)
}
