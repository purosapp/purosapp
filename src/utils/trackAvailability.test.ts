import { describe, expect, it } from 'vitest'
import { unavailableReasonFromProviderError, unavailableTrackLabel } from './trackAvailability'

describe('track availability', () => {
  it('reads the reason from TRACK_UNAVAILABLE and treats NOT_FOUND as unavailable', () => {
    expect(unavailableReasonFromProviderError({ code: 'TRACK_UNAVAILABLE', details: { reason: 'region' } })).toBe('region')
    expect(unavailableReasonFromProviderError({ code: 'TRACK_UNAVAILABLE' })).toBe('other')
    expect(unavailableReasonFromProviderError({ code: 'NOT_FOUND' })).toBe('other')
  })

  it('ignores failures that say nothing about the track', () => {
    for (const code of ['NETWORK', 'TIMEOUT', 'AUTH_EXPIRED', 'NOT_AUTHENTICATED', 'INTERNAL'] as const) {
      expect(unavailableReasonFromProviderError({ code })).toBeNull()
    }
  })

  it('labels known and unknown reasons', () => {
    expect(unavailableTrackLabel('region')).toBe('Not available in your country')
    expect(unavailableTrackLabel('something-new')).toBe('Not available')
    expect(unavailableTrackLabel(null)).toBe('Not available')
  })
})
