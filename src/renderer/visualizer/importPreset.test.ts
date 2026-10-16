import { describe, expect, it } from 'vitest'
import { importMilkPreset } from './importPreset'
import { convertVisualizerShader } from '../../../electron/main/visualizerShaderConversion'

const convert = async (shaders: { warp: string; comp: string }) => ({
  warp: await convertVisualizerShader(shaders.warp),
  comp: await convertVisualizerShader(shaders.comp),
})

describe('MilkDrop import', () => {
  it('keeps shader behavior by converting both HLSL stages to GLSL', async () => {
    const text = '[preset00]\nfDecay=0.96\nper_frame_1=zoom=1;\nwarp_1=`shader_body { ret = tex2D(sampler_main, uv).xyz * 0.75; }\ncomp_1=`shader_body { ret = float3(1.0, 0.5, 0.25); }'
    const preset = await importMilkPreset('Shader preset', text, convert)
    expect(preset.warp).toContain('texture(sampler_main')
    expect(preset.warp).toContain('0.750000')
    expect(preset.comp).toContain('vec3(1.000000, 0.500000, 0.250000)')
    expect(preset.baseVals.decay).toBe(0.96)
  })

  it('accepts shader-free presets and reports invalid files or equations', async () => {
    const preset = await importMilkPreset('Classic', '[preset00]\nfDecay=0.9', convert)
    expect(preset.warp).toBe('')
    expect(preset.comp).toBe('')
    await expect(importMilkPreset('Bad', 'not a preset', convert)).rejects.toThrow('preset00')
    await expect(importMilkPreset('Bad', '[preset00]\nper_frame_1=window.puros.app.quit();', convert)).rejects.toThrow()
  })

  it('propagates conversion errors instead of replacing the shader with a blank one', async () => {
    await expect(importMilkPreset('Broken', '[preset00]\nwarp_1=`bad shader', async () => {
      throw new Error('Shader conversion failed')
    })).rejects.toThrow('Shader conversion failed')
  })

  it('rejects malformed HLSL through the real converter', async () => {
    await expect(importMilkPreset('Broken', '[preset00]\ncomp_1=`shader_body { ret = ; }', convert)).rejects.toThrow()
  })
})
