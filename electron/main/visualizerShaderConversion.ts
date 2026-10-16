import { convertHLSLShader } from 'hlslparser-js'
import { prepareShader, processUnOptimizedShader } from 'milkdrop-preset-utils'

export async function convertVisualizerShader(shader: string): Promise<string> {
  if (!shader.trim()) return ''
  const entry = 'main_shader_sentinel'
  const source = prepareShader(shader).replace('float4 shader_body (', `float4 ${entry} (`)
  const converted = await convertHLSLShader(source, entry, 'fs')
  if (!converted || !converted.includes(entry)) throw new Error('Unable to convert this preset’s shader')
  return processUnOptimizedShader(converted)
}
