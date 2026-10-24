/**
 * Roon-style waveform seek bar: the playing file's loudness envelope as
 * mirrored bars, played part tinted, with a red playhead. Bars rise from a
 * baseline as the background analysis delivers them, so a streamed track's
 * waveform fills in alongside its download.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { PlaybackSource } from '../store/playerStore'
import { hexToRgb, useAccentStore } from '../utils/accentColor'

/**
 * Hairline bars on a fixed whole-pixel pitch, as in Roon: dense enough to read
 * as texture, and never stretched to fill the width, since a fractional pitch
 * would land bar edges between device pixels and blur them unevenly.
 */
const BAR_WIDTH = 1
const BAR_GAP = 1
const BAR_STEP = BAR_WIDTH + BAR_GAP
/** Height of a bar with no data yet, in CSS px. */
const BASELINE_HEIGHT = 1
/** Time constant of a bar easing towards its height. */
const EASE_MS = 260
/** Delay between neighbouring bars appearing in the same batch. */
const STAGGER_MS = 5
/** Quietest loudness the tallest bar may represent, so near-silence stays flat. */
const MIN_REFERENCE = 0.04
/** Length of audio each bar summarises, around its centre. */
const SAMPLE_WINDOW_SECONDS = 0.4

// Played bars use the app's accent (a gradient across the bar when the accent
// is one); the playhead is a lighter tint of its end colour.
const COLOR_UNPLAYED = 'rgba(255, 255, 255, 0.34)'
const COLOR_BASELINE = 'rgba(255, 255, 255, 0.16)'
const COLOR_HOVER = 'rgba(255, 255, 255, 0.55)'

const CANVAS_STYLE: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }

export interface WaveformData {
  trackIdentity: string | null
  binSeconds: number
  /** Loudness (RMS) per bin; holes are bins not analysed yet. */
  bins: number[]
  done: boolean
  failed: boolean
}

function emptyWaveform(trackIdentity: string | null): WaveformData {
  return { trackIdentity, binSeconds: 0.1, bins: [], done: false, failed: false }
}

/** Bins of roughly 1/1500 of the track keep any bar width well resolved. */
function binSecondsFor(durationSeconds: number): number {
  if (!(durationSeconds > 0)) return 0.1
  return Math.round(Math.min(0.5, Math.max(0.02, durationSeconds / 1500)) * 100) / 100
}

/**
 * Streams the waveform of `source` from the main process. Returns a stable
 * data object (mutated in place) and a revision that changes with it.
 */
export function useWaveform(
  source: PlaybackSource | null,
  trackDurationSeconds: number,
  enabled: boolean,
): { data: WaveformData; revision: number } {
  const dataRef = useRef<WaveformData>(emptyWaveform(null))
  const requestIdRef = useRef<string | null>(null)
  const [revision, setRevision] = useState(0)

  const active = enabled && source ? source : null
  const requestKey = active
    ? [active.trackIdentity, active.path, active.startSeconds, active.durationSeconds ?? ''].join('|')
    : null
  const binSeconds = binSecondsFor(active?.durationSeconds ?? trackDurationSeconds)
  // The bin size is fixed per track; a duration arriving later must not restart the analysis.
  const binSecondsRef = useRef({ trackIdentity: null as string | null, binSeconds })
  if (binSecondsRef.current.trackIdentity !== (active?.trackIdentity ?? null)) {
    binSecondsRef.current = { trackIdentity: active?.trackIdentity ?? null, binSeconds }
  }

  useEffect(() => {
    if (!active || !requestKey) {
      requestIdRef.current = null
      return
    }
    // A finished download may move the file: keep the bars shown so far and
    // let the new pass overwrite them in place.
    if (dataRef.current.trackIdentity !== active.trackIdentity) {
      dataRef.current = emptyWaveform(active.trackIdentity)
    } else {
      dataRef.current.done = false
      dataRef.current.failed = false
    }
    setRevision((value) => value + 1)

    const requestId = globalThis.crypto.randomUUID()
    requestIdRef.current = requestId
    const unsubscribe = window.puros.audio.onWaveformChunk((chunk) => {
      if (chunk.requestId !== requestId) return
      const data = dataRef.current
      data.binSeconds = chunk.binSeconds
      for (let i = 0; i < chunk.bins.length; i++) data.bins[chunk.offset + i] = chunk.bins[i]
      if (chunk.done) {
        data.done = true
        data.failed = !!chunk.error && data.bins.length === 0
      }
      setRevision((value) => value + 1)
    })
    void window.puros.audio.startWaveform(requestId, {
      path: active.path,
      growing: active.growing,
      startSeconds: active.startSeconds,
      durationSeconds: active.durationSeconds,
      binSeconds: binSecondsRef.current.binSeconds,
    }).then((started) => {
      if (started || requestIdRef.current !== requestId) return
      dataRef.current.failed = true
      setRevision((value) => value + 1)
    }).catch(() => {
      // No analysis available (e.g. a main process without the handler): plain bar.
      if (requestIdRef.current !== requestId) return
      dataRef.current.failed = true
      setRevision((value) => value + 1)
    })

    return () => {
      unsubscribe()
      if (requestIdRef.current === requestId) requestIdRef.current = null
      void window.puros.audio.cancelWaveform(requestId).catch(() => undefined)
    }
    // The request key covers every field of `active` the analysis reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  const growing = active?.growing ?? false
  useEffect(() => {
    const requestId = requestIdRef.current
    if (!growing && requestId) void window.puros.audio.finishWaveformSource(requestId).catch(() => undefined)
  }, [growing, requestKey])

  return { data: dataRef.current, revision }
}

interface WaveformSeekBarProps {
  data: WaveformData
  revision: number
  /** Seconds covered by the bar. */
  duration: number
  /** Playhead position, 0–1. */
  fraction: number
  /** Pointer position while hovering, 0–1. */
  hoverFraction: number | null
}

interface BarState {
  trackIdentity: string | null
  columns: number
  heights: Float32Array
  /** performance.now() at which a bar starts rising; 0 while it has no data. */
  appearAt: Float64Array
}

export default function WaveformSeekBar({ data, revision, duration, fraction, hoverFraction }: WaveformSeekBarProps) {
  const accentFrom = useAccentStore((state) => state.from)
  const accentTo = useAccentStore((state) => state.to)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const barsRef = useRef<BarState>({
    trackIdentity: null,
    columns: 0,
    heights: new Float32Array(0),
    appearAt: new Float64Array(0),
  })
  const frameRef = useRef<number | null>(null)
  const lastFrameRef = useRef(0)
  const propsRef = useRef({ data, duration, fraction, hoverFraction, size })
  propsRef.current = { data, duration, fraction, hoverFraction, size }

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }))
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const rgba = (hex: string, alpha: number) => {
      const { r, g, b } = hexToRgb(hex)
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }
    const playhead = hexToRgb(accentTo)
    const colorPlayhead = `rgb(${[playhead.r, playhead.g, playhead.b].map((channel) => Math.round(channel + (255 - channel) * 0.45)).join(', ')})`
    const draw = (now: number) => {
      frameRef.current = null
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      const { data, duration, fraction, hoverFraction, size } = propsRef.current
      if (!canvas || !ctx || size.width <= 0 || size.height <= 0) return

      const dpr = window.devicePixelRatio || 1
      const pixelWidth = Math.round(size.width * dpr)
      const pixelHeight = Math.round(size.height * dpr)
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.width, size.height)

      // A gradient accent runs across the whole bar, so colours stay put as the playhead moves.
      const colorPlayed = ctx.createLinearGradient(0, 0, size.width, 0)
      colorPlayed.addColorStop(0, rgba(accentFrom, 0.95))
      colorPlayed.addColorStop(1, rgba(accentTo, 0.95))

      const columns = Math.max(1, Math.floor((size.width + BAR_GAP) / BAR_STEP))
      const bars = barsRef.current
      if (bars.columns !== columns || bars.trackIdentity !== data.trackIdentity) {
        const resized = bars.trackIdentity === data.trackIdentity
        const previousHeights = bars.heights
        const previousColumns = bars.columns
        bars.trackIdentity = data.trackIdentity
        bars.columns = columns
        bars.heights = new Float32Array(columns)
        bars.appearAt = new Float64Array(columns)
        // A resize keeps the current shape instead of replaying the reveal.
        if (resized && previousColumns > 0) {
          for (let c = 0; c < columns; c++) {
            bars.heights[c] = previousHeights[Math.min(previousColumns - 1, Math.floor((c / columns) * previousColumns))]
            bars.appearAt[c] = bars.heights[c] > 0 ? 1 : 0
          }
        }
      }

      // Target height per column: the loudness of a short window at its centre,
      // against the loudest column. A short window keeps the beat-to-beat
      // variation a whole-column maximum would flatten out.
      const targets = new Float32Array(columns).fill(-1)
      const binsPerColumn = duration > 0 ? duration / data.binSeconds / columns : 0
      const windowBins = Math.max(1, Math.round(SAMPLE_WINDOW_SECONDS / data.binSeconds))
      let reference = MIN_REFERENCE
      if (binsPerColumn > 0) {
        for (let c = 0; c < columns; c++) {
          const centre = Math.floor((c + 0.5) * binsPerColumn)
          const first = Math.max(0, centre - (windowBins >> 1))
          const last = Math.min(data.bins.length, first + windowBins)
          let sum = 0
          let count = 0
          for (let b = first; b < last; b++) {
            const value = data.bins[b]
            if (value === undefined) continue
            sum += value
            count++
          }
          if (count === 0) continue
          targets[c] = sum / count
          if (targets[c] > reference) reference = targets[c]
        }
      }

      const dt = lastFrameRef.current ? Math.min(100, now - lastFrameRef.current) : 16
      lastFrameRef.current = now
      const ease = 1 - Math.exp(-dt / EASE_MS)
      let nextAppear = now
      let animating = false
      for (let c = 0; c < columns; c++) {
        if (targets[c] < 0) continue
        if (bars.appearAt[c] === 0) {
          bars.appearAt[c] = nextAppear
          nextAppear += STAGGER_MS
        }
        if (now < bars.appearAt[c]) {
          animating = true
          continue
        }
        const target = Math.pow(targets[c] / reference, 1.4)
        const delta = target - bars.heights[c]
        if (Math.abs(delta) > 0.002) {
          bars.heights[c] += delta * ease
          animating = true
        } else {
          bars.heights[c] = target
        }
      }

      const middle = size.height / 2
      const playedX = Math.max(0, Math.min(1, fraction)) * size.width
      const maxBarHeight = size.height - 2
      for (let c = 0; c < columns; c++) {
        const x = c * BAR_STEP
        const hasData = bars.appearAt[c] > 0 && now >= bars.appearAt[c]
        const barHeight = Math.max(BASELINE_HEIGHT, bars.heights[c] * maxBarHeight)
        const played = x + BAR_WIDTH / 2 <= playedX
        ctx.fillStyle = played ? colorPlayed : hasData ? COLOR_UNPLAYED : COLOR_BASELINE
        ctx.fillRect(x, middle - barHeight / 2, BAR_WIDTH, barHeight)
      }

      if (hoverFraction !== null) {
        ctx.fillStyle = COLOR_HOVER
        ctx.fillRect(Math.round(hoverFraction * size.width) - 0.5, 0, 1, size.height)
      }
      ctx.fillStyle = colorPlayhead
      ctx.fillRect(Math.min(size.width - 1.5, Math.max(0, playedX - 0.75)), 0, 1.5, size.height)

      if (animating) {
        frameRef.current = requestAnimationFrame(draw)
      } else {
        lastFrameRef.current = 0
      }
    }

    if (frameRef.current === null) frameRef.current = requestAnimationFrame(draw)
  }, [accentFrom, accentTo, data, revision, duration, fraction, hoverFraction, size])

  useEffect(() => () => {
    // Cleared so a remount (StrictMode runs effects twice) schedules drawing again.
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    lastFrameRef.current = 0
  }, [])

  // Sized by its box, never by its bitmap, so resizing the bitmap cannot feed back into the observer.
  return <canvas ref={canvasRef} style={CANVAS_STYLE} aria-hidden="true" />
}
