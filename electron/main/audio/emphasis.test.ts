import { describe, expect, it } from 'vitest'
import { cueTrackHasPreEmphasis, tagsIndicatePreEmphasis } from './emphasis'

const CUE = `REM DATE 1985
PERFORMER "Dire Straits"
TITLE "Brothers in Arms"
FILE "Brothers in Arms.flac" WAVE
  TRACK 01 AUDIO
    TITLE "So Far Away"
    FLAGS PRE
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Money for Nothing"
    INDEX 00 05:10:40
    INDEX 01 05:12:00
  TRACK 03 AUDIO
    FLAGS DCP PRE
    INDEX 01 13:40:37
FILE "Bonus.flac" WAVE
  TRACK 04 AUDIO
    INDEX 01 00:00:00
`

describe('cueTrackHasPreEmphasis', () => {
  it('matches the flagged track by file and INDEX 01', () => {
    expect(cueTrackHasPreEmphasis(CUE, '/music/Brothers in Arms.flac', 0)).toBe(true)
    expect(cueTrackHasPreEmphasis(CUE, '/music/Brothers in Arms.flac', 312_000)).toBe(false)
    // 13:40:37 = 820.493 s; FLAGS may list several flags.
    expect(cueTrackHasPreEmphasis(CUE, '/music/Brothers in Arms.flac', 820_493)).toBe(true)
    expect(cueTrackHasPreEmphasis(CUE, '/music/Bonus.flac', 0)).toBe(false)
  })

  it('treats a per-file rip (no offset) as flagged when any of its tracks is', () => {
    expect(cueTrackHasPreEmphasis(CUE, '/music/Brothers in Arms.flac', null)).toBe(true)
    expect(cueTrackHasPreEmphasis(CUE, '/music/Other.flac', null)).toBe(false)
  })
})

describe('tagsIndicatePreEmphasis', () => {
  it('accepts common ripper tags with truthy values', () => {
    expect(tagsIndicatePreEmphasis([{ id: 'PRE_EMPHASIS', value: '1' }])).toBe(true)
    expect(tagsIndicatePreEmphasis([{ id: 'EMPHASIS', value: '50/15 µs' }])).toBe(true)
    expect(tagsIndicatePreEmphasis([{ id: 'TXXX:PREEMPHASIS', value: 'yes' }])).toBe(true)
    expect(tagsIndicatePreEmphasis([{ id: '----:com.apple.iTunes:PRE_EMPHASIS', value: 'true' }])).toBe(true)
  })

  it('ignores unrelated or negative tags', () => {
    expect(tagsIndicatePreEmphasis([{ id: 'PRE_EMPHASIS', value: '0' }])).toBe(false)
    expect(tagsIndicatePreEmphasis([{ id: 'EMPHASIS', value: 'none' }])).toBe(false)
    expect(tagsIndicatePreEmphasis([{ id: 'COMMENT', value: 'pre-emphasis 1' }])).toBe(false)
  })
})
