import { ChevronDown, ExternalLink, Maximize, Minimize } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CatalogCreditSummary, CatalogTrackSummary } from '../../../services/catalog/types'
import type { ProviderCreditV1, ProviderTrackDetailsV1 } from '../../../provider-api/v1'
import { usePlayerStore } from '../../../store/playerStore'
import { useProviderStatusStore } from '../../../store/providerStatusStore'
import { LYRICS_PROVIDER_LABELS, useSettingsStore } from '../../../store/settingsStore'
import {
  DEFAULT_ARTWORK_AMBIENT_COLOR,
  resolveArtwork,
  resolveHighResolutionArtwork,
  rgba,
  sampleArtworkColor,
} from '../../../utils/artworkColor'
import {
  lyricsProviderService,
  type LyricsProviderConfig,
  type ResolvedLyrics,
} from './LyricsProviderService'
import LyricsPanel from './LyricsPanel'
import VisualizerPanel from './VisualizerPanel'
import { useVisualizerStore } from '../../../store/visualizerStore'

interface NowPlayingOverlayProps {
  open: boolean
  onClose: () => void
}

type NowPlayingTab = 'lyrics' | 'authors' | 'visualizer'

function formatCreditRole(role: CatalogCreditSummary['role']): string {
  switch (role) {
    case 'primary': return 'Primary'
    case 'main': return 'Main'
    case 'featured': return 'Featured'
    case 'composer': return 'Composer'
    case 'producer': return 'Producer'
    case 'conductor': return 'Conductor'
    case 'performer': return 'Performer'
    case 'related': return 'Related'
    default: return role
  }
}

function formatDisplayDate(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(parsed)
}

function dedupeCredits(credits: CatalogCreditSummary[] | undefined): CatalogCreditSummary[] {
  const seen = new Set<string>()
  return (credits ?? []).filter((credit) => {
    const key = [credit.artistId, credit.artistName, credit.role, credit.position].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function fallbackRoleGroups(track: CatalogTrackSummary | null): Array<{ role: string; contributors: string[] }> {
  const grouped = new Map<string, string[]>()

  for (const credit of dedupeCredits(track?.credits)) {
    const role = formatCreditRole(credit.role)
    const contributors = grouped.get(role) ?? []
    if (!contributors.includes(credit.artistName)) {
      contributors.push(credit.artistName)
    }
    grouped.set(role, contributors)
  }

  return Array.from(grouped.entries()).map(([role, contributors]) => ({ role, contributors }))
}

function PanelShell({
  header,
  children,
}: {
  header: ReactNode
  children: ReactNode
}) {
  return (
    <div className="relative flex h-full min-h-[24rem] flex-col overflow-hidden rounded-[32px] border border-white/8 bg-black/18 shadow-[0_24px_70px_rgba(0,0,0,0.22)] backdrop-blur-2xl">
      <div className="border-b border-white/8 px-6 py-4">
        {header}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  )
}

function AuthorsPanel({
  detailedCredits,
  loading,
  track,
  header,
}: {
  detailedCredits: ProviderTrackDetailsV1 | null
  loading: boolean
  track: CatalogTrackSummary | null
  header: ReactNode
}) {
  const roleGroups = detailedCredits?.roles?.length
    ? detailedCredits.roles
    : fallbackRoleGroups(track)
  const metadata = [
    { label: 'Release Date', value: formatDisplayDate(detailedCredits?.releaseDate) },
    { label: 'Album', value: detailedCredits?.albumTitle ?? track?.albumTitle ?? null },
    { label: 'Label', value: detailedCredits?.label ?? null },
    { label: 'ISRC', value: detailedCredits?.isrc ?? null },
    { label: 'UPC', value: detailedCredits?.upc ?? null },
    { label: 'Copyright', value: detailedCredits?.copyright ?? null },
  ].filter((entry) => entry.value)

  return (
    <PanelShell header={header}>
      <div className="flex h-full flex-col overflow-y-auto px-6 py-6 md:px-8 md:py-8">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading credits…
          </div>
        ) : roleGroups.length > 0 ? (
          <div className="space-y-7">
            <div className="space-y-6">
              {roleGroups.map((group) => (
                <div key={`${group.role}-${group.contributors.join('|')}`}>
                  <p className="text-[0.98rem] font-semibold text-zinc-100">{group.role}</p>
                  <p className="mt-1.5 text-[0.98rem] leading-[1.55] text-zinc-300/88">
                    {group.contributors.join(', ')}
                  </p>
                </div>
              ))}
            </div>

            {metadata.length > 0 ? (
              <div className="border-t border-white/8 pt-6">
                <div className="space-y-5">
                  {metadata.map((entry) => (
                    <div key={entry.label}>
                      <p className="text-[0.98rem] font-semibold text-zinc-100">{entry.label}</p>
                      <p className="mt-1.5 text-[0.98rem] leading-[1.55] text-zinc-300/88">{entry.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-center text-sm text-zinc-500">
            Credits unavailable for this track
          </div>
        )}
      </div>
    </PanelShell>
  )
}

export default function NowPlayingOverlay({ open, onClose }: NowPlayingOverlayProps) {
  const {
    currentTrack,
    isPlaying,
    position,
    seek,
  } = usePlayerStore()
  const showLyricsInNowPlaying = useSettingsStore((s) => s.showLyricsInNowPlaying)
  const lyricsProviderPriority = useSettingsStore((s) => s.lyricsProviderPriority)
  const lyricsApiKeys = useSettingsStore((s) => s.lyricsApiKeys)
  const lyricsFontSize = useSettingsStore((s) => s.lyricsFontSize)
  const dimAlbumArtWhenLyricsVisible = useSettingsStore((s) => s.dimAlbumArtWhenLyricsVisible)

  const isDetached = useVisualizerStore((s) => s.isDetached)
  const setDetached = useVisualizerStore((s) => s.setDetached)

  const [ambientColor, setAmbientColor] = useState(DEFAULT_ARTWORK_AMBIENT_COLOR)
  const [isFullScreen, setIsFullScreen] = useState(false)
  const [activeTab, setActiveTab] = useState<NowPlayingTab>('lyrics')
  const [vizFullscreen, setVizFullscreen] = useState(false)
  const [shouldMountVisualizer, setShouldMountVisualizer] = useState(false)
  const [lyrics, setLyrics] = useState<ResolvedLyrics | null>(null)
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [trackSummary, setTrackSummary] = useState<CatalogTrackSummary | null>(null)
  const [detailedCredits, setDetailedCredits] = useState<ProviderTrackDetailsV1 | null>(null)
  const [detailedCreditsLoading, setDetailedCreditsLoading] = useState(false)
  const [largeArtworkSrc, setLargeArtworkSrc] = useState<string | null>(null)
  const lastLyricsSignatureRef = useRef<string>('')
  const detailedCreditsCacheRef = useRef<Map<string, ProviderTrackDetailsV1 | null>>(new Map())
  const providerDescriptors = useProviderStatusStore((state) => state.providers)

  const artworkSrc = resolveArtwork(currentTrack)
  const showLyricsPanel = showLyricsInNowPlaying
  const duoLayoutStyle = {
    '--np-panel-size': 'min(68vh, 52rem)',
    '--np-gap': 'clamp(1.5rem, 2vw, 2.5rem)',
  } as CSSProperties

  useEffect(() => {
    if (!open) return

    void window.puros.app.isFullScreen().then(setIsFullScreen).catch(() => {})

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (vizFullscreen) { setVizFullscreen(false); return }
        onClose()
      }
      if (event.key === 'F11') {
        event.preventDefault()
        void window.puros.app.toggleFullScreen().then(setIsFullScreen).catch(() => {})
      }
      if (event.key === 'f' || event.key === 'F') {
        if (activeTab === 'visualizer' && !(event.metaKey || event.ctrlKey || event.altKey)) {
          setVizFullscreen(v => !v)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, onClose, open, vizFullscreen])

  useEffect(() => {
    const unsubDetach = window.puros.on('visualizer:detached', () => setDetached(true))
    const unsubAttach = window.puros.on('visualizer:attached', () => setDetached(false))
    return () => { unsubDetach(); unsubAttach() }
  }, [setDetached])

  useEffect(() => {
    let cancelled = false
    void sampleArtworkColor(artworkSrc).then((color) => {
      if (!cancelled) setAmbientColor(color)
    })
    return () => {
      cancelled = true
    }
  }, [artworkSrc])

  useEffect(() => {
    setLargeArtworkSrc(artworkSrc)
    if (!open) return

    let cancelled = false
    void resolveHighResolutionArtwork(
      currentTrack,
      providerDescriptors,
      (providerId, capability, method, args) => window.puros.provider.invoke(providerId, capability, method, args),
    ).then((highResolutionArtworkSrc) => {
      if (cancelled || !highResolutionArtworkSrc || highResolutionArtworkSrc === artworkSrc) return
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => {
        if (!cancelled) setLargeArtworkSrc(highResolutionArtworkSrc)
      }
      image.src = highResolutionArtworkSrc
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [artworkSrc, currentTrack, open, providerDescriptors])

  useEffect(() => {
    if (shouldMountVisualizer || !open || isDetached) return

    const timeoutId = window.setTimeout(() => {
      setShouldMountVisualizer(true)
    }, 180)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [isDetached, open, shouldMountVisualizer])

  useEffect(() => {
    if (!currentTrack) {
      setLyrics(null)
      setLyricsLoading(false)
      return
    }

    const providers: LyricsProviderConfig[] = lyricsProviderPriority.map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      apiKey: provider.id === 'lrclib'
        ? ''
        : provider.id === 'musixmatch'
          ? lyricsApiKeys.musixmatch
          : lyricsApiKeys.genius,
    }))
    const signature = JSON.stringify({
      providers,
      trackId: currentTrack.id,
    })

    if (lastLyricsSignatureRef.current && lastLyricsSignatureRef.current !== signature) {
      lyricsProviderService.clearCache(currentTrack.id)
    }
    lastLyricsSignatureRef.current = signature

    let cancelled = false
    setLyricsLoading(true)
    void lyricsProviderService.getLyrics(currentTrack, providers).then((result) => {
      if (cancelled) return
      setLyrics(result)
      setLyricsLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [currentTrack, lyricsApiKeys, lyricsProviderPriority])

  useEffect(() => {
    if (!currentTrack?.catalogTrackId) {
      setTrackSummary(null)
      return
    }

    let cancelled = false
    void window.puros.catalog.getTrack(currentTrack.catalogTrackId).then((result) => {
      if (!cancelled) setTrackSummary(result)
    }).catch(() => {
      if (!cancelled) setTrackSummary(null)
    })

    return () => {
      cancelled = true
    }
  }, [currentTrack?.catalogTrackId])

  const creditsProviders = providerDescriptors
    .filter((descriptor) => descriptor.status.state === 'ready'
      && descriptor.manifest.capabilities.includes('metadata.credits')
      && (!descriptor.manifest.capabilities.includes('auth') || descriptor.status.authenticated))
    .map((descriptor) => descriptor.manifest.id)
  const currentProviderId = currentTrack?.provider
  const currentSourceId = currentTrack?.streamId ?? currentTrack?.sourceId
  const preferredCreditsSource = currentProviderId && currentSourceId && creditsProviders.includes(currentProviderId)
    ? { providerId: currentProviderId, sourceId: currentSourceId }
    : null
  const linkedCreditsSource = trackSummary?.sourceLinks.find((link) => link.available && creditsProviders.includes(link.provider))
  const creditsProviderId = preferredCreditsSource?.providerId ?? linkedCreditsSource?.provider ?? null
  const creditsSourceId = preferredCreditsSource?.sourceId ?? linkedCreditsSource?.sourceId ?? null
  const creditsCacheKey = creditsProviderId && creditsSourceId ? `${creditsProviderId}\u0000${creditsSourceId}` : null

  useEffect(() => {
    if (!creditsProviderId || !creditsSourceId || !creditsCacheKey) {
      setDetailedCredits(null)
      setDetailedCreditsLoading(false)
      return
    }

    const cached = detailedCreditsCacheRef.current.get(creditsCacheKey)
    if (cached !== undefined) {
      setDetailedCredits(cached)
      setDetailedCreditsLoading(false)
      return
    }

    let cancelled = false
    setDetailedCreditsLoading(true)
    const loadCredits = async (): Promise<ProviderTrackDetailsV1 | null> => {
      const details = await window.puros.provider.invoke(creditsProviderId, 'metadata.credits', 'getTrackDetails', [creditsSourceId])
      if (details.ok && details.value && typeof details.value === 'object' && !Array.isArray(details.value)) {
        return details.value as unknown as ProviderTrackDetailsV1
      }
      const credits = await window.puros.provider.invoke(creditsProviderId, 'metadata.credits', 'getCredits', [{ entityType: 'track', sourceId: creditsSourceId }])
      if (!credits.ok || !Array.isArray(credits.value)) return null
      const groups = new Map<string, string[]>()
      for (const credit of credits.value as unknown as ProviderCreditV1[]) {
        const names = groups.get(credit.role) ?? []
        names.push(credit.name)
        groups.set(credit.role, names)
      }
      return { sourceId: creditsSourceId, roles: [...groups].map(([role, contributors]) => ({ role, contributors })) }
    }
    void loadCredits().then((result) => {
      if (cancelled) return
      detailedCreditsCacheRef.current.set(creditsCacheKey, result)
      setDetailedCredits(result)
      setDetailedCreditsLoading(false)
    }).catch(() => {
      if (cancelled) return
      detailedCreditsCacheRef.current.set(creditsCacheKey, null)
      setDetailedCredits(null)
      setDetailedCreditsLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [creditsProviderId, creditsSourceId, creditsCacheKey])

  if (!currentTrack) return null

  const handleToggleFullScreen = () => {
    void window.puros.app.toggleFullScreen().then(setIsFullScreen).catch(() => {})
  }

  const tabs: Array<{ id: NowPlayingTab; label: string }> = [
    { id: 'lyrics', label: 'Lyrics' },
    { id: 'authors', label: 'Authors' },
    { id: 'visualizer', label: 'Visualizer' },
  ]
  const lyricsMeta = lyrics?.providerId ? `Source: ${LYRICS_PROVIDER_LABELS[lyrics.providerId]}` : 'No lyrics source'
  const authorsMeta = detailedCredits?.roles?.length
    ? `${detailedCredits.roles.length} role groups`
    : trackSummary?.credits?.length
      ? `${trackSummary.credits.length} credits`
      : 'Track credits'
  const visualizerMeta = isPlaying ? 'Playing' : 'Paused'
  const activeMeta = activeTab === 'lyrics' ? lyricsMeta : activeTab === 'authors' ? authorsMeta : visualizerMeta
  const panelHeader = (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="inline-flex w-fit rounded-full border border-white/10 bg-white/[0.04] p-1 backdrop-blur-xl">
        {tabs.map((tab) => {
          const active = tab.id === activeTab
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => { setActiveTab(tab.id); if (tab.id !== 'visualizer') setVizFullscreen(false) }}
              className={`rounded-full px-4 py-2 text-xs font-medium tracking-[0.14em] uppercase transition duration-200 ${
                active
                  ? 'bg-white text-black shadow-[0_10px_24px_rgba(255,255,255,0.14)]'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-zinc-500">{activeMeta}</p>
    </div>
  )

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-x-0 transition-opacity duration-300 ${
        vizFullscreen ? 'inset-0 z-50' : 'top-17 bottom-0 z-35'
      } ${open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
    >
      {artworkSrc ? (
        <div className="absolute inset-0 overflow-hidden">
          <div
            className="absolute opacity-30"
            style={{
              inset: '-38%',
              animationName: 'now-playing-ambient-rotate',
              animationDuration: '72s',
              animationTimingFunction: 'linear',
              animationIterationCount: 'infinite',
              animationPlayState: isPlaying ? 'running' : 'paused',
              willChange: 'transform',
              transformOrigin: 'center',
            }}
          >
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url("${artworkSrc}")`,
                backgroundPosition: 'center',
                backgroundSize: 'cover',
                filter: 'blur(64px) saturate(1.1)',
                animationName: 'now-playing-ambient-breathe',
                animationDuration: '24s',
                animationTimingFunction: 'ease-in-out',
                animationIterationCount: 'infinite',
                animationPlayState: isPlaying ? 'running' : 'paused',
                willChange: 'transform',
              }}
            />
          </div>
        </div>
      ) : null}

      <div
        className="absolute inset-0 transition-opacity duration-300"
        style={{ backgroundColor: 'rgba(5, 5, 7, 0.82)', backdropFilter: 'blur(48px)' }}
      />
      <div className="absolute inset-0 overflow-hidden transition-opacity duration-300">
        <div
          className="absolute"
          style={{
            inset: '-36%',
            animationName: 'now-playing-ambient-rotate',
            animationDuration: '92s',
            animationTimingFunction: 'linear',
            animationIterationCount: 'infinite',
            animationPlayState: isPlaying ? 'running' : 'paused',
            willChange: 'transform',
            transformOrigin: 'center',
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              background: `
                radial-gradient(circle at 18% 28%, ${rgba(ambientColor, 0.44)} 0%, transparent 42%),
                radial-gradient(circle at 82% 18%, ${rgba(ambientColor, 0.16)} 0%, transparent 30%),
                linear-gradient(180deg, rgba(4,4,5,0.88) 0%, rgba(4,4,6,0.95) 100%)
              `,
              animationName: 'now-playing-ambient-breathe',
              animationDuration: '32s',
              animationTimingFunction: 'ease-in-out',
              animationIterationCount: 'infinite',
              animationPlayState: isPlaying ? 'running' : 'paused',
              willChange: 'transform',
            }}
          />
        </div>
      </div>

      <div
        className="relative flex h-full flex-col overflow-hidden px-5 pb-28 pt-5 transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] md:px-8 md:pb-32 md:pt-8 xl:px-10"
        style={{
          // vizFullscreen: remove transform so that position:fixed children are
          // contained by the viewport (not this div), allowing the visualizer to
          // escape and cover the full screen including the player bar.
          transform: vizFullscreen ? 'none' : (open ? 'translateY(0)' : 'translateY(calc(100% + 6rem))'),
          opacity: open ? 1 : 0.92,
        }}
      >
        <div className="pointer-events-none absolute right-5 top-5 z-10 flex items-center gap-2 md:right-8 md:top-8 xl:right-10">
          <button
            type="button"
            aria-label={isFullScreen ? 'Exit Full Screen' : 'Enter Full Screen'}
            title={isFullScreen ? 'Exit Full Screen (F11)' : 'Enter Full Screen (F11)'}
            onClick={handleToggleFullScreen}
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/65 backdrop-blur-xl transition duration-200 hover:bg-white/10 hover:text-white"
          >
            {isFullScreen ? (
              <Minimize className="h-4 w-4" />
            ) : (
              <Maximize className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            aria-label="Minimize Now Playing"
            title="Minimize Now Playing"
            onClick={onClose}
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/65 backdrop-blur-xl transition duration-200 hover:bg-white/10 hover:text-white"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 min-h-0 items-center justify-center">
          <div
            className={`grid min-h-0 w-full items-start ${
              showLyricsPanel
                ? 'grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
                : 'grid-cols-1'
            }`}
            style={{
              ...duoLayoutStyle,
              gap: showLyricsPanel ? 'var(--np-gap)' : undefined,
              maxWidth: showLyricsPanel
                ? 'calc(var(--np-panel-size) * 2 + var(--np-gap))'
                : 'min(var(--np-panel-size), 100%)',
            }}
          >
            <div className={`flex min-h-0 flex-col ${showLyricsPanel ? '' : 'mx-auto w-full'}`}>
              <div
                className="relative aspect-square w-full overflow-hidden rounded-[30px] shadow-[0_30px_90px_rgba(0,0,0,0.5)]"
                style={{ maxWidth: 'var(--np-panel-size)' }}
              >
                {largeArtworkSrc ? (
                  <img
                    src={largeArtworkSrc}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="h-full w-full bg-zinc-900" />
                )}
                {dimAlbumArtWhenLyricsVisible && showLyricsPanel ? (
                  <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_36%,rgba(0,0,0,0.08)_62%,rgba(0,0,0,0.3)_100%)]" />
                ) : null}
              </div>
            </div>

            {showLyricsPanel ? (
              <div className="flex min-h-0 flex-col">
                <div
                  className="relative min-h-0 aspect-square w-full overflow-hidden"
                  style={{ maxWidth: 'var(--np-panel-size)' }}
                >
                  {activeTab === 'lyrics' ? (
                    <LyricsPanel
                      lyrics={lyrics}
                      loading={lyricsLoading}
                      position={position}
                      fontSize={lyricsFontSize}
                      headerContent={panelHeader}
                      onSeekToTime={lyrics?.synced ? (time) => {
                        seek(time)
                      } : undefined}
                    />
                  ) : null}
                  {activeTab === 'authors' ? (
                    <AuthorsPanel
                      detailedCredits={detailedCredits}
                      loading={detailedCreditsLoading}
                      track={trackSummary}
                      header={panelHeader}
                    />
                  ) : null}
                  {isDetached && activeTab === 'visualizer' ? (
                    <div className="relative flex h-full min-h-96 flex-col items-center justify-center gap-3 overflow-hidden rounded-4xl border border-white/8 bg-black/18 shadow-[0_24px_70px_rgba(0,0,0,0.22)] backdrop-blur-2xl">
                      <div className="border-b border-white/8 px-6 py-4 absolute top-0 inset-x-0">{panelHeader}</div>
                      <ExternalLink className="h-8 w-8 text-white/20" strokeWidth={1.5} />
                      <p className="text-sm text-white/30">Visualizer is open in a separate window</p>
                    </div>
                  ) : null}
                  {!isDetached && activeTab === 'visualizer' && !shouldMountVisualizer ? (
                    <div className="relative flex h-full min-h-96 flex-col items-center justify-center gap-3 overflow-hidden rounded-4xl border border-white/8 bg-black/18 shadow-[0_24px_70px_rgba(0,0,0,0.22)] backdrop-blur-2xl">
                      <div className="border-b border-white/8 px-6 py-4 absolute top-0 inset-x-0">{panelHeader}</div>
                      <div className="h-8 w-8 animate-pulse rounded-full border border-white/12 bg-white/[0.06]" />
                      <p className="text-sm text-white/30">Preparing visualizer…</p>
                    </div>
                  ) : null}
                  {!isDetached && shouldMountVisualizer ? (
                    <div
                      className={`absolute inset-0 transition-opacity duration-200 ${
                        activeTab === 'visualizer' ? 'opacity-100' : 'pointer-events-none opacity-0'
                      }`}
                      aria-hidden={activeTab !== 'visualizer'}
                    >
                      <VisualizerPanel
                        active={open && activeTab === 'visualizer'}
                        isPlaying={isPlaying}
                        ambientColor={ambientColor}
                        header={panelHeader}
                        vizFullscreen={vizFullscreen}
                        onToggleVizFullscreen={() => setVizFullscreen(v => !v)}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
