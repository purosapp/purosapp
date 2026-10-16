import { readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { InstalledAudioPlugin } from '../../../src/types/plugins'

const pluginRoots = [
  '/Library/Audio/Plug-Ins/VST3',
  '/Library/Audio/Plug-Ins/VST',
  path.join(os.homedir(), 'Library/Audio/Plug-Ins/VST3'),
  path.join(os.homedir(), 'Library/Audio/Plug-Ins/VST'),
]

let cachedPlugins: InstalledAudioPlugin[] | null = null
let pendingScan: Promise<InstalledAudioPlugin[]> | null = null

async function scanRoots(roots: string[]): Promise<InstalledAudioPlugin[]> {
  const plugins: InstalledAudioPlugin[] = []
  const seen = new Set<string>()
  const visitedDirectories = new Set<string>()

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 5) return
    try {
      const canonicalDirectory = await realpath(directory)
      if (visitedDirectories.has(canonicalDirectory)) return
      visitedDirectories.add(canonicalDirectory)
    } catch {
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return // A system or user plug-in folder may not exist or be readable.
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      const extension = path.extname(entry.name).toLowerCase()
      if (extension === '.vst' || extension === '.vst3') {
        try {
          if (!(await stat(entryPath)).isDirectory()) continue
          const canonicalPath = await realpath(entryPath)
          if (seen.has(canonicalPath)) continue
          seen.add(canonicalPath)
          plugins.push({
            path: entryPath,
            name: path.basename(entry.name, path.extname(entry.name)),
            format: extension === '.vst3' ? 'VST3' : 'VST',
          })
        } catch {
          // Ignore broken links and incomplete installations.
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        try {
          if ((await stat(entryPath)).isDirectory()) await visit(entryPath, depth + 1)
        } catch {
          // Ignore broken links.
        }
      }
    }
  }

  for (const root of roots) await visit(root, 0)
  return plugins.sort((a, b) => a.name.localeCompare(b.name) || a.format.localeCompare(b.format))
}

export function listInstalledAudioPlugins(refresh = false): Promise<InstalledAudioPlugin[]> {
  if (pendingScan) return pendingScan
  if (!refresh && cachedPlugins) return Promise.resolve(cachedPlugins)
  pendingScan = scanRoots(pluginRoots).then((plugins) => {
    cachedPlugins = plugins
    return plugins
  }).finally(() => { pendingScan = null })
  return pendingScan
}
