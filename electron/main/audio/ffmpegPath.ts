import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

let resolvedFfmpegPath: string | null = null

/** Resolve the core-owned ffmpeg used only for local audio preparation. */
export function getFfmpegPath(): string {
  if (resolvedFfmpegPath) return resolvedFfmpegPath

  const candidates = [
    process.env.PUROS_FFMPEG_PATH ?? '',
    process.env.FFMPEG_PATH ?? '',
    process.resourcesPath ? path.join(process.resourcesPath, 'audio', 'ffmpeg') : '',
    process.env.APP_ROOT ? path.join(process.env.APP_ROOT, 'build', 'audio', 'ffmpeg') : '',
    path.join(process.cwd(), 'build', 'audio', 'ffmpeg'),
    'ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ]
  const failures: string[] = []

  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (candidate !== 'ffmpeg' && !fs.existsSync(candidate)) continue

    const probe = spawnSync(candidate, ['-version'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    })
    if (!probe.error && probe.status === 0) {
      resolvedFfmpegPath = candidate
      return candidate
    }

    failures.push(`${candidate}: ${(probe.stderr || probe.error?.message || `exit code ${probe.status}`).trim()}`)
  }

  throw new Error(`No working ffmpeg executable found. ${failures.join(' | ') || 'Install ffmpeg or set PUROS_FFMPEG_PATH.'}`)
}
