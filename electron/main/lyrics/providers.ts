import type {
  LyricsProviderFetchRequest,
  LyricsProviderFetchResult,
  LyricsProviderId,
  LyricsProviderTestResult,
  LyricsTrackPayload,
} from '../../../src/renderer/components/NowPlaying/LyricsProviderService'
import { getDb } from '../db'
import { getLyricsProviderApiKey } from '../settings/store'

type LyricsMatcher = (a: string | null | undefined, b: string | null | undefined) => boolean

let titlesLikelyMatch: LyricsMatcher
let namesLikelyMatch: LyricsMatcher

export function configureLyricsProviders(deps: {
  titlesLikelyMatch: LyricsMatcher
  namesLikelyMatch: LyricsMatcher
}) {
  titlesLikelyMatch = deps.titlesLikelyMatch
  namesLikelyMatch = deps.namesLikelyMatch
}

function buildLyricsResult(
  providerId: LyricsProviderId,
  kind: Exclude<LyricsProviderFetchResult['kind'], 'none'>,
  text: string,
): LyricsProviderFetchResult {
  return {
    providerId,
    kind,
    syncedText: kind === 'timed' ? text : null,
    plainText: kind === 'static' ? text : null,
  }
}

function normalizeLyricsBody(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\r/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s+|\s+$/g, '')
}

function sanitizeMusixmatchLyrics(value: string | null | undefined): string {
  return normalizeLyricsBody(value)
    .replace(/\*{7,}.*?Commercial use.*$/is, '')
    .trim()
}

function decodeLyricsHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
  .trim()
}

function htmlToPlainText(value: string): string {
  return decodeLyricsHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n'),
  )
}

function extractGeniusLyricsFromHtml(html: string): string | null {
  const blocks = [...html.matchAll(/<div[^>]+data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi)]
  if (blocks.length === 0) return null

  const text = blocks
    .map((match) => htmlToPlainText(match[1] ?? ''))
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text || null
}

export function resolveLyricsApiKey(
  provider: LyricsProviderId,
  explicitApiKey: string | null | undefined,
): string {
  const direct = explicitApiKey?.trim()
  if (direct) return direct
  if (provider === 'lrclib') return ''
  return getLyricsProviderApiKey(getDb(), provider)
}

async function fetchLrclibLyrics(track: LyricsTrackPayload): Promise<LyricsProviderFetchResult | null> {
  const directUrl = new URL('https://lrclib.net/api/get')
  directUrl.searchParams.set('track_name', track.title)
  directUrl.searchParams.set('artist_name', track.artist)
  if (track.album) directUrl.searchParams.set('album_name', track.album)
  if (track.duration > 0) directUrl.searchParams.set('duration', String(Math.round(track.duration)))

  const directResponse = await fetch(directUrl, {
    headers: { 'User-Agent': 'Puros/1.0' },
  })

  if (directResponse.ok) {
    const payload = await directResponse.json() as {
      syncedLyrics?: string | null
      plainLyrics?: string | null
    }
    const syncedLyrics = normalizeLyricsBody(payload.syncedLyrics)
    if (syncedLyrics) return buildLyricsResult('lrclib', 'timed', syncedLyrics)

    const plainLyrics = normalizeLyricsBody(payload.plainLyrics)
    if (plainLyrics) return buildLyricsResult('lrclib', 'static', plainLyrics)
  }

  const searchUrl = new URL('https://lrclib.net/api/search')
  searchUrl.searchParams.set('track_name', track.title)
  searchUrl.searchParams.set('artist_name', track.artist)
  const searchResponse = await fetch(searchUrl, {
    headers: { 'User-Agent': 'Puros/1.0' },
  })

  if (!searchResponse.ok) return null

  const results = await searchResponse.json() as Array<{
    trackName?: string
    artistName?: string
    syncedLyrics?: string | null
    plainLyrics?: string | null
  }>

  const match = results.find((candidate) =>
    titlesLikelyMatch(candidate.trackName, track.title) &&
    namesLikelyMatch(candidate.artistName, track.artist),
  ) ?? results[0]

  if (!match) return null

  const syncedLyrics = normalizeLyricsBody(match.syncedLyrics)
  if (syncedLyrics) return buildLyricsResult('lrclib', 'timed', syncedLyrics)

  const plainLyrics = normalizeLyricsBody(match.plainLyrics)
  if (plainLyrics) return buildLyricsResult('lrclib', 'static', plainLyrics)

  return null
}

async function fetchMusixmatchPayload(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<unknown> {
  const url = new URL(`https://api.musixmatch.com/ws/1.1/${endpoint}`)
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value)
  })
  url.searchParams.set('apikey', apiKey)

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Puros/1.0' },
  })
  if (!response.ok) throw new Error(`Musixmatch HTTP ${response.status}`)

  const payload = await response.json() as {
    message?: {
      header?: { status_code?: number }
      body?: unknown
    }
  }
  const status = payload.message?.header?.status_code ?? response.status
  if (status !== 200) {
    if (status === 404) return null
    throw new Error(`Musixmatch ${status}`)
  }

  return payload
}

async function fetchMusixmatchLyrics(
  track: LyricsTrackPayload,
  apiKey: string,
): Promise<LyricsProviderFetchResult | null> {
  if (!apiKey) return null

  const subtitlePayload = await fetchMusixmatchPayload('matcher.subtitle.get', {
    q_track: track.title,
    q_artist: track.artist,
    q_album: track.album,
    f_subtitle_length: track.duration > 0 ? String(Math.round(track.duration)) : '',
  }, apiKey) as {
    message?: {
      body?: {
        subtitle?: {
          subtitle_body?: string | null
        } | null
      }
    }
  } | null

  const subtitleBody = normalizeLyricsBody(subtitlePayload?.message?.body?.subtitle?.subtitle_body)
  if (subtitleBody) return buildLyricsResult('musixmatch', 'timed', subtitleBody)

  const lyricsPayload = await fetchMusixmatchPayload('matcher.lyrics.get', {
    q_track: track.title,
    q_artist: track.artist,
    q_album: track.album,
  }, apiKey) as {
    message?: {
      body?: {
        lyrics?: {
          lyrics_body?: string | null
        } | null
      }
    }
  } | null

  const lyricsBody = sanitizeMusixmatchLyrics(lyricsPayload?.message?.body?.lyrics?.lyrics_body)
  if (lyricsBody) return buildLyricsResult('musixmatch', 'static', lyricsBody)

  return null
}

async function fetchGeniusLyrics(
  track: LyricsTrackPayload,
  apiKey: string,
): Promise<LyricsProviderFetchResult | null> {
  if (!apiKey) return null

  const searchUrl = new URL('https://api.genius.com/search')
  searchUrl.searchParams.set('q', [track.artist, track.title].filter(Boolean).join(' '))

  const response = await fetch(searchUrl, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'Puros/1.0',
    },
  })
  if (!response.ok) throw new Error(`Genius HTTP ${response.status}`)

  const payload = await response.json() as {
    response?: {
      hits?: Array<{
        type?: string
        result?: {
          title?: string
          full_title?: string
          url?: string
          primary_artist?: { name?: string }
        }
      }>
    }
  }

  const hits = (payload.response?.hits ?? [])
    .filter((hit) => hit.type === 'song' && hit.result?.url)
    .map((hit) => hit.result!)

  const match = hits.find((candidate) =>
    titlesLikelyMatch(candidate.title ?? candidate.full_title, track.title) &&
    namesLikelyMatch(candidate.primary_artist?.name, track.artist),
  ) ?? hits[0]

  if (!match?.url) return null

  const pageResponse = await fetch(match.url, {
    headers: { 'User-Agent': 'Puros/1.0' },
  })
  if (!pageResponse.ok) throw new Error(`Genius page HTTP ${pageResponse.status}`)

  const lyrics = extractGeniusLyricsFromHtml(await pageResponse.text())
  if (!lyrics) return null

  return buildLyricsResult('genius', 'static', lyrics)
}

export async function fetchLyricsForProvider(
  track: LyricsTrackPayload,
  provider: LyricsProviderId,
  apiKey: string,
): Promise<LyricsProviderFetchResult | null> {
  if (provider === 'lrclib') return fetchLrclibLyrics(track)
  if (provider === 'musixmatch') return fetchMusixmatchLyrics(track, apiKey)
  return fetchGeniusLyrics(track, apiKey)
}

export async function resolveLyrics(
  payload: LyricsProviderFetchRequest,
): Promise<LyricsProviderFetchResult> {
  const providers = payload.providers.filter((provider) => provider.enabled)

  for (const provider of providers) {
    try {
      const apiKey = resolveLyricsApiKey(provider.id, provider.apiKey)
      if (provider.id !== 'lrclib' && !apiKey) continue
      const result = await fetchLyricsForProvider(payload.track, provider.id, apiKey)
      if (result) return result
    } catch (error) {
      console.warn(`[Puros][Lyrics] ${provider.id} failed:`, error)
    }
  }

  return {
    providerId: null,
    kind: 'none',
    syncedText: null,
    plainText: null,
  } satisfies LyricsProviderFetchResult
}

export async function testLyricsProvider(
  provider: LyricsProviderId,
  apiKey?: string,
): Promise<LyricsProviderTestResult> {
  try {
    const resolvedApiKey = resolveLyricsApiKey(provider, apiKey)
    if (provider !== 'lrclib' && !resolvedApiKey) {
      return {
        ok: false,
        message: 'API key required',
      } satisfies LyricsProviderTestResult
    }

    const probeTrack: LyricsTrackPayload = {
      id: 'lyrics-test',
      title: 'Yellow',
      artist: 'Coldplay',
      album: 'Parachutes',
      duration: 269,
    }

    await fetchLyricsForProvider(probeTrack, provider, resolvedApiKey)

    return {
      ok: true,
      message: 'Connection OK',
    } satisfies LyricsProviderTestResult
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    } satisfies LyricsProviderTestResult
  }
}
