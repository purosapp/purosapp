import type { ProviderEventV1 } from '../../../src/provider-api/v1'

const PROGRESS_FLUSH_MS = 100
const MAX_PROGRESS_PER_FLUSH = 2

/** Keep the newest progress sample while preserving terminal session events. */
export class ProviderEventCoalescer {
  private readonly pending = new Map<string, ProviderEventV1>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly send: (event: ProviderEventV1) => void) {}

  publish(event: ProviderEventV1): void {
    const key = this.progressKey(event)
    if (key) {
      this.pending.set(key, event)
      this.schedule()
      return
    }
    if (event.type === 'playback.session' && ['completed', 'failed', 'cancelled'].includes(event.session.state)) {
      this.flushKey(`playback:${event.session.sessionId}`)
    }
    this.send(event)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private progressKey(event: ProviderEventV1): string | null {
    if (event.type === 'playback.progress') return `playback:${event.progress.sessionId}`
    if (event.type === 'library.sync.progress') return 'library.sync'
    return null
  }

  private flushKey(key: string): void {
    const event = this.pending.get(key)
    if (!event) return
    this.pending.delete(key)
    this.send(event)
  }

  private schedule(): void {
    if (this.timer || this.pending.size === 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      for (const key of [...this.pending.keys()].slice(0, MAX_PROGRESS_PER_FLUSH)) this.flushKey(key)
      this.schedule()
    }, PROGRESS_FLUSH_MS)
  }
}
