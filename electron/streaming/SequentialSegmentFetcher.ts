import {
  StreamingSession,
  type SegmentFetcher,
  type StreamingProgressEvent,
} from '../../src/services/playback/streaming'
import {
  type FinalizedCacheFile,
  type ProgressiveContainerAdapter,
} from './ProgressiveContainerAdapters'

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const

type FetchImplementation = typeof fetch

type ReadinessWaiter = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  settled: boolean
}

function createReadinessWaiter(): ReadinessWaiter {
  let resolvePromise!: () => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: false,
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function abortError(): Error {
  return new DOMException('Streaming session cancelled', 'AbortError')
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

export class SequentialSegmentFetcher implements SegmentFetcher {
  private readonly adapter: ProgressiveContainerAdapter
  private readonly fetchImpl: FetchImplementation
  private readonly onProgress: (event: StreamingProgressEvent) => void
  private readonly controllers = new Map<string, AbortController>()
  private readonly sessions = new Map<string, StreamingSession>()
  private readonly readinessWaiters = new Map<string, ReadinessWaiter>()

  constructor(options: {
    adapter: ProgressiveContainerAdapter
    fetchImpl?: FetchImplementation
    onProgress: (event: StreamingProgressEvent) => void
  }) {
    this.adapter = options.adapter
    this.fetchImpl = options.fetchImpl ?? fetch
    this.onProgress = options.onProgress
  }

  async start(session: StreamingSession): Promise<FinalizedCacheFile> {
    if (session.manifest.urls.length === 0) {
      throw new Error('Streaming manifest contains no segment URLs')
    }

    const controller = new AbortController()
    this.controllers.set(session.sessionId, controller)
    this.sessions.set(session.sessionId, session)
    const readiness = createReadinessWaiter()
    this.readinessWaiters.set(session.sessionId, readiness)

    try {
      await this.adapter.prepare(session)
      session.markRunning()

      for (let index = 0; index < session.manifest.urls.length; index += 1) {
        if (controller.signal.aborted) throw abortError()
        const url = session.manifest.urls[index]
        if (!url) throw new Error(`Missing URL for streaming segment ${index + 1}`)

        const data = await this.downloadSegment(
          url,
          controller.signal,
          session.manifest.segmentByteRanges?.[index] ?? null,
        )
        if (controller.signal.aborted) throw abortError()
        await this.adapter.appendSegment(session, Buffer.from(data))
        session.recordSegment(data.byteLength)
        session.setPlaybackRevision(this.adapter.getPlaybackRevision(session.sessionId))

        const progress = this.createProgressEvent(session)
        this.onProgress(progress)
        console.info(`[Streaming] Downloaded segment ${progress.segmentsDownloaded}/${progress.segmentsTotal}`)

        if (!readiness.settled && this.adapter.isReady(session)) {
          readiness.settled = true
          readiness.resolve()
          console.info('[Streaming] Threshold reached')
          console.info(`Bytes: ${session.bytesDownloaded}`)
          console.info(`Segments: ${session.completedSegments}/${session.totalSegments}`)
        }
      }

      const finalized = await this.adapter.finalize(session)
      session.setPlaybackRevision(this.adapter.getPlaybackRevision(session.sessionId))
      session.markCompleted()
      if (!readiness.settled) {
        readiness.settled = true
        readiness.resolve()
      }
      console.info('[Streaming] Session completed')
      return finalized
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        session.markCancelled()
      } else {
        session.markFailed(error)
      }
      await this.adapter.abort(session.sessionId)
      if (!readiness.settled) {
        readiness.settled = true
        readiness.reject(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    } finally {
      this.controllers.delete(session.sessionId)
      this.sessions.delete(session.sessionId)
      this.readinessWaiters.delete(session.sessionId)
    }
  }

  async stop(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.markCancelled()
    this.controllers.get(sessionId)?.abort()
    await this.adapter.abort(sessionId)
  }

  async waitForReadiness(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session && this.adapter.isReady(session)) return
    const waiter = this.readinessWaiters.get(sessionId)
    if (!waiter) throw new Error(`Streaming session ${sessionId} has not started`)
    await waiter.promise
  }

  private async downloadSegment(
    url: string,
    signal: AbortSignal,
    byteRange?: { offset: number; length: number } | null,
  ): Promise<Uint8Array> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const headers = byteRange
          ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` }
          : undefined
        const response = await this.fetchImpl(url, { signal, ...(headers ? { headers } : {}) })
        if (!response.ok) {
          const error = new Error(`Segment request failed with HTTP ${response.status}`)
          if (!isTransientStatus(response.status)) throw error
          lastError = error
        } else if (byteRange && response.status !== 206) {
          throw new Error(`Segment byte-range request was not honored (HTTP ${response.status})`)
        } else {
          return new Uint8Array(await response.arrayBuffer())
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError()
        lastError = error instanceof Error ? error : new Error(String(error))
        if (error instanceof Error && /^Segment request failed with HTTP/.test(error.message)) {
          const status = Number(error.message.match(/HTTP (\d+)/)?.[1])
          if (!isTransientStatus(status)) throw error
        }
      }

      const retryDelay = RETRY_DELAYS_MS[attempt]
      if (retryDelay === undefined) break
      console.warn(`[Streaming] Segment download retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${retryDelay}ms`)
      await waitForRetry(retryDelay, signal)
    }

    throw lastError ?? new Error('Segment download failed')
  }

  private createProgressEvent(session: StreamingSession): StreamingProgressEvent {
    const percent = session.totalSegments > 0
      ? (session.completedSegments / session.totalSegments) * 100
      : 0
    return {
      sessionId: session.sessionId,
      trackId: session.trackId,
      bytesDownloaded: session.bytesDownloaded,
      segmentsDownloaded: session.completedSegments,
      segmentsTotal: session.totalSegments,
      percent: Math.max(0, Math.min(100, percent)),
      state: session.state,
      downloadRate: session.downloadRate,
      estimatedRemaining: session.estimatedRemaining,
      playbackStarted: session.playbackStarted,
      playbackRevision: session.playbackRevision,
    }
  }
}
