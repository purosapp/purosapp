/**
 * Scanning is now performed entirely in the main process (electron/main.ts).
 * This file retains only the ScanProgress type (for the progress event shape)
 * and the fisherYatesShuffle utility used by the player.
 */

export interface ScanProgress {
  processed: number
  total: number
  currentFile: string
  phase: 'scanning' | 'normalizing' | 'fetching_bios' | 'done'
}

/**
 * Fisher-Yates shuffle — true random, not weighted.
 */
export function fisherYatesShuffle<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}
