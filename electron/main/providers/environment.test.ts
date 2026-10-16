import { describe, expect, it } from 'vitest'
import type { ProviderManifestV1 } from '../../../src/provider-api/v1'
import { providerHelperEnvironment, providerProcessEnvironment } from './environment'

const manifest = {
  schemaVersion: 1, apiVersion: 1, id: 'sample', version: '1', displayName: 'Sample',
  icon: 'icon.svg', brandColor: '#000000', defaultPriority: 1, capabilities: [],
  permissions: { runtimeEnvironment: ['SAMPLE_CLIENT_ID', 'SAMPLE_CLIENT_SECRET'] },
} satisfies ProviderManifestV1

describe('provider process environment', () => {
  it('passes only declared provider-prefixed values', () => {
    expect(providerProcessEnvironment(manifest, {
      SAMPLE_CLIENT_ID: 'public-id', SAMPLE_CLIENT_SECRET: 'secret', OTHER_TOKEN: 'must-not-leak',
    } as unknown as NodeJS.ProcessEnv)).toEqual({ SAMPLE_CLIENT_ID: 'public-id', SAMPLE_CLIENT_SECRET: 'secret' })
  })

  it('rejects an environment declaration outside its namespace', () => {
    const invalid = { ...manifest, permissions: { runtimeEnvironment: ['OTHER_TOKEN'] } }
    expect(() => providerProcessEnvironment(invalid, {} as NodeJS.ProcessEnv)).toThrow('outside its namespace')
  })

  it('gives helpers only a private home/temp and fixed system path', () => {
    expect(providerHelperEnvironment('/private/provider-data')).toEqual({
      HOME: '/private/provider-data', TMPDIR: '/private/provider-data',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
    })
  })
})
