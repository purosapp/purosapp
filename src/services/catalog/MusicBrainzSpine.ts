import type { CanonicalMatchStatus } from './types'

function normalize(value: string | null | undefined) {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value))
}

function statusFromScore(score: number): CanonicalMatchStatus {
  if (score >= 0.92) return 'matched_high'
  if (score >= 0.78) return 'matched_low'
  if (score >= 0.6) return 'candidate'
  return 'none'
}

function quoteTerm(term: string) {
  return `"${term.replace(/"/g, '\\"')}"`
}

export interface ArtistMatchResult {
  status: CanonicalMatchStatus
  confidence: number
  artistId: string | null
}

export interface AlbumMatchResult {
  status: CanonicalMatchStatus
  confidence: number
  releaseGroupId: string | null
  releaseId: string | null
}

export interface TrackMatchResult {
  status: CanonicalMatchStatus
  confidence: number
  recordingId: string | null
  releaseId: string | null
}

type ArtistSearchResponse = {
  artists?: Array<{
    id: string
    name?: string | null
    disambiguation?: string | null
    type?: string | null
  }>
}

type ReleaseGroupSearchResponse = {
  'release-groups'?: Array<{
    id: string
    title?: string | null
    'primary-type'?: string | null
    'artist-credit'?: Array<{ name?: string | null; artist?: { id?: string | null; name?: string | null } | null }>
  }>
}

type ReleaseSearchResponse = {
  releases?: Array<{ id: string }>
}

type RecordingSearchResponse = {
  recordings?: Array<{
    id: string
    title?: string | null
    length?: number | null
    releases?: Array<{ id?: string | null; title?: string | null }>
    'artist-credit'?: Array<{ name?: string | null; artist?: { id?: string | null; name?: string | null } | null }>
  }>
}

type ArtistLookupResponse = {
  genres?: Array<{
    name?: string | null
    count?: number | null
  }>
  tags?: Array<{
    name?: string | null
    count?: number | null
  }>
  relations?: Array<{
    type?: string | null
    url?: { resource?: string | null } | null
  }>
}

function wikipediaTitleFromUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    if (!/wikipedia\.org$/i.test(parsed.hostname)) return null
    const raw = parsed.pathname.split('/').filter(Boolean).pop()
    return raw ? decodeURIComponent(raw).replace(/_/g, ' ') : null
  } catch {
    return null
  }
}

export class MusicBrainzSpineClient {
  private nextAllowedRequestAt = 0

  constructor(
    private readonly options: {
      userAgent?: string
      minIntervalMs?: number
    } = {},
  ) {}

  private async throttle() {
    const now = Date.now()
    const waitMs = this.nextAllowedRequestAt - now
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
    this.nextAllowedRequestAt = Date.now() + (this.options.minIntervalMs ?? 1100)
  }

  private async request<T>(path: string, query: Record<string, string | number | null | undefined>): Promise<T | null> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue
      params.set(key, String(value))
    }

    await this.throttle()
    const response = await fetch(`https://musicbrainz.org/ws/2/${path}?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': this.options.userAgent ?? 'Puros/1.0 ( metadata spine )',
      },
    })

    if (!response.ok) return null
    return await response.json() as T
  }

  async matchArtist(name: string): Promise<ArtistMatchResult> {
    const normalizedName = normalize(name)
    if (!normalizedName) {
      return { status: 'none', confidence: 0, artistId: null }
    }

    const data = await this.request<ArtistSearchResponse>('artist', {
      query: `artist:${quoteTerm(name)}`,
      fmt: 'json',
      limit: 5,
    })

    const candidates = data?.artists ?? []
    let best: { id: string; score: number } | null = null
    for (const candidate of candidates) {
      const candidateName = normalize(candidate.name)
      if (!candidateName) continue

      let score = 0
      if (candidateName === normalizedName) score += 0.82
      else if (candidateName.startsWith(normalizedName) || normalizedName.startsWith(candidateName)) score += 0.68
      else if (candidateName.includes(normalizedName) || normalizedName.includes(candidateName)) score += 0.58

      if (candidate.type && /group|person|orchestra|choir|character/i.test(candidate.type)) score += 0.06
      if (candidate.disambiguation && /band|musician|rapper|singer|composer|dj|producer/i.test(candidate.disambiguation)) score += 0.06

      score = clamp(score)
      if (!best || score > best.score) {
        best = { id: candidate.id, score }
      }
    }

    return {
      status: statusFromScore(best?.score ?? 0),
      confidence: best?.score ?? 0,
      artistId: best?.id ?? null,
    }
  }

  async matchAlbum(input: {
    title: string
    artistName?: string | null
    mbArtistId?: string | null
  }): Promise<AlbumMatchResult> {
    const normalizedTitle = normalize(input.title)
    if (!normalizedTitle) {
      return { status: 'none', confidence: 0, releaseGroupId: null, releaseId: null }
    }

    const query = input.mbArtistId
      ? `releasegroup:${quoteTerm(input.title)} AND arid:${input.mbArtistId}`
      : input.artistName
        ? `releasegroup:${quoteTerm(input.title)} AND artist:${quoteTerm(input.artistName)}`
        : `releasegroup:${quoteTerm(input.title)}`

    const data = await this.request<ReleaseGroupSearchResponse>('release-group', {
      query,
      fmt: 'json',
      limit: 5,
    })

    const candidates = data?.['release-groups'] ?? []
    let best: { id: string; score: number } | null = null
    for (const candidate of candidates) {
      const candidateTitle = normalize(candidate.title)
      if (!candidateTitle) continue

      let score = 0
      if (candidateTitle === normalizedTitle) score += 0.68
      else if (candidateTitle.startsWith(normalizedTitle) || normalizedTitle.startsWith(candidateTitle)) score += 0.56
      else if (candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle)) score += 0.42

      const creditNames = (candidate['artist-credit'] ?? [])
        .map((credit) => normalize(credit.artist?.name ?? credit.name))
        .filter(Boolean)
      if (input.mbArtistId && (candidate['artist-credit'] ?? []).some((credit) => credit.artist?.id === input.mbArtistId)) {
        score += 0.22
      } else if (input.artistName && creditNames.some((name) => name === normalize(input.artistName))) {
        score += 0.18
      }

      if (candidate['primary-type']) score += 0.04
      score = clamp(score)
      if (!best || score > best.score) best = { id: candidate.id, score }
    }

    let releaseId: string | null = null
    if (best?.id && best.score >= 0.78) {
      const releaseData = await this.request<ReleaseSearchResponse>('release', {
        query: `rgid:${best.id}`,
        fmt: 'json',
        limit: 1,
      })
      releaseId = releaseData?.releases?.[0]?.id ?? null
    }

    return {
      status: statusFromScore(best?.score ?? 0),
      confidence: best?.score ?? 0,
      releaseGroupId: best?.id ?? null,
      releaseId,
    }
  }

  async matchTrack(input: {
    title: string
    artistName?: string | null
    albumTitle?: string | null
    durationMs?: number | null
    mbArtistId?: string | null
  }): Promise<TrackMatchResult> {
    const normalizedTitle = normalize(input.title)
    if (!normalizedTitle) {
      return { status: 'none', confidence: 0, recordingId: null, releaseId: null }
    }

    const terms = [`recording:${quoteTerm(input.title)}`]
    if (input.mbArtistId) terms.push(`arid:${input.mbArtistId}`)
    else if (input.artistName) terms.push(`artist:${quoteTerm(input.artistName)}`)
    if (input.albumTitle) terms.push(`release:${quoteTerm(input.albumTitle)}`)

    const data = await this.request<RecordingSearchResponse>('recording', {
      query: terms.join(' AND '),
      fmt: 'json',
      limit: 5,
    })

    const candidates = data?.recordings ?? []
    let best: { id: string; score: number; releaseId: string | null } | null = null
    for (const candidate of candidates) {
      const candidateTitle = normalize(candidate.title)
      if (!candidateTitle) continue

      let score = 0
      if (candidateTitle === normalizedTitle) score += 0.56
      else if (candidateTitle.startsWith(normalizedTitle) || normalizedTitle.startsWith(candidateTitle)) score += 0.44
      else if (candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle)) score += 0.32

      const creditNames = (candidate['artist-credit'] ?? [])
        .map((credit) => normalize(credit.artist?.name ?? credit.name))
        .filter(Boolean)
      if (input.mbArtistId && (candidate['artist-credit'] ?? []).some((credit) => credit.artist?.id === input.mbArtistId)) {
        score += 0.18
      } else if (input.artistName && creditNames.some((name) => name === normalize(input.artistName))) {
        score += 0.14
      }

      const matchingRelease = (candidate.releases ?? []).find((release) =>
        input.albumTitle ? normalize(release.title) === normalize(input.albumTitle) : true,
      ) ?? candidate.releases?.[0]
      if (matchingRelease?.title && input.albumTitle && normalize(matchingRelease.title) === normalize(input.albumTitle)) {
        score += 0.08
      }

      if (input.durationMs && candidate.length) {
        const delta = Math.abs(candidate.length - input.durationMs)
        if (delta <= 2000) score += 0.1
        else if (delta <= 5000) score += 0.05
      }

      score = clamp(score)
      if (!best || score > best.score) {
        best = {
          id: candidate.id,
          score,
          releaseId: matchingRelease?.id ?? null,
        }
      }
    }

    return {
      status: statusFromScore(best?.score ?? 0),
      confidence: best?.score ?? 0,
      recordingId: best?.id ?? null,
      releaseId: best?.releaseId ?? null,
    }
  }

  async getArtistWikipediaSeedTitles(artistId: string): Promise<string[]> {
    if (!artistId) return []

    const data = await this.request<ArtistLookupResponse>(`artist/${encodeURIComponent(artistId)}`, {
      inc: 'url-rels',
      fmt: 'json',
    })

    const titles = new Set<string>()
    for (const relation of data?.relations ?? []) {
      const resource = relation.url?.resource ?? null
      const title = wikipediaTitleFromUrl(resource)
      if (title) titles.add(title)
    }

    return [...titles]
  }

  async getArtistGenres(artistId: string): Promise<string[]> {
    if (!artistId) return []

    const data = await this.request<ArtistLookupResponse>(`artist/${encodeURIComponent(artistId)}`, {
      inc: 'genres+tags',
      fmt: 'json',
    })

    const genreNames = normalizeGenreList(data?.genres)
    if (genreNames.length > 0) return genreNames
    return normalizeGenreList(data?.tags)
  }
}

function normalizeGenreList(values: Array<{ name?: string | null; count?: number | null }> | null | undefined): string[] {
  const seen = new Set<string>()
  const genres: string[] = []
  for (const value of [...(values ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
    const raw = value.name?.trim()
    if (!raw) continue
    const key = normalize(raw)
    if (!key || seen.has(key)) continue
    seen.add(key)
    genres.push(raw)
    if (genres.length >= 5) break
  }
  return genres
}
