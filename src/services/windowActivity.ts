import { create } from 'zustand'
import type { WindowActivity } from '../../electron/preload'

/**
 * Whether the user can see this window, from the main process (the page never
 * learns this itself: background throttling is off so playback keeps polling).
 *
 * - 'unfocused': slow down decorative work (visualizer frame rate, ambient motion, progress polling).
 * - 'hidden': stop everything the user cannot see; only playback keeps running.
 * - `dormant`: hidden for DORMANT_AFTER_MS; heavy resources (WebGL, decoded images) are released too.
 *
 * `<html data-activity>` mirrors the state so CSS can pause animations.
 */
export type { WindowActivity }

/** Long enough that a quick minimize and restore does not tear anything down. */
const DORMANT_AFTER_MS = 60_000

interface WindowActivityState {
  activity: WindowActivity
  dormant: boolean
}

export const useWindowActivityStore = create<WindowActivityState>(() => ({
  activity: 'active',
  dormant: false,
}))

export function getWindowActivity(): WindowActivity {
  return useWindowActivityStore.getState().activity
}

export function isWindowHidden(): boolean {
  return getWindowActivity() === 'hidden'
}

export function useWindowActivity(): WindowActivity {
  return useWindowActivityStore((state) => state.activity)
}

export function useWindowDormant(): boolean {
  return useWindowActivityStore((state) => state.dormant)
}

let dormantTimer: ReturnType<typeof setTimeout> | null = null

function applyActivity(activity: WindowActivity) {
  if (activity === getWindowActivity()) return
  document.documentElement.dataset.activity = activity
  if (dormantTimer !== null) {
    clearTimeout(dormantTimer)
    dormantTimer = null
  }
  if (activity === 'hidden') {
    dormantTimer = setTimeout(() => {
      dormantTimer = null
      useWindowActivityStore.setState({ dormant: true })
      // After React has unmounted what dormancy drops, so its memory is free to go.
      setTimeout(() => window.puros.app.releaseRendererCaches(), 0)
    }, DORMANT_AFTER_MS)
    useWindowActivityStore.setState({ activity })
  } else {
    useWindowActivityStore.setState({ activity, dormant: false })
  }
}

function isWindowActivity(value: unknown): value is WindowActivity {
  return value === 'active' || value === 'unfocused' || value === 'hidden'
}

/** Starts following the main process; call once at renderer startup. */
export function startWindowActivityWatch(): void {
  document.documentElement.dataset.activity = getWindowActivity()
  window.puros.on('app:window-activity-changed', (activity) => {
    if (isWindowActivity(activity)) applyActivity(activity)
  })
  void window.puros.app.getWindowActivity().then(applyActivity).catch(() => {})
}
