import type { PackageInspectionSummary, PackageTrustWarning } from '../../../electron/preload'

/** Plain-language explanation of each trust warning the user must accept before installing. */
export function describeTrustWarning(warning: PackageTrustWarning, summary: PackageInspectionSummary): string {
  const fingerprint = summary.trust.publisher?.fingerprint ?? ''
  const installed = summary.installedVersion ?? 'the installed version'
  switch (warning) {
    case 'runs-with-user-privileges':
      return 'Provider code runs with your user account’s permissions. Puros runs it in a separate process, but that is not a security sandbox: it can read your files and use the network.'
    case 'unsigned-package':
      return 'This package is not signed, so its publisher cannot be verified.'
    case 'new-publisher':
      return `First package from publisher key ${fingerprint}. Updates will be expected from the same key.`
    case 'publisher-changed':
      return `This update is signed by a different key (${fingerprint}) than the installed version. It may not come from the same publisher.`
    case 'signed-to-unsigned':
      return 'The installed version was signed, but this update is not. It may not come from the same publisher.'
    case 'native-code-not-notarized':
      return 'Contains native programs that Apple has not checked (no Developer ID signature).'
    case 'downgrade':
      return `This is an older version than the installed ${installed}.`
    case 'unordered-version':
      return `Puros cannot tell whether this version is older or newer than the installed ${installed}.`
    case 'same-version-different-content':
      return `Same version number as the installed ${installed}, but different contents.`
  }
}

/** A downgrade (or an unknown version order) gets a separate "may be incompatible" confirmation. */
export function needsIncompatibilityConfirmation(summary: PackageInspectionSummary): boolean {
  return summary.trust.warnings.includes('downgrade') || summary.trust.warnings.includes('unordered-version')
}

export function describePublisher(summary: PackageInspectionSummary): string {
  if (summary.trust.signature === 'first-party') return `Verified by ${summary.trust.publisher?.label ?? 'Puros'}`
  if (summary.trust.signature === 'publisher') return `Publisher key ${summary.trust.publisher?.fingerprint}`
  return 'Unsigned — publisher unverified'
}

export function describeRelation(summary: PackageInspectionSummary): string {
  switch (summary.relation) {
    case 'new': return 'New provider'
    case 'upgrade': return `Update from ${summary.installedVersion}`
    case 'downgrade': return `Older than installed ${summary.installedVersion}`
    case 'same': return 'Already installed'
    case 'replace': return `Replaces installed ${summary.installedVersion}`
    case 'unordered': return `Replaces installed ${summary.installedVersion}`
  }
}
