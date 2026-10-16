import {
  ensureCatalogReady,
  getCatalogSearchService,
  rebuildCatalogGraphFromSources,
} from '../catalog/services'
import { getDb } from '../db'
import { getArtistRowById } from '../metadata/bios'
import { getSettingValue } from '../settings/store'
import { sha256 } from '../shared/normalize'
import { searchRemoteLibraryTracks } from './providerSearch'
import {
  cleanupLocalLibraryOrphans,
  deleteLocalTracksByFilePaths,
  rescanWatchFolders,
  runLibraryScan,
} from './scanner'

type LibraryChangeCallbacks = {
  onCatalogChanged: () => void
  onLibraryChanged: () => void
  onPlaylistsChanged: () => void
}

function showUnavailableSources(): boolean {
  return getSettingValue(getDb(), 'showUnavailableSources') === 'true'
}

function visibleTrackSql(alias: string): string {
  if (showUnavailableSources()) return '1 = 1'
  return `(
    ${alias}.source IN ('local', 'm3u')
    OR EXISTS (
      SELECT 1 FROM catalog_track_sources visible_source
      WHERE visible_source.provider = ${alias}.source
        AND visible_source.source_id = COALESCE(${alias}.source_id, ${alias}.id)
        AND visible_source.available = 1
    )
  )`
}

function visibleAlbumSql(alias: string): string {
  if (showUnavailableSources()) return '1 = 1'
  return `(
    ${alias}.source IN ('local', 'm3u')
    OR EXISTS (
      SELECT 1 FROM catalog_album_sources visible_source
      WHERE visible_source.provider = ${alias}.source
        AND visible_source.source_id = COALESCE(${alias}.source_id, ${alias}.id)
        AND visible_source.available = 1
    )
  )`
}

function visibleArtistSql(alias: string): string {
  if (showUnavailableSources()) return '1 = 1'
  return `(
    ${alias}.source IN ('local', 'm3u')
    OR EXISTS (
      SELECT 1 FROM catalog_artist_sources visible_source
      WHERE visible_source.provider = ${alias}.source
        AND visible_source.source_id = COALESCE(${alias}.source_id, ${alias}.id)
        AND visible_source.available = 1
    )
  )`
}

export async function scanLibraryFolder(
  folderPath: string,
  onProgress: (progress: unknown) => void,
  callbacks: Pick<LibraryChangeCallbacks, 'onCatalogChanged' | 'onLibraryChanged'>,
): Promise<string> {
  const db = getDb()
  db.prepare(`
    INSERT INTO watch_folders (id, path, recursive, added_at)
    VALUES (?, ?, 1, strftime('%s','now'))
    ON CONFLICT(path) DO NOTHING
  `).run(sha256(folderPath), folderPath)
  await runLibraryScan(folderPath, db, onProgress)
  db.prepare(`UPDATE watch_folders SET last_scanned_at = strftime('%s','now') WHERE path = ?`).run(folderPath)
  cleanupLocalLibraryOrphans(db)
  await rebuildCatalogGraphFromSources()
  callbacks.onCatalogChanged()
  callbacks.onLibraryChanged()
  return folderPath
}

export function getLibraryFolders() {
  return getDb().prepare(
    `SELECT id, path, last_scanned_at FROM watch_folders ORDER BY added_at`
  ).all()
}

export async function rescanLibrary(): Promise<void> {
  await rescanWatchFolders({ emitProgress: true })
}

export async function removeLibraryFolder(
  folderId: string,
  callbacks: LibraryChangeCallbacks,
): Promise<boolean> {
  const db = getDb()
  const folder = db.prepare(
    `SELECT id, path FROM watch_folders WHERE id = ?`
  ).get(folderId) as { id: string; path: string } | undefined

  if (!folder) return false

  const trackPaths = db.prepare(`
    SELECT file_path
    FROM tracks
    WHERE file_path LIKE ?
  `).all(folder.path + '%') as Array<{ file_path: string }>
  const playlistIds = db.prepare(`
    SELECT id
    FROM playlists
    WHERE source = 'm3u' AND source_id LIKE ?
  `).all(folder.path + '%') as Array<{ id: number }>

  db.transaction(() => {
    deleteLocalTracksByFilePaths(db, trackPaths.map(row => row.file_path))
    const deletePlaylist = db.prepare(`DELETE FROM playlists WHERE id = ?`)
    for (const playlist of playlistIds) deletePlaylist.run(playlist.id)
    db.prepare(`DELETE FROM watch_folders WHERE id = ?`).run(folder.id)
  })()

  cleanupLocalLibraryOrphans(db)
  await rebuildCatalogGraphFromSources()
  callbacks.onCatalogChanged()
  callbacks.onLibraryChanged()
  callbacks.onPlaylistsChanged()
  return true
}

export function getLibraryTracks(options?: { search?: string; limit?: number; offset?: number }) {
  const db = getDb()
  const params: unknown[] = []
  let where = `WHERE ${visibleTrackSql('t')}`
  if (options?.search) {
    where += ` AND (t.title LIKE ? OR ar.name LIKE ? OR al.title LIKE ?)`
    const term = `%${options.search}%`
    params.push(term, term, term)
  }
  let query = `
    SELECT t.id, t.file_path, t.playback_file_path, t.start_offset_ms, t.end_offset_ms, t.cue_sheet_path,
           t.source, t.source_id, t.title, t.track_number, t.disc_number,
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
             WHERE cas.local_artist_id = ar.id
                OR (cas.provider = ar.source AND cas.source_id = COALESCE(ar.source_id, ar.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_artist_id,
           t.duration_ms as duration, t.format, t.sample_rate, t.bit_depth,
           t.bitrate, t.channels, t.lossless, t.stream_info_fetched_at, t.year, t.file_size,
           t.file_modified_at as modified_at,
           t.has_embedded_art, t.art_hash,
           t.album_id, t.artist_id,
           ar.name as artist_name,
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
           al.art_path as album_art_path,
           al.artwork_id as album_artwork_id, t.artwork_id as track_artwork_id, t.art_path as track_art_path,
           (
             SELECT ca.artwork_url
             FROM catalog_album_sources cas
             JOIN catalog_albums ca ON ca.id = cas.catalog_album_id
             WHERE cas.local_album_id = al.id
                OR (cas.provider = al.source AND cas.source_id = COALESCE(al.source_id, al.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as album_artwork_url
    FROM tracks t
    LEFT JOIN artists ar ON t.artist_id = ar.id
    LEFT JOIN albums al ON t.album_id = al.id
    ${where}
    ORDER BY ar.name, al.title, t.disc_number, t.track_number
  `
  if (options?.limit) {
    query += ` LIMIT ?`; params.push(options.limit)
    if (options.offset) { query += ` OFFSET ?`; params.push(options.offset) }
  }
  return db.prepare(query).all(...params)
}

export function getLibraryAlbums(options?: { sort?: string; limit?: number; offset?: number }) {
  const db = getDb()
  const sortMap: Record<string, string> = {
    artist: 'al.album_artist_name, al.title',
    title:  'al.title',
    year:   'al.year DESC, al.title',
    date_added: 'MIN(t.indexed_at) DESC',
  }
  const orderBy = sortMap[options?.sort ?? 'artist'] ?? sortMap['artist']
  const params: unknown[] = []
  let query = `
    SELECT al.id, al.source, al.source_id, al.title, al.year, al.total_tracks, al.total_discs,
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
             WHERE cas.local_artist_id = ar.id
                OR (cas.provider = ar.source AND cas.source_id = COALESCE(ar.source_id, ar.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_artist_id,
           al.album_artist_id, al.album_artist_name,
           al.art_path, al.artwork_id, al.art_source, al.is_compilation,
           ar.name as artist_name
    FROM albums al
    LEFT JOIN artists ar ON al.album_artist_id = ar.id
    LEFT JOIN tracks t ON t.album_id = al.id
    WHERE ${visibleAlbumSql('al')}
    GROUP BY al.id
    ORDER BY ${orderBy}
  `
  if (options?.limit) {
    query += ` LIMIT ?`; params.push(options.limit)
    if (options.offset) { query += ` OFFSET ?`; params.push(options.offset) }
  }
  return db.prepare(query).all(...params)
}

export function getLibraryArtists(options?: { sort?: string }) {
  const db = getDb()
  const orderBy = options?.sort === 'album_count'
    ? 'album_count DESC, ar.name'
    : 'ar.normalized_name'
  return db.prepare(`
    SELECT ar.id, ar.name, ar.normalized_name, ar.art_path, ar.artwork_id, ar.art_source, ar.bio, ar.bio_source,
           (
             SELECT cas.catalog_artist_id
             FROM catalog_artist_sources cas
             WHERE cas.local_artist_id = ar.id
                OR (cas.provider = ar.source AND cas.source_id = COALESCE(ar.source_id, ar.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_artist_id,
           ar.bio_url, ar.bio_fetched_at, ar.genres,
           COUNT(DISTINCT al.id) as album_count,
           COUNT(DISTINCT t.id) as track_count
    FROM artists ar
    LEFT JOIN albums al ON al.album_artist_id = ar.id
    LEFT JOIN tracks t ON t.artist_id = ar.id
    WHERE ${visibleArtistSql('ar')}
    GROUP BY ar.id
    HAVING album_count > 0 OR track_count > 0
    ORDER BY ${orderBy}
  `).all()
}

export async function getLibraryGenres(providerId: string) {
  await ensureCatalogReady()
  return getCatalogSearchService().browseGenres(providerId, 'library')
}

export async function getLibraryArtistsByGenre(providerId: string, genre: string) {
  await ensureCatalogReady()
  return getCatalogSearchService().browseArtistsByGenre(providerId, genre, 'library')
}

export async function getLibraryArtistProfile(artistId: string) {
  return getArtistRowById(getDb(), artistId)
}

export function getLibraryAlbumTracks(albumId: string) {
  return getDb().prepare(`
    SELECT t.id, t.file_path, t.playback_file_path, t.start_offset_ms, t.end_offset_ms, t.cue_sheet_path,
           t.source, t.source_id, t.title, t.track_number, t.disc_number,
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
             WHERE cas.local_artist_id = ar.id
                OR (cas.provider = ar.source AND cas.source_id = COALESCE(ar.source_id, ar.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_artist_id,
           t.duration_ms as duration, t.format, t.sample_rate, t.bit_depth,
           t.bitrate, t.channels, t.lossless, t.stream_info_fetched_at, t.year, t.file_size,
           t.album_id, t.artist_id,
           ar.name as artist_name,
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
           al.art_path as album_art_path,
           al.artwork_id as album_artwork_id, t.artwork_id as track_artwork_id, t.art_path as track_art_path,
           (
             SELECT ca.artwork_url
             FROM catalog_album_sources cas
             JOIN catalog_albums ca ON ca.id = cas.catalog_album_id
             WHERE cas.local_album_id = al.id
                OR (cas.provider = al.source AND cas.source_id = COALESCE(al.source_id, al.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as album_artwork_url
    FROM tracks t
    LEFT JOIN artists ar ON t.artist_id = ar.id
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.album_id = ?
    ORDER BY t.disc_number, t.track_number, t.title
  `).all(albumId)
}

export function getLibraryArtistTracks(artistId: string) {
  return getDb().prepare(`
    SELECT t.id, t.file_path, t.playback_file_path, t.start_offset_ms, t.end_offset_ms, t.cue_sheet_path,
           t.source, t.source_id, t.title, t.track_number, t.disc_number,
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
             WHERE cas.local_artist_id = ar.id
                OR (cas.provider = ar.source AND cas.source_id = COALESCE(ar.source_id, ar.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_artist_id,
           t.duration_ms as duration, t.format, t.sample_rate, t.bit_depth,
           t.bitrate, t.channels, t.lossless, t.stream_info_fetched_at, t.year,
           t.album_id, t.artist_id,
           ar.name as artist_name,
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
           al.art_path as album_art_path,
           al.artwork_id as album_artwork_id, t.artwork_id as track_artwork_id, t.art_path as track_art_path,
           (
             SELECT ca.artwork_url
             FROM catalog_album_sources cas
             JOIN catalog_albums ca ON ca.id = cas.catalog_album_id
             WHERE cas.local_album_id = al.id
                OR (cas.provider = al.source AND cas.source_id = COALESCE(al.source_id, al.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as album_artwork_url,
           al.year as album_year
    FROM tracks t
    LEFT JOIN artists ar ON t.artist_id = ar.id
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.artist_id = ? OR EXISTS (
      SELECT 1 FROM track_artists ta WHERE ta.track_id = t.id AND ta.artist_id = ?
    )
    ORDER BY al.year DESC, al.title, t.disc_number, t.track_number
  `).all(artistId, artistId)
}

export async function searchLibrary(query: string) {
  if (!query.trim()) return { tracks: [], albums: [], artists: [] }
  const db = getDb()
  const ftsQuery = query.trim().replace(/['"]/g, '') + '*'
  const trackIds = (db.prepare(
    `SELECT track_id FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT 50`
  ).all(ftsQuery) as Array<{ track_id: string }>).map(r => r.track_id)

  const tracks = trackIds.length > 0
    ? db.prepare(`
        SELECT t.id, t.file_path, t.playback_file_path, t.start_offset_ms, t.end_offset_ms, t.cue_sheet_path,
               t.source, t.source_id, t.title, t.track_number, t.duration_ms as duration,
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
                 WHERE cas.local_artist_id = ar.id
                    OR (cas.provider = ar.source AND cas.source_id = COALESCE(ar.source_id, ar.id))
                 ORDER BY cas.in_library DESC, cas.match_confidence DESC
                 LIMIT 1
               ) as catalog_artist_id,
               t.format, t.sample_rate, t.bit_depth, t.lossless, t.stream_info_fetched_at,
               ar.name as artist_name,
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
        FROM tracks t
        LEFT JOIN artists ar ON t.artist_id = ar.id
        LEFT JOIN albums al ON t.album_id = al.id
        WHERE t.id IN (${trackIds.map(() => '?').join(',')})
          AND ${visibleTrackSql('t')}
      `).all(...trackIds)
    : []

  const term = `%${query}%`
  const albums = db.prepare(`
    SELECT id, source, source_id, title, year, album_artist_name, art_path, artwork_id, total_tracks,
           (
             SELECT cas.catalog_album_id
             FROM catalog_album_sources cas
             WHERE cas.local_album_id = albums.id
                OR (cas.provider = albums.source AND cas.source_id = COALESCE(albums.source_id, albums.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_album_id
    FROM albums WHERE (title LIKE ? OR album_artist_name LIKE ?)
      AND ${visibleAlbumSql('albums')}
    LIMIT 10
  `).all(term, term)
  const artists = db.prepare(`
    SELECT id, name, art_path, artwork_id, art_source,
           (
             SELECT cas.catalog_artist_id
             FROM catalog_artist_sources cas
             WHERE cas.local_artist_id = artists.id
                OR (cas.provider = artists.source AND cas.source_id = COALESCE(artists.source_id, artists.id))
             ORDER BY cas.in_library DESC, cas.match_confidence DESC
             LIMIT 1
           ) as catalog_artist_id
    FROM artists WHERE name LIKE ?
      AND ${visibleArtistSql('artists')}
    LIMIT 10
  `).all(term)

  const remoteTracks = await searchRemoteLibraryTracks(query)
  return { tracks: [...tracks, ...remoteTracks], albums, artists }
}

export function removeLibraryTrack(trackId: string, onCatalogChanged: () => void): void {
  const db = getDb()
  const track = db.prepare(`SELECT file_path FROM tracks WHERE id = ?`).get(trackId) as {
    file_path: string
  } | undefined
  if (track) deleteLocalTracksByFilePaths(db, [track.file_path])
  void rebuildCatalogGraphFromSources().then(() => {
    onCatalogChanged()
  }).catch((error) => {
    console.warn('[Puros] Failed to rebuild catalog after track removal:', error)
  })
}

export function clearLibrary(onCatalogChanged: () => void): void {
  const db = getDb()
  db.transaction(() => {
    // Contentless FTS5 tables cannot be cleared with DELETE FROM — use the
    // special management insert to rebuild the index as empty.
    db.exec(`INSERT INTO search_index(search_index) VALUES('delete-all')`)

    // Remove graph rows that reference library entities before deleting the library itself.
    db.exec(`
      DELETE FROM catalog_album_preferences;
      DELETE FROM catalog_artist_preferences;
      DELETE FROM catalog_related_artists;
      DELETE FROM catalog_artist_track_edges;
      DELETE FROM catalog_album_track_edges;
      DELETE FROM catalog_artist_album_edges;
      DELETE FROM catalog_track_sources;
      DELETE FROM catalog_album_sources;
      DELETE FROM catalog_artist_sources;
      DELETE FROM catalog_tracks;
      DELETE FROM catalog_albums;
      DELETE FROM catalog_artists;
    `)

    // Playlists can stay, but their track links must go before tracks are deleted.
    db.exec(`
      DELETE FROM playlist_tracks;
      DELETE FROM track_artists;
      DELETE FROM tracks;
      DELETE FROM albums;
      DELETE FROM artists;
      DELETE FROM watch_folders;
    `)
  })()
  void rebuildCatalogGraphFromSources().then(() => {
    onCatalogChanged()
  }).catch((error) => {
    console.warn('[Puros] Failed to rebuild catalog after clearing library:', error)
  })
}
