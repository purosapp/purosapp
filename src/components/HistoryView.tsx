/**
 * History — recently played tracks across every data provider.
 *
 * Backed by the shared recently-played log, which records each track with its
 * originating source (local or remote), so the list is inherently
 * provider-spanning. Clicking a row plays from that point; the queue continues
 * through the rest of the history.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  HOME_RECENTS_CHANGED_EVENT,
  clearRecentlyPlayedHistory,
  loadRecentlyPlayed,
  type RecentPlayedEntry,
} from '../services/homeRecents'
import { usePlayerStore } from '../store/playerStore'
import { Trash2 } from 'lucide-react'
import { useAppShellStore } from '../store/appShellStore'
import { formatPlayedAt } from '../utils/formatTime'
import ProviderBadge from './ProviderBadge'
import TrackList, { TrackListSkeleton, type TrackListRow } from './TrackList'
import { Button, PageHeader, PageStatus } from './ui'

function cover(entry: RecentPlayedEntry): string | null {
  return entry.track.coverUrl ?? entry.track.artworkUrl ?? null
}

export default function HistoryView() {
  const setQueue = usePlayerStore((s) => s.setQueue)
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id)
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const [entries, setEntries] = useState<RecentPlayedEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    const rows = await loadRecentlyPlayed()
    setEntries(rows)
    setIsLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
    const handler = () => { void refresh() }
    window.addEventListener(HOME_RECENTS_CHANGED_EVENT, handler)
    return () => window.removeEventListener(HOME_RECENTS_CHANGED_EVENT, handler)
  }, [refresh])

  const tracks = entries.map((entry) => entry.track)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PageHeader
        kicker="Library"
        title="History"
        subtitle={isLoading ? 'Loading…' : `${entries.length} recently played ${entries.length === 1 ? 'track' : 'tracks'}`}
        actions={entries.length > 0 ? (
          <Button icon={Trash2} label="Clear history" onClick={() => { void clearRecentlyPlayedHistory() }} />
        ) : undefined}
      />

      {isLoading && entries.length === 0 ? (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <TrackListSkeleton rows={12} />
        </div>
      ) : entries.length === 0 ? (
        <PageStatus fill title="Nothing played yet." hint="Tracks you listen to will show up here." />
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <TrackList
            rows={entries.map((entry, index): TrackListRow => ({
              key: `${entry.track.id}:${entry.playedAt}`,
              number: index + 1,
              title: entry.track.title,
              artworkSrc: cover(entry),
              artist: entry.track.artist,
              onOpenArtist: entry.track.catalogArtistId ? () => { void openCatalogArtist(entry.track.catalogArtistId!) } : undefined,
              album: entry.track.album || null,
              onOpenAlbum: entry.track.catalogAlbumId ? () => { void openCatalogAlbum(entry.track.catalogAlbumId!) } : undefined,
              meta: <ProviderBadge provider={entry.track.provider ?? 'local'} compact iconOnly className="border-white/10 bg-white/[0.05]" />,
              trailing: formatPlayedAt(entry.playedAt),
              active: entry.track.id === currentTrackId,
            }))}
            trailingLabel="Played"
            onPlay={(index) => setQueue(tracks, index)}
          />
        </div>
      )}
    </div>
  )
}
