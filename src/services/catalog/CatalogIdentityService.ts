import { sourceEntityId } from './sourceIdentity'
import type Database from 'better-sqlite3'
import type {
  CatalogAlbumIdentityInput,
  CatalogIdentityInput,
  CatalogTrackIdentityInput,
} from './types'


const ALBUM_VERSION_QUALIFIER = /\b(live|recording|explicit|clean|standard|japan|japanese|deluxe|super\s+deluxe|special|collector'?s?|limited|tour|bonus|digital|edition|expanded|remaster(?:ed)?|reissue|re[-\s]?release|anniversary|mono|stereo|sacd|shm|uhq|hybrid|disc|cd|lp|vinyl|immersive|mix|version|re[-\s]?record(?:ed|ing)?|rerecord(?:ed|ing)?|revisited|redux|reimagined|taylor'?s\s+version)\b/i
const ALBUM_VERSION_LOCATION_PHRASE = /\b(?:at|in|with|from|recorded)\b/i
const ALBUM_BARE_VERSION_SUFFIX = /\s+(?:\d{4}\s+)?(?:deluxe|super\s+deluxe|special|collector'?s?|limited|tour|bonus|digital|expanded|standard|clean|explicit|japan(?:ese)?|anniversary|mono|stereo|remaster(?:ed)?|reissue|re[-\s]?release|re[-\s]?record(?:ed|ing)?|rerecord(?:ed|ing)?|revisited|redux|reimagined|taylor'?s\s+version)(?:\s+(?:edition|version|remaster(?:ed)?|mix|bonus\s+tracks?))?$/i


export function canonicalizeArtistName(name: string | null | undefined) {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .replace(/^the\s+/i, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function canonicalizeAlbumTitle(title: string | null | undefined, primaryArtistNormalizedName?: string | null) {
  let normalized = (title ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .trim()

  if (primaryArtistNormalizedName) {
    const artistPrefix = `${primaryArtistNormalizedName.trim()} - `
    if (normalized.startsWith(artistPrefix)) {
      normalized = normalized.slice(artistPrefix.length).trim()
    }
  }

  // Qualifiers that are strippable when they appear alone in a trailing (...)
  // or [...] suffix. "Live" is included so that e.g. "S&M2 (Live)" and "S&M2"
  // are matched together, but location-flavoured suffixes like "(Live at MSG)"
  // are kept distinct (see the locationPhrase guard below).
  // Prevent stripping "(Live at X)", "(Recorded in Y)", etc.
  let previous = ''
  while (normalized !== previous) {
    previous = normalized
    normalized = normalized
      .replace(ALBUM_BARE_VERSION_SUFFIX, '')
      .replace(/\s+(?:-|\u2013|\u2014|:)\s+(.+)$/i, (_match, suffix: string) => {
        const cleaned = suffix.trim()
        const isRemovable = (/^\d{4}$/.test(cleaned) || ALBUM_VERSION_QUALIFIER.test(cleaned)) && !ALBUM_VERSION_LOCATION_PHRASE.test(cleaned)
        return isRemovable ? '' : ` - ${cleaned}`
      })
      .replace(/\s*[[(]([^()[\]]+)[\])]\s*$/g, (_match, inner: string) => {
        const cleaned = inner.trim()
        const isRemovable = (/^\d{4}$/.test(cleaned) || ALBUM_VERSION_QUALIFIER.test(cleaned)) && !ALBUM_VERSION_LOCATION_PHRASE.test(cleaned)
        return isRemovable ? '' : ` (${cleaned})`
      })
      .trim()
  }

  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function canonicalizeTrackTitle(title: string | null | undefined) {
  let normalized = (title ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .trim()

  normalized = normalized
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .replace(/\s+(?:-|\u2013|\u2014)\s+(?:live|edit|radio edit|single version|album version|mono|stereo|remaster(?:ed)?|version|mix)\b.*$/i, '')

  const removableQualifier = /\b(live|edit|radio edit|single version|album version|mono|stereo|remaster(?:ed)?|version|mix)\b/i
  let previous = ''
  while (normalized !== previous) {
    previous = normalized
    normalized = normalized
      .replace(/\s*[[(]([^()[\]]+)[\])]\s*$/g, (_match, inner: string) => {
        const cleaned = inner.trim()
        return removableQualifier.test(cleaned) ? '' : ` (${cleaned})`
      })
      .trim()
  }

  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class CatalogIdentityService {
  constructor(private readonly db: Database.Database) {}

  private find(kind: 'artist' | 'album' | 'track', provider: string, sourceId: string) {
    const row = this.db.prepare(`SELECT catalog_${kind}_id AS id FROM catalog_${kind}_sources WHERE provider = ? AND source_id = ?`).get(provider, sourceId) as { id: string } | undefined
    return row?.id ?? sourceEntityId({ providerId: provider, entityType: kind, sourceId })
  }
  findOrCreateArtist(input: CatalogIdentityInput) { return this.find('artist', input.provider, input.sourceId) }
  findOrCreateAlbum(input: CatalogAlbumIdentityInput) { return this.find('album', input.provider, input.sourceId) }
  findOrCreateTrack(input: CatalogTrackIdentityInput) { return this.find('track', input.provider, input.sourceId) }
}
