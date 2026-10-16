import type { LiveRadioNowPlayingMetadata } from '../../../src/services/liveRadio/types'
import { getDb } from '../db'
import { fetchWithTimeout } from './directory'

const LIVE_RADIO_METADATA_TIMEOUT_MS = 6500
const LIVE_RADIO_METADATA_CACHE_SECONDS = 20

function splitIcyStreamTitle(rawTitle: string | null): { title: string | null; artist: string | null } {
  const value = rawTitle?.trim()
  if (!value) return { title: null, artist: null }
  const [artist, ...titleParts] = value.split(/\s+-\s+/)
  if (artist && titleParts.length > 0) {
    return { artist: artist.trim(), title: titleParts.join(' - ').trim() || null }
  }
  return { title: value, artist: null }
}

function readSynchsafeInt(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
}

function decodeId3TextFrame(bytes: Uint8Array): string | null {
  if (bytes.length <= 1) return null
  const encoding = bytes[0]
  const payload = Buffer.from(bytes.slice(1))
  if (encoding === 1 || encoding === 2) {
    return payload.toString('utf16le').replace(/\0+$/g, '').trim() || null
  }
  return payload.toString('utf8').replace(/\0+$/g, '').trim() || null
}

function parseId3NowPlaying(bytes: Uint8Array): { title: string | null; artist: string | null; rawTitle: string | null } | null {
  const id3Offset = bytes.findIndex((_, index) =>
    bytes[index] === 0x49 && bytes[index + 1] === 0x44 && bytes[index + 2] === 0x33
  )
  if (id3Offset < 0 || id3Offset + 10 >= bytes.length) return null
  const tagSize = readSynchsafeInt(bytes, id3Offset + 6)
  let offset = id3Offset + 10
  const end = Math.min(bytes.length, offset + tagSize)
  let title: string | null = null
  let artist: string | null = null
  let rawTitle: string | null = null

  while (offset + 10 <= end) {
    const frameId = Buffer.from(bytes.slice(offset, offset + 4)).toString('latin1')
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break
    const size = bytes[offset + 4] * 0x1000000 + bytes[offset + 5] * 0x10000 + bytes[offset + 6] * 0x100 + bytes[offset + 7]
    offset += 10
    if (size <= 0 || offset + size > bytes.length) break
    const payload = bytes.slice(offset, offset + size)
    const text = decodeId3TextFrame(payload)
    if (text) {
      if (frameId === 'TIT2') title = text
      if (frameId === 'TPE1') artist = text
      if (!rawTitle && (frameId === 'TXXX' || frameId === 'TIT2')) rawTitle = text
    }
    offset += size
  }

  if (!title && !artist && !rawTitle) return null
  return { title: title ?? rawTitle, artist, rawTitle }
}

async function fetchHlsNowPlaying(streamUrl: string): Promise<{ title: string | null; artist: string | null; rawTitle: string | null } | null> {
  try {
    const manifestResponse = await fetchWithTimeout(streamUrl, {
      headers: { Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*' },
    }, LIVE_RADIO_METADATA_TIMEOUT_MS)
    if (!manifestResponse.ok) return null
    const manifest = await manifestResponse.text()
    const segmentLine = manifest
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'))
    if (!segmentLine) return null
    const segmentUrl = new URL(segmentLine, streamUrl).toString()
    if (/\.m3u8(?:$|\?)/i.test(segmentUrl) && segmentUrl !== streamUrl) {
      return fetchHlsNowPlaying(segmentUrl)
    }
    const segmentResponse = await fetchWithTimeout(segmentUrl, {
      headers: { Range: 'bytes=0-65535' },
    }, LIVE_RADIO_METADATA_TIMEOUT_MS)
    if (!segmentResponse.ok && segmentResponse.status !== 206) return null
    const bytes = new Uint8Array(await segmentResponse.arrayBuffer())
    return parseId3NowPlaying(bytes)
  } catch {
    return null
  }
}

export async function fetchIcyNowPlaying(stationId: string, streamUrl: string): Promise<LiveRadioNowPlayingMetadata> {
  const cached = getDb().prepare(`
    SELECT raw_title, title, artist, fetched_at
    FROM live_radio_metadata_cache
    WHERE station_id = ?
  `).get(stationId) as { raw_title: string | null; title: string | null; artist: string | null; fetched_at: number } | undefined
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (cached && nowSeconds - cached.fetched_at < LIVE_RADIO_METADATA_CACHE_SECONDS) {
    return {
      stationId,
      title: cached.title,
      artist: cached.artist,
      rawTitle: cached.raw_title,
      fetchedAt: cached.fetched_at,
    }
  }

  let rawTitle: string | null = null
  let hlsMetadata: { title: string | null; artist: string | null; rawTitle: string | null } | null = null
  if (/\.m3u8(?:$|\?)/i.test(streamUrl)) {
    hlsMetadata = await fetchHlsNowPlaying(streamUrl)
    rawTitle = hlsMetadata?.rawTitle ?? null
  }
  try {
    if (hlsMetadata) throw new Error('HLS metadata already resolved')
    const response = await fetchWithTimeout(streamUrl, {
      headers: {
        Accept: 'audio/*,*/*',
        'Icy-MetaData': '1',
      },
    }, LIVE_RADIO_METADATA_TIMEOUT_MS)
    const metaInt = Number(response.headers.get('icy-metaint'))
    if (response.body && Number.isFinite(metaInt) && metaInt > 0) {
      const reader = response.body.getReader()
      let neededAudio = metaInt
      const chunks: Uint8Array[] = []
      let metadataLength = -1
      for (;;) {
        const { done, value } = await reader.read()
        if (done || !value) break
        let offset = 0
        while (offset < value.length) {
          if (neededAudio > 0) {
            const consume = Math.min(neededAudio, value.length - offset)
            neededAudio -= consume
            offset += consume
            continue
          }
          if (metadataLength < 0) {
            metadataLength = value[offset] * 16
            offset += 1
            if (metadataLength === 0) {
              reader.cancel().catch(() => undefined)
              break
            }
          }
          const remainingMeta = metadataLength - chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          const consume = Math.min(remainingMeta, value.length - offset)
          chunks.push(value.slice(offset, offset + consume))
          offset += consume
          if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) >= metadataLength) {
            reader.cancel().catch(() => undefined)
            const metadata = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').replace(/\0+$/g, '')
            rawTitle = metadata.match(/StreamTitle='([^']*)'/i)?.[1]?.trim() || null
            break
          }
        }
        if (rawTitle !== null || metadataLength === 0) break
      }
    }
  } catch {
    // Metadata is opportunistic; no title is a valid fallback.
  }

  const split = hlsMetadata ?? splitIcyStreamTitle(rawTitle)
  getDb().prepare(`
    INSERT INTO live_radio_metadata_cache (station_id, stream_url, raw_title, title, artist, fetched_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(station_id) DO UPDATE SET
      stream_url = excluded.stream_url,
      raw_title = excluded.raw_title,
      title = excluded.title,
      artist = excluded.artist,
      fetched_at = excluded.fetched_at
  `).run(stationId, streamUrl, rawTitle, split.title, split.artist)

  return {
    stationId,
    title: split.title,
    artist: split.artist,
    rawTitle,
    fetchedAt: nowSeconds,
  }
}
