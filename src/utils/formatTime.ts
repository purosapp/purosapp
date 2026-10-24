/** Track length as m:ss. Takes seconds; catalog durations (ms) divide by 1000 first. */
export function formatTrackDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds || 0))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}

/** Longer spans (an album, a week of listening): "58 min", "1 hr 12 min", "140 hr". */
export function formatTotalDuration(seconds: number): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} min`
  if (hours >= 100 || minutes === 0) return `${hours} hr`
  return `${hours} hr ${minutes} min`
}

/** Relative time for history rows: "5 min ago", "3 hr ago", "2 days ago". */
export function formatPlayedAt(timestamp: number): string {
  const deltaMinutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000))
  if (deltaMinutes < 60) return `${deltaMinutes} min ago`
  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours} hr ago`
  const deltaDays = Math.round(deltaHours / 24)
  return `${deltaDays} day${deltaDays === 1 ? '' : 's'} ago`
}
