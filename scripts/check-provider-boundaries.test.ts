import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { findForbiddenProviderImports, findProviderIdentityLiterals } from './check-provider-boundaries.mjs'

describe('provider import boundary', () => {
  it('rejects static and dynamic imports from provider implementations', () => {
    const source = [
      "import plugin from '../providers/tidal/src/index'",
      "const apple = import('../providers/apple/src/index')",
    ].join('\n')
    const filePath = path.join(process.cwd(), 'src', 'feature.ts')

    expect(findForbiddenProviderImports(source, filePath)).toEqual([
      expect.objectContaining({ line: 1, specifier: '../providers/tidal/src/index' }),
      expect.objectContaining({ line: 2, specifier: '../providers/apple/src/index' }),
    ])
  })

  it('allows imports from the core-owned provider API', () => {
    expect(findForbiddenProviderImports("import type { ProviderId } from '../provider-api/v1'"))
      .toEqual([])
  })

  it('rejects provider identities in shared core code', () => {
    expect(findProviderIdentityLiterals("if (source === 'apple') return 'tidal'"))
      .toEqual([
        expect.objectContaining({ line: 1, literal: "'apple'" }),
        expect.objectContaining({ line: 1, literal: 'tidal' }),
      ])
    expect(findProviderIdentityLiterals("const platform = 'CoreAudio'"))
      .toEqual([])
  })
})
