import { ArrowDown, ArrowUp, SlidersVertical, X } from 'lucide-react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { CROSSFEED_LIMITS, useDSPStore } from '../store/dspStore'
import { parseAutoEQ } from '../services/autoeq/AutoEQParser'
import ParametricEQPanel from './ParametricEQPanel'
import { getJsonSetting, getStringSetting, setJsonSetting, setStringSetting } from '../utils/appSettings'
import type { AudioPluginParameter, InstalledAudioPlugin } from '../types/plugins'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutoEQEntry {
  name: string
  source: string
  downloadUrl: string
}

interface RecentEntry {
  name: string
  source: string
  downloadUrl: string
}

const RECENT_KEY = 'ui:eqAutoEqRecent'
const TOP_TAB_KEY = 'ui:eqTopTab'
const AUTOEQ_SUB_TAB_KEY = 'ui:eqAutoEqSubTab'
const MAX_RECENT = 5

async function loadRecent(): Promise<RecentEntry[]> {
  const recent = await getJsonSetting<RecentEntry[]>(RECENT_KEY, [])
  return recent.filter((entry) =>
    typeof entry?.name === 'string' &&
    typeof entry?.source === 'string' &&
    typeof entry?.downloadUrl === 'string'
  )
}

async function saveRecent(entry: RecentEntry): Promise<RecentEntry[]> {
  const prev = await loadRecent()
  const next = [entry, ...prev.filter((recent) => recent.downloadUrl !== entry.downloadUrl)].slice(0, MAX_RECENT)
  await setJsonSetting(RECENT_KEY, next)
  return next
}

// ---------------------------------------------------------------------------
// Profile info card
// ---------------------------------------------------------------------------

function ProfileInfo({ name, bands, preampGain }: {
  name: string
  bands: { type: string; frequency: number; gain: number; q: number }[]
  preampGain: number
}) {
  return (
    <div className="bg-zinc-800/50 rounded-md p-2 space-y-1">
      <p className="text-xs text-zinc-200 font-medium truncate">{name}</p>
      <p className="text-[10px] text-zinc-500 font-mono">
        {bands.length} bands · preamp {preampGain > 0 ? '+' : ''}{preampGain.toFixed(1)} dB
      </p>
      <div className="max-h-24 overflow-y-auto space-y-px">
        {bands.map((band, i) => (
          <div key={i} className="flex items-center justify-between text-[10px] font-mono text-zinc-500 px-0.5">
            <span className="w-6 text-zinc-600">{i + 1}</span>
            <span className="w-8 text-zinc-400">
              {band.type === 'lowShelf' ? 'LS' : band.type === 'highShelf' ? 'HS' : 'PK'}
            </span>
            <span className="w-16 text-right">
              {band.frequency >= 1000
                ? `${(band.frequency / 1000).toFixed(1)}k`
                : Math.round(band.frequency)} Hz
            </span>
            <span className={`w-14 text-right ${band.gain > 0 ? 'text-red-400/70' : 'text-green-400/70'}`}>
              {band.gain > 0 ? '+' : ''}{band.gain.toFixed(1)} dB
            </span>
            <span className="w-10 text-right">Q {band.q.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Browse tab (AutoEQ preset search)
// ---------------------------------------------------------------------------

function ResultRow({ name, source, applying, onApply }: {
  name: string; source: string; applying: boolean; onApply: () => void
}) {
  return (
    <button
      onClick={onApply}
      disabled={applying}
      className="w-full text-left px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors group"
    >
      <p className="text-xs text-zinc-200 group-hover:text-white truncate">
        {applying ? <span className="text-zinc-500">Loading…</span> : name}
      </p>
      <p className="text-[10px] text-zinc-600 truncate">{source}</p>
    </button>
  )
}

function BrowseTab({ onApply }: { onApply: (name: string, source: string, url: string) => Promise<void> }) {
  const [indexState, setIndexState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [indexError, setIndexError] = useState<string | null>(null)
  const [allEntries, setAllEntries] = useState<AutoEQEntry[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AutoEQEntry[]>([])
  const [applying, setApplying] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void loadRecent().then((entries) => {
      if (!cancelled) setRecent(entries)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (indexState !== 'idle') return
    setIndexState('loading')
    window.puros.autoeq.buildIndex().then(res => {
      if (res.success && res.entries) {
        setAllEntries(res.entries)
        setIndexState('ready')
        setTimeout(() => inputRef.current?.focus(), 50)
      } else {
        setIndexState('error')
        setIndexError(
          res.rateLimited
            ? 'GitHub rate limit reached. Try again in an hour or use file import.'
            : `Failed to load preset library: ${res.error ?? 'unknown error'}`
        )
      }
    }).catch(() => {
      setIndexState('error')
      setIndexError('No internet connection. Use file import instead.')
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsub = window.puros.on('autoeq:index-updated', (data: unknown) => {
      const { entries } = data as { count: number; entries: AutoEQEntry[] }
      setAllEntries(entries)
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const q = query.toLowerCase()
    setResults(allEntries.filter(e => e.name.toLowerCase().includes(q)).slice(0, 30))
  }, [query, allEntries])

  const apply = useCallback(async (name: string, source: string, url: string) => {
    setApplying(url)
    setApplyError(null)
    await onApply(name, source, url)
    setApplying(null)
    const nextRecent = await saveRecent({ name, source, downloadUrl: url })
    setRecent(nextRecent)
  }, [onApply])

  if (indexState === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2">
        <div className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        <p className="text-[10px] text-zinc-500">Loading preset library…</p>
      </div>
    )
  }
  if (indexState === 'error') {
    return <div className="py-4 px-1"><p className="text-[11px] text-yellow-400/80">{indexError}</p></div>
  }

  const showRecent = !query.trim() && recent.length > 0
  const displayList = query.trim() ? results : []

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={`Search ${allEntries.length.toLocaleString()} presets…`}
        className="w-full bg-zinc-800 text-zinc-200 text-xs font-mono px-3 py-2 rounded-md outline-none focus:ring-1 focus:ring-zinc-600 placeholder-zinc-600"
      />
      {applyError && <p className="text-[10px] text-red-400 px-1">{applyError}</p>}
      {showRecent && (
        <div>
          <p className="text-[10px] text-zinc-600 uppercase tracking-wider px-1 mb-1">Recent</p>
          <div className="space-y-px">
            {recent.map(r => (
              <ResultRow key={r.downloadUrl} name={r.name} source={r.source}
                applying={applying === r.downloadUrl}
                onApply={() => apply(r.name, r.source, r.downloadUrl)} />
            ))}
          </div>
        </div>
      )}
      {query.trim() && displayList.length === 0 && (
        <p className="text-[11px] text-zinc-600 text-center py-3">No results</p>
      )}
      {displayList.length > 0 && (
        <div className="space-y-px max-h-48 overflow-y-auto">
          {displayList.map(entry => (
            <ResultRow key={entry.downloadUrl} name={entry.name} source={entry.source}
              applying={applying === entry.downloadUrl}
              onApply={() => apply(entry.name, entry.source, entry.downloadUrl)} />
          ))}
          {results.length === 30 && (
            <p className="text-[10px] text-zinc-600 text-center py-1">Showing 30 of many — refine your search</p>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File import tab
// ---------------------------------------------------------------------------

function FileTab({ onApply }: { onApply: (text: string, name: string) => Promise<void> }) {
  const [loading, setLoading] = useState(false)
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-zinc-500 leading-relaxed">
        Load an <span className="text-zinc-400">AutoEQ ParametricEQ.txt</span> file exported from the AutoEQ website or GitHub repository.
      </p>
      <button
        onClick={async () => {
          setLoading(true)
          const text = await window.puros.dsp.loadEQFile()
          setLoading(false)
          if (text) await onApply(text, 'Custom')
        }}
        disabled={loading}
        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-50"
      >
        {loading ? 'Opening…' : 'Choose file…'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AutoEQ tab (wraps Browse + File import + profile display)
// ---------------------------------------------------------------------------

function AutoEQTab() {
  const { eqEnabled, activeProfile } = useDSPStore()
  const [subTab, setSubTab] = useState<'browse' | 'file'>('browse')
  const [subTabLoaded, setSubTabLoaded] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getStringSetting(AUTOEQ_SUB_TAB_KEY).then((value) => {
      if (cancelled) return
      if (value === 'browse' || value === 'file') {
        setSubTab(value)
      }
      setSubTabLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!subTabLoaded) return
    void setStringSetting(AUTOEQ_SUB_TAB_KEY, subTab)
  }, [subTab, subTabLoaded])

  const applyProfile = useCallback(async (text: string, name: string) => {
    setParseError(null)
    const profile = parseAutoEQ(text, name)
    if (profile.bands.length === 0) {
      setParseError('Could not parse preset — no filter bands found.')
      return
    }
    // Atomically set profile + enable, then sync once
    useDSPStore.getState().applyState({ activeProfile: profile, eqEnabled: true })
    await useDSPStore.getState().syncToEngine()
  }, [])

  const handleBrowseApply = useCallback(async (name: string, _source: string, url: string) => {
    const res = await window.puros.autoeq.fetchPreset(url)
    if (!res.success || !res.text) {
      setParseError(`Could not fetch preset: ${res.error ?? 'unknown error'}`)
      return
    }
    await applyProfile(res.text, name)
  }, [applyProfile])

  const handleToggle = async () => {
    await useDSPStore.getState().setEQEnabled(!eqEnabled)
  }

  const handleClear = async () => {
    useDSPStore.getState().applyState({ activeProfile: null, eqEnabled: false })
    await useDSPStore.getState().syncToEngine()
    setParseError(null)
  }

  return (
    <div className="space-y-3">
      {/* Header + toggle */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono">AutoEQ</span>
        <button
          onClick={handleToggle}
          disabled={!activeProfile}
          title={!activeProfile ? 'Load a preset first' : eqEnabled ? 'Disable AutoEQ' : 'Enable AutoEQ'}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            eqEnabled ? 'bg-purple-600' : 'bg-zinc-700'
          } ${!activeProfile ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200 ${
            eqEnabled ? 'left-4.5' : 'left-0.5'
          }`} />
        </button>
      </div>

      {/* Active profile */}
      {activeProfile && (
        <div className="space-y-1">
          <ProfileInfo name={activeProfile.name} bands={activeProfile.bands} preampGain={activeProfile.preampGain} />
          <button
            onClick={handleClear}
            className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors px-1"
          >
            Remove profile
          </button>
        </div>
      )}

      {parseError && <p className="text-[10px] text-red-400 px-1">{parseError}</p>}

      {/* Sub-tabs */}
      <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
        <button
          onClick={() => setSubTab('browse')}
          className={`flex-1 py-1.5 transition-colors ${
            subTab === 'browse' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >Browse library</button>
        <button
          onClick={() => setSubTab('file')}
          className={`flex-1 py-1.5 transition-colors ${
            subTab === 'file' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >Import from file</button>
      </div>

      {subTab === 'browse'
        ? <BrowseTab onApply={handleBrowseApply} />
        : <FileTab onApply={applyProfile} />
      }
    </div>
  )
}

function CrossfeedTab() {
  const {
    crossfeedEnabled,
    crossfeedCutoffFrequency,
    crossfeedFeedLevelDb,
    setCrossfeedEnabled,
    setCrossfeedCutoffFrequency,
    setCrossfeedFeedLevelDb,
  } = useDSPStore()
  const [cutoffDraft, setCutoffDraft] = useState(() => String(Math.round(crossfeedCutoffFrequency)))
  const [feedLevelDraft, setFeedLevelDraft] = useState(() => crossfeedFeedLevelDb.toFixed(1))

  useEffect(() => {
    setCutoffDraft(String(Math.round(crossfeedCutoffFrequency)))
  }, [crossfeedCutoffFrequency])

  useEffect(() => {
    setFeedLevelDraft(crossfeedFeedLevelDb.toFixed(1))
  }, [crossfeedFeedLevelDb])

  const commitCutoffDraft = useCallback(() => {
    const parsed = Number(cutoffDraft)
    if (!Number.isFinite(parsed)) {
      setCutoffDraft(String(Math.round(crossfeedCutoffFrequency)))
      return
    }
    void setCrossfeedCutoffFrequency(parsed)
  }, [crossfeedCutoffFrequency, cutoffDraft, setCrossfeedCutoffFrequency])

  const commitFeedLevelDraft = useCallback(() => {
    const parsed = Number(feedLevelDraft)
    if (!Number.isFinite(parsed)) {
      setFeedLevelDraft(crossfeedFeedLevelDb.toFixed(1))
      return
    }
    void setCrossfeedFeedLevelDb(parsed)
  }, [crossfeedFeedLevelDb, feedLevelDraft, setCrossfeedFeedLevelDb])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono">Crossfeed</span>
          <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed max-w-md">
            Reduces low-frequency channel separation for a more speaker-like stereo image while preserving mono content and top-end width.
          </p>
        </div>
        <button
          onClick={() => void setCrossfeedEnabled(!crossfeedEnabled)}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            crossfeedEnabled ? 'bg-amber-500' : 'bg-zinc-700'
          }`}
          title={crossfeedEnabled ? 'Disable Crossfeed' : 'Enable Crossfeed'}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200 ${
            crossfeedEnabled ? 'left-4.5' : 'left-0.5'
          }`} />
        </button>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-xs text-zinc-200">Cut Frequency (Hz)</p>
              <p className="text-[10px] text-zinc-500">300 Hz to 2000 Hz · default 700 Hz</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={CROSSFEED_LIMITS.cutoffFrequency.min}
                max={CROSSFEED_LIMITS.cutoffFrequency.max}
                step={1}
                value={cutoffDraft}
                onChange={(e) => setCutoffDraft(e.target.value)}
                onBlur={commitCutoffDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur()
                  }
                }}
                className="w-22 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-right text-xs font-mono text-amber-300 outline-none focus:border-amber-400"
              />
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Hz</span>
            </div>
          </div>
          <input
            type="range"
            min={CROSSFEED_LIMITS.cutoffFrequency.min}
            max={CROSSFEED_LIMITS.cutoffFrequency.max}
            step={1}
            value={crossfeedCutoffFrequency}
            onChange={(e) => {
              const nextValue = Number(e.target.value)
              setCutoffDraft(String(Math.round(nextValue)))
              void setCrossfeedCutoffFrequency(nextValue)
            }}
            className="w-full accent-amber-400"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-xs text-zinc-200">Feed level (dB)</p>
              <p className="text-[10px] text-zinc-500">1 dB to 15 dB · default 5 dB</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={CROSSFEED_LIMITS.feedLevelDb.min}
                max={CROSSFEED_LIMITS.feedLevelDb.max}
                step={0.1}
                value={feedLevelDraft}
                onChange={(e) => setFeedLevelDraft(e.target.value)}
                onBlur={commitFeedLevelDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur()
                  }
                }}
                className="w-22 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-right text-xs font-mono text-amber-300 outline-none focus:border-amber-400"
              />
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">dB</span>
            </div>
          </div>
          <input
            type="range"
            min={CROSSFEED_LIMITS.feedLevelDb.min}
            max={CROSSFEED_LIMITS.feedLevelDb.max}
            step={0.1}
            value={crossfeedFeedLevelDb}
            onChange={(e) => {
              const nextValue = Number(e.target.value)
              setFeedLevelDraft(nextValue.toFixed(1))
              void setCrossfeedFeedLevelDb(nextValue)
            }}
            className="w-full accent-amber-400"
          />
        </div>
      </div>
    </div>
  )
}

function PluginParameterPanel({ index }: { index: number }) {
  const setPluginParameter = useDSPStore((state) => state.setPluginParameter)
  const savedValues = useDSPStore((state) => state.plugins[index]?.parameters)
  const [parameters, setParameters] = useState<AudioPluginParameter[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.puros.dsp.getPluginParameters(index).then((items) => {
      if (!cancelled) setParameters(items)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [index])

  useEffect(() => {
    if (!savedValues) return
    setParameters((current) => current.map((parameter) => {
      const value = savedValues[String(parameter.id)]
      return typeof value === 'number' && value !== parameter.value
        ? { ...parameter, value, display: `${Math.round(value * 100)}%` }
        : parameter
    }))
  }, [savedValues])

  const visible = parameters.filter((parameter) =>
    parameter.name.toLowerCase().includes(query.trim().toLowerCase()))
  const commit = (id: number, value: number) => {
    void setPluginParameter(index, id, value).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)))
  }

  return (
    <div className="mt-2 space-y-2 rounded border border-zinc-700 bg-zinc-900 p-2">
      <p className="text-[10px] text-zinc-400">Plug-in parameters</p>
      {loading ? <p className="text-xs text-zinc-500">Loading parameters…</p> : parameters.length === 0 ?
        <p className="text-xs text-zinc-500">This plug-in does not expose editable parameters.</p> : <>
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a parameter…" aria-label="Find plug-in parameter"
            className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none" />
          <div className="max-h-52 space-y-2 overflow-y-auto">
            {visible.slice(0, 80).map((parameter) => (
              <label key={parameter.id} className="block text-[10px] text-zinc-300">
                <span className="flex justify-between gap-2">
                  <span className="truncate">{parameter.name}</span>
                  <span className="shrink-0 font-mono text-zinc-500">{parameter.display}</span>
                </span>
                <input type="range" min="0" max="1" step="0.001" value={parameter.value}
                  className="w-full accent-purple-500"
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    setParameters((current) => current.map((item) => item.id === parameter.id ? {
                      ...item, value, display: `${Math.round(value * 100)}%`,
                    } : item))
                  }}
                  onPointerUp={(event) => commit(parameter.id, Number(event.currentTarget.value))}
                  onKeyUp={(event) => commit(parameter.id, Number(event.currentTarget.value))} />
              </label>
            ))}
            {visible.length > 80 && <p className="text-[10px] text-zinc-500">Showing 80 parameters. Narrow the search to find others.</p>}
          </div>
        </>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

function PluginsTab() {
  const { plugins, setPlugins } = useDSPStore()
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [installed, setInstalled] = useState<InstalledAudioPlugin[]>([])
  const [loadingInstalled, setLoadingInstalled] = useState(true)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.puros.dsp.listInstalledPlugins().then((items) => {
      if (!cancelled) setInstalled(items)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setLoadingInstalled(false)
    })
    return () => { cancelled = true }
  }, [])

  const refresh = async () => {
    setLoadingInstalled(true)
    setError(null)
    try {
      setInstalled(await window.puros.dsp.listInstalledPlugins(true))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoadingInstalled(false)
    }
  }

  const update = async (next: typeof plugins) => {
    setBusy(true)
    setError(null)
    try {
      await setPlugins(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const addFile = async () => {
    setBusy(true)
    setError(null)
    try {
      const plugin = await window.puros.dsp.addPlugin()
      if (plugin) await setPlugins([...plugins, plugin])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const addInstalled = async (filePath: string) => {
    setBusy(true)
    setError(null)
    try {
      const plugin = await window.puros.dsp.addInstalledPlugin(filePath)
      await setPlugins([...plugins, plugin])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const visibleInstalled = installed.filter((plugin) =>
    plugin.name.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-zinc-200">Installed VST effects</p>
          <p className="text-[10px] text-zinc-500">After EQ and crossfeed · top to bottom · stereo PCM</p>
        </div>
        <button disabled={loadingInstalled} onClick={() => void refresh()}
          className="text-[10px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50">
          Refresh
        </button>
      </div>
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="Search installed plug-ins…"
        aria-label="Search installed VST plug-ins"
        className="w-full rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-purple-500" />
      <div className="max-h-44 overflow-y-auto rounded border border-zinc-800">
        {loadingInstalled ? <p className="p-2 text-xs text-zinc-500">Scanning installed plug-ins…</p> :
          visibleInstalled.length === 0 ? <p className="p-2 text-xs text-zinc-500">
            {installed.length === 0 ? 'No installed VST plug-ins found.' : 'No matching plug-ins.'}
          </p> : visibleInstalled.map((plugin) => (
            <button key={plugin.path} disabled={busy || plugins.length >= 16}
              onClick={() => void addInstalled(plugin.path)}
              title={plugin.path}
              className="flex w-full items-center gap-2 border-b border-zinc-800 px-2 py-1.5 text-left hover:bg-zinc-800 disabled:opacity-50 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{plugin.name}</span>
              <span className="text-[10px] text-zinc-500">{plugin.format}</span>
              <span className="text-xs text-purple-400">+</span>
            </button>
          ))}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-zinc-500">{installed.length} installed · {plugins.length}/16 in stack</p>
        <button disabled={busy || plugins.length >= 16} onClick={() => void addFile()}
          className="text-[10px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50">
          Choose file…
        </button>
      </div>
      <div className="flex items-baseline justify-between border-t border-zinc-800 pt-2">
        <p className="text-[10px] uppercase tracking-wider text-zinc-500">Effect stack</p>
        {plugins.length > 1 && <p className="text-[10px] text-zinc-600">Processed top to bottom · 1 runs first</p>}
      </div>
      {plugins.length === 0 && <p className="text-xs text-zinc-500">No plug-ins in the stack.</p>}
      {plugins.map((plugin, index) => (
        <div key={`${plugin.path}-${index}`} className="rounded bg-zinc-800/60 p-2">
          <div className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-right font-mono text-xs tabular-nums text-zinc-500">{index + 1}.</span>
          <button type="button" role="switch" aria-checked={plugin.enabled} disabled={busy}
            aria-label={`Enable ${plugin.name}`}
            title={plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}
            onClick={() => void update(plugins.map((item, i) => i === index ? { ...item, enabled: !item.enabled } : item))}
            className={`relative w-9 h-5 shrink-0 rounded-full transition-colors ${
              plugin.enabled ? 'bg-purple-600' : 'bg-zinc-700'
            } ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200 ${
              plugin.enabled ? 'left-4.5' : 'left-0.5'
            }`} />
          </button>
          <div className="min-w-0 flex-1">
            <p className={`truncate text-xs ${plugin.enabled ? 'text-zinc-200' : 'text-zinc-400'}`}>{plugin.name}</p>
            <p className="truncate text-[10px] text-zinc-500" title={plugin.path}>{plugin.path}</p>
          </div>
          <button disabled={busy} title={`Open ${plugin.name} parameters`}
            className="text-[10px] text-purple-300 hover:text-purple-200 disabled:opacity-50"
            onClick={() => setOpenIndex(openIndex === index ? null : index)}>
            {openIndex === index ? 'Close' : 'Params'}
          </button>
          <button disabled={busy || !plugin.enabled} title={plugin.enabled
            ? `Open ${plugin.name} plug-in window during PCM playback`
            : `Enable ${plugin.name} to open its plug-in window`}
            className="text-[10px] text-purple-300 hover:text-purple-200 disabled:opacity-50"
            onClick={() => void window.puros.dsp.openPluginEditor(index).catch((reason) =>
              setError(reason instanceof Error ? reason.message : String(reason)))}>
            GUI
          </button>
          <button disabled={busy || index === 0} title="Move up" className="text-xs text-zinc-400 disabled:opacity-30"
            onClick={() => { setOpenIndex(null); const next = [...plugins]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; void update(next) }}><ArrowUp className="w-3 h-3" /></button>
          <button disabled={busy || index === plugins.length - 1} title="Move down" className="text-xs text-zinc-400 disabled:opacity-30"
            onClick={() => { setOpenIndex(null); const next = [...plugins]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; void update(next) }}><ArrowDown className="w-3 h-3" /></button>
          <button disabled={busy} title="Remove" className="text-xs text-red-400 disabled:opacity-30"
            onClick={() => { setOpenIndex(null); void update(plugins.filter((_, i) => i !== index)) }}><X className="w-3 h-3" /></button>
          </div>
          {openIndex === index && <PluginParameterPanel index={index} />}
        </div>
      ))}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <p className="text-[10px] text-zinc-500">Enabled effects change samples, so PCM playback is no longer bit perfect. DSD over DoP bypasses this stack.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root EQPanel (trigger button + popup with top-level tabs)
// ---------------------------------------------------------------------------

type TopTab = 'autoeq' | 'peq' | 'crossfeed' | 'plugins'

export default function EQPanel() {
  const { eqEnabled, peqEnabled, crossfeedEnabled, plugins } = useDSPStore()
  const [open, setOpen] = useState(false)
  const [topTab, setTopTab] = useState<TopTab>('autoeq')
  const [topTabLoaded, setTopTabLoaded] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const anyActive = eqEnabled || peqEnabled || crossfeedEnabled || plugins.some((plugin) => plugin.enabled)

  useEffect(() => {
    let cancelled = false
    void getStringSetting(TOP_TAB_KEY).then((value) => {
      if (cancelled) return
      if (value === 'autoeq' || value === 'peq' || value === 'crossfeed' || value === 'plugins') {
        setTopTab(value)
      }
      setTopTabLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!topTabLoaded) return
    void setStringSetting(TOP_TAB_KEY, topTab)
  }, [topTab, topTabLoaded])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="relative" ref={panelRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className={`p-1.5 rounded-md transition-colors ${
          anyActive ? 'text-purple-400 bg-purple-400/10' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        title={anyActive ? 'Equalizer (active)' : 'Equalizer'}
      >
        <SlidersVertical className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-120 max-w-[calc(100vw-1rem)] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-50">
          {/* Top-level tabs */}
          <div className="flex border-b border-zinc-800">
            {([['autoeq', 'AutoEQ'], ['peq', 'Parametric EQ'], ['crossfeed', 'Crossfeed'], ['plugins', 'VST']] as [TopTab, string][]).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTopTab(id)}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                  topTab === id
                    ? 'text-zinc-100 border-b-2 border-purple-500 -mb-px bg-zinc-800/40'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {label}
                {id === 'autoeq' && eqEnabled && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-purple-500 inline-block" />
                )}
                {id === 'peq' && peqEnabled && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                )}
                {id === 'crossfeed' && crossfeedEnabled && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                )}
                {id === 'plugins' && plugins.some((plugin) => plugin.enabled) && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-purple-500 inline-block" />
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-3 max-h-[70vh] overflow-y-auto">
            {topTab === 'autoeq' ? <AutoEQTab /> : topTab === 'peq' ? <ParametricEQPanel /> : topTab === 'crossfeed' ? <CrossfeedTab /> : <PluginsTab />}
          </div>
        </div>
      )}
    </div>
  )
}
