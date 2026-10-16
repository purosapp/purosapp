import type { PlaybackArtifactV1, ProviderDescriptorV1 } from '../../provider-api/v1'
import type { Track } from '../../store/playerStore'
import { PlaybackPreparationCancelledError, type PreparationIntent, type PreparationOptions } from './types'

export function providerIdForTrack(track: Track): string {
  const providerId = String(track.provider ?? track.sourceType ?? '').trim()
  if (!providerId || providerId === 'local') throw new Error('Remote playback requires a provider ID')
  return providerId
}

function sourceIdForTrack(track: Track): string {
  const sourceId = track.sourceId ?? track.streamId
  if (!sourceId) throw new Error('Remote playback requires a source ID')
  return sourceId
}

async function descriptor(providerId: string): Promise<ProviderDescriptorV1> {
  const found = (await window.puros.provider.list()).find(({ manifest }) => manifest.id === providerId)
  if (!found) throw new Error(`Provider is not installed: ${providerId}`)
  return found
}

export async function resolveProviderArtifact(
  track: Track,
  intent: PreparationIntent,
  preferPrefetch: boolean,
  options: PreparationOptions = {},
): Promise<{ providerId: string; artifact: PlaybackArtifactV1 | null }> {
  if (options.isCancelled?.()) throw new PlaybackPreparationCancelledError()
  const providerId = providerIdForTrack(track)
  const provider = await descriptor(providerId)
  if (options.isCancelled?.()) throw new PlaybackPreparationCancelledError()
  const request = {
    sourceId: sourceIdForTrack(track),
    fallbackSourceIds: [],
    intent,
    ...(intent === 'playback' && options.sessionId ? { sessionId: options.sessionId } : {}),
  }
  const usePrefetch = preferPrefetch && provider.manifest.capabilities.includes('playback.prefetch')
  const unsubscribe = options.sessionId && options.onProgress
    ? window.puros.provider.onEvent((envelope) => {
      if (envelope.providerId !== providerId || envelope.event.type !== 'playback.progress') return
      if (envelope.event.progress.sessionId !== options.sessionId || options.isCancelled?.()) return
      options.onProgress?.(envelope.event.progress)
    })
    : null
  let result: Awaited<ReturnType<typeof window.puros.provider.invoke>>
  try {
    if (options.isCancelled?.()) throw new PlaybackPreparationCancelledError()
    result = usePrefetch
      ? await window.puros.provider.invoke(providerId, 'playback.prefetch', 'prefetch', [request])
      : await window.puros.provider.invoke(providerId, 'playback.resolve', 'resolve', [request])
  } finally {
    unsubscribe?.()
  }
  if (options.isCancelled?.()) throw new PlaybackPreparationCancelledError()
  if (!result.ok) throw new Error(result.error.message)
  if (result.value == null) return { providerId, artifact: null }
  return { providerId, artifact: result.value as unknown as PlaybackArtifactV1 }
}

export function waitForCompletedArtifact(
  providerId: string,
  artifact: PlaybackArtifactV1,
  timeoutMs = 120_000,
): Promise<PlaybackArtifactV1> {
  if (artifact.lifecycle === 'complete') return Promise.resolve(artifact)
  if (!artifact.sessionId) return Promise.reject(new Error('Growing playback artifact is missing a session ID'))
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error(`Provider playback session timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const unsubscribe = window.puros.provider.onEvent((envelope) => {
      if (envelope.providerId !== providerId || envelope.event.type !== 'playback.session') return
      const session = envelope.event.session
      if (session.sessionId !== artifact.sessionId) return
      if (session.state === 'completed' && session.artifactPath) {
        window.clearTimeout(timeout)
        unsubscribe()
        resolve({ ...artifact, path: session.artifactPath, lifecycle: 'complete' })
      } else if (session.state === 'failed' || session.state === 'cancelled') {
        window.clearTimeout(timeout)
        unsubscribe()
        reject(new Error(session.error?.message ?? `Provider playback session ${session.state}`))
      }
    })
  })
}
