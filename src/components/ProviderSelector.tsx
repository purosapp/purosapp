import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { useCatalogStore } from '../store/catalogStore'
import { useProviderStatusStore } from '../store/providerStatusStore'
import { ProviderIcon, ProviderInlineLabel } from './ProviderBadge'

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function useSelectedProvider() {
  const providerId = useCatalogStore(s => s.activeProviderId)
  const providers = useProviderStatusStore(s => s.providers)
  const loaded = useProviderStatusStore(s => s.loaded)
  const selected = providers.find(p => p.manifest.id === providerId)
  const unavailable = providerId !== 'local' && (!selected || selected.status.authenticated === false || selected.status.state === 'error' || selected.status.state === 'inactive')
  return { providerId, providers, loaded, selected, unavailable }
}

/** Circular provider picker shown in the title bar. */
export default function ProviderSelector() {
  const { providerId, providers, selected, unavailable } = useSelectedProvider()
  const setProvider = useCatalogStore(s => s.setProvider)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (id: string) => {
    setProvider(id)
    setOpen(false)
  }

  const options = [
    { id: 'local', note: null as string | null },
    ...providers.map(p => ({
      id: p.manifest.id,
      note: p.status.authenticated === false ? 'Sign in' : p.status.state === 'error' || p.status.state === 'inactive' ? 'Unavailable' : null,
    })),
  ]
  if (providerId !== 'local' && !selected) options.push({ id: providerId, note: 'Unavailable' })

  return (
    <div ref={rootRef} className="relative" style={noDrag}>
      <button
        type="button"
        aria-label="Music provider"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Provider: ${selected?.manifest.displayName ?? (providerId === 'local' ? 'Local' : providerId)}`}
        onClick={() => setOpen(v => !v)}
        className={`relative flex h-9 w-9 items-center justify-center rounded-full border bg-zinc-900/80 transition-all duration-200 hover:scale-105 hover:border-white/25 ${
          open ? 'border-white/30 ring-2 ring-white/10' : 'border-white/10'
        }`}
      >
        <ProviderIcon provider={providerId} className="w-4.5 h-4.5" />
        {unavailable && (
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-950 bg-amber-400" />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 w-60 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl"
        >
          <p className="px-3 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Provider</p>
          {options.map(option => (
            <button
              key={option.id}
              role="menuitemradio"
              aria-checked={option.id === providerId}
              onClick={() => choose(option.id)}
              className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                option.id === providerId ? 'bg-white/[0.08] text-white' : 'text-zinc-300 hover:bg-white/[0.05] hover:text-white'
              }`}
            >
              <ProviderInlineLabel provider={option.id} className="min-w-0 gap-2.5" />
              <span className="flex shrink-0 items-center gap-2">
                {option.note && <span className="text-[11px] text-zinc-500">{option.note}</span>}
                {option.id === providerId && <Check className="h-3.5 w-3.5 text-zinc-200" />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Status notes for the selected provider; renders nothing when there is nothing to say. */
export function ProviderNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { loaded, selected, unavailable } = useSelectedProvider()
  const noSearch = selected && !selected.manifest.capabilities.includes('catalog.search')
  if (!(loaded && unavailable) && !noSearch) return null
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-3 px-6 py-2 border-b border-white/5 bg-white/[0.015]">
      {loaded && unavailable && <>
        <span className="text-xs text-zinc-500">{selected?.status.message ?? (selected?.status.authenticated === false ? 'Sign in to play music from this provider.' : 'This provider is unavailable. Saved library items are shown below.')}</span>
        <button className="text-xs text-zinc-300 hover:text-white underline underline-offset-4" onClick={onOpenSettings}>Provider settings</button>
      </>}
      {noSearch && <span className="text-xs text-zinc-500">This provider does not support online search.</span>}
    </div>
  )
}
