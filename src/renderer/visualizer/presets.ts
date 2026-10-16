import { compileEquation } from './equations'

type PresetData = Record<string, unknown>

function object(value: unknown): PresetData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid visualizer preset')
  return value as PresetData
}

/** Butterchurn skips its new Function branch when init_eqs is supplied.
 * Compile every child too; the library mutates child arrays during loading. */
export function preparePreset(value: unknown): PresetData {
  const preset = object(value)
  const eq = (key: string, data = preset) => {
    const source = data[key]
    if (source !== undefined && typeof source !== 'string') throw new Error(`Invalid equation: ${key}`)
    return compileEquation(source ?? '')
  }
  const children = (key: 'shapes' | 'waves') => {
    const source = Array.isArray(preset[key]) ? preset[key] as unknown[] : []
    return Array.from({ length: 4 }, (_, index) => {
      const child = source[index] === undefined ? {} : object(source[index])
      const baseVals = child.baseVals === undefined ? {} : object(child.baseVals)
      const enabled = Number(baseVals.enabled ?? 0) !== 0
      return {
        ...child,
        baseVals: { ...baseVals },
        init_eqs: enabled ? eq('init_eqs_str', child) : compileEquation(''),
        frame_eqs: enabled ? eq('frame_eqs_str', child) : compileEquation(''),
        ...(key === 'waves' ? { point_eqs: enabled && child.point_eqs_str ? eq('point_eqs_str', child) : '' } : {}),
      }
    })
  }
  return {
    ...preset,
    baseVals: { ...object(preset.baseVals ?? {}) },
    init_eqs: eq('init_eqs_str'),
    frame_eqs: eq('frame_eqs_str'),
    pixel_eqs: preset.pixel_eqs_str ? eq('pixel_eqs_str') : '',
    shapes: children('shapes'),
    waves: children('waves'),
    warp: typeof preset.warp === 'string' ? preset.warp : '',
    comp: typeof preset.comp === 'string' ? preset.comp : '',
  }
}
