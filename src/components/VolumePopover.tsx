/**
 * Volume control for the player bar: the speaker button opens a compact
 * liquid-glass slider right beside it, to the left (like Apple Music),
 * instead of keeping a slider in the bar. How volume is applied (DSP,
 * device, fixed) is the popover's tooltip.
 */

import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { Volume1, Volume2, VolumeX } from 'lucide-react'
import { GlassPopover } from './GlassPanel'

function SpeakerIcon({ volume, className = 'w-4 h-4' }: { volume: number; className?: string }) {
  const Icon = volume <= 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  return <Icon className={className} aria-hidden="true" />
}

/** Volume change per wheel notch. */
const WHEEL_STEP = 0.04

export default function VolumePopover({
  volume,
  onVolumeChange,
  onToggleMute,
  locked,
  description,
  decibels,
}: {
  volume: number
  onVolumeChange: (volume: number) => void
  onToggleMute: () => void
  /** Fixed volume: the level is set on the amplifier, not here. */
  locked: boolean
  /** How the volume is applied (DSP, device, fixed), from describeVolumeControl. */
  description: string | null
  /** Level the slider applies, formatted (formatDecibels); null when unknown. */
  decibels: string | null
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!anchorRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const clamp = (value: number) => Math.max(0, Math.min(1, value))

  const onWheel = (event: WheelEvent) => {
    if (locked || event.deltaY === 0) return
    onVolumeChange(clamp(volume + (event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)))
  }

  const setFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    onVolumeChange(clamp((event.clientX - rect.left) / rect.width))
  }

  const percent = Math.round(volume * 100)

  return (
    <div ref={anchorRef} className="relative" onWheel={onWheel}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Volume"
        title={locked ? description ?? 'Volume' : `Volume ${percent}%${decibels ? ` (${decibels})` : ''}`}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          open ? 'bg-white/10 text-zinc-100' : locked ? 'text-zinc-600 hover:text-zinc-400' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
        }`}
      >
        <SpeakerIcon volume={volume} />
      </button>

      <GlassPopover
        ref={popoverRef}
        anchorRef={anchorRef}
        open={open}
        placement="left"
        gap={8}
        radius={22}
        onWheel={onWheel}
        title={locked ? undefined : description ?? undefined}
        className={`flex h-11 w-84 items-center border border-transparent px-2.5 transition-[opacity,translate] duration-200 ease-out ${
          open ? 'pointer-events-auto translate-x-0 opacity-100' : 'pointer-events-none translate-x-2 opacity-0'
        }`}
      >
        {locked ? (
          <div className="flex min-w-0 items-center gap-2.5 px-1.5">
            <SpeakerIcon volume={1} className="h-4 w-4 shrink-0 text-zinc-500" />
            <p className="truncate text-xs text-zinc-400" title={`${description ?? 'Fixed volume'} — set the level on your amplifier.`}>
              {description ?? 'Fixed volume'} · set on your amplifier
            </p>
          </div>
        ) : (
          <>
            <div className="flex w-full items-center gap-2.5">
              <button
                type="button"
                onClick={onToggleMute}
                title={volume > 0 ? 'Mute' : 'Unmute'}
                aria-label={volume > 0 ? 'Mute' : 'Unmute'}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
              >
                <SpeakerIcon volume={volume} />
              </button>
              <div
                role="slider"
                aria-label="Volume"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={decibels ? `${percent}%, ${decibels}` : `${percent}%`}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') onVolumeChange(clamp(volume + WHEEL_STEP))
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') onVolumeChange(clamp(volume - WHEEL_STEP))
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setFromPointer(event)
                }}
                onPointerMove={(event) => { if (event.buttons === 1) setFromPointer(event) }}
                className="group relative flex h-5 flex-1 cursor-pointer items-center focus:outline-none"
              >
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15">
                  <div className="h-full rounded-full bg-white" style={{ width: `${percent}%` }} />
                </div>
                <div
                  className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_6px_rgba(0,0,0,0.5)] transition-transform group-hover:scale-110 group-focus-visible:ring-2 group-focus-visible:ring-white/50"
                  style={{ left: `${percent}%` }}
                />
              </div>
              <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-zinc-300">{percent}%</span>
              {/* Fixed width (fits −100.0 dB) so the slider doesn't shift as the readout changes. */}
              {decibels ? (
                <span className="w-17 shrink-0 text-right font-mono text-xs tabular-nums text-zinc-500">{decibels}</span>
              ) : null}
            </div>
          </>
        )}
      </GlassPopover>
    </div>
  )
}
