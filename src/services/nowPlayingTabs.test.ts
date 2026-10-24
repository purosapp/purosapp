import { describe, expect, it } from 'vitest'
import { DEFAULT_NOW_PLAYING_TABS, enabledNowPlayingTabs, parseNowPlayingTabs } from './nowPlayingTabs'

describe('Now Playing tabs', () => {
  it('shows lyrics and authors, without the visualizer, by default', () => {
    expect(parseNowPlayingTabs(null)).toEqual({ lyrics: true, authors: true, visualizer: false })
    expect(enabledNowPlayingTabs(DEFAULT_NOW_PLAYING_TABS)).toEqual(['lyrics', 'authors'])
  })

  it('reads stored tabs, filling gaps and ignoring junk', () => {
    expect(parseNowPlayingTabs('{"visualizer":true,"lyrics":false}')).toEqual({ lyrics: false, authors: true, visualizer: true })
    expect(parseNowPlayingTabs('{"authors":"no","extra":true}')).toEqual(DEFAULT_NOW_PLAYING_TABS)
    expect(parseNowPlayingTabs('not json')).toEqual(DEFAULT_NOW_PLAYING_TABS)
    expect(parseNowPlayingTabs('[true]')).toEqual(DEFAULT_NOW_PLAYING_TABS)
  })

  it('carries the old "hide lyrics" switch over as every tab off, until tabs are saved', () => {
    expect(parseNowPlayingTabs(null, 'false')).toEqual({ lyrics: false, authors: false, visualizer: false })
    expect(parseNowPlayingTabs(null, 'true')).toEqual(DEFAULT_NOW_PLAYING_TABS)
    expect(parseNowPlayingTabs('{"lyrics":true}', 'false')).toEqual(DEFAULT_NOW_PLAYING_TABS)
  })

  it('keeps display order regardless of which tabs are on', () => {
    expect(enabledNowPlayingTabs({ lyrics: false, authors: true, visualizer: true })).toEqual(['authors', 'visualizer'])
  })
})
