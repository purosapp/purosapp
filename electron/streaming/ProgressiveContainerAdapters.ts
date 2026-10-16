import type { StreamingSession, StreamManifest } from '../../src/services/playback/streaming'

/** Shared type boundary retained for the legacy Apple progressive path. */
export interface ProgressiveContainerTarget {
  playbackPath: string
  sourcePath: string
}

export interface FinalizedCacheFile {
  playbackPath: string
}

export interface ProgressiveContainerAdapter {
  canHandle(manifest: StreamManifest): boolean
  prepare(session: StreamingSession): Promise<ProgressiveContainerTarget>
  appendSegment(session: StreamingSession, segment: Buffer): Promise<void>
  finalize(session: StreamingSession): Promise<FinalizedCacheFile>
  abort(sessionId: string): Promise<void>
  isReady(session: StreamingSession): boolean
  getTarget(sessionId: string): ProgressiveContainerTarget
  getPlaybackRevision(sessionId: string): number
}
