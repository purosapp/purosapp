import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../store/playerStore'
import { useSettingsStore } from '../../store/settingsStore'
import { DownloadFirstPreparationStrategy } from './DownloadFirstPreparationStrategy'
import { PlaybackPreparationService } from './PlaybackPreparationService'
import type { PreparedPlayback } from './types'

const track = {
  id: 'row-1', title: 'Song', artist: 'Artist', album: 'Album', duration: 1,
  provider: 'fixture', streamId: 'source-1',
} as Track

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('renderer playback preparation cancellation', () => {
  it('cancels an in-flight complete-file request before its artifact returns', async () => {
    useSettingsStore.setState({ streamingPlaybackMode: 'download-first' })
    vi.stubGlobal('crypto', { randomUUID: () => 'session-123' })
    const cancelSession = vi.fn(async () => ({ ok: true, value: true }))
    vi.stubGlobal('window', { puros: { provider: { cancelSession, invoke: vi.fn() } } })
    let finish!: (value: PreparedPlayback) => void
    const prepare = vi.spyOn(DownloadFirstPreparationStrategy.prototype, 'prepareTrack')
      .mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const service = new PlaybackPreparationService()
    const pending = service.prepareTrack(track)
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(prepare.mock.calls[0]?.[1].sessionId).toBe('session-123')

    await service.cancelActiveSession()
    expect(cancelSession).toHaveBeenCalledWith('fixture', 'session-123')
    finish({ playbackTarget: '/cache/song.m4a', formatInfo: null, providerId: 'fixture' })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.getActiveGrowingSession()).toBeNull()
  })

  it('preserves the existing progressive-session cancel after a growing artifact returns', async () => {
    useSettingsStore.setState({ streamingPlaybackMode: 'download-first' })
    vi.stubGlobal('crypto', { randomUUID: () => 'session-456' })
    const invoke = vi.fn(async () => ({ ok: true, value: undefined }))
    vi.stubGlobal('window', { puros: { provider: { cancelSession: vi.fn(), invoke } } })
    vi.spyOn(DownloadFirstPreparationStrategy.prototype, 'prepareTrack').mockResolvedValue({
      playbackTarget: '/cache/partial.flac', formatInfo: null, providerId: 'fixture',
      isStreamingSession: true,
      streamingSession: { sessionId: 'stream-123' } as PreparedPlayback['streamingSession'],
    })
    const service = new PlaybackPreparationService()
    await service.prepareTrack(track)
    expect(service.getActiveGrowingSession()).toEqual({ providerId: 'fixture', sessionId: 'stream-123' })
    await service.cancelActiveSession()
    expect(invoke).toHaveBeenCalledWith('fixture', 'playback.progressive', 'cancel', [{ sessionId: 'stream-123' }])
  })
})
