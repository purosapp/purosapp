import { Play, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { LiveRadioDirectoryFilters, Station } from '../services/liveRadio/types'
import { getStationDefaultStream, stationToTrack } from '../services/liveRadio/track'
import { usePlayerStore } from '../store/playerStore'

type Tab = 'browse' | 'mine'

const emptyFilters: LiveRadioDirectoryFilters = {
  tags: [],
  countries: [],
  languages: [],
}

function stationMeta(station: Station): string {
  const parts = [
    station.genre?.[0],
    station.country,
    station.language,
    station.codec,
    station.bitrate ? `${station.bitrate}kbps` : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

function StationLogo({ station }: { station: Station }) {
  if (station.logoUrl) {
    return (
      <img
        src={station.logoUrl}
        alt=""
        className="h-11 w-11 rounded object-cover bg-zinc-900"
      />
    )
  }
  return (
    <div className="flex h-11 w-11 items-center justify-center rounded bg-zinc-800 text-xs font-semibold text-zinc-500">
      {station.name.slice(0, 2).toUpperCase()}
    </div>
  )
}

function StationRow({
  station,
  selected,
  onSelect,
  onPlay,
}: {
  station: Station
  selected: boolean
  onSelect: () => void
  onPlay: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
        selected ? 'bg-white/10' : 'hover:bg-white/[0.05]'
      }`}
    >
      <StationLogo station={station} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-zinc-100">{station.name}</p>
          {station.isFavorite && (
            <span className="rounded bg-red-400/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
              Saved
            </span>
          )}
        </div>
        <p className="truncate text-xs text-zinc-500">{stationMeta(station) || 'Live stream'}</p>
      </div>
      <span
        role="button"
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation()
          onPlay()
        }}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-zinc-950 transition-transform hover:scale-105"
        title="Play"
      >
        <Play className="h-4 w-4" fill="currentColor" />
      </span>
    </button>
  )
}

function AddStreamDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: (station: Station) => void
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) return
    setSaving(true)
    setError(null)
    try {
      const station = await window.puros.liveRadio.addCustomStream({
        url: trimmedUrl,
        name: name.trim() || null,
      })
      onAdded(station)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-zinc-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-100">Add Stream</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 transition-colors hover:text-zinc-200"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://station.example/stream.mp3"
            className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-white/20"
            autoFocus
          />
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Display name"
            className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-white/20"
          />
          {error && (
            <p className="rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !url.trim()}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Checking...' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function LiveRadio() {
  const [tab, setTab] = useState<Tab>('browse')
  const [filters, setFilters] = useState<LiveRadioDirectoryFilters>(emptyFilters)
  const [stations, setStations] = useState<Station[]>([])
  const [myStations, setMyStations] = useState<Station[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [countryCode, setCountryCode] = useState('')
  const [language, setLanguage] = useState('')
  const [sort, setSort] = useState<'popular' | 'votes' | 'name'>('popular')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const setQueue = usePlayerStore((state) => state.setQueue)

  const activeList = tab === 'browse' ? stations : myStations
  const selectedStation = useMemo(
    () => activeList.find((station) => station.id === selectedId) ?? activeList[0] ?? null,
    [activeList, selectedId],
  )

  const refreshMyStations = async () => {
    const mine = await window.puros.liveRadio.getMyStations()
    setMyStations(mine)
  }

  useEffect(() => {
    let cancelled = false
    void window.puros.liveRadio.getFilters().then((value) => {
      if (!cancelled) setFilters(value)
    }).catch(() => undefined)
    void refreshMyStations().catch(() => undefined)
    const unsub = window.puros.on('live-radio:changed', () => {
      void refreshMyStations().catch(() => undefined)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  useEffect(() => {
    if (tab !== 'browse') return
    let cancelled = false
    const timer = setTimeout(() => {
      setLoading(true)
      setError(null)
      window.puros.liveRadio.browse({
        query,
        tag,
        countryCode,
        language,
        sort,
        hideBroken: true,
        limit: 64,
      }).then((result) => {
        if (cancelled) return
        setStations(result)
        setSelectedId((current) => current ?? result[0]?.id ?? null)
      }).catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Radio directory unavailable')
      }).finally(() => {
        if (!cancelled) setLoading(false)
      })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [countryCode, language, query, sort, tab, tag])

  useEffect(() => {
    const list = tab === 'browse' ? stations : myStations
    setSelectedId((current) => current && list.some((station) => station.id === current)
      ? current
      : list[0]?.id ?? null)
  }, [myStations, stations, tab])

  const playStation = (station: Station) => {
    const track = stationToTrack(station)
    if (!track) return
    setQueue([track], 0, {
      kind: 'live-radio',
      label: station.name,
      stationId: station.id,
    })
  }

  const saveStation = async (station: Station) => {
    const saved = await window.puros.liveRadio.saveStation(station)
    setStations((items) => items.map((item) => item.id === saved.id ? saved : item))
    await refreshMyStations()
  }

  const removeStation = async (station: Station) => {
    await window.puros.liveRadio.removeStation(station.id)
    await refreshMyStations()
    setStations((items) => items.map((item) => item.id === station.id ? { ...item, isFavorite: false } : item))
  }

  const stream = selectedStation ? getStationDefaultStream(selectedStation) : null

  return (
    <div className="flex h-full min-h-0 w-full bg-zinc-950">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-white/10 px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-zinc-100">Live Radio</h1>
              <p className="mt-1 text-sm text-zinc-500">Browse Radio Browser stations or keep your own streams.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddDialog(true)}
              className="inline-flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
            >
              <Plus className="h-4 w-4" />
              Add Stream
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setTab('browse')}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                tab === 'browse' ? 'bg-white text-zinc-950' : 'bg-white/[0.05] text-zinc-400 hover:text-zinc-100'
              }`}
            >
              Browse
            </button>
            <button
              type="button"
              onClick={() => setTab('mine')}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                tab === 'mine' ? 'bg-white text-zinc-950' : 'bg-white/[0.05] text-zinc-400 hover:text-zinc-100'
              }`}
            >
              My Live Radio
            </button>
          </div>

          {tab === 'browse' && (
            <div className="mt-4 grid grid-cols-[minmax(12rem,1fr)_repeat(4,auto)] gap-2">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search stations..."
                className="min-w-0 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-white/20"
              />
              <select value={tag} onChange={(event) => setTag(event.target.value)} className="rounded-md border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-300 outline-none">
                <option value="">Genre</option>
                {filters.tags.slice(0, 50).map((option) => (
                  <option key={option.value} value={option.value}>{option.name}</option>
                ))}
              </select>
              <select value={countryCode} onChange={(event) => setCountryCode(event.target.value)} className="rounded-md border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-300 outline-none">
                <option value="">Country</option>
                {filters.countries.map((option) => (
                  <option key={option.value} value={option.value}>{option.name}</option>
                ))}
              </select>
              <select value={language} onChange={(event) => setLanguage(event.target.value)} className="rounded-md border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-300 outline-none">
                <option value="">Language</option>
                {filters.languages.slice(0, 50).map((option) => (
                  <option key={option.value} value={option.value}>{option.name}</option>
                ))}
              </select>
              <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="rounded-md border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-300 outline-none">
                <option value="popular">Popular</option>
                <option value="votes">Votes</option>
                <option value="name">Name</option>
              </select>
            </div>
          )}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(20rem,1fr)_24rem]">
          <div className="min-h-0 overflow-y-auto p-4">
            {error && <p className="rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</p>}
            {loading && <p className="px-3 py-2 text-sm text-zinc-500">Loading stations...</p>}
            {!loading && activeList.length === 0 && (
              <p className="px-3 py-2 text-sm text-zinc-500">
                {tab === 'mine' ? 'No saved stations yet.' : 'No stations found.'}
              </p>
            )}
            <div className="space-y-1">
              {activeList.map((station) => (
                <StationRow
                  key={station.id}
                  station={station}
                  selected={selectedStation?.id === station.id}
                  onSelect={() => setSelectedId(station.id)}
                  onPlay={() => playStation(station)}
                />
              ))}
            </div>
          </div>

          <aside className="min-h-0 border-l border-white/10 p-5">
            {selectedStation ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex items-start gap-3">
                  <StationLogo station={selectedStation} />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold text-zinc-100">{selectedStation.name}</h2>
                    <p className="mt-1 text-xs text-zinc-500">{stationMeta(selectedStation) || 'Live stream'}</p>
                  </div>
                </div>

                <div className="mt-5 space-y-4 text-sm">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Location</p>
                    <p className="mt-1 text-zinc-300">{selectedStation.country || 'Unknown'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Genre</p>
                    <p className="mt-1 text-zinc-300">{selectedStation.genre?.join(', ') || 'Unknown'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Streams</p>
                    <div className="mt-2 space-y-1">
                      {selectedStation.streams.map((item, index) => (
                        <div key={`${item.url}:${index}`} className="rounded-md bg-white/[0.04] px-2 py-2 text-xs text-zinc-400">
                          <p className="truncate">{item.url}</p>
                          <p className="mt-1 text-zinc-600">
                            {[item.codec ?? selectedStation.codec, item.bitrate ?? selectedStation.bitrate ? `${item.bitrate ?? selectedStation.bitrate}kbps` : null].filter(Boolean).join(' · ') || 'Stream'}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-auto flex flex-wrap gap-2 pt-5">
                  <button
                    type="button"
                    onClick={() => playStation(selectedStation)}
                    disabled={!stream}
                    className="inline-flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-40"
                  >
                    <Play className="h-4 w-4" fill="currentColor" />
                    Play
                  </button>
                  {selectedStation.isFavorite || selectedStation.isCustom ? (
                    <button
                      type="button"
                      onClick={() => void removeStation(selectedStation)}
                      className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.05]"
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void saveStation(selectedStation)}
                      className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.05]"
                    >
                      Add to My Live Radio
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">Select a station.</p>
            )}
          </aside>
        </div>
      </div>
      {showAddDialog && (
        <AddStreamDialog
          onClose={() => setShowAddDialog(false)}
          onAdded={(station) => {
            setTab('mine')
            setSelectedId(station.id)
            void refreshMyStations()
          }}
        />
      )}
    </div>
  )
}
