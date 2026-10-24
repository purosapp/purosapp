import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_BACKOFF_MAX_MS,
  DOWNLOAD_BACKOFF_START_MS,
  nextDownloadBackoffMs,
  relaxDownloadBackoffMs,
} from './pacing'

describe('download pacing', () => {
  it('doubles the backoff up to the cap', () => {
    let backoff = 0
    const waits: number[] = []
    for (let i = 0; i < 8; i += 1) {
      backoff = nextDownloadBackoffMs(backoff)
      waits.push(backoff)
    }
    expect(waits[0]).toBe(DOWNLOAD_BACKOFF_START_MS)
    expect(waits[1]).toBe(DOWNLOAD_BACKOFF_START_MS * 2)
    expect(waits[waits.length - 1]).toBe(DOWNLOAD_BACKOFF_MAX_MS)
  })

  it('halves the backoff after a success and drops it below the start value', () => {
    expect(relaxDownloadBackoffMs(80_000)).toBe(40_000)
    expect(relaxDownloadBackoffMs(DOWNLOAD_BACKOFF_START_MS)).toBe(0)
    expect(relaxDownloadBackoffMs(0)).toBe(0)
  })
})
