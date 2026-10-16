import { Worker } from 'node:worker_threads'

type Shaders = { warp: string; comp: string }
let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve: (value: Shaders) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

function stopWorker(error: Error): void {
  const previous = worker
  worker = null
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error) }
  pending.clear()
  void previous?.terminate()
}

export function convertVisualizerShaders(input: unknown): Promise<Shaders> {
  const shaders = input as Shaders | null
  if (!shaders || typeof shaders.warp !== 'string' || typeof shaders.comp !== 'string' ||
      shaders.warp.length > 262144 || shaders.comp.length > 262144) {
    return Promise.reject(new Error('Invalid shader data or shader exceeds 256 KB'))
  }
  if (!shaders.warp.trim() && !shaders.comp.trim()) return Promise.resolve({ warp: '', comp: '' })
  if (pending.size >= 16) return Promise.reject(new Error('Too many pending preset imports. Try again after the current import.'))
  if (!worker) {
    // Separate Electron entry, emitted beside main.js (not a browser worker).
    const workerUrl = new URL(/* @vite-ignore */ './visualizer-converter.js', import.meta.url)
    const current = new Worker(workerUrl)
    worker = current
    current.unref()
    current.on('message', (message: { id: number; result?: Shaders; error?: string }) => {
      if (worker !== current) return
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id)
      clearTimeout(task.timer)
      if (message.result) task.resolve(message.result)
      else task.reject(new Error(message.error || 'Shader conversion failed'))
    })
    current.on('error', error => { if (worker === current) stopWorker(error) })
    current.on('exit', () => { if (worker === current) stopWorker(new Error('Shader converter stopped')) })
  }
  return new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => stopWorker(new Error('Shader conversion timed out')), 15000)
    pending.set(id, { resolve, reject, timer })
    worker!.postMessage({ id, warp: shaders.warp, comp: shaders.comp })
  })
}
