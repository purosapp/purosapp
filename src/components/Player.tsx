/**
 * Player component — bottom bar with transport controls,
 * track info, format badges, and progress bar.
 */

import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react'
import { usePlayerStore } from '../store/playerStore'
import { useAppShellStore } from '../store/appShellStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  StreamingSessionState,
} from '../services/playback/streaming'
import { playbackPreparationService } from '../services/playback/PlaybackPreparationService'
import FormatBadges from './FormatBadges'
import AudioOutputSelector from './AudioOutputSelector'
import ArtworkThumbnail from './ArtworkThumbnail'
import EQPanel from './EQPanel'
import SignalPathPanel from './SignalPathPanel'
import {
  DEFAULT_ARTWORK_AMBIENT_COLOR,
  resolveArtwork,
  rgba,
  sampleArtworkColor,
} from '../utils/artworkColor'
import { isLiveRadioTrack } from '../services/liveRadio/track'
import { describeVolumeControl } from '../services/volumeControl'

interface PlayerProps {
  onOpenNowPlaying?: () => void
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function getPerceivedBrightness({ r, g, b }: { r: number; g: number; b: number }): number {
  return (r * 299 + g * 587 + b * 114) / 1000
}

function darkenColor(
  { r, g, b }: { r: number; g: number; b: number },
  amount: number,
): { r: number; g: number; b: number } {
  const factor = Math.max(0, 1 - amount)
  return {
    r: Math.round(r * factor),
    g: Math.round(g * factor),
    b: Math.round(b * factor),
  }
}

function SpeakerIcon({ volume }: { volume: number }) {
  const Icon = volume <= 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  return <Icon className="w-4 h-4" aria-hidden="true" />
}

export default function Player({ onOpenNowPlaying }: PlayerProps) {
  const {
    currentTrack,
    formatInfo,
    outputMode,
    deviceName,
    audioDevice,
    bluetoothInfo,
    isPlaying,
    position,
    duration,
    volume,
    volumeControl,
    shuffle,
    repeat,
    playbackDecision,
    togglePlayPause,
    next,
    previous,
    seek,
    setVolume,
    toggleShuffle,
    cycleRepeat,
  } = usePlayerStore()
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const openCatalogAlbum = useAppShellStore((s) => s.openCatalogAlbum)
  const openPlaylist = useAppShellStore((s) => s.openPlaylist)
  const openProviderCollection = useAppShellStore((s) => s.openProviderCollection)
  const streamingPlaybackMode = useSettingsStore((s) => s.streamingPlaybackMode)
  const showStreamingBadge = useSettingsStore((s) => s.playerTags.streamingStatus)
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubPos, setScrubPos] = useState(0)
  const scrubBarRef = useRef<HTMLDivElement>(null)
  const lastAudibleVolumeRef = useRef(volume > 0 ? volume : 1)
  const volumeLocked = volumeControl.effective === 'fixed'
  const volumeTitle = describeVolumeControl(volumeControl, volume)
  const [ambientColor, setAmbientColor] = useState(DEFAULT_ARTWORK_AMBIENT_COLOR)
  const [streamingStatus, setStreamingStatus] = useState<{
    providerId: string
    sessionId: string
    trackId: string
    state: StreamingSessionState
    percent: number
  } | null>(null)

  const displayPosition = scrubbing ? scrubPos : position
  const liveRadioActive = isLiveRadioTrack(currentTrack)
  const progress = duration > 0 ? (displayPosition / duration) * 100 : 0
  const artworkSrc = resolveArtwork(currentTrack)
  const currentTrackProvider = String(currentTrack?.provider ?? currentTrack?.sourceType ?? '').trim().toLowerCase()
  const activeStreamIds = [
    currentTrack?.streamId,
    ...(currentTrack?.fallbackStreamIds ?? []),
  ].filter((value): value is string => !!value)
  const growingSession = playbackPreparationService.getActiveGrowingSession()
  const showStreamingStatus =
    showStreamingBadge
    &&
    streamingPlaybackMode === 'progressive-cache'
    && !!streamingStatus
    && growingSession?.providerId === streamingStatus.providerId
    && growingSession.sessionId === streamingStatus.sessionId
    && currentTrackProvider === streamingStatus.providerId
    && activeStreamIds.includes(streamingStatus.trackId)
    && (
      streamingStatus.state === StreamingSessionState.Running
      || streamingStatus.state === StreamingSessionState.Completed
    )
  const streamingStatusLabel = streamingStatus?.state === StreamingSessionState.Completed
    ? 'Streaming'
    : 'Streaming + Caching'

  const posFromEvent = (e: React.PointerEvent) => {
    const rect = scrubBarRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration
  }

  useEffect(() => {
    if (volume > 0) lastAudibleVolumeRef.current = volume
  }, [volume])

  useEffect(() => {
    setStreamingStatus(null)
  }, [currentTrack?.streamId])

  useEffect(() => {
    return window.puros.provider.onEvent((envelope) => {
      if (envelope.event.type === 'playback.progress') {
        const event = envelope.event.progress
        setStreamingStatus({
          providerId: envelope.providerId,
          sessionId: event.sessionId,
          trackId: event.sourceId,
          state: event.state as StreamingSessionState,
          percent: event.percent ?? 0,
        })
      } else if (envelope.event.type === 'playback.session') {
        const event = envelope.event.session
        setStreamingStatus((current) => ({
          providerId: envelope.providerId,
          sessionId: event.sessionId,
          trackId: event.sourceId,
          state: event.state as StreamingSessionState,
          percent: event.state === 'completed' ? 100 : (current?.sessionId === event.sessionId ? current.percent : 0),
        }))
      }
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    void sampleArtworkColor(artworkSrc).then((color) => {
      if (!cancelled) setAmbientColor(color)
    })

    return () => {
      cancelled = true
    }
  }, [artworkSrc])

  const playbackContext = currentTrack?.playbackContext ?? null
  const canOpenPlaybackContext =
    playbackContext?.kind === 'playlist' ||
    playbackContext?.kind === 'provider-playlist' ||
    playbackContext?.kind === 'album' ||
    playbackContext?.kind === 'artist' ||
    (playbackContext?.kind === 'artist-radio' && !!playbackContext.catalogArtistId)

  const openPlaybackContext = () => {
    if (!playbackContext) return

    if (playbackContext.kind === 'playlist') {
      openPlaylist(playbackContext.playlistId)
      return
    }

    if (playbackContext.kind === 'provider-playlist') {
      if (typeof playbackContext.syncedPlaylistId === 'number') {
        openPlaylist(playbackContext.syncedPlaylistId)
        return
      }

      openProviderCollection({
        id: playbackContext.itemId,
        provider: playbackContext.provider,
        sourceType: playbackContext.sourceType,
        sourceId: playbackContext.sourceId,
        title: playbackContext.label,
        subtitle: playbackContext.subtitle ?? null,
        artworkUrl: playbackContext.artworkUrl ?? null,
        providerUrl: playbackContext.providerUrl ?? null,
        trackCount: playbackContext.trackCount ?? null,
        syncedPlaylistId: playbackContext.syncedPlaylistId ?? null,
      })
      return
    }

    if (playbackContext.kind === 'album') {
      void openCatalogAlbum(playbackContext.catalogAlbumId)
      return
    }

    if (playbackContext.kind === 'artist') {
      void openCatalogArtist(playbackContext.catalogArtistId)
      return
    }

    if (playbackContext.kind === 'artist-radio' && playbackContext.catalogArtistId) {
      void openCatalogArtist(playbackContext.catalogArtistId)
    }
  }

  const handleToggleMute = () => {
    if (volumeLocked) return
    if (volume > 0) {
      setVolume(0)
      return
    }
    setVolume(Math.max(lastAudibleVolumeRef.current, 0.05))
  }

  const ambientBrightness = getPerceivedBrightness(ambientColor)
  const extraDarkening = Math.max(0, (ambientBrightness - 120) / 135) * 0.52
  const playerTintColor = darkenColor(ambientColor, 0.18 + extraDarkening)

  const barBackground = `
    radial-gradient(circle at 4% 50%, ${rgba(playerTintColor, 0.22)} 0%, transparent 20%),
    linear-gradient(90deg,
      rgba(3, 3, 7, 0.88) 0%,
      rgba(6, 6, 9, 0.8) 6%,
      ${rgba(playerTintColor, 0.34)} 14%,
      ${rgba(playerTintColor, 0.18)} 26%,
      ${rgba(playerTintColor, 0.06)} 40%,
      rgba(18, 18, 22, 0.24) 58%,
      rgba(255, 255, 255, 0.05) 100%
    ),
    linear-gradient(180deg, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0.015) 100%)
  `

  return (
    <div
      className="relative z-40 grid h-24 grid-cols-[1fr_auto_1fr] items-center gap-4 border-t border-white/10 px-4 backdrop-blur-xl"
      style={{ background: barBackground }}
    >
      {/* Track info — artwork + text side by side */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={() => {
            if (!currentTrack) return
            onOpenNowPlaying?.()
          }}
          disabled={!currentTrack}
          className="shrink-0 rounded-[10px] transition-transform hover:scale-[1.02] disabled:cursor-default disabled:hover:scale-100"
          title={currentTrack ? 'Open now playing' : undefined}
        >
          <ArtworkThumbnail src={artworkSrc} size={56} />
        </button>
        <div className="min-w-0">
          {currentTrack ? (
            <>
              <div className="flex items-baseline gap-2 min-w-0">
                <p className="text-sm font-medium text-zinc-100 truncate">
                  {currentTrack.title}
                </p>
                {playbackContext?.label ? (
                  canOpenPlaybackContext ? (
                    <button
                      className="shrink-0 max-w-[45%] truncate text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                      onClick={() => openPlaybackContext()}
                      title={playbackContext.label}
                    >
                      {playbackContext.label}
                    </button>
                  ) : (
                    <span
                      className="shrink-0 max-w-[45%] truncate text-[11px] text-zinc-500"
                      title={playbackContext.label}
                    >
                      {playbackContext.label}
                    </span>
                  )
                ) : null}
              </div>
              <div className="text-xs text-zinc-400 truncate flex items-center gap-1.5">
                {currentTrack.catalogArtistId ? (
                  <button
                    className="truncate hover:text-zinc-100 transition-colors"
                    onClick={() => void openCatalogArtist(currentTrack.catalogArtistId!)}
                  >
                    {currentTrack.artist}
                  </button>
                ) : (
                  <span className="truncate">{currentTrack.artist}</span>
                )}
                <span>—</span>
                {currentTrack.catalogAlbumId ? (
                  <button
                    className="truncate hover:text-zinc-100 transition-colors"
                    onClick={() => void openCatalogAlbum(currentTrack.catalogAlbumId!)}
                  >
                    {currentTrack.album}
                  </button>
                ) : (
                  <span className="truncate">{currentTrack.album}</span>
                )}
              </div>
              <FormatBadges
                formatInfo={formatInfo}
                outputMode={outputMode}
                deviceName={deviceName}
                playbackDecision={playbackDecision}
                bluetoothInfo={audioDevice === '__default__' ? bluetoothInfo : null}
              />
              {showStreamingStatus ? (
                <span
                  className="mt-1 inline-flex rounded-full border border-sky-400/25 bg-sky-400/10 px-2 py-0.5 text-[10px] font-medium text-sky-300"
                  title={`${Math.round(streamingStatus?.percent ?? 0)}% cached`}
                >
                  {streamingStatusLabel}
                </span>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-zinc-500">No track selected</p>
          )}
        </div>
      </div>

      {/* Transport controls */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-3">
          {/* Shuffle */}
          <button
            onClick={toggleShuffle}
            className={`p-1.5 rounded-md transition-colors ${
              shuffle ? 'text-blue-400 bg-blue-400/10' : 'text-zinc-400 hover:text-zinc-200'
            }`}
            title="Shuffle"
          >
            <Shuffle className="w-4 h-4" />
          </button>

          {/* Previous */}
          <button
            onClick={previous}
            className="p-1.5 text-zinc-300 hover:text-white transition-colors"
            title="Previous"
          >
            <SkipBack className="w-5 h-5" fill="currentColor" />
          </button>

          {/* Play/Pause */}
          <button
            onClick={togglePlayPause}
            className="p-3 bg-white rounded-full text-zinc-950 hover:scale-105 transition-transform"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <Pause className="w-5 h-5" fill="currentColor" />
            ) : (
              <Play className="w-5 h-5" fill="currentColor" />
            )}
          </button>

          {/* Next */}
          <button
            onClick={next}
            className="p-1.5 text-zinc-300 hover:text-white transition-colors"
            title="Next"
          >
            <SkipForward className="w-5 h-5" fill="currentColor" />
          </button>

          {/* Repeat */}
          <button
            onClick={cycleRepeat}
            className={`p-1.5 rounded-md transition-colors ${
              repeat !== 'off' ? 'text-blue-400 bg-blue-400/10' : 'text-zinc-400 hover:text-zinc-200'
            }`}
            title={`Repeat: ${repeat}`}
          >
            {repeat === 'one' ? <Repeat1 className="w-4 h-4" /> : <Repeat className="w-4 h-4" />}
          </button>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-2 w-96">
          <span className="text-[10px] font-mono text-zinc-500 w-10 text-right">
            {liveRadioActive ? 'LIVE' : formatTime(displayPosition)}
          </span>
          <div
            ref={scrubBarRef}
            className={`relative flex-1 h-1 rounded-full group overflow-hidden ${
              liveRadioActive ? 'cursor-default bg-red-500/20' : 'cursor-pointer bg-zinc-800'
            }`}
            onPointerDown={(e) => {
              if (liveRadioActive) return
              if (!duration) return
              e.currentTarget.setPointerCapture(e.pointerId)
              const pos = posFromEvent(e)
              setScrubbing(true)
              setScrubPos(pos)
            }}
            onPointerMove={(e) => {
              if (liveRadioActive) return
              if (!scrubbing) return
              setScrubPos(posFromEvent(e))
            }}
            onPointerUp={(e) => {
              if (liveRadioActive) return
              if (!scrubbing) return
              setScrubbing(false)
              seek(posFromEvent(e))
            }}
            onPointerCancel={() => setScrubbing(false)}
          >
            <div
              className="absolute inset-y-0 left-0 bg-zinc-400 rounded-full group-hover:bg-white transition-colors"
            style={{ width: `${progress}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
            {liveRadioActive && (
              <div className="absolute left-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.85)]" />
            )}
          </div>
          <span className="text-[10px] font-mono text-zinc-500 w-10">
            {liveRadioActive ? '' : formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Volume + Device */}
      <div className="flex justify-end items-center gap-2">
        <button
          type="button"
          onClick={handleToggleMute}
          disabled={volumeLocked}
          className={`transition-colors ${
            volumeLocked
              ? 'text-zinc-600 cursor-not-allowed'
              : 'text-zinc-400 hover:text-zinc-100'
          }`}
          title={
            volumeLocked
              ? volumeTitle ?? undefined
              : volume > 0
                ? 'Mute'
                : 'Unmute'
          }
        >
          <SpeakerIcon volume={volume} />
        </button>
        <div
          className={`w-24 h-1 rounded-full group relative ${
            volumeLocked
              ? 'bg-zinc-800 cursor-not-allowed'
              : 'bg-zinc-800 cursor-pointer'
          }`}
          title={volumeTitle ?? undefined}
          onPointerDown={(e) => {
            if (volumeLocked) return
            const el = e.currentTarget
            el.setPointerCapture(e.pointerId)
            const rect = el.getBoundingClientRect()
            setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
          }}
          onPointerMove={(e) => {
            if (volumeLocked) return
            if (e.buttons !== 1) return
            const rect = e.currentTarget.getBoundingClientRect()
            setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
          }}
        >
          <div
            className={`h-full rounded-full transition-colors ${
              volumeLocked ? 'bg-zinc-600' : 'bg-zinc-400 group-hover:bg-white'
            }`}
            style={{ width: `${volume * 100}%` }}
          />
        </div>
        <EQPanel />
        <SignalPathPanel />
        <AudioOutputSelector />
      </div>
    </div>
  )
}
