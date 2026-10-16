import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderEventV1 } from '../../../src/provider-api/v1'
import { ProviderEventCoalescer } from './eventCoalescer'

function progress(percent: number): ProviderEventV1 {
  return {
    type: 'playback.progress',
    progress: { sessionId: 'session', sourceId: 'track', state: 'running', percent, playbackStarted: false, revision: percent },
  }
}

afterEach(() => vi.useRealTimers())

describe('provider progress coalescing', () => {
  it('emits the newest sample at a bounded rate', () => {
    vi.useFakeTimers()
    const sent: ProviderEventV1[] = []
    const coalescer = new ProviderEventCoalescer((event) => sent.push(event))
    for (let index = 0; index < 100; index += 1) coalescer.publish(progress(index))
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(sent).toEqual([progress(99)])
    coalescer.dispose()
  })

  it('flushes progress before a terminal session and cancels pending timers on dispose', () => {
    vi.useFakeTimers()
    const sent: ProviderEventV1[] = []
    const coalescer = new ProviderEventCoalescer((event) => sent.push(event))
    coalescer.publish(progress(90))
    const completed: ProviderEventV1 = {
      type: 'playback.session',
      session: { sessionId: 'session', sourceId: 'track', state: 'completed', playbackStarted: true, revision: 91 },
    }
    coalescer.publish(completed)
    expect(sent).toEqual([progress(90), completed])
    coalescer.publish(progress(92))
    coalescer.dispose()
    vi.runAllTimers()
    expect(sent).toHaveLength(2)
  })
})
