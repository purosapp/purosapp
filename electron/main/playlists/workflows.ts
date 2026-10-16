import type Database from 'better-sqlite3'
import { type CatalogProviderName } from '../../../src/services/catalog'
import {
  artworkFileUrl,
  cacheLocalArtworkFile,
  extractArtwork,
} from '../artwork/cache'
import { rebuildUnifiedSearchIndex } from '../catalog/services'
import { getDb } from '../db'
import { listProviderDescriptors, isProviderAvailable } from '../providers'
import { getSettingValue } from '../settings/store'
import {
  ensurePlaylistTrackIdForCatalogTrack,
  getPlaylistResolvedItems,
  getPlaylistSourceRow,
  isLocalPlaylistSource,
  normalizePlaylistTrackPositions,
  repairPlaylistStacks,
  repairPlaylistProviderTrackMetadata,
  resolvePlaylistPlaybackQueue,
  toPlaybackTrackRow,
} from './store'

type PlaylistFolderInfoRow = {
  id: number
  name: string
  created_at: number
  source: string
  source_id: string | null
  parent_id: number | null
  read_only: number
  position: number
}

function getPlaylistFolderRow(db: Database.Database, folderId: number): PlaylistFolderInfoRow | undefined {
  return db.prepare(`
    SELECT id, name, created_at, source, source_id, parent_id, read_only, position
    FROM playlist_folders
    WHERE id = ?
  `).get(folderId) as PlaylistFolderInfoRow | undefined
}

function getNextPlaylistFolderPosition(db: Database.Database, parentId: number | null): number {
  const row = parentId == null
    ? db.prepare(`
        SELECT COALESCE(MAX(position), -1) as maxPos
        FROM playlist_folders
        WHERE parent_id IS NULL AND source = 'local'
      `).get() as { maxPos: number }
    : db.prepare(`
        SELECT COALESCE(MAX(position), -1) as maxPos
        FROM playlist_folders
        WHERE parent_id = ? AND source = 'local'
      `).get(parentId) as { maxPos: number }
  return row.maxPos + 1
}

function getNextPlaylistPositionInFolder(db: Database.Database, folderId: number | null): number {
  const row = folderId == null
    ? db.prepare(`
        SELECT COALESCE(MAX(folder_position), -1) as maxPos
        FROM playlists
        WHERE folder_id IS NULL AND source = 'local'
      `).get() as { maxPos: number }
    : db.prepare(`
        SELECT COALESCE(MAX(folder_position), -1) as maxPos
        FROM playlists
        WHERE folder_id = ? AND source = 'local'
      `).get(folderId) as { maxPos: number }
  return row.maxPos + 1
}

function normalizePlaylistFolderParent(
  db: Database.Database,
  parentId: number | null | undefined,
): number | null {
  if (parentId == null) return null
  const parent = getPlaylistFolderRow(db, parentId)
  if (!parent || parent.read_only || !isLocalPlaylistSource(parent.source)) return null
  return parent.id
}

export function getAllPlaylists() {
  const db = getDb()
  const showUnavailable = getSettingValue(db, 'showUnavailableSources') === 'true'
  const providers = listProviderDescriptors()
    .map(({ manifest }) => manifest.id)
    .filter(isProviderAvailable)
  const visibilitySql = showUnavailable
    ? '1 = 1'
    : `p.source IN ('local', 'm3u')${providers.length > 0 ? ` OR p.source IN (${providers.map(() => '?').join(', ')})` : ''}`
  return db.prepare(`
    SELECT p.id, p.name, p.created_at, p.playback_provider_id as source, p.source_id, p.read_only, p.artwork_id,
           p.playback_provider_id, p.management, p.legacy_mixed,
           p.folder_id, p.folder_position,
           COUNT(pt.id) as track_count
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
    WHERE ${visibilitySql}
    GROUP BY p.id
  `).all(...providers)
}

export function getPlaylistFolders() {
  const db = getDb()
  const showUnavailable = getSettingValue(db, 'showUnavailableSources') === 'true'
  const providers = listProviderDescriptors()
    .map(({ manifest }) => manifest.id)
    .filter(isProviderAvailable)
  const visibilitySql = showUnavailable
    ? '1 = 1'
    : `source IN ('local', 'm3u')${providers.length > 0 ? ` OR source IN (${providers.map(() => '?').join(', ')})` : ''}`
  return db.prepare(`
    SELECT id, name, created_at, source, source_id, parent_id, read_only, position
    FROM playlist_folders
    WHERE ${visibilitySql}
    ORDER BY COALESCE(parent_id, 0), position, name
  `).all(...providers)
}

export function createPlaylist(
  name: string,
  folderId: number | null | undefined,
  onChanged: () => void,
  providerId = 'local',
) {
  const db = getDb()
  if (providerId !== 'local' && !listProviderDescriptors().some(p => p.manifest.id === providerId)) throw new Error('Provider is not installed')
  const normalizedFolderId = normalizePlaylistFolderParent(db, folderId)
  const folderPosition = getNextPlaylistPositionInFolder(db, normalizedFolderId)
  const row = db.prepare(
    `INSERT INTO playlists (name, source, read_only, folder_id, folder_position, playback_provider_id, management)
     VALUES (?, 'local', 0, ?, ?, ?, 'app')
     RETURNING id, name, created_at, playback_provider_id as source, source_id, read_only, artwork_id, folder_id, folder_position, playback_provider_id, management, legacy_mixed`
  ).get(name, normalizedFolderId, folderPosition, providerId) as {
    id: number
    name: string
    created_at: number
    source: string
    source_id: string | null
    read_only: number
    artwork_id: string | null
    folder_id: number | null
    folder_position: number | null
  }
  onChanged()
  return { ...row, track_count: 0 }
}

export function createPlaylistFolder(
  name: string,
  parentId: number | null | undefined,
  onChanged: () => void,
) {
  const db = getDb()
  const normalizedParentId = normalizePlaylistFolderParent(db, parentId)
  const position = getNextPlaylistFolderPosition(db, normalizedParentId)
  const row = db.prepare(`
    INSERT INTO playlist_folders (name, source, read_only, parent_id, position)
    VALUES (?, 'local', 0, ?, ?)
    RETURNING id, name, created_at, source, source_id, parent_id, read_only, position
  `).get(name, normalizedParentId, position) as PlaylistFolderInfoRow
  onChanged()
  return row
}

export function renamePlaylistFolder(id: number, newName: string, onChanged: () => void): void {
  getDb().prepare(`
    UPDATE playlist_folders
    SET name = ?
    WHERE id = ? AND read_only = 0 AND source = 'local'
  `).run(newName, id)
  onChanged()
}

export function deletePlaylistFolder(id: number, onChanged: () => void): void {
  getDb().prepare(`
    DELETE FROM playlist_folders
    WHERE id = ? AND read_only = 0 AND source = 'local'
  `).run(id)
  onChanged()
}

export function movePlaylistToFolder(
  playlistId: number,
  folderId: number | null | undefined,
  onChanged: () => void,
): void {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || playlist.read_only || !isLocalPlaylistSource(playlist.source)) return

  const normalizedFolderId = normalizePlaylistFolderParent(db, folderId)
  const folderPosition = getNextPlaylistPositionInFolder(db, normalizedFolderId)
  db.prepare(`
    UPDATE playlists
    SET folder_id = ?, folder_position = ?
    WHERE id = ? AND source = 'local' AND read_only = 0
  `).run(normalizedFolderId, folderPosition, playlistId)
  onChanged()
}

export function renamePlaylist(id: number, newName: string, onChanged: () => void): void {
  getDb().prepare(`UPDATE playlists SET name = ? WHERE id = ? AND read_only = 0`).run(newName, id)
  onChanged()
}

export function deletePlaylist(id: number, onChanged: () => void): void {
  getDb().prepare(`DELETE FROM playlists WHERE id = ? AND read_only = 0`).run(id)
  onChanged()
}

export function duplicatePlaylist(id: number, onChanged: () => void) {
  const db = getDb()
  const src = db.prepare(`SELECT name, source, artwork_id, playback_provider_id, legacy_mixed FROM playlists WHERE id = ?`).get(id) as {
    name: string
    source: string
    artwork_id: string | null
    playback_provider_id: string
    legacy_mixed: number
  } | undefined
  if (!src || src.legacy_mixed) return null
  const newRow = db.prepare(
    `INSERT INTO playlists (name, source, read_only, artwork_id, folder_id, folder_position, playback_provider_id, management)
     VALUES (?, 'local', 0, ?, NULL, ?, ?, 'app')
     RETURNING id, name, created_at, playback_provider_id as source, source_id, read_only, artwork_id, folder_id, folder_position, playback_provider_id, management, legacy_mixed`
  ).get(`${src.name} — kopia`, src.artwork_id, getNextPlaylistPositionInFolder(db, null), src.playback_provider_id) as {
    id: number
    name: string
    created_at: number
    source: string
    source_id: string | null
    read_only: number
    artwork_id: string | null
    folder_id: number | null
    folder_position: number | null
  }
  const copyTracks = db.transaction(() => {
    if (isLocalPlaylistSource(src.source)) {
      repairPlaylistStacks(db, id)
    }

    const srcTracks = db.prepare(
      `SELECT id, track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position`
    ).all(id) as Array<{ id: number; track_id: string; position: number }>
    const insertTrack = db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position)
      VALUES (?, ?, ?)
      RETURNING id
    `)
    const sourceToDuplicateId = new Map<number, number>()
    for (const track of srcTracks) {
      const inserted = insertTrack.get(newRow.id, track.track_id, track.position) as { id: number }
      sourceToDuplicateId.set(track.id, inserted.id)
    }

    if (isLocalPlaylistSource(src.source)) {
      const sourceStacks = db.prepare(`
        SELECT ps.id as stack_id,
               psi.playlist_track_id,
               psi.position
        FROM playlist_stacks ps
        JOIN playlist_stack_items psi ON psi.stack_id = ps.id
        WHERE ps.playlist_id = ?
        ORDER BY ps.id, psi.position
      `).all(id) as Array<{
        stack_id: number
        playlist_track_id: number
        position: number
      }>

      const stackRowsBySourceId = new Map<number, typeof sourceStacks>()
      for (const row of sourceStacks) {
        const bucket = stackRowsBySourceId.get(row.stack_id)
        if (bucket) bucket.push(row)
        else stackRowsBySourceId.set(row.stack_id, [row])
      }

      const insertStack = db.prepare(`
        INSERT INTO playlist_stacks (playlist_id)
        VALUES (?)
        RETURNING id
      `)
      const insertStackItem = db.prepare(`
        INSERT INTO playlist_stack_items (stack_id, playlist_track_id, position)
        VALUES (?, ?, ?)
      `)

      for (const rows of stackRowsBySourceId.values()) {
        const duplicatedTrackIds = rows
          .map((row) => sourceToDuplicateId.get(row.playlist_track_id) ?? null)
          .filter((value): value is number => value != null)
        if (duplicatedTrackIds.length < 2) continue

        const duplicatedStack = insertStack.get(newRow.id) as { id: number }
        duplicatedTrackIds.forEach((playlistTrackId, index) => {
          insertStackItem.run(duplicatedStack.id, playlistTrackId, index)
        })
      }
    }

    return srcTracks.length
  })
  const trackCount = copyTracks()
  onChanged()
  return { ...newRow, track_count: trackCount }
}

export async function choosePlaylistArtwork(
  playlistId: number,
  chooseFile: () => Promise<string | null>,
  onChanged: () => void,
) {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || playlist.read_only || !isLocalPlaylistSource(playlist.source)) {
    return { changed: false, artworkId: null as string | null }
  }

  const filePath = await chooseFile()
  if (!filePath) {
    return { changed: false, artworkId: null as string | null }
  }

  const artworkId = cacheLocalArtworkFile(filePath)
  if (!artworkId) {
    return { changed: false, artworkId: null as string | null }
  }

  db.prepare(`
    UPDATE playlists
    SET artwork_id = ?
    WHERE id = ?
      AND source = 'local'
      AND read_only = 0
  `).run(artworkId, playlistId)

  onChanged()
  return { changed: true, artworkId }
}

export function clearPlaylistArtwork(playlistId: number, onChanged: () => void) {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || playlist.read_only || !isLocalPlaylistSource(playlist.source)) {
    return { changed: false }
  }

  const result = db.prepare(`
    UPDATE playlists
    SET artwork_id = NULL
    WHERE id = ?
      AND source = 'local'
      AND read_only = 0
      AND artwork_id IS NOT NULL
  `).run(playlistId)

  if (result.changes > 0) {
    onChanged()
    return { changed: true }
  }

  return { changed: false }
}

export function addPlaylistTrack(
  playlistId: number,
  trackId: string | number,
  onChanged: () => void,
) {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || playlist.read_only || playlist.management !== 'app' || playlist.legacy_mixed) return { alreadyPresent: true }
  const track = db.prepare('SELECT source FROM tracks WHERE id = ?').get(trackId) as { source: string } | undefined
  if (!track || track.source !== playlist.playback_provider_id) throw new Error('The track and playlist must use the same provider')
  const existing = db.prepare(
    `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`
  ).get(playlistId, trackId)
  if (existing) return { alreadyPresent: true }
  const row = db.prepare(
    `SELECT COALESCE(MAX(position), -1) as maxPos FROM playlist_tracks WHERE playlist_id = ?`
  ).get(playlistId) as { maxPos: number }
  db.prepare(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`
  ).run(playlistId, trackId, row.maxPos + 1)
  onChanged()
  return { alreadyPresent: false }
}

export async function addCatalogTrackToPlaylist(
  playlistId: number,
  catalogTrackId: string,
  preferredProvider: CatalogProviderName | null | undefined,
  preferredSourceId: string | null | undefined,
  onLibraryChanged: () => void,
  onPlaylistsChanged: () => void,
) {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || playlist.read_only || playlist.management !== 'app' || playlist.legacy_mixed) {
    return { alreadyPresent: true, added: false }
  }

  const trackId = await ensurePlaylistTrackIdForCatalogTrack(
    db,
    catalogTrackId,
    preferredProvider ?? playlist.playback_provider_id,
    preferredSourceId ?? null,
  )
  if (!trackId) return { alreadyPresent: true, added: false }
  const source = db.prepare('SELECT source FROM tracks WHERE id = ?').get(trackId) as { source: string } | undefined
  if (!source || source.source !== playlist.playback_provider_id) throw new Error('The track and playlist must use the same provider')

  const existing = db.prepare(
    `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`
  ).get(playlistId, trackId)
  if (existing) return { alreadyPresent: true, added: false }

  const row = db.prepare(
    `SELECT COALESCE(MAX(position), -1) as maxPos FROM playlist_tracks WHERE playlist_id = ?`
  ).get(playlistId) as { maxPos: number }
  db.prepare(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`
  ).run(playlistId, trackId, row.maxPos + 1)
  rebuildUnifiedSearchIndex()
  onLibraryChanged()
  onPlaylistsChanged()
  return { alreadyPresent: false, added: true }
}

export function removePlaylistTrack(
  playlistId: number,
  trackIdOrPlaylistItemId: string | number,
  onChanged: () => void,
): void {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (playlist?.read_only) return
  db.transaction(() => {
    let removed = false
    if (typeof trackIdOrPlaylistItemId === 'number') {
      const result = db.prepare(`
        DELETE FROM playlist_tracks
        WHERE playlist_id = ? AND id = ?
      `).run(playlistId, trackIdOrPlaylistItemId)
      removed = result.changes > 0
    }

    if (!removed) {
      db.prepare(`
        DELETE FROM playlist_tracks
        WHERE playlist_id = ? AND track_id = ?
      `).run(playlistId, trackIdOrPlaylistItemId)
    }

    normalizePlaylistTrackPositions(db, playlistId)
    if (playlist && isLocalPlaylistSource(playlist.source)) {
      repairPlaylistStacks(db, playlistId)
    }
  })()
  onChanged()
}

export function reorderPlaylistTracks(
  playlistId: number,
  fromIndex: number,
  toIndex: number,
  onChanged: () => void,
): void {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (playlist?.read_only) return
  const rows = db.prepare(
    `SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position`
  ).all(playlistId) as Array<{ id: number }>
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 ||
      fromIndex >= rows.length || toIndex >= rows.length) return
  const [moved] = rows.splice(fromIndex, 1)
  rows.splice(toIndex, 0, moved)
  const upd = db.prepare(`UPDATE playlist_tracks SET position = ? WHERE id = ?`)
  rows.forEach((r, i) => upd.run(i, r.id))
  if (playlist && isLocalPlaylistSource(playlist.source)) {
    repairPlaylistStacks(db, playlistId)
  }
  onChanged()
}

export async function getPlaylistTracks(playlistId: number) {
  await repairPlaylistProviderTrackMetadata(getDb(), playlistId)
  return getPlaylistResolvedItems(getDb(), playlistId).map((item) => toPlaybackTrackRow(item.row))
}

export function createPlaylistSmartStack(
  playlistId: number,
  playlistItemIds: number[],
  onChanged: () => void,
): void {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || playlist.read_only || !isLocalPlaylistSource(playlist.source)) return

  const uniqueItemIds = [...new Set(playlistItemIds.filter((value) => Number.isInteger(value)))]
  if (uniqueItemIds.length < 2) return

  db.transaction(() => {
    repairPlaylistStacks(db, playlistId)

    const stackCandidates = db.prepare(`
      SELECT id, position
      FROM playlist_tracks
      WHERE playlist_id = ?
        AND id IN (${uniqueItemIds.map(() => '?').join(', ')})
      ORDER BY position
    `).all(playlistId, ...uniqueItemIds) as Array<{ id: number; position: number }>

    if (stackCandidates.length !== uniqueItemIds.length) return
    const firstPosition = stackCandidates[0]?.position ?? 0
    const areContiguous = stackCandidates.every((row, index) => row.position === firstPosition + index)
    if (!areContiguous) return

    db.prepare(`
      DELETE FROM playlist_stack_items
      WHERE playlist_track_id IN (${uniqueItemIds.map(() => '?').join(', ')})
    `).run(...uniqueItemIds)

    const createdStack = db.prepare(`
      INSERT INTO playlist_stacks (playlist_id)
      VALUES (?)
      RETURNING id
    `).get(playlistId) as { id: number }

    const insertStackItem = db.prepare(`
      INSERT INTO playlist_stack_items (stack_id, playlist_track_id, position)
      VALUES (?, ?, ?)
    `)
    stackCandidates.forEach((row, index) => {
      insertStackItem.run(createdStack.id, row.id, index)
    })

    repairPlaylistStacks(db, playlistId)
  })()

  onChanged()
}

export function removeFromPlaylistSmartStack(
  playlistId: number,
  playlistItemId: number,
  onChanged: () => void,
): void {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || playlist.read_only || !isLocalPlaylistSource(playlist.source)) return

  db.transaction(() => {
    db.prepare(`
      DELETE FROM playlist_stack_items
      WHERE playlist_track_id = ?
        AND stack_id IN (SELECT id FROM playlist_stacks WHERE playlist_id = ?)
    `).run(playlistItemId, playlistId)
    repairPlaylistStacks(db, playlistId)
  })()

  onChanged()
}

export function dissolvePlaylistSmartStack(
  playlistId: number,
  stackId: number,
  onChanged: () => void,
): void {
  const db = getDb()
  const playlist = getPlaylistSourceRow(db, playlistId)
  if (!playlist || playlist.read_only || !isLocalPlaylistSource(playlist.source)) return

  db.prepare(`
    DELETE FROM playlist_stacks
    WHERE id = ? AND playlist_id = ?
  `).run(stackId, playlistId)

  onChanged()
}

export function resolvePlaylistPlayback(playlistId: number, options?: {
  shuffle?: boolean
  startPlaylistItemId?: number
  startTrackId?: string
  playlistItemIds?: number[]
}) {
  return resolvePlaylistPlaybackQueue(getDb(), playlistId, options)
}

export async function getPlaylistArtwork(playlistId: number) {
  const row = getDb().prepare(`
    SELECT p.artwork_id as playlist_artwork_id, COALESCE(t.playback_file_path, t.file_path) as file_path, t.source, al.artwork_id, al.art_path
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
    LEFT JOIN tracks t ON pt.track_id = t.id
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE p.id = ?
    ORDER BY pt.position
    LIMIT 1
  `).get(playlistId) as {
    playlist_artwork_id: string | null
    file_path: string | null
    source: string | null
    artwork_id: string | null
    art_path: string | null
  } | undefined
  if (!row) return null
  if (row.playlist_artwork_id) return `artwork://cache/${encodeURIComponent(row.playlist_artwork_id)}`
  if (row.artwork_id) return `artwork://cache/${encodeURIComponent(row.artwork_id)}`
  if (row.art_path) return /^(https?:|artwork:|data:)/i.test(row.art_path) ? row.art_path : artworkFileUrl(row.art_path)
  if ((row.source !== 'local' && row.source !== 'm3u') || !row.file_path) return null
  return extractArtwork(row.file_path)
}
