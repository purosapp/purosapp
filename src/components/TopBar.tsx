import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from '@animateicons/react/lucide'
import { useCatalogStore } from '../store/catalogStore'
import { useAppShellStore } from '../store/appShellStore'
import { useNavigationStore } from '../store/navigationStore'
import ProviderSelector from './ProviderSelector'

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

type AnimatedIcon = React.ForwardRefExoticComponent<
  { size?: number; className?: string } & React.RefAttributes<{ startAnimation: () => void; stopAnimation: () => void }>
>

function SidebarToggle() {
  const collapsed = useAppShellStore((s) => s.sidebarCollapsed)
  const setCollapsed = useAppShellStore((s) => s.setSidebarCollapsed)
  const iconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void }>(null)
  const Icon = (collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon) as AnimatedIcon
  return (
    <button
      type="button"
      onClick={() => setCollapsed(!collapsed)}
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
      style={noDrag}
    >
      <Icon ref={iconRef} size={18} />
    </button>
  )
}

function HistoryButtons() {
  const canGoBack = useNavigationStore((s) => s.canGoBack)
  const canGoForward = useNavigationStore((s) => s.canGoForward)
  const goBack = useNavigationStore((s) => s.goBack)
  const goForward = useNavigationStore((s) => s.goForward)

  // ⌘[ / ⌘] and the mouse's back/forward side buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key === '[') {
        event.preventDefault()
        useNavigationStore.getState().goBack()
      } else if (event.key === ']') {
        event.preventDefault()
        useNavigationStore.getState().goForward()
      }
    }
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3) useNavigationStore.getState().goBack()
      else if (event.button === 4) useNavigationStore.getState().goForward()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])

  const buttonClass = 'flex h-full w-9 items-center justify-center rounded-full transition-colors enabled:text-zinc-200 enabled:hover:bg-white/[0.08] enabled:hover:text-white disabled:text-zinc-600'
  return (
    <div className="flex h-9 shrink-0 items-center rounded-full bg-zinc-900/80" style={noDrag}>
      <button type="button" onClick={goBack} disabled={!canGoBack} aria-label="Go back" title="Back (⌘[)" className={buttonClass}>
        <ChevronLeft className="h-4.5 w-4.5" strokeWidth={2.25} />
      </button>
      <button type="button" onClick={goForward} disabled={!canGoForward} aria-label="Go forward" title="Forward (⌘])" className={buttonClass}>
        <ChevronRight className="h-4.5 w-4.5" strokeWidth={2.25} />
      </button>
    </div>
  )
}

function QueueIcon() {
  return (
    <svg
      className="queue-icon h-4.5 w-4.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path className="queue-icon-line" d="M16 5H3" />
      <path className="queue-icon-line" d="M11 12H3" />
      <path className="queue-icon-line" d="M11 19H3" />
      <g className="queue-icon-note">
        <path d="M21 16V5" />
        <circle cx="18" cy="16" r="3" />
      </g>
    </svg>
  )
}

export default function TopBar({ queueOpen, onToggleQueue }: { queueOpen: boolean; onToggleQueue: () => void }) {
  const query = useCatalogStore((s) => s.query)
  const setQuery = useCatalogStore((s) => s.setQuery)
  const setActiveView = useAppShellStore((s) => s.setActiveView)
  const sidebarCollapsed = useAppShellStore((s) => s.sidebarCollapsed)
  const [value, setValue] = useState(query)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    setValue(query)
  }, [query])

  useEffect(() => () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
  }, [])

  // ⌘F / ⌘K focuses the search field from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key !== 'f' && event.key !== 'k') return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showExplore = () => {
    if (useAppShellStore.getState().activeView !== 'explore') setActiveView('explore')
  }

  const runSearch = (nextValue: string) => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      const { search, browse } = useCatalogStore.getState()
      if (nextValue.trim()) void search(nextValue)
      else void browse()
    }, 220)
  }

  const updateQuery = (nextValue: string) => {
    setValue(nextValue)
    setQuery(nextValue)
    showExplore()
    runSearch(nextValue)
  }

  return (
    <div className="relative z-40 h-17 flex items-center gap-4 pr-4 shrink-0" style={drag}>
      {/* Expanded: spans the sidebar's width (toggle at its right edge) so
          back/forward line up with the content column. Collapsed: the toggle
          follows the label, as in TIDAL. */}
      <div
        className={`flex h-full shrink-0 items-center pl-24 ${
          sidebarCollapsed ? 'gap-3' : 'w-52 justify-between pr-3'
        }`}
      >
        <span className="text-xs font-semibold tracking-widest uppercase text-zinc-500">
          Puros
        </span>
        <SidebarToggle />
      </div>
      <div className="-ml-4 pl-6">
        <HistoryButtons />
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-4">
        <label
          className={`group/search flex h-9 min-w-0 items-center gap-3 rounded-full border px-4 transition-all duration-300 ease-out ${
            focused
              ? 'w-84 border-white/20 bg-zinc-900'
              : 'w-70 border-white/[0.07] bg-zinc-900/70 hover:border-white/15 hover:bg-zinc-900'
          }`}
          style={noDrag}
        >
          <Search className={`h-3.5 w-3.5 shrink-0 transition-colors ${focused ? 'text-zinc-200' : 'text-zinc-500 group-hover/search:text-zinc-400'}`} />
          <input
            ref={inputRef}
            type="search"
            value={value}
            onChange={(event) => updateQuery(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              if (value) updateQuery('')
              else inputRef.current?.blur()
            }}
            placeholder="Search"
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {value && (
            <button
              type="button"
              aria-label="Clear search"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => updateQuery('')}
              className="shrink-0 rounded-full p-0.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>

        <ProviderSelector />

        <div className="-mx-1 h-5 w-px bg-white/10" />

        <button
          type="button"
          onClick={onToggleQueue}
          aria-pressed={queueOpen}
          title="Toggle queue"
          className={`group flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
            queueOpen ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'
          }`}
          style={noDrag}
        >
          <QueueIcon />
        </button>
      </div>
    </div>
  )
}
