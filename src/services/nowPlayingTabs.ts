/** Tabs beside the artwork in the full-screen Now Playing view, in display order. */
export const NOW_PLAYING_TAB_IDS = ['lyrics', 'authors', 'visualizer'] as const

export type NowPlayingTabId = typeof NOW_PLAYING_TAB_IDS[number]
export type NowPlayingTabs = Record<NowPlayingTabId, boolean>

export const NOW_PLAYING_TAB_LABELS: Record<NowPlayingTabId, string> = {
  lyrics: 'Lyrics',
  authors: 'Authors',
  visualizer: 'Visualizer',
}

/** The visualizer is opt-in: it keeps the GPU busy whenever Now Playing is open. */
export const DEFAULT_NOW_PLAYING_TABS: NowPlayingTabs = {
  lyrics: true,
  authors: true,
  visualizer: false,
}

export const NOW_PLAYING_TABS_SETTING_KEY = 'nowPlayingTabs'

/**
 * Reads the stored tabs. Before this setting existed, turning off
 * 'lyricsShowInNowPlaying' hid the whole tab column, so that carries over as
 * every tab off.
 */
export function parseNowPlayingTabs(raw: string | null | undefined, legacyShowLyrics?: string | null): NowPlayingTabs {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const stored = parsed as Partial<Record<string, unknown>>
        const tabs = { ...DEFAULT_NOW_PLAYING_TABS }
        for (const id of NOW_PLAYING_TAB_IDS) {
          if (typeof stored[id] === 'boolean') tabs[id] = stored[id]
        }
        return tabs
      }
    } catch {
      /* fall through to defaults */
    }
  }
  if (legacyShowLyrics === 'false') return { lyrics: false, authors: false, visualizer: false }
  return { ...DEFAULT_NOW_PLAYING_TABS }
}

export function enabledNowPlayingTabs(tabs: NowPlayingTabs): NowPlayingTabId[] {
  return NOW_PLAYING_TAB_IDS.filter((id) => tabs[id])
}
