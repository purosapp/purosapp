import fs from 'node:fs'
import path from 'node:path'

function realPath(value: string): string | null {
  try {
    return fs.realpathSync.native(value)
  } catch {
    return null
  }
}

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

export function resolveAllowedExistingFile(
  candidatePath: unknown,
  allowedRoots: readonly string[],
): string | null {
  if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) return null

  const candidateRealPath = realPath(candidatePath)
  if (!candidateRealPath) return null

  try {
    if (!fs.statSync(candidateRealPath).isFile()) return null
  } catch {
    return null
  }

  for (const rootPath of allowedRoots) {
    const rootRealPath = realPath(rootPath)
    if (rootRealPath && isPathInsideRoot(candidateRealPath, rootRealPath)) {
      return candidateRealPath
    }
  }
  return null
}
