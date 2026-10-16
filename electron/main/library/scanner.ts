import fs from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import type Database from "better-sqlite3"
import { inferArtistCredits } from "../../../src/services/catalog/creditHeuristics"
import {
  normalizeArtistList,
  normalizeGenreTags,
  normalizeIsrc,
  normalizeUpc,
  normStr,
  sha256,
  splitArtists,
} from "../shared/normalize"
import { extensionFromMimeType, normalizeArtworkMime } from "../shared/mime"
import { getDb } from "../db"
import { artCacheDir, ensureArtCacheDir, readFolderArtAsset } from "../artwork/cache"
import { pauseBackgroundWorkForPlayback } from "../playbackCoordinator"
import { sendToRenderer } from "../rendererBridge"
import {
  getNumericSettingValue,
  LOCAL_ARTIST_SPLIT_VERSION,
  LOCAL_ARTIST_SPLIT_VERSION_KEY,
} from "../settings/store"
import { readFlacStreamInfo } from "../audio/localPlayback"

type LibraryScannerDeps = {
  ensureArtistProfile: (db: Database.Database, artistId: string) => Promise<unknown>
  getProviderLibrarySyncPromise: () => Promise<unknown> | null
  rebuildCatalogGraphFromSources: () => Promise<void>
}

let libraryScannerDeps: LibraryScannerDeps | null = null
let localLibraryRescanPromise: Promise<void> | null = null

export function configureLibraryScanner(deps: LibraryScannerDeps) {
  libraryScannerDeps = deps
}

function getLibraryScannerDeps(): LibraryScannerDeps {
  if (!libraryScannerDeps) throw new Error("Library scanner is not configured")
  return libraryScannerDeps
}

export function resetLibraryScanner() {
  localLibraryRescanPromise = null
}

function detectCompilation(
  albumArtistRaw: string, albumRaw: string,
  trackArtists: string[], anyCompilationTag: boolean,
): boolean {
  if (anyCompilationTag) return true
  if (normStr(albumArtistRaw) === 'various artists') return true
  const title = albumRaw.toLowerCase()
  if (title.includes(' ost') || title.includes('soundtrack')) return true
  if (trackArtists.length > 4) {
    const unique = new Set(trackArtists.map(a => normStr(a)))
    if (unique.size > 4) return true
  }
  return false
}

interface TrackRaw {
  filePath: string
  playbackFilePath: string
  fileSize: number
  fileMtimeMs: number
  durationMs: number
  format: string
  sampleRate: number | null
  bitDepth: number | null
  channels: number
  bitrate: number | null
  lossless: boolean
  title: string
  trackNumber: number | null
  discNumber: number
  year: number | null
  artistRaw: string
  artistListRaw: string[]
  albumArtistRaw: string
  albumArtistListRaw: string[]
  albumRaw: string
  genres: string[]
  isCompilationTag: boolean
  hasEmbeddedArt: boolean
  artHash: string | null
  artMime: string | null
  artBuffer: Buffer | null
  albumTotalTracksHint: number | null
  isrc: string | null
  upc: string | null
  startOffsetMs: number
  endOffsetMs: number | null
  cueSheetPath: string | null
}

interface CueTrackMetadata {
  number: number
  title: string | null
  performer: string | null
  index01Ms: number | null
}

interface CueVirtualTrack {
  logicalFilePath: string
  playbackFilePath: string
  cueSheetPath: string
  albumTitle: string | null
  albumArtist: string | null
  year: number | null
  trackNumber: number
  totalTracks: number | null
  title: string | null
  performer: string | null
  startOffsetMs: number
  endOffsetMs: number | null
}

interface LogicalScanEntry {
  logicalPath: string
  playbackFilePath: string
  cueTrack: CueVirtualTrack | null
  effectiveMtimeMs: number
}

function inferTrackOrderFromStem(stem: string): { trackNumber: number | null; title: string } {
  const normalizedStem = stem.trim()
  const patterns = [
    /^(\d{1,2})\s*[-._]\s*(.+)$/u,
    /^(\d{1,2})\s+(.+)$/u,
  ]

  for (const pattern of patterns) {
    const match = normalizedStem.match(pattern)
    if (!match) continue
    const trackNumber = Number.parseInt(match[1], 10)
    const title = match[2].trim()
    if (Number.isFinite(trackNumber) && trackNumber > 0 && title.length > 0) {
      return { trackNumber, title }
    }
  }

  return { trackNumber: null, title: normalizedStem }
}

function inferTrackOrderFromFilename(filePath: string): { trackNumber: number | null; title: string } {
  const ext = path.extname(filePath)
  return inferTrackOrderFromStem(path.basename(filePath, ext))
}

function decodeCueValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function resolveCueReferencedFile(cuePath: string, rawReference: string): string {
  const cueDir = path.dirname(cuePath)
  const normalizedReference = decodeCueValue(rawReference).replace(/\\/g, path.sep)
  return path.normalize(path.resolve(cueDir, normalizedReference))
}

function parseCueTimeToMs(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})$/u)
  if (!match) return null
  const minutes = Number.parseInt(match[1], 10)
  const seconds = Number.parseInt(match[2], 10)
  const frames = Number.parseInt(match[3], 10)
  if (![minutes, seconds, frames].every(Number.isFinite)) return null
  return Math.round(((minutes * 60) + seconds + (frames / 75)) * 1000)
}

function parseCueSheet(cuePath: string): CueVirtualTrack[] {
  const content = fs.readFileSync(cuePath, 'utf8')
  const lines = content.split(/\r?\n/)
  const tracksByFile = new Map<string, CueTrackMetadata[]>()

  let albumTitle: string | null = null
  let albumArtist: string | null = null
  let year: number | null = null
  let currentFilePath: string | null = null
  let currentTrack: CueTrackMetadata | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';')) continue

    const remDateMatch = line.match(/^REM\s+DATE\s+(\d{4})\s*$/iu)
    if (remDateMatch) {
      const parsedYear = Number.parseInt(remDateMatch[1], 10)
      if (Number.isFinite(parsedYear) && parsedYear > 0) year = parsedYear
      continue
    }

    const fileMatch = line.match(/^FILE\s+(".*?"|.+?)\s+\S+\s*$/iu)
    if (fileMatch) {
      currentFilePath = resolveCueReferencedFile(cuePath, fileMatch[1])
      if (!tracksByFile.has(currentFilePath)) tracksByFile.set(currentFilePath, [])
      currentTrack = null
      continue
    }

    const trackMatch = line.match(/^TRACK\s+(\d{1,3})\s+\S+\s*$/iu)
    if (trackMatch && currentFilePath) {
      const trackNumber = Number.parseInt(trackMatch[1], 10)
      currentTrack = {
        number: Number.isFinite(trackNumber) && trackNumber > 0 ? trackNumber : 0,
        title: null,
        performer: null,
        index01Ms: null,
      }
      tracksByFile.get(currentFilePath)?.push(currentTrack)
      continue
    }

    const titleMatch = line.match(/^TITLE\s+(.+?)\s*$/iu)
    if (titleMatch) {
      const value = decodeCueValue(titleMatch[1])
      if (currentTrack) currentTrack.title = value
      else albumTitle = value
      continue
    }

    const performerMatch = line.match(/^PERFORMER\s+(.+?)\s*$/iu)
    if (performerMatch) {
      const value = decodeCueValue(performerMatch[1])
      if (currentTrack) currentTrack.performer = value
      else albumArtist = value
      continue
    }

    const indexMatch = line.match(/^INDEX\s+01\s+(\d{1,3}:\d{2}:\d{2})\s*$/iu)
    if (indexMatch && currentTrack) {
      currentTrack.index01Ms = parseCueTimeToMs(indexMatch[1])
    }
  }

  let totalTracks = 0
  for (const tracks of tracksByFile.values()) {
    for (const track of tracks) {
      totalTracks = Math.max(totalTracks, track.number)
    }
  }

  const result: CueVirtualTrack[] = []
  for (const [filePath, tracks] of tracksByFile.entries()) {
    tracks.sort((a, b) => a.number - b.number)
    for (let index = 0; index < tracks.length; index++) {
      const track = tracks[index]
      const nextTrack = tracks[index + 1] ?? null
      const startOffsetMs = track.index01Ms ?? 0
      const endOffsetMs = nextTrack?.index01Ms ?? null
      result.push({
        logicalFilePath: `${filePath}#cue:${track.number.toString().padStart(2, '0')}`,
        playbackFilePath: filePath,
        cueSheetPath: cuePath,
        albumTitle,
        albumArtist,
        year,
        trackNumber: track.number,
        totalTracks: totalTracks > 0 ? totalTracks : null,
        title: track.title,
        performer: track.performer,
        startOffsetMs,
        endOffsetMs,
      })
    }
  }

  return result
}

function buildCueVirtualTrackIndex(cueFiles: string[]): Map<string, CueVirtualTrack[]> {
  const tracksByFile = new Map<string, CueVirtualTrack[]>()

  for (const cuePath of cueFiles) {
    try {
      const cueTracks = parseCueSheet(cuePath)
      for (const cueTrack of cueTracks) {
        const key = path.normalize(cueTrack.playbackFilePath)
        if (!tracksByFile.has(key)) tracksByFile.set(key, [])
        tracksByFile.get(key)!.push(cueTrack)
      }
    } catch (error) {
      console.warn(`[scanner] Failed to parse cue sheet ${cuePath}:`, error)
    }
  }

  for (const tracks of tracksByFile.values()) {
    tracks.sort((a, b) => a.trackNumber - b.trackNumber)
  }

  return tracksByFile
}

export async function parseTrackFile(
  filePath: string,
  mm: typeof import('music-metadata'),
  cueTrack?: CueVirtualTrack | null,
): Promise<TrackRaw> {
  const stat = fs.statSync(filePath)
  const metadata = await mm.parseFile(filePath, { skipCovers: false })
  const { common, format: fmt } = metadata

  const tags: Record<string, string> = {}
  if (metadata.native) {
    for (const tagType of Object.keys(metadata.native)) {
      for (const tag of metadata.native[tagType]) {
        if (typeof tag.value === 'string') tags[tag.id] = tag.value
      }
    }
  }

  const container = fmt.container ?? ''
  const ext = path.extname(filePath).toLowerCase()
  const trackInfoCodec = (fmt as { trackInfo?: Array<{ codecName?: string }> })
    .trackInfo?.[0]?.codecName?.toLowerCase() ?? ''
  const codec = (fmt.codec ?? '').toLowerCase()
  const codecId = codec || trackInfoCodec

  const trackAudio = (fmt as {
    trackInfo?: Array<{ audio?: { samplingFrequency?: number; bitDepth?: number; channels?: number } }>
  }).trackInfo?.[0]?.audio

  let sampleRate: number | null = (fmt.sampleRate && fmt.sampleRate > 0) ? fmt.sampleRate : null
  let bitDepth: number | null = (fmt.bitsPerSample && fmt.bitsPerSample > 0) ? fmt.bitsPerSample : null
  let channels = fmt.numberOfChannels ?? 2

  if (!sampleRate && trackAudio?.samplingFrequency) sampleRate = trackAudio.samplingFrequency
  if (!bitDepth && trackAudio?.bitDepth) bitDepth = trackAudio.bitDepth
  if (trackAudio?.channels) channels = trackAudio.channels

  if (!sampleRate && (codecId.includes('flac') || ext === '.flac')) {
    const si = readFlacStreamInfo(filePath)
    if (si) {
      if (!sampleRate) sampleRate = si.sampleRate
      if (!bitDepth) bitDepth = si.bitsPerSample
      if (channels === 2) channels = si.channels
    }
  }

  const bitrate = fmt.bitrate ?? null
  const isDsd = container === 'dsf' || container === 'dff' || codecId.includes('dsd')
  const isMqa = !!(tags['MQAENCODER'] || tags['mqaencoder'] ||
    (tags['ENCODER'] || tags['encoder'] || '').toUpperCase().includes('MQA'))
  const isHiRes = (bitDepth ?? 0) > 16 || (sampleRate ?? 0) > 48000

  let format: string
  if (isDsd || ext === '.dsf' || ext === '.dff') format = 'DSD'
  else if (isMqa) format = 'MQA'
  else if (codecId.includes('flac') || trackInfoCodec.includes('flac') || ext === '.flac')
    format = isHiRes ? 'FLAC_HIRES' : 'FLAC'
  else if (codecId.includes('alac') || trackInfoCodec.includes('alac') || ext === '.alac')
    format = 'ALAC'
  else if (codecId.includes('aiff') || container === 'aiff' || ext === '.aiff' || ext === '.aif')
    format = 'AIFF'
  else if ((codecId === 'pcm' && container === 'wav') || ext === '.wav') format = 'WAV'
  else if (codecId.includes('mp3') || codecId === 'mpeg 1 layer 3' || ext === '.mp3') format = 'MP3'
  else if (codecId.includes('aac') || trackInfoCodec.includes('mp4a') || ext === '.aac') format = 'AAC'
  else if (codecId.includes('opus') || trackInfoCodec.includes('opus') || ext === '.opus') format = 'OPUS'
  else if (ext === '.m4a') format = (bitDepth && bitDepth >= 24) ? 'FLAC' : 'AAC'
  else if (codecId.includes('vorbis') || trackInfoCodec.includes('vorbis') || ext === '.ogg' || ext === '.oga') format = 'VORBIS'
  else format = 'FLAC'

  const lossless = !['MP3', 'AAC', 'MQA', 'VORBIS', 'OPUS'].includes(format)
  if (format === 'OPUS') {
    // Opus always decodes at 48 kHz; the header's "input sample rate" only describes the encoder's source.
    sampleRate = 48_000
  }
  if (format === 'OPUS' || format === 'AAC') {
    // Lossy codecs carry no source bit depth; a container's nominal 16 bits describes the decoder output.
    bitDepth = null
  }

  let hasEmbeddedArt = false
  let artHash: string | null = null
  let artMime: string | null = null
  let artBuffer: Buffer | null = null
  const pic = common.picture?.[0]
  if (pic && pic.data.length > 0) {
    hasEmbeddedArt = true
    const buf = Buffer.from(pic.data)
    artHash = createHash('sha256').update(buf).digest('hex')
    artMime = normalizeArtworkMime(pic.format)
    artBuffer = buf
  }

  const inferredFromFilename = inferTrackOrderFromFilename(filePath)
  const inferredCueTitle = cueTrack?.title ? inferTrackOrderFromStem(cueTrack.title) : null
  const artistRaw = cueTrack?.performer ?? common.artist ?? cueTrack?.albumArtist ?? 'Unknown Artist'
  const albumArtistRaw = cueTrack?.albumArtist ?? common.albumartist ?? common.artist ?? 'Unknown Artist'
  const artistListRaw = cueTrack?.performer
    ? splitArtists(cueTrack.performer)
    : normalizeArtistList(common.artists, artistRaw)
  const albumArtistListRaw = cueTrack?.albumArtist
    ? splitArtists(cueTrack.albumArtist)
    : normalizeArtistList(common.albumartists, albumArtistRaw)
  const title = cueTrack?.title
    ? (inferredCueTitle?.title || cueTrack.title)
    : (common.title?.trim() || inferredFromFilename.title)
  const trackNumber = cueTrack?.trackNumber
    ?? common.track?.no
    ?? inferredCueTitle?.trackNumber
    ?? inferredFromFilename.trackNumber
  const startOffsetMs = cueTrack?.startOffsetMs ?? 0
  const endOffsetMs = cueTrack?.endOffsetMs ?? null
  const slicedDurationMs = cueTrack
    ? Math.max(
        0,
        (endOffsetMs ?? Math.round((fmt.duration ?? 0) * 1000)) - startOffsetMs,
      )
    : Math.round((fmt.duration ?? 0) * 1000)

  const isrc = normalizeIsrc(common.isrc ?? tags['ISRC'] ?? tags['TSRC'] ?? null)
  const upc = normalizeUpc(common.barcode ?? tags['BARCODE'] ?? tags['UPC'] ?? tags['EAN'] ?? null)

  return {
    filePath: cueTrack?.logicalFilePath ?? filePath,
    playbackFilePath: cueTrack?.playbackFilePath ?? filePath,
    fileSize: stat.size,
    fileMtimeMs: stat.mtimeMs,
    durationMs: slicedDurationMs,
    format,
    sampleRate,
    bitDepth,
    channels,
    bitrate: bitrate != null ? Math.round(bitrate / 1000) : null,
    lossless,
    title,
    trackNumber,
    discNumber: common.disk?.no ?? 1,
    year: common.year ?? cueTrack?.year ?? null,
    artistRaw,
    artistListRaw,
    albumArtistRaw,
    albumArtistListRaw,
    albumRaw: cueTrack?.albumTitle ?? common.album ?? 'Unknown Album',
    genres: normalizeGenreTags(common.genre),
    isCompilationTag: !!(common as { compilation?: boolean }).compilation,
    hasEmbeddedArt,
    artHash,
    artMime,
    artBuffer,
    albumTotalTracksHint: cueTrack?.totalTracks ?? null,
    isrc,
    upc,
    startOffsetMs,
    endOffsetMs,
    cueSheetPath: cueTrack?.cueSheetPath ?? null,
  }
}

function buildCueVirtualTrackRaw(
  baseTrack: TrackRaw,
  cueTrack: CueVirtualTrack,
  effectiveMtimeMs: number,
): TrackRaw {
  const inferredCueTitle = cueTrack.title ? inferTrackOrderFromStem(cueTrack.title) : null
  const fullDurationMs = baseTrack.endOffsetMs ?? baseTrack.durationMs
  const slicedDurationMs = Math.max(
    0,
    (cueTrack.endOffsetMs ?? fullDurationMs) - cueTrack.startOffsetMs,
  )

  return {
    ...baseTrack,
    filePath: cueTrack.logicalFilePath,
    playbackFilePath: cueTrack.playbackFilePath,
    fileMtimeMs: effectiveMtimeMs,
    durationMs: slicedDurationMs,
    title: inferredCueTitle?.title || cueTrack.title || baseTrack.title,
    trackNumber: cueTrack.trackNumber,
    year: cueTrack.year ?? baseTrack.year,
    artistRaw: cueTrack.performer ?? cueTrack.albumArtist ?? baseTrack.artistRaw,
    artistListRaw: cueTrack.performer
      ? splitArtists(cueTrack.performer)
      : cueTrack.albumArtist
        ? splitArtists(cueTrack.albumArtist)
        : baseTrack.artistListRaw,
    albumArtistRaw: cueTrack.albumArtist ?? baseTrack.albumArtistRaw,
    albumArtistListRaw: cueTrack.albumArtist
      ? splitArtists(cueTrack.albumArtist)
      : baseTrack.albumArtistListRaw,
    albumRaw: cueTrack.albumTitle ?? baseTrack.albumRaw,
    genres: baseTrack.genres,
    albumTotalTracksHint: cueTrack.totalTracks ?? baseTrack.albumTotalTracksHint,
    startOffsetMs: cueTrack.startOffsetMs,
    endOffsetMs: cueTrack.endOffsetMs,
    cueSheetPath: cueTrack.cueSheetPath,
  }
}

function normalizeAndInsert(tracks: TrackRaw[], db: Database.Database): void {
  if (tracks.length === 0) return

  // Group tracks by (normalised album artist + normalised album title)
  const albumGroups = new Map<string, {
    albumArtistRaw: string; albumRaw: string; tracks: TrackRaw[]
  }>()
  for (const t of tracks) {
    const key = normStr(t.albumArtistRaw) + '\x00' + normStr(t.albumRaw)
    if (!albumGroups.has(key)) albumGroups.set(key, { albumArtistRaw: t.albumArtistRaw, albumRaw: t.albumRaw, tracks: [] })
    albumGroups.get(key)!.tracks.push(t)
  }

  ensureArtCacheDir()

  const upsertArtist = db.prepare(`
    INSERT INTO artists (id, name, normalized_name, genres, artwork_id, art_source) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      normalized_name=excluded.normalized_name,
      genres=CASE
        WHEN excluded.genres IS NOT NULL AND excluded.genres != '[]' THEN excluded.genres
        ELSE artists.genres
      END,
      artwork_id=COALESCE(excluded.artwork_id, artists.artwork_id),
      art_source=CASE
        WHEN excluded.artwork_id IS NOT NULL THEN excluded.art_source
        ELSE artists.art_source
      END
  `)
  const upsertAlbum = db.prepare(`
    INSERT INTO albums (id, title, normalized_title, upc, year, album_artist_id, album_artist_name,
                        genres, art_path, artwork_id, art_source, is_compilation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      upc=COALESCE(excluded.upc, upc),
      year=COALESCE(excluded.year, year),
      genres=CASE
        WHEN excluded.genres IS NOT NULL AND excluded.genres != '[]' THEN excluded.genres
        ELSE albums.genres
      END,
      art_path=COALESCE(excluded.art_path, art_path),
      artwork_id=COALESCE(excluded.artwork_id, artwork_id),
      art_source=CASE
        WHEN excluded.artwork_id IS NOT NULL OR excluded.art_path IS NOT NULL THEN excluded.art_source
        ELSE art_source
      END,
      is_compilation=excluded.is_compilation
  `)
  const upsertArtwork = db.prepare(`
    INSERT INTO artwork_cache (id, mime_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mime_type=excluded.mime_type,
      data=excluded.data
  `)
  const upsertTrack = db.prepare(`
    INSERT INTO tracks (id, file_path, playback_file_path, file_size, file_modified_at, duration_ms, format,
      sample_rate, bit_depth, channels, bitrate, lossless, title, genres, isrc, upc, track_number, disc_number,
      year, album_id, artist_id, has_embedded_art, art_hash, start_offset_ms, end_offset_ms, cue_sheet_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      id=excluded.id, playback_file_path=excluded.playback_file_path,
      file_size=excluded.file_size, file_modified_at=excluded.file_modified_at,
      duration_ms=excluded.duration_ms, format=excluded.format, sample_rate=excluded.sample_rate,
      bit_depth=excluded.bit_depth, channels=excluded.channels, bitrate=excluded.bitrate,
      lossless=excluded.lossless, title=excluded.title,
      genres=CASE
        WHEN excluded.genres IS NOT NULL AND excluded.genres != '[]' THEN excluded.genres
        ELSE tracks.genres
      END,
      isrc=COALESCE(excluded.isrc, isrc),
      upc=COALESCE(excluded.upc, upc), track_number=excluded.track_number,
      disc_number=excluded.disc_number, year=excluded.year, album_id=excluded.album_id,
      artist_id=excluded.artist_id, has_embedded_art=excluded.has_embedded_art,
      art_hash=excluded.art_hash, start_offset_ms=excluded.start_offset_ms,
      end_offset_ms=excluded.end_offset_ms, cue_sheet_path=excluded.cue_sheet_path,
      indexed_at=strftime('%s','now')
  `)
  const upsertTrackArtist = db.prepare(`
    INSERT OR IGNORE INTO track_artists (track_id, artist_id, role, position) VALUES (?, ?, ?, ?)
  `)
  const updateAlbumStats = db.prepare(`
    UPDATE albums
    SET total_tracks = MAX(
          (SELECT COUNT(*) FROM tracks WHERE album_id = albums.id),
          ?
        ),
        total_discs = (SELECT COALESCE(MAX(disc_number), 1) FROM tracks WHERE album_id = albums.id)
    WHERE id = ?
  `)

  const insertAll = db.transaction(() => {
    for (const group of albumGroups.values()) {
      const { albumArtistRaw, albumRaw, tracks: gt } = group

      const anyCompTag = gt.some(t => t.isCompilationTag)
      const compilation = detectCompilation(
        albumArtistRaw,
        albumRaw,
        gt.flatMap((t) => t.artistListRaw.length > 0 ? t.artistListRaw : [t.artistRaw]),
        anyCompTag,
      )
      const albumArtists = compilation
        ? ['Various Artists']
        : (gt.find((track) => track.albumArtistListRaw.length > 0)?.albumArtistListRaw ?? splitArtists(albumArtistRaw))
      const primaryAlbumArtist = albumArtists[0] || albumArtistRaw
      const effectiveAlbumArtist = compilation ? 'Various Artists' : albumArtists.join(', ')

      const albumArtistId = sha256(normStr(primaryAlbumArtist))
      upsertArtist.run(albumArtistId, primaryAlbumArtist, normStr(primaryAlbumArtist), '[]', null, 'none')

      // Album art: embedded first, then folder fallback
      let artPath: string | null = null
      let artworkId: string | null = null
      let artSource = 'none'
      for (const t of gt) {
        if (t.artHash && t.artBuffer && t.artMime) {
          const dest = path.join(artCacheDir(), `${t.artHash}${extensionFromMimeType(t.artMime)}`)
          if (!fs.existsSync(dest)) {
            try { fs.writeFileSync(dest, t.artBuffer) } catch { /* non-critical */ }
          }
          upsertArtwork.run(t.artHash, t.artMime, t.artBuffer)
          artPath = dest
          artworkId = t.artHash
          artSource = 'embedded'
          break
        }
      }
      if (!artPath && gt.length > 0) {
        const folderArt = readFolderArtAsset(path.dirname(gt[0].filePath))
        if (folderArt) {
          upsertArtwork.run(folderArt.hash, folderArt.mimeType, folderArt.data)
          artPath = folderArt.filePath
          artworkId = folderArt.hash
          artSource = 'folder'
        }
      }

      const year = gt.find(t => t.year)?.year ?? null
      const albumId = sha256(normStr(effectiveAlbumArtist) + '\x00' + normStr(albumRaw))
      const groupUpc = gt.find((track) => !!track.upc)?.upc ?? null
      const albumGenres = normalizeGenreTags(gt.flatMap((track) => track.genres))
      upsertAlbum.run(albumId, albumRaw, normStr(albumRaw), groupUpc, year, albumArtistId,
        effectiveAlbumArtist, JSON.stringify(albumGenres), artPath, artworkId, artSource, compilation ? 1 : 0)

      for (const t of gt) {
        const artists = t.artistListRaw.length > 0 ? t.artistListRaw : splitArtists(t.artistRaw)
        const mainArtist = artists[0] || t.artistRaw
        const artistId = sha256(normStr(mainArtist))
        upsertArtist.run(artistId, mainArtist, normStr(mainArtist), JSON.stringify(t.genres), null, 'none')

        const trackId = sha256(t.filePath)
        upsertTrack.run(
          trackId, t.filePath, t.playbackFilePath, t.fileSize, Math.floor(t.fileMtimeMs / 1000),
          t.durationMs, t.format, t.sampleRate, t.bitDepth, t.channels, t.bitrate,
          t.lossless ? 1 : 0, t.title, JSON.stringify(t.genres), t.isrc, t.upc, t.trackNumber, t.discNumber, t.year,
          albumId, artistId, t.hasEmbeddedArt ? 1 : 0, t.artHash,
          t.startOffsetMs, t.endOffsetMs, t.cueSheetPath,
        )

        // Delete stale track_artists rows for this track, then re-insert
        db.prepare('DELETE FROM track_artists WHERE track_id = ?').run(trackId)
        const inferredCredits = inferArtistCredits({
          entityType: 'track',
          title: t.title,
          primaryArtistName: mainArtist,
          artists: artists.map((name) => ({ name })),
        })
        for (let i = 0; i < artists.length; i++) {
          const aId = sha256(normStr(artists[i]))
          upsertArtist.run(aId, artists[i], normStr(artists[i]), JSON.stringify(t.genres), null, 'none')
          upsertTrackArtist.run(trackId, aId, inferredCredits[i]?.role ?? (i === 0 ? 'primary' : 'main'), i)
        }
      }

      const totalTracksHint = gt.reduce((max, track) => Math.max(max, track.albumTotalTracksHint ?? 0), 0)
      updateAlbumStats.run(totalTracksHint, albumId)
    }
  })

  insertAll()
}

function parseM3uPlaylistFile(playlistPath: string): { name: string; entries: string[] } {
  const raw = fs.readFileSync(playlistPath, 'utf8')
  const entries: string[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const resolved = path.isAbsolute(line)
      ? path.normalize(line)
      : path.normalize(path.resolve(path.dirname(playlistPath), line.replace(/\\/g, path.sep)))
    entries.push(resolved)
  }

  return {
    name: path.basename(playlistPath, path.extname(playlistPath)),
    entries,
  }
}

function syncM3uPlaylists(db: Database.Database, folderPath: string, playlistFiles: string[]): void {
  const normalizedPlaylistFiles = playlistFiles.map((playlistPath) => path.normalize(playlistPath))
  const existingPlaylists = db.prepare(`
    SELECT id, source_id
    FROM playlists
    WHERE source = 'm3u' AND source_id LIKE ?
  `).all(folderPath + '%') as Array<{ id: number; source_id: string | null }>

  const stalePlaylists = existingPlaylists.filter((playlist) => {
    if (!playlist.source_id) return true
    return !normalizedPlaylistFiles.includes(path.normalize(playlist.source_id))
  })

  if (stalePlaylists.length > 0) {
    const deletePlaylist = db.prepare(`DELETE FROM playlists WHERE id = ?`)
    db.transaction((playlistIds: number[]) => {
      for (const playlistId of playlistIds) deletePlaylist.run(playlistId)
    })(stalePlaylists.map((playlist) => playlist.id))
  }

  if (normalizedPlaylistFiles.length === 0) return

  const upsertPlaylist = db.prepare(`
    INSERT INTO playlists (name, source, source_id, read_only)
    VALUES (?, 'm3u', ?, 1)
    ON CONFLICT(source, source_id) DO UPDATE SET
      name = excluded.name,
      read_only = 1
    RETURNING id
  `)
  const clearPlaylistTracks = db.prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ?`)
  const insertPlaylistTrack = db.prepare(`
    INSERT INTO playlist_tracks (playlist_id, track_id, position)
    VALUES (?, ?, ?)
  `)
  const resolveTrackId = db.prepare(`
    SELECT id
    FROM tracks
    WHERE file_path = ? OR playback_file_path = ?
    ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, track_number, title
    LIMIT 1
  `)

  db.transaction((playlistPaths: string[]) => {
    for (const playlistPath of playlistPaths) {
      const parsed = parseM3uPlaylistFile(playlistPath)
      const playlistRow = upsertPlaylist.get(parsed.name, playlistPath) as { id: number } | undefined
      if (!playlistRow) continue

      clearPlaylistTracks.run(playlistRow.id)

      let position = 0
      for (const entryPath of parsed.entries) {
        const row = resolveTrackId.get(entryPath, entryPath, entryPath) as { id: string } | undefined
        if (!row?.id) continue
        insertPlaylistTrack.run(playlistRow.id, row.id, position)
        position += 1
      }
    }
  })(normalizedPlaylistFiles)
}

export function rebuildSearchIndex(db: Database.Database): void {
  db.exec(`INSERT INTO search_index(search_index) VALUES('delete-all')`)
  db.exec(`
    INSERT INTO search_index (track_id, title, album_title, artist_name, album_artist_name)
    SELECT t.id, t.title, al.title, ar.name, al.album_artist_name
    FROM tracks t
    LEFT JOIN albums al ON t.album_id = al.id
    LEFT JOIN artists ar ON t.artist_id = ar.id
  `)
}

interface ScanProgressEvent {
  processed: number
  total: number
  currentFile: string
  phase: 'scanning' | 'normalizing' | 'fetching_bios' | 'done'
}

export async function runLibraryScan(
  folderPath: string,
  db: Database.Database,
  onProgress: (p: ScanProgressEvent) => void,
): Promise<void> {
  const SUPPORTED_EXT = new Set(['.flac','.alac','.m4a','.aiff','.aif','.wav','.mp3','.aac','.dsf','.dff'])
  const CUE_EXT = '.cue'
  const M3U_EXTS = new Set(['.m3u', '.m3u8'])

  function collectLibraryEntries(dir: string): { audioFiles: string[]; cueFiles: string[]; playlistFiles: string[] } {
    const audioFiles: string[] = []
    const cueFiles: string[] = []
    const playlistFiles: string[] = []
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return { audioFiles, cueFiles, playlistFiles } }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
    for (const e of entries) {
      if (e.name.startsWith('._')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        const nested = collectLibraryEntries(full)
        audioFiles.push(...nested.audioFiles)
        cueFiles.push(...nested.cueFiles)
        playlistFiles.push(...nested.playlistFiles)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (SUPPORTED_EXT.has(ext)) audioFiles.push(full)
        else if (ext === CUE_EXT) cueFiles.push(full)
        else if (M3U_EXTS.has(ext)) playlistFiles.push(full)
      }
    }
    return { audioFiles, cueFiles, playlistFiles }
  }

  const { audioFiles, cueFiles, playlistFiles } = collectLibraryEntries(folderPath)
  const cueTracksByPlaybackFile = buildCueVirtualTrackIndex(cueFiles)
  const storedArtistSplitVersion = getNumericSettingValue(db, LOCAL_ARTIST_SPLIT_VERSION_KEY) ?? 0
  const forceMetadataRefresh = storedArtistSplitVersion < LOCAL_ARTIST_SPLIT_VERSION

  const logicalEntries: LogicalScanEntry[] = audioFiles.flatMap((audioFilePath): LogicalScanEntry[] => {
    const normalizedPath = path.normalize(audioFilePath)
    const cueTracks = cueTracksByPlaybackFile.get(normalizedPath)
    if (cueTracks && cueTracks.length > 0) {
      const cueMtimeMs = cueTracks.reduce((max, cueTrack) => {
        try {
          return Math.max(max, fs.statSync(cueTrack.cueSheetPath).mtimeMs)
        } catch {
          return max
        }
      }, 0)
      return cueTracks.map((cueTrack) => ({
        logicalPath: cueTrack.logicalFilePath,
        playbackFilePath: audioFilePath,
        cueTrack,
        effectiveMtimeMs: cueMtimeMs,
      }))
    }
    return [{
      logicalPath: audioFilePath,
      playbackFilePath: audioFilePath,
      cueTrack: null,
      effectiveMtimeMs: 0,
    }]
  })

  const total = logicalEntries.length

  // Load existing mtime index for change detection
  const existingMtimes = new Map<string, number>()
  const existing = db.prepare(
    `SELECT file_path, file_modified_at FROM tracks WHERE file_path LIKE ?`
  ).all(folderPath + '%') as Array<{ file_path: string; file_modified_at: number }>
  for (const r of existing) existingMtimes.set(r.file_path, r.file_modified_at)

  const mm = await import('music-metadata')
  const rawTracks: TrackRaw[] = []
  const parsedBaseTrackCache = new Map<string, Promise<TrackRaw>>()

  // Process in batches of 50, yielding between batches
  for (let i = 0; i < logicalEntries.length; i += 50) {
    await pauseBackgroundWorkForPlayback()
    const batch = logicalEntries.slice(i, Math.min(i + 50, logicalEntries.length))
    for (const entry of batch) {
      await pauseBackgroundWorkForPlayback()
      onProgress({ processed: i, total, currentFile: path.basename(entry.playbackFilePath), phase: 'scanning' })
      try {
        const sourceMtimeMs = Math.max(fs.statSync(entry.playbackFilePath).mtimeMs, entry.effectiveMtimeMs)
        const mtimeSec = Math.floor(sourceMtimeMs / 1000)
        if (!forceMetadataRefresh && existingMtimes.get(entry.logicalPath) === mtimeSec) continue

        if (entry.cueTrack) {
          let parsedBaseTrackPromise = parsedBaseTrackCache.get(entry.playbackFilePath)
          if (!parsedBaseTrackPromise) {
            parsedBaseTrackPromise = parseTrackFile(entry.playbackFilePath, mm, null)
            parsedBaseTrackCache.set(entry.playbackFilePath, parsedBaseTrackPromise)
          }
          const baseTrack = await parsedBaseTrackPromise
          rawTracks.push(buildCueVirtualTrackRaw(baseTrack, entry.cueTrack, sourceMtimeMs))
        } else {
          const track = await parseTrackFile(entry.playbackFilePath, mm, null)
          track.filePath = entry.logicalPath
          track.playbackFilePath = entry.playbackFilePath
          track.fileMtimeMs = sourceMtimeMs
          rawTracks.push(track)
        }
      } catch (err) {
        console.warn(`[scanner] ${entry.playbackFilePath}:`, err)
      }
    }
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  onProgress({ processed: total, total, currentFile: '', phase: 'normalizing' })

  // Bulk write in batches of 100 tracks (normalizeAndInsert does a single transaction internally)
  for (let i = 0; i < rawTracks.length; i += 100) {
    await pauseBackgroundWorkForPlayback()
    normalizeAndInsert(rawTracks.slice(i, i + 100), db)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  // Remove deleted files
  const fileSet = new Set(logicalEntries.map((entry) => entry.logicalPath))
  const dbPaths = db.prepare(
    `SELECT file_path FROM tracks WHERE file_path LIKE ?`
  ).all(folderPath + '%') as Array<{ file_path: string }>
  const toDelete = dbPaths.filter(r => !fileSet.has(r.file_path)).map(r => r.file_path)
  if (toDelete.length > 0) {
    deleteLocalTracksByFilePaths(db, toDelete)
  }

  rebuildSearchIndex(db)
  syncM3uPlaylists(db, folderPath, playlistFiles)
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(LOCAL_ARTIST_SPLIT_VERSION_KEY, String(LOCAL_ARTIST_SPLIT_VERSION))
  onProgress({ processed: total, total, currentFile: '', phase: 'done' })
}

export function cleanupLocalLibraryOrphans(db: Database.Database): void {
  db.exec(`
    DELETE FROM track_artists
    WHERE track_id NOT IN (SELECT id FROM tracks)
       OR artist_id NOT IN (SELECT id FROM artists);

    DELETE FROM catalog_track_sources
    WHERE local_track_id IS NOT NULL
      AND local_track_id NOT IN (SELECT id FROM tracks);

    DELETE FROM catalog_album_sources
    WHERE local_album_id IS NOT NULL
      AND local_album_id NOT IN (SELECT id FROM albums);

    DELETE FROM catalog_artist_sources
    WHERE local_artist_id IS NOT NULL
      AND local_artist_id NOT IN (SELECT id FROM artists);
  `)

  const orphanAlbumIds = db.prepare(`
    SELECT id
    FROM albums
    WHERE id NOT IN (
      SELECT DISTINCT album_id
      FROM tracks
      WHERE album_id IS NOT NULL
    )
  `).all() as Array<{ id: string }>

  if (orphanAlbumIds.length > 0) {
    const deleteAlbumSource = db.prepare(`DELETE FROM catalog_album_sources WHERE local_album_id = ?`)
    const deleteAlbum = db.prepare(`DELETE FROM albums WHERE id = ?`)
    db.transaction((albumIds: string[]) => {
      for (const albumId of albumIds) {
        deleteAlbumSource.run(albumId)
        deleteAlbum.run(albumId)
      }
    })(orphanAlbumIds.map(row => row.id))
  }

  const orphanArtistIds = db.prepare(`
    SELECT id
    FROM artists
    WHERE id NOT IN (
      SELECT artist_id
      FROM tracks
      WHERE artist_id IS NOT NULL
      UNION
      SELECT album_artist_id
      FROM albums
      WHERE album_artist_id IS NOT NULL
      UNION
      SELECT artist_id
      FROM track_artists
      WHERE artist_id IS NOT NULL
    )
  `).all() as Array<{ id: string }>

  if (orphanArtistIds.length > 0) {
    const deleteArtistSource = db.prepare(`DELETE FROM catalog_artist_sources WHERE local_artist_id = ?`)
    const deleteArtist = db.prepare(`DELETE FROM artists WHERE id = ?`)
    db.transaction((artistIds: string[]) => {
      for (const artistId of artistIds) {
        deleteArtistSource.run(artistId)
        deleteArtist.run(artistId)
      }
    })(orphanArtistIds.map(row => row.id))
  }

  rebuildSearchIndex(db)
}

export function deleteLocalTracksByFilePaths(db: Database.Database, filePaths: string[]): void {
  if (filePaths.length === 0) return

  const selectTrackId = db.prepare(`
    SELECT id
    FROM tracks
    WHERE file_path = ?
  `)
  const deletePlaylistTrack = db.prepare(`DELETE FROM playlist_tracks WHERE track_id = ?`)
  const deleteCatalogTrackSource = db.prepare(`DELETE FROM catalog_track_sources WHERE local_track_id = ?`)
  const deleteTrack = db.prepare(`DELETE FROM tracks WHERE id = ?`)

  db.transaction((paths: string[]) => {
    for (const filePath of paths) {
      const row = selectTrackId.get(filePath) as { id: string } | undefined
      if (!row) continue
      deletePlaylistTrack.run(row.id)
      deleteCatalogTrackSource.run(row.id)
      deleteTrack.run(row.id)
    }
  })(filePaths)
}

export async function rescanWatchFolders(options?: { emitProgress?: boolean }): Promise<void> {
  if (localLibraryRescanPromise) return localLibraryRescanPromise

  localLibraryRescanPromise = (async () => {
    const db = getDb()
    const folders = db.prepare(
      'SELECT path FROM watch_folders ORDER BY added_at'
    ).all() as Array<{ path: string }>
    const onProgress = options?.emitProgress
      ? (progress: ScanProgressEvent) => sendToRenderer('library:scan-progress', progress)
      : () => {}

  for (const { path: folderPath } of folders) {
      await pauseBackgroundWorkForPlayback()
      if (!fs.existsSync(folderPath)) continue
      await runLibraryScan(folderPath, db, onProgress)
      db.prepare(
        `UPDATE watch_folders SET last_scanned_at = strftime('%s','now') WHERE path = ?`
      ).run(folderPath)
    }

    cleanupLocalLibraryOrphans(db)

    const pendingProviderSync = getLibraryScannerDeps().getProviderLibrarySyncPromise()
    if (pendingProviderSync) {
      try {
        await pendingProviderSync
      } catch {
        // Local rescan can still rebuild the catalog from whatever data is available.
      }
    }

    await getLibraryScannerDeps().rebuildCatalogGraphFromSources()
    sendToRenderer('catalog:changed')
    sendToRenderer('library:changed')
    sendToRenderer('playlists:changed')
  })()

  try {
    await localLibraryRescanPromise
  } finally {
    localLibraryRescanPromise = null
  }
}
