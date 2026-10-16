import type Database from "better-sqlite3"
import { getArtistBioSource, getArtistBioSourcePriority } from "../settings/store"
import { invokeProvider } from "../providers"
import { musicBrainzSpineClient, upsertCatalogFieldProvenance } from "./canonical"

type ArtistBioSource = 'wikipedia' | 'metal-archives' | 'none'

interface ArtistBioResult {
  bio: string | null
  genres: string[] | null
  sourceUrl: string | null
  imageUrl: string | null
}

interface ArtistBioProvider {
  id: ArtistBioSource
  fetchBio: (artistName: string) => Promise<ArtistBioResult | null>
}

const ARTIST_BIO_CACHE_TTL_SEC = 30 * 24 * 60 * 60
const ARTIST_BIO_EMPTY_CACHE_TTL_SEC = 6 * 60 * 60
const WIKIPEDIA_LANG = 'en'
export const ARTIST_BIO_MIN_SCORE = 40
const ARTIST_PAGE_VARIANTS = [
  'band',
  'British band',
  'English band',
  'American band',
  'Australian band',
  'Canadian band',
  'Scottish band',
  'Welsh band',
  'Irish band',
  'Swedish band',
  'Norwegian band',
  'German band',
  'French band',
  'Japanese band',
  'musical group',
  'musician',
  'singer',
  'rapper',
]
const MUSIC_HINT_TERMS = [
  'band', 'musician', 'singer', 'rapper', 'songwriter', 'record producer',
  'dj', 'musical group', 'rock', 'metal', 'metalcore', 'album', 'formed',
  'vocalist', 'drummer', 'guitarist', 'bassist', 'discography',
]
const NON_MUSIC_HINT_TERMS = [
  'architect', 'architecture', 'building', 'buildings', 'construction',
  'discipline', 'profession', 'occupation', 'design of buildings',
  'chief builder', 'site surrounding',
]

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleMatchesArtistName(artistName: string, title: string): boolean {
  const normalizedArtist = normalizeSearchText(artistName)
  const normalizedTitle = normalizeSearchText(title)
  return normalizedTitle === normalizedArtist ||
    normalizedTitle.includes(normalizedArtist) ||
    normalizedArtist.includes(normalizedTitle)
}

function sanitizeWikipediaExtract(text: string | null | undefined): string | null {
  const normalized = text?.replace(/\s+/g, ' ').trim()
  return normalized ? normalized : null
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

interface WikipediaSummaryData {
  title: string
  description: string | null
  extract: string | null
  sourceUrl: string | null
  imageUrl: string | null
}

interface WikipediaCandidate extends WikipediaSummaryData {
  snippet?: string | null
}

function countTermHits(text: string, terms: string[]): number {
  return terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0)
}

function scoreWikipediaCandidate(artistName: string, candidate: WikipediaCandidate): number {
  const normalizedArtist = normalizeSearchText(artistName)
  const normalizedTitle = normalizeSearchText(candidate.title)
  const haystack = normalizeSearchText([
    candidate.title,
    candidate.description,
    candidate.extract,
    candidate.snippet,
  ].filter(Boolean).join(' '))

  let score = 0

  if (!titleMatchesArtistName(artistName, candidate.title)) score -= 300
  if (normalizedTitle === normalizedArtist) score += 15
  if (normalizedTitle.startsWith(`${normalizedArtist} (`)) score += 35
  if (/\((?:band|musician|rapper|singer|dj|record producer|songwriter)/i.test(candidate.title)) score += 120

  const musicHits = countTermHits(haystack, MUSIC_HINT_TERMS)
  const nonMusicHits = countTermHits(haystack, NON_MUSIC_HINT_TERMS)

  score += Math.min(musicHits * 30, 150)
  score -= Math.min(nonMusicHits * 60, 240)

  if (musicHits > 0 && nonMusicHits === 0) score += 30
  if (nonMusicHits > 0 && musicHits === 0) score -= 120

  return score
}

function sourceTitleFromWikipediaUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const pathname = new URL(url).pathname
    const raw = pathname.split('/').pop()
    return raw ? decodeURIComponent(raw).replace(/_/g, ' ') : null
  } catch {
    return null
  }
}

function shouldRefreshWikipediaBio(artist: ArtistRowDb): boolean {
  if (!artist.bio) return true

  const candidate: WikipediaCandidate = {
    title: sourceTitleFromWikipediaUrl(artist.bio_url) ?? artist.name,
    description: null,
    extract: artist.bio,
    sourceUrl: artist.bio_url,
    imageUrl: null,
  }

  return scoreWikipediaCandidate(artist.name, candidate) < ARTIST_BIO_MIN_SCORE
}

async function fetchWikipediaPageSummaryData(title: string): Promise<WikipediaSummaryData | null> {
  const res = await fetch(
    `https://${WIKIPEDIA_LANG}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { 'User-Agent': 'Puros/1.0' } },
  )

  if (!res.ok) {
    return fetchWikipediaPageQueryData(title)
  }

  const data = await res.json() as {
    type?: string
    extract?: string
    description?: string
    titles?: { normalized?: string }
    content_urls?: { desktop?: { page?: string } }
    originalimage?: { source?: string }
    thumbnail?: { source?: string }
  }

  if (data.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') {
    return fetchWikipediaPageQueryData(title)
  }

  const extract = sanitizeWikipediaExtract(data.extract)
  if (!extract) {
    return fetchWikipediaPageQueryData(title)
  }

  return {
    title: data.titles?.normalized ?? title,
    description: data.description?.trim() ?? null,
    extract,
    sourceUrl: data.content_urls?.desktop?.page ?? null,
    imageUrl: data.originalimage?.source ?? data.thumbnail?.source ?? null,
  }
}

async function fetchWikipediaPageQueryData(title: string): Promise<WikipediaSummaryData | null> {
  const res = await fetch(
    `https://${WIKIPEDIA_LANG}.wikipedia.org/w/api.php?action=query&prop=extracts|pageimages|info|description&titles=${encodeURIComponent(title)}&redirects=1&exintro=1&explaintext=1&inprop=url&pithumbsize=1200&format=json`,
    { headers: { 'User-Agent': 'Puros/1.0' } },
  )
  if (!res.ok) return fetchWikipediaPageHtmlData(title)

  const data = await res.json() as {
    query?: {
      pages?: Record<string, {
        title?: string
        description?: string
        extract?: string
        fullurl?: string
        thumbnail?: { source?: string }
      }>
    }
  }

  const pages = Object.values(data.query?.pages ?? {})
  const page = pages.find((candidate) => !!candidate.title && !candidate.title.startsWith('Special:'))
  const extract = sanitizeWikipediaExtract(page?.extract)
  if (!page?.title || !extract) return fetchWikipediaPageHtmlData(title)

  return {
    title: page.title,
    description: page.description?.trim() ?? null,
    extract,
    sourceUrl: page.fullurl ?? null,
    imageUrl: page.thumbnail?.source ?? null,
  }
}

async function fetchWikipediaPageHtmlData(title: string): Promise<WikipediaSummaryData | null> {
  const url = `https://${WIKIPEDIA_LANG}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Puros/1.0' },
  })
  if (!res.ok) return null

  const html = await res.text()
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
  const pageTitle = titleMatch?.[1]
    ?.replace(/\s*-\s*Wikipedia\s*$/i, '')
    ?.trim()
    ?? title

  const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/gi)]
    .map((match) => match[1] ?? '')
    .map((paragraph) => decodeHtmlEntities(
      paragraph
        .replace(/<sup[\s\S]*?<\/sup>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ))
    .filter((paragraph) => paragraph.length >= 80)

  const extract = sanitizeWikipediaExtract(paragraphs[0] ?? null)
  if (!extract) return null

  return {
    title: pageTitle,
    description: null,
    extract,
    sourceUrl: url,
    imageUrl: null,
  }
}

async function fetchWikipediaSearchCandidates(artistName: string): Promise<Array<{ title: string; snippet: string | null }>> {
  const res = await fetch(
    `https://${WIKIPEDIA_LANG}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`"${artistName}" band music musician singer rapper songwriter`)}&srlimit=5&format=json`,
    { headers: { 'User-Agent': 'Puros/1.0' } },
  )
  if (!res.ok) return []

  const data = await res.json() as {
    query?: { search?: Array<{ title: string; snippet?: string }> }
  }

  return (data.query?.search ?? []).map((entry) => ({
    title: entry.title,
    snippet: entry.snippet?.replace(/<[^>]+>/g, ' ') ?? null,
  }))
}

export async function fetchBestWikipediaArtistCandidate(
  artistName: string,
  options?: { preferredTitles?: string[] | null },
): Promise<{ candidate: WikipediaCandidate | null; score: number }> {
  const candidateMap = new Map<string, WikipediaCandidate>()
  const seedTitles = [
    ...(options?.preferredTitles ?? []),
    artistName,
    ...ARTIST_PAGE_VARIANTS.map((variant) => `${artistName} (${variant})`),
  ]

  for (const title of seedTitles) {
    const summary = await fetchWikipediaPageSummaryData(title)
    if (summary) candidateMap.set(summary.title, summary)
  }

  const searchCandidates = await fetchWikipediaSearchCandidates(artistName)
  for (const searchCandidate of searchCandidates) {
    const summary = await fetchWikipediaPageSummaryData(searchCandidate.title)
    if (!summary) continue
    const existing = candidateMap.get(summary.title)
    candidateMap.set(summary.title, {
      ...summary,
      snippet: existing?.snippet ?? searchCandidate.snippet,
    })
  }

  const ranked = [...candidateMap.values()]
    .filter((candidate) => titleMatchesArtistName(artistName, candidate.title))
    .map((candidate) => ({ candidate, score: scoreWikipediaCandidate(artistName, candidate) }))
    .sort((a, b) => b.score - a.score)

  return {
    candidate: ranked[0]?.candidate ?? null,
    score: ranked[0]?.score ?? -Infinity,
  }
}

async function fetchWikipediaBio(artistName: string): Promise<ArtistBioResult | null> {
  const { candidate: best, score: bestScore } = await fetchBestWikipediaArtistCandidate(artistName)
  const bio = sanitizeWikipediaExtract(best?.extract)
  if (!best || !bio || bestScore < ARTIST_BIO_MIN_SCORE) return null

  return {
    bio,
    genres: null,
    sourceUrl: best.sourceUrl,
    imageUrl: best.imageUrl,
  }
}

async function fetchWikipediaBioWithSeedTitles(
  artistName: string,
  preferredTitles?: string[] | null,
): Promise<ArtistBioResult | null> {
  const { candidate: best, score: bestScore } = await fetchBestWikipediaArtistCandidate(artistName, { preferredTitles })
  const bio = sanitizeWikipediaExtract(best?.extract)
  if (!best || !bio || bestScore < ARTIST_BIO_MIN_SCORE) return null

  return {
    bio,
    genres: null,
    sourceUrl: best.sourceUrl,
    imageUrl: best.imageUrl,
  }
}

const MA_USER_AGENT = 'Puros/1.0 (personal music player; not scraping en masse)'
const MA_REQUEST_INTERVAL_MS = 1500
let maNextAllowedAt = 0

async function maThrottle() {
  const wait = maNextAllowedAt - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  maNextAllowedAt = Date.now() + MA_REQUEST_INTERVAL_MS
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fetchMetalArchivesBio(artistName: string): Promise<ArtistBioResult | null> {
  try {
    await maThrottle()
    const searchRes = await fetch(
      `https://www.metal-archives.com/search/ajax-band-search/field/name/query/${encodeURIComponent(artistName)}`,
      { headers: { 'User-Agent': MA_USER_AGENT, 'Accept': 'application/json' } },
    )
    if (!searchRes.ok) return null

    const searchData = await searchRes.json() as {
      aaData?: Array<[string, string, string]>
    }

    const rows = searchData.aaData ?? []
    if (!rows.length) return null

    // Each row: [link_html, genres, country]
    // link_html e.g. <a href="https://www.metal-archives.com/bands/Metallica/138">Metallica</a>
    const normalizedQuery = artistName.toLowerCase().replace(/[^a-z0-9]/g, '')
    let bestRow: [string, string, string] | null = null
    for (const row of rows) {
      const nameMatch = row[0].match(/>([^<]+)<\/a>/)
      if (!nameMatch) continue
      const candidateName = nameMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '')
      if (candidateName === normalizedQuery) { bestRow = row; break }
      if (!bestRow && (candidateName.includes(normalizedQuery) || normalizedQuery.includes(candidateName))) {
        bestRow = row
      }
    }
    if (!bestRow) return null

    const idMatch = bestRow[0].match(/\/bands\/[^/]+\/(\d+)/)
    const bandId = idMatch?.[1]
    const bandUrl = bestRow[0].match(/href="([^"]+)"/)?.[1] ?? null
    if (!bandId) return null

    const genreRaw = bestRow[1] ?? ''
    const genres = genreRaw ? genreRaw.split(/[,/]/).map((g) => g.trim()).filter(Boolean) : null

    await maThrottle()
    const bioRes = await fetch(
      `https://www.metal-archives.com/band/read-more/id/${bandId}`,
      { headers: { 'User-Agent': MA_USER_AGENT, 'Accept': 'text/html' } },
    )
    if (!bioRes.ok) return { bio: null, genres, sourceUrl: bandUrl, imageUrl: null }

    const bioHtml = await bioRes.text()
    const bio = stripHtmlTags(bioHtml).trim() || null

    return { bio, genres, sourceUrl: bandUrl, imageUrl: null }
  } catch (err) {
    console.warn('[metal-archives] fetch error:', err)
    return null
  }
}

const artistBioProviders: Record<ArtistBioSource, ArtistBioProvider> = {
  none: {
    id: 'none',
    fetchBio: async () => ({ bio: null, genres: null, sourceUrl: null, imageUrl: null }),
  },
  wikipedia: {
    id: 'wikipedia',
    fetchBio: fetchWikipediaBio,
  },
  'metal-archives': {
    id: 'metal-archives',
    fetchBio: fetchMetalArchivesBio,
  },
}

interface ArtistRowDb {
  id: string
  name: string
  normalized_name: string | null
  art_path: string | null
  artwork_id: string | null
  art_source: string | null
  bio: string | null
  bio_source: string | null
  bio_url: string | null
  bio_fetched_at: number | null
  genres: string | null
  album_count: number
  track_count: number
}

export function getArtistRowById(db: Database.Database, artistId: string): ArtistRowDb | null {
  return (db.prepare(`
    SELECT ar.id, ar.name, ar.normalized_name, ar.art_path, ar.artwork_id, ar.art_source, ar.bio, ar.bio_source,
           ar.bio_url, ar.bio_fetched_at, ar.genres,
           COUNT(DISTINCT al.id) as album_count,
           COUNT(DISTINCT t.id) as track_count
    FROM artists ar
    LEFT JOIN albums al ON al.album_artist_id = ar.id
    LEFT JOIN tracks t ON t.artist_id = ar.id
    WHERE ar.id = ?
    GROUP BY ar.id
  `).get(artistId) as ArtistRowDb | undefined) ?? null
}

export async function ensureArtistProfile(db: Database.Database, artistId: string): Promise<ArtistRowDb | null> {
  const artist = getArtistRowById(db, artistId)
  if (!artist) return null

  const source = getArtistBioSource(db)
  if (source === 'none') return artist

  const nowSec = Math.floor(Date.now() / 1000)
  const isFresh = artist.bio_source === source &&
    artist.bio_fetched_at != null &&
    nowSec - artist.bio_fetched_at < ARTIST_BIO_CACHE_TTL_SEC

  if (isFresh && !(source === 'wikipedia' && shouldRefreshWikipediaBio(artist))) return artist

  const provider = artistBioProviders[source]
  if (!provider) return artist

  try {
    const result = await provider.fetchBio(artist.name)
    db.prepare(`
      UPDATE artists
      SET bio = ?, bio_source = ?, bio_url = ?, bio_fetched_at = ?, genres = COALESCE(?, genres)
      WHERE id = ?
    `).run(
      result?.bio ?? null,
      source,
      result?.sourceUrl ?? null,
      nowSec,
      result?.genres ? JSON.stringify(result.genres) : null,
      artistId,
    )
  } catch (err) {
    console.warn(`[artist-bio] ${artist.name}:`, err)
  }

  return getArtistRowById(db, artistId)
}

async function ensureCatalogArtistWikipediaBio(db: Database.Database, catalogArtistId: string): Promise<void> {
  const selectArtist = db.prepare(`
    SELECT id, name, mb_artist_id
    FROM catalog_artists
    WHERE id = ?
    LIMIT 1
  `)
  const artist = selectArtist.get(catalogArtistId) as { id: string; name: string; mb_artist_id: string | null } | undefined
  if (!artist) return

  const existing = db.prepare(`
    SELECT fetched_at, bio
    FROM catalog_artist_bios
    WHERE catalog_artist_id = ? AND provider = 'wikipedia'
    LIMIT 1
  `).get(catalogArtistId) as { fetched_at: number | null; bio: string | null } | undefined

  const nowSec = Math.floor(Date.now() / 1000)
  const ttl = existing?.bio ? ARTIST_BIO_CACHE_TTL_SEC : ARTIST_BIO_EMPTY_CACHE_TTL_SEC
  if (existing?.fetched_at && nowSec - existing.fetched_at < ttl) return

  const provider = artistBioProviders.wikipedia
  if (!provider) return

  try {
    const preferredTitles = artist.mb_artist_id
      ? await musicBrainzSpineClient.getArtistWikipediaSeedTitles(artist.mb_artist_id).catch(() => [])
      : []
    const result = await fetchWikipediaBioWithSeedTitles(artist.name, preferredTitles)
    const stillExists = selectArtist.get(catalogArtistId) as { id: string; name: string; mb_artist_id: string | null } | undefined
    if (!stillExists) return
    db.prepare(`
      INSERT INTO catalog_artist_bios (
        catalog_artist_id, provider, bio, bio_url, genres_json, fetched_at
      ) VALUES (?, 'wikipedia', ?, ?, ?, ?)
      ON CONFLICT(catalog_artist_id, provider) DO UPDATE SET
        bio = excluded.bio,
        bio_url = excluded.bio_url,
        genres_json = COALESCE(excluded.genres_json, catalog_artist_bios.genres_json),
        fetched_at = excluded.fetched_at
    `).run(
      catalogArtistId,
      result?.bio ?? null,
      result?.sourceUrl ?? null,
      result?.genres ? JSON.stringify(result.genres) : null,
      nowSec,
    )
    upsertCatalogFieldProvenance(db, 'artist', catalogArtistId, 'bio', 'wikipedia', {
      value: result?.bio ?? null,
      confidence: result?.bio ? 0.8 : 0,
      fetchedAt: nowSec,
    })
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message)) return
    console.warn(`[catalog-artist-bio] ${artist.name}:`, err)
  }
}

async function ensureCatalogArtistMetalArchivesBio(db: Database.Database, catalogArtistId: string): Promise<void> {
  const artist = db.prepare(`SELECT id, name FROM catalog_artists WHERE id = ? LIMIT 1`)
    .get(catalogArtistId) as { id: string; name: string } | undefined
  if (!artist) return

  const existing = db.prepare(`
    SELECT fetched_at, bio FROM catalog_artist_bios
    WHERE catalog_artist_id = ? AND provider = 'metal-archives' LIMIT 1
  `).get(catalogArtistId) as { fetched_at: number | null; bio: string | null } | undefined

  const nowSec = Math.floor(Date.now() / 1000)
  const ttl = existing?.bio ? ARTIST_BIO_CACHE_TTL_SEC : ARTIST_BIO_EMPTY_CACHE_TTL_SEC
  if (existing?.fetched_at && nowSec - existing.fetched_at < ttl) return

  try {
    const result = await fetchMetalArchivesBio(artist.name)
    const stillExists = db.prepare(`SELECT id FROM catalog_artists WHERE id = ? LIMIT 1`).get(catalogArtistId)
    if (!stillExists) return
    db.prepare(`
      INSERT INTO catalog_artist_bios (
        catalog_artist_id, provider, bio, bio_url, genres_json, fetched_at
      ) VALUES (?, 'metal-archives', ?, ?, ?, ?)
      ON CONFLICT(catalog_artist_id, provider) DO UPDATE SET
        bio = excluded.bio,
        bio_url = excluded.bio_url,
        genres_json = COALESCE(excluded.genres_json, catalog_artist_bios.genres_json),
        fetched_at = excluded.fetched_at
    `).run(
      catalogArtistId,
      result?.bio ?? null,
      result?.sourceUrl ?? null,
      result?.genres ? JSON.stringify(result.genres) : null,
      nowSec,
    )
    upsertCatalogFieldProvenance(db, 'artist', catalogArtistId, 'bio', 'metal-archives', {
      value: result?.bio ?? null,
      confidence: result?.bio ? 0.85 : 0,
      fetchedAt: nowSec,
    })
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message)) return
    console.warn(`[metal-archives-bio] ${artist.name}:`, err)
  }
}

async function ensureCatalogProviderBio(
  db: Database.Database,
  catalogArtistId: string,
  providerId: string,
): Promise<void> {
  const source = db.prepare(`
    SELECT source_id FROM catalog_artist_sources
    WHERE catalog_artist_id = ? AND provider = ? AND available = 1
    LIMIT 1
  `).get(catalogArtistId, providerId) as { source_id: string } | undefined
  if (!source) return
  const existing = db.prepare(`
    SELECT fetched_at, bio FROM catalog_artist_bios
    WHERE catalog_artist_id = ? AND provider = ? LIMIT 1
  `).get(catalogArtistId, providerId) as { fetched_at: number | null; bio: string | null } | undefined
  const nowSec = Math.floor(Date.now() / 1000)
  const ttl = existing?.bio ? ARTIST_BIO_CACHE_TTL_SEC : ARTIST_BIO_EMPTY_CACHE_TTL_SEC
  if (existing?.fetched_at && nowSec - existing.fetched_at < ttl) return

  const response = await invokeProvider(providerId, 'metadata.bio', 'getBio', [{
    entityType: 'artist',
    sourceId: source.source_id,
  }])
  if (!response.ok) return
  const result = response.value as { text?: unknown; sourceUrl?: unknown; genres?: unknown } | null | undefined
  const bio = typeof result?.text === 'string' ? result.text : null
  const bioUrl = typeof result?.sourceUrl === 'string' ? result.sourceUrl : null
  const genres = Array.isArray(result?.genres)
    ? result.genres.filter((value): value is string => typeof value === 'string')
    : null
  db.prepare(`
    INSERT INTO catalog_artist_bios (catalog_artist_id, provider, bio, bio_url, genres_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(catalog_artist_id, provider) DO UPDATE SET
      bio = excluded.bio,
      bio_url = excluded.bio_url,
      genres_json = COALESCE(excluded.genres_json, catalog_artist_bios.genres_json),
      fetched_at = excluded.fetched_at
  `).run(catalogArtistId, providerId, bio, bioUrl, genres ? JSON.stringify(genres) : null, nowSec)
  upsertCatalogFieldProvenance(db, 'artist', catalogArtistId, 'bio', providerId, {
    value: bio,
    confidence: bio ? 0.9 : 0,
    fetchedAt: nowSec,
  })
}

export async function ensureCatalogArtistBioPriority(db: Database.Database, catalogArtistId: string, options?: { force?: boolean }): Promise<void> {
  const priority = getArtistBioSourcePriority(db)
  if (options?.force) {
    for (const provider of priority.filter((source) => source !== 'none')) {
      db.prepare(`UPDATE catalog_artist_bios SET fetched_at = NULL WHERE catalog_artist_id = ? AND provider = ?`).run(catalogArtistId, provider)
    }
  }
  for (const provider of priority) {
    if (provider === 'none') break
    if (provider === 'wikipedia') await ensureCatalogArtistWikipediaBio(db, catalogArtistId)
    else if (provider === 'metal-archives') await ensureCatalogArtistMetalArchivesBio(db, catalogArtistId)
    else await ensureCatalogProviderBio(db, catalogArtistId, provider)
  }
}

function normalizeArtworkMatchText(value: string | null | undefined): string {
  return normalizeSearchText(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeAlbumMatchTitle(value: string | null | undefined): string {
  return normalizeArtworkMatchText(value)
    .replace(/\b(deluxe|expanded|remaster|remastered|anniversary|edition|version|bonus)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function titlesLikelyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const normalizedA = normalizeAlbumMatchTitle(a)
  const normalizedB = normalizeAlbumMatchTitle(b)
  return !!normalizedA && !!normalizedB && (
    normalizedA === normalizedB ||
    normalizedA.includes(normalizedB) ||
    normalizedB.includes(normalizedA)
  )
}

export function namesLikelyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const normalizedA = normalizeArtworkMatchText(a)
  const normalizedB = normalizeArtworkMatchText(b)
  return !!normalizedA && !!normalizedB && (
    normalizedA === normalizedB ||
    normalizedA.includes(normalizedB) ||
    normalizedB.includes(normalizedA)
  )
}
