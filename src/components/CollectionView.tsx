/**
 * CollectionView — the shared page for albums, singles, EPs, playlists and artists.
 *
 * One hero (artwork, kind, title, byline, meta chips, actions, search) over a
 * radial glow in the cover's key colour that fades out to the edges and the
 * bottom. The glow is painted by the shell (CollectionGlow) so it also sits
 * behind the title bar; this view only publishes the colour. The glow follows
 * the page through a CSS scroll timeline (see .collection-glow in index.css).
 * Artist pages use the 'backdrop' shape instead: the photo fills the top of
 * the window behind the title bar and the hero and fades into the page, like
 * Apple Music. The shell paints it too, next to the glow.
 * Each view only decides which actions it shows; the track list and any extra
 * sections come in as children. Search sits in the action row as a button
 * (after Shuffle) that expands into a field. CollectionSkeleton is the same
 * layout while the page loads, so nothing jumps when it arrives.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Search, X, type LucideIcon } from 'lucide-react'
import { rgba, sampleArtworkKeyColor, type RgbColor } from '../utils/artworkColor'
import { Button, PAGE_KICKER_CLASS, PAGE_TITLE_CLASS } from './ui'
import { TrackListSkeleton } from './TrackList'
import { useCollectionGlowStore } from '../store/collectionGlowStore'

export interface CollectionAction {
  id: string
  label: string
  icon: LucideIcon
  onClick: () => void
  /** primary: the cover-tinted Play button; secondary: glass pill; quiet: low-emphasis pill. */
  variant?: 'primary' | 'secondary' | 'quiet'
  /** 'end' pushes the action to the right edge of the row (Add, Open Source, …). */
  align?: 'start' | 'end'
  disabled?: boolean
  title?: string
  /** Round icon button; the label becomes its tooltip. */
  iconOnly?: boolean
}

export interface CollectionMetaChip {
  id: string
  label: string
  icon?: LucideIcon
}

/**
 * Keep the key colour's hue but move it into a glowing range: covers are often
 * dominated by deep tones (navy, oxblood) that vanish on a black page. Near-grey
 * colours keep their low saturation so monochrome covers stay monochrome.
 */
function toGlowColor({ r, g, b }: RgbColor): RgbColor {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta > 0) {
    if (max === red) hue = ((green - blue) / delta) % 6
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))

  const s = saturation < 0.12 ? saturation : Math.max(saturation, 0.6)
  const l = Math.min(Math.max(lightness, 0.45), 0.6)

  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - chroma / 2
  const [r1, g1, b1] = hue < 60 ? [chroma, x, 0]
    : hue < 120 ? [x, chroma, 0]
      : hue < 180 ? [0, chroma, x]
        : hue < 240 ? [0, x, chroma]
          : hue < 300 ? [x, 0, chroma]
            : [chroma, 0, x]
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  }
}

function useArtworkColor(src: string | null): RgbColor | null {
  const [color, setColor] = useState<RgbColor | null>(null)
  useEffect(() => {
    let cancelled = false
    setColor(null)
    if (!src) return
    void sampleArtworkKeyColor(src).then((next) => {
      if (!cancelled) setColor(toGlowColor(next))
    })
    return () => { cancelled = true }
  }, [src])
  return color
}

/** Lift the key colour toward white so the Play button stays readable with dark text. */
function lighten(color: RgbColor, amount: number): RgbColor {
  return {
    r: Math.round(color.r + (255 - color.r) * amount),
    g: Math.round(color.g + (255 - color.g) * amount),
    b: Math.round(color.b + (255 - color.b) * amount),
  }
}

/**
 * The shell-level glow: spans the title bar and the top of the content column
 * and moves up with the page as it scrolls. Renders nothing outside a
 * collection page. The caller positions it.
 */
export function CollectionGlow({ className = '', style }: { className?: string; style?: CSSProperties }) {
  const color = useCollectionGlowStore((state) => state.color)
  const backdrop = useCollectionGlowStore((state) => state.backdrop)
  return (
    <div aria-hidden className={`pointer-events-none overflow-hidden ${className}`} style={style}>
      {/* Moved by the page's scroll timeline on the compositor, in the same frame as the page. */}
      <div className="collection-glow absolute inset-x-0 top-0 h-[720px]">
        {/* The photo replaces the glow on artist pages. */}
        <div
          className="absolute inset-0 transition-opacity duration-700"
          style={{
            opacity: color && !backdrop ? 1 : 0,
            background: color
              ? `radial-gradient(ellipse 90% 100% at 50% 0%, ${rgba(color, 0.42)} 0%, ${rgba(color, 0.16)} 45%, ${rgba(color, 0)} 100%)`
              : undefined,
          }}
        />
        {backdrop && (
          // Title bar plus the hero: the photo ends just under the action row.
          <div className="absolute inset-x-0 top-0 h-[528px]">
            {/* Faces sit in the upper part of most artist photos. */}
            <img src={backdrop} alt="" decoding="async" className="h-full w-full object-cover object-[50%_25%]" />
            <div className="absolute inset-0" style={{ background: `${BACKDROP_FADE}, ${BACKDROP_SCRIM}` }} />
          </div>
        )}
      </div>
    </div>
  )
}

type ArtworkShape = 'square' | 'round' | 'backdrop'

/** The text sits on the lower, faded part of the backdrop photo. */
const BACKDROP_MIN_HERO = 'min-h-[320px]'
// Solid under the title bar, fading out into the page. A plain overlay rather
// than a CSS mask: a masked layer is repainted on every scroll frame.
const BACKDROP_FADE = 'linear-gradient(to bottom, rgba(0, 0, 0, 0) 50%, rgb(0, 0, 0) 100%)'
// Darkens the left side so the title and bio stay readable over bright photos.
const BACKDROP_SCRIM = 'linear-gradient(to right, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0.25) 45%, rgba(0, 0, 0, 0) 75%)'

function ActionButton({ action, accent }: { action: CollectionAction; accent: RgbColor | null }) {
  const variant = action.variant ?? 'secondary'
  return (
    <Button
      variant={variant}
      icon={action.icon}
      iconFilled={variant === 'primary'}
      iconOnly={action.iconOnly}
      label={action.label}
      title={action.title}
      disabled={action.disabled}
      onClick={action.onClick}
      accentColor={variant === 'primary' && accent ? rgba(lighten(accent, 0.45), 1) : undefined}
    />
  )
}

interface CollectionSearch {
  value: string
  onChange: (value: string) => void
  placeholder: string
}

/** Icon pill that grows into a search field; folds back when left empty. */
function SearchToggle({ search }: { search: CollectionSearch }) {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const expanded = open || search.value !== ''

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  return (
    <div
      className={`inline-flex items-center h-9 rounded-full border backdrop-blur-md overflow-hidden transition-[width,background-color,border-color] duration-300 ease-out ${
        expanded
          ? 'w-56 bg-white/[0.06] border-white/20'
          : 'w-9 bg-white/[0.08] border-white/10 hover:bg-white/[0.14]'
      }`}
    >
      <button
        type="button"
        onClick={() => (expanded ? inputRef.current?.focus() : setOpen(true))}
        title="Search"
        aria-label={search.placeholder}
        aria-expanded={expanded}
        className="shrink-0 w-[34px] h-full flex items-center justify-center text-zinc-100"
      >
        <Search size={15} strokeWidth={2} />
      </button>
      <input
        ref={inputRef}
        type="text"
        value={search.value}
        tabIndex={expanded ? 0 : -1}
        onChange={(event) => search.onChange(event.target.value)}
        onBlur={() => { if (!search.value) setOpen(false) }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          search.onChange('')
          setOpen(false)
          event.currentTarget.blur()
        }}
        placeholder={search.placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
      />
      {search.value && (
        <button
          type="button"
          onClick={() => {
            search.onChange('')
            inputRef.current?.focus()
          }}
          title="Clear search"
          className="shrink-0 w-8 h-full flex items-center justify-center text-zinc-400 hover:text-zinc-100"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

export default function CollectionView({
  kind,
  title,
  artworkSrc,
  artworkShape = 'square',
  byline,
  chips = [],
  description,
  actions,
  heroExtra,
  search,
  children,
}: {
  /** Small label above the title: Album, Single, EP, Playlist, Mix, Station. */
  kind: string
  title: string
  artworkSrc: string | null
  /** 'round' for artist photos; 'backdrop' spreads the photo behind the hero. */
  artworkShape?: ArtworkShape
  /** Artist link, provider badge — whatever identifies the owner. */
  byline?: ReactNode
  chips?: CollectionMetaChip[]
  description?: ReactNode
  actions: CollectionAction[]
  /** Rendered under the actions (version picker, selection hints, …). */
  heroExtra?: ReactNode
  search?: CollectionSearch
  children: ReactNode
}) {
  const color = useArtworkColor(artworkSrc)
  const setGlowColor = useCollectionGlowStore((state) => state.setColor)
  const setGlowBackdrop = useCollectionGlowStore((state) => state.setBackdrop)

  useEffect(() => {
    setGlowColor(color)
  }, [color, setGlowColor])

  // Without a photo an artist falls back to the round placeholder.
  const backdrop = artworkShape === 'backdrop' && !!artworkSrc

  useEffect(() => {
    setGlowBackdrop(backdrop ? artworkSrc : null)
  }, [artworkSrc, backdrop, setGlowBackdrop])

  useEffect(() => {
    return () => {
      setGlowColor(null)
      setGlowBackdrop(null)
    }
  }, [setGlowBackdrop, setGlowColor])
  const startActions = actions.filter((action) => action.align !== 'end')
  // The search button follows Shuffle, or closes the leading group without one.
  const searchAfter = startActions.findIndex((action) => action.id === 'shuffle')
  const searchIndex = searchAfter >= 0 ? searchAfter + 1 : startActions.length
  const endActions = actions.filter((action) => action.align === 'end')

  return (
    <div className="collection-scroller relative flex-1 min-h-0 overflow-y-auto">
      <div className="relative px-6 pt-8">
        <div className={backdrop
          ? `relative flex ${BACKDROP_MIN_HERO} flex-col justify-end`
          : 'flex flex-col md:flex-row md:items-end gap-6'}
        >
          {!backdrop && (
            <div className={`w-52 h-52 shrink-0 ${artworkShape === 'square' ? 'rounded-2xl' : 'rounded-full'} overflow-hidden bg-white/[0.04] border border-white/10 shadow-[0_18px_50px_rgba(0,0,0,0.45)]`}>
              {artworkSrc ? (
                <img src={artworkSrc} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-6xl text-zinc-600 font-semibold">
                  {(title || '?').charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          )}

          <div className={`min-w-0 ${backdrop ? '' : 'flex-1'}`}>
            <p className={PAGE_KICKER_CLASS}>{kind}</p>
            <h1 className={`mt-1.5 truncate ${PAGE_TITLE_CLASS}`}>{title}</h1>
            {byline && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-200">{byline}</div>
            )}
            {chips.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {chips.map((chip) => {
                  const Icon = chip.icon
                  return (
                    <span
                      key={chip.id}
                      className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border border-white/10 bg-black/20 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-300"
                    >
                      {Icon && <Icon size={11} strokeWidth={2.25} />}
                      {chip.label}
                    </span>
                  )
                })}
              </div>
            )}
            {description && <div className="mt-3 max-w-2xl text-sm text-zinc-400">{description}</div>}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {startActions.slice(0, searchIndex).map((action) => (
                <ActionButton key={action.id} action={action} accent={color} />
              ))}
              {search && <SearchToggle search={search} />}
              {startActions.slice(searchIndex).map((action) => (
                <ActionButton key={action.id} action={action} accent={color} />
              ))}
              {endActions.length > 0 && <div className="flex-1" />}
              {endActions.map((action) => (
                <ActionButton key={action.id} action={action} accent={color} />
              ))}
            </div>
          </div>
        </div>

        {heroExtra && <div className="mt-5">{heroExtra}</div>}
      </div>

      <div className="relative px-6 pt-8 pb-6">{children}</div>
    </div>
  )
}

/**
 * The collection page while it loads: same hero geometry (artwork size and
 * shape, title position, chip and button rows) and a track list skeleton.
 */
export function CollectionSkeleton({
  kind,
  title,
  artworkShape = 'square',
  trackArtwork = true,
}: {
  kind: string
  /** Known title (e.g. from the tile that was clicked), or a placeholder bar. */
  title?: string
  artworkShape?: ArtworkShape
  /** Match the loaded list: album pages show no per-track covers. */
  trackArtwork?: boolean
}) {
  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto" aria-busy>
      <div className="relative px-6 pt-8">
        {artworkShape === 'backdrop' && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[460px] animate-pulse bg-gradient-to-b from-white/[0.05] to-transparent"
          />
        )}
        <div className={artworkShape === 'backdrop'
          ? `relative flex ${BACKDROP_MIN_HERO} flex-col justify-end`
          : 'flex flex-col md:flex-row md:items-end gap-6'}
        >
          {artworkShape !== 'backdrop' && (
            <div className={`w-52 h-52 shrink-0 animate-pulse bg-white/[0.06] ${artworkShape === 'round' ? 'rounded-full' : 'rounded-2xl'}`} />
          )}
          <div className="min-w-0 flex-1">
            <p className={PAGE_KICKER_CLASS}>{kind}</p>
            {title ? (
              <h1 className={`mt-1.5 truncate ${PAGE_TITLE_CLASS}`}>{title}</h1>
            ) : (
              <div className="mt-3 h-9 w-72 max-w-full animate-pulse rounded-full bg-white/[0.07]" />
            )}
            <div className="mt-4 h-4 w-40 animate-pulse rounded-full bg-white/[0.05]" />
            <div className="mt-4 flex gap-1.5">
              {[64, 80, 56].map((width) => (
                <div key={width} className="h-6 animate-pulse rounded-full bg-white/[0.05]" style={{ width }} />
              ))}
            </div>
            <div className="mt-5 flex gap-2">
              {[88, 104, 36].map((width) => (
                <div key={width} className="h-9 animate-pulse rounded-full bg-white/[0.06]" style={{ width }} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="relative px-6 pt-8 pb-6">
        <TrackListSkeleton rows={8} showArtwork={trackArtwork} />
      </div>
    </div>
  )
}
