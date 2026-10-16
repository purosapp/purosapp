import { describe, expect, it } from 'vitest'
import { API_VERSION } from '../../../src/provider-api/v1'
import { assertProviderWireMessage, ProviderEventBudget, PROVIDER_MAX_MESSAGE_BYTES, PROVIDER_MAX_EVENTS_PER_SECOND } from './limits'

describe('provider process wire limits', () => {
  it('accepts a cloneable helper byte chunk on the host channel', () => {
    expect(() => assertProviderWireMessage({
      type: 'host.request', apiVersion: API_VERSION, requestId: 'req_1',
      namespace: 'helpers', method: 'write', args: [{ handleId: 'handle', data: new Uint8Array([1, 2, 3]) }],
    })).not.toThrow()
  })

  it('rejects undeclared host methods, malformed runtime calls, and cycles', () => {
    expect(() => assertProviderWireMessage({
      type: 'host.request', apiVersion: API_VERSION, requestId: 'req_2',
      namespace: 'helpers', method: 'exec', args: [],
    })).toThrow('Invalid provider host method')
    expect(() => assertProviderWireMessage({
      type: 'runtime.request', apiVersion: API_VERSION, requestId: 'req_3', providerId: 'sample',
      action: 'invoke', capability: 'playback.resolve', method: '../escape', args: [],
    })).toThrow('Invalid provider method')
    const cycle: Record<string, unknown> = { type: 'runtime.request', apiVersion: API_VERSION, requestId: 'req_4' }
    cycle.cycle = cycle
    expect(() => assertProviderWireMessage(cycle)).toThrow('cycles')
  })

  it('rejects a message above 8 MiB before dispatch', () => {
    expect(() => assertProviderWireMessage({
      type: 'host.request', apiVersion: API_VERSION, requestId: 'req_5',
      namespace: 'helpers', method: 'write', args: [{ handleId: 'handle', data: new Uint8Array(PROVIDER_MAX_MESSAGE_BYTES) }],
    })).toThrow('size limit')
  })

  it('bounds a rolling one-second event window', () => {
    const budget = new ProviderEventBudget()
    for (let index = 0; index < PROVIDER_MAX_EVENTS_PER_SECOND; index += 1) expect(budget.admit(1000)).toBe(true)
    expect(budget.admit(1000)).toBe(false)
    expect(budget.admit(2000)).toBe(true)
  })
})
