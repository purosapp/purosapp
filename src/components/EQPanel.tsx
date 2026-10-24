import { ArrowDown, ArrowUp, ChevronDown, FolderOpen, RefreshCw, SlidersVertical, X } from 'lucide-react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { GlassPopover } from './GlassPanel'
import { CROSSFEED_LIMITS, useDSPStore } from '../store/dspStore'
import { parseAutoEQ } from '../services/autoeq/AutoEQParser'
import ParametricEQPanel from './ParametricEQPanel'
import { getJsonSetting, getStringSetting, setJsonSetting, setStringSetting } from '../utils/appSettings'
import type { AudioPluginParameter, InstalledAudioPlugin } from '../types/plugins'
import {
  DEFAULT_RESTORE_SETTINGS,
  type RestoreMode,
  type RestorePosition,
  type RestoreProfile,
  type RestoreStatus,
} from '../services/restoreSettings'
import { Button, FIELD_SM_CLASS, SearchField } from './ui'
import { Segmented, Switch } from './settings/controls'
import { isWindowHidden } from '../services/windowActivity'

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
    <div className="bg-white/[0.03] rounded-xl p-2 space-y-1">
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
      className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors group"
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
        <div className="w-4 h-4 border-2 border-white/15 border-t-zinc-300 rounded-full animate-spin" />
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
      <SearchField
        ref={inputRef}
        size="sm"
        value={query}
        onChange={setQuery}
        placeholder={`Search ${allEntries.length.toLocaleString()} presets…`}
        className="w-full"
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
      <Button
        variant="secondary"
        size="sm"
        label={loading ? 'Opening…' : 'Choose file…'}
        onClick={async () => {
          setLoading(true)
          const text = await window.puros.dsp.loadEQFile()
          setLoading(false)
          if (text) await onApply(text, 'Custom')
        }}
        disabled={loading}
        className="w-full"
      />
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
        <Switch
          checked={eqEnabled}
          onChange={() => handleToggle()}
          disabled={!activeProfile}
          label="AutoEQ"
          title={!activeProfile ? 'Load a preset first' : eqEnabled ? 'Disable AutoEQ' : 'Enable AutoEQ'}
        />
      </div>

      {/* Active profile */}
      {activeProfile && (
        <div className="space-y-1">
          <ProfileInfo name={activeProfile.name} bands={activeProfile.bands} preampGain={activeProfile.preampGain} />
          <Button variant="ghost" size="xs" icon={X} label="Remove profile" onClick={handleClear} />
        </div>
      )}

      {parseError && <p className="text-[10px] text-red-400 px-1">{parseError}</p>}

      {/* Sub-tabs */}
      <Segmented
        value={subTab}
        onChange={setSubTab}
        options={[
          { id: 'browse', label: 'Browse library' },
          { id: 'file', label: 'Import from file' },
        ]}
      />

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
        <Switch
          checked={crossfeedEnabled}
          onChange={(value) => void setCrossfeedEnabled(value)}
          label="Crossfeed"
          title={crossfeedEnabled ? 'Disable Crossfeed' : 'Enable Crossfeed'}
        />
      </div>

      <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3 space-y-4">
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
                className={`${FIELD_SM_CLASS} w-22 text-right font-mono`}
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
            className="w-full accent-white"
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
                className={`${FIELD_SM_CLASS} w-22 text-right font-mono`}
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
            className="w-full accent-white"
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
    <div className="mt-2 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-2">
      <p className="text-[10px] text-zinc-400">Plug-in parameters</p>
      {loading ? <p className="text-xs text-zinc-500">Loading parameters…</p> : parameters.length === 0 ?
        <p className="text-xs text-zinc-500">This plug-in does not expose editable parameters.</p> : <>
          <SearchField size="sm" value={query} onChange={setQuery}
            placeholder="Find a parameter…" aria-label="Find plug-in parameter" className="w-full" />
          <div className="max-h-52 space-y-2 overflow-y-auto">
            {visible.slice(0, 80).map((parameter) => (
              <label key={parameter.id} className="block text-[10px] text-zinc-300">
                <span className="flex justify-between gap-2">
                  <span className="truncate">{parameter.name}</span>
                  <span className="shrink-0 font-mono text-zinc-500">{parameter.display}</span>
                </span>
                <input type="range" min="0" max="1" step="0.001" value={parameter.value}
                  className="w-full accent-white"
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
        <Button variant="ghost" size="xs" icon={RefreshCw} label="Refresh" disabled={loadingInstalled} onClick={() => void refresh()} />
      </div>
      <SearchField size="sm" value={query} onChange={setQuery}
        placeholder="Search installed plug-ins…"
        aria-label="Search installed VST plug-ins" className="w-full" />
      <div className="max-h-44 overflow-y-auto rounded-xl border border-white/5">
        {loadingInstalled ? <p className="p-2 text-xs text-zinc-500">Scanning installed plug-ins…</p> :
          visibleInstalled.length === 0 ? <p className="p-2 text-xs text-zinc-500">
            {installed.length === 0 ? 'No installed VST plug-ins found.' : 'No matching plug-ins.'}
          </p> : visibleInstalled.map((plugin) => (
            <button key={plugin.path} disabled={busy || plugins.length >= 16}
              onClick={() => void addInstalled(plugin.path)}
              title={plugin.path}
              className="flex w-full items-center gap-2 border-b border-white/5 px-2 py-1.5 text-left hover:bg-white/5 disabled:opacity-50 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{plugin.name}</span>
              <span className="text-[10px] text-zinc-500">{plugin.format}</span>
              <span className="text-xs text-accent-400">+</span>
            </button>
          ))}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-zinc-500">{installed.length} installed · {plugins.length}/16 in stack</p>
        <Button variant="ghost" size="xs" icon={FolderOpen} label="Choose file…" disabled={busy || plugins.length >= 16} onClick={() => void addFile()} />
      </div>
      <div className="flex items-baseline justify-between border-t border-white/5 pt-2">
        <p className="text-[10px] uppercase tracking-wider text-zinc-500">Effect stack</p>
        {plugins.length > 1 && <p className="text-[10px] text-zinc-600">Processed top to bottom · 1 runs first</p>}
      </div>
      {plugins.length === 0 && <p className="text-xs text-zinc-500">No plug-ins in the stack.</p>}
      {plugins.map((plugin, index) => (
        <div key={`${plugin.path}-${index}`} className="rounded-xl bg-white/[0.03] p-2">
          <div className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-right font-mono text-xs tabular-nums text-zinc-500">{index + 1}.</span>
          <Switch
            checked={plugin.enabled}
            disabled={busy}
            label={`Enable ${plugin.name}`}
            title={plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}
            onChange={() => void update(plugins.map((item, i) => i === index ? { ...item, enabled: !item.enabled } : item))}
          />
          <div className="min-w-0 flex-1">
            <p className={`truncate text-xs ${plugin.enabled ? 'text-zinc-200' : 'text-zinc-400'}`}>{plugin.name}</p>
            <p className="truncate text-[10px] text-zinc-500" title={plugin.path}>{plugin.path}</p>
          </div>
          <Button variant="ghost" size="xs" label={openIndex === index ? 'Close' : 'Params'} title={`Open ${plugin.name} parameters`}
            disabled={busy} active={openIndex === index} onClick={() => setOpenIndex(openIndex === index ? null : index)} />
          <Button variant="ghost" size="xs" label="GUI" disabled={busy || !plugin.enabled} title={plugin.enabled
            ? `Open ${plugin.name} plug-in window during PCM playback`
            : `Enable ${plugin.name} to open its plug-in window`}
            onClick={() => void window.puros.dsp.openPluginEditor(index).catch((reason) =>
              setError(reason instanceof Error ? reason.message : String(reason)))} />
          <Button variant="ghost" size="xs" iconOnly icon={ArrowUp} label="Move up" disabled={busy || index === 0}
            onClick={() => { setOpenIndex(null); const next = [...plugins]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; void update(next) }} />
          <Button variant="ghost" size="xs" iconOnly icon={ArrowDown} label="Move down" disabled={busy || index === plugins.length - 1}
            onClick={() => { setOpenIndex(null); const next = [...plugins]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; void update(next) }} />
          <Button variant="ghost" size="xs" iconOnly icon={X} label="Remove" disabled={busy} className="hover:!text-red-300"
            onClick={() => { setOpenIndex(null); void update(plugins.filter((_, i) => i !== index)) }} />
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

const RESTORE_MODE_HELP: Record<RestoreMode, string> = {
  off: 'Disabled. Audio passes through untouched.',
  manual: 'Restores every PCM source, lossless included. Native DSD is never processed.',
  auto: 'Restores only sources the decoder confirms as lossy (MP3, AAC, Opus, Vorbis…). Lossless, DSD and unidentified formats stay untouched and bit-perfect.',
}

const RESTORE_PROFILE_HELP: Record<RestoreProfile, string> = {
  adaptive: 'Follows the measured coding damage: more on low bitrates, almost nothing on transparent encodes.',
  natural: 'Restrained and smooth; the rebuilt top end rolls off early.',
  detailed: 'Fuller high-frequency reconstruction and crisper attacks.',
}

function formatKhz(hz: number) {
  return `${(hz / 1000).toFixed(1)} kHz`
}

function RestoreStatusLine({ status }: { status: RestoreStatus | null }) {
  if (!status || status.state === 'off') return null
  const codec = status.codec ? ` · ${status.codec}` : ''
  if (status.state === 'active') {
    const detail = status.cutoffHz > 0
      ? `codec low-pass at ${formatKhz(status.cutoffHz)}`
      : 'full-bandwidth source, no top end to rebuild'
    return (
      <p className="flex items-center gap-2 text-[11px] text-zinc-300" data-testid="restore-status">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
        <span className="min-w-0 truncate">Restoring{codec} · {detail}</span>
      </p>
    )
  }
  return (
    <p className="flex items-center gap-2 text-[11px] text-zinc-500" data-testid="restore-status">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" />
      <span className="min-w-0 truncate">
        {status.state === 'idle' ? 'Waiting for playback' : `Bypassed${codec} · ${status.reason}`}
      </span>
    </p>
  )
}

function RestoreToggleRow({ label, help, checked, disabled, onChange }: {
  label: string
  help: string
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs text-zinc-200">{label}</p>
        <p className="text-[10px] text-zinc-500">{help}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={label} />
    </div>
  )
}

function RestoreTab() {
  const restore = useDSPStore((state) => state.restore)
  const setRestore = useDSPStore((state) => state.setRestore)
  const [status, setStatus] = useState<RestoreStatus | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const off = restore.mode === 'off'

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void window.puros.dsp.getRestoreStatus()
        .then((next) => { if (!cancelled) setStatus(next) })
        .catch(() => {})
    }
    refresh()
    const timer = window.setInterval(() => { if (!isWindowHidden()) refresh() }, 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const update = (patch: Parameters<typeof setRestore>[0]) => {
    void setRestore(patch).catch((error) => console.warn('Could not apply Puros Restore settings:', error))
  }

  return (
    <div className="space-y-4">
      <div>
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono">Puros Restore</span>
        <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed max-w-md">
          Adaptive restoration for compressed audio: rebuilds a plausible top end above the codec&apos;s cut-off,
          smooths coding artifacts and tightens smeared attacks. It cannot recover what the encoder discarded.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-zinc-200">Activation</p>
        <Segmented<RestoreMode>
          value={restore.mode}
          onChange={(mode) => update({ mode })}
          options={[
            { id: 'off', label: 'Off' },
            { id: 'manual', label: 'Manual' },
            { id: 'auto', label: 'Auto (Lossy Only)' },
          ]}
        />
        <p className="text-[10px] text-zinc-500 leading-relaxed">{RESTORE_MODE_HELP[restore.mode]}</p>
        <RestoreStatusLine status={status} />
      </div>

      <div className={`rounded-xl border border-white/5 bg-white/[0.03] p-3 space-y-4 transition-opacity ${off ? 'opacity-50' : ''}`}>
        <div className="space-y-2">
          <p className="text-xs text-zinc-200">Restoration profile</p>
          <Segmented<RestoreProfile>
            value={restore.profile}
            onChange={(profile) => update({ profile })}
            options={[
              { id: 'adaptive', label: 'Adaptive', disabled: off },
              { id: 'natural', label: 'Natural', disabled: off },
              { id: 'detailed', label: 'Detailed', disabled: off },
            ]}
          />
          <p className="text-[10px] text-zinc-500">{RESTORE_PROFILE_HELP[restore.profile]}</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-xs text-zinc-200">Restoration strength</p>
              <p className="text-[10px] text-zinc-500">0 % to 100 % · default {DEFAULT_RESTORE_SETTINGS.strength} %</p>
            </div>
            <span className="font-mono text-xs text-zinc-300">{restore.strength} %</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={restore.strength}
            disabled={off}
            aria-label="Restoration strength"
            onChange={(e) => update({ strength: Number(e.target.value) })}
            className="w-full accent-white disabled:opacity-60"
          />
        </div>

        <div className="border-t border-white/5 pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center justify-between text-xs text-zinc-300 hover:text-zinc-100"
          >
            Advanced settings
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
          </button>
          {advancedOpen && (
            <div className="mt-3 space-y-3">
              <RestoreToggleRow
                label="Artifact reduction"
                help="Fills spectral holes and calms flickering high-frequency “birdies”."
                checked={restore.artifactReduction}
                disabled={off}
                onChange={(artifactReduction) => update({ artifactReduction })}
              />
              <RestoreToggleRow
                label="High-frequency reconstruction"
                help="Extends the spectrum above the codec's low-pass, rolling off naturally."
                checked={restore.hfReconstruction}
                disabled={off}
                onChange={(hfReconstruction) => update({ hfReconstruction })}
              />
              <RestoreToggleRow
                label="Transient restoration"
                help="Suppresses pre-echo before attacks and restores their clarity."
                checked={restore.transientRestoration}
                disabled={off}
                onChange={(transientRestoration) => update({ transientRestoration })}
              />
              <div className="space-y-2">
                <p className="text-xs text-zinc-200">Position in the DSP chain</p>
                <Segmented<RestorePosition>
                  value={restore.position}
                  onChange={(position) => update({ position })}
                  options={[
                    { id: 'source', label: 'First', disabled: off, title: 'On the decoded source, before resampling, EQ, crossfeed and VST' },
                    { id: 'afterDsp', label: 'Last', disabled: off, title: 'After EQ, crossfeed and VST plug-ins' },
                  ]}
                />
                <p className="text-[10px] text-zinc-500">
                  First (recommended) repairs the source before anything else. A new position applies from the next track or seek.
                </p>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="xs"
                  label="Restore defaults"
                  disabled={off}
                  onClick={() => update({ ...DEFAULT_RESTORE_SETTINGS, mode: restore.mode })}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

type TopTab = 'autoeq' | 'peq' | 'crossfeed' | 'plugins' | 'restore'

export default function EQPanel() {
  const { eqEnabled, peqEnabled, crossfeedEnabled, plugins, restore } = useDSPStore()
  const [open, setOpen] = useState(false)
  const [topTab, setTopTab] = useState<TopTab>('autoeq')
  const [topTabLoaded, setTopTabLoaded] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const anyActive = eqEnabled || peqEnabled || crossfeedEnabled || plugins.some((plugin) => plugin.enabled) ||
    restore.mode !== 'off'

  useEffect(() => {
    let cancelled = false
    void getStringSetting(TOP_TAB_KEY).then((value) => {
      if (cancelled) return
      if (value === 'autoeq' || value === 'peq' || value === 'crossfeed' || value === 'plugins' || value === 'restore') {
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
      const target = e.target as Node
      if (panelRef.current && !panelRef.current.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="relative" ref={panelRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className={`p-1.5 rounded-full transition-colors ${
          anyActive ? 'text-accent-400 bg-accent-400/10' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        title={anyActive ? 'Equalizer (active)' : 'Equalizer'}
      >
        <SlidersVertical className="w-4 h-4" />
      </button>

      {open && (
        <GlassPopover
          ref={popoverRef}
          anchorRef={panelRef}
          radius={12}
          className="w-120 max-w-[calc(100vw-1rem)] border border-transparent overflow-hidden"
        >
          {/* Top-level tabs */}
          {/* Same pill control as Segmented, with an "active" dot per tab. */}
          <div role="tablist" className="m-3 mb-0 flex gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] p-1">
            {([['autoeq', 'AutoEQ'], ['peq', 'Parametric EQ'], ['crossfeed', 'Crossfeed'], ['plugins', 'VST'], ['restore', 'Restore']] as [TopTab, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={topTab === id}
                onClick={() => setTopTab(id)}
                className={`flex-1 h-7 rounded-full text-xs font-medium transition-colors ${
                  topTab === id
                    ? 'bg-white text-zinc-950'
                    : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
                }`}
              >
                {label}
                {id === 'autoeq' && eqEnabled && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent-500 inline-block" />
                )}
                {id === 'peq' && peqEnabled && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent-500 inline-block" />
                )}
                {id === 'crossfeed' && crossfeedEnabled && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent-400 inline-block" />
                )}
                {id === 'plugins' && plugins.some((plugin) => plugin.enabled) && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent-500 inline-block" />
                )}
                {id === 'restore' && restore.mode !== 'off' && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent-500 inline-block" />
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-3 max-h-[70vh] overflow-y-auto">
            {topTab === 'autoeq' ? <AutoEQTab />
              : topTab === 'peq' ? <ParametricEQPanel />
              : topTab === 'crossfeed' ? <CrossfeedTab />
              : topTab === 'restore' ? <RestoreTab />
              : <PluginsTab />}
          </div>
        </GlassPopover>
      )}
    </div>
  )
}
