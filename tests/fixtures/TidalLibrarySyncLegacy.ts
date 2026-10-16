import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { TidalApiService, imageIdToUrl } from '../../providers/tidal/src/TidalApiService'
import { inferArtistCredits } from '../../src/services/catalog/creditHeuristics'
import type {
  TidalArtist,
  TidalArtworkCache,
  TidalDbContext,
  TidalLibraryPayload,
  TidalSyncProgress,
  TidalSyncResult,
  TidalTrack,
} from '../../providers/tidal/src/types'

export class TidalLibrarySync {
  private readonly api: TidalApiService
  private readonly db: Database.Database
  private readonly artworkCache: TidalArtworkCache
  private readonly rebuildSearchIndex: () => void

  constructor(options: {
    api: TidalApiService
    dbContext: TidalDbContext
    artworkCache: TidalArtworkCache
  }) {
    this.api = options.api
    this.db = options.dbContext.db
    this.artworkCache = options.artworkCache
    this.rebuildSearchIndex = options.dbContext.rebuildSearchIndex
  }

  async syncUserLibrary(onProgress?: (progress: TidalSyncProgress) => void): Promise<TidalSyncResult> {
    const payload = await this.fetchLibraryPayload(onProgress)
    await this.persist(payload, onProgress)

    const result = {
      albums: payload.albums.length,
      tracks: payload.tracks.length,
      playlists: payload.playlists.length,
      syncedAt: Math.floor(Date.now() / 1_000),
    }

    this.db.prepare(`
      INSERT INTO provider_kv (provider, key, value, updated_at)
      VALUES (?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(provider, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('tidal', 'lastSyncAt', JSON.stringify(result.syncedAt))

    this.rebuildSearchIndex()
    return result
  }

  private async fetchLibraryPayload(onProgress?: (progress: TidalSyncProgress) => void): Promise<TidalLibraryPayload> {
    onProgress?.({ stage: 'fetching', processed: 0, total: 0, label: 'Fetching TIDAL library' })
    const payload = await this.api.fetchLibraryPayload()
    const playlistFolderCount = payload.playlistFolders?.length ?? 0
    const folderedPlaylistCount = payload.playlists.filter((playlist) => playlist.folderSourceId).length
    console.info(`[Puros][TIDAL] Playlist folders fetched: ${playlistFolderCount}; foldered playlists: ${folderedPlaylistCount}`)
    onProgress?.({ stage: 'persisting', processed: 0, total: payload.albums.length + payload.tracks.length + payload.playlists.length + (payload.playlistFolders?.length ?? 0), label: 'Saving TIDAL library' })
    return {
      albums: payload.albums,
      tracks: dedupeTracks(payload.tracks),
      playlists: payload.playlists,
      playlistFolders: payload.playlistFolders ?? [],
    }
  }

  private async persist(payload: TidalLibraryPayload, onProgress?: (progress: TidalSyncProgress) => void) {
    const artistIds = new Set<string>()
    const albumIds = new Set<string>()
    const trackIds = new Set<string>()
    const playlistSourceIds = new Set<string>()
    const playlistFolderSourceIds = new Set<string>()

    const upsertArtist = this.db.prepare(`
      INSERT INTO artists (id, name, normalized_name, genres, source, source_id)
      VALUES (?, ?, ?, ?, 'tidal', ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        normalized_name = excluded.normalized_name,
        genres = CASE
          WHEN excluded.genres IS NOT NULL AND excluded.genres != '[]' THEN excluded.genres
          ELSE artists.genres
        END,
        source = 'tidal',
        source_id = excluded.source_id
    `)

    const upsertAlbum = this.db.prepare(`
      INSERT INTO albums (
        id, title, normalized_title, upc, year, total_tracks, total_discs,
        album_artist_id, album_artist_name, art_path, artwork_id, art_source,
        genres, source, source_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tidal', ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        normalized_title = excluded.normalized_title,
        upc = COALESCE(excluded.upc, albums.upc),
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
        genres = CASE
          WHEN excluded.genres IS NOT NULL AND excluded.genres != '[]' THEN excluded.genres
          ELSE albums.genres
        END,
        source = 'tidal',
        source_id = excluded.source_id
    `)

    const upsertTrack = this.db.prepare(`
      INSERT INTO tracks (
        id, file_path, duration_ms, format, sample_rate, bit_depth, channels,
        bitrate, lossless, title, genres, isrc, upc, track_number, disc_number, album_id, artist_id,
        indexed_at, source, source_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), 'tidal', ?)
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
        genres = CASE
          WHEN excluded.genres IS NOT NULL AND excluded.genres != '[]' THEN excluded.genres
          ELSE tracks.genres
        END,
        isrc = COALESCE(excluded.isrc, tracks.isrc),
        upc = COALESCE(excluded.upc, tracks.upc),
        track_number = excluded.track_number,
        disc_number = excluded.disc_number,
        album_id = excluded.album_id,
        artist_id = excluded.artist_id,
        source = 'tidal',
        source_id = excluded.source_id
    `)

    const clearTrackArtists = this.db.prepare(`DELETE FROM track_artists WHERE track_id = ?`)
    const upsertTrackArtist = this.db.prepare(`
      INSERT OR REPLACE INTO track_artists (track_id, artist_id, role, position)
      VALUES (?, ?, ?, ?)
    `)

    const insertPlaylist = this.db.prepare(`
      INSERT INTO playlists (name, created_at, source, source_id, read_only, artwork_id, folder_id, folder_position, playback_provider_id, management)
      VALUES (?, strftime('%s','now'), 'tidal', ?, 1, ?, ?, ?, 'tidal', 'provider')
      ON CONFLICT DO NOTHING
    `)

    const updatePlaylist = this.db.prepare(`
      UPDATE playlists
      SET name = ?, read_only = 1, artwork_id = COALESCE(?, artwork_id),
          folder_id = ?, folder_position = ?
      WHERE source = 'tidal' AND source_id = ?
    `)

    const getExistingPlaylistId = this.db.prepare(`
      SELECT id FROM playlists WHERE source = 'tidal' AND source_id = ?
    `)

    const getPlaylistTracks = this.db.prepare(`
      SELECT id, track_id FROM playlist_tracks
      WHERE playlist_id = ?
      ORDER BY position, id
    `)

    const deletePlaylistTrack = this.db.prepare(`DELETE FROM playlist_tracks WHERE id = ?`)

    const updatePlaylistTrackPosition = this.db.prepare(`
      UPDATE playlist_tracks SET position = ? WHERE id = ?
    `)

    const insertPlaylistTrack = this.db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position)
      VALUES (?, ?, ?)
    `)

    // Reconcile in place instead of delete + reinsert: playlist item ids are
    // held by open playlist views and used to pick the start row on click, so
    // a background sync must not invalidate ids of tracks that are still there.
    const reconcilePlaylistTracks = (playlistId: number, nextTrackIds: string[]) => {
      const existingIdsByTrack = new Map<string, number[]>()
      for (const item of getPlaylistTracks.all(playlistId) as Array<{ id: number; track_id: string }>) {
        const ids = existingIdsByTrack.get(item.track_id)
        if (ids) ids.push(item.id)
        else existingIdsByTrack.set(item.track_id, [item.id])
      }
      nextTrackIds.forEach((trackId, position) => {
        const reusedId = existingIdsByTrack.get(trackId)?.shift()
        if (reusedId != null) updatePlaylistTrackPosition.run(position, reusedId)
        else insertPlaylistTrack.run(playlistId, trackId, position)
      })
      for (const staleIds of existingIdsByTrack.values()) {
        for (const staleId of staleIds) deletePlaylistTrack.run(staleId)
      }
    }

    const insertPlaylistFolder = this.db.prepare(`
      INSERT INTO playlist_folders (name, created_at, source, source_id, parent_id, read_only, position)
      VALUES (?, strftime('%s','now'), 'tidal', ?, ?, 1, ?)
      ON CONFLICT DO NOTHING
    `)

    const updatePlaylistFolder = this.db.prepare(`
      UPDATE playlist_folders
      SET name = ?, parent_id = ?, read_only = 1, position = ?
      WHERE source = 'tidal' AND source_id = ?
    `)

    const getExistingPlaylistFolderId = this.db.prepare(`
      SELECT id FROM playlist_folders WHERE source = 'tidal' AND source_id = ?
    `)

    const persistTotal = payload.albums.length + payload.tracks.length + payload.playlists.length + (payload.playlistFolders?.length ?? 0)
    let persisted = 0
    const reportPersistProgress = (label: string) => {
      persisted += 1
      onProgress?.({ stage: 'persisting', processed: persisted, total: persistTotal, label })
    }

    for (const album of payload.albums) {
      const mappedArtist = this.upsertArtists(
        album.artists ?? (album.artist ? [album.artist] : []),
        upsertArtist,
        artistIds,
      )
      const primaryArtist = mappedArtist[0] ?? null
      const albumId = tidalAlbumRowId(album.id)
      albumIds.add(albumId)

      const artworkId = await this.artworkCache.cacheRemoteArtwork(imageIdToUrl(album.cover))
      const artworkUrl = imageIdToUrl(album.cover)
      const year = album.releaseDate ? Number(album.releaseDate.slice(0, 4)) || null : null
      const genres = normalizeGenres(album.genres)

      upsertAlbum.run(
        albumId,
        album.title,
        normalize(album.title),
        null,
        year,
        album.numberOfTracks ?? null,
        album.numberOfVolumes ?? 1,
        primaryArtist?.id ?? null,
        primaryArtist?.name ?? null,
        artworkUrl,
        artworkId,
        artworkId ? 'tidal' : 'none',
        JSON.stringify(genres),
        String(album.id),
      )
      reportPersistProgress(`Saving albums: ${album.title}`)
    }

    for (const track of payload.tracks) {
      const artists = this.upsertArtists(
        track.artists ?? (track.artist ? [track.artist] : []),
        upsertArtist,
        artistIds,
      )
      const primaryArtist = artists[0] ?? null
      const album = track.album
      const albumId = album ? tidalAlbumRowId(album.id) : null
      const trackId = tidalTrackRowId(track.id)
      trackIds.add(trackId)
      if (albumId) albumIds.add(albumId)

      if (album) {
        const artworkId = await this.artworkCache.cacheRemoteArtwork(imageIdToUrl(album.cover))
        const artworkUrl = imageIdToUrl(album.cover)
        const albumArtists = this.upsertArtists(
          album.artists ?? (album.artist ? [album.artist] : []),
          upsertArtist,
          artistIds,
        )
        const albumPrimaryArtist = albumArtists[0] ?? primaryArtist
        const albumGenres = normalizeGenres(album.genres)
        upsertAlbum.run(
          albumId,
          album.title,
          normalize(album.title),
          null,
          album.releaseDate ? Number(album.releaseDate.slice(0, 4)) || null : null,
          album.numberOfTracks ?? null,
          album.numberOfVolumes ?? 1,
          albumPrimaryArtist?.id ?? null,
          albumPrimaryArtist?.name ?? null,
          artworkUrl,
          artworkId,
          artworkId ? 'tidal' : 'none',
          JSON.stringify(albumGenres),
          String(album.id),
        )
      }

      const trackGenres = normalizeGenres(track.genres ?? album?.genres)
      upsertTrack.run(
        trackId,
        `tidal://track/${track.id}`,
        Math.round(track.duration * 1000),
        null,
        null,
        null,
        null,
        null,
        0,
        track.title,
        JSON.stringify(trackGenres),
        null,
        null,
        track.trackNumber ?? null,
        track.volumeNumber ?? 1,
        albumId,
        primaryArtist?.id ?? null,
        String(track.id),
      )

      clearTrackArtists.run(trackId)
      const inferredCredits = inferArtistCredits({
        entityType: 'track',
        title: track.title,
        primaryArtistSourceId: track.artist?.id != null ? String(track.artist.id) : null,
        primaryArtistName: primaryArtist?.name ?? null,
        artists: artists.map((artist) => ({
          sourceId: artist.id.replace(/^tidal:artist:/, ''),
          name: artist.name,
        })),
      })
      artists.forEach((artist, index) => {
        upsertTrackArtist.run(trackId, artist.id, inferredCredits[index]?.role ?? (index === 0 ? 'primary' : 'main'), index)
      })
      reportPersistProgress(`Saving tracks: ${track.title}`)
    }

    const folderIdBySourceId = new Map<string, number>()
    for (const folder of payload.playlistFolders ?? []) {
      const sourceId = String(folder.sourceId ?? '').trim()
      if (!sourceId) {
        reportPersistProgress('Saving folders')
        continue
      }
      playlistFolderSourceIds.add(sourceId)
      const parentSourceId = folder.parentSourceId ? String(folder.parentSourceId).trim() : ''
      const parentId = parentSourceId ? (folderIdBySourceId.get(parentSourceId) ?? null) : null
      const position = Number.isFinite(folder.position) ? folder.position : 0
      const name = folder.name?.trim() || 'TIDAL Folder'
      insertPlaylistFolder.run(name, sourceId, parentId, position)
      updatePlaylistFolder.run(name, parentId, position, sourceId)
      const row = getExistingPlaylistFolderId.get(sourceId) as { id: number } | undefined
      if (row) folderIdBySourceId.set(sourceId, row.id)
      reportPersistProgress(`Saving folders: ${name}`)
    }

    for (const playlist of payload.playlists) {
      const sourceId = String(playlist.uuid ?? playlist.id ?? '')
      const playlistName = playlist.title ?? playlist.name ?? 'TIDAL Playlist'
      if (!sourceId) {
        reportPersistProgress(`Saving playlists: ${playlistName}`)
        continue
      }

      playlistSourceIds.add(sourceId)
      const folderSourceId = playlist.folderSourceId ? String(playlist.folderSourceId).trim() : ''
      const folderId = folderSourceId ? (folderIdBySourceId.get(folderSourceId) ?? null) : null
      const folderPosition = Number.isFinite(playlist.folderPosition) ? playlist.folderPosition : null
      const playlistArtworkId = await this.artworkCache.cacheRemoteArtwork(
        imageIdToUrl(playlist.squareImage ?? playlist.image, 320),
      )
      insertPlaylist.run(
        playlistName,
        sourceId,
        playlistArtworkId,
        folderId,
        folderPosition,
      )
      updatePlaylist.run(
        playlistName,
        playlistArtworkId,
        folderId,
        folderPosition,
        sourceId,
      )
      const row = getExistingPlaylistId.get(sourceId) as { id: number } | undefined

      if (row) {
        reconcilePlaylistTracks(
          row.id,
          playlist.items
            .map((track: TidalTrack) => tidalTrackRowId(track.id))
            .filter((trackId: string) => trackIds.has(trackId)),
        )
      }
      reportPersistProgress(`Saving playlists: ${playlistName}`)
    }

    if (persistTotal === 0) {
      onProgress?.({ stage: 'persisting', processed: 0, total: 0, label: 'Saving TIDAL library' })
    }
    this.cleanupStaleTidalRows({ artistIds, albumIds, trackIds, playlistSourceIds, playlistFolderSourceIds })
  }

  private upsertArtists(
    artists: TidalArtist[],
    upsertArtist: Database.Statement,
    artistIds: Set<string>,
  ): Array<{ id: string; name: string }> {
    const mapped: Array<{ id: string; name: string }> = []
    for (const artist of artists) {
      if (!artist?.name) continue
      const id = tidalArtistRowId(artist.id)
      artistIds.add(id)
      upsertArtist.run(id, artist.name, normalize(artist.name), JSON.stringify(normalizeGenres(artist.genres)), String(artist.id))
      mapped.push({ id, name: artist.name })
    }
    return mapped
  }

  private cleanupStaleTidalRows(ids: {
    artistIds: Set<string>
    albumIds: Set<string>
    trackIds: Set<string>
    playlistSourceIds: Set<string>
    playlistFolderSourceIds: Set<string>
  }) {
    const deleteCatalogTrackSource = this.db.prepare(`DELETE FROM catalog_track_sources WHERE local_track_id = ?`)
    const deleteMissingTracks = this.db.prepare(`DELETE FROM tracks WHERE source = 'tidal' AND id = ?`)
    const deleteCatalogAlbumSource = this.db.prepare(`DELETE FROM catalog_album_sources WHERE local_album_id = ?`)
    const deleteMissingAlbums = this.db.prepare(`DELETE FROM albums WHERE source = 'tidal' AND id = ?`)
    const deleteCatalogArtistSource = this.db.prepare(`DELETE FROM catalog_artist_sources WHERE local_artist_id = ?`)
    const deleteMissingArtists = this.db.prepare(`DELETE FROM artists WHERE source = 'tidal' AND id = ?`)
    const deleteMissingPlaylist = this.db.prepare(`DELETE FROM playlists WHERE source = 'tidal' AND source_id = ?`)
    const deleteMissingPlaylistFolder = this.db.prepare(`DELETE FROM playlist_folders WHERE source = 'tidal' AND source_id = ?`)
    const pinnedLocalPlaylistTracks = this.db.prepare(`
      SELECT DISTINCT t.id, t.album_id, t.artist_id
      FROM tracks t
      JOIN playlist_tracks pt ON pt.track_id = t.id
      JOIN playlists p ON p.id = pt.playlist_id
      WHERE t.source = 'tidal'
        AND p.source = 'local'
    `).all() as Array<{
      id: string
      album_id: string | null
      artist_id: string | null
    }>

    const pinnedTrackIds = new Set<string>()
    const pinnedAlbumIds = new Set<string>()
    const pinnedArtistIds = new Set<string>()

    for (const row of pinnedLocalPlaylistTracks) {
      pinnedTrackIds.add(row.id)
      if (row.album_id) pinnedAlbumIds.add(row.album_id)
      if (row.artist_id) pinnedArtistIds.add(row.artist_id)
    }

    if (pinnedTrackIds.size > 0) {
      const pinnedTrackIdList = [...pinnedTrackIds]
      const pinnedTrackArtists = this.db.prepare(`
        SELECT DISTINCT artist_id
        FROM track_artists
        WHERE track_id IN (${pinnedTrackIdList.map(() => '?').join(', ')})
          AND artist_id IS NOT NULL
      `).all(...pinnedTrackIdList) as Array<{ artist_id: string | null }>
      for (const row of pinnedTrackArtists) {
        if (row.artist_id) pinnedArtistIds.add(row.artist_id)
      }

      if (pinnedAlbumIds.size > 0) {
        const pinnedAlbumIdList = [...pinnedAlbumIds]
        const pinnedAlbumArtists = this.db.prepare(`
          SELECT DISTINCT album_artist_id
          FROM albums
          WHERE id IN (${pinnedAlbumIdList.map(() => '?').join(', ')})
            AND album_artist_id IS NOT NULL
        `).all(...pinnedAlbumIdList) as Array<{ album_artist_id: string | null }>
        for (const row of pinnedAlbumArtists) {
          if (row.album_artist_id) pinnedArtistIds.add(row.album_artist_id)
        }
      }
    }

    this.db.transaction(() => {
      const existingTracks = this.db.prepare(`SELECT id FROM tracks WHERE source = 'tidal'`).all() as Array<{ id: string }>
      existingTracks.forEach(({ id }) => {
        if (!ids.trackIds.has(id) && !pinnedTrackIds.has(id)) {
          deleteCatalogTrackSource.run(id)
          deleteMissingTracks.run(id)
        }
      })

      const existingAlbums = this.db.prepare(`SELECT id FROM albums WHERE source = 'tidal'`).all() as Array<{ id: string }>
      existingAlbums.forEach(({ id }) => {
        if (!ids.albumIds.has(id) && !pinnedAlbumIds.has(id)) {
          deleteCatalogAlbumSource.run(id)
          deleteMissingAlbums.run(id)
        }
      })

      const existingArtists = this.db.prepare(`SELECT id FROM artists WHERE source = 'tidal'`).all() as Array<{ id: string }>
      existingArtists.forEach(({ id }) => {
        if (!ids.artistIds.has(id) && !pinnedArtistIds.has(id)) {
          deleteCatalogArtistSource.run(id)
          deleteMissingArtists.run(id)
        }
      })

      const existingPlaylists = this.db.prepare(`SELECT source_id FROM playlists WHERE source = 'tidal'`).all() as Array<{ source_id: string }>
      existingPlaylists.forEach(({ source_id }) => {
        if (!ids.playlistSourceIds.has(source_id)) deleteMissingPlaylist.run(source_id)
      })

      if (ids.playlistFolderSourceIds.size > 0) {
        const existingPlaylistFolders = this.db.prepare(`SELECT source_id FROM playlist_folders WHERE source = 'tidal'`).all() as Array<{ source_id: string }>
        existingPlaylistFolders.forEach(({ source_id }) => {
          if (!ids.playlistFolderSourceIds.has(source_id)) deleteMissingPlaylistFolder.run(source_id)
        })
      }
    })()
  }
}

function dedupeTracks(tracks: TidalTrack[]): TidalTrack[] {
  const map = new Map<string, TidalTrack>()
  tracks.forEach((track) => {
    map.set(String(track.id), track)
  })
  return [...map.values()]
}

function normalize(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim()
}

function normalizeGenres(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const genres: string[] = []
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const genre = raw.trim()
    const key = normalize(genre)
    if (!genre || seen.has(key)) continue
    seen.add(key)
    genres.push(genre)
  }
  return genres
}

function tidalArtistRowId(id: string | number) {
  return `tidal:artist:${id}`
}

function tidalAlbumRowId(id: string | number) {
  return `tidal:album:${id}`
}

function tidalTrackRowId(id: string | number) {
  return createHash('sha256').update(`tidal://track/${id}`).digest('hex')
}
