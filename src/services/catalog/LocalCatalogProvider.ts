import type Database from 'better-sqlite3'
import type { CatalogProvider } from './CatalogProvider'
import type {
  CatalogProviderAlbum,
  CatalogProviderAlbumBundle,
  CatalogProviderArtist,
  CatalogProviderArtistBundle,
  CatalogProviderTrack,
  CatalogResolvedPlaybackTrack,
} from './types'

function emptyArtistBundle(artist: CatalogProviderArtist): CatalogProviderArtistBundle {
  return {
    artist,
    releases: [],
    playlists: [],
    topTracks: [],
    relatedArtists: [],
  }
}

export class LocalCatalogProvider implements CatalogProvider {
  readonly name = 'local' as const
  readonly capabilities = {
    search: false,
    artistProfile: true,
    artistDiscography: true,
    albumDetails: true,
    trackPlayback: true,
    relatedArtists: false,
    similarAlbums: false,
    addToLibrary: false,
  }

  constructor(private readonly db: Database.Database) {}

  async isAuthenticated() {
    return true
  }

  async search() {
    return { artists: [], albums: [], tracks: [], playlists: [] }
  }

  async getArtist(providerArtistId: string): Promise<CatalogProviderArtist> {
    const row = this.db.prepare(`
      SELECT ca.id, ca.name, ca.normalized_name, ca.artwork_url, ca.artwork_id
      FROM catalog_artists ca
      JOIN catalog_artist_sources cas ON cas.catalog_artist_id = ca.id
      WHERE cas.provider = 'local' AND cas.source_id = ?
      LIMIT 1
    `).get(providerArtistId) as {
      id: string
      name: string
      normalized_name: string | null
      artwork_url: string | null
      artwork_id: string | null
    } | undefined
    if (!row) throw new Error('Local artist not found')
    return {
      provider: 'local',
      sourceId: providerArtistId,
      name: row.name,
      normalizedName: row.normalized_name,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      inLibrary: true,
    }
  }

  async getArtistDiscography(providerArtistId: string) {
    const rows = this.db.prepare(`
      SELECT ca.id, ca.title, ca.normalized_title, ca.year, ca.release_type, ca.release_section,
             ca.artwork_url, ca.artwork_id, ca.primary_artist_name, ca.total_tracks, ca.total_discs
      FROM catalog_albums ca
      JOIN catalog_album_sources cas ON cas.catalog_album_id = ca.id
      WHERE cas.provider = 'local'
        AND cas.local_album_id IN (
          SELECT id FROM albums WHERE album_artist_id = ?
        )
      ORDER BY ca.year DESC, ca.title
    `).all(providerArtistId, providerArtistId) as Array<{
      id: string
      title: string
      normalized_title: string | null
      year: number | null
      release_type: CatalogProviderAlbum['releaseType']
      release_section: CatalogProviderAlbum['releaseSection']
      artwork_url: string | null
      artwork_id: string | null
      primary_artist_name: string | null
      total_tracks: number | null
      total_discs: number | null
    }>

    return rows.map((row) => ({
      provider: 'local' as const,
      sourceId: row.id,
      title: row.title,
      normalizedTitle: row.normalized_title,
      year: row.year,
      releaseType: row.release_type,
      releaseSection: row.release_section,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      primaryArtistName: row.primary_artist_name,
      totalTracks: row.total_tracks,
      totalDiscs: row.total_discs,
      inLibrary: true,
    }))
  }

  async getArtistTopTracks(providerArtistId: string): Promise<CatalogProviderTrack[]> {
    const rows = this.db.prepare(`
      SELECT ct.id, ct.title, ct.normalized_title, ct.duration_ms, ct.track_number, ct.disc_number,
             ct.album_title, ct.primary_artist_name, ct.artwork_url, ct.artwork_id
      FROM catalog_tracks ct
      JOIN catalog_track_sources cts ON cts.catalog_track_id = ct.id
      WHERE cts.provider = 'local'
        AND cts.local_track_id IN (
          SELECT t.id
          FROM tracks t
          WHERE t.artist_id = ?
             OR EXISTS (
               SELECT 1
               FROM track_artists ta
               WHERE ta.track_id = t.id
                 AND ta.artist_id = ?
             )
        )
      ORDER BY ct.album_title, ct.disc_number, ct.track_number, ct.title
      LIMIT 25
    `).all(providerArtistId) as Array<{
      id: string
      title: string
      normalized_title: string | null
      duration_ms: number
      track_number: number | null
      disc_number: number | null
      album_title: string | null
      primary_artist_name: string | null
      artwork_url: string | null
      artwork_id: string | null
    }>


    return rows.map((row) => ({
      provider: 'local' as const,
      sourceId: row.id,
      title: row.title,
      normalizedTitle: row.normalized_title,
      durationMs: row.duration_ms,
      trackNumber: row.track_number,
      discNumber: row.disc_number,
      albumTitle: row.album_title,
      primaryArtistName: row.primary_artist_name,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      inLibrary: true,
    }))
  }

  async getArtistRelated() {
    return []
  }

  async getArtistBundle(providerArtistId: string): Promise<CatalogProviderArtistBundle> {
    const artist = await this.getArtist(providerArtistId)
    return {
      ...emptyArtistBundle(artist),
      releases: await this.getArtistDiscography(providerArtistId),
      topTracks: await this.getArtistTopTracks(providerArtistId),
    }
  }

  async getAlbum(providerAlbumId: string): Promise<CatalogProviderAlbum> {
    const row = this.db.prepare(`
      SELECT ca.id, ca.title, ca.normalized_title, ca.year, ca.release_type, ca.release_section,
             ca.artwork_url, ca.artwork_id, ca.primary_artist_name, ca.total_tracks, ca.total_discs
      FROM catalog_albums ca
      JOIN catalog_album_sources cas ON cas.catalog_album_id = ca.id
      WHERE cas.provider = 'local' AND cas.source_id = ?
      LIMIT 1
    `).get(providerAlbumId) as {
      id: string
      title: string
      normalized_title: string | null
      year: number | null
      release_type: CatalogProviderAlbum['releaseType']
      release_section: CatalogProviderAlbum['releaseSection']
      artwork_url: string | null
      artwork_id: string | null
      primary_artist_name: string | null
      total_tracks: number | null
      total_discs: number | null
    } | undefined
    if (!row) throw new Error('Local album not found')
    return {
      provider: 'local',
      sourceId: providerAlbumId,
      title: row.title,
      normalizedTitle: row.normalized_title,
      year: row.year,
      releaseType: row.release_type,
      releaseSection: row.release_section,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      primaryArtistName: row.primary_artist_name,
      totalTracks: row.total_tracks,
      totalDiscs: row.total_discs,
      inLibrary: true,
    }
  }

  async getAlbumTracks(providerAlbumId: string): Promise<CatalogProviderTrack[]> {
    const rows = this.db.prepare(`
      SELECT ct.id, ct.title, ct.normalized_title, ct.duration_ms, ct.track_number, ct.disc_number,
             ct.album_title, ct.primary_artist_name, ct.artwork_url, ct.artwork_id
      FROM catalog_tracks ct
      JOIN catalog_track_sources cts ON cts.catalog_track_id = ct.id
      WHERE cts.provider = 'local'
        AND cts.local_track_id IN (
          SELECT id FROM tracks WHERE album_id = ?
        )
      ORDER BY ct.disc_number, ct.track_number, ct.title
    `).all(providerAlbumId) as Array<{
      id: string
      title: string
      normalized_title: string | null
      duration_ms: number
      track_number: number | null
      disc_number: number | null
      album_title: string | null
      primary_artist_name: string | null
      artwork_url: string | null
      artwork_id: string | null
    }>
    return rows.map((row) => ({
      provider: 'local' as const,
      sourceId: row.id,
      title: row.title,
      normalizedTitle: row.normalized_title,
      durationMs: row.duration_ms,
      trackNumber: row.track_number,
      discNumber: row.disc_number,
      albumTitle: row.album_title,
      primaryArtistName: row.primary_artist_name,
      artworkUrl: row.artwork_url,
      artworkId: row.artwork_id,
      inLibrary: true,
    }))
  }

  async getAlbumBundle(providerAlbumId: string): Promise<CatalogProviderAlbumBundle> {
    return {
      album: await this.getAlbum(providerAlbumId),
      tracks: await this.getAlbumTracks(providerAlbumId),
    }
  }

  async resolvePlayback(catalogTrackId: string, providerTrackId: string): Promise<CatalogResolvedPlaybackTrack> {
    const row = this.db.prepare(`
      SELECT ct.title, ct.duration_ms, ct.album_title, ct.primary_artist_name,
             (
               SELECT group_concat(piece, '')
               FROM (
                 SELECT ca.name || COALESCE(edge.join_phrase, '') as piece,
                        MIN(edge.position) as sort_position
                 FROM catalog_artist_track_edges edge
                 JOIN catalog_artists ca ON ca.id = edge.catalog_artist_id
                 WHERE edge.catalog_track_id = ct.id
                 GROUP BY ca.id, piece
                 ORDER BY sort_position, ca.name
               )
             ) as artist_credit_name,
             ct.album_id, ct.primary_artist_id,
             t.id as local_track_id, t.file_path, t.playback_file_path, t.start_offset_ms, t.end_offset_ms, t.cue_sheet_path
      FROM catalog_tracks ct
      JOIN catalog_track_sources cts ON cts.catalog_track_id = ct.id
      LEFT JOIN tracks t ON t.id = cts.local_track_id
      WHERE ct.id = ? AND cts.provider = 'local' AND cts.source_id = ?
      LIMIT 1
    `).get(catalogTrackId, providerTrackId) as {
      title: string | null
      duration_ms: number | null
      album_title: string | null
      primary_artist_name: string | null
      artist_credit_name: string | null
      album_id: string | null
      primary_artist_id: string | null
      local_track_id: string | null
      file_path: string | null
      playback_file_path: string | null
      start_offset_ms: number | null
      end_offset_ms: number | null
      cue_sheet_path: string | null
    } | undefined
    if (!row?.file_path || !row.local_track_id) throw new Error('Local playback target not found')
    return {
      catalogTrackId,
      catalogAlbumId: row.album_id,
      catalogArtistId: row.primary_artist_id,
      sourceType: 'local',
      sourceId: row.local_track_id,
      displayMetadataSource: 'local',
      id: row.local_track_id,
      title: row.title ?? 'Unknown Track',
      artist: row.artist_credit_name ?? row.primary_artist_name ?? 'Unknown Artist',
      album: row.album_title ?? 'Unknown Album',
      duration: Math.round((row.duration_ms ?? 0) / 1000),
      filePath: row.file_path,
      playbackFilePath: row.playback_file_path ?? row.file_path,
      provider: 'local',
      startOffsetMs: row.start_offset_ms ?? 0,
      endOffsetMs: row.end_offset_ms ?? null,
      cueSheetPath: row.cue_sheet_path ?? null,
    }
  }
}
