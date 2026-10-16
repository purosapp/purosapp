import { vi } from 'vitest'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NowPlayingPayload } from './index'

const mocks = {
  getDb: vi.fn(),
  invokeProvider: vi.fn(),
  setNowPlaying: vi.fn(),
  clearNowPlaying: vi.fn(),
}

vi.doMock('../../DiscordRichPresence', () => ({
  DiscordRichPresenceService: class {
    setNowPlaying = mocks.setNowPlaying
    clearNowPlaying = mocks.clearNowPlaying
  },
}))
vi.doMock('../db', () => ({ getDb: mocks.getDb }))
vi.doMock('../audio/engine', () => ({
  getAudioEngine: () => ({ setNowPlayingInfo() {}, clearNowPlayingInfo() {} }),
}))
vi.doMock('../playbackCoordinator', () => ({ setPlaybackState() {} }))
vi.doMock('../providers', () => ({
  invokeProvider: mocks.invokeProvider,
  listProviderDescriptors: () => ['spotify', 'tidal'].map((id) => ({
    manifest: {
      id, displayName: id === 'tidal' ? 'Tidal' : 'Spotify',
      capabilities: id === 'tidal' ? ['catalog.entities', 'metadata.credits'] : ['catalog.entities'],
    },
  })),
}))

const { clearNowPlaying, setNowPlaying } = await import('./index')

const payload = (provider: string, sourceId: string): NowPlayingPayload => ({
  title: `${provider} song`, artist: 'Artist', album: 'Album', duration: 200, position: 0,
  provider, sourceId, catalogTrackId: `catalog:track:${provider}:${sourceId}`,
  artworkUrl: 'https://images.example/cover.jpg',
})

describe('Discord now playing provider links', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    db = new Database(':memory:')
    db.exec(`CREATE TABLE catalog_track_sources (
      catalog_track_id TEXT, provider TEXT, source_id TEXT, provider_url TEXT, available INTEGER DEFAULT 1
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('discordRichPresenceEnabled', 'true')`)
    mocks.getDb.mockReturnValue(db)
    mocks.invokeProvider.mockReset()
  })

  afterEach(() => {
    clearNowPlaying()
    db.close()
  })

  function insert(provider: string, sourceId: string, url: string | null) {
    db.prepare('INSERT INTO catalog_track_sources (catalog_track_id, provider, source_id, provider_url) VALUES (?, ?, ?, ?)')
      .run(`catalog:track:${provider}:${sourceId}`, provider, sourceId, url)
  }

  it('restores a missing Tidal link after a rate-limited Spotify lookup and caches it', async () => {
    insert('spotify', 'spotify-track', null)
    insert('tidal', '379605138', null)
    mocks.invokeProvider.mockImplementation(async (provider: string) => provider === 'spotify'
      ? { ok: false, error: { code: 'RATE_LIMITED', message: 'Try again later', retryable: true } }
      : { ok: true, value: { sourceId: '379605138', providerUrl: 'https://tidal.com/browse/track/379605138' } })

    await setNowPlaying(payload('spotify', 'spotify-track'))
    await setNowPlaying(payload('tidal', '379605138'))

    expect(mocks.setNowPlaying).toHaveBeenLastCalledWith(expect.objectContaining({
      providerLabel: 'Tidal', providerTrackUrl: 'https://tidal.com/browse/track/379605138',
    }))
    expect(db.prepare("SELECT provider_url FROM catalog_track_sources WHERE provider = 'spotify'").get())
      .toEqual({ provider_url: null })
    const lookups = mocks.invokeProvider.mock.calls.length
    await setNowPlaying(payload('tidal', '379605138'))
    expect(mocks.invokeProvider).toHaveBeenCalledTimes(lookups)
    expect(mocks.setNowPlaying).toHaveBeenLastCalledWith(expect.objectContaining({ providerLabel: 'Tidal' }))
  })

  it('does not let a late Spotify response replace the current Tidal presence', async () => {
    insert('spotify', 'old', null)
    insert('tidal', 'current', 'https://tidal.com/browse/track/current')
    let complete!: (value: unknown) => void
    mocks.invokeProvider.mockReturnValue(new Promise((resolve) => { complete = resolve }))
    const pending = setNowPlaying(payload('spotify', 'old'))
    await setNowPlaying(payload('tidal', 'current'))
    const updates = mocks.setNowPlaying.mock.calls.length

    complete({ ok: true, value: { sourceId: 'old', providerUrl: 'https://open.spotify.com/track/old' } })
    await pending

    expect(mocks.setNowPlaying).toHaveBeenCalledTimes(updates)
    expect(mocks.setNowPlaying).toHaveBeenLastCalledWith(expect.objectContaining({ providerLabel: 'Tidal' }))
  })

  it('gets the first-play link for Drift from track details when an older package returns no catalog URL', async () => {
    insert('tidal', '438995711', null)
    mocks.invokeProvider.mockImplementation(async (_provider: string, capability: string) => ({
      ok: true,
      value: capability === 'catalog.entities'
        ? { sourceId: '438995711', title: 'Drift', durationMs: 274_000 }
        : { sourceId: '438995711', providerUrl: 'https://tidal.com/browse/track/438995711', roles: [] },
    }))

    await setNowPlaying({ ...payload('tidal', '438995711'), title: 'Drift', artist: 'ERRA' })

    expect(mocks.invokeProvider).toHaveBeenNthCalledWith(1, 'tidal', 'catalog.entities', 'getTrack', ['438995711'])
    expect(mocks.invokeProvider).toHaveBeenNthCalledWith(2, 'tidal', 'metadata.credits', 'getTrackDetails', ['438995711'])
    expect(mocks.setNowPlaying).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Drift', providerLabel: 'Tidal', providerTrackUrl: 'https://tidal.com/browse/track/438995711',
    }))
    expect(db.prepare('SELECT provider_url FROM catalog_track_sources').get())
      .toEqual({ provider_url: 'https://tidal.com/browse/track/438995711' })
    await setNowPlaying(payload('tidal', '438995711'))
    expect(mocks.invokeProvider).toHaveBeenCalledTimes(2)
  })

  it('shares first-play metadata lookups across repeated presence updates for the same track', async () => {
    insert('tidal', '438995711', null)
    let complete!: (value: unknown) => void
    mocks.invokeProvider.mockImplementation(async (_provider: string, capability: string) => {
      if (capability === 'catalog.entities') return { ok: true, value: { sourceId: '438995711' } }
      return await new Promise((resolve) => { complete = resolve })
    })
    const first = setNowPlaying(payload('tidal', '438995711'))
    const second = setNowPlaying({ ...payload('tidal', '438995711'), duration: 274 })
    await vi.waitFor(() => expect(mocks.invokeProvider).toHaveBeenCalledTimes(2))
    const initialUpdates = mocks.setNowPlaying.mock.calls.length
    complete({ ok: true, value: { sourceId: '438995711', providerUrl: 'https://tidal.com/browse/track/438995711' } })
    await Promise.all([first, second])
    expect(mocks.invokeProvider).toHaveBeenCalledTimes(2)
    expect(mocks.setNowPlaying).toHaveBeenCalledTimes(initialUpdates + 1)
    expect(mocks.setNowPlaying).toHaveBeenLastCalledWith(expect.objectContaining({
      duration: 274, providerTrackUrl: 'https://tidal.com/browse/track/438995711',
    }))
  })

  it('keeps link lookup within the playing provider even with a stale catalog ID', async () => {
    insert('spotify', 'shared-id', 'https://open.spotify.com/track/shared-id')
    insert('tidal', 'shared-id', 'https://tidal.com/browse/track/shared-id')
    await setNowPlaying({ ...payload('tidal', 'shared-id'), catalogTrackId: 'catalog:track:spotify:shared-id' })
    expect(mocks.setNowPlaying).toHaveBeenLastCalledWith(expect.objectContaining({
      providerLabel: 'Tidal', providerTrackUrl: 'https://tidal.com/browse/track/shared-id',
    }))
    expect(mocks.invokeProvider).not.toHaveBeenCalled()
  })

  it('rejects links for a different track', async () => {
    insert('tidal', 'requested', null)
    mocks.invokeProvider.mockResolvedValue({ ok: true, value: { sourceId: 'different', providerUrl: 'https://tidal.com/browse/track/different' } })
    await setNowPlaying(payload('tidal', 'requested'))
    expect(mocks.setNowPlaying).toHaveBeenCalledOnce()
    expect(mocks.setNowPlaying).toHaveBeenLastCalledWith(expect.objectContaining({ providerTrackUrl: null }))
    expect(db.prepare('SELECT provider_url FROM catalog_track_sources').get()).toEqual({ provider_url: null })
  })

  it('does not request provider metadata when Discord Rich Presence is disabled', async () => {
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'discordRichPresenceEnabled'").run()
    await setNowPlaying(payload('spotify', 'rate-limited'))
    expect(mocks.invokeProvider).not.toHaveBeenCalled()
  })

  it('does not restore presence after it is cleared during a link lookup', async () => {
    let complete!: (value: unknown) => void
    mocks.invokeProvider.mockReturnValue(new Promise((resolve) => { complete = resolve }))
    const pending = setNowPlaying(payload('tidal', 'pending'))
    clearNowPlaying()
    complete({ ok: true, value: { sourceId: 'pending', providerUrl: 'https://tidal.com/browse/track/pending' } })
    await pending
    expect(mocks.setNowPlaying).toHaveBeenCalledOnce()
    expect(mocks.clearNowPlaying).toHaveBeenCalledOnce()
  })
})
