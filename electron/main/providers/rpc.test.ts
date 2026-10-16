import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { API_VERSION, ProviderApiError, type ProviderRuntimeRequestV1 } from '../../../src/provider-api/v1'
import { PROVIDER_MAX_EVENTS_PER_SECOND } from './limits'
import { ProviderRpcPeer, untypedProviderError } from './rpc'

class TestPort extends EventEmitter {
  peer?: TestPort
  closed = false

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('Port closed')
    queueMicrotask(() => { if (!this.peer?.closed) this.peer?.emit('message', { data: structuredClone(message) }) })
  }

  start(): void {}

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.emit('close')
  }
}

function ports(): [TestPort, TestPort] {
  const left = new TestPort()
  const right = new TestPort()
  left.peer = right
  right.peer = left
  return [left, right]
}

function request(requestId: string): ProviderRuntimeRequestV1 {
  return {
    type: 'runtime.request', apiVersion: API_VERSION, requestId, providerId: 'sample',
    action: 'getStatus',
  }
}

describe('provider MessagePort RPC', () => {
  it('correlates concurrent responses and preserves clone-safe byte chunks', async () => {
    const [mainPort, workerPort] = ports()
    const main = new ProviderRpcPeer(mainPort, 'host.request', async () => undefined, () => {}, () => {})
    const worker = new ProviderRpcPeer(workerPort, 'runtime.request', async (message) => {
      if (message.requestId === 'slow') await new Promise((resolve) => setTimeout(resolve, 10))
      return { requestId: message.requestId, bytes: new Uint8Array([1, 2, 3]) }
    }, () => {}, () => {})
    const [slow, fast] = await Promise.all([main.request(request('slow'), 100), main.request(request('fast'), 100)])
    expect(slow).toEqual({ requestId: 'slow', bytes: new Uint8Array([1, 2, 3]) })
    expect(fast).toEqual({ requestId: 'fast', bytes: new Uint8Array([1, 2, 3]) })
    main.close()
    worker.close()
  })

  it('times out a hung request and rejects outstanding work on close', async () => {
    const [mainPort] = ports()
    const main = new ProviderRpcPeer(mainPort, 'host.request', async () => undefined, () => {}, () => {})
    const timedOut = main.request(request('hung'), 5)
    await expect(timedOut).rejects.toMatchObject({ providerError: { code: 'TIMEOUT' } })
    const pending = main.request(request('pending'), 1000)
    main.close()
    await expect(pending).rejects.toMatchObject({ providerError: { code: 'PROVIDER_CRASHED' } })
  })

  it('does not send requests on a port assigned to receive that direction', async () => {
    const [mainPort] = ports()
    const main = new ProviderRpcPeer(mainPort, 'runtime.request', async () => undefined, () => {}, () => {})
    await expect(main.request(request('wrong'), 100)).rejects.toThrow('wrong direction')
    main.close()
  })

  it('turns a typed handler failure into a typed response', async () => {
    const [mainPort, workerPort] = ports()
    const main = new ProviderRpcPeer(mainPort, 'host.request', async () => undefined, () => {}, () => {})
    const worker = new ProviderRpcPeer(workerPort, 'runtime.request', async () => {
      throw new ProviderApiError({ code: 'NOT_AUTHENTICATED', message: 'Login required', retryable: false })
    }, () => {}, () => {})
    await expect(main.request(request('auth'), 100)).rejects.toMatchObject({ providerError: { code: 'NOT_AUTHENTICATED' } })
    main.close()
    worker.close()
  })

  it('keeps the message of an ordinary thrown error', async () => {
    const [mainPort, workerPort] = ports()
    const main = new ProviderRpcPeer(mainPort, 'host.request', async () => undefined, () => {}, () => {})
    const worker = new ProviderRpcPeer(workerPort, 'runtime.request', async () => {
      throw new Error('Artist 30993256 not found')
    }, () => {}, () => {})
    await expect(main.request(request('artist'), 100)).rejects.toMatchObject({
      providerError: { code: 'INTERNAL', message: 'Artist 30993256 not found', retryable: false },
    })
    expect(untypedProviderError(new Error('bridge timed out after 30000ms'))).toMatchObject({ code: 'TIMEOUT', retryable: true })
    expect(untypedProviderError(Object.assign(new Error('stop'), { name: 'AbortError' }))).toMatchObject({ code: 'CANCELLED' })
    expect(untypedProviderError('not an error')).toMatchObject({ code: 'INTERNAL', message: 'Provider RPC request failed' })
    main.close()
    worker.close()
  })

  it('closes on malformed payloads and an event flood', async () => {
    const [mainPort, workerPort] = ports()
    const violation = vi.fn()
    new ProviderRpcPeer(mainPort, 'host.request', async () => undefined, () => {}, violation)
    workerPort.postMessage({ type: 'host.request', apiVersion: API_VERSION, requestId: 'bad', namespace: 'helpers', method: 'exec', args: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(violation).toHaveBeenCalledOnce()
    expect(mainPort.closed).toBe(true)

    const [nextMainPort, nextWorkerPort] = ports()
    const eventViolation = vi.fn()
    const nextMain = new ProviderRpcPeer(nextMainPort, 'host.request', async () => undefined, () => {}, eventViolation)
    for (let index = 0; index <= PROVIDER_MAX_EVENTS_PER_SECOND; index += 1) {
      nextWorkerPort.postMessage({
        type: 'provider.event', apiVersion: API_VERSION,
        envelope: { apiVersion: API_VERSION, providerId: 'sample', sequence: index, event: { type: 'warning', code: 'fixture', message: 'test' } },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(eventViolation).toHaveBeenCalledOnce()
    expect(nextMainPort.closed).toBe(true)
    nextMain.close()
  })
})
