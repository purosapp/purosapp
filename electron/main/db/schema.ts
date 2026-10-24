import type Database from 'better-sqlite3'
import { migrateProviderSeparation, ensureProviderBoundaries } from './providerSeparation'

function ensureSourceIndexes(db: Database.Database) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_source_source_id
      ON tracks(source, source_id)
      WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_source_source_id
      ON albums(source, source_id)
      WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_source_source_id
      ON artists(source, source_id)
      WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_source_source_id
      ON playlists(source, source_id)
      WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_folders_source_source_id
      ON playlist_folders(source, source_id)
      WHERE source_id IS NOT NULL;
  `)
}

export function initSchema(
  db: Database.Database,
  backfillArtworkCache: (db: Database.Database) => void,
) {
  // v1 used INTEGER PKs; v2 uses TEXT SHA-256 IDs — migrate destructively
  const schemaVersion = db.pragma('user_version', { simple: true }) as number
  if (schemaVersion < 2) {
    db.exec(`
      DROP TABLE IF EXISTS tracks_fts;
      DROP TABLE IF EXISTS search_index;
      DROP TABLE IF EXISTS track_artists;
      DROP TABLE IF EXISTS playlist_tracks;
      DROP TABLE IF EXISTS tracks;
      DROP TABLE IF EXISTS albums;
      DROP TABLE IF EXISTS artists;
      DROP TABLE IF EXISTS watch_folders;
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT,
      bio TEXT,
      bio_source TEXT,
      bio_url TEXT,
      bio_fetched_at INTEGER,
      genres TEXT,
      art_path TEXT,
      artwork_id TEXT REFERENCES artwork_cache(id),
      art_source TEXT DEFAULT 'none',
      source TEXT NOT NULL DEFAULT 'local',
      source_id TEXT
    );

    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      normalized_title TEXT,
      upc TEXT,
      year INTEGER,
      total_tracks INTEGER,
      total_discs INTEGER,
      album_artist_id TEXT REFERENCES artists(id),
      album_artist_name TEXT,
      art_path TEXT,
      artwork_id TEXT REFERENCES artwork_cache(id),
      art_source TEXT DEFAULT 'none',
      genres TEXT,
      is_compilation INTEGER DEFAULT 0,
      label TEXT,
      catalog_number TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      source_id TEXT
    );

    CREATE TABLE IF NOT EXISTS artwork_cache (
      id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS discord_artwork_uploads (
      provider TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      external_url TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_used_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (provider, content_hash)
    );

    CREATE TABLE IF NOT EXISTS streaming_audio_cache (
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      quality_key TEXT NOT NULL,
      resolved_source_id TEXT,
      resolved_quality TEXT,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      format TEXT,
      sample_rate INTEGER,
      bit_depth INTEGER,
      bitrate INTEGER,
      channels INTEGER,
      lossless INTEGER DEFAULT 0,
      is_dsd INTEGER DEFAULT 0,
      dsd_rate INTEGER,
      source_format TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_accessed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_played_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (provider, source_id, quality_key)
    );

    -- Playlists the user downloaded for offline playback. Their provider tracks
    -- are pinned in the streaming audio cache so trimming never evicts them.
    CREATE TABLE IF NOT EXISTS offline_playlists (
      playlist_id INTEGER PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS offline_tracks (
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      downloaded_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (provider, source_id)
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      playback_file_path TEXT,
      file_size INTEGER,
      file_modified_at INTEGER,
      duration_ms INTEGER,
      format TEXT,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channels INTEGER,
      bitrate INTEGER,
      lossless INTEGER DEFAULT 0,
      title TEXT,
      genres TEXT,
      isrc TEXT,
      upc TEXT,
      track_number INTEGER,
      disc_number INTEGER,
      year INTEGER,
      album_id TEXT REFERENCES albums(id),
      artist_id TEXT REFERENCES artists(id),
      has_embedded_art INTEGER DEFAULT 0,
      art_hash TEXT,
      start_offset_ms INTEGER NOT NULL DEFAULT 0,
      end_offset_ms INTEGER,
      cue_sheet_path TEXT,
      indexed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      stream_info_fetched_at INTEGER,
      source TEXT NOT NULL DEFAULT 'local',
      source_id TEXT
    );

    CREATE TABLE IF NOT EXISTS track_artists (
      track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
      artist_id TEXT REFERENCES artists(id),
      role TEXT DEFAULT 'main',
      position INTEGER,
      PRIMARY KEY (track_id, artist_id, role)
    );

    CREATE TABLE IF NOT EXISTS watch_folders (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      recursive INTEGER DEFAULT 1,
      added_at INTEGER NOT NULL,
      last_scanned_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      source TEXT NOT NULL DEFAULT 'local',
      source_id TEXT,
      read_only INTEGER NOT NULL DEFAULT 0,
      artwork_id TEXT REFERENCES artwork_cache(id),
      folder_id INTEGER REFERENCES playlist_folders(id) ON DELETE SET NULL,
      folder_position INTEGER
    );

    CREATE TABLE IF NOT EXISTS playlist_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      source TEXT NOT NULL DEFAULT 'local',
      source_id TEXT,
      parent_id INTEGER REFERENCES playlist_folders(id) ON DELETE SET NULL,
      read_only INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
      track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlist_stacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS playlist_stack_items (
      stack_id INTEGER NOT NULL REFERENCES playlist_stacks(id) ON DELETE CASCADE,
      playlist_track_id INTEGER NOT NULL UNIQUE REFERENCES playlist_tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (stack_id, playlist_track_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_kv (
      provider TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (provider, key)
    );

    CREATE TABLE IF NOT EXISTS provider_secrets (
      provider TEXT NOT NULL,
      key TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      encryption_version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (provider, key)
    );

    CREATE TABLE IF NOT EXISTS live_radio_stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      streams_json TEXT NOT NULL,
      default_stream_index INTEGER NOT NULL DEFAULT 0,
      genre_json TEXT,
      country TEXT,
      country_code TEXT,
      language TEXT,
      logo_url TEXT,
      homepage TEXT,
      codec TEXT,
      bitrate INTEGER,
      click_count INTEGER DEFAULT 0,
      votes INTEGER DEFAULT 0,
      last_check_ok INTEGER DEFAULT 1,
      is_custom INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS live_radio_metadata_cache (
      station_id TEXT PRIMARY KEY,
      stream_url TEXT NOT NULL,
      raw_title TEXT,
      title TEXT,
      artist TEXT,
      fetched_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);
    CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id);
    CREATE INDEX IF NOT EXISTS idx_albums_artist_id ON albums(album_artist_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      track_id UNINDEXED,
      title,
      album_title,
      artist_name,
      album_artist_name,
      content='',
      tokenize='unicode61 remove_diacritics 1'
    );

    CREATE TABLE IF NOT EXISTS catalog_artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT,
      genres_json TEXT,
      mb_artist_id TEXT,
      canonical_match_status TEXT NOT NULL DEFAULT 'none',
      canonical_match_confidence REAL NOT NULL DEFAULT 0,
      canonical_match_source TEXT,
      canonical_fetched_at INTEGER,
      canonical_locked INTEGER NOT NULL DEFAULT 0,
      artwork_url TEXT,
      artwork_id TEXT REFERENCES artwork_cache(id),
      fetched_at INTEGER,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS catalog_artist_bios (
      catalog_artist_id TEXT NOT NULL REFERENCES catalog_artists(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      bio TEXT,
      bio_url TEXT,
      genres_json TEXT,
      fetched_at INTEGER,
      expires_at INTEGER,
      PRIMARY KEY (catalog_artist_id, provider)
    );

    CREATE TABLE IF NOT EXISTS catalog_albums (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      normalized_title TEXT,
      upc TEXT,
      year INTEGER,
      mb_release_group_id TEXT,
      mb_release_id TEXT,
      canonical_match_status TEXT NOT NULL DEFAULT 'none',
      canonical_match_confidence REAL NOT NULL DEFAULT 0,
      canonical_match_source TEXT,
      canonical_fetched_at INTEGER,
      canonical_locked INTEGER NOT NULL DEFAULT 0,
      release_type TEXT,
      release_section TEXT,
      genres_json TEXT,
      total_tracks INTEGER,
      total_discs INTEGER,
      primary_artist_id TEXT REFERENCES catalog_artists(id),
      primary_artist_name TEXT,
      primary_artist_normalized_name TEXT,
      artwork_url TEXT,
      artwork_id TEXT REFERENCES artwork_cache(id),
      fetched_at INTEGER,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS catalog_tracks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      normalized_title TEXT,
      duration_ms INTEGER,
      isrc TEXT,
      upc TEXT,
      mb_recording_id TEXT,
      mb_release_id TEXT,
      canonical_match_status TEXT NOT NULL DEFAULT 'none',
      canonical_match_confidence REAL NOT NULL DEFAULT 0,
      canonical_match_source TEXT,
      canonical_fetched_at INTEGER,
      canonical_locked INTEGER NOT NULL DEFAULT 0,
      track_number INTEGER,
      disc_number INTEGER,
      album_id TEXT REFERENCES catalog_albums(id),
      album_title TEXT,
      primary_artist_id TEXT REFERENCES catalog_artists(id),
      primary_artist_name TEXT,
      primary_artist_normalized_name TEXT,
      artwork_url TEXT,
      artwork_id TEXT REFERENCES artwork_cache(id),
      format TEXT,
      sample_rate INTEGER,
      bit_depth INTEGER,
      bitrate INTEGER,
      channels INTEGER,
      lossless INTEGER DEFAULT 0,
      genres_json TEXT,
      stream_info_fetched_at INTEGER,
      fetched_at INTEGER,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS catalog_artist_sources (
      catalog_artist_id TEXT NOT NULL REFERENCES catalog_artists(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      local_artist_id TEXT REFERENCES artists(id),
      in_library INTEGER NOT NULL DEFAULT 0,
      provider_priority INTEGER NOT NULL DEFAULT 0,
      match_confidence REAL NOT NULL DEFAULT 0,
      provider_url TEXT,
      last_seen_at INTEGER,
      available INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (catalog_artist_id, provider, source_id)
    );

    CREATE TABLE IF NOT EXISTS catalog_album_sources (
      catalog_album_id TEXT NOT NULL REFERENCES catalog_albums(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      local_album_id TEXT REFERENCES albums(id),
      in_library INTEGER NOT NULL DEFAULT 0,
      provider_priority INTEGER NOT NULL DEFAULT 0,
      match_confidence REAL NOT NULL DEFAULT 0,
      provider_url TEXT,
      last_seen_at INTEGER,
      available INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (catalog_album_id, provider, source_id)
    );

    CREATE TABLE IF NOT EXISTS catalog_track_sources (
      catalog_track_id TEXT NOT NULL REFERENCES catalog_tracks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      local_track_id TEXT REFERENCES tracks(id),
      in_library INTEGER NOT NULL DEFAULT 0,
      provider_priority INTEGER NOT NULL DEFAULT 0,
      match_confidence REAL NOT NULL DEFAULT 0,
      provider_url TEXT,
      last_seen_at INTEGER,
      available INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (catalog_track_id, provider, source_id)
    );

    CREATE TABLE IF NOT EXISTS catalog_artist_album_edges (
      catalog_artist_id TEXT NOT NULL REFERENCES catalog_artists(id) ON DELETE CASCADE,
      catalog_album_id TEXT NOT NULL REFERENCES catalog_albums(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      metadata_source TEXT NOT NULL DEFAULT 'local',
      credit_role TEXT NOT NULL DEFAULT 'primary',
      join_phrase TEXT,
      confidence REAL NOT NULL DEFAULT 1,
      fetched_at INTEGER,
      PRIMARY KEY (catalog_artist_id, catalog_album_id, provider)
    );

    CREATE TABLE IF NOT EXISTS catalog_album_track_edges (
      catalog_album_id TEXT NOT NULL REFERENCES catalog_albums(id) ON DELETE CASCADE,
      catalog_track_id TEXT NOT NULL REFERENCES catalog_tracks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      disc_number INTEGER NOT NULL DEFAULT 1,
      metadata_source TEXT NOT NULL DEFAULT 'local',
      confidence REAL NOT NULL DEFAULT 1,
      fetched_at INTEGER,
      PRIMARY KEY (catalog_album_id, catalog_track_id, provider)
    );

    CREATE TABLE IF NOT EXISTS catalog_artist_track_edges (
      catalog_artist_id TEXT NOT NULL REFERENCES catalog_artists(id) ON DELETE CASCADE,
      catalog_track_id TEXT NOT NULL REFERENCES catalog_tracks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      metadata_source TEXT NOT NULL DEFAULT 'local',
      credit_role TEXT NOT NULL DEFAULT 'main',
      join_phrase TEXT,
      confidence REAL NOT NULL DEFAULT 1,
      fetched_at INTEGER,
      PRIMARY KEY (catalog_artist_id, catalog_track_id, provider)
    );

    CREATE TABLE IF NOT EXISTS catalog_related_artists (
      catalog_artist_id TEXT NOT NULL REFERENCES catalog_artists(id) ON DELETE CASCADE,
      related_catalog_artist_id TEXT NOT NULL REFERENCES catalog_artists(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      metadata_source TEXT NOT NULL DEFAULT 'local',
      confidence REAL NOT NULL DEFAULT 1,
      fetched_at INTEGER,
      PRIMARY KEY (catalog_artist_id, related_catalog_artist_id, provider)
    );

    CREATE TABLE IF NOT EXISTS catalog_field_provenance (
      entity_type TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      canonical_id TEXT,
      value TEXT,
      confidence REAL,
      fetched_at INTEGER,
      expires_at INTEGER,
      PRIMARY KEY (entity_type, catalog_id, field_name)
    );

    CREATE TABLE IF NOT EXISTS catalog_album_preferences (
      catalog_album_id TEXT PRIMARY KEY REFERENCES catalog_albums(id) ON DELETE CASCADE,
      preferred_provider TEXT,
      preferred_source_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS catalog_artist_preferences (
      catalog_artist_id TEXT PRIMARY KEY REFERENCES catalog_artists(id) ON DELETE CASCADE,
      preferred_provider TEXT,
      preferred_source_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_artists_normalized_name ON catalog_artists(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_catalog_artist_bios_artist ON catalog_artist_bios(catalog_artist_id, provider);
    CREATE INDEX IF NOT EXISTS idx_catalog_albums_normalized_title ON catalog_albums(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_catalog_tracks_normalized_title ON catalog_tracks(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_catalog_artist_sources_provider_source ON catalog_artist_sources(provider, source_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_album_sources_provider_source ON catalog_album_sources(provider, source_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_track_sources_provider_source ON catalog_track_sources(provider, source_id);
    CREATE INDEX IF NOT EXISTS idx_provider_kv_provider ON provider_kv(provider);
    CREATE INDEX IF NOT EXISTS idx_provider_secrets_provider ON provider_secrets(provider);
    CREATE INDEX IF NOT EXISTS idx_catalog_track_sources_local_track ON catalog_track_sources(local_track_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_album_sources_local_album ON catalog_album_sources(local_album_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_artist_sources_local_artist ON catalog_artist_sources(local_artist_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_artist_album_edges_artist ON catalog_artist_album_edges(catalog_artist_id, position);
    CREATE INDEX IF NOT EXISTS idx_catalog_album_track_edges_album ON catalog_album_track_edges(catalog_album_id, disc_number, position);
    CREATE INDEX IF NOT EXISTS idx_catalog_artist_track_edges_artist ON catalog_artist_track_edges(catalog_artist_id, position);
    CREATE INDEX IF NOT EXISTS idx_catalog_artist_track_edges_track ON catalog_artist_track_edges(catalog_track_id, position);
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
    CREATE INDEX IF NOT EXISTS idx_playlist_stacks_playlist ON playlist_stacks(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_playlist_stack_items_stack_position ON playlist_stack_items(stack_id, position);
    CREATE INDEX IF NOT EXISTS idx_catalog_field_provenance_entity ON catalog_field_provenance(entity_type, catalog_id);
    CREATE INDEX IF NOT EXISTS idx_discord_artwork_uploads_last_used ON discord_artwork_uploads(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_streaming_audio_cache_lru ON streaming_audio_cache(provider, last_played_at, last_accessed_at);
    CREATE INDEX IF NOT EXISTS idx_streaming_audio_cache_file ON streaming_audio_cache(file_path);
    CREATE INDEX IF NOT EXISTS idx_streaming_audio_cache_resolved ON streaming_audio_cache(provider, resolved_source_id, quality_key);
    CREATE INDEX IF NOT EXISTS idx_offline_tracks_file ON offline_tracks(file_path);
    CREATE INDEX IF NOT EXISTS idx_live_radio_custom ON live_radio_stations(is_custom, updated_at);
    CREATE INDEX IF NOT EXISTS idx_live_radio_favorite ON live_radio_stations(is_favorite, updated_at);
  `)

  if (schemaVersion < 4) {
    const artistColumns = db.prepare(`PRAGMA table_info(artists)`).all() as Array<{ name: string }>
    if (!artistColumns.some((column) => column.name === 'bio_source')) {
      db.exec(`ALTER TABLE artists ADD COLUMN bio_source TEXT`)
    }
    if (!artistColumns.some((column) => column.name === 'bio_url')) {
      db.exec(`ALTER TABLE artists ADD COLUMN bio_url TEXT`)
    }
    if (!artistColumns.some((column) => column.name === 'bio_fetched_at')) {
      db.exec(`ALTER TABLE artists ADD COLUMN bio_fetched_at INTEGER`)
    }
  }

  if (schemaVersion < 4) {
    const albumColumns = db.prepare(`PRAGMA table_info(albums)`).all() as Array<{ name: string }>
    if (!albumColumns.some((column) => column.name === 'artwork_id')) {
      db.exec(`ALTER TABLE albums ADD COLUMN artwork_id TEXT REFERENCES artwork_cache(id)`)
    }
    db.pragma('user_version = 4')
  }

  if (schemaVersion < 5) {
    const artistColumns = db.prepare(`PRAGMA table_info(artists)`).all() as Array<{ name: string }>
    if (!artistColumns.some((column) => column.name === 'source')) {
      db.exec(`ALTER TABLE artists ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!artistColumns.some((column) => column.name === 'source_id')) {
      db.exec(`ALTER TABLE artists ADD COLUMN source_id TEXT`)
    }

    const albumColumns = db.prepare(`PRAGMA table_info(albums)`).all() as Array<{ name: string }>
    if (!albumColumns.some((column) => column.name === 'source')) {
      db.exec(`ALTER TABLE albums ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!albumColumns.some((column) => column.name === 'source_id')) {
      db.exec(`ALTER TABLE albums ADD COLUMN source_id TEXT`)
    }

    const trackColumns = db.prepare(`PRAGMA table_info(tracks)`).all() as Array<{ name: string }>
    if (!trackColumns.some((column) => column.name === 'source')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!trackColumns.some((column) => column.name === 'source_id')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN source_id TEXT`)
    }

    const playlistColumns = db.prepare(`PRAGMA table_info(playlists)`).all() as Array<{ name: string }>
    if (!playlistColumns.some((column) => column.name === 'source')) {
      db.exec(`ALTER TABLE playlists ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!playlistColumns.some((column) => column.name === 'source_id')) {
      db.exec(`ALTER TABLE playlists ADD COLUMN source_id TEXT`)
    }
    if (!playlistColumns.some((column) => column.name === 'read_only')) {
      db.exec(`ALTER TABLE playlists ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`)
    }
    if (!playlistColumns.some((column) => column.name === 'artwork_id')) {
      db.exec(`ALTER TABLE playlists ADD COLUMN artwork_id TEXT REFERENCES artwork_cache(id)`)
    }

    db.pragma('user_version = 5')
  }

  if (schemaVersion < 6) {
    const playlistColumns = db.prepare(`PRAGMA table_info(playlists)`).all() as Array<{ name: string }>
    if (!playlistColumns.some((column) => column.name === 'artwork_id')) {
      db.exec(`ALTER TABLE playlists ADD COLUMN artwork_id TEXT REFERENCES artwork_cache(id)`)
    }
    db.pragma('user_version = 6')
  }

  if (schemaVersion < 7) {
    const trackColumns = db.prepare(`PRAGMA table_info(tracks)`).all() as Array<{ name: string }>
    if (!trackColumns.some((column) => column.name === 'stream_info_fetched_at')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN stream_info_fetched_at INTEGER`)
    }
    db.pragma('user_version = 7')
  }

  if (schemaVersion < 8) {
    db.pragma('user_version = 8')
  }

  if (schemaVersion < 9) {
    db.pragma('user_version = 9')
  }

  if (schemaVersion < 10) {
    const catalogAlbumColumns = db.prepare(`PRAGMA table_info(catalog_albums)`).all() as Array<{ name: string }>
    if (!catalogAlbumColumns.some((column) => column.name === 'release_type')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN release_type TEXT`)
    }
    db.pragma('user_version = 10')
  }

  if (schemaVersion < 11) {
    const catalogTrackColumns = db.prepare(`PRAGMA table_info(catalog_tracks)`).all() as Array<{ name: string }>
    if (!catalogTrackColumns.some((column) => column.name === 'stream_info_fetched_at')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN stream_info_fetched_at INTEGER`)
    }
    db.pragma('user_version = 11')
  }

  if (schemaVersion < 12) {
    const catalogAlbumColumns = db.prepare(`PRAGMA table_info(catalog_albums)`).all() as Array<{ name: string }>
    if (!catalogAlbumColumns.some((column) => column.name === 'release_section')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN release_section TEXT`)
    }
    db.pragma('user_version = 12')
  }

  if (schemaVersion < 13) {
    const catalogArtistColumns = db.prepare(`PRAGMA table_info(catalog_artists)`).all() as Array<{ name: string }>
    const canMigrateLegacyArtistBios =
      catalogArtistColumns.some((column) => column.name === 'bio_source') &&
      catalogArtistColumns.some((column) => column.name === 'bio')

    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_artist_bios (
        catalog_artist_id TEXT NOT NULL REFERENCES catalog_artists(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        bio TEXT,
        bio_url TEXT,
        genres_json TEXT,
        fetched_at INTEGER,
        expires_at INTEGER,
        PRIMARY KEY (catalog_artist_id, provider)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_artist_bios_artist ON catalog_artist_bios(catalog_artist_id, provider);
    `)

    if (canMigrateLegacyArtistBios) {
      db.exec(`
        INSERT OR REPLACE INTO catalog_artist_bios (
          catalog_artist_id, provider, bio, bio_url, genres_json, fetched_at, expires_at
        )
        SELECT id, bio_source, bio, bio_url, genres_json, fetched_at, expires_at
        FROM catalog_artists
        WHERE bio IS NOT NULL AND bio_source IS NOT NULL
      `)
    }

    db.pragma('user_version = 13')
  }

  if (schemaVersion < 14) {
    const trackColumns = db.prepare(`PRAGMA table_info(tracks)`).all() as Array<{ name: string }>
    if (!trackColumns.some((column) => column.name === 'playback_file_path')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN playback_file_path TEXT`)
      db.exec(`UPDATE tracks SET playback_file_path = file_path WHERE playback_file_path IS NULL`)
    }
    if (!trackColumns.some((column) => column.name === 'start_offset_ms')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN start_offset_ms INTEGER NOT NULL DEFAULT 0`)
    }
    if (!trackColumns.some((column) => column.name === 'end_offset_ms')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN end_offset_ms INTEGER`)
    }
    if (!trackColumns.some((column) => column.name === 'cue_sheet_path')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN cue_sheet_path TEXT`)
    }
    db.pragma('user_version = 14')
  }

  if (schemaVersion < 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discord_artwork_uploads (
        provider TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        external_url TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        last_used_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (provider, content_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_discord_artwork_uploads_last_used ON discord_artwork_uploads(last_used_at);
    `)
    db.pragma('user_version = 15')
  }

  if (schemaVersion < 16) {
    const artistColumns = db.prepare(`PRAGMA table_info(artists)`).all() as Array<{ name: string }>
    if (!artistColumns.some((column) => column.name === 'artwork_id')) {
      db.exec(`ALTER TABLE artists ADD COLUMN artwork_id TEXT REFERENCES artwork_cache(id)`)
    }
    if (!artistColumns.some((column) => column.name === 'art_source')) {
      db.exec(`ALTER TABLE artists ADD COLUMN art_source TEXT DEFAULT 'none'`)
    }
    db.pragma('user_version = 16')
  }

  if (schemaVersion < 17) {
    const catalogArtistColumns = db.prepare(`PRAGMA table_info(catalog_artists)`).all() as Array<{ name: string }>
    if (!catalogArtistColumns.some((column) => column.name === 'mb_artist_id')) {
      db.exec(`ALTER TABLE catalog_artists ADD COLUMN mb_artist_id TEXT`)
    }
    if (!catalogArtistColumns.some((column) => column.name === 'canonical_match_status')) {
      db.exec(`ALTER TABLE catalog_artists ADD COLUMN canonical_match_status TEXT NOT NULL DEFAULT 'none'`)
    }
    if (!catalogArtistColumns.some((column) => column.name === 'canonical_match_confidence')) {
      db.exec(`ALTER TABLE catalog_artists ADD COLUMN canonical_match_confidence REAL NOT NULL DEFAULT 0`)
    }
    if (!catalogArtistColumns.some((column) => column.name === 'canonical_match_source')) {
      db.exec(`ALTER TABLE catalog_artists ADD COLUMN canonical_match_source TEXT`)
    }
    if (!catalogArtistColumns.some((column) => column.name === 'canonical_fetched_at')) {
      db.exec(`ALTER TABLE catalog_artists ADD COLUMN canonical_fetched_at INTEGER`)
    }
    if (!catalogArtistColumns.some((column) => column.name === 'canonical_locked')) {
      db.exec(`ALTER TABLE catalog_artists ADD COLUMN canonical_locked INTEGER NOT NULL DEFAULT 0`)
    }

    const catalogAlbumColumns = db.prepare(`PRAGMA table_info(catalog_albums)`).all() as Array<{ name: string }>
    if (!catalogAlbumColumns.some((column) => column.name === 'mb_release_group_id')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN mb_release_group_id TEXT`)
    }
    if (!catalogAlbumColumns.some((column) => column.name === 'mb_release_id')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN mb_release_id TEXT`)
    }
    if (!catalogAlbumColumns.some((column) => column.name === 'canonical_match_status')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN canonical_match_status TEXT NOT NULL DEFAULT 'none'`)
    }
    if (!catalogAlbumColumns.some((column) => column.name === 'canonical_match_confidence')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN canonical_match_confidence REAL NOT NULL DEFAULT 0`)
    }
    if (!catalogAlbumColumns.some((column) => column.name === 'canonical_match_source')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN canonical_match_source TEXT`)
    }
    if (!catalogAlbumColumns.some((column) => column.name === 'canonical_fetched_at')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN canonical_fetched_at INTEGER`)
    }
    if (!catalogAlbumColumns.some((column) => column.name === 'canonical_locked')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN canonical_locked INTEGER NOT NULL DEFAULT 0`)
    }

    const catalogTrackColumns = db.prepare(`PRAGMA table_info(catalog_tracks)`).all() as Array<{ name: string }>
    if (!catalogTrackColumns.some((column) => column.name === 'mb_recording_id')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN mb_recording_id TEXT`)
    }
    if (!catalogTrackColumns.some((column) => column.name === 'mb_release_id')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN mb_release_id TEXT`)
    }
    if (!catalogTrackColumns.some((column) => column.name === 'canonical_match_status')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN canonical_match_status TEXT NOT NULL DEFAULT 'none'`)
    }
    if (!catalogTrackColumns.some((column) => column.name === 'canonical_match_confidence')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN canonical_match_confidence REAL NOT NULL DEFAULT 0`)
    }
    if (!catalogTrackColumns.some((column) => column.name === 'canonical_match_source')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN canonical_match_source TEXT`)
    }
    if (!catalogTrackColumns.some((column) => column.name === 'canonical_fetched_at')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN canonical_fetched_at INTEGER`)
    }
    if (!catalogTrackColumns.some((column) => column.name === 'canonical_locked')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN canonical_locked INTEGER NOT NULL DEFAULT 0`)
    }

    const artistAlbumEdgeColumns = db.prepare(`PRAGMA table_info(catalog_artist_album_edges)`).all() as Array<{ name: string }>
    if (!artistAlbumEdgeColumns.some((column) => column.name === 'metadata_source')) {
      db.exec(`ALTER TABLE catalog_artist_album_edges ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!artistAlbumEdgeColumns.some((column) => column.name === 'credit_role')) {
      db.exec(`ALTER TABLE catalog_artist_album_edges ADD COLUMN credit_role TEXT NOT NULL DEFAULT 'primary'`)
    }
    if (!artistAlbumEdgeColumns.some((column) => column.name === 'join_phrase')) {
      db.exec(`ALTER TABLE catalog_artist_album_edges ADD COLUMN join_phrase TEXT`)
    }
    if (!artistAlbumEdgeColumns.some((column) => column.name === 'confidence')) {
      db.exec(`ALTER TABLE catalog_artist_album_edges ADD COLUMN confidence REAL NOT NULL DEFAULT 1`)
    }
    if (!artistAlbumEdgeColumns.some((column) => column.name === 'fetched_at')) {
      db.exec(`ALTER TABLE catalog_artist_album_edges ADD COLUMN fetched_at INTEGER`)
    }

    const albumTrackEdgeColumns = db.prepare(`PRAGMA table_info(catalog_album_track_edges)`).all() as Array<{ name: string }>
    if (!albumTrackEdgeColumns.some((column) => column.name === 'metadata_source')) {
      db.exec(`ALTER TABLE catalog_album_track_edges ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!albumTrackEdgeColumns.some((column) => column.name === 'confidence')) {
      db.exec(`ALTER TABLE catalog_album_track_edges ADD COLUMN confidence REAL NOT NULL DEFAULT 1`)
    }
    if (!albumTrackEdgeColumns.some((column) => column.name === 'fetched_at')) {
      db.exec(`ALTER TABLE catalog_album_track_edges ADD COLUMN fetched_at INTEGER`)
    }

    const artistTrackEdgeColumns = db.prepare(`PRAGMA table_info(catalog_artist_track_edges)`).all() as Array<{ name: string }>
    if (!artistTrackEdgeColumns.some((column) => column.name === 'metadata_source')) {
      db.exec(`ALTER TABLE catalog_artist_track_edges ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!artistTrackEdgeColumns.some((column) => column.name === 'credit_role')) {
      db.exec(`ALTER TABLE catalog_artist_track_edges ADD COLUMN credit_role TEXT NOT NULL DEFAULT 'main'`)
    }
    if (!artistTrackEdgeColumns.some((column) => column.name === 'join_phrase')) {
      db.exec(`ALTER TABLE catalog_artist_track_edges ADD COLUMN join_phrase TEXT`)
    }
    if (!artistTrackEdgeColumns.some((column) => column.name === 'confidence')) {
      db.exec(`ALTER TABLE catalog_artist_track_edges ADD COLUMN confidence REAL NOT NULL DEFAULT 1`)
    }
    if (!artistTrackEdgeColumns.some((column) => column.name === 'fetched_at')) {
      db.exec(`ALTER TABLE catalog_artist_track_edges ADD COLUMN fetched_at INTEGER`)
    }

    const relatedArtistColumns = db.prepare(`PRAGMA table_info(catalog_related_artists)`).all() as Array<{ name: string }>
    if (!relatedArtistColumns.some((column) => column.name === 'metadata_source')) {
      db.exec(`ALTER TABLE catalog_related_artists ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!relatedArtistColumns.some((column) => column.name === 'confidence')) {
      db.exec(`ALTER TABLE catalog_related_artists ADD COLUMN confidence REAL NOT NULL DEFAULT 1`)
    }
    if (!relatedArtistColumns.some((column) => column.name === 'fetched_at')) {
      db.exec(`ALTER TABLE catalog_related_artists ADD COLUMN fetched_at INTEGER`)
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_field_provenance (
        entity_type TEXT NOT NULL,
        catalog_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        canonical_id TEXT,
        value TEXT,
        confidence REAL,
        fetched_at INTEGER,
        expires_at INTEGER,
        PRIMARY KEY (entity_type, catalog_id, field_name)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_artists_mb_artist_id ON catalog_artists(mb_artist_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_albums_mb_release_group_id ON catalog_albums(mb_release_group_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_tracks_mb_recording_id ON catalog_tracks(mb_recording_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_field_provenance_entity ON catalog_field_provenance(entity_type, catalog_id);
    `)

    db.pragma('user_version = 17')
  }

  if (schemaVersion < 18) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_catalog_track_sources_local_track ON catalog_track_sources(local_track_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_album_sources_local_album ON catalog_album_sources(local_album_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_artist_sources_local_artist ON catalog_artist_sources(local_artist_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_artist_track_edges_track ON catalog_artist_track_edges(catalog_track_id, position);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
    `)
    db.pragma('user_version = 18')
  }

  if (schemaVersion < 19) {
    const artistSourceCols = db.prepare(`PRAGMA table_info(catalog_artist_sources)`).all() as Array<{ name: string }>
    if (!artistSourceCols.some((c) => c.name === 'bundle_fetched_at')) {
      db.exec(`ALTER TABLE catalog_artist_sources ADD COLUMN bundle_fetched_at INTEGER`)
    }
    const albumSourceCols = db.prepare(`PRAGMA table_info(catalog_album_sources)`).all() as Array<{ name: string }>
    if (!albumSourceCols.some((c) => c.name === 'bundle_fetched_at')) {
      db.exec(`ALTER TABLE catalog_album_sources ADD COLUMN bundle_fetched_at INTEGER`)
    }
    db.pragma('user_version = 19')
  }

  if (schemaVersion < 20) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS streaming_audio_cache (
        provider TEXT NOT NULL,
        source_id TEXT NOT NULL,
        quality_key TEXT NOT NULL,
        resolved_source_id TEXT,
        resolved_quality TEXT,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        format TEXT,
        sample_rate INTEGER,
        bit_depth INTEGER,
        bitrate INTEGER,
        channels INTEGER,
        lossless INTEGER DEFAULT 0,
        is_dsd INTEGER DEFAULT 0,
        dsd_rate INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        last_accessed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        last_played_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (provider, source_id, quality_key)
      );
      CREATE INDEX IF NOT EXISTS idx_streaming_audio_cache_lru ON streaming_audio_cache(provider, last_played_at, last_accessed_at);
      CREATE INDEX IF NOT EXISTS idx_streaming_audio_cache_file ON streaming_audio_cache(file_path);
      CREATE INDEX IF NOT EXISTS idx_streaming_audio_cache_resolved ON streaming_audio_cache(provider, resolved_source_id, quality_key);
    `)
    db.pragma('user_version = 20')
  }

  if (schemaVersion < 21) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS playlist_stacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE TABLE IF NOT EXISTS playlist_stack_items (
        stack_id INTEGER NOT NULL REFERENCES playlist_stacks(id) ON DELETE CASCADE,
        playlist_track_id INTEGER NOT NULL UNIQUE REFERENCES playlist_tracks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (stack_id, playlist_track_id)
      );
      CREATE INDEX IF NOT EXISTS idx_playlist_stacks_playlist ON playlist_stacks(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_stack_items_stack_position ON playlist_stack_items(stack_id, position);
    `)
    db.pragma('user_version = 21')
  }

  if (schemaVersion < 22) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_artist_preferences (
        catalog_artist_id TEXT PRIMARY KEY REFERENCES catalog_artists(id) ON DELETE CASCADE,
        preferred_provider TEXT,
        preferred_source_id TEXT,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
    `)
    db.pragma('user_version = 22')
  }

  if (schemaVersion < 23) {
    const albumColumns = db.prepare(`PRAGMA table_info(albums)`).all() as Array<{ name: string }>
    if (!albumColumns.some((column) => column.name === 'upc')) {
      db.exec(`ALTER TABLE albums ADD COLUMN upc TEXT`)
    }

    const trackColumns = db.prepare(`PRAGMA table_info(tracks)`).all() as Array<{ name: string }>
    if (!trackColumns.some((column) => column.name === 'isrc')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN isrc TEXT`)
    }
    if (!trackColumns.some((column) => column.name === 'upc')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN upc TEXT`)
    }

    const catalogAlbumColumns = db.prepare(`PRAGMA table_info(catalog_albums)`).all() as Array<{ name: string }>
    if (!catalogAlbumColumns.some((column) => column.name === 'upc')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN upc TEXT`)
    }

    const catalogTrackColumns = db.prepare(`PRAGMA table_info(catalog_tracks)`).all() as Array<{ name: string }>
    if (!catalogTrackColumns.some((column) => column.name === 'isrc')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN isrc TEXT`)
    }
    if (!catalogTrackColumns.some((column) => column.name === 'upc')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN upc TEXT`)
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_catalog_albums_upc ON catalog_albums(upc);
      CREATE INDEX IF NOT EXISTS idx_catalog_tracks_isrc ON catalog_tracks(isrc);
      CREATE INDEX IF NOT EXISTS idx_catalog_tracks_upc_track_number ON catalog_tracks(upc, track_number, disc_number);
    `)
    db.pragma('user_version = 23')
  }

  if (schemaVersion < 24) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS playlist_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        source TEXT NOT NULL DEFAULT 'local',
        source_id TEXT,
        parent_id INTEGER REFERENCES playlist_folders(id) ON DELETE SET NULL,
        read_only INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_playlist_folders_parent ON playlist_folders(parent_id, position);
    `)
    const playlistColumns = db.prepare(`PRAGMA table_info(playlists)`).all() as Array<{ name: string }>
    if (!playlistColumns.some((column) => column.name === 'folder_id')) {
      db.exec(`ALTER TABLE playlists ADD COLUMN folder_id INTEGER REFERENCES playlist_folders(id) ON DELETE SET NULL`)
    }
    if (!playlistColumns.some((column) => column.name === 'folder_position')) {
      db.exec(`ALTER TABLE playlists ADD COLUMN folder_position INTEGER`)
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_playlists_folder ON playlists(folder_id, folder_position)`)
    db.pragma('user_version = 24')
  }

  if (schemaVersion < 25) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_radio_stations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        streams_json TEXT NOT NULL,
        default_stream_index INTEGER NOT NULL DEFAULT 0,
        genre_json TEXT,
        country TEXT,
        country_code TEXT,
        language TEXT,
        logo_url TEXT,
        homepage TEXT,
        codec TEXT,
        bitrate INTEGER,
        click_count INTEGER DEFAULT 0,
        votes INTEGER DEFAULT 0,
        last_check_ok INTEGER DEFAULT 1,
        is_custom INTEGER NOT NULL DEFAULT 0,
        is_favorite INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE TABLE IF NOT EXISTS live_radio_metadata_cache (
        station_id TEXT PRIMARY KEY,
        stream_url TEXT NOT NULL,
        raw_title TEXT,
        title TEXT,
        artist TEXT,
        fetched_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_live_radio_custom ON live_radio_stations(is_custom, updated_at);
      CREATE INDEX IF NOT EXISTS idx_live_radio_favorite ON live_radio_stations(is_favorite, updated_at);
    `)
    db.pragma('user_version = 25')
  }

  if (schemaVersion < 26) {
    const catalogAlbumColumns = db.prepare(`PRAGMA table_info(catalog_albums)`).all() as Array<{ name: string }>
    if (!catalogAlbumColumns.some((column) => column.name === 'genres_json')) {
      db.exec(`ALTER TABLE catalog_albums ADD COLUMN genres_json TEXT`)
    }

    const catalogTrackColumns = db.prepare(`PRAGMA table_info(catalog_tracks)`).all() as Array<{ name: string }>
    if (!catalogTrackColumns.some((column) => column.name === 'genres_json')) {
      db.exec(`ALTER TABLE catalog_tracks ADD COLUMN genres_json TEXT`)
    }

    const albumColumns = db.prepare(`PRAGMA table_info(albums)`).all() as Array<{ name: string }>
    if (!albumColumns.some((column) => column.name === 'genres')) {
      db.exec(`ALTER TABLE albums ADD COLUMN genres TEXT`)
    }

    const trackColumns = db.prepare(`PRAGMA table_info(tracks)`).all() as Array<{ name: string }>
    if (!trackColumns.some((column) => column.name === 'genres')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN genres TEXT`)
    }
    db.pragma('user_version = 26')
  }

  if (schemaVersion < 27) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_kv (
        provider TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (provider, key)
      );
      CREATE TABLE IF NOT EXISTS provider_secrets (
        provider TEXT NOT NULL,
        key TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        encryption_version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (provider, key)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_kv_provider ON provider_kv(provider);
      CREATE INDEX IF NOT EXISTS idx_provider_secrets_provider ON provider_secrets(provider);
    `)
    db.pragma('user_version = 27')
  }

  if (schemaVersion < 28) {
    for (const table of ['catalog_artist_sources', 'catalog_album_sources', 'catalog_track_sources']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!columns.some((column) => column.name === 'available')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN available INTEGER NOT NULL DEFAULT 0`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_provider_available ON ${table}(provider, available)`)
    }
    db.exec(`
      UPDATE catalog_artist_sources SET available = 1 WHERE provider = 'local';
      UPDATE catalog_album_sources SET available = 1 WHERE provider = 'local';
      UPDATE catalog_track_sources SET available = 1 WHERE provider = 'local';
    `)
    db.pragma('user_version = 28')
  }

  if (schemaVersion < 29) {
    db.pragma('user_version = 29')
  }

  const catalogArtistColumns = db.prepare(`PRAGMA table_info(catalog_artists)`).all() as Array<{ name: string }>
  const catalogAlbumColumns = db.prepare(`PRAGMA table_info(catalog_albums)`).all() as Array<{ name: string }>
  const catalogTrackColumns = db.prepare(`PRAGMA table_info(catalog_tracks)`).all() as Array<{ name: string }>

  if (catalogArtistColumns.some((column) => column.name === 'mb_artist_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_artists_mb_artist_id ON catalog_artists(mb_artist_id)`)
  }
  if (catalogAlbumColumns.some((column) => column.name === 'mb_release_group_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_albums_mb_release_group_id ON catalog_albums(mb_release_group_id)`)
  }
  if (catalogAlbumColumns.some((column) => column.name === 'upc')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_albums_upc ON catalog_albums(upc)`)
  }
  if (catalogTrackColumns.some((column) => column.name === 'mb_recording_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_tracks_mb_recording_id ON catalog_tracks(mb_recording_id)`)
  }
  if (catalogTrackColumns.some((column) => column.name === 'isrc')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_tracks_isrc ON catalog_tracks(isrc)`)
  }
  if (catalogTrackColumns.some((column) => column.name === 'upc')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_tracks_upc_track_number ON catalog_tracks(upc, track_number, disc_number)`)
  }

  migrateProviderSeparation(db)
  migrateStreamingCacheProvenance(db)
  migrateTrackArtwork(db)
  migrateTrackAvailability(db)
  ensureProviderBoundaries(db)
  ensureSourceIndexes(db)
  backfillArtworkCache(db)
}

/**
 * v31: a cached provider file may be a conversion (e.g. Vorbis decoded to FLAC).
 * `source_format` keeps the delivered format as JSON; old rows stay NULL and
 * fall back to the file format, which is what they always meant.
 */
function migrateStreamingCacheProvenance(db: Database.Database): void {
  if ((db.pragma('user_version', { simple: true }) as number) >= 31) return
  const columns = db.prepare(`PRAGMA table_info(streaming_audio_cache)`).all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'source_format')) {
    db.exec(`ALTER TABLE streaming_audio_cache ADD COLUMN source_format TEXT`)
  }
  db.pragma('user_version = 31')
}

/**
 * v32: a provider track's own artwork (e.g. a video thumbnail) for rows whose
 * album has no cover or that belong to no album: `artwork_id` (local cache) and
 * `art_path` (the remote URL, for places that need a public link such as
 * Discord). Album artwork still wins; existing rows stay NULL until their
 * provider syncs again. Each column is checked on its own, so a database that
 * already reached v32 with only `artwork_id` gains `art_path` too.
 */
function migrateTrackArtwork(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(tracks)`).all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'artwork_id')) {
    db.exec(`ALTER TABLE tracks ADD COLUMN artwork_id TEXT`)
  }
  if (!columns.some((column) => column.name === 'art_path')) {
    db.exec(`ALTER TABLE tracks ADD COLUMN art_path TEXT`)
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 32) db.pragma('user_version = 32')
}

/**
 * v33: why the signed-in account cannot stream a provider track the service
 * still lists (`region`, `subscription`, …), as the provider last reported it
 * or as playback found out. NULL means playable. It is separate from
 * `catalog_track_sources.available`, which says whether the provider itself is
 * ready and is rewritten wholesale whenever providers come and go.
 */
function migrateTrackAvailability(db: Database.Database): void {
  for (const table of ['tracks', 'catalog_track_sources']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'unavailable_reason')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN unavailable_reason TEXT`)
    }
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 33) db.pragma('user_version = 33')
}
