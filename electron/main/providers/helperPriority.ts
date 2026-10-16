import os from 'node:os'
import type { ProviderHelperDeclarationV1 } from '../../../src/provider-api/v1'

/** Match the former progressive adapter's best-effort ffmpeg scheduling policy. */
export function applyDeclaredHelperPriority(
  declaration: ProviderHelperDeclarationV1,
  pid: number | undefined,
  setPriority: (processId: number, priority: number) => void = os.setPriority,
): void {
  if (declaration.processPriority !== 'below-normal' || !pid) return
  try {
    setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Playback correctness does not depend on process priority.
  }
}
