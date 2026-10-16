import { parentPort } from 'node:worker_threads'
import { convertVisualizerShader } from './main/visualizerShaderConversion'

// The compiler has shared internal memory; keep jobs strictly sequential.
let queue = Promise.resolve()
parentPort?.on('message', (job: { id: number; warp: string; comp: string }) => {
  queue = queue.then(async () => {
    try {
      const warp = await convertVisualizerShader(job.warp)
      const comp = await convertVisualizerShader(job.comp)
      parentPort?.postMessage({ id: job.id, result: { warp, comp } })
    } catch (error) {
      parentPort?.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
})
