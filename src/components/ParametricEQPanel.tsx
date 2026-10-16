/**
 * Manual Parametric Equalizer panel.
 * Renders a frequency-response graph (biquad magnitude response) and
 * a band editor. All state lives in dspStore; the store calls the native
 * audio engine via syncToEngine() after every mutation.
 */

import { Check, Plus, X } from 'lucide-react'
import { useRef, useEffect, useCallback, useState } from 'react'
import {
  useDSPStore,
  newBandId,
  PEQ_LIMITS,
  sanitizePEQBand,
  parsePEQPresetImport,
  exportPEQPresetAsText,
  exportPEQPresetsAsJson,
  type PEQBand,
} from '../store/dspStore'
import { usePlayerStore } from '../store/playerStore'

// ---------------------------------------------------------------------------
// Biquad math - Audio EQ Cookbook (Robert Bristow-Johnson)
// Only used for the canvas visualisation; the native engine does the real DSP.
// ---------------------------------------------------------------------------

const VIS_FS = 44100
const N_POINTS = 300
const FREQ_POINTS = Array.from({ length: N_POINTS }, (_, i) =>
  PEQ_LIMITS.frequency.min * Math.pow(PEQ_LIMITS.frequency.max / PEQ_LIMITS.frequency.min, i / (N_POINTS - 1))
)

interface Coeffs { b: [number, number, number]; a: [number, number, number] }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function freqToRatio(freq: number) {
  const min = PEQ_LIMITS.frequency.min
  const max = PEQ_LIMITS.frequency.max
  return Math.log10(clamp(freq, min, max) / min) / Math.log10(max / min)
}

function ratioToFreq(ratio: number) {
  const min = PEQ_LIMITS.frequency.min
  const max = PEQ_LIMITS.frequency.max
  return min * Math.pow(max / min, clamp(ratio, 0, 1))
}

function freqToX(freq: number, width: number) {
  return freqToRatio(freq) * width
}

function gainToY(gain: number, height: number) {
  return height / 2 - (clamp(gain, PEQ_LIMITS.gain.min, PEQ_LIMITS.gain.max) / PEQ_LIMITS.gain.max) * (height / 2 * 0.88)
}

function yToGain(y: number, height: number) {
  if (height <= 0) return 0
  const normalized = clamp((height / 2 - y) / (height / 2 * 0.88), -1, 1)
  return normalized * PEQ_LIMITS.gain.max
}

function formatFrequency(freq: number) {
  return freq >= 1000
    ? `${(freq / 1000).toFixed(freq >= 10000 ? 0 : 1)}k`
    : `${Math.round(freq)}`
}

function downloadTextFile(filename: string, content: string, mime = 'application/json;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function biquadCoeffs(
  type: PEQBand['type'],
  freq: number,
  gainDb: number,
  q: number,
): Coeffs {
  const f = Math.max(1, Math.min(freq, VIS_FS / 2 - 1))
  const A = Math.pow(10, gainDb / 40)
  const w0 = 2 * Math.PI * f / VIS_FS
  const cosW = Math.cos(w0)
  const sinW = Math.sin(w0)
  const alpha = sinW / (2 * Math.max(q, 0.01))
  const sqrtA = Math.sqrt(A)

  if (type === 'peaking') {
    const a0 = 1 + alpha / A
    return {
      b: [(1 + alpha * A) / a0, (-2 * cosW) / a0, (1 - alpha * A) / a0],
      a: [1, (-2 * cosW) / a0, (1 - alpha / A) / a0],
    }
  }
  if (type === 'lowShelf') {
    const a0 = (A + 1) + (A - 1) * cosW + 2 * sqrtA * alpha
    return {
      b: [
        A * ((A + 1) - (A - 1) * cosW + 2 * sqrtA * alpha) / a0,
        2 * A * ((A - 1) - (A + 1) * cosW) / a0,
        A * ((A + 1) - (A - 1) * cosW - 2 * sqrtA * alpha) / a0,
      ],
      a: [
        1,
        -2 * ((A - 1) + (A + 1) * cosW) / a0,
        ((A + 1) + (A - 1) * cosW - 2 * sqrtA * alpha) / a0,
      ],
    }
  }
  const a0 = (A + 1) - (A - 1) * cosW + 2 * sqrtA * alpha
  return {
    b: [
      A * ((A + 1) + (A - 1) * cosW + 2 * sqrtA * alpha) / a0,
      -2 * A * ((A - 1) + (A + 1) * cosW) / a0,
      A * ((A + 1) + (A - 1) * cosW - 2 * sqrtA * alpha) / a0,
    ],
    a: [
      1,
      2 * ((A - 1) - (A + 1) * cosW) / a0,
      ((A + 1) - (A - 1) * cosW - 2 * sqrtA * alpha) / a0,
    ],
  }
}

function biquadMagDb(c: Coeffs, f: number): number {
  const w = 2 * Math.PI * f / VIS_FS
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const c2w = Math.cos(2 * w)
  const s2w = Math.sin(2 * w)
  const nR = c.b[0] + c.b[1] * cw + c.b[2] * c2w
  const nI = -(c.b[1] * sw + c.b[2] * s2w)
  const dR = c.a[0] + c.a[1] * cw + c.a[2] * c2w
  const dI = -(c.a[1] * sw + c.a[2] * s2w)
  const d2 = dR * dR + dI * dI
  if (d2 === 0) return 0
  return 10 * Math.log10((nR * nR + nI * nI) / d2)
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

const BAND_COLORS = [
  '#60a5fa', '#34d399', '#f472b6', '#fb923c',
  '#a78bfa', '#38bdf8', '#4ade80', '#f87171',
  '#facc15', '#c084fc',
]

interface EQGraphProps {
  peqBands: PEQBand[]
  peqEnabled: boolean
  autoBands: { type: PEQBand['type']; frequency: number; gain: number; q: number }[]
  autoEnabled: boolean
  selectedBandId: string | null
  onSelectBand: (id: string) => void
  onPreviewBandChange: (id: string, patch: Partial<PEQBand>) => void
  onCommitBandChange: () => void
}

function EQGraph({
  peqBands,
  peqEnabled,
  autoBands,
  autoEnabled,
  selectedBandId,
  onSelectBand,
  onPreviewBandChange,
  onCommitBandChange,
}: EQGraphProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 440, height: 148 })
  const selectedBand = selectedBandId ? peqBands.find((band) => band.id === selectedBandId) ?? null : null

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const updateSize = () => {
      const width = Math.max(320, Math.round(wrapper.clientWidth))
      const height = Math.max(148, Math.round(wrapper.clientHeight))
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }

    updateSize()

    const observer = new ResizeObserver(() => updateSize())
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, size.width)
    const height = Math.max(1, size.height)
    const W = Math.round(width * dpr)
    const H = Math.round(height * dpr)

    canvas.width = W
    canvas.height = H
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dbToCanvasY = (db: number) => gainToY(db, height) * dpr
    const freqToCanvasX = (freq: number) => freqToX(freq, width) * dpr

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#09090b'
    ctx.fillRect(0, 0, W, H)

    ctx.lineWidth = 1 * dpr
    for (const freq of [20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      ctx.strokeStyle = freq === 1000 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)'
      ctx.beginPath()
      ctx.moveTo(freqToCanvasX(freq), 0)
      ctx.lineTo(freqToCanvasX(freq), H)
      ctx.stroke()
    }

    for (const gain of [-20, -15, -10, -5, 0, 5, 10, 15, 20]) {
      ctx.strokeStyle = gain === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'
      ctx.beginPath()
      ctx.moveTo(0, dbToCanvasY(gain))
      ctx.lineTo(W, dbToCanvasY(gain))
      ctx.stroke()
    }

    ctx.font = `${10 * dpr}px monospace`
    ctx.fillStyle = 'rgba(255,255,255,0.24)'
    ctx.textAlign = 'center'
    for (const freq of [100, 1000, 10000]) {
      ctx.fillText(formatFrequency(freq), freqToCanvasX(freq), H - 4 * dpr)
    }
    ctx.textAlign = 'left'
    for (const gain of [-20, -10, 0, 10, 20]) {
      if (gain !== 0) ctx.fillText(`${gain > 0 ? '+' : ''}${gain}`, 6 * dpr, dbToCanvasY(gain) - 3 * dpr)
    }

    if (peqEnabled) {
      peqBands.forEach((band, index) => {
        if (!band.enabled || band.gain === 0) return
        const coeffs = biquadCoeffs(band.type, band.frequency, band.gain, band.q)
        ctx.strokeStyle = `${BAND_COLORS[index % BAND_COLORS.length]}66`
        ctx.lineWidth = 1 * dpr
        ctx.beginPath()
        FREQ_POINTS.forEach((freq, pointIndex) => {
          const x = freqToCanvasX(freq)
          const y = dbToCanvasY(biquadMagDb(coeffs, freq))
          pointIndex === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        })
        ctx.stroke()
      })
    }

    const activePEQ = peqEnabled ? peqBands.filter((band) => band.enabled) : []
    const activeAuto = autoEnabled ? autoBands : []

    if (activePEQ.length > 0 || activeAuto.length > 0) {
      const coeffsPEQ = activePEQ.map((band) => biquadCoeffs(band.type, band.frequency, band.gain, band.q))
      const coeffsAuto = activeAuto.map((band) => biquadCoeffs(band.type, band.frequency, band.gain, band.q))

      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      FREQ_POINTS.forEach((freq, pointIndex) => {
        let gain = 0
        for (const coeffs of coeffsPEQ) gain += biquadMagDb(coeffs, freq)
        for (const coeffs of coeffsAuto) gain += biquadMagDb(coeffs, freq)
        const x = freqToCanvasX(freq)
        const y = dbToCanvasY(gain)
        pointIndex === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      })
      ctx.stroke()
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'
      ctx.lineWidth = 1 * dpr
      ctx.beginPath()
      ctx.moveTo(0, H / 2)
      ctx.lineTo(W, H / 2)
      ctx.stroke()
    }
  }, [autoBands, autoEnabled, peqBands, peqEnabled, size.height, size.width])

  const updateFromPointer = useCallback((bandId: string, clientX: number, clientY: number) => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const rect = wrapper.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const x = clamp(clientX - rect.left, 0, rect.width)
    const y = clamp(clientY - rect.top, 0, rect.height)
    onPreviewBandChange(bandId, {
      frequency: ratioToFreq(x / rect.width),
      gain: yToGain(y, rect.height),
    })
  }, [onPreviewBandChange])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>, bandId: string) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelectBand(bandId)
    updateFromPointer(bandId, event.clientX, event.clientY)
  }, [onSelectBand, updateFromPointer])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>, bandId: string) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    updateFromPointer(bandId, event.clientX, event.clientY)
  }, [updateFromPointer])

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onCommitBandChange()
  }, [onCommitBandChange])

  return (
    <div
      ref={wrapperRef}
      className="relative h-36 w-full overflow-hidden rounded-md bg-zinc-950"
      onPointerDown={(event) => {
        if (event.target === wrapperRef.current) {
          onCommitBandChange()
        }
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {peqBands.map((band, index) => {
        const selected = band.id === selectedBandId
        const color = band.enabled ? BAND_COLORS[index % BAND_COLORS.length] : '#52525b'
        const x = freqToX(band.frequency, size.width)
        const y = gainToY(band.gain, size.height)

        return (
          <button
            key={band.id}
            type="button"
            onClick={() => onSelectBand(band.id)}
            onPointerDown={(event) => handlePointerDown(event, band.id)}
            onPointerMove={(event) => handlePointerMove(event, band.id)}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title={`${TYPE_LABELS[band.type]} ${formatFrequency(band.frequency)} Hz ${band.gain >= 0 ? '+' : ''}${band.gain.toFixed(1)} dB`}
            className={`absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-[transform,box-shadow] duration-75 ${
              selected ? 'scale-110 shadow-[0_0_0_4px_rgba(255,255,255,0.08)]' : ''
            }`}
            style={{
              left: x,
              top: y,
              backgroundColor: color,
              borderColor: selected ? '#ffffff' : 'rgba(255,255,255,0.55)',
              touchAction: 'none',
              boxShadow: selected ? `0 0 0 1px ${color}, 0 0 0 6px rgba(255,255,255,0.08)` : `0 0 0 1px ${color}`,
            }}
          >
            <span className="sr-only">{band.id}</span>
          </button>
        )
      })}

      {selectedBand && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-black/65 px-2 py-1 text-[10px] font-mono text-zinc-200 backdrop-blur">
          {TYPE_LABELS[selectedBand.type]} {Math.round(selectedBand.frequency)} Hz
          {' '}· {selectedBand.gain >= 0 ? '+' : ''}{selectedBand.gain.toFixed(1)} dB
          {' '}· Q {selectedBand.q.toFixed(2)}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Number input - controlled, validates on blur
// ---------------------------------------------------------------------------

function NumInput({
  value,
  min,
  max,
  step,
  onChange,
  className = '',
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  className?: string
}) {
  const [local, setLocal] = useState(String(value))

  useEffect(() => {
    setLocal(String(value))
  }, [value])

  const commit = (raw: string) => {
    const parsed = parseFloat(raw)
    if (Number.isNaN(parsed)) {
      setLocal(String(value))
      return
    }

    const next = clamp(parsed, min, max)
    setLocal(String(next))
    onChange(next)
  }

  return (
    <input
      type="number"
      value={local}
      min={min}
      max={max}
      step={step}
      onChange={(event) => setLocal(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit((event.target as HTMLInputElement).value)
      }}
      className={`bg-zinc-800 border border-zinc-700 rounded text-zinc-200 text-[10px] font-mono text-right px-1 py-0.5 focus:outline-none focus:border-zinc-500 ${className}`}
    />
  )
}

// ---------------------------------------------------------------------------
// Band row
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<PEQBand['type'], string> = {
  peaking: 'PK',
  lowShelf: 'LS',
  highShelf: 'HS',
}

function BandRow({
  band,
  colorIndex,
  selected,
  onSelect,
  onUpdate,
  onDelete,
}: {
  band: PEQBand
  colorIndex: number
  selected: boolean
  onSelect: (id: string) => void
  onUpdate: (id: string, patch: Partial<PEQBand>) => void
  onDelete: (id: string) => void
}) {
  const color = BAND_COLORS[colorIndex % BAND_COLORS.length]

  const update = (patch: Partial<PEQBand>) => {
    onSelect(band.id)
    onUpdate(band.id, patch)
  }

  return (
    <div
      className={`flex items-center gap-1.5 py-1 group rounded px-1 transition-colors ${
        selected ? 'bg-zinc-900/80' : 'hover:bg-zinc-900/40'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(band.id)}
        className="w-2 h-2 rounded-full shrink-0"
        style={{ background: band.enabled ? color : '#52525b' }}
        title="Select band"
      />

      <button
        type="button"
        onClick={() => update({ enabled: !band.enabled })}
        className={`w-3.5 h-3.5 rounded shrink-0 border transition-colors ${
          band.enabled ? 'bg-zinc-600 border-zinc-500' : 'bg-transparent border-zinc-700'
        }`}
        title={band.enabled ? 'Disable band' : 'Enable band'}
      >
        {band.enabled && (
          <Check className="w-3 h-3 text-zinc-200 mx-auto" strokeWidth={3} />
        )}
      </button>

      <select
        value={band.type}
        onChange={(event) => update({ type: event.target.value as PEQBand['type'] })}
        className="w-10 bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-300 font-mono px-0.5 py-0.5 focus:outline-none focus:border-zinc-500 shrink-0"
      >
        {(Object.keys(TYPE_LABELS) as PEQBand['type'][]).map((type) => (
          <option key={type} value={type}>{TYPE_LABELS[type]}</option>
        ))}
      </select>

      <div className="flex items-center gap-0.5 flex-1 min-w-0">
        <NumInput
          value={band.frequency}
          min={PEQ_LIMITS.frequency.min}
          max={PEQ_LIMITS.frequency.max}
          step={1}
          onChange={(value) => update({ frequency: value })}
          className="w-full"
        />
        <span className="text-[9px] text-zinc-600 shrink-0">Hz</span>
      </div>

      <div className="flex items-center gap-0.5">
        <NumInput
          value={band.gain}
          min={PEQ_LIMITS.gain.min}
          max={PEQ_LIMITS.gain.max}
          step={0.1}
          onChange={(value) => update({ gain: value })}
          className="w-14"
        />
        <span className="text-[9px] text-zinc-600 shrink-0">dB</span>
      </div>

      <div className="flex items-center gap-0.5">
        <NumInput
          value={band.q}
          min={PEQ_LIMITS.q.min}
          max={PEQ_LIMITS.q.max}
          step={0.01}
          onChange={(value) => update({ q: value })}
          className="w-10"
        />
        <span className="text-[9px] text-zinc-600 shrink-0">Q</span>
      </div>

      <button
        type="button"
        onClick={() => onDelete(band.id)}
        className="text-zinc-700 hover:text-red-400 transition-colors shrink-0"
        title="Delete band"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preamp slider
// ---------------------------------------------------------------------------

function PreampRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-zinc-500 shrink-0 w-12">Preamp</span>
      <input
        type="range"
        min={PEQ_LIMITS.preamp.min}
        max={PEQ_LIMITS.preamp.max}
        step={0.1}
        value={value}
        onChange={(event) => onChange(parseFloat(event.target.value))}
        className="flex-1 accent-zinc-400 h-1"
      />
      <span className="text-[10px] font-mono text-zinc-300 w-12 text-right shrink-0">
        {value >= 0 ? '+' : ''}{value.toFixed(1)} dB
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type SyncMode = 'schedule' | 'flush'

export default function ParametricEQPanel() {
  const {
    peqEnabled, peqBands, peqPreamp,
    eqEnabled, activeProfile,
    setPEQEnabled, setPEQPreamp,
    peqPresets, activePEQPresetName,
    saveCurrentPEQPreset, loadPEQPreset, deletePEQPreset, importPEQPresets,
    syncToEngine,
  } = useDSPStore()
  const setNotification = usePlayerStore((s) => s.setNotification)

  const [localBands, setLocalBands] = useState<PEQBand[]>(peqBands.map(sanitizePEQBand))
  const [selectedBandId, setSelectedBandId] = useState<string | null>(peqBands[0]?.id ?? null)
  const [presetName, setPresetName] = useState('')
  const [selectedPresetName, setSelectedPresetName] = useState<string>('')
  const [importText, setImportText] = useState('')
  const [showImportList, setShowImportList] = useState(false)
  const localBandsRef = useRef(localBands)
  const syncFrameRef = useRef<number | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    localBandsRef.current = localBands
  }, [localBands])

  useEffect(() => {
    const sanitized = peqBands.map(sanitizePEQBand)
    localBandsRef.current = sanitized
    setLocalBands(sanitized)
  }, [peqBands])

  useEffect(() => {
    if (selectedBandId && localBands.some((band) => band.id === selectedBandId)) return
    setSelectedBandId(localBands[0]?.id ?? null)
  }, [localBands, selectedBandId])

  useEffect(() => {
    setSelectedPresetName(activePEQPresetName ?? '')
  }, [activePEQPresetName])

  useEffect(() => () => {
    if (syncFrameRef.current !== null) {
      window.cancelAnimationFrame(syncFrameRef.current)
    }
  }, [])

  const scheduleSync = useCallback(() => {
    if (syncFrameRef.current !== null) return
    syncFrameRef.current = window.requestAnimationFrame(() => {
      syncFrameRef.current = null
      void syncToEngine()
    })
  }, [syncToEngine])

  const flushSync = useCallback(() => {
    if (syncFrameRef.current !== null) {
      window.cancelAnimationFrame(syncFrameRef.current)
      syncFrameRef.current = null
    }
    void syncToEngine()
  }, [syncToEngine])

  const applyBands = useCallback((updater: (bands: PEQBand[]) => PEQBand[], syncMode: SyncMode, autoEnable = false) => {
    const currentBands = localBandsRef.current
    const nextBands = updater(currentBands).map(sanitizePEQBand)
    const nextEnabled = nextBands.length > 0 ? (autoEnable ? true : useDSPStore.getState().peqEnabled) : false

    localBandsRef.current = nextBands
    setLocalBands(nextBands)
    useDSPStore.getState().applyState({
      peqBands: nextBands,
      peqEnabled: nextEnabled,
    })

    if (syncMode === 'flush') flushSync()
    else scheduleSync()
  }, [flushSync, scheduleSync])

  const autoBands = (eqEnabled && activeProfile)
    ? activeProfile.bands.map((band) => ({ type: band.type, frequency: band.frequency, gain: band.gain, q: band.q }))
    : []

  const handleAddBand = useCallback(() => {
    const newBand: PEQBand = {
      id: newBandId(),
      type: 'peaking',
      frequency: 1000,
      gain: 0,
      q: 1,
      enabled: true,
    }

    setSelectedBandId(newBand.id)
    applyBands((bands) => [...bands, newBand], 'flush', true)
  }, [applyBands])

  const handleUpdateBand = useCallback((id: string, patch: Partial<PEQBand>, syncMode: SyncMode = 'flush') => {
    applyBands((bands) => bands.map((band) => (
      band.id === id ? sanitizePEQBand({ ...band, ...patch }) : band
    )), syncMode)
  }, [applyBands])

  const handleDeleteBand = useCallback((id: string) => {
    applyBands((bands) => bands.filter((band) => band.id !== id), 'flush')
  }, [applyBands])

  const handleResetBands = useCallback(() => {
    setSelectedBandId(null)
    applyBands(() => [], 'flush')
  }, [applyBands])

  const handlePreampChange = useCallback((value: number) => {
    setPEQPreamp(value)
  }, [setPEQPreamp])

  const handleSavePreset = useCallback(async () => {
    try {
      const name = presetName.trim() || activePEQPresetName || `Preset ${peqPresets.length + 1}`
      const saved = await saveCurrentPEQPreset(name)
      setPresetName(saved.name)
      setSelectedPresetName(saved.name)
      setNotification(`Saved PEQ preset: ${saved.name}`)
    } catch (error) {
      setNotification(error instanceof Error ? error.message : 'Failed to save PEQ preset')
    }
  }, [activePEQPresetName, peqPresets.length, presetName, saveCurrentPEQPreset, setNotification])

  const handleLoadPreset = useCallback(async (name: string) => {
    if (!name) return
    try {
      await loadPEQPreset(name)
      setSelectedPresetName(name)
      setPresetName(name)
      setNotification(`Loaded PEQ preset: ${name}`)
    } catch (error) {
      setNotification(error instanceof Error ? error.message : 'Failed to load PEQ preset')
    }
  }, [loadPEQPreset, setNotification])

  const handleDeletePreset = useCallback(async () => {
    const name = selectedPresetName || activePEQPresetName || presetName.trim()
    if (!name) return
    await deletePEQPreset(name)
    setSelectedPresetName('')
    if (presetName.trim() === name) setPresetName('')
    setNotification(`Deleted PEQ preset: ${name}`)
  }, [activePEQPresetName, deletePEQPreset, presetName, selectedPresetName, setNotification])

  const handleImportPresets = useCallback(async (text: string, fallbackName: string) => {
    try {
      const imported = await importPEQPresets(parsePEQPresetImport(text, fallbackName))
      if (imported.length === 0) {
        setNotification('No valid PEQ presets found')
        return
      }
      setSelectedPresetName(imported[0]?.name ?? '')
      setNotification(`Imported ${imported.length} PEQ preset${imported.length === 1 ? '' : 's'}`)
      setImportText('')
      setShowImportList(false)
    } catch (error) {
      setNotification(error instanceof Error ? error.message : 'Failed to import PEQ presets')
    }
  }, [importPEQPresets, setNotification])

  const handleImportFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const text = await file.text()
    await handleImportPresets(text, file.name.replace(/\.[^.]+$/, '') || 'Imported preset')
  }, [handleImportPresets])

  const handleExportSelected = useCallback(async () => {
    const name = selectedPresetName || activePEQPresetName
    if (!name) {
      setNotification('Choose a preset to export first')
      return
    }
    const preset = peqPresets.find((entry) => entry.name === name)
    if (!preset) {
      setNotification('Preset not found')
      return
    }
    downloadTextFile(`${preset.name}.peq.txt`, exportPEQPresetAsText(preset), 'text/plain;charset=utf-8')
    setNotification(`Exported PEQ preset: ${preset.name}`)
  }, [activePEQPresetName, peqPresets, selectedPresetName, setNotification])

  const handleExportAll = useCallback(() => {
    if (peqPresets.length === 0) {
      setNotification('No PEQ presets to export')
      return
    }
    downloadTextFile('parametric-eq-presets.json', exportPEQPresetsAsJson(peqPresets))
    setNotification(`Exported ${peqPresets.length} PEQ preset${peqPresets.length === 1 ? '' : 's'}`)
  }, [peqPresets, setNotification])

  const handleCopySelected = useCallback(async () => {
    const name = selectedPresetName || activePEQPresetName
    if (!name) {
      setNotification('Choose a preset to copy first')
      return
    }
    const preset = peqPresets.find((entry) => entry.name === name)
    if (!preset) {
      setNotification('Preset not found')
      return
    }
    try {
      await navigator.clipboard.writeText(exportPEQPresetAsText(preset))
      setNotification(`Copied preset list: ${preset.name}`)
    } catch {
      setNotification('Could not copy preset list')
    }
  }, [activePEQPresetName, peqPresets, selectedPresetName, setNotification])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono">
          Parametric EQ
          {localBands.length > 0 && (
            <span className="ml-1.5 text-zinc-600">· {localBands.length} band{localBands.length !== 1 ? 's' : ''}</span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {localBands.length > 0 && (
            <button
              type="button"
              onClick={handleResetBands}
              className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors"
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => void setPEQEnabled(!peqEnabled)}
            disabled={localBands.length === 0}
            title={localBands.length === 0 ? 'Add a band first' : peqEnabled ? 'Disable PEQ' : 'Enable PEQ'}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              peqEnabled ? 'bg-blue-600' : 'bg-zinc-700'
            } ${localBands.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-150 ${
              peqEnabled ? 'left-[18px]' : 'left-0.5'
            }`} />
          </button>
        </div>
      </div>

      <div className="rounded-md border border-zinc-800/80 bg-zinc-900/35 p-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono">
            Presets
            {peqPresets.length > 0 && (
              <span className="ml-1.5 text-zinc-600">· {peqPresets.length} saved</span>
            )}
          </span>
          {activePEQPresetName && (
            <span className="text-[10px] text-zinc-600 font-mono">
              Active: <span className="text-zinc-400">{activePEQPresetName}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            value={presetName}
            onChange={(event) => setPresetName(event.target.value)}
            placeholder="Preset name"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2.5 py-1.5 focus:outline-none focus:border-zinc-500 placeholder-zinc-600"
          />
          <button
            type="button"
            onClick={() => void handleSavePreset()}
            className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            Save
          </button>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={selectedPresetName}
            onChange={(event) => setSelectedPresetName(event.target.value)}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2.5 py-1.5 focus:outline-none focus:border-zinc-500"
          >
            <option value="">Select saved preset…</option>
            {peqPresets.map((preset) => (
              <option key={preset.name} value={preset.name}>{preset.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleLoadPreset(selectedPresetName)}
            disabled={!selectedPresetName}
            className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Load
          </button>
          <button
            type="button"
            onClick={() => void handleDeletePreset()}
            disabled={!selectedPresetName && !activePEQPresetName}
            className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-300 hover:text-red-300 hover:border-red-500/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Delete
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => importFileRef.current?.click()}
            className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            Import file
          </button>
          <button
            type="button"
            onClick={() => setShowImportList((value) => !value)}
            className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            {showImportList ? 'Hide list import' : 'Import list'}
          </button>
          <button
            type="button"
            onClick={() => void handleExportSelected()}
            disabled={!selectedPresetName && !activePEQPresetName}
            className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Export preset
          </button>
          <button
            type="button"
            onClick={() => void handleCopySelected()}
            disabled={!selectedPresetName && !activePEQPresetName}
            className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Copy list
          </button>
          <button
            type="button"
            onClick={handleExportAll}
            disabled={peqPresets.length === 0}
            className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Export all
          </button>
        </div>

        <input
          ref={importFileRef}
          type="file"
          accept=".json,.txt,.peq,.cfg,text/plain,application/json"
          onChange={(event) => void handleImportFile(event)}
          className="hidden"
        />

        {showImportList && (
          <div className="space-y-2">
            <textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={'Paste JSON presets or Equalizer APO filter lines\n\nPreamp: -3 dB\nFilter 1: ON PK Fc 1000 Hz Gain -2.5 dB Q 1.00'}
              className="min-h-28 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-[11px] text-zinc-200 font-mono focus:outline-none focus:border-zinc-500 placeholder-zinc-600"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] text-zinc-600">
                Supports saved preset JSON and Equalizer APO style lists.
              </p>
              <button
                type="button"
                onClick={() => void handleImportPresets(importText, 'Imported preset')}
                disabled={!importText.trim()}
                className="px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Import pasted list
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="rounded-md overflow-hidden">
          <EQGraph
            peqBands={localBands}
            peqEnabled={peqEnabled}
            autoBands={autoBands}
            autoEnabled={eqEnabled}
            selectedBandId={selectedBandId}
            onSelectBand={setSelectedBandId}
            onPreviewBandChange={(id, patch) => handleUpdateBand(id, patch, 'schedule')}
            onCommitBandChange={flushSync}
          />
        </div>
        {localBands.length > 0 && (
          <p className="text-[10px] text-zinc-600 text-center">
            Drag points on the graph to adjust frequency and gain.
          </p>
        )}
      </div>

      {localBands.length > 0 && (
        <PreampRow value={peqPreamp} onChange={handlePreampChange} />
      )}

      {localBands.length > 0 ? (
        <div className="space-y-0 divide-y divide-zinc-800/60">
          <div className="flex items-center gap-1.5 pb-1">
            <span className="w-2 shrink-0" />
            <span className="w-3.5 shrink-0" />
            <span className="text-[9px] text-zinc-600 w-10 shrink-0">Type</span>
            <span className="text-[9px] text-zinc-600 flex-1">Freq</span>
            <span className="text-[9px] text-zinc-600 w-[4.5rem]">Gain</span>
            <span className="text-[9px] text-zinc-600 w-[3.5rem]">Q</span>
            <span className="w-3 shrink-0" />
          </div>
          {localBands.map((band, index) => (
            <BandRow
              key={band.id}
              band={band}
              colorIndex={index}
              selected={band.id === selectedBandId}
              onSelect={setSelectedBandId}
              onUpdate={(id, patch) => handleUpdateBand(id, patch)}
              onDelete={handleDeleteBand}
            />
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-zinc-600 text-center py-2">
          No bands - click + Add band to start
        </p>
      )}

      <button
        type="button"
        onClick={handleAddBand}
        className="w-full flex items-center justify-center gap-1.5 py-1.5 border border-dashed border-zinc-700 rounded-md text-[11px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
      >
        <Plus className="w-3 h-3" strokeWidth={2.5} />
        Add band
      </button>

      {eqEnabled && activeProfile && (
        <p className="text-[9px] text-zinc-600 text-center">
          AutoEQ profile active - combined response shown above
        </p>
      )}
    </div>
  )
}
