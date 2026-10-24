/**
 * The app's accent colour: active toggles (shuffle, repeat, EQ), the played
 * part of the waveform, listening heatmap, drag-and-drop highlights.
 *
 * It lives in CSS variables on <html>: --accent (solid; Tailwind's accent-*
 * colours in index.css are mixed from it) and --accent-from / --accent-to for
 * the places that draw a gradient accent (waveform, heatmap, now-playing
 * bars). A solid accent sets all three to the same colour. Status colours with a meaning of their own (bit-perfect green,
 * hi-res blue, resampled yellow) are deliberately not accent.
 */

import { useEffect, useState } from 'react'
import { create } from 'zustand'

export type AccentPreset = 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'yellow' | 'green' | 'graphite'
export type AccentGradientPreset = 'sunset' | 'ocean' | 'aurora' | 'grape' | 'ember' | 'twilight'

export interface AccentSetting {
  /**
   * system: follow macOS' accent colour; preset: one of the eight macOS colours;
   * custom: any hue; gradient: a preset gradient; customGradient: between two hues.
   */
  mode: 'system' | 'preset' | 'custom' | 'gradient' | 'customGradient'
  preset: AccentPreset
  /** Hue in degrees for custom mode. */
  hue: number
  gradient: AccentGradientPreset
  /** Start and end hue for customGradient mode. */
  gradientHues: [number, number]
}

/** A resolved accent: a gradient from → to, and its average for solid uses. Solid accents have from = to. */
export interface ResolvedAccent {
  from: string
  to: string
  solid: string
}

/** macOS' accent colours as the system draws them in dark appearance. */
export const ACCENT_PRESETS: ReadonlyArray<{ id: AccentPreset; label: string; hex: string }> = [
  { id: 'blue', label: 'Blue', hex: '#0a84ff' },
  { id: 'purple', label: 'Purple', hex: '#bf5af2' },
  { id: 'pink', label: 'Pink', hex: '#ff375f' },
  { id: 'red', label: 'Red', hex: '#ff453a' },
  { id: 'orange', label: 'Orange', hex: '#ff9f0a' },
  { id: 'yellow', label: 'Yellow', hex: '#ffd60a' },
  { id: 'green', label: 'Green', hex: '#32d74b' },
  { id: 'graphite', label: 'Graphite', hex: '#98989d' },
]

/** Gradients between the macOS colours, so they sit with the solid presets. */
export const ACCENT_GRADIENTS: ReadonlyArray<{ id: AccentGradientPreset; label: string; from: string; to: string }> = [
  { id: 'sunset', label: 'Sunset', from: '#ff375f', to: '#ff9f0a' },
  { id: 'ember', label: 'Ember', from: '#ff453a', to: '#ffd60a' },
  { id: 'grape', label: 'Grape', from: '#bf5af2', to: '#ff375f' },
  { id: 'twilight', label: 'Twilight', from: '#0a84ff', to: '#bf5af2' },
  { id: 'ocean', label: 'Ocean', from: '#0a84ff', to: '#64d2ff' },
  { id: 'aurora', label: 'Aurora', from: '#32d74b', to: '#0a84ff' },
]

export const DEFAULT_ACCENT: AccentSetting = {
  mode: 'preset',
  preset: 'blue',
  hue: 211,
  gradient: 'sunset',
  gradientHues: [330, 30],
}

const PRESET_IDS = new Set<string>(ACCENT_PRESETS.map(({ id }) => id))
const GRADIENT_IDS = new Set<string>(ACCENT_GRADIENTS.map(({ id }) => id))
const MODES = new Set<string>(['system', 'preset', 'custom', 'gradient', 'customGradient'])

function normalizeHue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? ((Math.round(value) % 360) + 360) % 360 : fallback
}

export function parseAccentSetting(raw: string | null): AccentSetting {
  if (!raw) return DEFAULT_ACCENT
  try {
    const value = JSON.parse(raw) as Partial<AccentSetting>
    const hues = Array.isArray(value.gradientHues) ? value.gradientHues : []
    return {
      mode: typeof value.mode === 'string' && MODES.has(value.mode) ? value.mode : 'preset',
      preset: typeof value.preset === 'string' && PRESET_IDS.has(value.preset) ? value.preset : DEFAULT_ACCENT.preset,
      hue: normalizeHue(value.hue, DEFAULT_ACCENT.hue),
      gradient: typeof value.gradient === 'string' && GRADIENT_IDS.has(value.gradient) ? value.gradient : DEFAULT_ACCENT.gradient,
      gradientHues: [normalizeHue(hues[0], DEFAULT_ACCENT.gradientHues[0]), normalizeHue(hues[1], DEFAULT_ACCENT.gradientHues[1])],
    }
  } catch {
    return DEFAULT_ACCENT
  }
}

/** A custom hue at the saturation and lightness of the macOS colours, so it reads on the dark UI. */
export function hueToHex(hue: number): string {
  const s = 0.9
  const l = 0.58
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const h = (((hue % 360) + 360) % 360) / 60
  const x = chroma * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] = h < 1 ? [chroma, x, 0] : h < 2 ? [x, chroma, 0] : h < 3 ? [0, chroma, x] : h < 4 ? [0, x, chroma] : h < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const m = l - chroma / 2
  return `#${[r, g, b].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`
}

export function resolveAccent(setting: AccentSetting, systemHex: string | null): ResolvedAccent {
  const solid = (hex: string): ResolvedAccent => ({ from: hex, to: hex, solid: hex })
  const gradient = (from: string, to: string): ResolvedAccent => ({ from, to, solid: mixHex(from, to, 0.5) })
  switch (setting.mode) {
    case 'custom':
      return solid(hueToHex(setting.hue))
    case 'system':
      if (systemHex) return solid(systemHex)
      break
    case 'gradient': {
      const preset = ACCENT_GRADIENTS.find(({ id }) => id === setting.gradient) ?? ACCENT_GRADIENTS[0]
      return gradient(preset.from, preset.to)
    }
    case 'customGradient':
      return gradient(hueToHex(setting.gradientHues[0]), hueToHex(setting.gradientHues[1]))
  }
  return solid(ACCENT_PRESETS.find(({ id }) => id === setting.preset)?.hex ?? ACCENT_PRESETS[0].hex)
}

/** CSS for an accent as a swatch / preview background. */
export function accentBackground({ from, to }: ResolvedAccent): string {
  return from === to ? from : `linear-gradient(135deg, ${from}, ${to})`
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.replace('#', '').slice(0, 6), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/** Blend two hex colours; t = 0 gives a, 1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const from = hexToRgb(a)
  const to = hexToRgb(b)
  const channel = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${channel(from.r, to.r)}${channel(from.g, to.g)}${channel(from.b, to.b)}`
}

/** The resolved accent, for code that draws without CSS (the waveform canvas). */
export const useAccentStore = create<ResolvedAccent>(() => ({
  from: ACCENT_PRESETS[0].hex,
  to: ACCENT_PRESETS[0].hex,
  solid: ACCENT_PRESETS[0].hex,
}))

export function applyAccent(accent: ResolvedAccent) {
  const root = document.documentElement.style
  root.setProperty('--accent', accent.solid)
  root.setProperty('--accent-from', accent.from)
  root.setProperty('--accent-to', accent.to)
  useAccentStore.setState(accent)
}

/**
 * Keeps --accent in sync with the setting; in system mode it also follows
 * changes made in macOS System Settings while the app is open.
 */
export function useAccentColorSync(setting: AccentSetting) {
  const [systemHex, setSystemHex] = useState<string | null>(null)

  useEffect(() => {
    if (setting.mode !== 'system') return
    let cancelled = false
    void window.puros.app.getSystemAccentColor().then((hex) => { if (!cancelled) setSystemHex(hex) })
    const off = window.puros.on('app:accent-color-changed', (hex) => {
      setSystemHex(typeof hex === 'string' ? hex : null)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [setting.mode])

  useEffect(() => {
    applyAccent(resolveAccent(setting, systemHex))
  }, [setting, systemHex])
}
