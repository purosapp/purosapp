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
import LyricsPanel, { EDGE_FADE_MASK } from './LyricsPanel'
import VisualizerPanel from './VisualizerPanel'
import JewelCaseArtwork from './JewelCaseArtwork'
import { useVisualizerStore } from '../../../store/visualizerStore'
import { useWindowActivity, useWindowDormant } from '../../../services/windowActivity'
import { enabledNowPlayingTabs, NOW_PLAYING_TAB_LABELS, type NowPlayingTabId } from '../../../services/nowPlayingTabs'

interface NowPlayingOverlayProps {
  open: boolean
  onClose: () => void
  /** Width of the docked queue column, which stays visible beside the overlay. */
  rightInset?: number
}

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

const AMBIENT_FILTER = 'blur(72px) saturate(1.6)'
// Size containment makes an element the containing block of fixed
// descendants, which would trap the fullscreen visualizer, so it is dropped then.
const containerFor = (vizFullscreen: boolean) => ({ containerType: vizFullscreen ? 'normal' : 'size' } as CSSProperties)

const ROUND_BUTTON_CLASS = 'flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-zinc-200 transition-colors hover:bg-white/[0.16] hover:text-white'

type NowPlayingTab = NowPlayingTabId

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

function AuthorsPanel({
  detailedCredits,
  loading,
  track,
}: {
  detailedCredits: ProviderTrackDetailsV1 | null
  loading: boolean
  track: CatalogTrackSummary | null
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

  if (loading || roleGroups.length === 0) {
    return (
      <div className="flex h-full items-center text-lg font-semibold text-white/40">
        {loading ? 'Loading credits…' : 'Credits unavailable for this track'}
      </div>
    )
  }

  const entry = (label: string, value: string) => (
    <div key={`${label}-${value}`}>
      <p className="text-[13px] font-medium text-white/50">{label}</p>
      <p className="mt-1 text-lg font-semibold leading-snug text-white">{value}</p>
    </div>
  )

  return (
    <div
      className="h-full overflow-y-auto pr-2"
      style={{ maskImage: EDGE_FADE_MASK, scrollbarWidth: 'none' }}
    >
      <div className="space-y-5 py-[10cqh]">
        {roleGroups.map((group) => entry(group.role, group.contributors.join(', ')))}
        {metadata.length > 0 ? (
          <div className="space-y-5 border-t border-white/10 pt-5">
            {metadata.map((item) => entry(item.label, item.value!))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function NowPlayingOverlay({ open, onClose, rightInset = 0 }: NowPlayingOverlayProps) {
  const {
    currentTrack,
    isPlaying,
    position,
    seek,
  } = usePlayerStore()
  const nowPlayingTabs = useSettingsStore((s) => s.nowPlayingTabs)
  const lyricsProviderPriority = useSettingsStore((s) => s.lyricsProviderPriority)
  const lyricsApiKeys = useSettingsStore((s) => s.lyricsApiKeys)
  const lyricsFontSize = useSettingsStore((s) => s.lyricsFontSize)
  const dimAlbumArtWhenLyricsVisible = useSettingsStore((s) => s.dimAlbumArtWhenLyricsVisible)
  const artworkStyle = useSettingsStore((s) => s.nowPlayingArtworkStyle)

  const isDetached = useVisualizerStore((s) => s.isDetached)
  const setDetached = useVisualizerStore((s) => s.setDetached)
  const windowActivity = useWindowActivity()
  const windowDormant = useWindowDormant()

  const [ambientColor, setAmbientColor] = useState(DEFAULT_ARTWORK_AMBIENT_COLOR)
  const [isFullScreen, setIsFullScreen] = useState(false)
  const [selectedTab, setSelectedTab] = useState<NowPlayingTab>('lyrics')
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
  const enabledTabs = enabledNowPlayingTabs(nowPlayingTabs)
  // The chosen tab may have been turned off in Settings since; fall back to the first one left.
  const activeTab: NowPlayingTab | undefined = enabledTabs.includes(selectedTab) ? selectedTab : enabledTabs[0]
  const showTabPanel = enabledTabs.length > 0
  const lyricsEnabled = nowPlayingTabs.lyrics
  const authorsEnabled = nowPlayingTabs.authors
  const visualizerEnabled = nowPlayingTabs.visualizer
  // Artwork side, sized from the stage (a size container): fits its height
  // under the track info, and with the lyrics column beside it, half its width.
  const stageLayoutStyle = {
    '--np-gap': 'clamp(2rem, 4cqw, 4.5rem)',
    '--np-info': '4.5rem',
    '--np-panel-size': showTabPanel
      ? 'min(calc(100cqh - var(--np-info)), calc((100cqw - var(--np-gap)) / 2), 46rem)'
      : 'min(calc(100cqh - var(--np-info)), 100cqw, 46rem)',
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

  // Turned off in Settings, or out of sight for a while: give the visualizer's
  // WebGL context back. After dormancy it remounts on return.
  useEffect(() => {
    if (windowDormant || !visualizerEnabled) {
      setShouldMountVisualizer(false)
      setVizFullscreen(false)
    }
  }, [visualizerEnabled, windowDormant])

  useEffect(() => {
    if (shouldMountVisualizer || !open || isDetached || windowDormant || !visualizerEnabled) return

    const timeoutId = window.setTimeout(() => {
      setShouldMountVisualizer(true)
    }, 180)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [isDetached, open, shouldMountVisualizer, visualizerEnabled, windowDormant])

  useEffect(() => {
    if (!currentTrack || !lyricsEnabled) {
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
  }, [currentTrack, lyricsApiKeys, lyricsEnabled, lyricsProviderPriority])

  // The catalog summary and provider credits only feed the Authors tab.
  useEffect(() => {
    if (!currentTrack?.catalogTrackId || !authorsEnabled) {
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
  }, [authorsEnabled, currentTrack?.catalogTrackId])

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
    if (!creditsProviderId || !creditsSourceId || !creditsCacheKey || !authorsEnabled) {
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
  }, [authorsEnabled, creditsProviderId, creditsSourceId, creditsCacheKey])

  if (!currentTrack) return null

  const handleToggleFullScreen = () => {
    void window.puros.app.toggleFullScreen().then(setIsFullScreen).catch(() => {})
  }

  const tabs = enabledTabs.map((id) => ({ id, label: NOW_PLAYING_TAB_LABELS[id] }))
  const lyricsMeta = lyrics?.providerId ? `Source: ${LYRICS_PROVIDER_LABELS[lyrics.providerId]}` : 'No lyrics source'
  const authorsMeta = detailedCredits?.roles?.length
    ? `${detailedCredits.roles.length} role groups`
    : trackSummary?.credits?.length
      ? `${trackSummary.credits.length} credits`
      : 'Track credits'
  const visualizerMeta = isPlaying ? 'Playing' : 'Paused'
  const activeMeta = activeTab === 'lyrics' ? lyricsMeta : activeTab === 'authors' ? authorsMeta : visualizerMeta
  const artistLine = [currentTrack.artist, currentTrack.album].filter(Boolean).join(' — ')
  const ambientLayer = (duration: string, reverse: boolean) => ({
    animationName: 'now-playing-ambient-rotate',
    animationDuration: duration,
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    animationDirection: reverse ? 'reverse' : 'normal',
    // Slow ambient drift; not worth the GPU while another app has focus.
    animationPlayState: isPlaying && windowActivity === 'active' ? 'running' : 'paused',
    willChange: 'transform',
    transformOrigin: 'center',
  } as CSSProperties)
  const visualizerPlaceholder = (icon: ReactNode, label: string) => (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[30px] bg-black/30">
      {icon}
      <p className="text-sm text-white/40">{label}</p>
    </div>
  )

  return (
    <div
      aria-hidden={!open}
      className={`fixed left-0 overflow-hidden bg-black transition-[opacity,right] duration-300 ease-out ${
        vizFullscreen ? 'inset-y-0 z-50' : 'inset-y-0 z-41'
      } ${open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
      style={{ right: vizFullscreen ? 0 : rightInset }}
    >
      {/* Living artwork backdrop, like Apple Music's full-screen player: two
          heavily blurred copies of the cover turning against each other. */}
      {artworkSrc ? (
        <div className="absolute inset-0">
          <div className="absolute" style={{ inset: '-30%', ...ambientLayer('80s', false) }}>
            <div
              className="absolute inset-0"
              style={{ backgroundImage: `url("${artworkSrc}")`, backgroundPosition: 'center', backgroundSize: 'cover', filter: AMBIENT_FILTER }}
            />
          </div>
          <div className="absolute" style={{ left: '-10%', top: '-40%', width: '90%', height: '120%', ...ambientLayer('56s', true) }}>
            <div
              className="absolute inset-0 rounded-full opacity-80"
              style={{ backgroundImage: `url("${artworkSrc}")`, backgroundPosition: 'center', backgroundSize: 'cover', filter: AMBIENT_FILTER }}
            />
          </div>
        </div>
      ) : null}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(circle at 20% 30%, ${rgba(ambientColor, 0.28)} 0%, transparent 55%),
            linear-gradient(180deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.52) 60%, rgba(0,0,0,0.68) 100%)
          `,
        }}
      />

      <div
        className="relative flex h-full flex-col transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{
          // vizFullscreen: remove transform so that position:fixed children are
          // contained by the viewport (not this div), allowing the visualizer to
          // escape and cover the full screen including the player bar.
          transform: vizFullscreen ? 'none' : (open ? 'translateY(0)' : 'translateY(3rem)'),
          opacity: open ? 1 : 0,
        }}
      >
        {/* Title bar row: drags the window (traffic lights sit on the left).
            Only while open: Electron honours drag regions on invisible,
            pointer-events: none elements, and the closed row would swallow
            clicks on the sidebar and title bar beneath it. */}
        <div className="relative flex h-17 shrink-0 items-center justify-center px-4" style={open ? drag : undefined}>
          {showTabPanel ? (
            <div role="tablist" className="inline-flex items-center gap-0.5 rounded-full bg-white/[0.08] p-1" style={noDrag}>
              {tabs.map((tab) => {
                const active = tab.id === activeTab
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => { setSelectedTab(tab.id); if (tab.id !== 'visualizer') setVizFullscreen(false) }}
                    className={`h-7 rounded-full px-3.5 text-[13px] font-medium transition-colors ${
                      active ? 'bg-white text-zinc-950' : 'text-zinc-300 hover:bg-white/[0.08] hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                )
              })}
            </div>
          ) : null}
          <div className="absolute right-4 flex items-center gap-2" style={noDrag}>
            <button
              type="button"
              aria-label={isFullScreen ? 'Exit Full Screen' : 'Enter Full Screen'}
              title={isFullScreen ? 'Exit Full Screen (F11)' : 'Enter Full Screen (F11)'}
              onClick={handleToggleFullScreen}
              className={ROUND_BUTTON_CLASS}
            >
              {isFullScreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
            <button
              type="button"
              aria-label="Minimize Now Playing"
              title="Minimize Now Playing (Esc)"
              onClick={onClose}
              className={ROUND_BUTTON_CLASS}
            >
              <ChevronDown className="h-4.5 w-4.5" strokeWidth={2.25} />
            </button>
          </div>
        </div>

        {/* Stage: everything between the title bar and the floating player. */}
        <div className="min-h-0 flex-1 px-8 pb-28 pt-4 xl:px-12" style={containerFor(vizFullscreen)}>
          <div
            className="flex h-full items-center justify-center"
            style={{ ...stageLayoutStyle, gap: 'var(--np-gap)' }}
          >
            <div className="flex shrink-0 flex-col" style={{ width: 'var(--np-panel-size)' }}>
              {artworkStyle === 'jewelCase' ? (
                <JewelCaseArtwork
                  src={largeArtworkSrc}
                  active={open && windowActivity === 'active'}
                  dimmed={dimAlbumArtWhenLyricsVisible && showTabPanel}
                />
              ) : (
                <div className="relative aspect-square w-full overflow-hidden rounded-[30px] shadow-[0_30px_90px_rgba(0,0,0,0.5)]">
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
                  {dimAlbumArtWhenLyricsVisible && showTabPanel ? (
                    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_36%,rgba(0,0,0,0.08)_62%,rgba(0,0,0,0.3)_100%)]" />
                  ) : null}
                </div>
              )}
              <div className="flex min-w-0 flex-col justify-end" style={{ height: 'var(--np-info)' }}>
                <p className="truncate text-xl font-bold tracking-tight text-white">{currentTrack.title}</p>
                {artistLine ? (
                  <p className="mt-0.5 truncate text-[15px] font-medium text-white/60">{artistLine}</p>
                ) : null}
              </div>
            </div>

            {showTabPanel ? (
              <div
                className="relative flex shrink-0 flex-col"
                style={{ width: 'var(--np-panel-size)', height: 'calc(var(--np-panel-size) + var(--np-info))' }}
              >
                <div className="relative min-h-0 flex-1" style={containerFor(vizFullscreen)}>
                  {activeTab === 'lyrics' ? (
                    <LyricsPanel
                      lyrics={lyrics}
                      loading={lyricsLoading}
                      position={position}
                      fontSize={lyricsFontSize}
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
                    />
                  ) : null}
                  {isDetached && activeTab === 'visualizer'
                    ? visualizerPlaceholder(<ExternalLink className="h-8 w-8 text-white/25" strokeWidth={1.5} />, 'Visualizer is open in a separate window')
                    : null}
                  {!isDetached && activeTab === 'visualizer' && !shouldMountVisualizer
                    ? visualizerPlaceholder(<div className="h-8 w-8 animate-pulse rounded-full bg-white/10" />, 'Preparing visualizer…')
                    : null}
                  {visualizerEnabled && !isDetached && shouldMountVisualizer ? (
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
                        vizFullscreen={vizFullscreen}
                        onToggleVizFullscreen={() => setVizFullscreen(v => !v)}
                      />
                    </div>
                  ) : null}
                </div>
                <p className="flex shrink-0 items-end text-xs font-medium text-white/40" style={{ height: 'calc(var(--np-info) - 2.75rem)' }}>
                  {activeMeta}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
