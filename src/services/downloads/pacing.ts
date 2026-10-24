/**
 * Pacing for playlist downloads. Providers rate-limit stream manifests (TIDAL
 * answers 429 and then skips prefetches during a cooldown), so the queue
 * spaces its requests and backs off on failures instead of burning through a
 * playlist with instant errors.
 */

/** Pause after every track, so fast cache hits and failures cannot stack up requests. */
export const DOWNLOAD_REQUEST_GAP_MS = 2_000
export const DOWNLOAD_BACKOFF_START_MS = 10_000
export const DOWNLOAD_BACKOFF_MAX_MS = 5 * 60_000
/** Tries per track before it counts as failed. */
export const DOWNLOAD_MAX_ATTEMPTS = 4

/** Wait after a failed attempt: doubles from 10 s up to 5 min. */
export function nextDownloadBackoffMs(previousMs: number): number {
  if (previousMs <= 0) return DOWNLOAD_BACKOFF_START_MS
  return Math.min(previousMs * 2, DOWNLOAD_BACKOFF_MAX_MS)
}

/** After a success, ease off gradually rather than jumping back to full speed. */
export function relaxDownloadBackoffMs(currentMs: number): number {
  const half = Math.floor(currentMs / 2)
  return half < DOWNLOAD_BACKOFF_START_MS ? 0 : half
}
