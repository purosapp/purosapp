import { describe, expect, it } from 'vitest'
import { normalizeHttpExternalUrl } from './urlPolicy'

describe('normalizeHttpExternalUrl', () => {
  it('allows HTTP and HTTPS URLs', () => {
    expect(normalizeHttpExternalUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1')
    expect(normalizeHttpExternalUrl('http://127.0.0.1:47892/callback')).toBe('http://127.0.0.1:47892/callback')
  })

  it('rejects non-web and malformed URLs', () => {
    expect(normalizeHttpExternalUrl('file:///tmp/private')).toBeNull()
    expect(normalizeHttpExternalUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeHttpExternalUrl('x-apple.systempreferences:Sound')).toBeNull()
    expect(normalizeHttpExternalUrl('not a URL')).toBeNull()
    expect(normalizeHttpExternalUrl(null)).toBeNull()
  })
})
