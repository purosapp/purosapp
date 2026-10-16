import { describe, expect, it } from 'vitest'
import type { ProviderManifestV1, ProviderRuntimeV1 } from '../../../src/provider-api/v1'
import type { ProviderHostController } from './ProviderHost'
import { ProviderRegistry, resolveProviderCallTimeoutMs } from './registry'

const manifest: ProviderManifestV1 = {
  schemaVersion: 1,
  apiVersion: 1,
  id: 'fixture',
  version: '1.0.0',
  displayName: 'Fixture',
  icon: 'assets/icon.svg',
  brandColor: '#123456',
  defaultPriority: 10,
  capabilities: ['auth', 'playback.resolve', 'playback.prefetch'],
}

describe('provider call timeouts', () => {
  it('keeps existing deadlines without an override', () => {
    expect(resolveProviderCallTimeoutMs(manifest, 'playback.resolve', 'resolve')).toBe(120_000)
    expect(resolveProviderCallTimeoutMs(manifest, 'auth', 'login')).toBe(300_000)
    expect(resolveProviderCallTimeoutMs(manifest, 'auth', 'logout')).toBe(30_000)
  })

  it('applies a declared playback deadline only to playback calls', () => {
    const extended = { ...manifest, playbackTimeoutMs: 1_800_000 }
    expect(resolveProviderCallTimeoutMs(extended, 'playback.resolve', 'resolve')).toBe(1_800_000)
    expect(resolveProviderCallTimeoutMs(extended, 'playback.prefetch', 'prefetch')).toBe(1_800_000)
    expect(resolveProviderCallTimeoutMs(extended, 'auth', 'login')).toBe(300_000)
    expect(resolveProviderCallTimeoutMs(extended, 'playback.resolve', 'resolve', 42_000)).toBe(42_000)
  })
})

describe('provider playback session cancellation', () => {
  function readyRegistry(cancelSession?: ProviderRuntimeV1['cancelSession'], capabilities = manifest.capabilities): ProviderRegistry {
    const registry = new ProviderRegistry()
    registry.addManifest({ ...manifest, capabilities })
    registry.setRuntime('fixture', {
      capabilities: {},
      getStatus: async () => ({ state: 'ready', updatedAt: 1 }),
      ...(cancelSession ? { cancelSession } : {}),
      deactivate: async () => {},
    }, { cacheRoot: '/fixture-cache' } as ProviderHostController)
    registry.updateStatus('fixture', { state: 'ready', updatedAt: 1 })
    return registry
  }

  it('routes a valid handle to the active provider runtime', async () => {
    const registry = readyRegistry(async (sessionId) => sessionId === 'session-123')
    expect(await registry.cancelSession('fixture', 'session-123')).toEqual({ ok: true, value: true })
    expect(await registry.cancelSession('fixture', 'session-456')).toEqual({ ok: true, value: false })
  })

  it('rejects malformed handles and reports unsupported cancellation safely', async () => {
    const registry = readyRegistry()
    const invalid = await registry.cancelSession('fixture', '../escape')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_ARGUMENT')
    expect(await registry.cancelSession('fixture', 'session-123')).toEqual({ ok: true, value: false })
    const nonPlayback = await readyRegistry(async () => true, ['auth']).cancelSession('fixture', 'session-123')
    expect(nonPlayback.ok).toBe(false)
    if (!nonPlayback.ok) expect(nonPlayback.error.code).toBe('NOT_SUPPORTED')
  })
})
