import { describe, expect, it } from 'vitest'
import type { TrackRow } from '../../electron/preload'
import { trackRowToTrack } from './libraryStore'

const row = (overrides: Partial<TrackRow>): TrackRow => ({
  id: 't', file_path: 'provider://track/t', title: 'T', duration: 1000, format: null, sample_rate: null, bit_depth: null,
  bitrate: null, channels: null, lossless: 0, year: null, file_size: null, modified_at: null, has_embedded_art: 0,
  art_hash: null, album_id: null, artist_id: null, artist_name: null, album_title: null, album_art_path: null,
  album_artwork_id: null, source: 'service-a', ...overrides,
} as TrackRow)

describe('library track artwork', () => {
  it('uses the album cover and falls back to the track’s own thumbnail only without one', () => {
    expect(trackRowToTrack(row({ album_artwork_id: 'album', track_artwork_id: 'thumb' })).coverUrl).toBe('artwork://cache/album')
    expect(trackRowToTrack(row({ album_art_path: 'https://img.example/a.jpg', track_artwork_id: 'thumb' })).coverUrl).toBe('https://img.example/a.jpg')
    expect(trackRowToTrack(row({ track_artwork_id: 'thumb' })).coverUrl).toBe('artwork://cache/thumb')
    expect(trackRowToTrack(row({})).coverUrl ?? null).toBeNull()
  })
  it('gives Discord the thumbnail’s public URL only when the album has no cover', () => {
    const thumb = 'https://i.ytimg.com/vi/x/hqdefault.jpg'
    expect(trackRowToTrack(row({ track_artwork_id: 'thumb', track_art_path: thumb })).discordArtworkUrl).toBe(thumb)
    expect(trackRowToTrack(row({ album_art_path: 'https://img.example/a.jpg', track_art_path: thumb })).discordArtworkUrl).toBeNull()
    expect(trackRowToTrack(row({ album_artwork_url: 'https://img.example/c.jpg', track_art_path: thumb })).discordArtworkUrl).toBe('https://img.example/c.jpg')
    expect(trackRowToTrack(row({ source: 'local', track_art_path: thumb })).discordArtworkUrl).toBeNull()
  })
})
