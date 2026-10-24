import type Database from 'better-sqlite3'
import type { ProviderLibraryRecordV1, ProviderTrackV1 } from '../../../src/provider-api/v1'
import { inferArtistCredits } from '../../../src/services/catalog/creditHeuristics'
import { providerAlbumRowId, providerArtistRowId, providerTrackRowId } from '../shared/normalize'

const ARTWORK_CONCURRENCY = 8

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim()
}

function genres(values: string[] | undefined): string {
  const seen = new Set<string>()
  return JSON.stringify((values ?? []).filter((value) => {
    const key = normalize(value.trim())
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }))
}

export function providerLibraryRowId(provider: string, kind: 'artist' | 'album' | 'track', sourceId: string): string {
  if (kind === 'track') return providerTrackRowId(provider, sourceId)
  if (kind === 'album') return providerAlbumRowId(provider, sourceId)
  return providerArtistRowId(provider, sourceId)
}

export interface LibraryMirrorResult {
  artists: number
  albums: number
  tracks: number
  playlists: number
  folders: number
}

/** Core-owned mirror of a completed provider library snapshot. */
export async function mirrorProviderLibrary(
  db: Database.Database,
  provider: string,
  records: ProviderLibraryRecordV1[],
  cacheArtwork: (url: string | null | undefined) => Promise<string | null>,
  shouldCommit: () => boolean = () => true,
): Promise<LibraryMirrorResult> {
  const artwork = new Map<string, string | null>()
  const urls = new Set<string>()
  for (const record of records) {
    if (record.type !== 'album' && record.type !== 'playlist' && record.type !== 'track') continue
    const url = record.value.artworkUrl
    if (url) urls.add(url)
  }
  // Large remote libraries have thousands of distinct covers; fetch a bounded number at once.
  const pending = [...urls]
  await Promise.all(Array.from({ length: Math.min(ARTWORK_CONCURRENCY, pending.length) }, async () => {
    for (let url = pending.shift(); url !== undefined; url = pending.shift()) {
      artwork.set(url, await cacheArtwork(url))
    }
  }))
  const artworkId = (url: string | null | undefined) => url ? artwork.get(url) ?? null : null
  const artists = new Map(records.filter((item) => item.type === 'artist').map((item) => [item.value.sourceId, item.value]))
  const albums = new Map(records.filter((item) => item.type === 'album').map((item) => [item.value.sourceId, item.value]))
  const tracks = new Map(records.filter((item) => item.type === 'track').map((item) => [item.value.sourceId, item.value]))
  const folders = new Map(records.filter((item) => item.type === 'playlistFolder').map((item) => [item.value.sourceId, item.value]))
  const playlists = new Map(records.filter((item) => item.type === 'playlist').map((item) => [item.value.sourceId, item.value]))
  const memberships = records.filter((item) => item.type === 'playlistTrack')
  // Existing imports may predate the v1 row-ID convention. Resolve by the
  // unique (source, source_id) identity so a mirror never rewrites their IDs.
  const existingIds = {
    artist: new Map((db.prepare(`SELECT source_id, id FROM artists WHERE source = ? AND source_id IS NOT NULL`).all(provider) as Array<{ source_id: string; id: string }>).map((row) => [row.source_id, row.id])),
    album: new Map((db.prepare(`SELECT source_id, id FROM albums WHERE source = ? AND source_id IS NOT NULL`).all(provider) as Array<{ source_id: string; id: string }>).map((row) => [row.source_id, row.id])),
    track: new Map((db.prepare(`SELECT source_id, id FROM tracks WHERE source = ? AND source_id IS NOT NULL`).all(provider) as Array<{ source_id: string; id: string }>).map((row) => [row.source_id, row.id])),
  }
  const id = (kind: 'artist' | 'album' | 'track', sourceId: string) =>
    existingIds[kind].get(sourceId) ?? providerLibraryRowId(provider, kind, sourceId)

  if (!shouldCommit()) throw new Error('Library sync was cancelled before commit')
  db.transaction(() => {
    const upsertArtist = db.prepare(`
      INSERT INTO artists (id, name, normalized_name, genres, source, source_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, normalized_name = excluded.normalized_name,
        genres = CASE WHEN excluded.genres != '[]' THEN excluded.genres ELSE artists.genres END,
        source = excluded.source, source_id = excluded.source_id
    `)
    for (const [sourceId, artist] of artists) {
      upsertArtist.run(id('artist', sourceId), artist.name, artist.normalizedName ?? normalize(artist.name), genres(artist.genres), provider, sourceId)
    }

    const upsertAlbum = db.prepare(`
      INSERT INTO albums (
        id, title, normalized_title, upc, year, total_tracks, total_discs,
        album_artist_id, album_artist_name, art_path, artwork_id, art_source,
        genres, source, source_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, normalized_title = excluded.normalized_title,
        upc = COALESCE(excluded.upc, albums.upc), year = excluded.year,
        total_tracks = excluded.total_tracks, total_discs = excluded.total_discs,
        album_artist_id = excluded.album_artist_id, album_artist_name = excluded.album_artist_name,
        art_path = COALESCE(excluded.art_path, albums.art_path),
        artwork_id = COALESCE(excluded.artwork_id, albums.artwork_id),
        art_source = CASE WHEN excluded.artwork_id IS NOT NULL THEN excluded.art_source ELSE albums.art_source END,
        genres = CASE WHEN excluded.genres != '[]' THEN excluded.genres ELSE albums.genres END,
        source = excluded.source, source_id = excluded.source_id
    `)
    for (const [sourceId, album] of albums) {
      const primaryArtistId = album.primaryArtistSourceId && artists.has(album.primaryArtistSourceId)
        ? id('artist', album.primaryArtistSourceId) : null
      const cachedArtwork = artworkId(album.artworkUrl)
      upsertAlbum.run(
        id('album', sourceId), album.title, album.normalizedTitle ?? normalize(album.title),
        album.upc ?? null, album.year ?? null, album.totalTracks ?? null, album.totalDiscs ?? 1,
        primaryArtistId, album.primaryArtistName ?? null, album.artworkUrl ?? null,
        cachedArtwork, cachedArtwork ? provider : 'none', genres(album.genres), provider, sourceId,
      )
    }

    const upsertTrack = db.prepare(`
      INSERT INTO tracks (
        id, file_path, duration_ms, format, sample_rate, bit_depth, channels,
        bitrate, lossless, title, genres, isrc, upc, track_number, disc_number,
        album_id, artist_id, indexed_at, source, source_id, artwork_id, art_path, unavailable_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path, duration_ms = excluded.duration_ms,
        format = CASE WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.format ELSE excluded.format END,
        sample_rate = CASE WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.sample_rate ELSE excluded.sample_rate END,
        bit_depth = CASE WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.bit_depth ELSE excluded.bit_depth END,
        channels = CASE WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.channels ELSE excluded.channels END,
        bitrate = CASE WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.bitrate ELSE excluded.bitrate END,
        lossless = CASE WHEN tracks.stream_info_fetched_at IS NOT NULL THEN tracks.lossless ELSE excluded.lossless END,
        title = excluded.title,
        genres = CASE WHEN excluded.genres != '[]' THEN excluded.genres ELSE tracks.genres END,
        isrc = COALESCE(excluded.isrc, tracks.isrc), upc = COALESCE(excluded.upc, tracks.upc),
        track_number = excluded.track_number, disc_number = excluded.disc_number,
        album_id = excluded.album_id, artist_id = excluded.artist_id,
        source = excluded.source, source_id = excluded.source_id,
        artwork_id = COALESCE(excluded.artwork_id, tracks.artwork_id),
        art_path = COALESCE(excluded.art_path, tracks.art_path),
        unavailable_reason = excluded.unavailable_reason
    `)
    const clearCredits = db.prepare(`DELETE FROM track_artists WHERE track_id = ?`)
    const addCredit = db.prepare(`INSERT OR REPLACE INTO track_artists (track_id, artist_id, role, position) VALUES (?, ?, ?, ?)`)
    for (const [sourceId, track] of tracks) {
      const trackId = id('track', sourceId)
      const albumId = track.albumSourceId && albums.has(track.albumSourceId) ? id('album', track.albumSourceId) : null
      const primaryArtistId = track.primaryArtistSourceId && artists.has(track.primaryArtistSourceId)
        ? id('artist', track.primaryArtistSourceId) : null
      upsertTrack.run(
        trackId, `${provider}://track/${sourceId}`, track.durationMs,
        track.format?.format ?? null, track.format?.sampleRate ?? null, track.format?.bitDepth ?? null,
        track.format?.channels ?? null, track.format?.bitrate ?? null, track.format?.isLossless ? 1 : 0,
        track.title, genres(track.genres), track.isrc ?? null, track.upc ?? null,
        track.trackNumber ?? null, track.discNumber ?? 1, albumId, primaryArtistId,
        provider, sourceId,
        // The track's own picture; views show it only when the album has no cover.
        artworkId(track.artworkUrl),
        track.artworkUrl ?? null,
        // The snapshot replaces what the last sync or a failed playback said.
        track.playable === false ? (track.unavailableReason ?? 'other') : null,
      )
      reconcileCredits(trackId, track, artists, id, clearCredits, addCredit)
    }

    const insertFolder = db.prepare(`
      INSERT INTO playlist_folders (name, created_at, source, source_id, parent_id, read_only, position)
      VALUES (?, strftime('%s','now'), ?, ?, NULL, 1, ?) ON CONFLICT DO NOTHING
    `)
    const updateFolder = db.prepare(`
      UPDATE playlist_folders SET name = ?, parent_id = ?, read_only = 1, position = ?
      WHERE source = ? AND source_id = ?
    `)
    const findFolder = db.prepare(`SELECT id FROM playlist_folders WHERE source = ? AND source_id = ?`)
    for (const [sourceId, folder] of folders) insertFolder.run(folder.name, provider, sourceId, folder.position ?? 0)
    for (const [sourceId, folder] of folders) {
      const parent = folder.parentSourceId ? findFolder.get(provider, folder.parentSourceId) as { id: number } | undefined : undefined
      updateFolder.run(folder.name, parent?.id ?? null, folder.position ?? 0, provider, sourceId)
    }

    const insertPlaylist = db.prepare(`
      INSERT INTO playlists (name, created_at, source, source_id, read_only, artwork_id, folder_id, folder_position)
      VALUES (?, strftime('%s','now'), ?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING
    `)
    const updatePlaylist = db.prepare(`
      UPDATE playlists SET name = ?, read_only = 1, artwork_id = COALESCE(?, artwork_id),
        folder_id = ?, folder_position = ? WHERE source = ? AND source_id = ?
    `)
    const findPlaylist = db.prepare(`SELECT id FROM playlists WHERE source = ? AND source_id = ?`)
    for (const [sourceId, playlist] of playlists) {
      const folder = playlist.folderSourceId ? findFolder.get(provider, playlist.folderSourceId) as { id: number } | undefined : undefined
      const cachedArtwork = artworkId(playlist.artworkUrl)
      insertPlaylist.run(playlist.title, provider, sourceId, cachedArtwork, folder?.id ?? null, playlist.folderPosition ?? null)
      updatePlaylist.run(playlist.title, cachedArtwork, folder?.id ?? null, playlist.folderPosition ?? null, provider, sourceId)
      db.prepare("UPDATE playlists SET playback_provider_id = ?, management = 'provider', legacy_mixed = 0 WHERE source = ? AND source_id = ?").run(provider, provider, sourceId)
    }

    const byPlaylist = new Map<string, Array<{ trackSourceId: string; position: number }>>()
    for (const membership of memberships) {
      const list = byPlaylist.get(membership.value.playlistSourceId) ?? []
      list.push(membership.value)
      byPlaylist.set(membership.value.playlistSourceId, list)
    }
    const existingMembers = db.prepare(`SELECT id, track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id`)
    const moveMember = db.prepare(`UPDATE playlist_tracks SET position = ? WHERE id = ?`)
    const addMember = db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`)
    const deleteMember = db.prepare(`DELETE FROM playlist_tracks WHERE id = ?`)
    for (const sourceId of playlists.keys()) {
      const row = findPlaylist.get(provider, sourceId) as { id: number } | undefined
      if (!row) continue
      const available = new Map<string, number[]>()
      for (const item of existingMembers.all(row.id) as Array<{ id: number; track_id: string }>) {
        const ids = available.get(item.track_id) ?? []
        ids.push(item.id)
        available.set(item.track_id, ids)
      }
      const next = (byPlaylist.get(sourceId) ?? []).sort((left, right) => left.position - right.position)
      for (const membership of next) {
        if (!tracks.has(membership.trackSourceId)) continue
        const trackId = id('track', membership.trackSourceId)
        const reused = available.get(trackId)?.shift()
        if (reused != null) moveMember.run(membership.position, reused)
        else addMember.run(row.id, trackId, membership.position)
      }
      for (const stale of available.values()) for (const itemId of stale) deleteMember.run(itemId)
    }

    cleanupStaleRows(db, provider, {
      artists: new Set([...artists.keys()].map((sourceId) => id('artist', sourceId))),
      albums: new Set([...albums.keys()].map((sourceId) => id('album', sourceId))),
      tracks: new Set([...tracks.keys()].map((sourceId) => id('track', sourceId))),
      playlists: new Set(playlists.keys()),
      folders: new Set(folders.keys()),
    })
  })()

  return { artists: artists.size, albums: albums.size, tracks: tracks.size, playlists: playlists.size, folders: folders.size }
}

function cleanupStaleRows(
  db: Database.Database,
  provider: string,
  seen: { artists: Set<string>; albums: Set<string>; tracks: Set<string>; playlists: Set<string>; folders: Set<string> },
): void {
  // A local playlist may pin a remote track even after that provider removes
  // it from the remote library. Keep its album and all credited artists too.
  const pinned = db.prepare(`
    SELECT DISTINCT t.id, t.album_id, t.artist_id
    FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id
    JOIN playlists p ON p.id = pt.playlist_id
    WHERE t.source = ? AND p.management = 'app'
  `).all(provider) as Array<{ id: string; album_id: string | null; artist_id: string | null }>
  const pinnedTracks = new Set(pinned.map((row) => row.id))
  const pinnedAlbums = new Set(pinned.map((row) => row.album_id).filter((id): id is string => !!id))
  const pinnedArtists = new Set(pinned.map((row) => row.artist_id).filter((id): id is string => !!id))
  for (const row of pinned) {
    for (const credit of db.prepare(`SELECT artist_id FROM track_artists WHERE track_id = ?`).all(row.id) as Array<{ artist_id: string | null }>) {
      if (credit.artist_id) pinnedArtists.add(credit.artist_id)
    }
  }
  for (const albumId of pinnedAlbums) {
    const row = db.prepare(`SELECT album_artist_id FROM albums WHERE id = ?`).get(albumId) as { album_artist_id: string | null } | undefined
    if (row?.album_artist_id) pinnedArtists.add(row.album_artist_id)
  }

  const staleRows = (table: string) => db.prepare(`SELECT id, source_id FROM ${table} WHERE source = ?`).all(provider) as Array<{ id: string | number; source_id: string }>
  const deleteTrackLink = db.prepare(`DELETE FROM catalog_track_sources WHERE local_track_id = ?`)
  const deleteTrack = db.prepare(`DELETE FROM tracks WHERE source = ? AND id = ?`)
  for (const row of staleRows('tracks')) {
    if (seen.tracks.has(String(row.id)) || pinnedTracks.has(String(row.id))) continue
    deleteTrackLink.run(row.id)
    deleteTrack.run(provider, row.id)
  }
  const deleteAlbumLink = db.prepare(`DELETE FROM catalog_album_sources WHERE local_album_id = ?`)
  const deleteAlbum = db.prepare(`DELETE FROM albums WHERE source = ? AND id = ?`)
  for (const row of staleRows('albums')) {
    if (seen.albums.has(String(row.id)) || pinnedAlbums.has(String(row.id))) continue
    deleteAlbumLink.run(row.id)
    deleteAlbum.run(provider, row.id)
  }
  const deleteArtistLink = db.prepare(`DELETE FROM catalog_artist_sources WHERE local_artist_id = ?`)
  const deleteArtist = db.prepare(`DELETE FROM artists WHERE source = ? AND id = ?`)
  for (const row of staleRows('artists')) {
    if (seen.artists.has(String(row.id)) || pinnedArtists.has(String(row.id))) continue
    deleteArtistLink.run(row.id)
    deleteArtist.run(provider, row.id)
  }
  const deletePlaylist = db.prepare(`DELETE FROM playlists WHERE source = ? AND source_id = ?`)
  for (const row of staleRows('playlists')) {
    if (!seen.playlists.has(row.source_id)) deletePlaylist.run(provider, row.source_id)
  }
  if (seen.folders.size > 0) {
    const deleteFolder = db.prepare(`DELETE FROM playlist_folders WHERE source = ? AND source_id = ?`)
    for (const row of staleRows('playlist_folders')) {
      if (!seen.folders.has(row.source_id)) deleteFolder.run(provider, row.source_id)
    }
  }
}

function reconcileCredits(
  trackId: string,
  track: ProviderTrackV1,
  artists: Map<string, { sourceId: string }>,
  id: (kind: 'artist' | 'album' | 'track', sourceId: string) => string,
  clear: Database.Statement,
  add: Database.Statement,
): void {
  clear.run(trackId)
  const credits = (track.artists ?? []).filter((credit) => !!credit.artistSourceId && artists.has(credit.artistSourceId))
  const inferred = inferArtistCredits({
    entityType: 'track',
    title: track.title,
    primaryArtistSourceId: track.primaryArtistSourceId ?? null,
    primaryArtistName: track.primaryArtistName ?? null,
    artists: credits.map((credit) => ({ sourceId: credit.artistSourceId!, name: credit.artistName })),
  })
  credits.forEach((credit, position) => {
    add.run(trackId, id('artist', credit.artistSourceId!), inferred[position]?.role ?? credit.role, position)
  })
}

function isWebUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim())
}

/**
 * Library tables carry no provider links, so a catalog rebuilt from them has
 * none. After the rebuild, copy each snapshot record's `providerUrl` onto its
 * catalog source row; later rebuilds keep it (their upserts COALESCE the URL).
 */
export function applyProviderLibraryUrls(db: Database.Database, provider: string, records: ProviderLibraryRecordV1[]): number {
  const statements = {
    artist: db.prepare(`UPDATE catalog_artist_sources SET provider_url = ? WHERE provider = ? AND source_id = ? AND provider_url IS NOT ?`),
    album: db.prepare(`UPDATE catalog_album_sources SET provider_url = ? WHERE provider = ? AND source_id = ? AND provider_url IS NOT ?`),
    track: db.prepare(`UPDATE catalog_track_sources SET provider_url = ? WHERE provider = ? AND source_id = ? AND provider_url IS NOT ?`),
  }
  let updated = 0
  db.transaction(() => {
    for (const record of records) {
      if (record.type !== 'artist' && record.type !== 'album' && record.type !== 'track') continue
      const url = record.value.providerUrl
      if (!isWebUrl(url)) continue
      const trimmed = url.trim()
      updated += statements[record.type].run(trimmed, provider, record.value.sourceId, trimmed).changes
    }
  })()
  return updated
}
