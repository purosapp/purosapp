/**
 * Listening statistics for the Home activity map.
 *
 * Only time actually played counts: the player's position ticks are summed
 * while playing, and jumps (seeks, skips) are ignored. Totals are kept per
 * local calendar day under one settings key; a play counts once a track has
 * been heard for 30 s (or half of it, for shorter tracks).
 */

import { getTrackIdentity, usePlayerStore } from '../store/playerStore'
import { getJsonSetting, setJsonSetting } from '../utils/appSettings'

const STATS_KEY = 'stats:listeningDaily'
export const LISTENING_STATS_CHANGED_EVENT = 'puros:listening-stats-changed'
const FLUSH_INTERVAL_MS = 30_000
/** Larger position jumps between two ticks are seeks, not listening. */
const MAX_TICK_SECONDS = 3
const PLAY_THRESHOLD_SECONDS = 30

export interface ListeningDay {
  seconds: number
  plays: number
}

export type ListeningStats = Record<string, ListeningDay>

export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

let pending: ListeningStats = {}

function addPending(key: string, seconds: number, plays: number) {
  const day = pending[key] ?? { seconds: 0, plays: 0 }
  pending[key] = { seconds: day.seconds + seconds, plays: day.plays + plays }
}

function mergeStats(stored: ListeningStats, extra: ListeningStats): ListeningStats {
  const merged: ListeningStats = { ...stored }
  for (const [key, day] of Object.entries(extra)) {
    const current = merged[key] ?? { seconds: 0, plays: 0 }
    merged[key] = { seconds: current.seconds + day.seconds, plays: current.plays + day.plays }
  }
  return merged
}

function sanitize(raw: unknown): ListeningStats {
  if (!raw || typeof raw !== 'object') return {}
  const stats: ListeningStats = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue
    const { seconds, plays } = value as Partial<ListeningDay>
    stats[key] = {
      seconds: Number.isFinite(seconds) ? Math.max(0, Number(seconds)) : 0,
      plays: Number.isFinite(plays) ? Math.max(0, Math.round(Number(plays))) : 0,
    }
  }
  return stats
}

/** Saved totals plus whatever has been listened since the last save. */
export async function loadListeningStats(): Promise<ListeningStats> {
  const stored = sanitize(await getJsonSetting<unknown>(STATS_KEY, {}))
  return mergeStats(stored, pending)
}

let flushChain: Promise<void> = Promise.resolve()

async function writePending(): Promise<void> {
  if (Object.keys(pending).length === 0) return
  const batch = pending
  pending = {}
  try {
    const stored = sanitize(await getJsonSetting<unknown>(STATS_KEY, {}))
    await setJsonSetting(STATS_KEY, mergeStats(stored, batch))
    window.dispatchEvent(new Event(LISTENING_STATS_CHANGED_EVENT))
  } catch (error) {
    pending = mergeStats(pending, batch)
    console.warn('[ListeningStats] Failed to save:', error)
  }
}

/** Chained so two read-modify-writes of the stats key never interleave. */
function flush(): Promise<void> {
  flushChain = flushChain.then(writePending)
  return flushChain
}

/** Starts counting listening time. Returns a cleanup function. */
export function startListeningStatsTracking(): () => void {
  let trackSeconds = 0
  let playCounted = false

  const unsubscribe = usePlayerStore.subscribe((state, prev) => {
    if (getTrackIdentity(state.currentTrack) !== getTrackIdentity(prev.currentTrack)) {
      trackSeconds = 0
      playCounted = false
      return
    }
    if (state.isPlaying !== prev.isPlaying && !state.isPlaying) {
      void flush()
      return
    }
    if (!state.currentTrack || !state.isPlaying || !prev.isPlaying) return
    const delta = state.position - prev.position
    if (delta <= 0 || delta > MAX_TICK_SECONDS) return

    trackSeconds += delta
    const duration = state.duration > 0 ? state.duration : state.currentTrack.duration
    const threshold = duration > 0 ? Math.min(PLAY_THRESHOLD_SECONDS, duration / 2) : PLAY_THRESHOLD_SECONDS
    const countsAsPlay = !playCounted && trackSeconds >= threshold
    if (countsAsPlay) playCounted = true
    addPending(dayKey(new Date()), delta, countsAsPlay ? 1 : 0)
  })

  const interval = window.setInterval(() => { void flush() }, FLUSH_INTERVAL_MS)
  const onUnload = () => { void flush() }
  window.addEventListener('beforeunload', onUnload)

  return () => {
    unsubscribe()
    window.clearInterval(interval)
    window.removeEventListener('beforeunload', onUnload)
    void flush()
  }
}
