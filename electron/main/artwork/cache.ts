import { app } from 'electron'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import {
  detectImageMime,
  mimeTypeFromPath,
  normalizeArtworkMime,
} from '../shared/mime'
import { sha256 } from '../shared/normalize'

// Cache: filePath → base64 data URI, file:// path, or null
// Capped at 100 entries to bound memory usage
const artworkCache = new Map<string, string | null>()
const ARTWORK_CACHE_LIMIT = 100

const FOLDER_CANDIDATES = [
  'cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'artwork.jpg',
]

export function artCacheDir(): string {
  return path.join(app.getPath('userData'), 'art_cache')
}

export function ensureArtCacheDir() {
  const dir = artCacheDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function clearArtworkMemoryCache() {
  artworkCache.clear()
}

export function artworkFileUrl(filePath: string): string {
  return `artwork://file?path=${encodeURIComponent(filePath)}`
}

export async function extractArtwork(filePath: string): Promise<string | null> {
  if (artworkCache.has(filePath)) return artworkCache.get(filePath)!

  let result: string | null = null

  // 1. Try embedded tag artwork
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(filePath, { skipCovers: false })
    const pic = metadata.common.picture?.[0]
    if (pic && pic.data.length > 0) {
      const mime = pic.format || 'image/jpeg'
      // pic.data is Uint8Array in music-metadata v11 — must go through Buffer
      const b64 = Buffer.from(pic.data).toString('base64')
      result = `data:${mime};base64,${b64}`
    }
  } catch (err) {
    console.warn('[Puros] Artwork tag read failed, trying folder scan:', err)
  }

  // 2. Folder scan fallback
  if (result === null) {
    const dir = path.dirname(filePath)
    for (const name of FOLDER_CANDIDATES) {
      const candidate = path.join(dir, name)
      try {
        fs.accessSync(candidate, fs.constants.R_OK)
        result = artworkFileUrl(candidate)
        break
      } catch {
        // not found, try next
      }
    }
  }

  // Evict oldest entry if over limit
  if (artworkCache.size >= ARTWORK_CACHE_LIMIT) {
    const firstKey = artworkCache.keys().next().value
    if (firstKey !== undefined) artworkCache.delete(firstKey)
  }
  artworkCache.set(filePath, result)
  return result
}

function artworkCacheUrl(artworkId: string | null | undefined): string | null {
  return artworkId ? `artwork://cache/${encodeURIComponent(artworkId)}` : null
}

export async function resolveArtworkCacheUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null
  if (url.startsWith('artwork://')) return url

  const artworkId = await cacheRemoteArtwork(url)
  return artworkCacheUrl(artworkId) ?? url
}

export async function cacheRemoteArtwork(url: string | null | undefined): Promise<string | null> {
  if (!url) return null

  const artworkId = sha256(url)
  const existing = getDb().prepare(
    `SELECT id FROM artwork_cache WHERE id = ?`
  ).get(artworkId) as { id: string } | undefined
  if (existing) return existing.id

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Puros/1.0' },
      // One stalled image must not hold a library sync forever.
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return null

    const arrayBuffer = await response.arrayBuffer()
    const data = Buffer.from(arrayBuffer)
    const mimeType = detectImageMime(
      data,
      normalizeArtworkMime(response.headers.get('content-type')),
    )

    getDb().prepare(`
      INSERT INTO artwork_cache (id, mime_type, data)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mime_type = excluded.mime_type,
        data = excluded.data
    `).run(artworkId, mimeType, data)

    return artworkId
  } catch (error) {
    console.warn('[Puros][Artwork] Failed to cache remote artwork:', url, error)
    return null
  }
}

function cacheArtworkBuffer(data: Buffer, mimeType: string): string {
  const artworkId = createHash('sha256').update(data).digest('hex')
  getDb().prepare(`
    INSERT INTO artwork_cache (id, mime_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mime_type = excluded.mime_type,
      data = excluded.data
  `).run(artworkId, mimeType, data)
  return artworkId
}

export function cacheLocalArtworkFile(filePath: string): string | null {
  try {
    const data = fs.readFileSync(filePath)
    const mimeType = detectImageMime(data, mimeTypeFromPath(filePath))
    return cacheArtworkBuffer(data, mimeType)
  } catch (error) {
    console.warn('[Puros][Artwork] Failed to cache local artwork:', filePath, error)
    return null
  }
}

function findFolderArt(dir: string): string | null {
  for (const name of FOLDER_CANDIDATES) {
    const p = path.join(dir, name)
    try { fs.accessSync(p, fs.constants.R_OK); return p } catch { /* next */ }
  }
  return null
}

export function readFolderArtAsset(dir: string): { filePath: string; mimeType: string; data: Buffer; hash: string } | null {
  const filePath = findFolderArt(dir)
  if (!filePath) return null

  try {
    const data = fs.readFileSync(filePath)
    return {
      filePath,
      mimeType: detectImageMime(data, mimeTypeFromPath(filePath)),
      data,
      hash: createHash('sha256').update(data).digest('hex'),
    }
  } catch {
    return null
  }
}

export function backfillArtworkCache(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, art_path
    FROM albums
    WHERE artwork_id IS NULL AND art_path IS NOT NULL
  `).all() as Array<{ id: string; art_path: string | null }>

  if (rows.length === 0) return

  const upsertArtwork = db.prepare(`
    INSERT INTO artwork_cache (id, mime_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mime_type=excluded.mime_type,
      data=excluded.data
  `)
  const updateAlbumArtwork = db.prepare(`
    UPDATE albums SET artwork_id = ? WHERE id = ?
  `)

  db.transaction((items: Array<{ id: string; art_path: string | null }>) => {
    for (const row of items) {
      if (!row.art_path) continue
      try {
        const data = fs.readFileSync(row.art_path)
        const artworkId = createHash('sha256').update(data).digest('hex')
        const mimeType = detectImageMime(data, mimeTypeFromPath(row.art_path))
        upsertArtwork.run(artworkId, mimeType, data)
        updateAlbumArtwork.run(artworkId, row.id)
      } catch {
        // Keep the legacy file-path fallback if the source art is no longer accessible.
      }
    }
  })(rows)
}
