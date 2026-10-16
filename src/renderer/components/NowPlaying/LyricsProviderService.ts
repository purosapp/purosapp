import type { Track } from '../../../store/playerStore'
import { parseLRC, type LrcLine } from './lrcParser'

export type LyricsProviderId = 'lrclib' | 'musixmatch' | 'genius'
export type LyricsResponseKind = 'timed' | 'static' | 'none'

export interface LyricsProviderConfig {
  id: LyricsProviderId
  enabled: boolean
  apiKey?: string
}

export interface LyricsTrackPayload {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  provider?: string | null
  sourceId?: string | null
  catalogTrackId?: string | null
}

export interface LyricsProviderFetchRequest {
  track: LyricsTrackPayload
  providers: LyricsProviderConfig[]
}

export interface LyricsProviderFetchResult {
  providerId: LyricsProviderId | null
  kind: LyricsResponseKind
  syncedText: string | null
  plainText: string | null
}

export interface LyricsProviderTestResult {
  ok: boolean
  message: string
}

export interface ResolvedLyrics {
  providerId: LyricsProviderId | null
  kind: LyricsResponseKind
  synced: boolean
  lines: LrcLine[]
  plainText: string
  staticLines: string[]
}

function providerSignature(providers: LyricsProviderConfig[]): string {
  return providers
    .map((provider) => `${provider.id}:${provider.enabled ? '1' : '0'}:${provider.apiKey?.trim() ?? ''}`)
    .join('|')
}

function normalizePlainText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function staticLinesFromText(text: string): string[] {
  if (!text) return []
  return text
    .split('\n')
    .map((line) => line.trimEnd())
}

function toTrackPayload(track: Track): LyricsTrackPayload {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    provider: track.provider ?? null,
    sourceId: track.sourceId ?? null,
    catalogTrackId: track.catalogTrackId ?? null,
  }
}

function normalizeLyrics(result: LyricsProviderFetchResult): ResolvedLyrics {
  const parsedLines = result.syncedText ? parseLRC(result.syncedText) : []
  const synced = parsedLines.length > 0
  const plainText = normalizePlainText(
    synced
      ? parsedLines.map((line) => line.text).join('\n')
      : result.plainText,
  )

  return {
    providerId: result.providerId,
    kind: synced ? 'timed' : result.kind,
    synced,
    lines: synced ? parsedLines : [],
    plainText,
    staticLines: synced ? [] : staticLinesFromText(plainText),
  }
}

class LyricsProviderService {
  private cache = new Map<string, ResolvedLyrics>()
  private inflight = new Map<string, Promise<ResolvedLyrics>>()

  clearCache(trackId?: string) {
    if (trackId) {
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(`${trackId}::`)) this.cache.delete(key)
      }
      for (const key of [...this.inflight.keys()]) {
        if (key.startsWith(`${trackId}::`)) this.inflight.delete(key)
      }
      return
    }

    this.cache.clear()
    this.inflight.clear()
  }

  async getLyrics(track: Track, providers: LyricsProviderConfig[]): Promise<ResolvedLyrics> {
    const cacheKey = `${track.id}::${providerSignature(providers)}`

    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const inflight = this.inflight.get(cacheKey)
    if (inflight) return inflight

    const request: LyricsProviderFetchRequest = {
      track: toTrackPayload(track),
      providers,
    }

    const nextPromise = window.puros.lyrics.resolve(request)
      .then((result) => {
        const normalized = normalizeLyrics(result)
        this.cache.set(cacheKey, normalized)
        return normalized
      })
      .catch(() => ({
        providerId: null,
        kind: 'none' as const,
        synced: false,
        lines: [],
        plainText: '',
        staticLines: [],
      }))
      .finally(() => {
        this.inflight.delete(cacheKey)
      })

    this.inflight.set(cacheKey, nextPromise)
    return nextPromise
  }

  async prefetchLyrics(track: Track | null | undefined, providers: LyricsProviderConfig[]): Promise<void> {
    if (!track) return
    await this.getLyrics(track, providers)
  }
}

export const lyricsProviderService = new LyricsProviderService()
