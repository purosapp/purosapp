export interface StreamManifest {
  trackId: string
  resolvedTrackId?: string
  resolvedQuality?: string
  codec: string
  fileExtension?: string
  sampleRate?: number
  bitDepth?: number
  urls: string[]
  segmentByteRanges?: Array<{ offset: number; length: number } | null>
  encrypted: boolean
  encryptionKey?: string | null
  replayGain?: number | null
  /** Provider that owns the streaming session. */
  provider?: string
}

export enum StreamingSessionState {
  Created = 'created',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export interface StreamingSessionSnapshot {
  sessionId: string
  trackId: string
  createdAt: number
  state: StreamingSessionState
  manifest: StreamManifest
  bytesDownloaded: number
  totalSegments: number
  completedSegments: number
  downloadRate: number
  estimatedRemaining: number | null
  playbackStarted: boolean
  playbackRevision: number
  error?: string
}

export interface StreamingSessionStartResult {
  playbackPath: string
  session: StreamingSessionSnapshot
}

export interface StreamingSessionEvent {
  session: StreamingSessionSnapshot
  playbackPath: string
}

export class StreamingSession {
  readonly sessionId: string
  readonly trackId: string
  readonly createdAt: number
  readonly manifest: StreamManifest
  readonly totalSegments: number
  state = StreamingSessionState.Created
  bytesDownloaded = 0
  completedSegments = 0
  downloadRate = 0
  estimatedRemaining: number | null = null
  playbackStarted = false
  playbackRevision = 0
  error?: string
  private runningAt: number | null = null

  constructor(sessionId: string, manifest: StreamManifest, createdAt = Date.now()) {
    this.sessionId = sessionId
    this.trackId = manifest.trackId
    this.createdAt = createdAt
    this.manifest = manifest
    this.totalSegments = manifest.urls.length
  }

  markRunning(): void {
    if (this.state !== StreamingSessionState.Created) return
    this.state = StreamingSessionState.Running
    this.runningAt = Date.now()
  }

  recordSegment(bytes: number): void {
    if (this.state !== StreamingSessionState.Running) return
    this.bytesDownloaded += Math.max(0, bytes)
    this.completedSegments += 1
    const elapsedSeconds = Math.max(0.001, (Date.now() - (this.runningAt ?? this.createdAt)) / 1000)
    this.downloadRate = this.bytesDownloaded / elapsedSeconds
    const averageSegmentBytes = this.bytesDownloaded / this.completedSegments
    const remainingBytes = averageSegmentBytes * Math.max(0, this.totalSegments - this.completedSegments)
    this.estimatedRemaining = this.downloadRate > 0 ? remainingBytes / this.downloadRate : null
  }

  markCompleted(): void {
    if (this.state !== StreamingSessionState.Running) return
    this.state = StreamingSessionState.Completed
    this.estimatedRemaining = 0
  }

  markPlaybackStarted(): void {
    this.playbackStarted = true
  }

  setPlaybackRevision(revision: number): void {
    this.playbackRevision = Math.max(this.playbackRevision, revision)
  }

  markFailed(error: unknown): void {
    if (this.isTerminal()) return
    this.state = StreamingSessionState.Failed
    this.error = error instanceof Error ? error.message : String(error)
  }

  markCancelled(): void {
    if (this.isTerminal()) return
    this.state = StreamingSessionState.Cancelled
  }

  snapshot(): StreamingSessionSnapshot {
    return {
      sessionId: this.sessionId,
      trackId: this.trackId,
      createdAt: this.createdAt,
      state: this.state,
      manifest: this.manifest,
      bytesDownloaded: this.bytesDownloaded,
      totalSegments: this.totalSegments,
      completedSegments: this.completedSegments,
      downloadRate: this.downloadRate,
      estimatedRemaining: this.estimatedRemaining,
      playbackStarted: this.playbackStarted,
      playbackRevision: this.playbackRevision,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  private isTerminal(): boolean {
    return this.state === StreamingSessionState.Completed
      || this.state === StreamingSessionState.Failed
      || this.state === StreamingSessionState.Cancelled
  }
}

export interface StreamingProgressEvent {
  sessionId: string
  trackId: string
  bytesDownloaded: number
  segmentsDownloaded: number
  segmentsTotal: number
  percent: number
  state: StreamingSessionState
  downloadRate: number
  estimatedRemaining: number | null
  playbackStarted: boolean
  playbackRevision: number
}

export interface SegmentFetcher {
  start(session: StreamingSession): Promise<{ playbackPath: string }>
  stop(sessionId: string): Promise<void>
  waitForReadiness(sessionId: string): Promise<void>
}

export interface CacheWriter {
  begin(session: StreamingSession): Promise<void>
  append(sessionId: string, data: Uint8Array): Promise<void>
  finalize(sessionId: string): Promise<void>
  abort(sessionId: string): Promise<void>
}
