import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderEventEnvelopeV1 } from '../../provider-api/v1'
import type { Track } from '../../store/playerStore'
import { resolveProviderArtifact } from './providerArtifact'

const track = {
  id: 'row-1', title: 'Song', artist: 'Artist', album: 'Album', duration: 1,
  provider: 'fixture', streamId: 'source-1',
} as Track
const artifact = {
  path: '/cache/song.m4a', lifecycle: 'complete',
  format: { format: 'AAC', sampleRate: 44_100, bitDepth: 16, bitrate: 256_000, channels: 2,
    isLossless: false, isHiRes: false, isMqa: false, isDsd: false },
}

afterEach(() => vi.unstubAllGlobals())

describe('renderer provider artifact resolution', () => {
  it('uses the recorded source ID for playback and prefetch without legacy alternatives', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: artifact }))
    vi.stubGlobal('window', { puros: { provider: {
      list: async () => [{ manifest: { id: 'fixture', capabilities: ['playback.resolve', 'playback.prefetch'] } }],
      invoke, onEvent: vi.fn(),
    } } })
    const savedTrack = { ...track, sourceId: 'exact-source', streamId: 'old-matched-version', fallbackStreamIds: ['another-version'] }
    await resolveProviderArtifact(savedTrack, 'playback', false)
    await resolveProviderArtifact(savedTrack, 'prefetch', true)
    expect(invoke).toHaveBeenNthCalledWith(1, 'fixture', 'playback.resolve', 'resolve', [{ sourceId: 'exact-source', fallbackSourceIds: [], intent: 'playback' }])
    expect(invoke).toHaveBeenNthCalledWith(2, 'fixture', 'playback.prefetch', 'prefetch', [{ sourceId: 'exact-source', fallbackSourceIds: [], intent: 'prefetch' }])
  })
  it('issues a playback handle before invoke, accepts only matching progress, and unsubscribes', async () => {
    let listener: ((event: ProviderEventEnvelopeV1) => void) | null = null
    const unsubscribe = vi.fn()
    const onProgress = vi.fn()
    const invoke = vi.fn(async (_id: string, _capability: string, _method: string, _args: unknown[]) => {
      const send = (providerId: string, sessionId: string) => listener?.({
        apiVersion: 1, providerId, sequence: 1,
        event: { type: 'playback.progress', progress: {
          sessionId, sourceId: 'source-1', state: 'running', percent: 50, playbackStarted: false, revision: 1,
        } },
      })
      send('other-provider', 'session-123')
      send('fixture', 'session-other')
      send('fixture', 'session-123')
      return { ok: true, value: artifact }
    })
    vi.stubGlobal('window', { puros: { provider: {
      list: async () => [{ manifest: { id: 'fixture', capabilities: ['playback.resolve', 'playback.prefetch'] } }],
      invoke,
      onEvent: (callback: typeof listener) => { listener = callback; return unsubscribe },
    } } })

    expect(await resolveProviderArtifact(track, 'playback', false, { sessionId: 'session-123', onProgress }))
      .toEqual({ providerId: 'fixture', artifact })
    expect(invoke).toHaveBeenCalledWith('fixture', 'playback.resolve', 'resolve', [expect.objectContaining({ sessionId: 'session-123' })])
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps speculative prefetch free of session handles and skips a cancelled lookup', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: artifact }))
    let completeList!: (value: unknown[]) => void
    const list = vi.fn(() => new Promise<unknown[]>((resolve) => { completeList = resolve }))
    vi.stubGlobal('window', { puros: { provider: { list, invoke, onEvent: vi.fn() } } })
    const cancelled = { value: false }
    const pending = resolveProviderArtifact(track, 'playback', false, { sessionId: 'session-123', isCancelled: () => cancelled.value })
    cancelled.value = true
    completeList([{ manifest: { id: 'fixture', capabilities: ['playback.resolve', 'playback.prefetch'] } }])
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke).not.toHaveBeenCalled()

    const prefetch = resolveProviderArtifact(track, 'prefetch', true, { sessionId: 'session-123' })
    completeList([{ manifest: { id: 'fixture', capabilities: ['playback.resolve', 'playback.prefetch'] } }])
    await prefetch
    expect(invoke).toHaveBeenCalledWith('fixture', 'playback.prefetch', 'prefetch', [expect.not.objectContaining({ sessionId: expect.anything() })])
  })
})
