import { existsSync } from 'node:fs'
import type Database from "better-sqlite3"
import type { CatalogProviderName } from "../../../src/services/catalog"
import { cacheRemoteArtwork } from "../artwork/cache"
import { ensureCatalogReady, getCatalogBrowseService } from "../catalog/services"
import { isProviderAvailable, listProviderDescriptors } from "../providers"
import { normStr, providerAlbumRowId, providerArtistRowId, providerTrackRowId } from "../shared/normalize"

type PlaylistSourceRow = {
  source: string
  read_only: number
  playback_provider_id: string
  management: string
  legacy_mixed: number
}

type PlaylistTrackQueryRow = {
  playlist_item_id: number
  playlist_position: number
  playlist_stack_id: number | null
  playlist_stack_position: number | null
  playlist_stack_size: number | null
  id: string
  file_path: string
  playback_file_path?: string | null
  start_offset_ms?: number | null
  end_offset_ms?: number | null
  cue_sheet_path?: string | null
  source: string
  source_id: string | null
  title: string
  track_number: number | null
  disc_number: number
  unavailable_reason?: string | null
  catalog_track_id?: string | null
  catalog_album_id?: string | null
  catalog_artist_id?: string | null
  duration: number
  format: string | null
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  lossless: number
  stream_info_fetched_at?: number | null
  year: number | null
  file_size: number | null
  modified_at: number | null
  has_embedded_art: number
  art_hash: string | null
  album_id: string | null
  artist_id: string | null
  artist_name: string | null
  artist_credit_name?: string | null
  album_title: string | null
  album_art_path: string | null
  album_artwork_id: string | null
  track_artwork_id?: string | null
  track_art_path?: string | null
  album_artwork_url?: string | null
}

type PlaylistPlaybackTrackRow = Omit<PlaylistTrackQueryRow, 'playlist_position'>

interface PlaylistResolvedItem {
  playlistItemId: number
  playlistPosition: number
  row: PlaylistTrackQueryRow
  stackId: number | null
  stackPosition: number | null
}

interface PlaybackUnit {
  kind: 'single' | 'stack'
  unitId: string
  items: PlaylistResolvedItem[]
}

interface ResolvedPlaybackQueue {
  rows: PlaylistPlaybackTrackRow[]
  startIndex: number
  skippedCount?: number
}

type ProviderHydratedArtist = {
  catalogArtistId: string
  sourceId: string
  localArtistId: string
  name: string
  role: string
  position: number
}

export function isLocalPlaylistSource(source: string | null | undefined): boolean {
  return source === 'local'
}

function shuffleArray<T>(items: T[]): T[] {
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export function getPlaylistSourceRow(db: Database.Database, playlistId: number): PlaylistSourceRow | undefined {
  return db.prepare(`SELECT source, read_only, playback_provider_id, management, legacy_mixed FROM playlists WHERE id = ?`).get(playlistId) as PlaylistSourceRow | undefined
}

export function normalizePlaylistTrackPositions(db: Database.Database, playlistId: number): void {
  const remaining = db.prepare(
    `SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id`
  ).all(playlistId) as Array<{ id: number }>
  const updatePosition = db.prepare(`UPDATE playlist_tracks SET position = ? WHERE id = ?`)
  remaining.forEach((row, index) => updatePosition.run(index, row.id))
}

function dissolvePlaylistStackIds(db: Database.Database, stackIds: number[]): void {
  if (stackIds.length === 0) return
  const uniqueStackIds = [...new Set(stackIds.filter((value) => Number.isFinite(value)))]
  const dissolveStack = db.prepare(`DELETE FROM playlist_stacks WHERE id = ?`)
  uniqueStackIds.forEach((stackId) => dissolveStack.run(stackId))
}

export function repairPlaylistStacks(db: Database.Database, playlistId: number): void {
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || !isLocalPlaylistSource(playlist.source)) return

  const deleteInvalidMembership = db.prepare(`
    DELETE FROM playlist_stack_items
    WHERE stack_id = ? AND playlist_track_id = ?
  `)
  const invalidMemberships = db.prepare(`
    SELECT psi.stack_id, psi.playlist_track_id
    FROM playlist_stack_items psi
    JOIN playlist_stacks ps ON ps.id = psi.stack_id
    LEFT JOIN playlist_tracks pt ON pt.id = psi.playlist_track_id
    WHERE ps.playlist_id = ?
      AND (pt.id IS NULL OR pt.playlist_id != ps.playlist_id)
  `).all(playlistId) as Array<{ stack_id: number; playlist_track_id: number }>
  invalidMemberships.forEach((row) => deleteInvalidMembership.run(row.stack_id, row.playlist_track_id))

  const stackRows = db.prepare(`
    SELECT ps.id as stack_id,
           psi.playlist_track_id,
           psi.position as stack_position,
           pt.position as playlist_position
    FROM playlist_stacks ps
    JOIN playlist_stack_items psi ON psi.stack_id = ps.id
    JOIN playlist_tracks pt ON pt.id = psi.playlist_track_id
    WHERE ps.playlist_id = ?
    ORDER BY ps.id, pt.position, psi.position, psi.playlist_track_id
  `).all(playlistId) as Array<{
    stack_id: number
    playlist_track_id: number
    stack_position: number
    playlist_position: number
  }>

  const updateStackPosition = db.prepare(`
    UPDATE playlist_stack_items
    SET position = ?
    WHERE stack_id = ? AND playlist_track_id = ?
  `)

  const rowsByStack = new Map<number, typeof stackRows>()
  for (const row of stackRows) {
    const bucket = rowsByStack.get(row.stack_id)
    if (bucket) bucket.push(row)
    else rowsByStack.set(row.stack_id, [row])
  }

  const invalidStackIds: number[] = []
  for (const [stackId, rows] of rowsByStack) {
    if (rows.length < 2) {
      invalidStackIds.push(stackId)
      continue
    }

    const startPosition = rows[0]?.playlist_position ?? 0
    const isContiguous = rows.every((row, index) => row.playlist_position === startPosition + index)
    if (!isContiguous) {
      invalidStackIds.push(stackId)
      continue
    }

    rows.forEach((row, index) => {
      if (row.stack_position !== index) {
        updateStackPosition.run(index, stackId, row.playlist_track_id)
      }
    })
  }

  const undersizedStacks = db.prepare(`
    SELECT ps.id
    FROM playlist_stacks ps
    LEFT JOIN playlist_stack_items psi ON psi.stack_id = ps.id
    WHERE ps.playlist_id = ?
    GROUP BY ps.id
    HAVING COUNT(psi.playlist_track_id) < 2
  `).all(playlistId) as Array<{ id: number }>

  dissolvePlaylistStackIds(db, [
    ...invalidStackIds,
    ...undersizedStacks.map((row) => row.id),
  ])
}

function queryPlaylistTrackRows(
  db: Database.Database,
  playlistId: number,
  playlistItemIds?: number[],
): PlaylistTrackQueryRow[] {
  const hasFilter = Array.isArray(playlistItemIds)
  if (hasFilter && playlistItemIds.length === 0) return []

  const filterSql = hasFilter
    ? `AND pt.id IN (${playlistItemIds.map(() => '?').join(', ')})`
    : ''

  return db.prepare(`
    WITH stack_sizes AS (
      SELECT psi.stack_id, COUNT(*) as stack_size
      FROM playlist_stack_items psi
      GROUP BY psi.stack_id
    )
    SELECT pt.id as playlist_item_id,
           pt.position as playlist_position,
           CASE WHEN p.source = 'local' THEN psi.stack_id ELSE NULL END as playlist_stack_id,
           CASE WHEN p.source = 'local' THEN psi.position ELSE NULL END as playlist_stack_position,
           CASE WHEN p.source = 'local' THEN ss.stack_size ELSE NULL END as playlist_stack_size,
           t.id, t.file_path, t.playback_file_path, t.start_offset_ms, t.end_offset_ms, t.cue_sheet_path,
           t.source, t.source_id, t.title, t.track_number, t.disc_number, t.unavailable_reason,
           (
             SELECT cts.catalog_track_id
             FROM catalog_track_sources cts
             WHERE cts.local_track_id = t.id
                OR (cts.provider = t.source AND cts.source_id = COALESCE(t.source_id, t.id))
             ORDER BY cts.in_library DESC, cts.match_confidence DESC
             LIMIT 1
           ) as catalog_track_id,
           (
             SELECT cas.catalog_album_id
             FROM catalog_album_sources cas
             WHERE cas.local_album_id = al.id
                OR (cas.provider = al.source AND cas.source_id = COALESCE(al.source_id, al.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_album_id,
           (
             SELECT cas.catalog_artist_id
             FROM catalog_artist_sources cas
             WHERE cas.local_artist_id = a.id
                OR (cas.provider = a.source AND cas.source_id = COALESCE(a.source_id, a.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_artist_id,
           t.duration_ms as duration, t.format, t.sample_rate, t.bit_depth,
           t.bitrate, t.channels, t.lossless, t.stream_info_fetched_at, t.year, t.file_size, t.file_modified_at as modified_at,
           t.has_embedded_art, t.art_hash, t.album_id, t.artist_id,
           a.name as artist_name,
           (
             SELECT group_concat(piece, '')
             FROM (
               SELECT ca.name || COALESCE(edge.join_phrase, '') as piece,
                      MIN(edge.position) as sort_position
               FROM catalog_artist_track_edges edge
               JOIN catalog_artists ca ON ca.id = edge.catalog_artist_id
               WHERE edge.catalog_track_id = (
                 SELECT cts.catalog_track_id
                 FROM catalog_track_sources cts
                 WHERE cts.local_track_id = t.id
                    OR (cts.provider = t.source AND cts.source_id = COALESCE(t.source_id, t.id))
                 ORDER BY cts.in_library DESC, cts.match_confidence DESC
                 LIMIT 1
               )
               GROUP BY ca.id, piece
               ORDER BY sort_position, ca.name
             )
           ) as artist_credit_name,
           al.title as album_title,
           al.art_path as album_art_path, al.artwork_id as album_artwork_id, t.artwork_id as track_artwork_id, t.art_path as track_art_path,
           (
             SELECT ca.artwork_url
             FROM catalog_album_sources cas
             JOIN catalog_albums ca ON ca.id = cas.catalog_album_id
             WHERE cas.local_album_id = al.id
                OR (cas.provider = al.source AND cas.source_id = COALESCE(al.source_id, al.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as album_artwork_url
    FROM playlist_tracks pt
    JOIN playlists p ON p.id = pt.playlist_id
    JOIN tracks t ON pt.track_id = t.id
    LEFT JOIN playlist_stack_items psi ON psi.playlist_track_id = pt.id
    LEFT JOIN stack_sizes ss ON ss.stack_id = psi.stack_id
    LEFT JOIN artists a ON t.artist_id = a.id
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE pt.playlist_id = ?
      ${filterSql}
    ORDER BY pt.position
  `).all(playlistId, ...(playlistItemIds ?? [])) as PlaylistTrackQueryRow[]
}

export function getPlaylistResolvedItems(
  db: Database.Database,
  playlistId: number,
  playlistItemIds?: number[],
): PlaylistResolvedItem[] {
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist) return []
  if (isLocalPlaylistSource(playlist.source)) {
    repairPlaylistStacks(db, playlistId)
  }

  return queryPlaylistTrackRows(db, playlistId, playlistItemIds).map((row) => ({
    playlistItemId: row.playlist_item_id,
    playlistPosition: row.playlist_position,
    row,
    stackId: row.playlist_stack_id,
    stackPosition: row.playlist_stack_position,
  }))
}

export function toPlaybackTrackRow(row: PlaylistTrackQueryRow): PlaylistPlaybackTrackRow {
  const { playlist_position, ...trackRow } = row
  void playlist_position
  return trackRow
}

async function resolvePreferredPlaybackTrackRow(
  row: PlaylistTrackQueryRow,
): Promise<PlaylistPlaybackTrackRow> {
  const baseRow = toPlaybackTrackRow(row)
  if (row.source === 'local' || !row.catalog_track_id) return baseRow

  await ensureCatalogReady()
  const resolved = await getCatalogBrowseService().resolvePlayback(row.catalog_track_id, row.source, row.source_id)
  if (!resolved) return baseRow

  const resolvedSource = String(resolved.provider ?? resolved.sourceType ?? row.source).trim().toLowerCase() || row.source
  const resolvedStreamOrSourceId = resolved.streamId ?? resolved.sourceId ?? row.source_id ?? null
  const resolvedFormatInfo = resolved.formatInfo ?? null

  return {
    ...baseRow,
    id: resolved.id || baseRow.id,
    file_path: resolved.filePath ?? baseRow.file_path,
    playback_file_path: resolved.playbackFilePath ?? resolved.filePath ?? baseRow.playback_file_path ?? baseRow.file_path,
    source: resolvedSource,
    source_id: resolvedStreamOrSourceId,
    catalog_track_id: resolved.catalogTrackId ?? baseRow.catalog_track_id,
    catalog_album_id: resolved.catalogAlbumId ?? baseRow.catalog_album_id,
    catalog_artist_id: resolved.catalogArtistId ?? baseRow.catalog_artist_id,
    duration: baseRow.duration > 0
      ? baseRow.duration
      : Math.max(0, Math.round((resolved.duration ?? 0) * 1000)),
    format: resolvedFormatInfo?.format ?? baseRow.format,
    sample_rate: resolvedFormatInfo?.sampleRate ?? baseRow.sample_rate,
    bit_depth: resolvedFormatInfo?.bitDepth ?? baseRow.bit_depth,
    bitrate: resolvedFormatInfo?.bitrate ?? baseRow.bitrate,
    channels: resolvedFormatInfo?.channels ?? baseRow.channels,
    lossless: resolvedFormatInfo ? (resolvedFormatInfo.isLossless ? 1 : 0) : baseRow.lossless,
    stream_info_fetched_at: resolvedFormatInfo ? Date.now() : baseRow.stream_info_fetched_at,
  }
}

function buildPlaybackUnits(items: PlaylistResolvedItem[]): PlaybackUnit[] {
  const units: PlaybackUnit[] = []

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue

    if (!item.stackId) {
      units.push({
        kind: 'single',
        unitId: `single:${item.playlistItemId}`,
        items: [item],
      })
      continue
    }

    const stackItems = [item]
    while (
      index + 1 < items.length &&
      items[index + 1]?.stackId === item.stackId
    ) {
      index += 1
      stackItems.push(items[index]!)
    }

    units.push({
      kind: 'stack',
      unitId: `stack:${item.stackId}`,
      items: stackItems,
    })
  }

  return units
}

export async function resolvePlaylistPlaybackQueue(
  db: Database.Database,
  playlistId: number,
  options?: { shuffle?: boolean; startPlaylistItemId?: number; startTrackId?: string; playlistItemIds?: number[] },
): Promise<ResolvedPlaybackQueue> {
  const requestedIds = Array.isArray(options?.playlistItemIds)
    ? [...new Set(options!.playlistItemIds.filter((value) => Number.isInteger(value)))]
    : undefined
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (playlist && isLocalPlaylistSource(playlist.source)) {
    await repairPlaylistProviderTrackMetadata(db, playlistId, requestedIds)
  }
  // Tracks the account cannot stream are shown greyed out, not queued; only
  // rows that look playable but are not (missing files, offline providers)
  // count as skipped.
  const allItems = getPlaylistResolvedItems(db, playlistId, requestedIds)
    .filter((item) => !item.row.unavailable_reason)
  const items = allItems.filter(item => {
    const row = item.row
    if (!playlist || (!playlist.legacy_mixed && row.source !== playlist.playback_provider_id)) return false
    return row.source === 'local' ? existsSync(row.playback_file_path ?? row.file_path) : isProviderAvailable(row.source)
  })
  const skippedCount = allItems.length - items.length
  const units = buildPlaybackUnits(items)
  const orderedUnits = options?.shuffle ? shuffleArray(units) : units
  const orderedItems = orderedUnits.flatMap((unit) => unit.items.map((item) => item.row))

  const rows = orderedItems.map((row) => toPlaybackTrackRow(row))
  const requestedStart = options?.startPlaylistItemId != null || options?.startTrackId != null
  let matchedIndex = options?.startPlaylistItemId != null
    ? rows.findIndex((row) => row.playlist_item_id === options.startPlaylistItemId)
    : -1
  // The caller's item id can be stale if a sync rewrote the playlist after the
  // view loaded; fall back to the clicked track rather than starting at row 0.
  if (matchedIndex < 0 && options?.startTrackId != null) {
    matchedIndex = rows.findIndex((row) => row.id === options.startTrackId)
  }
  if (requestedStart && matchedIndex < 0) {
    console.warn('[Puros] Requested playlist start row no longer exists; not starting playback', {
      playlistId,
      startPlaylistItemId: options?.startPlaylistItemId ?? null,
      startTrackId: options?.startTrackId ?? null,
    })
    return { rows: [], startIndex: 0 }
  }
  const startIndex = Math.max(matchedIndex, 0)

  const startItem = orderedItems[startIndex]
  if (startItem) {
    rows[startIndex] = await resolvePreferredPlaybackTrackRow(startItem)
  }

  return { rows, startIndex, skippedCount }
}

function isAvailableHostMirrorProvider(providerId: string): boolean {
  return isProviderAvailable(providerId)
    && listProviderDescriptors().some(({ manifest }) => (
      manifest.id === providerId && manifest.librarySyncMode === 'host-mirror'
    ))
}

function getProviderSourceId(
  sourceLinks: Array<{ provider: CatalogProviderName; sourceId: string }> | null | undefined,
  providerId: string,
) {
  return sourceLinks?.find((source) => source.provider === providerId)?.sourceId ?? null
}

async function hydrateProviderTrackFromCatalog(
  db: Database.Database,
  options: {
    providerId: string
    catalogTrackId: string
    preferredTrackSourceId?: string | null
  },
): Promise<string | null> {
  await ensureCatalogReady()
  const browse = getCatalogBrowseService()
  const track = browse.getTrackSummary(options.catalogTrackId)
  if (!track) return null

  const { providerId } = options
  const trackSourceId = options.preferredTrackSourceId ?? getProviderSourceId(track.sourceLinks, providerId)
  if (!trackSourceId) return null

  const primaryArtistSummary = track.primaryArtistId
    ? browse.getArtistSummary(track.primaryArtistId)
    : null
  const primaryArtistName = primaryArtistSummary?.name ?? track.primaryArtistName ?? null
  const primaryArtistSourceId = primaryArtistSummary
    ? getProviderSourceId(primaryArtistSummary.sourceLinks, providerId)
    : null

  const creditedArtists: ProviderHydratedArtist[] = []
  const seenCatalogArtistIds = new Set<string>()
  for (const credit of track.credits ?? []) {
    if (!credit.artistId || seenCatalogArtistIds.has(credit.artistId)) continue
    const artistSummary = browse.getArtistSummary(credit.artistId)
    const artistSourceId = artistSummary ? getProviderSourceId(artistSummary.sourceLinks, providerId) : null
    const artistName = artistSummary?.name ?? credit.artistName ?? null
    if (!artistSourceId || !artistName) continue
    seenCatalogArtistIds.add(credit.artistId)
    creditedArtists.push({
      catalogArtistId: credit.artistId,
      sourceId: artistSourceId,
      localArtistId: providerArtistRowId(providerId, artistSourceId),
      name: artistName,
      role: credit.role ?? (creditedArtists.length === 0 ? 'primary' : 'main'),
      position: credit.position ?? creditedArtists.length,
    })
  }

  if (
    creditedArtists.length === 0 &&
    track.primaryArtistId &&
    primaryArtistSourceId &&
    primaryArtistName
  ) {
    creditedArtists.push({
      catalogArtistId: track.primaryArtistId,
      sourceId: primaryArtistSourceId,
      localArtistId: providerArtistRowId(providerId, primaryArtistSourceId),
      name: primaryArtistName,
      role: 'primary',
      position: 0,
    })
  }

  const upsertArtist = db.prepare(`
    INSERT INTO artists (id, name, normalized_name, source, source_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      normalized_name = excluded.normalized_name,
      source = excluded.source,
      source_id = excluded.source_id
  `)
  const linkCatalogArtist = db.prepare(`
    UPDATE catalog_artist_sources
    SET local_artist_id = COALESCE(?, local_artist_id)
    WHERE catalog_artist_id = ?
      AND provider = ?
      AND source_id = ?
  `)

  const artistRows = new Map<string, { sourceId: string; localArtistId: string; name: string }>()
  if (track.primaryArtistId && primaryArtistSourceId && primaryArtistName) {
    artistRows.set(track.primaryArtistId, {
      sourceId: primaryArtistSourceId,
      localArtistId: providerArtistRowId(providerId, primaryArtistSourceId),
      name: primaryArtistName,
    })
  }
  for (const artist of creditedArtists) {
    artistRows.set(artist.catalogArtistId, {
      sourceId: artist.sourceId,
      localArtistId: artist.localArtistId,
      name: artist.name,
    })
  }

  for (const [catalogArtistId, artist] of artistRows.entries()) {
    upsertArtist.run(artist.localArtistId, artist.name, normStr(artist.name), providerId, artist.sourceId)
    linkCatalogArtist.run(artist.localArtistId, catalogArtistId, providerId, artist.sourceId)
  }

  let localAlbumId: string | null = null
  const album = track.albumId ? browse.getAlbumSummary(track.albumId) : null
  if (album) {
    const albumSourceId = getProviderSourceId(album.sourceLinks, providerId)
    if (albumSourceId) {
      localAlbumId = providerAlbumRowId(providerId, albumSourceId)
      const albumArtistSummary = album.primaryArtistId
        ? (browse.getArtistSummary(album.primaryArtistId) ?? primaryArtistSummary)
        : primaryArtistSummary
      const albumArtistName = albumArtistSummary?.name ?? album.primaryArtistName ?? primaryArtistName ?? null
      const albumArtistSourceId = albumArtistSummary
        ? getProviderSourceId(albumArtistSummary.sourceLinks, providerId)
        : primaryArtistSourceId
      const albumArtistLocalId = albumArtistSourceId && albumArtistName
        ? providerArtistRowId(providerId, albumArtistSourceId)
        : null

      if (album.primaryArtistId && albumArtistLocalId && albumArtistName && albumArtistSourceId) {
        upsertArtist.run(albumArtistLocalId, albumArtistName, normStr(albumArtistName), providerId, albumArtistSourceId)
        linkCatalogArtist.run(albumArtistLocalId, album.primaryArtistId, providerId, albumArtistSourceId)
      }

      const artworkId = album.artworkId ?? await cacheRemoteArtwork(album.artworkUrl ?? null)
      db.prepare(`
        INSERT INTO albums (
          id, title, normalized_title, year, total_tracks, total_discs,
          album_artist_id, album_artist_name, art_path, artwork_id, art_source,
          source, source_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          normalized_title = excluded.normalized_title,
          year = excluded.year,
          total_tracks = excluded.total_tracks,
          total_discs = excluded.total_discs,
          album_artist_id = excluded.album_artist_id,
          album_artist_name = excluded.album_artist_name,
          art_path = COALESCE(excluded.art_path, albums.art_path),
          artwork_id = COALESCE(excluded.artwork_id, albums.artwork_id),
          art_source = CASE
            WHEN excluded.artwork_id IS NOT NULL THEN excluded.art_source
            ELSE albums.art_source
          END,
          source = excluded.source,
          source_id = excluded.source_id
      `).run(
        localAlbumId,
        album.title,
        normStr(album.title),
        album.year ?? null,
        album.totalTracks ?? null,
        album.totalDiscs ?? null,
        albumArtistLocalId,
        albumArtistName,
        album.artworkUrl ?? null,
        artworkId,
        artworkId ? providerId : 'none',
        providerId,
        albumSourceId,
      )

      db.prepare(`
        UPDATE catalog_album_sources
        SET local_album_id = COALESCE(?, local_album_id)
        WHERE catalog_album_id = ?
          AND provider = ?
          AND source_id = ?
      `).run(localAlbumId, album.id, providerId, albumSourceId)
    }
  }

  const localTrackId = providerTrackRowId(providerId, trackSourceId)
  const primaryLocalArtistId = track.primaryArtistId
    ? (artistRows.get(track.primaryArtistId)?.localArtistId ?? null)
    : null

  db.prepare(`
    INSERT INTO tracks (
      id, file_path, duration_ms, format, sample_rate, bit_depth, channels,
      bitrate, lossless, title, track_number, disc_number, album_id, artist_id,
      indexed_at, source, source_id, unavailable_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      duration_ms = excluded.duration_ms,
      format = CASE
        WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.format
        ELSE excluded.format
      END,
      sample_rate = CASE
        WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.sample_rate
        ELSE excluded.sample_rate
      END,
      bit_depth = CASE
        WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.bit_depth
        ELSE excluded.bit_depth
      END,
      channels = CASE
        WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.channels
        ELSE excluded.channels
      END,
      bitrate = CASE
        WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.bitrate
        ELSE excluded.bitrate
      END,
      lossless = CASE
        WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.lossless
        ELSE excluded.lossless
      END,
      title = excluded.title,
      track_number = excluded.track_number,
      disc_number = excluded.disc_number,
      album_id = COALESCE(excluded.album_id, tracks.album_id),
      artist_id = COALESCE(excluded.artist_id, tracks.artist_id),
      source = excluded.source,
      source_id = excluded.source_id,
      unavailable_reason = excluded.unavailable_reason
  `).run(
    localTrackId,
    `${providerId}://track/${trackSourceId}`,
    Math.max(0, track.durationMs ?? 0),
    null,
    null,
    null,
    null,
    null,
    0,
    track.title ?? 'Unknown Track',
    track.trackNumber ?? null,
    track.discNumber ?? 1,
    localAlbumId,
    primaryLocalArtistId,
    providerId,
    trackSourceId,
    track.sourceLinks.find((source) => source.provider === providerId && source.sourceId === trackSourceId)?.unavailableReason ?? null,
  )

  db.prepare(`DELETE FROM track_artists WHERE track_id = ?`).run(localTrackId)
  const insertTrackArtist = db.prepare(`
    INSERT OR REPLACE INTO track_artists (track_id, artist_id, role, position)
    VALUES (?, ?, ?, ?)
  `)
  const orderedArtists = creditedArtists.length > 0
    ? [...creditedArtists].sort((a, b) => a.position - b.position)
    : []
  for (const [index, artist] of orderedArtists.entries()) {
    insertTrackArtist.run(localTrackId, artist.localArtistId, artist.role, index)
  }
  if (orderedArtists.length === 0 && primaryLocalArtistId) {
    insertTrackArtist.run(localTrackId, primaryLocalArtistId, 'primary', 0)
  }

  db.prepare(`
    UPDATE catalog_track_sources
    SET local_track_id = COALESCE(?, local_track_id)
    WHERE catalog_track_id = ?
      AND provider = ?
      AND source_id = ?
  `).run(localTrackId, track.id, providerId, trackSourceId)

  return localTrackId
}

export async function repairPlaylistProviderTrackMetadata(
  db: Database.Database,
  playlistId: number,
  playlistItemIds?: number[],
): Promise<void> {
  const hasFilter = Array.isArray(playlistItemIds)
  if (hasFilter && playlistItemIds.length === 0) return
  const providerIds = listProviderDescriptors()
    .filter(({ manifest }) => manifest.librarySyncMode === 'host-mirror' && isProviderAvailable(manifest.id))
    .map(({ manifest }) => manifest.id)
  if (providerIds.length === 0) return

  const filterSql = hasFilter
    ? `AND pt.id IN (${playlistItemIds!.map(() => '?').join(', ')})`
    : ''

  const candidates = db.prepare(`
    SELECT DISTINCT
           t.source AS provider,
           t.source_id,
           (
             SELECT cts.catalog_track_id
             FROM catalog_track_sources cts
             WHERE cts.local_track_id = t.id
                OR (cts.provider = t.source AND cts.source_id = COALESCE(t.source_id, t.id))
             ORDER BY cts.in_library DESC, cts.match_confidence DESC
             LIMIT 1
           ) as catalog_track_id
    FROM playlist_tracks pt
    JOIN playlists p ON p.id = pt.playlist_id
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ?
      AND p.source = 'local'
      AND t.source IN (${providerIds.map(() => '?').join(', ')})
      AND (
        t.artist_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM artists a WHERE a.id = t.artist_id)
        OR t.album_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM albums al WHERE al.id = t.album_id)
        OR EXISTS (
          SELECT 1
          FROM albums al
          WHERE al.id = t.album_id
            AND al.artwork_id IS NULL
            AND (al.art_path IS NULL OR al.art_path = '')
        )
      )
      ${filterSql}
  `).all(playlistId, ...providerIds, ...(playlistItemIds ?? [])) as Array<{
    provider: string
    source_id: string | null
    catalog_track_id: string | null
  }>

  for (const candidate of candidates) {
    if (!candidate.catalog_track_id) continue
    try {
      await hydrateProviderTrackFromCatalog(db, {
        providerId: candidate.provider,
        catalogTrackId: candidate.catalog_track_id,
        preferredTrackSourceId: candidate.source_id ?? null,
      })
    } catch (error) {
      console.warn('[Puros][Playlist] Failed to repair provider playlist metadata:', candidate.provider, candidate.catalog_track_id, error)
    }
  }
}

export async function ensurePlaylistTrackIdForCatalogTrack(
  db: Database.Database,
  catalogTrackId: string,
  preferredProvider?: CatalogProviderName | null,
  preferredSourceId?: string | null,
): Promise<string | null> {
  await ensureCatalogReady()
  const resolved = await getCatalogBrowseService().resolvePlayback(
    catalogTrackId,
    preferredProvider ?? null,
    preferredSourceId ?? null,
  )

  if (!resolved) return null

  if (resolved.provider === 'local' && resolved.sourceId) {
    return resolved.sourceId
  }

  if (!resolved.provider || !resolved.sourceId || !isAvailableHostMirrorProvider(resolved.provider)) {
    return null
  }

  return hydrateProviderTrackFromCatalog(db, {
    providerId: resolved.provider,
    catalogTrackId,
    preferredTrackSourceId: resolved.sourceId,
  })
}
