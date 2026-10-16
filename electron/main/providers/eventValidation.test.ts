import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { API_VERSION, type ProviderEventEnvelopeV1 } from '../../../src/provider-api/v1'
import { validateProviderProcessEvent } from './eventValidation'

const created: string[] = []
afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function sessionEvent(artifactPath: string, state: 'running' | 'completed'): ProviderEventEnvelopeV1 {
  return {
    apiVersion: API_VERSION, providerId: 'sample', sequence: 1,
    event: {
      type: 'playback.session',
      session: { sessionId: 'session-1', sourceId: 'track-1', state, artifactPath, playbackStarted: false, revision: 1 },
    },
  }
}

describe('provider process event validation', () => {
  it('canonicalizes a completed artifact only within the provider cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-event-cache-'))
    created.push(root)
    const file = path.join(root, 'audio.flac')
    fs.writeFileSync(file, 'fixture')
    const event = validateProviderProcessEvent(sessionEvent(file, 'completed'), root)
    expect(event.event.type === 'playback.session' ? event.event.session.artifactPath : null).toBe(fs.realpathSync.native(file))
  })

  it('rejects an escaped completed path and strips unavailable running paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-event-cache-'))
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-event-other-'))
    created.push(root, other)
    const escaped = path.join(other, 'audio.flac')
    fs.writeFileSync(escaped, 'fixture')
    expect(() => validateProviderProcessEvent(sessionEvent(escaped, 'completed'), root)).toThrow('escaped')
    const pending = validateProviderProcessEvent(sessionEvent(path.join(root, 'not-yet.flac'), 'running'), root)
    expect(pending.event.type === 'playback.session' ? pending.event.session.artifactPath : null).toBeUndefined()
  })

  it('passes a finished artifact format through and rejects a malformed one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-event-cache-'))
    created.push(root)
    const file = path.join(root, 'audio.flac')
    fs.writeFileSync(file, 'fixture')
    const format = { format: 'FLAC' as const, sampleRate: 44_100, bitDepth: 16, bitrate: 912, channels: 2, isLossless: true, isHiRes: false, isMqa: false, isDsd: false }
    const base = sessionEvent(file, 'completed')
    const withFormat = { ...base, event: { ...base.event, session: { ...(base.event as { session: object }).session, format } } } as ProviderEventEnvelopeV1
    const validated = validateProviderProcessEvent(withFormat, root)
    expect(validated.event.type === 'playback.session' ? validated.event.session.format : null).toEqual(format)
    const broken = { ...base, event: { ...base.event, session: { ...(base.event as { session: object }).session, format: { ...format, bitrate: -1 } } } } as ProviderEventEnvelopeV1
    expect(() => validateProviderProcessEvent(broken, root)).toThrow(/bitrate/)
  })

  it('rejects malformed status events before they reach core state', () => {
    expect(() => validateProviderProcessEvent({
      apiVersion: API_VERSION, providerId: 'sample', sequence: 1,
      event: { type: 'status.changed', status: { state: 'ready', updatedAt: NaN } },
    }, '/tmp')).toThrow('status')
  })
})
