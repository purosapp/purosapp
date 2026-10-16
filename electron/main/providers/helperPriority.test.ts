import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderHelperDeclarationV1 } from '../../../src/provider-api/v1'
import { applyDeclaredHelperPriority } from './helperPriority'

const helper: ProviderHelperDeclarationV1 = { id: 'remux', executable: 'helper/dist/ffmpeg' }

describe('declared helper process priority', () => {
  it('applies the old progressive ffmpeg priority only when declared', () => {
    const setPriority = vi.fn()
    applyDeclaredHelperPriority(helper, 123, setPriority)
    applyDeclaredHelperPriority({ ...helper, processPriority: 'below-normal' }, undefined, setPriority)
    expect(setPriority).not.toHaveBeenCalled()
    applyDeclaredHelperPriority({ ...helper, processPriority: 'below-normal' }, 123, setPriority)
    expect(setPriority).toHaveBeenCalledExactlyOnceWith(123, os.constants.priority.PRIORITY_BELOW_NORMAL)
  })

  it('treats an OS scheduling error as nonfatal', () => {
    expect(() => applyDeclaredHelperPriority({ ...helper, processPriority: 'below-normal' }, 123, () => {
      throw new Error('permission denied')
    })).not.toThrow()
  })
})
