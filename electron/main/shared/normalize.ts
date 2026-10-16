import { createHash } from 'node:crypto'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function normStr(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim()
}

export function normalizeIsrc(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const normalized = normalizeIsrc(candidate)
      if (normalized) return normalized
    }
    return null
  }
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const compact = raw.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return compact.length >= 10 ? compact : null
}

export function normalizeUpc(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const normalized = normalizeUpc(candidate)
      if (normalized) return normalized
    }
    return null
  }
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const digits = raw.replace(/\D+/g, '')
  return digits.length >= 8 ? digits : null
}

export function providerArtistRowId(provider: string, id: string | number) {
  return `${provider}:artist:${id}`
}

export function providerAlbumRowId(provider: string, id: string | number) {
  return `${provider}:album:${id}`
}

export function providerTrackRowId(provider: string, id: string | number) {
  return sha256(`${provider}://track/${id}`)
}

// Split artist string on common feat./&/x separators
const ARTIST_SPLIT_RE = /\s+(?:feat\.?|ft\.?|featuring|&|x)\s+/i
const ARTIST_MULTI_VALUE_RE = /\s*;\s*/u

function shouldSplitCommaSeparatedArtists(parts: string[]): boolean {
  if (parts.length <= 1) return false

  // Preserve artist names such as "Tyler, The Creator".
  if (parts.length === 2 && /^(the|a|an)\b/i.test(parts[1])) return false

  // Preserve common single-band names such as "Earth, Wind & Fire".
  if (parts.length === 2 && parts[1].includes('&')) return false

  // Avoid splitting obvious generational suffixes or family-name formatting.
  if (parts.length === 2 && /^(jr|sr|ii|iii|iv|v)\.?$/i.test(parts[1])) return false

  return true
}

export function splitArtists(raw: string): string[] {
  const initialParts = raw
    .split(ARTIST_SPLIT_RE)
    .map((value) => value.trim())
    .filter(Boolean)

  const expanded: string[] = []

  for (const part of initialParts) {
    const semicolonParts = part
      .split(ARTIST_MULTI_VALUE_RE)
      .map((value) => value.trim())
      .filter(Boolean)

    for (const semicolonPart of semicolonParts) {
      const commaParts = semicolonPart
        .split(/\s*,\s*/u)
        .map((value) => value.trim())
        .filter(Boolean)

      if (shouldSplitCommaSeparatedArtists(commaParts)) {
        expanded.push(...commaParts)
      } else {
        expanded.push(semicolonPart)
      }
    }
  }

  return [...new Set(expanded)]
}

export function normalizeArtistList(values: string[] | null | undefined, fallback: string): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)

  const expanded = normalized.flatMap((value) => {
    const split = splitArtists(value)
    return split.length > 0 ? split : [value]
  })
  const deduped = [...new Set(expanded)]
  if (deduped.length > 1) return deduped

  const fallbackSplit = splitArtists(fallback)
  if (fallbackSplit.length > 1) return fallbackSplit

  if (deduped.length === 1) return deduped
  return fallbackSplit
}

export function normalizeGenreTags(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const genres: string[] = []
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const genre = raw.trim()
    const key = normStr(genre)
    if (!genre || seen.has(key)) continue
    seen.add(key)
    genres.push(genre)
  }
  return genres
}
