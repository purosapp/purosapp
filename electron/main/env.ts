import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_PROCESS_ENV_PREFIXES = ['DISCORD_', 'LASTFM_', 'MUSIXMATCH_', 'GENIUS_'] as const

function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue

    const [, key, rawValue] = match
    let value = rawValue.trim()

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }

    values[key] = value
  }

  return values
}

export function shouldImportMainProcessEnvKey(key: string, selectedProviderIds: readonly string[]): boolean {
  return MAIN_PROCESS_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    || selectedProviderIds.some((id) => key.startsWith(`${id.replace(/-/g, '_').toUpperCase()}_`))
}

function getMainProcessEnvFiles(): string[] {
  // Packaged builds must never depend on plaintext dotenv files. Development
  // can still use the ignored repository-local files for legacy integrations.
  if (!process.env.VITE_DEV_SERVER_URL) return []

  const candidates = [
    process.env.APP_ROOT ? path.join(process.env.APP_ROOT, '.env') : '',
    process.env.APP_ROOT ? path.join(process.env.APP_ROOT, '.env.local') : '',
  ]

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (!candidate || seen.has(candidate)) return false
    seen.add(candidate)
    return true
  })
}

export function loadMainProcessEnv(selectedProviderIds: readonly string[]) {
  const merged: Record<string, string> = {}

  for (const envFile of getMainProcessEnvFiles()) {
    if (!fs.existsSync(envFile)) continue

    const parsed = parseDotEnv(fs.readFileSync(envFile, 'utf8'))
    for (const [key, value] of Object.entries(parsed)) {
      if (!shouldImportMainProcessEnvKey(key, selectedProviderIds)) continue
      merged[key] = value
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const RENDERER_DIST = path.join(APP_ROOT, 'dist')
