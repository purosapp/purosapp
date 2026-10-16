import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callLastFmApi, getLastFmAuthUrl, getLastFmConfigStatus } from './index'

vi.mock('electron', () => ({ app: {} }))
vi.mock('../rendererBridge', () => ({ getMainWindow: () => null }))

describe('built-in Last.fm credentials', () => {
  beforeEach(() => {
    vi.stubEnv('PUROS_PROVIDERS', 'none')
    vi.stubEnv('LASTFM_API_KEY', undefined)
    vi.stubEnv('LASTFM_API_SECRET', undefined)
    vi.stubGlobal('__PUROS_LASTFM_CREDENTIALS__', {
      apiKey: 'bundled-key', apiSecret: 'bundled-secret',
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('enables connection without runtime credentials or playback providers', () => {
    expect(getLastFmConfigStatus()).toEqual({ configured: true })
    const authUrl = new URL(getLastFmAuthUrl(47892)!)
    expect(authUrl.searchParams.get('api_key')).toBe('bundled-key')
    expect(authUrl.searchParams.get('cb')).toBe('http://localhost:47892/lastfm/callback')
  })

  it('signs scrobbles with the bundled app credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ scrobbles: {} }) })
    vi.stubGlobal('fetch', fetchMock)

    await callLastFmApi({
      method: 'track.scrobble',
      params: { artist: 'Artist', track: 'Track', timestamp: '1700000000' },
      sessionKey: 'user-session',
    })

    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ws.audioscrobbler.com/2.0/')
    expect(request.method).toBe('POST')
    const params = request.body as URLSearchParams
    expect(params.get('api_key')).toBe('bundled-key')
    expect(params.get('sk')).toBe('user-session')
    expect(params.get('api_sig')).toBe(createHash('md5').update(
      'api_keybundled-keyartistArtistmethodtrack.scrobbleskuser-sessiontimestamp1700000000trackTrackbundled-secret',
    ).digest('hex'))
    expect(params.has('apiSecret')).toBe(false)
  })

  it('preserves runtime app credential overrides', () => {
    vi.stubEnv('LASTFM_API_KEY', ' override-key ')
    vi.stubEnv('LASTFM_API_SECRET', ' override-secret ')
    expect(getLastFmConfigStatus()).toEqual({ configured: true })
    expect(new URL(getLastFmAuthUrl(47892)!).searchParams.get('api_key')).toBe('override-key')
  })

  it('reports unconfigured builds and rejects API calls without credentials', async () => {
    vi.stubGlobal('__PUROS_LASTFM_CREDENTIALS__', { apiKey: '', apiSecret: '' })
    expect(getLastFmConfigStatus()).toEqual({ configured: false })
    expect(getLastFmAuthUrl(47892)).toBeNull()
    await expect(callLastFmApi({ method: 'auth.getSession', params: { token: 'token' } }))
      .rejects.toThrow('Last.fm API key is missing')
  })
})
