export const PROVIDER_RESTART_WINDOW_MS = 5 * 60_000
export const PROVIDER_MAX_RESTARTS = 3

/** Process exits are counted per provider; a stable window restores the restart budget. */
export class ProviderRestartPolicy {
  private failures: number[] = []

  recordFailure(now = Date.now()): { restart: boolean; delayMs: number } {
    this.failures = this.failures.filter((time) => now - time < PROVIDER_RESTART_WINDOW_MS)
    this.failures.push(now)
    if (this.failures.length > PROVIDER_MAX_RESTARTS) return { restart: false, delayMs: 0 }
    return { restart: true, delayMs: [0, 1000, 5000][this.failures.length - 1] }
  }

  reset(): void {
    this.failures = []
  }
}
