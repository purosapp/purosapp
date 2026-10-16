import { describe, expect, it } from 'vitest'
import type { PackageInspectionSummary, PackageTrustWarning } from '../../../electron/preload'
import { describePublisher, describeRelation, describeTrustWarning, needsIncompatibilityConfirmation } from './providerPackageText'

const WARNINGS: PackageTrustWarning[] = [
  'runs-with-user-privileges', 'unsigned-package', 'new-publisher', 'publisher-changed', 'signed-to-unsigned',
  'native-code-not-notarized', 'downgrade', 'unordered-version', 'same-version-different-content',
]

function summary(overrides: Partial<PackageInspectionSummary> = {}, warnings: PackageTrustWarning[] = ['runs-with-user-privileges']): PackageInspectionSummary {
  return {
    token: '00000000-0000-4000-8000-000000000000', providerId: 'demo', version: '1.0.0', displayName: 'Demo',
    description: null, homepage: null, capabilities: [],
    permissions: { networkOrigins: [], externalOrigins: [], secrets: [], runtimeEnvironment: [], authOrigins: [], helpers: [] },
    platform: null, archiveSha256: 'a'.repeat(64), relation: 'new', installedVersion: null,
    trust: { signature: 'publisher', publisher: { keyId: 'b'.repeat(32), fingerprint: 'BBBB BBBB', label: null }, nativeCode: 'none', warnings },
    ...overrides,
  }
}

describe('provider package consent text', () => {
  it('explains every trust warning in plain language', () => {
    for (const warning of WARNINGS) expect(describeTrustWarning(warning, summary({ installedVersion: '2.0.0' })).length).toBeGreaterThan(20)
    expect(describeTrustWarning('runs-with-user-privileges', summary())).toContain('not a security sandbox')
    expect(describeTrustWarning('downgrade', summary({ installedVersion: '2.0.0' }))).toContain('2.0.0')
  })

  it('asks for the incompatibility confirmation only for downgrades and unknown version order', () => {
    expect(needsIncompatibilityConfirmation(summary({}, ['runs-with-user-privileges', 'downgrade']))).toBe(true)
    expect(needsIncompatibilityConfirmation(summary({}, ['runs-with-user-privileges', 'unordered-version']))).toBe(true)
    expect(needsIncompatibilityConfirmation(summary({}, ['runs-with-user-privileges', 'publisher-changed']))).toBe(false)
  })

  it('names the publisher state and version relation', () => {
    expect(describePublisher(summary())).toBe('Publisher key BBBB BBBB')
    expect(describePublisher(summary({ trust: { signature: 'unsigned', publisher: null, nativeCode: 'none', warnings: [] } }))).toMatch(/Unsigned/)
    expect(describeRelation(summary({ relation: 'downgrade', installedVersion: '2.0.0' }))).toBe('Older than installed 2.0.0')
  })
})
