import { create } from 'zustand'

const STORAGE_KEY = 'purist-custom-visualizer-presets'

function sanitizePreset(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v
  const p = v as Record<string, unknown>
  const sanitized = {
    ...p,
    shapes: Array.isArray(p.shapes) ? p.shapes : [],
    waves: Array.isArray(p.waves) ? p.waves : [],
  }
  return sanitized
}

function loadFromStorage(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, sanitizePreset(v)]))
  } catch {
    return {}
  }
}

const SETTINGS_KEY = 'purist-visualizer-settings'

interface VisualizerSettings {
  cycleInterval: number  // seconds
  randomize: boolean
  brightness: number
  reactivity: number
  showFps: boolean
  renderScale: number
}

const DEFAULT_SETTINGS: VisualizerSettings = { cycleInterval: 25, randomize: true, brightness: 0.8, reactivity: 1, showFps: false, renderScale: 1 }

function clampRenderScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0.25, Math.min(3, value)) : 1
}

function clampIntensity(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

function loadSettings(): VisualizerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const saved = JSON.parse(raw) as Partial<VisualizerSettings> | null
    return {
      ...DEFAULT_SETTINGS, ...saved,
      brightness: clampIntensity(saved?.brightness, DEFAULT_SETTINGS.brightness),
      reactivity: clampIntensity(saved?.reactivity, DEFAULT_SETTINGS.reactivity),
      showFps: typeof saved?.showFps === 'boolean' ? saved.showFps : DEFAULT_SETTINGS.showFps,
      renderScale: clampRenderScale(saved?.renderScale),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveToStorage(presets: Record<string, unknown>): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
    } catch {
      // Storage quota exceeded — silently ignore
    }
  }, 200)
}

function saveSettings({ cycleInterval, randomize, brightness, reactivity, showFps, renderScale }: VisualizerSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ cycleInterval, randomize, brightness, reactivity, showFps, renderScale }))
  } catch {
    // Storage quota exceeded — silently ignore
  }
}

interface VisualizerState extends VisualizerSettings {
  customPresets: Record<string, unknown>
  isDetached: boolean
  addPresets(incoming: Record<string, unknown>): void
  removePreset(name: string): void
  setCycleInterval(seconds: number): void
  setRandomize(on: boolean): void
  setBrightness(value: number): void
  setReactivity(value: number): void
  setShowFps(on: boolean): void
  setRenderScale(value: number): void
  setDetached(detached: boolean): void
}

export const useVisualizerStore = create<VisualizerState>((set, get) => ({
  customPresets: loadFromStorage(),
  ...loadSettings(),
  isDetached: false,

  addPresets(incoming) {
    set((state) => {
      const next = { ...state.customPresets, ...incoming }
      saveToStorage(next)
      return { customPresets: next }
    })
  },

  removePreset(name) {
    set((state) => {
      const next = { ...state.customPresets }
      delete next[name]
      saveToStorage(next)
      return { customPresets: next }
    })
  },

  setCycleInterval(seconds) {
    const clamped = Math.max(5, seconds)
    set({ cycleInterval: clamped })
    saveSettings(get())
  },

  setRandomize(on) {
    set({ randomize: on })
    saveSettings(get())
  },

  setBrightness(value) {
    set({ brightness: clampIntensity(value, DEFAULT_SETTINGS.brightness) })
    saveSettings(get())
  },

  setReactivity(value) {
    set({ reactivity: clampIntensity(value, DEFAULT_SETTINGS.reactivity) })
    saveSettings(get())
  },

  setShowFps(on) {
    set({ showFps: on })
    saveSettings(get())
  },

  setRenderScale(value) {
    set({ renderScale: clampRenderScale(value) })
    saveSettings(get())
  },

  setDetached(detached) {
    set({ isDetached: detached })
  },
}))

// Keep the detached visualizer in sync with changes made in the main window.
if (typeof window !== 'undefined') {
  const syncSettings = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return
    if (event.key === STORAGE_KEY || event.key === null) {
      useVisualizerStore.setState({ customPresets: loadFromStorage() })
    }
    if (event.key === SETTINGS_KEY || event.key === null) {
      useVisualizerStore.setState(loadSettings())
    }
  }
  window.addEventListener('storage', syncSettings)
  import.meta.hot?.dispose(() => window.removeEventListener('storage', syncSettings))
}
