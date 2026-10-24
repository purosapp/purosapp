/**
 * Preview of a FIR design: magnitude response and impulse response, computed by
 * the native designer for a chosen rate pair. Values are also listed as text,
 * so nothing depends on hovering.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  toNativeFirDesign,
  type FirFilterSettings,
  type FirPreview,
} from '../../services/resamplingSettings'

type Preview = Extract<FirPreview, { success: true }>

const LINE = '#4a8cf0'          // single series; validated against the dark surface
const WIDTH = 320
const HEIGHT = 132
const PAD = { left: 34, right: 8, top: 8, bottom: 20 }
const PLOT_W = WIDTH - PAD.left - PAD.right
const PLOT_H = HEIGHT - PAD.top - PAD.bottom
const PREVIEW_DELAY_MS = 250

function formatKhz(hz: number): string {
  return `${Number((hz / 1000).toFixed(hz >= 10000 ? 1 : 2))} kHz`
}

type Point = { x: number; y: number }

function LineChart({
  points,
  xDomain,
  yDomain,
  xTicks,
  yTicks,
  formatX,
  formatY,
  marker,
  label,
}: {
  points: Point[]
  xDomain: [number, number]
  yDomain: [number, number]
  xTicks: number[]
  yTicks: number[]
  formatX: (x: number) => string
  formatY: (y: number) => string
  marker?: { x: number; label: string }
  label: string
}) {
  const [hover, setHover] = useState<Point | null>(null)
  // Drop ticks that would collide with a neighbour (closer than 18% of the width).
  const visibleTicks = useMemo(() => {
    const span = xDomain[1] - xDomain[0] || 1
    const kept: number[] = []
    for (const tick of [...xTicks].sort((a, b) => a - b)) {
      if (tick < xDomain[0] || tick > xDomain[1]) continue
      const last = kept[kept.length - 1]
      if (last !== undefined && (tick - last) / span < 0.18) {
        // Prefer the domain edges over interior ticks.
        if (tick === xDomain[1]) kept[kept.length - 1] = tick
        continue
      }
      kept.push(tick)
    }
    return kept
  }, [xTicks, xDomain])
  const sx = (x: number) => PAD.left + ((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * PLOT_W
  const sy = (y: number) => PAD.top + (1 - (Math.min(Math.max(y, yDomain[0]), yDomain[1]) - yDomain[0]) / (yDomain[1] - yDomain[0])) * PLOT_H
  const path = useMemo(() => points
    .filter((p) => p.x >= xDomain[0] && p.x <= xDomain[1])
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
    .join(''), [points, xDomain, yDomain]) // eslint-disable-line react-hooks/exhaustive-deps

  const nearest = (clientX: number, rect: DOMRect) => {
    const x = xDomain[0] + ((clientX - rect.left) / rect.width * WIDTH - PAD.left) / PLOT_W * (xDomain[1] - xDomain[0])
    let best: Point | null = null
    for (const p of points) {
      if (p.x < xDomain[0] || p.x > xDomain[1]) continue
      if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p
    }
    return best
  }

  return (
    <figure className="relative">
      <figcaption className="text-[11px] text-zinc-400 mb-1">{label}</figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto select-none"
        role="img"
        aria-label={label}
        onPointerMove={(event) => setHover(nearest(event.clientX, event.currentTarget.getBoundingClientRect()))}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={sy(tick)} y2={sy(tick)} stroke="rgba(255,255,255,0.06)" />
            <text x={PAD.left - 4} y={sy(tick) + 3} textAnchor="end" fontSize="8" fill="#71717a">{formatY(tick)}</text>
          </g>
        ))}
        {visibleTicks.map((tick) => {
          // Edge labels hug the plot edges so they are never clipped.
          const anchor = tick === xDomain[0] ? 'start' : tick === xDomain[1] ? 'end' : 'middle'
          return (
            <text key={`x${tick}`} x={sx(tick)} y={HEIGHT - 6} textAnchor={anchor} fontSize="8" fill="#71717a">{formatX(tick)}</text>
          )
        })}
        {marker && marker.x >= xDomain[0] && marker.x <= xDomain[1] && (
          <g>
            <line x1={sx(marker.x)} x2={sx(marker.x)} y1={PAD.top} y2={PAD.top + PLOT_H} stroke="#a1a1aa" strokeDasharray="2 3" strokeWidth="1" />
            <text x={sx(marker.x) + 3} y={PAD.top + 8} fontSize="8" fill="#a1a1aa">{marker.label}</text>
          </g>
        )}
        <path d={path} fill="none" stroke={LINE} strokeWidth="1.5" strokeLinejoin="round" />
        {hover && (
          <g pointerEvents="none">
            <line x1={sx(hover.x)} x2={sx(hover.x)} y1={PAD.top} y2={PAD.top + PLOT_H} stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
            <circle cx={sx(hover.x)} cy={sy(hover.y)} r="3" fill={LINE} stroke="#18181b" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute right-1 top-0 rounded-lg border border-white/10 bg-black/85 backdrop-blur-xl px-2 py-1 text-[10px] tabular-nums">
          <span className="text-zinc-100 font-medium">{formatY(hover.y)}</span>
          <span className="text-zinc-500"> at {formatX(hover.x)}</span>
        </div>
      )}
    </figure>
  )
}

export default function FirPreviewChart({
  design,
  inputRate,
  outputRate,
}: {
  design: FirFilterSettings
  inputRate: number
  outputRate: number
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const request = useRef(0)

  useEffect(() => {
    const id = ++request.current
    setLoading(true)
    const timer = window.setTimeout(() => {
      void window.puros.audio.previewFirFilter(toNativeFirDesign(design), inputRate, outputRate)
        .then((result) => {
          if (id !== request.current) return
          if (result.success) {
            setPreview(result)
            setError(null)
          } else {
            setError(result.error)
          }
        })
        .catch((err: unknown) => { if (id === request.current) setError(err instanceof Error ? err.message : String(err)) })
        .finally(() => { if (id === request.current) setLoading(false) })
    }, PREVIEW_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [design, inputRate, outputRate])

  const lowNyquist = Math.min(inputRate, outputRate) / 2
  const magnitude = useMemo<Point[]>(() => {
    if (!preview) return []
    return Array.from(preview.frequencies, (f, i) => ({ x: f, y: preview.magnitudeDb[i] }))
  }, [preview])
  const impulse = useMemo<Point[]>(() => {
    if (!preview) return []
    const peak = preview.impulse[preview.impulsePeakIndex] || 1
    return Array.from(preview.impulse, (v, i) => ({
      x: (i - preview.impulsePeakIndex) / preview.impulseSampleRate * 1000,
      y: v / peak,
    }))
  }, [preview])

  if (!preview) {
    return (
      <p className="text-xs text-zinc-500 py-2">{error ?? (loading ? 'Designing filter…' : '')}</p>
    )
  }

  const floor = Math.min(-100, Math.floor((preview.attenuationAtNyquistDb - 20) / 40) * 40)
  const xMax = Math.min(preview.frequencies[preview.frequencies.length - 1], lowNyquist * 2)
  const impulseStart = impulse[0]?.x ?? -1
  const impulseEnd = impulse[impulse.length - 1]?.x ?? 1

  return (
    <div className={`space-y-2 transition-opacity ${loading ? 'opacity-50' : ''}`}>
      <div className="grid grid-cols-2 gap-3">
        <LineChart
          label="Magnitude response"
          points={magnitude}
          xDomain={[0, xMax]}
          yDomain={[floor, 5]}
          xTicks={[0, lowNyquist / 2, lowNyquist, lowNyquist * 1.5].filter((x) => x <= xMax)}
          yTicks={[0, Math.round(floor / 2 / 20) * 20, floor]}
          formatX={formatKhz}
          formatY={(y) => `${y.toFixed(y > -10 ? 2 : 0)} dB`}
          marker={{ x: lowNyquist, label: 'Nyquist' }}
        />
        <LineChart
          label="Impulse response"
          points={impulse}
          xDomain={[impulseStart, impulseEnd]}
          yDomain={[-0.4, 1.05]}
          xTicks={[impulseStart, 0, impulseEnd]}
          yTicks={[0, 1]}
          formatX={(x) => `${x.toFixed(2)} ms`}
          formatY={(y) => y.toFixed(3)}
        />
      </div>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-0.5 text-[11px]">
        <div><dt className="inline text-zinc-500">Taps </dt><dd className="inline text-zinc-200 tabular-nums">{preview.taps.toLocaleString()}</dd></div>
        <div><dt className="inline text-zinc-500">Length </dt><dd className="inline text-zinc-200 tabular-nums">{preview.lengthMs.toFixed(1)} ms</dd></div>
        <div><dt className="inline text-zinc-500">Pre-ringing </dt><dd className="inline text-zinc-200 tabular-nums">{preview.preRingingMs.toFixed(2)} ms</dd></div>
        <div><dt className="inline text-zinc-500">Flat (±0.1 dB) to </dt><dd className="inline text-zinc-200 tabular-nums">{formatKhz(preview.passbandEdgeHz)}</dd></div>
        <div><dt className="inline text-zinc-500">−3 dB at </dt><dd className="inline text-zinc-200 tabular-nums">{formatKhz(preview.minus3DbHz)}</dd></div>
        <div><dt className="inline text-zinc-500">At Nyquist </dt><dd className="inline text-zinc-200 tabular-nums">{preview.attenuationAtNyquistDb.toFixed(1)} dB</dd></div>
      </dl>
    </div>
  )
}
