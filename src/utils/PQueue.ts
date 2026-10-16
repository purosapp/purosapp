export class PQueue {
  private readonly queue: Array<() => void> = []
  private activeCount = 0

  constructor(private readonly config: { concurrency: number }) {}

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.activeCount += 1
        void task()
          .then(resolve, reject)
          .finally(() => {
            this.activeCount = Math.max(0, this.activeCount - 1)
            this.drain()
          })
      }

      this.queue.push(run)
      this.drain()
    })
  }

  private drain(): void {
    while (this.activeCount < Math.max(1, this.config.concurrency) && this.queue.length > 0) {
      const next = this.queue.shift()
      next?.()
    }
  }
}
