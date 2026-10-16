import { describe, expect, it } from 'vitest'
import { HelperOutputQueue } from './helperOutput'

describe('private helper output queue', () => {
  it('keeps ordered output and exit on the provider side', async () => {
    const queue = new HelperOutputQueue()
    const secret = new TextEncoder().encode('{"session":"private"}\n')
    expect(queue.push({ type: 'stdout', data: secret })).toBe(true)
    expect(queue.push({ type: 'exit', exitCode: 0, signal: null })).toBe(true)
    expect(await queue.read()).toEqual({ type: 'stdout', data: secret })
    expect(await queue.read()).toEqual({ type: 'exit', exitCode: 0, signal: null })
    await expect(queue.read()).rejects.toThrow('closed')
  })

  it('rejects simultaneous reads and oversized buffered output', async () => {
    const queue = new HelperOutputQueue()
    const first = queue.read()
    await expect(queue.read()).rejects.toThrow('Concurrent')
    queue.push({ type: 'stderr', data: new TextEncoder().encode('warning') })
    expect((await first).type).toBe('stderr')
    expect(queue.push({ type: 'stdout', data: new Uint8Array(8 * 1024 * 1024 + 1) })).toBe(false)
    queue.fail('output limit')
    expect(await queue.read()).toEqual({ type: 'error', message: 'output limit' })
  })
})
