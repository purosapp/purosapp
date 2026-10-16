import { create } from 'zustand'
import type { AutoEQProfile } from '../services/autoeq/AutoEQParser'
import { getJsonSetting, setJsonSetting } from '../utils/appSettings'
import type { AudioPlugin } from '../types/plugins'

// ---------------------------------------------------------------------------
// Parametric EQ band
// ---------------------------------------------------------------------------

export interface PEQBand {
  id: string
  type: 'peaking' | 'lowShelf' | 'highShelf'
  frequency: number  // Hz
  gain: number       // dB
  q: number
  enabled: boolean
}

export interface ParametricEQPreset {
  name: string
  preamp: number
  bands: PEQBand[]
}

export interface CrossfeedSettings {
  enabled: boolean
  cutoffFrequency: number
  feedLevelDb: number
}

export const PEQ_LIMITS = {
  frequency: { min: 20, max: 20000 },
  gain: { min: -20, max: 20 },
  q: { min: 0.1, max: 10 },
  preamp: { min: -12, max: 12 },
} as const

export const CROSSFEED_LIMITS = {
  cutoffFrequency: { min: 300, max: 2000 },
  feedLevelDb: { min: 1, max: 15 },
  defaults: {
    cutoffFrequency: 700,
    feedLevelDb: 5,
  },
} as const

let _bandCounter = 0
export const newBandId = () => `peq-${++_bandCounter}`

const DSP_SETTINGS_KEY = 'dsp:state'
const PLUGINS_SETTINGS_KEY = 'dsp:plugins'
let pluginChangeListenerRegistered = false

interface PersistedDSPState {
  eqEnabled: boolean
  activeProfile: AutoEQProfile | null
  peqEnabled: boolean
  peqBands: PEQBand[]
  peqPreamp: number
  peqPresets: ParametricEQPreset[]
  activePEQPresetName: string | null
  crossfeedEnabled: boolean
  crossfeedCutoffFrequency: number
  crossfeedFeedLevelDb: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function sanitizePreamp(value: number) {
  if (!Number.isFinite(value)) return 0
  return clamp(value, PEQ_LIMITS.preamp.min, PEQ_LIMITS.preamp.max)
}

function sanitizeCrossfeedCutoffFrequency(value: number) {
  if (!Number.isFinite(value)) return CROSSFEED_LIMITS.defaults.cutoffFrequency
  return clamp(value, CROSSFEED_LIMITS.cutoffFrequency.min, CROSSFEED_LIMITS.cutoffFrequency.max)
}

function sanitizeCrossfeedFeedLevelDb(value: number) {
  if (!Number.isFinite(value)) return CROSSFEED_LIMITS.defaults.feedLevelDb
  return clamp(value, CROSSFEED_LIMITS.feedLevelDb.min, CROSSFEED_LIMITS.feedLevelDb.max)
}

export function sanitizePEQBand(band: PEQBand): PEQBand {
  return {
    ...band,
    frequency: Number.isFinite(band.frequency)
      ? clamp(band.frequency, PEQ_LIMITS.frequency.min, PEQ_LIMITS.frequency.max)
      : 1000,
    gain: Number.isFinite(band.gain)
      ? clamp(band.gain, PEQ_LIMITS.gain.min, PEQ_LIMITS.gain.max)
      : 0,
    q: Number.isFinite(band.q)
      ? clamp(band.q, PEQ_LIMITS.q.min, PEQ_LIMITS.q.max)
      : 1,
  }
}

function sanitizePEQBands(bands: PEQBand[]) {
  return bands.map(sanitizePEQBand)
}

function sanitizePresetName(name: string) {
  return name.trim().replace(/\s+/g, ' ').slice(0, 80)
}

function normalizeBandType(value: string): PEQBand['type'] | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'peaking' || normalized === 'pk') return 'peaking'
  if (normalized === 'lowshelf' || normalized === 'low_shelf' || normalized === 'low-shelf' || normalized === 'ls') return 'lowShelf'
  if (normalized === 'highshelf' || normalized === 'high_shelf' || normalized === 'high-shelf' || normalized === 'hs') return 'highShelf'
  return null
}

function cloneBandsWithFreshIds(bands: PEQBand[]) {
  return sanitizePEQBands(bands).map((band) => ({ ...band, id: newBandId() }))
}

function syncBandCounterFromBands(bands: PEQBand[]) {
  for (const band of bands) {
    const match = band.id.match(/^peq-(\d+)$/)
    if (!match) continue
    const id = Number.parseInt(match[1], 10)
    if (Number.isFinite(id)) {
      _bandCounter = Math.max(_bandCounter, id)
    }
  }
}

function normalizePersistedBands(value: unknown): PEQBand[] {
  if (!Array.isArray(value)) return []

  const normalized: PEQBand[] = []
  for (const band of value) {
    if (!band || typeof band !== 'object') continue
    const candidate = band as Partial<PEQBand>
    if (
      typeof candidate.id !== 'string' ||
      (candidate.type !== 'peaking' && candidate.type !== 'lowShelf' && candidate.type !== 'highShelf') ||
      typeof candidate.frequency !== 'number' ||
      typeof candidate.gain !== 'number' ||
      typeof candidate.q !== 'number' ||
      typeof candidate.enabled !== 'boolean'
    ) {
      continue
    }
    normalized.push(sanitizePEQBand(candidate as PEQBand))
  }

  return normalized
}

function normalizePreset(value: unknown): ParametricEQPreset | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ParametricEQPreset> & {
    peqPreamp?: unknown
    peqBands?: unknown
  }

  const name = typeof candidate.name === 'string' ? sanitizePresetName(candidate.name) : ''
  if (!name) return null

  const preamp = sanitizePreamp(
    typeof candidate.preamp === 'number'
      ? candidate.preamp
      : typeof candidate.peqPreamp === 'number'
        ? candidate.peqPreamp
        : 0
  )

  const bands = normalizePersistedBands(Array.isArray(candidate.bands) ? candidate.bands : candidate.peqBands)
  return {
    name,
    preamp,
    bands,
  }
}

function normalizePersistedPresets(value: unknown): ParametricEQPreset[] {
  if (!Array.isArray(value)) return []
  const presets = value
    .map(normalizePreset)
    .filter((preset): preset is ParametricEQPreset => preset !== null)

  const deduped = new Map<string, ParametricEQPreset>()
  for (const preset of presets) deduped.set(preset.name.toLowerCase(), preset)
  return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function parseApoList(text: string, defaultName: string): ParametricEQPreset | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return null

  let name = defaultName
  let preamp = 0
  const bands: PEQBand[] = []

  for (const line of lines) {
    const nameMatch = line.match(/^(?:name|preset)\s*:\s*(.+)$/i)
    if (nameMatch) {
      const parsedName = sanitizePresetName(nameMatch[1] ?? '')
      if (parsedName) name = parsedName
      continue
    }

    const preampMatch = line.match(/^preamp\s*:\s*([+-]?\d+(?:\.\d+)?)\s*dB?$/i)
    if (preampMatch) {
      preamp = sanitizePreamp(Number.parseFloat(preampMatch[1] ?? '0'))
      continue
    }

    const filterMatch = line.match(
      /^filter\s+\d+\s*:\s*(on|off)\s+(\w+)\s+fc\s+([+-]?\d+(?:\.\d+)?)\s*hz\s+gain\s+([+-]?\d+(?:\.\d+)?)\s*dB\s+q\s+([+-]?\d+(?:\.\d+)?)$/i
    )
    if (!filterMatch) continue

    const type = normalizeBandType(filterMatch[2] ?? '')
    if (!type) continue
    bands.push(sanitizePEQBand({
      id: newBandId(),
      type,
      frequency: Number.parseFloat(filterMatch[3] ?? '1000'),
      gain: Number.parseFloat(filterMatch[4] ?? '0'),
      q: Number.parseFloat(filterMatch[5] ?? '1'),
      enabled: (filterMatch[1] ?? '').toLowerCase() === 'on',
    }))
  }

  if (bands.length === 0) return null
  return { name: sanitizePresetName(name) || defaultName, preamp, bands }
}

function parseJsonPresets(text: string): ParametricEQPreset[] | null {
  try {
    const data = JSON.parse(text) as unknown
    if (Array.isArray(data)) {
      return data.map(normalizePreset).filter((preset): preset is ParametricEQPreset => preset !== null)
    }

    const directPreset = normalizePreset(data)
    if (directPreset) return [directPreset]

    if (data && typeof data === 'object') {
      const candidate = data as {
        presets?: unknown
        items?: unknown
      }
      if (Array.isArray(candidate.presets)) {
        return candidate.presets.map(normalizePreset).filter((preset): preset is ParametricEQPreset => preset !== null)
      }
      if (Array.isArray(candidate.items)) {
        return candidate.items.map(normalizePreset).filter((preset): preset is ParametricEQPreset => preset !== null)
      }
    }
  } catch {
    return null
  }

  return []
}

export function parsePEQPresetImport(text: string, fallbackName = 'Imported preset'): ParametricEQPreset[] {
  const jsonPresets = parseJsonPresets(text)
  if (jsonPresets && jsonPresets.length > 0) return normalizePersistedPresets(jsonPresets)

  const apoPreset = parseApoList(text, sanitizePresetName(fallbackName) || 'Imported preset')
  if (apoPreset) return [apoPreset]

  throw new Error('Could not parse preset data. Use JSON or Equalizer APO filter lines.')
}

export function exportPEQPresetAsText(preset: ParametricEQPreset): string {
  const lines = [
    `Name: ${preset.name}`,
    `Preamp: ${sanitizePreamp(preset.preamp).toFixed(1)} dB`,
  ]

  preset.bands.forEach((band, index) => {
    const type = band.type === 'peaking' ? 'PK' : band.type === 'lowShelf' ? 'LS' : 'HS'
    lines.push(
      `Filter ${index + 1}: ${band.enabled ? 'ON' : 'OFF'} ${type} Fc ${band.frequency.toFixed(1)} Hz Gain ${band.gain.toFixed(1)} dB Q ${band.q.toFixed(2)}`
    )
  })

  return lines.join('\n')
}

export function exportPEQPresetsAsJson(presets: ParametricEQPreset[]): string {
  return JSON.stringify(
    {
      version: 1,
      presets: presets.map((preset) => ({
        name: preset.name,
        preamp: sanitizePreamp(preset.preamp),
        bands: preset.bands.map((band) => {
          const sanitized = sanitizePEQBand({ ...band, id: 'export-band' })
          return {
            type: sanitized.type,
            frequency: sanitized.frequency,
            gain: sanitized.gain,
            q: sanitized.q,
            enabled: sanitized.enabled,
          }
        }),
      })),
    },
    null,
    2
  )
}

function normalizePersistedProfile(value: unknown): AutoEQProfile | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AutoEQProfile>
  if (typeof candidate.name !== 'string' || typeof candidate.preampGain !== 'number') {
    return null
  }

  const bands = Array.isArray(candidate.bands)
    ? candidate.bands.filter((band) =>
      !!band &&
      typeof band === 'object' &&
      ((band as { type?: string }).type === 'peaking' ||
        (band as { type?: string }).type === 'lowShelf' ||
        (band as { type?: string }).type === 'highShelf') &&
      typeof (band as { frequency?: unknown }).frequency === 'number' &&
      typeof (band as { gain?: unknown }).gain === 'number' &&
      typeof (band as { q?: unknown }).q === 'number'
    ) as AutoEQProfile['bands']
    : []

  return {
    name: candidate.name,
    preampGain: candidate.preampGain,
    bands,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface DSPState {
  plugins: AudioPlugin[]
  setPlugins: (plugins: AudioPlugin[]) => Promise<void>
  setPluginParameter: (index: number, id: number, value: number) => Promise<void>
  // AutoEQ
  eqEnabled: boolean
  activeProfile: AutoEQProfile | null
  // Manual PEQ
  peqEnabled: boolean
  peqBands: PEQBand[]
  peqPreamp: number
  peqPresets: ParametricEQPreset[]
  activePEQPresetName: string | null
  // Crossfeed
  crossfeedEnabled: boolean
  crossfeedCutoffFrequency: number
  crossfeedFeedLevelDb: number
  hydrated: boolean
  // Low-level setter — updates state only, does NOT call native engine.
  // Use this for batching; call syncToEngine() manually afterwards.
  applyState: (patch: Partial<Pick<DSPState, 'eqEnabled' | 'activeProfile' | 'peqEnabled' | 'peqBands' | 'peqPreamp' | 'activePEQPresetName' | 'crossfeedEnabled' | 'crossfeedCutoffFrequency' | 'crossfeedFeedLevelDb'>>) => void
  // Merge both profiles and push the result to the native audio engine.
  syncToEngine: () => Promise<void>
  hydrate: () => Promise<void>
  // Convenience actions that update state AND sync to engine.
  setEQEnabled: (v: boolean) => Promise<void>
  setActiveProfile: (p: AutoEQProfile | null) => Promise<void>
  setPEQEnabled: (v: boolean) => Promise<void>
  setPEQBands: (bands: PEQBand[]) => Promise<void>
  setPEQPreamp: (db: number) => Promise<void>
  setCrossfeedEnabled: (v: boolean) => Promise<void>
  setCrossfeedCutoffFrequency: (hz: number) => Promise<void>
  setCrossfeedFeedLevelDb: (db: number) => Promise<void>
  saveCurrentPEQPreset: (name: string) => Promise<ParametricEQPreset>
  loadPEQPreset: (name: string) => Promise<void>
  deletePEQPreset: (name: string) => Promise<void>
  importPEQPresets: (presets: ParametricEQPreset[]) => Promise<ParametricEQPreset[]>
}

function getPersistedState(state: Pick<DSPState, 'eqEnabled' | 'activeProfile' | 'peqEnabled' | 'peqBands' | 'peqPreamp' | 'peqPresets' | 'activePEQPresetName' | 'crossfeedEnabled' | 'crossfeedCutoffFrequency' | 'crossfeedFeedLevelDb'>): PersistedDSPState {
  return {
    eqEnabled: state.eqEnabled,
    activeProfile: state.activeProfile,
    peqEnabled: state.peqEnabled,
    peqBands: state.peqBands,
    peqPreamp: state.peqPreamp,
    peqPresets: state.peqPresets,
    activePEQPresetName: state.activePEQPresetName,
    crossfeedEnabled: state.crossfeedEnabled,
    crossfeedCutoffFrequency: state.crossfeedCutoffFrequency,
    crossfeedFeedLevelDb: state.crossfeedFeedLevelDb,
  }
}

export const useDSPStore = create<DSPState>((set, get) => {
  const persistState = async () => {
    await setJsonSetting(DSP_SETTINGS_KEY, getPersistedState(get()))
  }

  /** Build the combined band list and push to the native engine. */
  const syncToEngine = async () => {
    const {
      eqEnabled,
      activeProfile,
      peqEnabled,
      peqBands,
      peqPreamp,
      crossfeedEnabled,
      crossfeedCutoffFrequency,
      crossfeedFeedLevelDb,
    } = get()

    const autoBands = eqEnabled && activeProfile
      ? activeProfile.bands.map(b => ({ type: b.type, freq: b.frequency, gain: b.gain, q: b.q }))
      : []

    const manualBands = peqEnabled
      ? peqBands
          .filter(b => b.enabled)
          .map(b => ({ type: b.type, freq: b.frequency, gain: b.gain, q: b.q }))
      : []

    const allBands = [...autoBands, ...manualBands]
    const totalPreamp =
      (eqEnabled && activeProfile ? activeProfile.preampGain : 0) +
      (peqEnabled ? peqPreamp : 0)

    await window.puros.dsp.setCrossfeed(
      crossfeedEnabled,
      sanitizeCrossfeedCutoffFrequency(crossfeedCutoffFrequency),
      sanitizeCrossfeedFeedLevelDb(crossfeedFeedLevelDb),
    )

    if (allBands.length > 0 || crossfeedEnabled) {
      await window.puros.dsp.setEQProfile(allBands, totalPreamp)
      await window.puros.dsp.setEQEnabled(true)
    } else {
      await window.puros.dsp.setEQEnabled(false)
      await window.puros.dsp.clearEQProfile()
    }

    await persistState()
  }

  const hydrate = async () => {
    if (get().hydrated) return

    const persisted = await getJsonSetting<PersistedDSPState | null>(DSP_SETTINGS_KEY, null)
    const storedPlugins = await getJsonSetting<AudioPlugin[]>(PLUGINS_SETTINGS_KEY, [])
    const plugins = Array.isArray(storedPlugins) ? storedPlugins.filter((plugin) =>
      typeof plugin?.path === 'string' && /\.vst3?$/.test(plugin.path) &&
      typeof plugin.name === 'string' && typeof plugin.enabled === 'boolean'
    ).slice(0, 16).map((plugin) => ({
      ...plugin,
      parameters: Object.fromEntries(Object.entries(plugin.parameters ?? {}).filter(([id, value]) =>
        /^\d+$/.test(id) && Number(id) <= 0xffffffff &&
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)),
    })) : []
    const peqBands = normalizePersistedBands(persisted?.peqBands)
    const peqPresets = normalizePersistedPresets(persisted?.peqPresets)
    syncBandCounterFromBands(peqBands)
    peqPresets.forEach((preset) => syncBandCounterFromBands(preset.bands))

    const activePEQPresetName = typeof persisted?.activePEQPresetName === 'string'
      ? peqPresets.find((preset) => preset.name === persisted.activePEQPresetName)?.name ?? null
      : null

    set({
      plugins,
      eqEnabled: persisted?.eqEnabled ?? false,
      activeProfile: normalizePersistedProfile(persisted?.activeProfile),
      peqEnabled: (persisted?.peqEnabled ?? false) && peqBands.length > 0,
      peqBands,
      peqPreamp: sanitizePreamp(persisted?.peqPreamp ?? 0),
      peqPresets,
      activePEQPresetName,
      crossfeedEnabled: persisted?.crossfeedEnabled ?? false,
      crossfeedCutoffFrequency: sanitizeCrossfeedCutoffFrequency(
        persisted?.crossfeedCutoffFrequency ?? CROSSFEED_LIMITS.defaults.cutoffFrequency
      ),
      crossfeedFeedLevelDb: sanitizeCrossfeedFeedLevelDb(
        persisted?.crossfeedFeedLevelDb ?? CROSSFEED_LIMITS.defaults.feedLevelDb
      ),
      hydrated: true,
    })

    await syncToEngine()
    try {
      await window.puros.dsp.setPlugins(plugins)
    } catch (error) {
      console.warn('Saved VST stack could not be loaded:', error)
      const bypassed = plugins.map((plugin) => ({ ...plugin, enabled: false }))
      await window.puros.dsp.setPlugins(bypassed)
      set({ plugins: bypassed })
      await setJsonSetting(PLUGINS_SETTINGS_KEY, bypassed)
    }
    if (!pluginChangeListenerRegistered) {
      pluginChangeListenerRegistered = true
      window.puros.on('dsp:plugin-parameter-changed', (...args) => {
        const [index, id, value] = args
        if (typeof index !== 'number' || !Number.isInteger(index) ||
            typeof id !== 'number' || !Number.isInteger(id) ||
            typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 ||
            index < 0 || index >= get().plugins.length) return
        set({ plugins: get().plugins.map((plugin, i) => i === index ? {
          ...plugin,
          parameters: { ...plugin.parameters, [String(id)]: value },
        } : plugin) })
        void setJsonSetting(PLUGINS_SETTINGS_KEY, get().plugins)
      })
      // The plug-in window was saved with its bypass switch off.
      window.puros.on('dsp:plugin-disabled', (...args) => {
        const [index] = args
        const plugins = get().plugins
        if (typeof index !== 'number' || !Number.isInteger(index) ||
            index < 0 || index >= plugins.length || !plugins[index].enabled) return
        void get().setPlugins(plugins.map((plugin, i) => i === index ? { ...plugin, enabled: false } : plugin))
          .catch((error) => console.warn('Could not disable bypassed plug-in:', error))
      })
    }
  }

  return {
    plugins: [],
    setPlugins: async (plugins) => {
      await window.puros.dsp.setPlugins(plugins)
      set({ plugins })
      await setJsonSetting(PLUGINS_SETTINGS_KEY, plugins)
    },
    setPluginParameter: async (index, id, value) => {
      if (!Number.isInteger(index) || index < 0 || index >= get().plugins.length ||
          !Number.isInteger(id) || !Number.isFinite(value)) return
      await window.puros.dsp.setPluginParameter(index, id, value)
      const plugins = get().plugins.map((plugin, i) => i === index ? {
        ...plugin,
        parameters: { ...plugin.parameters, [String(id)]: value },
      } : plugin)
      set({ plugins })
      await setJsonSetting(PLUGINS_SETTINGS_KEY, plugins)
    },
    eqEnabled: false,
    activeProfile: null,
    peqEnabled: false,
    peqBands: [],
    peqPreamp: 0,
    peqPresets: [],
    activePEQPresetName: null,
    crossfeedEnabled: false,
    crossfeedCutoffFrequency: CROSSFEED_LIMITS.defaults.cutoffFrequency,
    crossfeedFeedLevelDb: CROSSFEED_LIMITS.defaults.feedLevelDb,
    hydrated: false,

    applyState: (patch) => set(patch),
    syncToEngine,
    hydrate,

    setEQEnabled: async (eqEnabled) => { set({ eqEnabled }); await syncToEngine() },
    setActiveProfile: async (activeProfile) => { set({ activeProfile }); await syncToEngine() },
    setPEQEnabled: async (peqEnabled) => { set({ peqEnabled }); await syncToEngine() },
    setPEQBands: async (peqBands) => {
      const nextBands = sanitizePEQBands(peqBands)
      syncBandCounterFromBands(nextBands)
      set({
        peqBands: nextBands,
        peqEnabled: nextBands.length > 0 ? get().peqEnabled : false,
        activePEQPresetName: null,
      })
      await syncToEngine()
    },
    setPEQPreamp: async (peqPreamp) => {
      set({ peqPreamp: sanitizePreamp(peqPreamp), activePEQPresetName: null })
      await syncToEngine()
    },
    setCrossfeedEnabled: async (crossfeedEnabled) => {
      set({ crossfeedEnabled })
      await syncToEngine()
    },
    setCrossfeedCutoffFrequency: async (crossfeedCutoffFrequency) => {
      set({ crossfeedCutoffFrequency: sanitizeCrossfeedCutoffFrequency(crossfeedCutoffFrequency) })
      await syncToEngine()
    },
    setCrossfeedFeedLevelDb: async (crossfeedFeedLevelDb) => {
      set({ crossfeedFeedLevelDb: sanitizeCrossfeedFeedLevelDb(crossfeedFeedLevelDb) })
      await syncToEngine()
    },
    saveCurrentPEQPreset: async (name) => {
      const presetName = sanitizePresetName(name)
      if (!presetName) throw new Error('Preset name cannot be empty.')

      const current = get()
      const preset: ParametricEQPreset = {
        name: presetName,
        preamp: sanitizePreamp(current.peqPreamp),
        bands: cloneBandsWithFreshIds(current.peqBands),
      }

      const peqPresets = [...current.peqPresets.filter((entry) => entry.name.toLowerCase() !== presetName.toLowerCase()), preset]
        .sort((a, b) => a.name.localeCompare(b.name))

      set({ peqPresets, activePEQPresetName: preset.name })
      await persistState()
      return preset
    },
    loadPEQPreset: async (name) => {
      const preset = get().peqPresets.find((entry) => entry.name === name)
      if (!preset) throw new Error('Preset not found.')
      const nextBands = cloneBandsWithFreshIds(preset.bands)
      syncBandCounterFromBands(nextBands)
      set({
        peqBands: nextBands,
        peqPreamp: sanitizePreamp(preset.preamp),
        peqEnabled: nextBands.length > 0,
        activePEQPresetName: preset.name,
      })
      await syncToEngine()
    },
    deletePEQPreset: async (name) => {
      const current = get()
      const peqPresets = current.peqPresets.filter((entry) => entry.name !== name)
      set({
        peqPresets,
        activePEQPresetName: current.activePEQPresetName === name ? null : current.activePEQPresetName,
      })
      await persistState()
    },
    importPEQPresets: async (presets) => {
      const normalized = normalizePersistedPresets(presets)
      if (normalized.length === 0) return []
      const merged = new Map<string, ParametricEQPreset>()
      for (const preset of get().peqPresets) merged.set(preset.name.toLowerCase(), preset)
      for (const preset of normalized) {
        merged.set(preset.name.toLowerCase(), {
          ...preset,
          bands: cloneBandsWithFreshIds(preset.bands),
        })
      }
      const peqPresets = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
      set({ peqPresets })
      await persistState()
      return normalized
    },
  }
})
