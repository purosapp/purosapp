export class RateLimiter {
  private queue: Array<() => void> = []
  private timestamps: number[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private config: { maxRequests: number; windowMs: number }) {}

  async acquire(): Promise<void> {
    if (this.config.maxRequests <= 0) return

    return new Promise((resolve) => {
      this.queue.push(resolve)
      this.drain()
    })
  }

  private drain(): void {
    const now = Date.now()
    this.timestamps = this.timestamps.filter((timestamp) => now - timestamp < this.config.windowMs)

    while (this.queue.length > 0 && this.timestamps.length < this.config.maxRequests) {
      this.timestamps.push(Date.now())
      const next = this.queue.shift()
      next?.()
    }

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.queue.length === 0 || this.timestamps.length < this.config.maxRequests) {
      return
    }

    const oldest = this.timestamps[0]
    const delay = Math.max(0, this.config.windowMs - (now - oldest))
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain()
    }, delay + 1)
  }
}
