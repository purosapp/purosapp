import { splitPreset } from 'milkdrop-preset-utils'
import { preparePreset } from './presets'

type Shaders = { warp: string; comp: string }

export async function importMilkPreset(name: string, text: string, convertShaders: (source: Shaders) => Promise<Shaders>) {
  if (!/\[preset00\]/i.test(text)) throw new Error('Missing [preset00] section')
  const parts = splitPreset(text)
  const preset = {
    name,
    baseVals: parts.baseVals ?? {},
    init_eqs_str: parts.presetInit ?? '',
    frame_eqs_str: parts.perFrame ?? '',
    pixel_eqs_str: parts.perVertex ?? '',
    shapes: parts.shapes ?? [],
    waves: parts.waves ?? [],
    warp: '', comp: '',
  }
  // Reject unsupported equations before spending time compiling shaders.
  preparePreset(preset)
  const shaders = await convertShaders({ warp: parts.warp ?? '', comp: parts.comp ?? '' })
  return { ...preset, ...shaders }
}
