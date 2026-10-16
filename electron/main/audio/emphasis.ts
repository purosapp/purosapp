import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * CD pre-emphasis (50/15 µs) detection for local files, so playback can undo it.
 *
 * Sources: the CUE sheet (`FLAGS PRE` on the track) or a tag written by rippers
 * (PRE_EMPHASIS / PREEMPHASIS / EMPHASIS with a truthy or "50/15" value).
 */

const EMPHASIS_TAG_KEYS = new Set(['PRE_EMPHASIS', 'PREEMPHASIS', 'PRE-EMPHASIS', 'EMPHASIS'])
const TRUTHY_EMPHASIS = /^(1|yes|true|on|50\/15(\s*[µu]s)?|ccitt)$/i
const INDEX_MATCH_TOLERANCE_MS = 20

const cache = new Map<string, boolean>()

function parseCueTimeMs(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})$/u)
  if (!match) return null
  const [minutes, seconds, frames] = match.slice(1).map((part) => Number.parseInt(part, 10))
  return Math.round((minutes * 60 + seconds + frames / 75) * 1000)
}

function unquote(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

/**
 * Whether the CUE track that plays `audioFile` from `startOffsetMs` carries
 * `FLAGS PRE`. With no offset, any flagged track in that file counts.
 */
export function cueTrackHasPreEmphasis(cueContent: string, audioFile: string, startOffsetMs: number | null): boolean {
  const target = path.basename(audioFile).toLowerCase()
  let inTargetFile = false
  let trackFlagged = false
  let trackIndexMs: number | null = null
  const matches = () => trackFlagged &&
    (startOffsetMs == null || (trackIndexMs != null && Math.abs(trackIndexMs - startOffsetMs) <= INDEX_MATCH_TOLERANCE_MS))

  for (const rawLine of cueContent.split(/\r?\n/)) {
    const line = rawLine.trim()
    const file = line.match(/^FILE\s+(".*?"|\S+)/iu)
    if (file) {
      if (inTargetFile && matches()) return true
      const referenced = path.basename(unquote(file[1]).replace(/\\/g, '/')).toLowerCase()
      inTargetFile = referenced === target
      trackFlagged = false
      trackIndexMs = null
      continue
    }
    if (!inTargetFile) continue
    if (/^TRACK\s+\d+/iu.test(line)) {
      if (matches()) return true
      trackFlagged = false
      trackIndexMs = null
      continue
    }
    const flags = line.match(/^FLAGS\s+(.+)$/iu)
    if (flags) {
      trackFlagged = flags[1].toUpperCase().split(/\s+/).includes('PRE')
      continue
    }
    const index = line.match(/^INDEX\s+01\s+(\S+)/iu)
    if (index) trackIndexMs = parseCueTimeMs(index[1])
  }
  return inTargetFile && matches()
}

export function tagsIndicatePreEmphasis(tags: Array<{ id: string; value: unknown }>): boolean {
  return tags.some(({ id, value }) => {
    const key = id.replace(/^(TXXX|----):/i, '').replace(/^com\.apple\.iTunes:/i, '').toUpperCase()
    return EMPHASIS_TAG_KEYS.has(key) && TRUTHY_EMPHASIS.test(String(value).trim())
  })
}

export async function detectPreEmphasis(
  filePath: string,
  cueSheetPath?: string | null,
  startOffsetMs?: number | null,
): Promise<boolean> {
  const key = `${filePath}\0${cueSheetPath ?? ''}\0${startOffsetMs ?? ''}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  let detected = false
  if (cueSheetPath) {
    try {
      detected = cueTrackHasPreEmphasis(await fs.readFile(cueSheetPath, 'utf8'), filePath, startOffsetMs ?? null)
    } catch {
      // Unreadable CUE: fall through to tags.
    }
  }
  if (!detected) {
    try {
      const mm = await import('music-metadata')
      const metadata = await mm.parseFile(filePath, { skipCovers: true, duration: false })
      detected = Object.values(metadata.native).some((tags) => tagsIndicatePreEmphasis(tags))
    } catch {
      detected = false
    }
  }
  cache.set(key, detected)
  return detected
}
