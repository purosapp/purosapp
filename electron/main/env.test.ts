import { describe, expect, it } from 'vitest'
import { shouldImportMainProcessEnvKey } from './env'

describe('development main-process dotenv selection', () => {
  it('imports a selected provider prefix with its existing key spelling', () => {
    expect(shouldImportMainProcessEnvKey('TIDAL_CLIENT_ID', ['tidal'])).toBe(true)
    expect(shouldImportMainProcessEnvKey('TIDAL_AUDIO_QUALITY', ['tidal'])).toBe(true)
    expect(shouldImportMainProcessEnvKey('SERVICE_A_TOKEN', ['service-a'])).toBe(true)
  })

  it('does not import credentials for an absent provider', () => {
    expect(shouldImportMainProcessEnvKey('TIDAL_CLIENT_SECRET', [])).toBe(false)
    expect(shouldImportMainProcessEnvKey('SERVICE_A_TOKEN', ['other-service'])).toBe(false)
    expect(shouldImportMainProcessEnvKey('UNRELATED_SECRET', ['tidal'])).toBe(false)
  })

  it('keeps core keys while importing provider keys only when selected', () => {
    expect(shouldImportMainProcessEnvKey('LASTFM_API_KEY', [])).toBe(true)
    expect(shouldImportMainProcessEnvKey('LASTFM_API_SECRET', [])).toBe(true)
    expect(shouldImportMainProcessEnvKey('DISCORD_CLIENT_ID', [])).toBe(true)
    expect(shouldImportMainProcessEnvKey('APPLE_WEB_PLAYER_TOKEN', [])).toBe(false)
    expect(shouldImportMainProcessEnvKey('APPLE_WEB_PLAYER_TOKEN', ['apple'])).toBe(true)
    expect(shouldImportMainProcessEnvKey('VITE_APPLE_MUSIC_DEVELOPER_TOKEN', ['apple'])).toBe(false)
  })
})
