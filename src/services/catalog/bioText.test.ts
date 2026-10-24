import { describe, expect, it } from 'vitest'
import { bioPlainText, parseBioText } from './bioText'

describe('bio text', () => {
  it('splits entity and web links from plain text', () => {
    expect(parseBioText('[Deftones](puros:artist/15349) issued [White Pony](puros:album/392528). See [more](https://example.com/a).')).toEqual([
      { type: 'entity', text: 'Deftones', entityType: 'artist', sourceId: '15349' },
      { type: 'text', text: ' issued ' },
      { type: 'entity', text: 'White Pony', entityType: 'album', sourceId: '392528' },
      { type: 'text', text: '. See ' },
      { type: 'external', text: 'more', url: 'https://example.com/a' },
      { type: 'text', text: '.' },
    ])
  })

  it('keeps unsupported links as text and turns <br> into paragraph breaks', () => {
    expect(parseBioText('One<br/>[Two](javascript:alert(1)) [x](puros:video/1)')).toEqual([
      { type: 'text', text: 'One\n\nTwo) x' },
    ])
  })

  it('reads as plain text without markup', () => {
    expect(bioPlainText('[Deftones](puros:artist/15349) formed in 1988.')).toBe('Deftones formed in 1988.')
  })
})
