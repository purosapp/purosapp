import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderHelperDeclarationV1 } from '../../../src/provider-api/v1'
import { resolveHelperArguments } from './helperArguments'

const roots: string[] = []
const declaration: ProviderHelperDeclarationV1 = {
  id: 'remux',
  executable: 'helper/dist/ffmpeg',
  argumentTemplate: ['-nostdin', '-i', { cachePath: 'input' }, '-c:a', 'copy', { cachePath: 'output' }],
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('declared helper argv', () => {
  it('accepts only the exact command with canonical cache input and a new cache output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-helper-args-'))
    roots.push(root)
    const input = path.join(root, 'input.m4a')
    const output = path.join(root, 'output.flac')
    fs.writeFileSync(input, 'fixture')
    expect(resolveHelperArguments(declaration, ['-nostdin', '-i', input, '-c:a', 'copy', output], root))
      .toEqual(['-nostdin', '-i', fs.realpathSync(input), '-c:a', 'copy', path.join(fs.realpathSync(root), 'output.flac')])
    expect(() => resolveHelperArguments(declaration, ['-y', '-i', input, '-c:a', 'copy', output], root)).toThrow(/undeclared/)
    expect(() => resolveHelperArguments(declaration, ['-nostdin', '-i', input], root)).toThrow(/argv shape/)
  })

  it('rejects escaped, symlinked, or existing output paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-helper-args-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-helper-outside-'))
    roots.push(root, outside)
    const input = path.join(root, 'input.m4a')
    fs.writeFileSync(input, 'fixture')
    fs.symlinkSync(outside, path.join(root, 'escape'))
    const argv = (source: string, destination: string) => ['-nostdin', '-i', source, '-c:a', 'copy', destination]
    expect(() => resolveHelperArguments(declaration, argv(input, path.join(outside, 'out.flac')), root)).toThrow(/outside/)
    expect(() => resolveHelperArguments(declaration, argv(input, path.join(root, 'escape', 'out.flac')), root)).toThrow(/outside/)
    expect(() => resolveHelperArguments(declaration, argv(path.join(outside, 'missing.m4a'), path.join(root, 'out.flac')), root)).toThrow(/outside/)
    fs.symlinkSync(path.join(outside, 'target.flac'), path.join(root, 'linked.flac'))
    expect(() => resolveHelperArguments(declaration, argv(input, path.join(root, 'linked.flac')), root)).toThrow(/already exists/)
    expect(() => resolveHelperArguments(declaration, argv(input, input), root)).toThrow(/already exists/)
  })

  it('preserves the legacy exact-argument allowlist for the Python bridge', () => {
    const bridge = { id: 'bridge', executable: 'helper/run.sh', allowedArguments: ['login'] }
    expect(resolveHelperArguments(bridge, ['login'], '/unused')).toEqual(['login'])
    expect(() => resolveHelperArguments(bridge, ['playback-info'], '/unused')).toThrow(/undeclared/)
  })

  it('accepts a fixed stdout-only probe with one canonical cache input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-helper-probe-'))
    roots.push(root)
    const input = path.join(root, 'input.flac')
    fs.writeFileSync(input, 'fixture')
    const probe: ProviderHelperDeclarationV1 = {
      id: 'duration',
      executable: 'helper/dist/ffmpeg',
      argumentTemplate: ['-i', { cachePath: 'input' }, '-f', 'null', '-'],
    }
    expect(resolveHelperArguments(probe, ['-i', input, '-f', 'null', '-'], root))
      .toEqual(['-i', fs.realpathSync(input), '-f', 'null', '-'])
    expect(() => resolveHelperArguments(probe, ['-i', input, '-f', 'flac', '-'], root)).toThrow(/undeclared/)
  })
})
