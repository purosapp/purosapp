import { useCatalogStore } from './store/catalogStore'
import { ProviderNotice } from './components/ProviderSelector'
import TopBar from './components/TopBar'
import { useState, useEffect } from 'react'
import Home from './components/Home'
import Explore from './components/Explore'
import ArtistsView from './components/ArtistsView'
import AlbumsView from './components/AlbumsView'
import TracksView from './components/TracksView'
import GenresView from './components/GenresView'
import HistoryView from './components/HistoryView'
import PinsView from './components/PinsView'
import LiveRadio from './components/LiveRadio'
import Queue from './components/Queue'
import Player from './components/Player'
import Sidebar from './components/Sidebar'
import PlaylistView from './components/PlaylistView'
import ProviderCollectionView from './components/ProviderCollectionView'
import Settings from './components/Settings'
import NowPlayingOverlay from './renderer/components/NowPlaying/NowPlayingOverlay'
import VisualizerPanel from './renderer/components/NowPlaying/VisualizerPanel'
import {
  lyricsProviderService,
  type LyricsProviderConfig,
} from './renderer/components/NowPlaying/LyricsProviderService'
import { audioService } from './services/AudioService'
import { restorePlaybackSession, startPlaybackSessionPersistence } from './services/playbackSession'
import { startListeningStatsTracking } from './services/listeningStats'
import { usePlayerStore } from './store/playerStore'
import { useAppShellStore } from './store/appShellStore'
import { useProviderStatusStore } from './store/providerStatusStore'
import { useSettingsStore } from './store/settingsStore'
import { useLastFmStore } from './store/lastfmStore'
import { useDSPStore } from './store/dspStore'
import { getBooleanSetting, setBooleanSetting } from './utils/appSettings'
import { onOpenSettingsRequest, type SettingsTab } from './utils/openSettings'

function isSpaceKey(event: KeyboardEvent): boolean {
  return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar'
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true
  }

  const input = target.closest('input, textarea')
  if (input instanceof HTMLTextAreaElement) return true
  if (!(input instanceof HTMLInputElement)) return false

  return [
    '',
    'email',
    'number',
    'password',
    'search',
    'tel',
    'text',
    'url',
  ].includes(input.type)
}

export function StandaloneVisualizerPage() {
  return (
    <div className="h-screen w-screen bg-black">
      <VisualizerPanel
        header={null}
        isPlaying={false}
        ambientColor={{ r: 0, g: 0, b: 0 }}
        vizFullscreen={true}
        onToggleVizFullscreen={() => {}}
        standalone
      />
    </div>
  )
}

export default function App() {
  const [showQueue, setShowQueue] = useState(true)
  const [queueLoaded, setQueueLoaded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined)
  const [showNowPlaying, setShowNowPlaying] = useState(false)
  const activeProviderId = useCatalogStore(s => s.activeProviderId)
  const activeView = useAppShellStore((s) => s.activeView)
  const currentProviderCollection = useAppShellStore((s) => s.currentProviderCollection)
  const setActiveView = useAppShellStore((s) => s.setActiveView)
  const notification = usePlayerStore((s) => s.notification)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const queue = usePlayerStore((s) => s.queue)
  const shuffledQueue = usePlayerStore((s) => s.shuffledQueue)
  const queueIndex = usePlayerStore((s) => s.queueIndex)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const providerWarning = useProviderStatusStore((s) => s.currentWarning)
  const clearProviderWarning = useProviderStatusStore((s) => s.clearWarning)
  const loadProviders = useProviderStatusStore((s) => s.loadProviders)
  const loadSettings = useSettingsStore((s) => s.load)
  const showLyricsInNowPlaying = useSettingsStore((s) => s.showLyricsInNowPlaying)
  const lyricsProviderPriority = useSettingsStore((s) => s.lyricsProviderPriority)
  const lyricsApiKeys = useSettingsStore((s) => s.lyricsApiKeys)
  const loadLastFm = useLastFmStore((s) => s.load)
  const authenticateLastFm = useLastFmStore((s) => s.authenticate)
  const hydrateDSP = useDSPStore((s) => s.hydrate)

  useEffect(() => {
    audioService.init()
    const stopListeningStats = startListeningStatsTracking()
    let disposed = false
    let stopPlaybackSessionPersistence: (() => void) | null = null
    const settingsReady = loadSettings().then(async () => {
      if (disposed) return
      await restorePlaybackSession().catch((error) => {
        console.warn('[PlaybackSession] Failed to restore session:', error)
      })
      if (!disposed) stopPlaybackSessionPersistence = startPlaybackSessionPersistence()
    })
    void Promise.all([
      loadProviders(),
      settingsReady,
      loadLastFm(),
      hydrateDSP(),
      getBooleanSetting('ui:showQueue', true).then((value) => {
        setShowQueue(value)
        setQueueLoaded(true)
      }),
    ])
    return () => {
      disposed = true
      stopListeningStats()
      stopPlaybackSessionPersistence?.()
      audioService.destroy()
    }
  }, [hydrateDSP, loadLastFm, loadProviders, loadSettings])

  useEffect(() => {
    return window.puros.on('lastfm:auth-token', (token) => {
      if (typeof token !== 'string') return
      void authenticateLastFm(token)
    })
  }, [authenticateLastFm])

  useEffect(() => {
    if (!queueLoaded) return
    void setBooleanSetting('ui:showQueue', showQueue)
  }, [queueLoaded, showQueue])

  // Global keyboard shortcuts.
  useEffect(() => {
    const unsub = window.puros.on('app:open-settings', () => setShowSettings(true))
    const unsubSettingsRequest = onOpenSettingsRequest((tab) => {
      setSettingsTab(tab)
      setShowSettings(true)
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === ',' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setShowSettings(true)
        return
      }

      if (
        isSpaceKey(event) &&
        !event.repeat &&
        !(event.metaKey || event.ctrlKey || event.altKey) &&
        !isTextEntryTarget(event.target)
      ) {
        const { currentTrack: playingTrack, togglePlayPause } = usePlayerStore.getState()
        if (!playingTrack) return

        event.preventDefault()
        event.stopPropagation()
        togglePlayPause()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      unsub()
      unsubSettingsRequest()
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [])

  useEffect(() => {
    if (!currentTrack) {
      setShowNowPlaying(false)
    }
  }, [currentTrack])

  useEffect(() => {
    const unsub = window.puros.on('provider:warning', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const warning = payload as {
        provider: string
        code: 'rate_limited' | 'auth_expired' | 'provider_unavailable' | 'partial_results' | 'sync_failed' | 'playback_failed'
        message: string
        scope?: string | null
        retryable?: boolean
      }
      useProviderStatusStore.getState().setWarning(warning)
      usePlayerStore.getState().setNotification(warning.message)
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!showLyricsInNowPlaying || !currentTrack) return

    const providers: LyricsProviderConfig[] = lyricsProviderPriority.map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      apiKey: provider.id === 'lrclib'
        ? ''
        : provider.id === 'musixmatch'
          ? lyricsApiKeys.musixmatch
          : lyricsApiKeys.genius,
    }))

    const activeQueue = shuffle ? shuffledQueue : queue
    let nextTrack = null

    if (activeQueue.length > 0 && queueIndex >= 0) {
      let nextIndex = queueIndex + 1
      if (nextIndex >= activeQueue.length) {
        nextIndex = repeat === 'all' ? 0 : -1
      }
      nextTrack = nextIndex >= 0 ? activeQueue[nextIndex] ?? null : null
    }

    void lyricsProviderService.prefetchLyrics(currentTrack, providers)
    void lyricsProviderService.prefetchLyrics(nextTrack, providers)
  }, [
    currentTrack,
    lyricsApiKeys,
    lyricsProviderPriority,
    queue,
    queueIndex,
    repeat,
    showLyricsInNowPlaying,
    shuffle,
    shuffledQueue,
  ])

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100 select-none">
      {/* Title bar: drag region, global search, scope, provider, queue */}
      <TopBar queueOpen={showQueue} onToggleQueue={() => setShowQueue((s) => !s)} />

      {/* Main content */}
      <div className="flex-1 flex min-h-0 relative">
        <Sidebar activeView={activeView} onViewChange={setActiveView} />

        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {providerWarning && (
            <div className="absolute top-0 left-0 right-0 z-20 px-6 pt-4 pointer-events-none">
              <div className="pointer-events-auto flex items-start justify-between gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                <div>
                  <p className="font-medium">{providerWarning.provider.toUpperCase()}</p>
                  <p className="text-amber-50/90">{providerWarning.message}</p>
                </div>
                <button
                  onClick={clearProviderWarning}
                  className="shrink-0 text-amber-100/80 hover:text-white transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {typeof activeView === 'string' && ['explore', 'artists', 'albums', 'tracks', 'genres'].includes(activeView) && <ProviderNotice onOpenSettings={() => setShowSettings(true)} />}
          {activeView === 'library' && <Home />}
          {activeView === 'explore' && <Explore key={activeProviderId} />}
          {activeView === 'artists' && <ArtistsView key={activeProviderId} />}
          {activeView === 'albums' && <AlbumsView key={activeProviderId} />}
          {activeView === 'tracks' && <TracksView key={activeProviderId} />}
          {activeView === 'genres' && <GenresView key={activeProviderId} />}
          {activeView === 'history' && <HistoryView />}
          {activeView === 'pins' && <PinsView />}
          {activeView === 'live-radio' && <LiveRadio />}
          {activeView === 'provider-collection' && currentProviderCollection && (
            <ProviderCollectionView key={`${currentProviderCollection.provider}:${currentProviderCollection.sourceType}:${currentProviderCollection.sourceId}`} collection={currentProviderCollection} />
          )}
          {typeof activeView === 'number' && (
            <PlaylistView key={activeView} playlistId={activeView} />
          )}
        </div>

        {/* Queue overlays the content area — does not affect layout */}
        <div
          className={`absolute inset-0 z-30 transition-opacity duration-300 ease-out ${
            showQueue ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <button
            type="button"
            aria-label="Close queue"
            onClick={() => setShowQueue(false)}
            className={`absolute inset-0 bg-black/18 backdrop-blur-[1px] transition-opacity duration-300 ease-out ${
              showQueue ? 'opacity-100' : 'opacity-0'
            }`}
          />
          <div
            className={`absolute inset-y-3 right-3 flex transition-all duration-300 ease-out ${
              showQueue ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0'
            }`}
          >
            <Queue open={showQueue} onClose={() => setShowQueue(false)} />
          </div>
        </div>
      </div>

      {/* Player bar */}
      <Player onOpenNowPlaying={() => setShowNowPlaying((value) => !value)} />

      <NowPlayingOverlay open={showNowPlaying} onClose={() => setShowNowPlaying(false)} />

      {/* Settings modal */}
      {showSettings && (
        <Settings
          initialTab={settingsTab}
          onClose={() => {
            setShowSettings(false)
            setSettingsTab(undefined)
          }}
        />
      )}

      {/* Transient notification toast */}
      {notification && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-zinc-800 border border-white/10 rounded-lg shadow-xl text-xs text-zinc-200">
          {notification}
        </div>
      )}
    </div>
  )
}
