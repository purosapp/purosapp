import { createHash } from 'node:crypto'
import type { FormatInfo } from '../../../src/services/local/formats'
import type {
  LiveRadioBrowseOptions,
  LiveRadioDirectoryFilters,
  LiveRadioProbeResult,
  Station,
} from '../../../src/services/liveRadio/types'
import { getDb } from '../db'

type LiveRadioStationRow = {
  id: string
  name: string
  streams_json: string
  default_stream_index: number
  genre_json: string | null
  country: string | null
  country_code: string | null
  language: string | null
  logo_url: string | null
  homepage: string | null
  codec: string | null
  bitrate: number | null
  click_count: number | null
  votes: number | null
  last_check_ok: number | null
  is_custom: number
  is_favorite: number
}

type RadioBrowserStation = {
  stationuuid?: string
  name?: string
  url?: string
  url_resolved?: string
  homepage?: string
  favicon?: string
  tags?: string
  country?: string
  countrycode?: string
  language?: string
  codec?: string
  bitrate?: number
  lastcheckok?: number | boolean
  clickcount?: number
  votes?: number
}

const RADIO_BROWSER_BASE_URLS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://api.radio-browser.info',
] as const
const LIVE_RADIO_FETCH_TIMEOUT_MS = 9000
const LIVE_RADIO_USER_AGENT = 'Puros/1.0 LiveRadio'
const LIVE_RADIO_SUPPORTED_CODECS = new Set(['mp3', 'aac', 'flac', 'm3u8'])

function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseLiveRadioStreams(value: string | null): Station['streams'] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (typeof item === 'string') return { url: item }
        if (!item || typeof item !== 'object') return null
        const stream = item as { url?: unknown; codec?: unknown; bitrate?: unknown }
        const url = typeof stream.url === 'string' ? stream.url : ''
        if (!url) return null
        return {
          url,
          codec: typeof stream.codec === 'string' ? stream.codec : undefined,
          bitrate: typeof stream.bitrate === 'number' ? stream.bitrate : undefined,
        }
      })
      .filter((item): item is Station['streams'][number] => !!item)
  } catch {
    return []
  }
}

function stationRowToStation(row: LiveRadioStationRow): Station {
  return {
    id: row.id,
    name: row.name,
    streams: parseLiveRadioStreams(row.streams_json),
    defaultStreamIndex: Math.max(0, row.default_stream_index ?? 0),
    genre: parseJsonArray(row.genre_json),
    country: row.country ?? undefined,
    countryCode: row.country_code ?? undefined,
    language: row.language ?? undefined,
    logoUrl: row.logo_url ?? undefined,
    homepage: row.homepage ?? undefined,
    codec: row.codec ?? undefined,
    bitrate: row.bitrate ?? undefined,
    clickCount: row.click_count ?? 0,
    votes: row.votes ?? 0,
    lastCheckOk: row.last_check_ok !== 0,
    isCustom: row.is_custom === 1,
    isFavorite: row.is_favorite === 1,
  }
}

function getSavedLiveRadioStations(): Map<string, Station> {
  const rows = getDb().prepare(`
    SELECT *
    FROM live_radio_stations
  `).all() as LiveRadioStationRow[]
  return new Map(rows.map((row) => [row.id, stationRowToStation(row)]))
}

function normalizeLiveRadioCodec(codec?: string | null, url?: string | null): 'MP3' | 'AAC' | 'FLAC' {
  const raw = String(codec ?? '').trim().toLowerCase()
  const targetUrl = String(url ?? '').toLowerCase()
  if (raw.includes('flac') || targetUrl.includes('.flac')) return 'FLAC'
  if (raw.includes('aac') || targetUrl.includes('.aac') || targetUrl.includes('.m4a') || targetUrl.includes('.m3u8')) return 'AAC'
  return 'MP3'
}

function liveRadioFormatInfo(codec?: string | null, bitrate?: number | null, url?: string | null): FormatInfo {
  const format = normalizeLiveRadioCodec(codec, url)
  const normalizedBitrate = Math.max(0, Math.round(Number(bitrate ?? 0)))
  return {
    format,
    sampleRate: 44_100,
    bitDepth: format === 'FLAC' ? 16 : 0,
    bitrate: normalizedBitrate,
    channels: 2,
    isLossless: format === 'FLAC',
    isHiRes: false,
    isMqa: false,
    isDsd: false,
  }
}

function radioBrowserToStation(input: RadioBrowserStation, saved: Map<string, Station>): Station | null {
  const id = String(input.stationuuid ?? '').trim()
  const name = String(input.name ?? '').trim()
  const url = String(input.url_resolved || input.url || '').trim()
  if (!id || !name || !url) return null

  const savedStation = saved.get(id)
  const genre = String(input.tags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8)

  return {
    id,
    name,
    streams: [{ url, codec: input.codec || undefined, bitrate: input.bitrate || undefined }],
    defaultStreamIndex: 0,
    genre,
    country: input.country || undefined,
    countryCode: input.countrycode || undefined,
    language: input.language || undefined,
    logoUrl: input.favicon || undefined,
    homepage: input.homepage || undefined,
    codec: input.codec || undefined,
    bitrate: input.bitrate || undefined,
    clickCount: input.clickcount ?? 0,
    votes: input.votes ?? 0,
    lastCheckOk: input.lastcheckok === true || input.lastcheckok === 1,
    isCustom: false,
    isFavorite: !!savedStation?.isFavorite,
  }
}

async function fetchJsonWithRadioBrowserFallback<T>(pathAndQuery: string): Promise<T> {
  let lastError: unknown = null
  for (const baseUrl of RADIO_BROWSER_BASE_URLS) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LIVE_RADIO_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(`${baseUrl}${pathAndQuery}`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': LIVE_RADIO_USER_AGENT,
        },
      })
      if (!response.ok) throw new Error(`Radio Browser returned ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Radio Browser is unavailable')
}

function encodeRadioBrowserParams(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

export async function browseLiveRadioDirectory(options: LiveRadioBrowseOptions = {}): Promise<Station[]> {
  const limit = Math.max(1, Math.min(100, Math.round(options.limit ?? 48)))
  const hideBroken = options.hideBroken ?? true
  const params = encodeRadioBrowserParams({
    name: options.query?.trim() || undefined,
    tag: options.tag?.trim() || undefined,
    countrycode: options.countryCode?.trim() || undefined,
    language: options.language?.trim() || undefined,
    hidebroken: hideBroken,
    order:
      options.sort === 'votes' ? 'votes' :
      options.sort === 'name' ? 'name' :
      'clickcount',
    reverse: options.sort !== 'name',
    limit,
  })
  const raw = await fetchJsonWithRadioBrowserFallback<RadioBrowserStation[]>(`/json/stations/search${params}`)
  const saved = getSavedLiveRadioStations()
  return raw
    .map((station) => radioBrowserToStation(station, saved))
    .filter((station): station is Station => !!station)
}

export async function getLiveRadioDirectoryFilters(): Promise<LiveRadioDirectoryFilters> {
  const [tags, countries, languages] = await Promise.all([
    fetchJsonWithRadioBrowserFallback<Array<{ name?: string; stationcount?: number }>>('/json/tags?hidebroken=true&order=stationcount&reverse=true&limit=80'),
    fetchJsonWithRadioBrowserFallback<Array<{ name?: string; iso_3166_1?: string; stationcount?: number }>>('/json/countries?hidebroken=true&order=stationcount&reverse=true'),
    fetchJsonWithRadioBrowserFallback<Array<{ name?: string; stationcount?: number }>>('/json/languages?hidebroken=true&order=stationcount&reverse=true&limit=80'),
  ])

  return {
    tags: tags
      .filter((tag) => tag.name)
      .map((tag) => ({ name: tag.name!, value: tag.name!, count: tag.stationcount ?? 0 })),
    countries: countries
      .filter((country) => country.name && country.iso_3166_1)
      .map((country) => ({ name: country.name!, value: country.iso_3166_1!, count: country.stationcount ?? 0 })),
    languages: languages
      .filter((language) => language.name)
      .map((language) => ({ name: language.name!, value: language.name!, count: language.stationcount ?? 0 })),
  }
}

export function saveLiveRadioStation(station: Station): Station {
  const defaultStream = station.streams[station.defaultStreamIndex] ?? station.streams[0]
  if (!station.id || !station.name || !defaultStream?.url) {
    throw new Error('Station is missing a playable stream')
  }

  const normalized: Station = {
    ...station,
    streams: station.streams.filter((stream) => !!stream.url),
    defaultStreamIndex: Math.max(0, Math.min(station.defaultStreamIndex ?? 0, station.streams.length - 1)),
    isFavorite: true,
  }

  getDb().prepare(`
    INSERT INTO live_radio_stations (
      id, name, streams_json, default_stream_index, genre_json, country, country_code,
      language, logo_url, homepage, codec, bitrate, click_count, votes, last_check_ok,
      is_custom, is_favorite, updated_at
    ) VALUES (
      @id, @name, @streams_json, @default_stream_index, @genre_json, @country, @country_code,
      @language, @logo_url, @homepage, @codec, @bitrate, @click_count, @votes, @last_check_ok,
      @is_custom, @is_favorite, strftime('%s', 'now')
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      streams_json = excluded.streams_json,
      default_stream_index = excluded.default_stream_index,
      genre_json = excluded.genre_json,
      country = excluded.country,
      country_code = excluded.country_code,
      language = excluded.language,
      logo_url = excluded.logo_url,
      homepage = excluded.homepage,
      codec = excluded.codec,
      bitrate = excluded.bitrate,
      click_count = excluded.click_count,
      votes = excluded.votes,
      last_check_ok = excluded.last_check_ok,
      is_custom = excluded.is_custom,
      is_favorite = excluded.is_favorite,
      updated_at = excluded.updated_at
  `).run({
    id: normalized.id,
    name: normalized.name,
    streams_json: JSON.stringify(normalized.streams),
    default_stream_index: normalized.defaultStreamIndex,
    genre_json: JSON.stringify(normalized.genre ?? []),
    country: normalized.country ?? null,
    country_code: normalized.countryCode ?? null,
    language: normalized.language ?? null,
    logo_url: normalized.logoUrl ?? null,
    homepage: normalized.homepage ?? null,
    codec: normalized.codec ?? defaultStream.codec ?? null,
    bitrate: normalized.bitrate ?? defaultStream.bitrate ?? null,
    click_count: normalized.clickCount ?? 0,
    votes: normalized.votes ?? 0,
    last_check_ok: normalized.lastCheckOk === false ? 0 : 1,
    is_custom: normalized.isCustom ? 1 : 0,
    is_favorite: normalized.isFavorite ? 1 : 0,
  })
  return normalized
}

export function removeLiveRadioStation(stationId: string): void {
  getDb().prepare(`DELETE FROM live_radio_stations WHERE id = ?`).run(stationId)
}

export function getMyLiveRadioStations(): Station[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM live_radio_stations
    WHERE is_favorite = 1 OR is_custom = 1
    ORDER BY updated_at DESC, name COLLATE NOCASE
  `).all() as LiveRadioStationRow[]
  return rows.map(stationRowToStation)
}

function inferCodecFromUrlOrContentType(url: string, contentType?: string | null): string | null {
  const lowered = `${url} ${contentType ?? ''}`.toLowerCase()
  if (lowered.includes('.m3u8') || lowered.includes('mpegurl')) return 'm3u8'
  if (lowered.includes('flac')) return 'flac'
  if (lowered.includes('aac') || lowered.includes('mp4') || lowered.includes('audiop')) return 'aac'
  if (lowered.includes('mpeg') || lowered.includes('mp3')) return 'mp3'
  return null
}

function parsePlaylistPointer(text: string, baseUrl: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const plsUrl = lines
    .map((line) => line.match(/^File\d+=(.+)$/i)?.[1]?.trim() ?? null)
    .find((value): value is string => !!value)
  const candidate = plsUrl ?? lines.find((line) => !line.startsWith('#') && !line.startsWith('[')) ?? null
  if (!candidate) return null
  try {
    return new URL(candidate, baseUrl).toString()
  } catch {
    return null
  }
}

function classifyProbeFailure(status: number, contentType: string | null): string | null {
  if (status === 403 || status === 451) {
    return "This stream appears to be geo-restricted and isn't accessible from your location."
  }
  if (contentType?.toLowerCase().includes('text/html')) {
    return 'This looks like a station webpage, not a stream link. Find the direct audio URL (usually ends in .mp3/.aac/.m3u8).'
  }
  return null
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = LIVE_RADIO_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': LIVE_RADIO_USER_AGENT,
        ...(init.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function probeLiveRadioStream(rawUrl: string): Promise<LiveRadioProbeResult> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl.trim())
  } catch {
    return { ok: false, error: 'Enter a valid stream URL.' }
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    return { ok: false, error: 'Only HTTP and HTTPS radio streams are supported.' }
  }

  const lowerPath = parsedUrl.pathname.toLowerCase()
  let streamUrl = parsedUrl.toString()
  if (lowerPath.endsWith('.pls') || (lowerPath.endsWith('.m3u') && !lowerPath.endsWith('.m3u8'))) {
    try {
      const response = await fetchWithTimeout(streamUrl, { headers: { Accept: 'audio/x-scpls,audio/mpegurl,text/plain,*/*' } })
      const contentType = response.headers.get('content-type')
      const classified = classifyProbeFailure(response.status, contentType)
      if (classified) return { ok: false, contentType: contentType ?? undefined, error: classified }
      if (!response.ok) return { ok: false, error: `Stream playlist returned HTTP ${response.status}.` }
      const text = await response.text()
      const resolved = parsePlaylistPointer(text, streamUrl)
      if (!resolved) return { ok: false, error: 'No playable stream URL was found in this playlist.' }
      streamUrl = resolved
    } catch {
      return { ok: false, error: "Couldn't reach this stream. Check the URL or try again later." }
    }
  }

  let response: Response | null = null
  try {
    response = await fetchWithTimeout(streamUrl, {
      method: 'HEAD',
      headers: {
        Accept: 'audio/*,application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
        'Icy-MetaData': '1',
      },
    }, 5000)
    if (!response.ok || !response.headers.get('content-type')) {
      response = await fetchWithTimeout(streamUrl, {
        method: 'GET',
        headers: {
          Accept: 'audio/*,application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
          Range: 'bytes=0-4095',
          'Icy-MetaData': '1',
        },
      }, 5000)
    }
  } catch {
    return { ok: false, error: "Couldn't reach this stream. Check the URL or try again later." }
  }

  const contentType = response.headers.get('content-type')
  const classified = classifyProbeFailure(response.status, contentType)
  if (classified) return { ok: false, contentType: contentType ?? undefined, error: classified }
  if (!response.ok && response.status !== 206) {
    return { ok: false, contentType: contentType ?? undefined, error: `Stream returned HTTP ${response.status}.` }
  }

  const codec = inferCodecFromUrlOrContentType(streamUrl, contentType)
  if (!codec || !LIVE_RADIO_SUPPORTED_CODECS.has(codec)) {
    return { ok: false, contentType: contentType ?? undefined, error: 'Stream format not supported.' }
  }

  const icyName = response.headers.get('icy-name')?.trim()
  const icyBitrate = Number(response.headers.get('icy-br'))
  const bitrate = Number.isFinite(icyBitrate) && icyBitrate > 0 ? icyBitrate : undefined
  const normalizedCodec = codec === 'm3u8' ? 'aac' : codec

  return {
    ok: true,
    streamUrl,
    displayName: icyName || undefined,
    codec: normalizedCodec,
    bitrate,
    contentType: contentType ?? undefined,
    formatInfo: liveRadioFormatInfo(normalizedCodec, bitrate, streamUrl),
  }
}

export async function addCustomLiveRadioStream(payload: { url: string; name?: string | null }): Promise<Station> {
  const probe = await probeLiveRadioStream(payload.url)
  if (!probe.ok || !probe.streamUrl) {
    throw new Error(probe.error ?? 'Stream format not supported.')
  }
  const id = `custom:${createHash('sha256').update(probe.streamUrl).digest('hex')}`
  const name = payload.name?.trim() || probe.displayName || new URL(probe.streamUrl).hostname
  return saveLiveRadioStation({
    id,
    name,
    streams: [{ url: probe.streamUrl, codec: probe.codec, bitrate: probe.bitrate }],
    defaultStreamIndex: 0,
    genre: [],
    logoUrl: undefined,
    isCustom: true,
    isFavorite: true,
    codec: probe.codec,
    bitrate: probe.bitrate,
    lastCheckOk: true,
  })
}
