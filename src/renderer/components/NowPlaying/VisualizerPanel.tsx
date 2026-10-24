import { ChevronLeft, ChevronRight, ExternalLink, Maximize, Minimize, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { VisualizerPlaybackState } from '../../../../electron/main/nowPlaying/visualizerState'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { BcVisualizer, BcStatic } from 'butterchurn'
import type { BcPresetsStatic } from 'butterchurn-presets'
import butterchurnRaw from 'butterchurn'
import butterchurnPresetsRaw from 'butterchurn-presets'
import { usePlayerStore } from '../../../store/playerStore'
import { useVisualizerStore } from '../../../store/visualizerStore'
import { preparePreset } from '../../visualizer/presets'
import { installReactivityControl } from '../../visualizer/reactivity'
import { VisualizerAudioWindow, setAnalysisSampleRate } from '../../visualizer/audio'
import { useWindowActivity } from '../../../services/windowActivity'

// Normalize CJS interop: Vite may leave the module as { default: X } or unwrap it
const bc: BcStatic = (butterchurnRaw.default ?? butterchurnRaw) as BcStatic
const bcPresets: BcPresetsStatic = (butterchurnPresetsRaw.default ?? butterchurnPresetsRaw) as BcPresetsStatic

interface VisualizerPanelProps {
  /** Shown above the canvas when not fullscreen; omit for none. */
  header?: ReactNode
  isPlaying: boolean
  ambientColor: { r: number; g: number; b: number }
  vizFullscreen: boolean
  onToggleVizFullscreen: () => void
  active?: boolean
  standalone?: boolean
}

// Butterchurn's internal AudioProcessor — used for direct PCM injection
interface BcAudioProcessor {
  sampleAudio(): void
  updateAudio(center: Uint8Array, left: Uint8Array, right: Uint8Array): void
}

const BUILTIN_PRESET_MAP = bcPresets.getPresets()
/** 30 fps while another app has focus. */
const UNFOCUSED_FRAME_MS = 1000 / 30


export default function VisualizerPanel({
  header,
  vizFullscreen,
  onToggleVizFullscreen,
  active = true,
  standalone,
}: VisualizerPanelProps) {
  // Nothing to draw for while the window is out of sight. With another app
  // focused, the panel drops to 30 fps; a detached window keeps its full rate
  // because it is usually watched beside other apps.
  const windowActivity = useWindowActivity()
  const running = active && windowActivity !== 'hidden'
  const minFrameMs = windowActivity === 'unfocused' && !standalone ? UNFOCUSED_FRAME_MS : 0
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const vizRef = useRef<BcVisualizer | null>(null)
  const audioProcessorRef = useRef<BcAudioProcessor | null>(null)
  const rafRef = useRef<number | null>(null)
  const pollRef = useRef<number | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)

  const customPresets = useVisualizerStore((s) => s.customPresets)
  const cycleInterval = useVisualizerStore((s) => s.cycleInterval)
  const randomize = useVisualizerStore((s) => s.randomize)
  const brightness = useVisualizerStore((s) => s.brightness)
  const showFps = useVisualizerStore((s) => s.showFps)
  const presetMap = useMemo(() => ({ ...BUILTIN_PRESET_MAP, ...customPresets }), [customPresets])
  const presetNames = useMemo(() => Object.keys(presetMap).sort(), [presetMap])

  const audioWindowRef = useRef(new VisualizerAudioWindow())
  const analysisRateRef = useRef(0)

  const [selectedPreset, setSelectedPreset] = useState(() => presetNames[Math.floor(Math.random() * presetNames.length)] ?? '')
  const [loadedPreset, setLoadedPreset] = useState('')
  const [presetError, setPresetError] = useState<string | null>(null)
  const [hoveringControls, setHoveringControls] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const loadedPresetRef = useRef<{ name: string; source: unknown } | null>(null)
  const renderErrorRef = useRef(false)
  const fpsSampleRef = useRef({ startedAt: 0, frames: 0 })
  const [fps, setFps] = useState<number | null>(null)

  useEffect(() => {
    fpsSampleRef.current = { startedAt: performance.now(), frames: 0 }
    setFps(null)
  }, [showFps, running, isReady])

  // History stack for prev/next random navigation
  const historyRef = useRef<string[]>([selectedPreset])
  const histPosRef = useRef(0)

  const advancePreset = useCallback((useHistory: boolean) => {
    if (presetNames.length <= 1) return
    if (useHistory) {
      while (histPosRef.current < historyRef.current.length - 1) {
        const name = historyRef.current[++histPosRef.current]
        if (presetNames.includes(name)) { setSelectedPreset(name); return }
      }
    }
    const current = historyRef.current[histPosRef.current]
    const index = Math.max(0, presetNames.indexOf(current))
    // Pick from every entry except the current preset without a retry loop.
    const nextIndex = randomize
      ? (index + 1 + Math.floor(Math.random() * (presetNames.length - 1))) % presetNames.length
      : (index + 1) % presetNames.length
    const name = presetNames[nextIndex]
    historyRef.current = historyRef.current.slice(0, histPosRef.current + 1)
    historyRef.current.push(name)
    histPosRef.current = historyRef.current.length - 1
    setSelectedPreset(name)
  }, [presetNames, randomize])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    let cancelled = false
    let scaleResizeTimer: ReturnType<typeof setTimeout> | undefined
    // Match Butterchurn's context attributes and query limits before allocating
    // scaled render targets, including when a saved scale is applied at startup.
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
    })
    if (!gl) { setPresetError('WebGL 2 is unavailable.'); return }
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    const maxTexture = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE))
    const maxWidth = Math.min(maxTexture, viewport[0])
    const maxHeight = Math.min(maxTexture, viewport[1])

    const sizeCanvas = () => {
      const w = parent.clientWidth
      const h = parent.clientHeight
      const dpr = window.devicePixelRatio || 1
      const scale = useVisualizerStore.getState().renderScale
      const requestedWidth = Math.max(1, w * dpr * scale)
      const requestedHeight = Math.max(1, h * dpr * scale)
      const fit = Math.min(1, maxWidth / requestedWidth, maxHeight / requestedHeight)
      const pw = Math.max(1, Math.floor(requestedWidth * fit))
      const ph = Math.max(1, Math.floor(requestedHeight * fit))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
        const viz = vizRef.current
        if (viz) {
          // Butterchurn 2.x replaces this texture on resize without freeing it.
          // A live scale slider would otherwise retain every intermediate size.
          const renderer = (viz as unknown as { renderer: { targetTexture: WebGLTexture } }).renderer
          const oldTexture = renderer.targetTexture
          viz.setRendererSize(pw, ph)
          if (renderer.targetTexture !== oldTexture) gl.deleteTexture(oldTexture)
        }
      }
    }
    sizeCanvas()

    // Minimal AudioContext — butterchurn needs one to initialize its WebGL
    // renderer, but we bypass its Web Audio analyser entirely.
    const audioCtx = new AudioContext()

    // — Butterchurn —
    const viz = bc.createVisualizer(audioCtx, canvas, {
      width: canvas.width,
      height: canvas.height,
      // Width/height already include Retina and render scaling, including on resize.
      // Butterchurn multiplies its texture dimensions by pixelRatio again.
      pixelRatio: 1,
      meshWidth: 32,
      meshHeight: 24,
    })
    vizRef.current = viz
    analysisRateRef.current = 0
    audioWindowRef.current.silence()

    // Disable butterchurn's internal sampleAudio() so it doesn't overwrite
    // the PCM we inject via updateAudio() on every frame.
    const audio = (viz as unknown as { audio: BcAudioProcessor }).audio
    audio.sampleAudio = () => {}
    audioProcessorRef.current = audio
    const restoreReactivity = installReactivityControl(
      viz as unknown as Parameters<typeof installReactivityControl>[0],
      () => useVisualizerStore.getState().reactivity,
    )

    setIsReady(true)

    // — ResizeObserver —
    const ro = new ResizeObserver(() => { if (!cancelled) sizeCanvas() })
    ro.observe(parent)
    roRef.current = ro
    const unsubscribeScale = useVisualizerStore.subscribe((state, previous) => {
      if (state.renderScale === previous.renderScale) return
      clearTimeout(scaleResizeTimer)
      // Coalesce dragging events to avoid repeatedly reallocating large textures.
      scaleResizeTimer = setTimeout(() => { if (!cancelled) sizeCanvas() }, 100)
    })

    return () => {
      cancelled = true
      unsubscribeScale()
      clearTimeout(scaleResizeTimer)
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current)
      roRef.current?.disconnect()
      restoreReactivity()
      void audioCtx.close()
      audioProcessorRef.current = null
      vizRef.current = null
      loadedPresetRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!running || !isReady) return

    let cancelled = false
    let lastRenderAt = 0

    const syncFrame = async () => {
      try {
        const frame = await window.puros.audio.getVisualizerFrame()
        if (cancelled) return
        audioWindowRef.current.accept(frame, performance.now())
      } catch { /* engine not ready; the last window expires to silence */ }
      finally {
        if (!cancelled) pollRef.current = window.setTimeout(() => { void syncFrame() }, Math.max(20, minFrameMs))
      }
    }

    void syncFrame()

    const render = () => {
      if (cancelled) return

      const viz = vizRef.current
      const audio = audioProcessorRef.current
      if (!viz || !audio) return

      const frameStart = performance.now()
      // A little slack so a 60 Hz display lands on every second frame.
      if (minFrameMs > 0 && frameStart - lastRenderAt < minFrameMs - 2) {
        rafRef.current = window.requestAnimationFrame(render)
        return
      }
      lastRenderAt = frameStart

      const pcm = audioWindowRef.current
      pcm.expire(performance.now())
      if (!renderErrorRef.current) {
        try {
          if (pcm.sampleRate > 0 && pcm.sampleRate !== analysisRateRef.current) {
            const levels = (viz as unknown as { renderer: { audioLevels: Parameters<typeof setAnalysisSampleRate>[0] } }).renderer.audioLevels
            setAnalysisSampleRate(levels, pcm.sampleRate)
            analysisRateRef.current = pcm.sampleRate
          }
          audio.updateAudio(pcm.center, pcm.left, pcm.right)
          viz.render()
          if (useVisualizerStore.getState().showFps) fpsSampleRef.current.frames++
        } catch (error) {
          // Keep requestAnimationFrame alive so another preset can recover.
          renderErrorRef.current = true
          console.error('Visualizer render failed', error)
          setPresetError('Unable to render this preset. Choose another preset.')
        }
      }

      if (useVisualizerStore.getState().showFps) {
        const now = performance.now()
        const sample = fpsSampleRef.current
        const elapsed = now - sample.startedAt
        // Measure completed renders, including preset-loading stalls. Update
        // the UI twice a second instead of causing a React render every frame.
        if (elapsed >= 500) {
          setFps(Math.round(sample.frames * 1000 / elapsed))
          fpsSampleRef.current = { startedAt: now, frames: 0 }
        }
      }

      rafRef.current = window.requestAnimationFrame(render)
    }
    rafRef.current = window.requestAnimationFrame(render)

    return () => {
      cancelled = true
      if (pollRef.current !== null) {
        window.clearTimeout(pollRef.current)
        pollRef.current = null
      }
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [running, isReady, minFrameMs])

  // Auto-advance only while the visualizer is visible and ready.
  useEffect(() => {
    if (!running || !isReady) return
    const id = window.setInterval(() => advancePreset(false), cycleInterval * 1000)
    return () => window.clearInterval(id)
  }, [running, isReady, cycleInterval, advancePreset])

  // Use the same loading path for initial, manual, automatic and custom presets.
  useEffect(() => {
    const viz = vizRef.current
    if (!isReady || !viz) return
    const name = presetNames.includes(selectedPreset) ? selectedPreset : presetNames[0]
    if (!name) return
    if (name !== selectedPreset) { setSelectedPreset(name); return }
    const source = presetMap[name]
    if (loadedPresetRef.current?.name === name && loadedPresetRef.current.source === source) return
    try {
      viz.loadPreset(preparePreset(source), loadedPresetRef.current && !renderErrorRef.current ? 2 : 0)
      loadedPresetRef.current = { name, source }
      renderErrorRef.current = false
      setLoadedPreset(name)
      setPresetError(null)
    } catch (error) {
      console.error(`Unable to load visualizer preset "${name}"`, error)
      // loadPreset can fail during init after modifying Butterchurn's state.
      // Restore the last successful preset so the canvas stays usable.
      const previous = loadedPresetRef.current
      if (previous) {
        try {
          viz.loadPreset(preparePreset(previous.source), 0)
          renderErrorRef.current = false
        } catch (restoreError) {
          console.error('Unable to restore visualizer preset', restoreError)
        }
      }
      setPresetError(`Unable to load "${name}". Choose another preset.`)
    }
  }, [isReady, presetMap, presetNames, selectedPreset])

  // Show song title banner whenever the track changes
  const localIsPlaying = usePlayerStore(s => s.isPlaying)
  const localTogglePlayPause = usePlayerStore(s => s.togglePlayPause)
  const localNext = usePlayerStore(s => s.next)
  const localPrevious = usePlayerStore(s => s.previous)
  const localTrack = usePlayerStore(s => s.currentTrack)
  const [remotePlayback, setRemotePlayback] = useState<VisualizerPlaybackState>({ track: null, isPlaying: false })
  useEffect(() => {
    if (!standalone) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const state = await window.puros.player.getVisualizerState()
        if (!cancelled) setRemotePlayback(state)
      } catch { /* main window is starting or closing */ }
      finally { if (!cancelled) timer = setTimeout(() => { void refresh() }, 250) }
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [standalone])
  const command = (name: 'play-pause' | 'next' | 'previous') => {
    void window.puros.player.visualizerCommand(name).catch(error => console.error('Playback command failed', error))
  }
  const isPlaying = standalone ? remotePlayback.isPlaying : localIsPlaying
  const currentTrack = standalone ? remotePlayback.track : localTrack
  const togglePlayPause = standalone ? () => command('play-pause') : localTogglePlayPause
  const next = standalone ? () => command('next') : localNext
  const previous = standalone ? () => command('previous') : localPrevious
  const prevTrackId = useRef<string | null>(null)
  useEffect(() => {
    if (!isReady) return
    if (!currentTrack) { prevTrackId.current = null; return }
    // Use id or a composite key so we fire only on actual track change
    const id = currentTrack.id ?? `${currentTrack.title}-${currentTrack.artist}`
    if (id === prevTrackId.current) return
    prevTrackId.current = id

    const parts = [currentTrack.artist, currentTrack.title].filter(Boolean)
    const label = parts.length > 0 ? parts.join(' — ') : 'Unknown'
    vizRef.current?.launchSongTitleAnim(label)
  }, [currentTrack, isReady])

  const prevPreset = () => {
    while (histPosRef.current > 0) {
      const name = historyRef.current[--histPosRef.current]
      if (presetNames.includes(name)) { setSelectedPreset(name); return }
    }
  }

  const nextPreset = () => advancePreset(true)
  const presetName = loadedPreset.trim()

  // Single JSX tree — canvas must never unmount or the WebGL context is lost.
  // Fullscreen is toggled by changing only the root div's className.
  return (
    <div
      className={
        vizFullscreen
          ? 'fixed inset-0 z-60 flex flex-col bg-black'
          : 'relative flex h-full flex-col overflow-hidden rounded-[30px] bg-black/40 shadow-[0_30px_90px_rgba(0,0,0,0.5)]'
      }
    >
      {/* Header — hidden in fullscreen */}
      {!vizFullscreen && header ? (
        <div className="border-b border-white/8 px-6 py-4">{header}</div>
      ) : null}

      {/* Canvas area */}
      <div className="relative flex-1 overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ filter: `brightness(${brightness})` }} />

        {showFps && running && (
          <span
            className="pointer-events-none absolute right-4 top-4 select-none rounded-md bg-black/65 px-2 py-1 font-mono text-xs tabular-nums text-white/85"
            aria-label="Visualizer frames per second"
          >
            {fps === null ? '—' : fps} FPS
          </span>
        )}

        {/* Gradient scrim — hidden in fullscreen until hover */}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 to-transparent transition-opacity duration-300 ${
            vizFullscreen ? 'h-28' : 'h-16'
          }`}
          style={vizFullscreen ? { opacity: hoveringControls ? 1 : 0 } : undefined}
        />

        {/* Bottom hover zone + bar — in fullscreen only the bottom strip triggers visibility */}
        <div
          className={`absolute inset-x-0 bottom-0 ${vizFullscreen ? 'h-28' : ''}`}
          onMouseEnter={() => vizFullscreen && setHoveringControls(true)}
          onMouseLeave={() => vizFullscreen && setHoveringControls(false)}
        >
        <div
          className={`absolute inset-x-0 bottom-0 flex items-center gap-1 transition-opacity duration-300 ${
            vizFullscreen ? 'px-4 pb-5' : 'px-3 pb-3'
          }`}
          style={vizFullscreen ? { opacity: hoveringControls ? 1 : 0 } : undefined}
        >
          <button
            onClick={prevPreset}
            className={`flex shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white/90 ${vizFullscreen ? 'h-8 w-8' : 'h-7 w-7'}`}
            aria-label="Previous preset"
          >
            <ChevronLeft size={12} />
          </button>

          <span
            className={`flex-1 cursor-default select-none truncate text-center text-white/40 ${vizFullscreen ? 'text-xs' : 'text-[11px]'}`}
            title={presetError ?? presetName}
            role={presetError ? 'status' : undefined}
          >
            {presetError ?? presetName}
          </span>

          <button
            onClick={nextPreset}
            className={`flex shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white/90 ${vizFullscreen ? 'h-8 w-8' : 'h-7 w-7'}`}
            aria-label="Next preset"
          >
            <ChevronRight size={12} />
          </button>

          {/* Track controls — fullscreen only */}
          {vizFullscreen && (
            <div className="ml-4 flex items-center gap-1 border-l border-white/10 pl-4">
              <button
                onClick={previous}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white/90"
                aria-label="Previous track"
              >
                <SkipBack size={14} fill="currentColor" />
              </button>
              <button
                onClick={togglePlayPause}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? (
                  <Pause size={14} fill="currentColor" />
                ) : (
                  <Play size={14} fill="currentColor" />
                )}
              </button>
              <button
                onClick={next}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white/90"
                aria-label="Next track"
              >
                <SkipForward size={14} fill="currentColor" />
              </button>
            </div>
          )}

          {!standalone && (
            <button
              onClick={onToggleVizFullscreen}
              className={`flex shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white/90 ${vizFullscreen ? 'ml-2 h-8 w-8' : 'ml-1 h-7 w-7'}`}
              aria-label={vizFullscreen ? 'Exit fullscreen visualizer' : 'Fullscreen visualizer'}
              title={vizFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            >
              {vizFullscreen ? (
                <Minimize className="h-3.5 w-3.5" />
              ) : (
                <Maximize className="h-3.5 w-3.5" />
              )}
            </button>
          )}

          {!standalone && (
            <button
              onClick={() => void window.puros.app.openVisualizerWindow()}
              className={`flex shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white/90 ${vizFullscreen ? 'h-8 w-8' : 'h-7 w-7'}`}
              aria-label="Detach visualizer"
              title="Open in separate window"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
