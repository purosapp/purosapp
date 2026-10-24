// Settings → Appearance: the app's accent colour (solid or gradient).

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, Repeat, Shuffle } from 'lucide-react'
import { useSettingsStore } from '../../store/settingsStore'
import {
  ACCENT_GRADIENTS,
  ACCENT_PRESETS,
  accentBackground,
  hexToRgb,
  hueToHex,
  resolveAccent,
  type AccentSetting,
} from '../../utils/accentColor'
import NowPlayingBars from '../NowPlayingBars'

const RAINBOW = 'conic-gradient(from 180deg, #ff453a, #ff9f0a, #ffd60a, #32d74b, #64d2ff, #0a84ff, #bf5af2, #ff375f, #ff453a)'

/** Dark checkmark on light swatches (yellow, graphite), white on the rest. */
function isLight(hex: string) {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 165
}

function Swatch({
  label,
  background,
  selected,
  onSelect,
  children,
}: {
  label: string
  background: string
  selected: boolean
  onSelect: () => void
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
        selected ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-950' : ''
      }`}
      style={{ background }}
    >
      {children}
      {selected && !children && (
        <Check
          className={`h-3.5 w-3.5 ${background.startsWith('#') && isLight(background) ? 'text-zinc-900' : 'text-white'}`}
          strokeWidth={3}
        />
      )}
    </button>
  )
}

function HueSlider({ label, hue, onChange }: { label: string; hue: number; onChange: (hue: number) => void }) {
  return (
    <label className="block space-y-1.5">
      <span className="flex justify-between text-[11px] text-zinc-500">
        <span>{label}</span>
        <span className="font-mono">{hueToHex(hue)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={359}
        value={hue}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        className="hue-slider w-full"
        style={{ '--thumb': hueToHex(hue) } as CSSProperties}
      />
    </label>
  )
}

/** Accent-coloured elements as they appear in the app, so the choice can be judged in place. */
function AccentPreview() {
  const alphas = [0, 25, 45, 70, 100]
  const heights = [6, 10, 14, 9, 18, 12, 20, 15, 8, 16, 11, 19, 13, 7, 17, 10, 14, 9, 12, 6]
  const along = (position: number) => `color-mix(in oklab, var(--accent-to) ${Math.round(position * 100)}%, var(--accent-from))`
  return (
    <div className="flex flex-wrap items-center gap-6 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
      <div className="flex items-center gap-1">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-400/10 text-accent-400"><Shuffle className="h-4 w-4" /></span>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-400/10 text-accent-400"><Repeat className="h-4 w-4" /></span>
      </div>
      <NowPlayingBars />
      <div className="flex h-6 items-center gap-[3px]">
        {heights.map((height, index) => (
          <span
            key={index}
            className="w-[3px] rounded-full bg-white/30"
            style={{ height, background: index < 12 ? along(index / 19) : undefined }}
          />
        ))}
      </div>
      <div className="grid grid-cols-5 gap-[3px]">
        {[0, 2, 4, 1, 3, 3, 1, 0, 4, 2].map((level, index) => (
          <span
            key={index}
            className="h-3 w-3 rounded-[3px] bg-white/[0.05]"
            style={{ background: level ? `color-mix(in oklab, ${along((index % 5) / 4)} ${alphas[level]}%, transparent)` : undefined }}
          />
        ))}
      </div>
      <span className="rounded-full border border-accent-400/25 bg-accent-400/10 px-2 py-0.5 text-[10px] font-medium text-accent-300">
        Streaming
      </span>
    </div>
  )
}

export default function AppearanceSettings() {
  const accent = useSettingsStore((s) => s.accent)
  const setAccent = useSettingsStore((s) => s.setAccent)
  const [systemHex, setSystemHex] = useState<string | null>(null)
  const persistTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.puros.app.getSystemAccentColor().then((hex) => { if (!cancelled) setSystemHex(hex) })
    const off = window.puros.on('app:accent-color-changed', (hex) => setSystemHex(typeof hex === 'string' ? hex : null))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  useEffect(() => () => {
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
  }, [])

  const choose = (next: AccentSetting) => { void setAccent(next) }

  // Dragging a hue recolours the app live; the setting is written once it settles.
  const chooseLive = (next: AccentSetting) => {
    useSettingsStore.setState({ accent: next })
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null
      void setAccent(next)
    }, 250)
  }

  const customGradient = resolveAccent({ ...accent, mode: 'customGradient' }, null)
  const selectedLabel = (() => {
    switch (accent.mode) {
      case 'system': return `Match system${systemHex ? '' : ' (not available, using Blue)'}`
      case 'custom': return `Custom · ${accent.hue}°`
      case 'gradient': return `${ACCENT_GRADIENTS.find(({ id }) => id === accent.gradient)?.label ?? 'Gradient'} gradient`
      case 'customGradient': return `Custom gradient · ${accent.gradientHues[0]}° → ${accent.gradientHues[1]}°`
      default: return ACCENT_PRESETS.find(({ id }) => id === accent.preset)?.label ?? 'Blue'
    }
  })()

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-1">Accent color</h3>
        <p className="text-xs text-zinc-600 mb-4 max-w-xl">
          Used for active controls like shuffle and repeat, the played part of the waveform, Listening Activity,
          the now-playing indicator and drag-and-drop highlights. Format and signal-path colours keep their own meaning.
        </p>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Swatch
              label="Match system"
              background={systemHex ?? RAINBOW}
              selected={accent.mode === 'system'}
              onSelect={() => choose({ ...accent, mode: 'system' })}
            />
            <span className="h-6 w-px bg-white/10" aria-hidden />
            {ACCENT_PRESETS.map((preset) => (
              <Swatch
                key={preset.id}
                label={preset.label}
                background={preset.hex}
                selected={accent.mode === 'preset' && accent.preset === preset.id}
                onSelect={() => choose({ ...accent, mode: 'preset', preset: preset.id })}
              />
            ))}
            <span className="h-6 w-px bg-white/10" aria-hidden />
            <Swatch
              label="Custom color"
              background={RAINBOW}
              selected={accent.mode === 'custom'}
              onSelect={() => choose({ ...accent, mode: 'custom' })}
            >
              <span className="h-3.5 w-3.5 rounded-full border-2 border-zinc-950" style={{ background: hueToHex(accent.hue) }} />
            </Swatch>
          </div>

          <div>
            <p className="mb-2 text-[11px] uppercase tracking-[0.22em] text-zinc-500">Gradients</p>
            <div className="flex flex-wrap items-center gap-3">
              {ACCENT_GRADIENTS.map((gradient) => (
                <Swatch
                  key={gradient.id}
                  label={`${gradient.label} gradient`}
                  background={`linear-gradient(135deg, ${gradient.from}, ${gradient.to})`}
                  selected={accent.mode === 'gradient' && accent.gradient === gradient.id}
                  onSelect={() => choose({ ...accent, mode: 'gradient', gradient: gradient.id })}
                />
              ))}
              <span className="h-6 w-px bg-white/10" aria-hidden />
              <Swatch
                label="Custom gradient"
                background={RAINBOW}
                selected={accent.mode === 'customGradient'}
                onSelect={() => choose({ ...accent, mode: 'customGradient' })}
              >
                <span className="h-3.5 w-3.5 rounded-full border-2 border-zinc-950" style={{ background: accentBackground(customGradient) }} />
              </Swatch>
            </div>
          </div>
        </div>

        <p className="mt-4 text-sm text-zinc-300">{selectedLabel}</p>

        {accent.mode === 'custom' && (
          <div className="mt-4 max-w-md">
            <HueSlider label="Hue" hue={accent.hue} onChange={(hue) => chooseLive({ ...accent, mode: 'custom', hue })} />
          </div>
        )}
        {accent.mode === 'customGradient' && (
          <div className="mt-4 max-w-md space-y-4">
            <div className="h-2.5 rounded-full" style={{ background: `linear-gradient(90deg, ${customGradient.from}, ${customGradient.to})` }} />
            <HueSlider
              label="Start"
              hue={accent.gradientHues[0]}
              onChange={(hue) => chooseLive({ ...accent, mode: 'customGradient', gradientHues: [hue, accent.gradientHues[1]] })}
            />
            <HueSlider
              label="End"
              hue={accent.gradientHues[1]}
              onChange={(hue) => chooseLive({ ...accent, mode: 'customGradient', gradientHues: [accent.gradientHues[0], hue] })}
            />
          </div>
        )}
      </div>

      <div>
        <h3 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-3">Preview</h3>
        <AccentPreview />
      </div>
    </div>
  )
}
