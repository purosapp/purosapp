import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCatalogStore } from '../store/catalogStore'
import { useAppShellStore } from '../store/appShellStore'
import { useNavigationStore } from '../store/navigationStore'
import ProviderSelector from './ProviderSelector'
import { SearchField } from './ui'
import { QUEUE_WIDTH, QueueToggleButton } from './Queue'

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

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

export default function TopBar({ queueOpen, onToggleQueue }: { queueOpen: boolean; onToggleQueue: () => void }) {
  const query = useCatalogStore((s) => s.query)
  const setQuery = useCatalogStore((s) => s.setQuery)
  const setActiveView = useAppShellStore((s) => s.setActiveView)
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
      {/* Spans the sidebar's width so back/forward line up with the content column. */}
      <div className="flex h-full w-52 shrink-0 items-center pl-24 pr-3">
        <span className="text-xs font-semibold tracking-widest uppercase text-zinc-500">
          Puros
        </span>
      </div>
      <div className="-ml-4 pl-6">
        <HistoryButtons />
      </div>

      {/* The open queue column covers the title bar's right end (and draws its
          own toggle over this one), so search and provider move clear of it:
          to 16px left of its hairline, past this toggle (36px) and gap/padding (32px). */}
      <div
        className="ml-auto flex min-w-0 items-center gap-4 transition-[margin] duration-300 ease-out"
        style={{ marginRight: queueOpen ? QUEUE_WIDTH + 16 - 68 : 0 }}
      >
        <div style={noDrag}>
          <SearchField
            ref={inputRef}
            value={value}
            onChange={updateQuery}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !value) inputRef.current?.blur()
            }}
            placeholder="Search"
            className={`transition-[width] duration-300 ease-out ${focused ? 'w-84' : 'w-70'}`}
          />
        </div>

        <ProviderSelector />

        <div className={`-mx-1 h-5 w-px bg-white/10 transition-opacity ${queueOpen ? 'opacity-0' : ''}`} />
      </div>

      <QueueToggleButton open={queueOpen} onToggle={onToggleQueue} />
    </div>
  )
}
