import type { ProviderHelperOutputV1 } from '../../../src/provider-api/v1'

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

export class HelperOutputQueue {
  private readonly items: ProviderHelperOutputV1[] = []
  private waiter: ((event: ProviderHelperOutputV1) => void) | null = null
  private bufferedBytes = 0
  private terminal = false

  push(event: ProviderHelperOutputV1): boolean {
    if (this.terminal) return false
    const size = event.type === 'stdout' || event.type === 'stderr' ? event.data.byteLength : 0
    if (this.bufferedBytes + size > MAX_BUFFERED_BYTES) return false
    if (event.type === 'exit' || event.type === 'error') this.terminal = true
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter(event)
    } else {
      this.items.push(event)
      this.bufferedBytes += size
    }
    return true
  }

  read(): Promise<ProviderHelperOutputV1> {
    const next = this.items.shift()
    if (next) {
      if (next.type === 'stdout' || next.type === 'stderr') this.bufferedBytes -= next.data.byteLength
      return Promise.resolve(next)
    }
    if (this.terminal) return Promise.reject(new Error('Helper output is closed'))
    if (this.waiter) return Promise.reject(new Error('Concurrent helper reads are not allowed'))
    return new Promise((resolve) => { this.waiter = resolve })
  }

  fail(message: string): void {
    this.push({ type: 'error', message })
  }
}
