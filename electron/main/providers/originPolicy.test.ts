import { describe, expect, it } from 'vitest'
import { authNavigationOrigin, isAllowedExternalUrl } from './originPolicy'

describe('provider external URL policy', () => {
  const origins = ['https://*.tidal.com', 'https://example.org']

  it('allows declared HTTPS origins and their declared subdomains', () => {
    expect(isAllowedExternalUrl('https://login.tidal.com/device?code=123', origins)).toBe(true)
    expect(isAllowedExternalUrl('https://a.b.tidal.com/path', origins)).toBe(true)
    expect(isAllowedExternalUrl('https://example.org/path', origins)).toBe(true)
  })

  it('rejects apex, lookalike, credentials, ports and non-HTTPS URLs', () => {
    for (const url of [
      'https://tidal.com/',
      'https://not-tidal.com/',
      'https://login.tidal.com.evil.invalid/',
      'https://login.tidal.com:444/',
      'https://user@login.tidal.com/',
      'http://login.tidal.com/',
      'file:///tmp/example',
    ]) expect(isAllowedExternalUrl(url, origins)).toBe(false)
  })
})

describe('provider auth navigation origin', () => {
  it('drops paths, query strings and fragments from HTTPS URLs', () => {
    expect(authNavigationOrigin('https://idmsa.apple.com/login?token=private#fragment'))
      .toBe('https://idmsa.apple.com')
  })

  it('rejects credential-bearing, non-HTTPS or malformed auth URLs', () => {
    expect(authNavigationOrigin('https://user:password@idmsa.apple.com/login')).toBeNull()
    expect(authNavigationOrigin('file:///private/secret')).toBeNull()
    expect(authNavigationOrigin('not a URL')).toBeNull()
  })
})
