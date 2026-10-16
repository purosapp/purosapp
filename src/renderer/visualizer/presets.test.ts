import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import presetsRaw from 'butterchurn-presets'
import { splitPreset } from 'milkdrop-preset-utils'
import { compileEquation, type Equation, type EquationState } from './equations'
import { preparePreset } from './presets'

const presets = (presetsRaw.default ?? presetsRaw).getPresets()

beforeAll(async () => {
  // Install the real Butterchurn math helpers for the native-JS reference.
  vi.stubGlobal('window', globalThis)
  await import('butterchurn')
})
afterAll(() => vi.unstubAllGlobals())

describe('CSP-compatible visualizer presets', () => {
  it('prepares all 100 built-in presets when dynamic JS compilation is blocked', () => {
    const blocked = vi.fn(() => { throw new EvalError('CSP blocks new Function') })
    vi.stubGlobal('Function', blocked)
    try {
      expect(Object.keys(presets)).toHaveLength(100)
      for (const preset of Object.values(presets)) {
        const prepared = preparePreset(preset)
        expect(prepared.init_eqs).toBeTypeOf('function')
        expect(prepared.frame_eqs).toBeTypeOf('function')
        for (const child of [...prepared.shapes as Record<string, unknown>[], ...prepared.waves as Record<string, unknown>[]]) {
          expect(child.init_eqs).toBeTypeOf('function')
          expect(child.frame_eqs).toBeTypeOf('function')
        }
      }
      expect(blocked).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals(); vi.stubGlobal('window', globalThis) }
  })

  it('matches Butterchurn JS execution for every built-in equation', () => {
    let seed = 42
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    })
    try {
      for (const [name, value] of Object.entries(presets)) {
        const preset = value as Record<string, unknown>
        const objects = [preset, ...preset.shapes as Record<string, unknown>[], ...preset.waves as Record<string, unknown>[]]
        for (const data of objects) {
          const bufferSize = JSON.stringify(data).includes('megabuf') ? 1048576 : 16
          const state: EquationState = {
            ...data.baseVals as Record<string, number>, time: 1.5, frame: 45, fps: 30,
            bass: 1.1, bass_att: 1.2, mid: 0.8, mid_att: 0.9, treb: 0.5, treb_att: 0.7,
            sample: 0.25, value1: 0.1, value2: 0.2, x: 0.3, y: 0.7, rad: 0.4, ang: 0.5,
            megabuf: new Array(bufferSize).fill(0), gmegabuf: new Array(bufferSize).fill(0),
          }
          const keys = ['init_eqs_str', 'frame_eqs_str', 'pixel_eqs_str', 'point_eqs_str']
          for (const key of keys) {
            const source = data[key] as string | undefined
            for (const match of (source ?? '').matchAll(/\ba\.(\w+)/g)) state[match[1]] ??= 0
          }
          const expected = structuredClone(state), actual = structuredClone(state)
          for (const key of keys) {
            const source = data[key] as string | undefined
            if (!source) continue
            const native = new Function('a', `${source}; return a;`) as Equation
            seed = 42
            native(expected)
            seed = 42
            try { compileEquation(source)(actual) } catch (error) { throw new Error(`${name}: ${key}: ${String(error)}`) }
            expect(actual, `${name}: ${key}`).toEqual(expected)
          }
        }
      }
    } finally { vi.restoreAllMocks() }
  }, 30000)

  it('loads raw imported EEL, custom variables and children', () => {
    const parts = splitPreset('[preset00]\nfDecay=0.95\nper_frame_init_1=counter=0;\nper_frame_1=counter=counter+1;zoom=if(above(counter,0),1+0.01*sin(time),0);\nwavecode_0_enabled=1\nwave_0_per_point1=x=sample;y=sin(sample);\nshapecode_0_enabled=1\nshape_0_per_frame1=rad=0.1;')
    const prepared = preparePreset({ ...parts, init_eqs_str: parts.presetInit, frame_eqs_str: parts.perFrame, pixel_eqs_str: parts.perVertex })
    const state: EquationState = { time: Math.PI / 2 }
    ;(prepared.init_eqs as Equation)(state)
    ;(prepared.frame_eqs as Equation)(state)
    expect(state.counter).toBe(1)
    expect(state.zoom).toBeCloseTo(1.01)
    expect(prepared.warp).toBe('')
    expect(prepared.comp).toBe('')
    expect((prepared.waves as Record<string, unknown>[])[0].point_eqs).toBeTypeOf('function')
    expect((prepared.shapes as Record<string, unknown>[])[0].frame_eqs).toBeTypeOf('function')
    const waveState = { sample: 0.5 }
    compileEquation('a=sample; r=1-a;')(waveState)
    expect(waveState).toEqual({ sample: 0.5, a: 0.5, r: 0.5 })
  })

  it('adds missing shaders/children to older saved presets without mutating the source', () => {
    const source = { baseVals: { zoom: 1 }, frame_eqs_str: 'a.zoom+=0.01;', shapes: [{ baseVals: { enabled: 0 } }] }
    const snapshot = structuredClone(source)
    const prepared = preparePreset(source)
    expect(prepared.warp).toBe('')
    expect(prepared.comp).toBe('')
    expect(prepared.shapes).toHaveLength(4)
    expect(prepared.waves).toHaveLength(4)
    expect(prepared.shapes).not.toBe(source.shapes)
    expect(source).toEqual(snapshot)
  })

  it.each(['window.puros.app.quit()', 'a.constructor.constructor(1)()', 'a.__proto__=1', 'Math.constructor(1)', 'new Function(1)', 'a[a.key]=1', 'fetch(1)', 'import(1)'])('rejects arbitrary JS: %s', source => {
    expect(() => compileEquation(source)).toThrow()
  })

  it('bounds imported loops and evaluates conditionals lazily', () => {
    expect(() => compileEquation('while(1) { a.counter+=1; }')({})).toThrow('loop limit')
    const state = { counter: 0 }
    compileEquation('a.result=if(0,a.counter+=1,2);')(state)
    expect(state).toEqual({ counter: 0, result: 2 })
  })
})
