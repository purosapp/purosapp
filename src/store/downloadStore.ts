/**
 * Download store — queues playlist downloads for offline playback.
 *
 * Each track goes through its provider's prefetch/resolve call, which writes
 * the finished file into the streaming audio cache; the main process then pins
 * that file so cache trimming never evicts it. Playlists download one at a
 * time and one track at a time, so playback keeps priority with the provider.
 */

import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { PlaylistDownloadState } from '../../electron/preload'
import { trackRowToTrack } from './libraryStore'
import { usePlayerStore, type Track } from './playerStore'
import { resolveProviderArtifact, waitForCompletedArtifact } from '../services/playback/providerArtifact'
import { TrackUnavailableError } from '../services/playback/types'
import type { ContextMenuEntry } from '../utils/contextMenu'
import {
  DOWNLOAD_MAX_ATTEMPTS,
  DOWNLOAD_REQUEST_GAP_MS,
  nextDownloadBackoffMs,
  relaxDownloadBackoffMs,
} from '../services/downloads/pacing'

/** Hi-res albums on slow connections need far longer than a playback start. */
const TRACK_DOWNLOAD_TIMEOUT_MS = 15 * 60_000

export type PlaylistDownloadStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled'

export interface PlaylistDownloadJob {
  playlistId: number
  name: string
  status: PlaylistDownloadStatus
  /** Tracks this run had to fetch (already downloaded tracks are not counted). */
  total: number
  completed: number
  failed: number
  skipped: number
  currentTitle: string | null
  /** Set while the queue backs off after a failure (usually a provider rate limit). */
  waitingUntil: number | null
  error?: string
}

interface DownloadState {
  jobs: Record<number, PlaylistDownloadJob>
  /** Bumped whenever downloaded files change, so views can refetch their counts. */
  revision: number

  downloadPlaylist: (playlistId: number, name: string) => Promise<void>
  cancelPlaylist: (playlistId: number) => void
  removePlaylistDownload: (playlistId: number) => Promise<number>
  removeAllDownloads: () => Promise<number>
  pruneOrphans: () => Promise<number>
}

const queue: number[] = []
const cancelled = new Set<number>()
let running = false
/** Shared across playlists: a rate limit hit by one also applies to the next. */
let backoffMs = 0

/** Sleeps in short steps so stopping a download does not wait out a long backoff. */
async function waitUnlessCancelled(ms: number, playlistId: number): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until && !cancelled.has(playlistId)) {
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(250, until - Date.now())))
  }
}

function keyFor(track: Track): string | null {
  const provider = track.provider ?? track.sourceType
  const sourceId = track.sourceId ?? track.streamId
  if (!provider || provider === 'local' || !sourceId) return null
  return `${provider}:${sourceId}`
}

export const useDownloadStore = create<DownloadState>((set, get) => {
  const updateJob = (playlistId: number, patch: Partial<PlaylistDownloadJob>) => {
    set((state) => {
      const job = state.jobs[playlistId]
      if (!job) return state
      return { jobs: { ...state.jobs, [playlistId]: { ...job, ...patch } } }
    })
  }

  const bumpRevision = () => set((state) => ({ revision: state.revision + 1 }))

  /** Returns 'done', 'skipped' or 'failed'; never throws. */
  const downloadTrack = async (track: Track): Promise<'done' | 'skipped' | 'failed'> => {
    try {
      const { providerId, artifact } = await resolveProviderArtifact(track, 'prefetch', true)
      if (!artifact) return 'failed'
      const completed = await waitForCompletedArtifact(providerId, artifact, TRACK_DOWNLOAD_TIMEOUT_MS)
      const sourceId = track.sourceId ?? track.streamId
      if (!sourceId) return 'failed'
      await window.puros.downloads.markTrack(providerId, sourceId, completed.path)
      return 'done'
    } catch (error) {
      if (error instanceof TrackUnavailableError) return 'skipped'
      console.warn('[Puros][Downloads] Track download failed:', track.title, error)
      return 'failed'
    }
  }

  const runPlaylist = async (playlistId: number) => {
    const job = get().jobs[playlistId]
    if (!job) return
    updateJob(playlistId, { status: 'downloading', error: undefined })

    let pending: Track[]
    try {
      const [state, rows] = await Promise.all([
        window.puros.downloads.enablePlaylist(playlistId),
        window.puros.playlists.getTracks(playlistId),
      ])
      const downloaded = new Set(state.downloadedKeys)
      const seen = new Set<string>()
      pending = rows.map(trackRowToTrack).filter((track) => {
        const key = keyFor(track)
        if (!key || track.unavailableReason || downloaded.has(key) || seen.has(key)) return false
        seen.add(key)
        return true
      })
    } catch (error) {
      updateJob(playlistId, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
      return
    }

    updateJob(playlistId, { total: pending.length, completed: 0, failed: 0, skipped: 0 })
    let completed = 0
    let failed = 0
    let skipped = 0

    for (const track of pending) {
      if (cancelled.has(playlistId)) break
      let outcome: Awaited<ReturnType<typeof downloadTrack>> = 'failed'
      for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS && !cancelled.has(playlistId); attempt += 1) {
        updateJob(playlistId, { currentTitle: track.title, waitingUntil: null })
        outcome = await downloadTrack(track)
        if (outcome !== 'failed') break
        // Usually a rate limit (or playback preempting the prefetch): wait, then retry this track.
        backoffMs = nextDownloadBackoffMs(backoffMs)
        if (attempt === DOWNLOAD_MAX_ATTEMPTS) break
        updateJob(playlistId, { waitingUntil: Date.now() + backoffMs })
        await waitUnlessCancelled(backoffMs, playlistId)
      }
      if (cancelled.has(playlistId) && outcome === 'failed') break
      if (outcome === 'done') {
        completed += 1
        backoffMs = relaxDownloadBackoffMs(backoffMs)
        bumpRevision()
      } else if (outcome === 'skipped') {
        skipped += 1
      } else {
        failed += 1
      }
      updateJob(playlistId, { completed, failed, skipped, waitingUntil: null })
      await waitUnlessCancelled(DOWNLOAD_REQUEST_GAP_MS, playlistId)
    }

    if (cancelled.has(playlistId)) {
      cancelled.delete(playlistId)
      updateJob(playlistId, { status: 'cancelled', currentTitle: null, waitingUntil: null })
      return
    }
    updateJob(playlistId, {
      status: failed > 0 ? 'failed' : 'done',
      currentTitle: null,
      waitingUntil: null,
      error: failed > 0 ? `${failed} track${failed === 1 ? '' : 's'} could not be downloaded` : undefined,
    })
    const { setNotification } = usePlayerStore.getState()
    setNotification(failed > 0
      ? `Downloaded "${job.name}" • ${failed} track${failed === 1 ? '' : 's'} failed`
      : `Downloaded "${job.name}"`)
  }

  const pump = async () => {
    if (running) return
    running = true
    try {
      while (queue.length > 0) {
        const playlistId = queue.shift()!
        if (cancelled.has(playlistId)) {
          cancelled.delete(playlistId)
          updateJob(playlistId, { status: 'cancelled', currentTitle: null, waitingUntil: null })
          continue
        }
        await runPlaylist(playlistId)
      }
    } finally {
      running = false
    }
  }

  return {
    jobs: {},
    revision: 0,

    downloadPlaylist: async (playlistId, name) => {
      const existing = get().jobs[playlistId]
      if (existing && (existing.status === 'queued' || existing.status === 'downloading')) return
      cancelled.delete(playlistId)
      await window.puros.downloads.enablePlaylist(playlistId)
      set((state) => ({
        jobs: {
          ...state.jobs,
          [playlistId]: { playlistId, name, status: 'queued', total: 0, completed: 0, failed: 0, skipped: 0, currentTitle: null, waitingUntil: null },
        },
        revision: state.revision + 1,
      }))
      queue.push(playlistId)
      void pump()
    },

    cancelPlaylist: (playlistId) => {
      const job = get().jobs[playlistId]
      if (!job || (job.status !== 'queued' && job.status !== 'downloading')) return
      cancelled.add(playlistId)
      if (job.status === 'queued') {
        const index = queue.indexOf(playlistId)
        if (index >= 0) queue.splice(index, 1)
        cancelled.delete(playlistId)
        updateJob(playlistId, { status: 'cancelled', currentTitle: null, waitingUntil: null })
      }
    },

    removePlaylistDownload: async (playlistId) => {
      get().cancelPlaylist(playlistId)
      const removed = await window.puros.downloads.removePlaylist(playlistId)
      set((state) => {
        const { [playlistId]: _removed, ...jobs } = state.jobs
        void _removed
        return { jobs, revision: state.revision + 1 }
      })
      return removed
    },

    removeAllDownloads: async () => {
      for (const playlistId of Object.keys(get().jobs).map(Number)) get().cancelPlaylist(playlistId)
      const removed = await window.puros.downloads.removeAll()
      set((state) => ({ jobs: {}, revision: state.revision + 1 }))
      return removed
    },

    pruneOrphans: async () => {
      const removed = await window.puros.downloads.pruneOrphans()
      bumpRevision()
      return removed
    },
  }
})

export function isPlaylistDownloadActive(job: PlaylistDownloadJob | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'downloading'
}

/** The playlist's on-disk download state; refetches as downloads progress or the playlist changes. */
export function usePlaylistDownloadState(playlistId: number): PlaylistDownloadState | null {
  const revision = useDownloadStore((state) => state.revision)
  const [downloadState, setDownloadState] = useState<PlaylistDownloadState | null>(null)
  const [playlistRevision, setPlaylistRevision] = useState(0)

  useEffect(() => window.puros.on('playlists:changed', () => setPlaylistRevision((value) => value + 1)), [])

  useEffect(() => {
    let stale = false
    window.puros.downloads.getPlaylistState(playlistId)
      .then((next) => { if (!stale) setDownloadState(next) })
      .catch(() => { if (!stale) setDownloadState(null) })
    return () => { stale = true }
  }, [playlistId, playlistRevision, revision])

  return downloadState
}

/** Download items for a playlist's context menu; empty when it has nothing to download. */
export async function getPlaylistDownloadMenuEntries(playlistId: number, name: string): Promise<ContextMenuEntry[]> {
  const store = useDownloadStore.getState()
  const notify = usePlayerStore.getState().setNotification
  if (isPlaylistDownloadActive(store.jobs[playlistId])) {
    return [{ label: 'Stop Downloading', onClick: () => store.cancelPlaylist(playlistId) }]
  }
  const state = await window.puros.downloads.getPlaylistState(playlistId).catch(() => null)
  if (!state) return []
  const download = () => {
    void store.downloadPlaylist(playlistId, name).catch((error) => {
      notify(`Could not download playlist: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const missing = Math.max(0, state.total - state.downloaded)
  if (!state.enabled) return state.total > 0 ? [{ label: 'Download', onClick: download }] : []
  return [
    missing > 0 && { label: `Download ${missing} Missing Track${missing === 1 ? '' : 's'}`, onClick: download },
    {
      label: 'Remove Download',
      onClick: () => { void store.removePlaylistDownload(playlistId).then(() => notify(`Removed download of "${name}"`)) },
    },
  ]
}
