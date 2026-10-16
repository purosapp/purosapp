import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { runPlaybackIdleTask } from '../playbackCoordinator'
import { sendToRenderer } from '../rendererBridge'

interface AutoEQEntry {
  name: string       // headphone name, e.g. "Sennheiser HD 650"
  source: string     // measurement source, e.g. "Filk / over-ear"
  downloadUrl: string
}

interface AutoEQDiskCache {
  timestamp: number      // ms since epoch when index was last fetched from GitHub
  entries: AutoEQEntry[]
}

let autoEQIndexCache: AutoEQEntry[] | null = null

const AUTOEQ_CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

export function getAutoEQCachePath(): string {
  return path.join(app.getPath('userData'), 'autoeq-index.json')
}

function loadAutoEQDiskCache(): AutoEQDiskCache | null {
  try {
    const raw = fs.readFileSync(getAutoEQCachePath(), 'utf-8')
    return JSON.parse(raw) as AutoEQDiskCache
  } catch {
    return null
  }
}

function saveAutoEQDiskCache(entries: AutoEQEntry[]) {
  try {
    const payload: AutoEQDiskCache = { timestamp: Date.now(), entries }
    fs.writeFileSync(getAutoEQCachePath(), JSON.stringify(payload), 'utf-8')
  } catch {
    // Non-critical — just means next launch won't have a cache
  }
}

async function fetchAutoEQFromGitHub(): Promise<AutoEQEntry[]> {
  const res = await fetch(
    'https://api.github.com/repos/jaakkopasanen/AutoEq/git/trees/master?recursive=1',
    { headers: { 'User-Agent': 'Puros/1.0', 'Accept': 'application/vnd.github.v3+json' } }
  )
  if (res.status === 403 || res.status === 429) throw new Error('RATE_LIMIT')
  if (!res.ok) throw new Error(`GitHub API error: HTTP ${res.status}`)

  const data = await res.json() as { tree: Array<{ path: string; type: string }> }
  const RAW_BASE = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/'

  const entries: AutoEQEntry[] = []
  for (const item of data.tree) {
    if (item.type !== 'blob' || !item.path.endsWith('ParametricEQ.txt')) continue
    const parts = item.path.split('/')
    if (parts.length < 3) continue
    const filename = parts[parts.length - 1]
    const name = filename.replace(' ParametricEQ.txt', '')
    const sourceParts = parts.slice(1, parts.length - 2)
    const source = sourceParts.join(' / ')
    entries.push({
      name,
      source,
      downloadUrl: RAW_BASE + item.path.split('/').map(encodeURIComponent).join('/'),
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/**
 * Return the AutoEQ index as fast as possible:
 *   1. In-memory cache → instant
 *   2. Disk cache → instant, then kick off a background refresh if > 24 h old
 *   3. No disk cache → fetch from GitHub synchronously (first ever launch)
 *
 * Background refresh pushes `autoeq:index-updated` to the renderer only when
 * the entry count changes (i.e. new headphones were added to the repo).
 */
export async function getAutoEQIndex(): Promise<AutoEQEntry[]> {
  if (autoEQIndexCache) return autoEQIndexCache

  const disk = loadAutoEQDiskCache()
  if (disk && disk.entries.length > 0) {
    autoEQIndexCache = disk.entries

    // Background refresh if cache is stale
    const age = Date.now() - disk.timestamp
    if (age > AUTOEQ_CACHE_TTL_MS) {
      setImmediate(() => refreshAutoEQInBackground(disk.entries.length))
    }

    return autoEQIndexCache
  }

  // No disk cache — fetch synchronously (first launch)
  const entries = await fetchAutoEQFromGitHub()
  autoEQIndexCache = entries
  saveAutoEQDiskCache(entries)
  return entries
}

function refreshAutoEQInBackground(previousCount: number) {
  runPlaybackIdleTask('AutoEQ refresh', async () => {
    const entries = await fetchAutoEQFromGitHub()
    if (entries.length === previousCount) return
    autoEQIndexCache = entries
    saveAutoEQDiskCache(entries)
    sendToRenderer('autoeq:index-updated', { count: entries.length, entries })
  })
}

export function clearAutoEQMemoryCache() {
  autoEQIndexCache = null
}
