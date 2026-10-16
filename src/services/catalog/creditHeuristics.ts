import type { CatalogCreditRole } from './types'

export interface CreditHeuristicArtist {
  sourceId?: string | null
  name?: string | null
  role?: CatalogCreditRole | string | null
  joinPhrase?: string | null
}

export interface InferredCredit {
  index: number
  role: CatalogCreditRole
  joinPhrase: string | null
}

type FeaturedConnector = 'feat' | 'with' | null

function norm(value: string | null | undefined) {
  return (value ?? '').toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim()
}

export function normalizeCreditRole(role: CatalogCreditRole | string | null | undefined): CatalogCreditRole {
  const normalized = (role ?? '').trim().toLowerCase()
  if (normalized === 'featured' || normalized === 'feat') return 'featured'
  if (normalized === 'composer') return 'composer'
  if (normalized === 'producer') return 'producer'
  if (normalized === 'conductor') return 'conductor'
  if (normalized === 'performer') return 'performer'
  if (normalized === 'primary') return 'primary'
  return 'main'
}

function splitFeaturedNames(raw: string): string[] {
  return raw
    .replace(/\s+(?:from|on)\s+.+$/iu, '')
    .split(/\s*(?:,|&|\band\b|\bx\b)\s*/iu)
    .map((value) => value.trim().replace(/^[@-]\s*/, ''))
    .filter(Boolean)
}

function extractFeaturedHints(title: string | null | undefined): {
  names: Set<string>
  connector: FeaturedConnector
} {
  const names = new Set<string>()
  let connector: FeaturedConnector = null
  const value = title ?? ''
  if (!value.trim()) return { names, connector }

  const patterns = [
    /[([]\s*(feat\.?|ft\.?|featuring|with)\s+([^)\]]+)\s*[)\]]/giu,
    /\b(feat\.?|ft\.?|featuring|with)\s+(.+)$/giu,
  ]

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const keyword = (match[1] ?? '').toLowerCase()
      const rawNames = match[2] ?? ''
      if (!rawNames.trim()) continue
      if (connector == null) connector = keyword === 'with' ? 'with' : 'feat'
      splitFeaturedNames(rawNames).forEach((name) => {
        const normalized = norm(name)
        if (normalized) names.add(normalized)
      })
    }
  }

  return { names, connector }
}

export function inferCreditJoinPhrase(
  index: number,
  credits: Array<{ role: CatalogCreditRole; joinPhrase?: string | null }>,
  featuredConnector: FeaturedConnector = null,
): string | null {
  if (index >= credits.length - 1) return null

  const current = credits[index]
  if (current.joinPhrase && current.joinPhrase.trim()) return current.joinPhrase

  const next = credits[index + 1]
  if (next.role === 'featured' && current.role !== 'featured') {
    return featuredConnector === 'with' ? ' with ' : ' feat. '
  }
  if (current.role === 'featured') return ', '

  const firstFeaturedIndex = credits.findIndex((credit) => credit.role === 'featured')
  const mainBlockEnd = firstFeaturedIndex >= 0 ? firstFeaturedIndex - 1 : credits.length - 1
  if (index < mainBlockEnd - 1) return ', '
  if (index === mainBlockEnd - 1) return ' & '
  if (index < mainBlockEnd) return ', '
  return ', '
}

export function inferArtistCredits(options: {
  entityType: 'album' | 'track'
  title?: string | null
  primaryArtistSourceId?: string | null
  primaryArtistName?: string | null
  artists: CreditHeuristicArtist[]
}): InferredCredit[] {
  const featuredHints = options.entityType === 'track'
    ? extractFeaturedHints(options.title)
    : { names: new Set<string>(), connector: null as FeaturedConnector }
  const normalizedPrimaryName = norm(options.primaryArtistName)

  const base = options.artists.map((artist, index) => {
    const normalizedName = norm(artist.name)
    const explicitRole = artist.role ? normalizeCreditRole(artist.role) : null
    const matchesPrimary = (
      (!!artist.sourceId && !!options.primaryArtistSourceId && artist.sourceId === options.primaryArtistSourceId) ||
      (!!normalizedName && !!normalizedPrimaryName && normalizedName === normalizedPrimaryName)
    )

    let role = explicitRole ?? (matchesPrimary || index === 0 ? 'primary' : 'main')
    if (!explicitRole && role !== 'primary' && normalizedName && featuredHints.names.has(normalizedName)) {
      role = 'featured'
    }

    return {
      index,
      role,
      joinPhrase: artist.joinPhrase ?? null,
    }
  })

  return base.map((artist, index, all) => ({
    ...artist,
    joinPhrase: artist.joinPhrase ?? inferCreditJoinPhrase(index, all, featuredHints.connector),
  }))
}
