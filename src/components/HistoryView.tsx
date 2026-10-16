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
import ProviderBadge from './ProviderBadge'

function formatPlayedAt(timestamp: number): string {
  const deltaMs = Date.now() - timestamp
  const deltaMinutes = Math.max(1, Math.round(deltaMs / 60000))
  if (deltaMinutes < 60) return `${deltaMinutes} min ago`
  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours} hr ago`
  const deltaDays = Math.round(deltaHours / 24)
  return `${deltaDays} day${deltaDays === 1 ? '' : 's'} ago`
}

function cover(entry: RecentPlayedEntry): string | null {
  return entry.track.coverUrl ?? entry.track.artworkUrl ?? null
}

export default function HistoryView() {
  const setQueue = usePlayerStore((s) => s.setQueue)
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id)
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
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-3 shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">History</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {isLoading ? 'Loading…' : `${entries.length} recently played ${entries.length === 1 ? 'track' : 'tracks'}`}
          </p>
        </div>
        {entries.length > 0 && (
          <button
            onClick={() => { void clearRecentlyPlayedHistory() }}
            className="px-3 py-1.5 rounded-lg text-sm text-zinc-400 border border-white/10 hover:text-zinc-200 hover:bg-white/5 transition-colors"
          >
            Clear history
          </button>
        )}
      </div>

      {/* List */}
      {isLoading && entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-zinc-500">Loading…</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-sm text-zinc-500 text-center">
            Nothing played yet. Tracks you listen to will show up here.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="rounded-2xl border border-white/5 overflow-hidden">
            {entries.map((entry, index) => {
              const isCurrent = entry.track.id === currentTrackId
              const art = cover(entry)
              return (
                <div
                  key={`${entry.track.id}:${entry.playedAt}`}
                  onClick={() => setQueue(tracks, index)}
                  className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors border-t border-white/[0.04] first:border-t-0 ${
                    isCurrent ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="w-10 h-10 rounded bg-zinc-800 overflow-hidden shrink-0">
                    {art ? (
                      <img
                        src={art}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                      />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm truncate ${isCurrent ? 'text-white' : 'text-zinc-100'}`}>{entry.track.title}</p>
                    <p className="text-xs text-zinc-500 truncate">
                      {entry.track.artist}
                      {entry.track.album ? ` · ${entry.track.album}` : ''}
                    </p>
                  </div>
                  <ProviderBadge provider={entry.track.provider ?? 'local'} compact iconOnly className="border-white/10 bg-white/5 shrink-0" />
                  <span className="text-xs text-zinc-500 font-mono shrink-0 w-20 text-right">
                    {formatPlayedAt(entry.playedAt)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
