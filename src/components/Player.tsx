/**
 * Player component — floating capsule bar laid out like the macOS / iOS 27
 * mini player: transport on the left, track info with a hairline progress bar
 * in the middle, output controls on the right. Format badges are opt-in.
 */

import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from 'lucide-react'
import { getTrackIdentity, usePlayerStore } from '../store/playerStore'
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
import VolumePopover from './VolumePopover'
import { resolveArtwork } from '../utils/artworkColor'
import { isLiveRadioTrack } from '../services/liveRadio/track'
import { describeVolumeControl, formatDecibels, volumeDecibels } from '../services/volumeControl'
import { useLiquidGlass } from './useLiquidGlass'
import { BAR_BLUR, BAR_TINT, GLASS_SATURATION } from './GlassPanel'
import WaveformSeekBar, { useWaveform } from './WaveformSeekBar'

interface PlayerProps {
  onOpenNowPlaying?: () => void
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
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
    playbackSource,
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
  const showPlayerBadges = useSettingsStore((s) => s.showPlayerBadges)
  const showStreamingBadge = useSettingsStore((s) => s.playerTags.streamingStatus)
  const seekBarStyle = useSettingsStore((s) => s.seekBarStyle)
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubPos, setScrubPos] = useState(0)
  const [hoverFraction, setHoverFraction] = useState<number | null>(null)
  const scrubBarRef = useRef<HTMLDivElement>(null)
  const lastAudibleVolumeRef = useRef(volume > 0 ? volume : 1)
  const barRef = useRef<HTMLDivElement>(null)
  // A slim capsule like the macOS / iOS 27 mini player.
  const barHeight = seekBarStyle === 'waveform' ? 80 : 64
  const cornerRadius = barHeight / 2
  const artworkSize = seekBarStyle === 'waveform' ? 56 : 44
  const glass = useLiquidGlass(barRef, { radius: cornerRadius, blur: BAR_BLUR, saturation: GLASS_SATURATION })
  const volumeLocked = volumeControl.effective === 'fixed'
  const volumeTitle = describeVolumeControl(volumeControl, volume)
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
  const waveformRequested = seekBarStyle === 'waveform' && !!currentTrack && !liveRadioActive
  const currentTrackIdentity = getTrackIdentity(currentTrack)
  const waveform = useWaveform(
    playbackSource?.trackIdentity === currentTrackIdentity ? playbackSource : null,
    currentTrack?.duration ?? duration,
    waveformRequested,
  )
  // Falls back to the plain bar when the file cannot be analysed.
  const showWaveform = waveformRequested && !waveform.data.failed
  const artworkSrc = resolveArtwork(currentTrack)
  const currentTrackProvider = String(currentTrack?.provider ?? currentTrack?.sourceType ?? '').trim().toLowerCase()
  const activeStreamIds = [
    currentTrack?.streamId,
    ...(currentTrack?.fallbackStreamIds ?? []),
  ].filter((value): value is string => !!value)
  const growingSession = playbackPreparationService.getActiveGrowingSession()
  const showStreamingStatus =
    showPlayerBadges
    && showStreamingBadge
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

  const fractionFromEvent = (e: React.PointerEvent) => {
    const rect = scrubBarRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }
  const posFromEvent = (e: React.PointerEvent) => fractionFromEvent(e) * duration

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


  const scrubHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (liveRadioActive) return
      if (!duration) return
      e.currentTarget.setPointerCapture(e.pointerId)
      const pos = posFromEvent(e)
      setScrubbing(true)
      setScrubPos(pos)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (liveRadioActive) return
      if (showWaveform && duration > 0) setHoverFraction(fractionFromEvent(e))
      if (!scrubbing) return
      setScrubPos(posFromEvent(e))
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (liveRadioActive) return
      if (!scrubbing) return
      setScrubbing(false)
      seek(posFromEvent(e))
    },
    onPointerCancel: () => setScrubbing(false),
    onPointerLeave: () => setHoverFraction(null),
  }

  // Extras stay hidden until the pointer is over the track info, like Apple Music.
  const revealOnHover = 'opacity-0 transition-opacity duration-200 group-hover/lcd:opacity-100'

  return (
    <div
      ref={barRef}
      className="relative z-40 grid grid-cols-[1fr_minmax(0,40rem)_1fr] items-center gap-4 border border-transparent px-3"
      style={{
        // The waveform needs a taller row than the hairline progress bar.
        height: barHeight,
        borderRadius: cornerRadius,
        ...glass.style,
        // Tinted with the app background (black) so it blends in over the
        // page instead of shifting its colour.
        background: `rgba(0, 0, 0, ${BAR_TINT})`,
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 12px 40px rgba(0, 0, 0, 0.45)',
      }}
    >
      {glass.layers}

      {/* Transport controls */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={toggleShuffle}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            shuffle ? 'text-accent-400 bg-accent-400/15' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
          }`}
          title="Shuffle"
        >
          <Shuffle className="h-[15px] w-[15px]" />
        </button>
        <button
          onClick={previous}
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-200 transition-colors hover:bg-white/[0.06] hover:text-white"
          title="Previous"
        >
          <SkipBack className="h-[18px] w-[18px]" fill="currentColor" />
        </button>
        <button
          onClick={togglePlayPause}
          className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-[background-color,transform] hover:bg-white/[0.06] active:scale-95"
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <Pause className="h-6 w-6" fill="currentColor" strokeWidth={1} />
          ) : (
            <Play className="h-6 w-6 translate-x-px" fill="currentColor" strokeWidth={1} />
          )}
        </button>
        <button
          onClick={next}
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-200 transition-colors hover:bg-white/[0.06] hover:text-white"
          title="Next"
        >
          <SkipForward className="h-[18px] w-[18px]" fill="currentColor" />
        </button>
        <button
          onClick={cycleRepeat}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            repeat !== 'off' ? 'text-accent-400 bg-accent-400/15' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
          }`}
          title={`Repeat: ${repeat}`}
        >
          {repeat === 'one' ? <Repeat1 className="h-[15px] w-[15px]" /> : <Repeat className="h-[15px] w-[15px]" />}
        </button>
      </div>

      {/* Track info — artwork, title, artist — album, hairline progress */}
      <div className="group/lcd flex min-w-0 items-center gap-3">
        <button
          onClick={() => {
            if (!currentTrack) return
            onOpenNowPlaying?.()
          }}
          disabled={!currentTrack}
          className="shrink-0 rounded-[6px] transition-transform hover:scale-[1.04] disabled:cursor-default disabled:hover:scale-100"
          title={currentTrack ? 'Open now playing' : undefined}
        >
          <ArtworkThumbnail src={artworkSrc} size={artworkSize} />
        </button>
        {/* With a waveform the column matches the artwork, so the waveform ends level with its bottom edge. */}
        <div
          className={`min-w-0 flex-1 ${showWaveform ? 'flex flex-col' : ''}`}
          style={showWaveform ? { height: artworkSize } : undefined}
        >
          {currentTrack ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-[13px] font-semibold text-zinc-100">
                  {currentTrack.title}
                </p>
                {showPlayerBadges && (
                  <FormatBadges
                    className="shrink-0 flex-nowrap"
                    formatInfo={formatInfo}
                    outputMode={outputMode}
                    deviceName={deviceName}
                    playbackDecision={playbackDecision}
                    bluetoothInfo={audioDevice === '__default__' ? bluetoothInfo : null}
                  />
                )}
                {showStreamingStatus ? (
                  <span
                    className="shrink-0 rounded-full border border-accent-400/25 bg-accent-400/10 px-2 py-0.5 text-[10px] font-medium text-accent-300"
                    title={`${Math.round(streamingStatus?.percent ?? 0)}% cached`}
                  >
                    {streamingStatusLabel}
                  </span>
                ) : null}
                {playbackContext?.label ? (
                  canOpenPlaybackContext ? (
                    <button
                      className="ml-auto shrink-0 max-w-[40%] truncate pl-2 text-[11px] text-zinc-500 opacity-0 transition-[color,opacity] group-hover/lcd:opacity-100 hover:text-zinc-300"
                      onClick={() => openPlaybackContext()}
                      title={playbackContext.label}
                    >
                      {playbackContext.label}
                    </button>
                  ) : (
                    <span
                      className="ml-auto shrink-0 max-w-[40%] truncate pl-2 text-[11px] text-zinc-500 opacity-0 transition-opacity group-hover/lcd:opacity-100"
                      title={playbackContext.label}
                    >
                      {playbackContext.label}
                    </span>
                  )
                ) : null}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
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
                <span
                  className={`ml-auto shrink-0 pl-2 text-[11px] tabular-nums ${
                    liveRadioActive ? 'font-medium text-red-400' : `text-zinc-500 ${scrubbing ? '' : revealOnHover}`
                  }`}
                >
                  {liveRadioActive
                    ? 'LIVE'
                    : `${formatTime(displayPosition)} / ${formatTime(duration)}`}
                </span>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-zinc-500">Not Playing</p>
          )}

          {/* Progress — a hairline under the text, aligned with it */}
          {currentTrack && (
            <div
              ref={scrubBarRef}
              className={`group/seek relative ${showWaveform ? 'mt-1 min-h-0 flex-1' : 'mt-0.5 flex h-3 items-center'} ${
                liveRadioActive ? 'cursor-default' : 'cursor-pointer'
              }`}
              {...scrubHandlers}
            >
              {showWaveform ? (
                <WaveformSeekBar
                  data={waveform.data}
                  revision={waveform.revision}
                  duration={duration}
                  fraction={progress / 100}
                  hoverFraction={scrubbing ? null : hoverFraction}
                />
              ) : (
                <div
                  className={`relative h-[3px] w-full overflow-hidden rounded-full transition-[height] group-hover/seek:h-[5px] ${
                    liveRadioActive ? 'bg-red-500/25' : 'bg-white/[0.12]'
                  }`}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-zinc-300 transition-colors group-hover/seek:bg-white"
                    style={{ width: `${liveRadioActive ? 0 : progress}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Signal path, EQ, output, volume */}
      <div className="flex items-center justify-end gap-1">
        <SignalPathPanel />
        <EQPanel />
        <AudioOutputSelector />
        <VolumePopover
          volume={volume}
          onVolumeChange={setVolume}
          onToggleMute={handleToggleMute}
          locked={volumeLocked}
          description={volumeTitle ?? null}
          decibels={formatDecibels(volumeDecibels(volumeControl, volume)) || null}
        />
      </div>
    </div>
  )
}
