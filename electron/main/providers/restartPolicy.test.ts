import { describe, expect, it } from 'vitest'
import { ProviderRestartPolicy, PROVIDER_RESTART_WINDOW_MS } from './restartPolicy'

describe('provider utility-process restart policy', () => {
  it('backs off and stops after three restarts in five minutes', () => {
    const policy = new ProviderRestartPolicy()
    expect(policy.recordFailure(0)).toEqual({ restart: true, delayMs: 0 })
    expect(policy.recordFailure(100)).toEqual({ restart: true, delayMs: 1000 })
    expect(policy.recordFailure(200)).toEqual({ restart: true, delayMs: 5000 })
    expect(policy.recordFailure(300)).toEqual({ restart: false, delayMs: 0 })
    expect(policy.recordFailure(PROVIDER_RESTART_WINDOW_MS + 301)).toEqual({ restart: true, delayMs: 0 })
  })

  it('resets after an explicit clean shutdown', () => {
    const policy = new ProviderRestartPolicy()
    policy.recordFailure(0)
    policy.recordFailure(1)
    policy.reset()
    expect(policy.recordFailure(2)).toEqual({ restart: true, delayMs: 0 })
  })
})
