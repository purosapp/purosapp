import { useCallback, useEffect, useState } from 'react'
import { Download, ListMusic, Trash2, X } from 'lucide-react'
import type { DownloadedPlaylistSummary, DownloadsOverview } from '../../../electron/preload'
import { isPlaylistDownloadActive, useDownloadStore, type PlaylistDownloadJob } from '../../store/downloadStore'
import { useAppShellStore } from '../../store/appShellStore'
import { artworkUrl } from '../../utils/artworkUrl'
import { formatBytes } from '../../utils/formatBytes'
import ProviderBadge from '../ProviderBadge'
import { Button } from '../ui'

function jobProgressLabel(job: PlaylistDownloadJob): string {
  if (job.status === 'queued') return 'Queued'
  if (job.total === 0) return 'Preparing…'
  const done = job.completed + job.failed + job.skipped
  if (job.waitingUntil) return `Paused ${done}/${job.total} • the provider is limiting requests, retrying shortly`
  return `Downloading ${done}/${job.total}${job.currentTitle ? ` • ${job.currentTitle}` : ''}`
}

function playlistStatusLabel(playlist: DownloadedPlaylistSummary, job: PlaylistDownloadJob | undefined): string {
  if (job && isPlaylistDownloadActive(job)) return jobProgressLabel(job)
  const parts = [`${playlist.downloaded}/${playlist.total} tracks`, formatBytes(playlist.totalBytes)]
  if (playlist.unavailable > 0) parts.push(`${playlist.unavailable} unavailable`)
  if (job?.status === 'failed' && job.error) parts.push(job.error)
  else if (job?.status === 'cancelled') parts.push('Stopped')
  return parts.join(' • ')
}

function DownloadedPlaylistRow({
  playlist,
  onOpen,
}: {
  playlist: DownloadedPlaylistSummary
  onOpen: () => void
}) {
  const job = useDownloadStore((state) => state.jobs[playlist.playlistId])
  const downloadPlaylist = useDownloadStore((state) => state.downloadPlaylist)
  const cancelPlaylist = useDownloadStore((state) => state.cancelPlaylist)
  const removePlaylistDownload = useDownloadStore((state) => state.removePlaylistDownload)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const active = isPlaylistDownloadActive(job)
  const missing = Math.max(0, playlist.total - playlist.downloaded)
  const cover = artworkUrl(playlist.artworkId, null)
  const progress = active && job && job.total > 0
    ? (job.completed + job.failed + job.skipped) / job.total
    : playlist.total > 0 ? playlist.downloaded / playlist.total : 0

  return (
    <div className="rounded-xl bg-white/[0.03] px-3 py-2.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpen}
          title="Open playlist"
          className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-white/[0.06] flex items-center justify-center text-zinc-500"
        >
          {cover ? <img src={cover} alt="" className="h-full w-full object-cover" /> : <ListMusic size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onOpen} className="truncate text-sm font-medium text-zinc-200 hover:text-white">
              {playlist.name}
            </button>
            <ProviderBadge provider={playlist.provider || 'local'} compact />
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500">{playlistStatusLabel(playlist, job)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {active ? (
            <Button variant="secondary" size="sm" icon={X} label="Stop" onClick={() => cancelPlaylist(playlist.playlistId)} />
          ) : missing > 0 && (
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              label={`Download ${missing}`}
              title={`Download the ${missing} missing track${missing === 1 ? '' : 's'}`}
              onClick={() => { void downloadPlaylist(playlist.playlistId, playlist.name) }}
            />
          )}
          {confirmRemove ? (
            <>
              <Button
                variant="primary"
                size="sm"
                label="Remove"
                onClick={() => { void removePlaylistDownload(playlist.playlistId) }}
              />
              <Button variant="secondary" size="sm" label="Cancel" onClick={() => setConfirmRemove(false)} />
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={Trash2}
              label="Remove download"
              onClick={() => setConfirmRemove(true)}
            />
          )}
        </div>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full bg-accent-400/70 transition-[width] duration-300"
          style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }}
        />
      </div>
    </div>
  )
}

export default function DownloadsSettings({ onClose }: { onClose: () => void }) {
  const revision = useDownloadStore((state) => state.revision)
  const jobs = useDownloadStore((state) => state.jobs)
  const removeAllDownloads = useDownloadStore((state) => state.removeAllDownloads)
  const pruneOrphans = useDownloadStore((state) => state.pruneOrphans)
  const openPlaylist = useAppShellStore((state) => state.openPlaylist)
  const [overview, setOverview] = useState<DownloadsOverview | null>(null)
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const next = await window.puros.downloads.getOverview().catch(() => null)
    setOverview(next)
  }, [])

  // Job status changes (finished, stopped) also change the totals.
  const jobStatuses = Object.values(jobs).map((job) => `${job.playlistId}:${job.status}`).join(',')
  useEffect(() => {
    void refresh()
  }, [refresh, revision, jobStatuses])

  useEffect(() => window.puros.on('playlists:changed', () => { void refresh() }), [refresh])

  const handleRemoveAll = async () => {
    setBusy(true)
    try {
      await removeAllDownloads()
      setConfirmRemoveAll(false)
    } finally {
      setBusy(false)
    }
  }

  const handlePrune = async () => {
    setBusy(true)
    try {
      await pruneOrphans()
    } finally {
      setBusy(false)
    }
  }

  const playlists = overview?.playlists ?? []

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-3">
          Downloaded playlists
        </h3>
        <div className="bg-white/[0.03] rounded-2xl p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-zinc-200">
              {overview ? formatBytes(overview.totalBytes) : 'Calculating…'}
            </span>
            {overview && (
              <span className="text-xs text-zinc-500">
                {overview.fileCount} {overview.fileCount === 1 ? 'file' : 'files'} in {playlists.length} {playlists.length === 1 ? 'playlist' : 'playlists'}
              </span>
            )}
          </div>
          <p className="mt-2 text-[11px] text-zinc-600 leading-relaxed">
            Downloaded playlists stay on disk for offline playback in the quality your provider is set to. They do not count towards the streaming audio cache limit and are kept when you clear caches. Use the Download button on a playlist to add it here.
          </p>
        </div>
      </div>

      {playlists.length > 0 ? (
        <div className="space-y-2">
          {playlists.map((playlist) => (
            <DownloadedPlaylistRow
              key={playlist.playlistId}
              playlist={playlist}
              onOpen={() => {
                openPlaylist(playlist.playlistId)
                onClose()
              }}
            />
          ))}
        </div>
      ) : overview && (
        <p className="rounded-2xl bg-white/[0.03] px-4 py-5 text-sm text-zinc-500">
          No playlists are downloaded yet.
        </p>
      )}

      {overview && overview.orphanedCount > 0 && (
        <div className="flex items-start justify-between gap-4 rounded-2xl bg-white/[0.03] p-4">
          <div>
            <p className="text-sm text-zinc-200 font-medium">Tracks no longer in a downloaded playlist</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              {overview.orphanedCount} {overview.orphanedCount === 1 ? 'file' : 'files'} • {formatBytes(overview.orphanedBytes)}. These were removed from their playlists after downloading.
            </p>
          </div>
          <Button variant="secondary" size="sm" label="Delete" onClick={() => { void handlePrune() }} disabled={busy} className="shrink-0" />
        </div>
      )}

      {playlists.length > 0 && (
        <div className="pt-3 border-t border-white/5 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-200 font-medium">Remove all downloads</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Deletes every downloaded file. Your playlists stay in the library and stream as before.
            </p>
          </div>
          {!confirmRemoveAll ? (
            <Button
              variant="secondary"
              size="sm"
              label="Remove all…"
              onClick={() => setConfirmRemoveAll(true)}
              disabled={busy}
              className="shrink-0"
            />
          ) : (
            <div className="shrink-0 flex gap-2">
              <Button
                variant="primary"
                size="sm"
                label={busy ? 'Removing…' : 'Yes, remove'}
                onClick={() => { void handleRemoveAll() }}
                disabled={busy}
              />
              <Button variant="secondary" size="sm" label="Cancel" onClick={() => setConfirmRemoveAll(false)} disabled={busy} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
