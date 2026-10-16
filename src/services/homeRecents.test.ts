import { describe, expect, it } from 'vitest'
import {
  filterVisibleRecentPlaylists,
  filterVisibleRecentTracks,
  type RecentPlayedEntry,
  type RecentPlaylistEntry,
} from './homeRecents'

function recentTrack(id: string, provider: string): RecentPlayedEntry {
  return {
    playedAt: 1,
    track: { id, title: id, artist: '', album: '', duration: 0, provider },
  }
}

function recentPlaylist(name: string, source: string, entryKind: RecentPlaylistEntry['entryKind']): RecentPlaylistEntry {
  return {
    playedAt: 1,
    entryKind,
    playlistId: entryKind === 'local-playlist' ? 1 : null,
    name,
    artworkId: null,
    artworkUrl: null,
    source,
    trackCount: 1,
    ...(entryKind === 'provider-playlist' ? {
      provider: source,
      sourceType: 'playlist' as const,
      sourceId: name,
      itemId: name,
    } : {}),
  }
}

describe('Home unavailable-source visibility', () => {
  const available = new Set(['connected-provider'])

  it('hides absent-provider track history but retains local and core radio history', () => {
    const history = [
      recentTrack('local', 'local'),
      recentTrack('connected', 'connected-provider'),
      recentTrack('absent', 'absent-provider'),
      { ...recentTrack('legacy', 'local'), track: { ...recentTrack('legacy', 'local').track, provider: undefined, sourceType: 'absent-provider' } },
      recentTrack('radio', 'live-radio'),
    ]

    expect(filterVisibleRecentTracks(history, available, false).map((entry) => entry.track.id))
      .toEqual(['local', 'connected', 'radio'])
    expect(filterVisibleRecentTracks(history, available, true)).toEqual(history)
    expect(history).toHaveLength(5)
  })

  it('hides absent imported and provider-collection playlists without deleting history', () => {
    const history = [
      recentPlaylist('Local', 'local', 'local-playlist'),
      recentPlaylist('Connected', 'connected-provider', 'provider-playlist'),
      recentPlaylist('Imported', 'absent-provider', 'local-playlist'),
      recentPlaylist('Remote', 'absent-provider', 'provider-playlist'),
      { ...recentPlaylist('Legacy', 'local', 'provider-playlist'), provider: 'absent-provider' },
    ]

    expect(filterVisibleRecentPlaylists(history, available, false).map((entry) => entry.name))
      .toEqual(['Local', 'Connected'])
    expect(filterVisibleRecentPlaylists(history, available, true)).toEqual(history)
    expect(history).toHaveLength(5)
  })
})
