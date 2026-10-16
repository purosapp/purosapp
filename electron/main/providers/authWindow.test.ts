import { describe, expect, it } from 'vitest'
import { authPartitionKind, browserUserAgent, googleChromeMetadata, hasRequiredCookies, lowEntropyClientHints, serializeCookieJar } from './authWindow'

describe('auth window helpers', () => {
  it('keeps partitions inside the provider namespace, on disk or in memory', () => {
    expect(authPartitionKind('youtube-music', 'persist:puros-provider-youtube-music')).toBe('persistent')
    expect(authPartitionKind('youtube-music', 'persist:puros-provider-youtube-music-login')).toBe('persistent')
    expect(authPartitionKind('youtube-music', 'puros-provider-youtube-music-sign-in')).toBe('memory')
    expect(authPartitionKind('youtube-music', 'puros-provider-youtube-musicx')).toBeNull()
    expect(authPartitionKind('youtube-music', 'persist:puros-provider-tidal')).toBeNull()
    expect(authPartitionKind('youtube-music', 'puros-provider-tidal-login')).toBeNull()
  })

  it('presents the embedded Chromium as a browser, without app and Electron tokens', () => {
    expect(browserUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) puros/0.0.0 Chrome/140.0.7339.41 Electron/38.1.2 Safari/537.36'))
      .toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
  })

  it('writes every cookie of the declared domains as a Netscape file', () => {
    const cookies = [
      { name: 'SAPISID', value: 'a/b', domain: '.youtube.com', hostOnly: false, path: '/', secure: true, httpOnly: false, session: false, expirationDate: 1_900_000_000.75 },
      { name: 'LOGIN_INFO', value: 'x:y', domain: '.youtube.com', hostOnly: false, path: '/', secure: true, httpOnly: true, session: false, expirationDate: 1_900_000_000 },
      { name: 'YSC', value: 'v', domain: 'music.youtube.com', hostOnly: true, path: '/', secure: true, httpOnly: true, session: true },
      { name: 'SAPISID', value: 'dup', domain: '.youtube.com', hostOnly: false, path: '/', secure: true },
      { name: 'SID', value: 'google', domain: '.google.com', hostOnly: false, path: '/', secure: false },
    ]
    expect(serializeCookieJar(cookies, ['youtube.com'])).toBe([
      '# Netscape HTTP Cookie File',
      '',
      '.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSAPISID\ta/b',
      '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1900000000\tLOGIN_INFO\tx:y',
      '#HttpOnly_music.youtube.com\tFALSE\t/\tTRUE\t0\tYSC\tv',
      '',
    ].join('\n'))
    expect(hasRequiredCookies(cookies, ['youtube.com'], ['LOGIN_INFO', 'SAPISID'])).toBe(true)
    expect(hasRequiredCookies(cookies, ['youtube.com'], ['SID'])).toBe(false)
    expect(hasRequiredCookies(cookies, ['google.com'], ['SID'])).toBe(true)
  })
})

describe('Google Chrome client hints', () => {
  it('adds the Google Chrome brand to the engine’s own hints, keeping its GREASE brand', () => {
    const native = {
      brands: [{ brand: 'Not-A.Brand', version: '24' }, { brand: 'Chromium', version: '146' }],
      fullVersionList: [{ brand: 'Not-A.Brand', version: '24.0.0.0' }, { brand: 'Chromium', version: '146.0.7680.166' }],
      platform: 'macOS', platformVersion: '26.6.2', architecture: 'arm', bitness: '64', model: '', mobile: false, wow64: false,
    }
    expect(googleChromeMetadata(native)).toEqual({
      ...native,
      brands: [...native.brands, { brand: 'Google Chrome', version: '146' }],
      fullVersionList: [...native.fullVersionList, { brand: 'Google Chrome', version: '146.0.7680.166' }],
    })
    expect(() => googleChromeMetadata({ ...native, brands: [] })).toThrow()
    // As Chromium formats them for subresources.
    expect(lowEntropyClientHints(googleChromeMetadata(native))).toEqual({
      'sec-ch-ua': '"Not-A.Brand";v="24", "Chromium";v="146", "Google Chrome";v="146"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    })
  })
})
