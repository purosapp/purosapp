import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { classifyNativeCode, compareProviderVersions, evaluatePackageTrust, inspectCodeSignature } from './trust'

const keyA = { keyId: 'a'.repeat(32), publicKey: 'A' }
const keyB = { keyId: 'b'.repeat(32), publicKey: 'B' }

describe('package trust verdict (owner-approved policy)', () => {
  it('never refuses a package for lacking a signature, but always warns about privileges', () => {
    const verdict = evaluatePackageTrust({ signature: null, pinned: null, nativeCode: 'none', versionRelation: 'new', trustedKeys: [] })
    expect(verdict).toMatchObject({ signature: 'unsigned', publisher: null })
    expect(verdict.warnings).toEqual(['runs-with-user-privileges', 'unsigned-package'])
  })

  it('distinguishes first-party, new, same and changed publishers', () => {
    const trusted = [{ ...keyA, label: 'Puros' }]
    expect(evaluatePackageTrust({ signature: keyA, pinned: null, nativeCode: 'none', versionRelation: 'new', trustedKeys: trusted }))
      .toMatchObject({ signature: 'first-party', publisher: { label: 'Puros' }, warnings: ['runs-with-user-privileges'] })
    expect(evaluatePackageTrust({ signature: keyB, pinned: null, nativeCode: 'none', versionRelation: 'new', trustedKeys: trusted }).warnings)
      .toContain('new-publisher')
    expect(evaluatePackageTrust({ signature: keyB, pinned: { keyId: keyB.keyId }, nativeCode: 'none', versionRelation: 'upgrade', trustedKeys: [] }).warnings)
      .toEqual(['runs-with-user-privileges'])
    expect(evaluatePackageTrust({ signature: keyB, pinned: { keyId: keyA.keyId }, nativeCode: 'none', versionRelation: 'upgrade', trustedKeys: [] }).warnings)
      .toContain('publisher-changed')
    expect(evaluatePackageTrust({ signature: null, pinned: { keyId: keyA.keyId }, nativeCode: 'none', versionRelation: 'upgrade', trustedKeys: [] }).warnings)
      .toEqual(['runs-with-user-privileges', 'unsigned-package', 'signed-to-unsigned'])
    expect(evaluatePackageTrust({ signature: keyA, pinned: { keyId: null }, nativeCode: 'none', versionRelation: 'upgrade', trustedKeys: [] }).warnings)
      .toContain('new-publisher')
  })

  it('warns about ad-hoc native code, downgrades, unordered and same-version replacements', () => {
    const warnings = (versionRelation: Parameters<typeof evaluatePackageTrust>[0]['versionRelation']) => evaluatePackageTrust({
      signature: keyA, pinned: { keyId: keyA.keyId }, nativeCode: 'ad-hoc', versionRelation, trustedKeys: [],
    }).warnings
    expect(warnings('upgrade')).toEqual(['runs-with-user-privileges', 'native-code-not-notarized'])
    expect(warnings('downgrade')).toContain('downgrade')
    expect(warnings('unordered')).toContain('unordered-version')
    expect(warnings('replace')).toContain('same-version-different-content')
  })

  it('orders numeric versions and refuses to guess otherwise', () => {
    expect(compareProviderVersions('1.10.0', '1.9.2')).toBe(1)
    expect(compareProviderVersions('v2', '2.0.0')).toBeNull()
    expect(compareProviderVersions('2.0', '2.0.0')).toBeNull()
    expect(compareProviderVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareProviderVersions('0.9', '1.0')).toBe(-1)
    expect(compareProviderVersions('nightly', '1.0')).toBeNull()
  })
})

describe.runIf(process.platform === 'darwin')('native code signature inspection', () => {
  it('classifies Apple, ad-hoc and unsigned Mach-O files and refuses unrunnable ones', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-codesign-'))
    try {
      expect(inspectCodeSignature('/usr/bin/true')).toBe('platform-signed')
      const copy = path.join(directory, 'tool')
      fs.copyFileSync('/usr/bin/true', copy)
      expect(spawnSync('/usr/bin/codesign', ['--remove-signature', copy]).status).toBe(0)
      expect(inspectCodeSignature(copy)).toBe('unsigned')
      expect(() => classifyNativeCode([copy])).toThrow('has no code signature')
      expect(spawnSync('/usr/bin/codesign', ['--sign', '-', copy]).status).toBe(0)
      expect(inspectCodeSignature(copy)).toBe('ad-hoc')
      expect(classifyNativeCode([copy])).toBe('ad-hoc')
      expect(classifyNativeCode(['/usr/bin/true', copy])).toBe('ad-hoc')
      expect(classifyNativeCode([])).toBe('none')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
