/**
 * Metadata extraction from local audio files using music-metadata.
 */

import type { FormatInfo } from './formats'
import { classifyFormat } from './formats'

export interface TrackMetadata {
  filePath: string
  title: string
  artist: string
  album: string
  trackNumber: number | null
  discNumber: number
  year: number | null
  genres: string[]
  duration: number     // seconds
  formatInfo: FormatInfo
  fileSize: number
  modifiedAt: number   // unix timestamp
}

/**
 * Parse metadata from an audio file.
 * Uses dynamic import since music-metadata is ESM-only.
 */
export async function parseMetadata(filePath: string, stat: { size: number; mtimeMs: number }): Promise<TrackMetadata> {
  const mm = await import('music-metadata')
  const metadata = await mm.parseFile(filePath)

  const { common, format: fmt } = metadata

  // Build flat tag map for MQA detection
  const tags: Record<string, string> = {}
  if (metadata.native) {
    for (const tagType of Object.keys(metadata.native)) {
      for (const tag of metadata.native[tagType]) {
        if (typeof tag.value === 'string') {
          tags[tag.id] = tag.value
        }
      }
    }
  }

  const formatInfo = classifyFormat({
    codec: fmt.codec ?? '',
    container: fmt.container ?? '',
    sampleRate: fmt.sampleRate ?? 44100,
    bitDepth: fmt.bitsPerSample ?? 16,
    bitrate: fmt.bitrate ?? 0,
    channels: fmt.numberOfChannels ?? 2,
    tags,
  })

  return {
    filePath,
    title: common.title ?? fileNameWithoutExt(filePath),
    artist: common.artist ?? 'Unknown Artist',
    album: common.album ?? 'Unknown Album',
    trackNumber: common.track?.no ?? null,
    discNumber: common.disk?.no ?? 1,
    year: common.year ?? null,
    genres: normalizeGenres(common.genre),
    duration: fmt.duration ?? 0,
    formatInfo,
    fileSize: stat.size,
    modifiedAt: Math.floor(stat.mtimeMs / 1000),
  }
}

function normalizeGenres(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const genres: string[] = []
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const genre = raw.trim()
    const key = genre.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim()
    if (!genre || seen.has(key)) continue
    seen.add(key)
    genres.push(genre)
  }
  return genres
}

function fileNameWithoutExt(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dotIndex = name.lastIndexOf('.')
  return dotIndex > 0 ? name.slice(0, dotIndex) : name
}
