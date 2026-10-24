import { Play, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { LiveRadioDirectoryFilters, Station } from '../services/liveRadio/types'
import { getStationDefaultStream, stationToTrack } from '../services/liveRadio/track'
import { usePlayerStore } from '../store/playerStore'
import MediaTabs from './MediaTabs'
import { Button, PageHeader, PageStatus, SearchField } from './ui'

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
        className="h-11 w-11 rounded-md object-cover bg-zinc-900"
      />
    )
  }
  return (
    <div className="flex h-11 w-11 items-center justify-center rounded-md bg-zinc-800 text-xs font-semibold text-zinc-500">
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
      className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
        selected ? 'bg-white/10' : 'hover:bg-white/[0.05]'
      }`}
    >
      <StationLogo station={station} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-zinc-100">{station.name}</p>
          {station.isFavorite && (
            <span className="rounded-full bg-red-400/10 px-2 py-0.5 text-[10px] font-medium text-red-300">
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
      <div className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-100">Add Stream</h2>
          <Button variant="ghost" size="sm" iconOnly icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="space-y-3">
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://station.example/stream.mp3"
            className="h-9 w-full rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 hover:border-white/15 focus:border-white/20"
            autoFocus
          />
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Display name"
            className="h-9 w-full rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 hover:border-white/15 focus:border-white/20"
          />
          {error && (
            <p className="rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" label="Cancel" onClick={onClose} />
          <Button variant="primary" icon={Plus} label={saving ? 'Checking…' : 'Add'} onClick={submit} disabled={saving || !url.trim()} />
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
    <div className="flex h-full min-h-0 w-full bg-black">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          kicker="Radio"
          title="Live Radio"
          subtitle="Browse Radio Browser stations or keep your own streams."
          actions={<Button variant="primary" icon={Plus} label="Add Stream" onClick={() => setShowAddDialog(true)} />}
        />
        <MediaTabs
          value={tab}
          onChange={setTab}
          options={[
            { id: 'browse', label: 'Browse' },
            { id: 'mine', label: 'My Live Radio' },
          ]}
        />
        {tab === 'browse' && (
          <div className="shrink-0 flex flex-wrap items-center gap-2 px-6 pt-2 pb-3">
            <SearchField value={query} onChange={setQuery} placeholder="Search stations" className="w-64" />
            <select value={tag} onChange={(event) => setTag(event.target.value)} className="h-9 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-zinc-300 outline-none transition-colors hover:border-white/15 focus:border-white/20">
              <option value="">Genre</option>
              {filters.tags.slice(0, 50).map((option) => (
                <option key={option.value} value={option.value}>{option.name}</option>
              ))}
            </select>
            <select value={countryCode} onChange={(event) => setCountryCode(event.target.value)} className="h-9 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-zinc-300 outline-none transition-colors hover:border-white/15 focus:border-white/20">
              <option value="">Country</option>
              {filters.countries.map((option) => (
                <option key={option.value} value={option.value}>{option.name}</option>
              ))}
            </select>
            <select value={language} onChange={(event) => setLanguage(event.target.value)} className="h-9 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-zinc-300 outline-none transition-colors hover:border-white/15 focus:border-white/20">
              <option value="">Language</option>
              {filters.languages.slice(0, 50).map((option) => (
                <option key={option.value} value={option.value}>{option.name}</option>
              ))}
            </select>
            <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="h-9 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-zinc-300 outline-none transition-colors hover:border-white/15 focus:border-white/20">
              <option value="popular">Popular</option>
              <option value="votes">Votes</option>
              <option value="name">Name</option>
            </select>
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(20rem,1fr)_24rem]">
          <div className="min-h-0 overflow-y-auto px-4 pb-4">
            {error && <p className="rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</p>}
            {loading && <PageStatus loading title="Loading stations…" />}
            {!loading && activeList.length === 0 && (
              <PageStatus title={tab === 'mine' ? 'No saved stations yet.' : 'No stations found.'} />
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

          <aside className="min-h-0 border-l border-white/5 p-5">
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
                        <div key={`${item.url}:${index}`} className="rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">
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
                  <Button variant="primary" icon={Play} iconFilled label="Play" onClick={() => playStation(selectedStation)} disabled={!stream} />
                  {selectedStation.isFavorite || selectedStation.isCustom ? (
                    <Button variant="quiet" icon={Trash2} label="Remove" onClick={() => void removeStation(selectedStation)} />
                  ) : (
                    <Button icon={Plus} label="Add to My Live Radio" onClick={() => void saveStation(selectedStation)} />
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
