import {
  PROVIDER_SESSION_ID_PATTERN,
  type ProviderEventEnvelopeV1,
} from '../../../src/provider-api/v1'
import { resolveAllowedExistingFile } from '../security/pathPolicy'
import { validateFormatInfo } from './validation'

const SESSION_STATES = new Set(['created', 'running', 'completed', 'failed', 'cancelled'])
const STATUS_STATES = new Set(['inactive', 'activating', 'ready', 'degraded', 'error'])

export function validateProviderProcessEvent(
  envelope: ProviderEventEnvelopeV1,
  cacheRoot: string,
): ProviderEventEnvelopeV1 {
  const event = envelope.event
  if (event.type === 'status.changed') {
    if (!event.status || !STATUS_STATES.has(event.status.state) || !Number.isFinite(event.status.updatedAt)) {
      throw new TypeError('Invalid provider status event')
    }
  } else if (event.type === 'auth.changed') {
    if (!event.status || typeof event.status.authenticated !== 'boolean') throw new TypeError('Invalid provider auth event')
  } else if (event.type === 'playback.session') {
    const session = event.session
    if (!session || !PROVIDER_SESSION_ID_PATTERN.test(session.sessionId)
      || typeof session.sourceId !== 'string' || !SESSION_STATES.has(session.state)
      || !Number.isSafeInteger(session.revision) || typeof session.playbackStarted !== 'boolean') {
      throw new TypeError('Invalid provider playback session event')
    }
    if (session.format !== undefined) validateFormatInfo(session.format)
    if (session.sourceFormat !== undefined) validateFormatInfo(session.sourceFormat)
    if (session.artifactPath !== undefined) {
      const allowedPath = resolveAllowedExistingFile(session.artifactPath, [cacheRoot])
      if (!allowedPath && session.state === 'completed') throw new TypeError('Completed provider artifact escaped its cache root')
      return {
        ...envelope,
        event: {
          ...event,
          session: allowedPath
            ? { ...session, artifactPath: allowedPath }
            : { ...session, artifactPath: undefined },
        },
      }
    }
  } else if (event.type === 'playback.progress') {
    const progress = event.progress
    if (!progress || !PROVIDER_SESSION_ID_PATTERN.test(progress.sessionId)
      || typeof progress.sourceId !== 'string' || !SESSION_STATES.has(progress.state)
      || !Number.isSafeInteger(progress.revision) || typeof progress.playbackStarted !== 'boolean') {
      throw new TypeError('Invalid provider playback progress event')
    }
  } else if (event.type === 'library.sync.progress') {
    if (!Number.isFinite(event.processed) || event.processed < 0) throw new TypeError('Invalid provider library progress event')
  } else if (event.type === 'warning') {
    if (typeof event.code !== 'string' || typeof event.message !== 'string') throw new TypeError('Invalid provider warning event')
  } else if (event.type !== 'catalog.changed') {
    throw new TypeError('Unknown provider event')
  }
  return envelope
}
