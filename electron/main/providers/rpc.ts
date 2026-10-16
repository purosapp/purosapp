import {
  API_VERSION,
  ProviderApiError,
  providerError,
  type ProviderHostRequestV1,
  type ProviderRpcResponseV1,
  type ProviderRuntimeEventV1,
  type ProviderRuntimeRequestV1,
  type ProviderWireValueV1,
} from '../../../src/provider-api/v1'
import { assertProviderWireMessage, ProviderEventBudget } from './limits'
import { toProviderError } from './validation'

export interface ProviderRpcPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  off(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  off(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

type RpcRequest = ProviderRuntimeRequestV1 | ProviderHostRequestV1

/**
 * An ordinary thrown error keeps its message across the port (AUTHORING: "throw
 * ordinary errors; the host normalizes them"), so callers can log the real cause
 * and recognize e.g. "not found". Typed `ProviderApiError`s pass unchanged.
 */
export function untypedProviderError(error: unknown) {
  const message = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 2_000) : null
  if (error instanceof Error && error.name === 'AbortError') {
    return providerError('CANCELLED', message ?? 'Provider operation was cancelled', { retryable: true })
  }
  if (message && /timed out/i.test(message)) return providerError('TIMEOUT', message, { retryable: true })
  return providerError('INTERNAL', message ?? 'Provider RPC request failed', { retryable: false })
}
type RpcHandler = (request: RpcRequest) => Promise<ProviderWireValueV1 | undefined>

interface PendingCall {
  resolve: (value: ProviderWireValueV1 | undefined) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** Symmetric, bounded MessagePort RPC. The caller owns process termination on protocol violation. */
export class ProviderRpcPeer {
  private readonly pending = new Map<string, PendingCall>()
  private readonly eventBudget = new ProviderEventBudget()
  private closed = false

  constructor(
    private readonly port: ProviderRpcPort,
    private readonly incomingType: RpcRequest['type'],
    private readonly onRequest: RpcHandler,
    private readonly onEvent: (event: ProviderRuntimeEventV1) => void,
    private readonly onViolation: (error: Error) => void,
    private readonly onRemoteClose: () => void = () => {},
  ) {
    port.on('message', this.handleMessage)
    port.on('close', this.handleClose)
    port.start()
  }

  request(message: RpcRequest, timeoutMs: number): Promise<ProviderWireValueV1 | undefined> {
    if (this.closed) return Promise.reject(this.unavailableError())
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
      return Promise.reject(new RangeError('Invalid provider RPC timeout'))
    }
    assertProviderWireMessage(message)
    if (message.type === this.incomingType) return Promise.reject(new TypeError('Provider RPC request sent in the wrong direction'))
    if (this.pending.has(message.requestId)) return Promise.reject(new TypeError('Duplicate provider RPC request ID'))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(message.requestId)
        reject(new ProviderApiError(providerError('TIMEOUT', 'Provider RPC call timed out', { retryable: true })))
      }, timeoutMs)
      this.pending.set(message.requestId, { resolve, reject, timeout })
      try {
        this.port.postMessage(message)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(message.requestId)
        reject(error instanceof Error ? error : this.unavailableError())
      }
    })
  }

  notify(message: ProviderRuntimeEventV1): void {
    if (this.closed) throw this.unavailableError()
    assertProviderWireMessage(message)
    this.port.postMessage(message)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.port.off('message', this.handleMessage)
    this.port.off('close', this.handleClose)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(this.unavailableError())
    }
    this.pending.clear()
    this.port.close()
  }

  private readonly handleClose = (): void => {
    this.close()
    this.onRemoteClose()
  }

  private readonly handleMessage = (event: { data: unknown }): void => {
    if (this.closed) return
    let message: RpcRequest | ProviderRpcResponseV1 | ProviderRuntimeEventV1
    try {
      assertProviderWireMessage(event.data)
      message = event.data
    } catch (error) {
      this.violate(error)
      return
    }
    if (message.type === 'rpc.response') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return // A timed-out response is stale, not a protocol failure.
      this.pending.delete(message.requestId)
      clearTimeout(pending.timeout)
      if (message.result.ok) pending.resolve(message.result.value)
      else pending.reject(new ProviderApiError(message.result.error))
      return
    }
    if (message.type === 'provider.event') {
      if (!this.eventBudget.admit()) {
        this.violate(new Error('Provider event rate exceeded'))
        return
      }
      try { this.onEvent(message) } catch (error) { this.violate(error) }
      return
    }
    if (message.type !== this.incomingType) {
      this.violate(new Error('Provider RPC request arrived in the wrong direction'))
      return
    }
    void this.respond(message)
  }

  private async respond(request: RpcRequest): Promise<void> {
    let response: ProviderRpcResponseV1
    try {
      const value = await this.onRequest(request)
      response = {
        type: 'rpc.response', apiVersion: API_VERSION, requestId: request.requestId,
        result: { ok: true, value },
      }
    } catch (error) {
      const providerErrorValue = toProviderError(error) ?? untypedProviderError(error)
      response = {
        type: 'rpc.response', apiVersion: API_VERSION, requestId: request.requestId,
        result: { ok: false, error: providerErrorValue },
      }
    }
    if (this.closed) return
    try {
      assertProviderWireMessage(response)
      this.port.postMessage(response)
    } catch (error) {
      this.violate(error)
    }
  }

  private violate(error: unknown): void {
    const normalized = error instanceof Error ? error : new TypeError('Invalid provider RPC payload')
    this.close()
    this.onViolation(normalized)
  }

  private unavailableError(): ProviderApiError {
    return new ProviderApiError(providerError('PROVIDER_CRASHED', 'Provider RPC channel closed', { retryable: true }))
  }
}
