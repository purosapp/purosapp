import { MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_VERSION,
  ProviderApiError,
  providerError,
  type ProviderCapabilityImplementationsV1,
  type ProviderCapabilityV1,
  type ProviderManifestV1,
  type ProviderRuntimeV1,
  type ProviderStatusV1,
  type ProviderValueV1,
  type ProviderWireValueV1,
  type ProviderHostRequestV1,
} from '../../../src/provider-api/v1'
import { createProviderHost, type ProviderHostController } from './ProviderHost'
import { providerProcessEnvironment } from './environment'
import { validateProviderProcessEvent } from './eventValidation'
import { ProviderRestartPolicy } from './restartPolicy'
import { ProviderRpcPeer } from './rpc'
import { resolveProviderCallTimeoutMs, type ProviderRegistry } from './registry'
import { assertProviderValue, toProviderError } from './validation'

interface ProcessConnection {
  child: UtilityProcess
  peer: ProviderRpcPeer
  host: ProviderHostController
  lastSequence: number
}

function processFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error('Provider utility process failed')
}

/** Stable main-process proxy: capability methods never expose the utility process or host handles. */
export class ProviderProcessManager implements ProviderRuntimeV1 {
  readonly capabilities: ProviderCapabilityImplementationsV1
  private readonly restarts = new ProviderRestartPolicy()
  private connection: ProcessConnection | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = false
  private starting = false

  constructor(
    private readonly manifest: ProviderManifestV1,
    private readonly providerRoot: string,
    private readonly registry: ProviderRegistry,
    /** Installed packages: absolute compiled entry; bundled providers load from the generated worker registry. */
    private readonly entryPath?: string,
  ) {
    const capabilities: Record<string, Record<string, (...args: ProviderValueV1[]) => Promise<unknown>>> = {}
    for (const capability of manifest.capabilities) {
      capabilities[capability] = new Proxy({}, {
        get: (_target, property) => typeof property === 'string'
          ? (...args: ProviderValueV1[]) => this.invoke(capability, property, args)
          : undefined,
      })
    }
    this.capabilities = capabilities as unknown as ProviderCapabilityImplementationsV1
  }

  async start(): Promise<void> {
    this.stopping = false
    await this.startAttempt()
  }

  async getStatus(): Promise<ProviderStatusV1> {
    return await this.call({
      type: 'runtime.request', apiVersion: API_VERSION, requestId: randomUUID(),
      providerId: this.manifest.id, action: 'getStatus',
    }, 5_000) as unknown as ProviderStatusV1
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    return await this.call({
      type: 'runtime.request', apiVersion: API_VERSION, requestId: randomUUID(),
      providerId: this.manifest.id, action: 'cancelSession', sessionId,
    }, 5_000) as boolean
  }

  async deactivate(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const connection = this.connection
    this.connection = null
    if (!connection) return
    try {
      await connection.peer.request({
        type: 'runtime.request', apiVersion: API_VERSION, requestId: randomUUID(),
        providerId: this.manifest.id, action: 'deactivate',
      }, 5_000)
    } catch {
      // Teardown continues even if the worker already exited or hung.
    } finally {
      connection.peer.close()
      connection.child.kill()
      await connection.host.dispose()
    }
  }

  private async invoke(capability: ProviderCapabilityV1, method: string, args: ProviderValueV1[]): Promise<ProviderValueV1 | undefined> {
    const timeoutMs = resolveProviderCallTimeoutMs(this.manifest, capability, method)
    return await this.call({
      type: 'runtime.request', apiVersion: API_VERSION, requestId: randomUUID(),
      providerId: this.manifest.id, action: 'invoke', capability, method, args,
    }, timeoutMs) as ProviderValueV1 | undefined
  }

  private async call(message: Parameters<ProviderRpcPeer['request']>[0], timeoutMs: number): Promise<ProviderWireValueV1 | undefined> {
    const connection = this.connection
    if (!connection || this.stopping) {
      throw new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', 'Provider process is not ready', { retryable: true }))
    }
    try {
      return await connection.peer.request(message, timeoutMs)
    } catch (error) {
      if (toProviderError(error)?.code === 'TIMEOUT') {
        void this.failConnection(connection, error)
      }
      throw error
    }
  }

  private async startAttempt(): Promise<void> {
    if (this.stopping || this.starting || this.connection) return
    this.starting = true
    this.registry.setActivating(this.manifest.id)
    let host: ProviderHostController | null = null
    let child: UtilityProcess | null = null
    let connection: ProcessConnection | null = null
    try {
      host = createProviderHost(this.manifest, this.providerRoot, (envelope) => this.registry.receiveEvent(envelope))
      child = utilityProcess.fork(path.join(path.dirname(fileURLToPath(import.meta.url)), 'provider-runtime.js'), [], {
        cwd: host.dataRoot,
        env: providerProcessEnvironment(this.manifest),
        serviceName: `puros-provider-${this.manifest.id}`,
      })
      const { port1, port2 } = new MessageChannelMain()
      connection = {
        child,
        host,
        lastSequence: 0,
        peer: null as unknown as ProviderRpcPeer,
      }
      const current = connection
      current.peer = new ProviderRpcPeer(
        port1,
        'host.request',
        async (request) => this.dispatchHostRequest(current, request as ProviderHostRequestV1),
        (message) => {
          const envelope = message.envelope
          if (envelope.providerId !== this.manifest.id || envelope.sequence <= current.lastSequence) {
            throw new Error('Invalid provider event identity or sequence')
          }
          current.lastSequence = envelope.sequence
          this.registry.receiveEvent(validateProviderProcessEvent(envelope, current.host.cacheRoot))
        },
        (error) => { void this.failConnection(current, error) },
        () => { void this.failConnection(current, new Error('Provider MessagePort closed')) },
      )
      this.connection = current
      // Keep the manager reachable by registry.deactivateAll() even if activation fails
      // and a restart is pending; the status remains 'activating' until the reply.
      this.registry.setRuntime(this.manifest.id, this, host)
      child.on('exit', (code) => { void this.failConnection(current, new Error(`Provider process exited (${code})`)) })
      child.on('error', (error) => { void this.failConnection(current, error) })
      child.postMessage({
        apiVersion: API_VERSION,
        providerId: this.manifest.id,
        manifest: this.manifest,
        ...(this.entryPath ? { entry: this.entryPath } : {}),
      }, [port2])
      const status = await current.peer.request({
        type: 'runtime.request', apiVersion: API_VERSION, requestId: randomUUID(),
        providerId: this.manifest.id, action: 'activate',
      }, 15_000) as unknown as ProviderStatusV1
      assertProviderValue(status)
      if (this.connection !== current || this.stopping) throw new Error('Provider process exited during activation')
      this.registry.updateStatus(this.manifest.id, status)
    } catch (error) {
      if (connection) await this.failConnection(connection, error)
      else {
        child?.kill()
        await host?.dispose()
        this.registry.markError(this.manifest.id, error)
        // Host creation/spawn failed before a process existed; there is no live
        // transport to recover, and the registry cannot own a restart timer.
      }
      throw error
    } finally {
      this.starting = false
    }
  }

  private async dispatchHostRequest(connection: ProcessConnection, request: ProviderHostRequestV1): Promise<ProviderWireValueV1 | undefined> {
    if (connection !== this.connection || this.stopping) {
      throw new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', 'Provider host was closed', { retryable: true }))
    }
    const host = connection.host.host
    const scope: unknown = request.namespace === 'host' ? host : host[request.namespace]
    if (!scope || typeof scope !== 'object' || !Object.prototype.hasOwnProperty.call(scope, request.method)) {
      throw new ProviderApiError(providerError('NOT_SUPPORTED', 'Provider host method is unavailable', { retryable: false }))
    }
    const method = (scope as Record<string, unknown>)[request.method]
    if (typeof method !== 'function') throw new TypeError('Provider host method is invalid')
    const result = await method.apply(scope, request.args) as unknown
    assertProviderValue(result, { allowUndefined: true, allowUint8Array: true })
    return result as ProviderWireValueV1 | undefined
  }

  private async failConnection(connection: ProcessConnection, error: unknown): Promise<void> {
    if (this.connection !== connection) return
    this.connection = null
    connection.peer.close()
    connection.child.kill()
    await connection.host.dispose().catch((cleanupError) => {
      console.warn(`[Puros][Provider:${this.manifest.id}] host cleanup failed:`, cleanupError)
    })
    if (this.stopping) return
    this.registry.markError(this.manifest.id, processFailure(error))
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return
    const decision = this.restarts.recordFailure()
    if (!decision.restart) {
      console.warn(`[Puros][Provider:${this.manifest.id}] restart budget exhausted`)
      return
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.startAttempt().catch((error) => {
        console.warn(`[Puros][Provider:${this.manifest.id}] restart failed:`, error)
      })
    }, decision.delayMs)
  }
}
