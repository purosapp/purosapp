/**
 * Shared building blocks for content pages, so every page uses the same
 * buttons, search fields, titles, section headings and status messages.
 *
 * Shape scale (keep new UI on it):
 * - Controls (buttons, search fields, tabs, chips): fully round.
 * - Surfaces (track lists, panels, notices): rounded-2xl.
 * - Artwork: hero rounded-2xl, tiles rounded-xl, row thumbnails rounded-md;
 *   artists are always round.
 */

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react'
import { ChevronDown, Loader2, Search, X, type LucideIcon } from 'lucide-react'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'ghost' | 'danger'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** primary: white (or `accentColor`) fill; secondary: glass pill; quiet: low-emphasis pill; ghost: text only; danger: destructive actions. */
  variant?: ButtonVariant
  /** md for pages, sm for toolbars and forms, xs for dense panels (EQ, popovers). */
  size?: 'md' | 'sm' | 'xs'
  icon?: LucideIcon
  /** Round icon button; `label` becomes its tooltip and accessible name. */
  iconOnly?: boolean
  label: ReactNode
  /** CSS colour for a primary button (e.g. the cover's key colour); text stays dark. */
  accentColor?: string
  /** Pressed state for toggles. */
  active?: boolean
  /** Solid icon (the Play triangle). */
  iconFilled?: boolean
}

const BUTTON_SIZE = {
  md: { box: 'h-9 px-4 gap-2 text-sm', square: 'w-9', icon: 15 },
  sm: { box: 'h-8 px-3 gap-1.5 text-[13px]', square: 'w-8', icon: 14 },
  xs: { box: 'h-7 px-2.5 gap-1.5 text-xs', square: 'w-7', icon: 13 },
} as const

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'text-zinc-950 hover:brightness-110',
  secondary: 'border border-white/10 bg-white/[0.08] text-zinc-100 backdrop-blur-md hover:bg-white/[0.14]',
  quiet: 'border border-white/[0.08] bg-white/[0.03] text-zinc-300 backdrop-blur-md hover:bg-white/[0.08] hover:text-zinc-100',
  ghost: 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100',
  danger: 'border border-red-400/25 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconOnly = false,
  label,
  accentColor,
  active = false,
  iconFilled = false,
  className = '',
  style,
  title,
  type = 'button',
  ...rest
}: ButtonProps) {
  const sizing = BUTTON_SIZE[size]
  const textLabel = typeof label === 'string' ? label : undefined
  return (
    <button
      type={type}
      title={title ?? (iconOnly ? textLabel : undefined)}
      aria-label={iconOnly ? textLabel : undefined}
      aria-pressed={active || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-medium transition-colors disabled:cursor-default disabled:opacity-40 ${sizing.box} ${
        iconOnly ? `${sizing.square} !px-0` : ''
      } ${BUTTON_VARIANT[variant]} ${variant === 'primary' && !accentColor ? 'bg-white' : ''} ${
        active ? '!bg-white/[0.16] !text-white' : ''
      } ${className}`}
      style={variant === 'primary' && accentColor ? { backgroundColor: accentColor, ...style } : style}
      {...rest}
    >
      {Icon && (
        <Icon
          size={sizing.icon}
          strokeWidth={variant === 'primary' ? 2.25 : 2}
          className={iconFilled ? 'fill-current' : undefined}
        />
      )}
      {!iconOnly && label}
    </button>
  )
}

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> {
  value: string
  onChange: (value: string) => void
  /** sm for dense panels (EQ, popovers). */
  size?: 'md' | 'sm'
  /** Extra classes for the pill (width, emphasis). */
  className?: string
}

/** The one search/filter field: a pill with a search icon and a clear button. */
export const SearchField = forwardRef(function SearchField(
  { value, onChange, size = 'md', className = 'w-56', placeholder = 'Search', onKeyDown, ...rest }: SearchFieldProps,
  ref: Ref<HTMLInputElement>,
) {
  return (
    <label
      className={`group/search flex min-w-0 items-center rounded-full border border-white/[0.08] bg-white/[0.04] transition-colors hover:border-white/15 focus-within:border-white/20 focus-within:bg-white/[0.06] ${
        size === 'sm' ? 'h-8 gap-2 px-3' : 'h-9 gap-2.5 px-3.5'
      } ${className}`}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-colors group-focus-within/search:text-zinc-200" />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event)
          if (event.defaultPrevented || event.key !== 'Escape' || !value) return
          event.preventDefault()
          onChange('')
        }}
        placeholder={placeholder}
        aria-label={rest['aria-label'] ?? placeholder}
        className={`min-w-0 flex-1 bg-transparent text-zinc-100 placeholder-zinc-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden ${size === 'sm' ? 'text-xs' : 'text-sm'}`}
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange('')}
          className="shrink-0 rounded-full p-0.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </label>
  )
})

/**
 * Text inputs outside of search: pills like every other control. `sm` is for
 * dense forms (Settings, EQ); textareas get the surface radius instead.
 */
const FIELD_BASE = 'border border-white/[0.08] bg-white/[0.04] text-zinc-100 placeholder-zinc-500 transition-colors hover:border-white/15 focus:outline-none focus:border-white/25 focus:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40'
export const FIELD_CLASS = `${FIELD_BASE} h-9 rounded-full px-4 text-sm`
export const FIELD_SM_CLASS = `${FIELD_BASE} h-8 rounded-full px-3 text-xs`
export const TEXTAREA_CLASS = `${FIELD_BASE} rounded-2xl px-4 py-3 text-sm`
export const TEXTAREA_SM_CLASS = `${FIELD_BASE} rounded-xl px-3 py-2 text-xs`

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'md' | 'sm'
  /** Classes for the wrapper (width, margins). */
  className?: string
}

/** Native select in a pill with our own chevron. */
export function SelectField({ size = 'sm', className = '', children, ...rest }: SelectFieldProps) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <select
        {...rest}
        className={`w-full appearance-none rounded-full border border-white/[0.08] bg-white/[0.04] pr-8 text-zinc-200 transition-colors hover:border-white/15 focus:outline-none focus:border-white/25 disabled:cursor-not-allowed disabled:opacity-40 ${
          size === 'sm' ? 'h-8 pl-3 text-xs' : 'h-9 pl-4 text-sm'
        }`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
    </span>
  )
}

/** Shared title typography: every page and collection header uses these. */
export const PAGE_KICKER_CLASS = 'text-[11px] uppercase tracking-[0.24em] text-zinc-400'
export const PAGE_TITLE_CLASS = 'text-4xl font-bold tracking-tight text-white'

/**
 * Header for list pages (Artists, Albums, Tracks, History, …): kicker, title,
 * a one-line subtitle, and controls on the right.
 */
export function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
  leading,
  className = '',
}: {
  kicker?: string
  title: ReactNode
  subtitle?: ReactNode
  /** Right-aligned controls: search field, sort, clear… */
  actions?: ReactNode
  /** Rendered before the title block (e.g. a back button). */
  leading?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-4 px-6 pt-8 pb-5 shrink-0 ${className}`}>
      <div className="flex min-w-0 items-end gap-4">
        {leading}
        <div className="min-w-0">
          {kicker && <p className={PAGE_KICKER_CLASS}>{kicker}</p>}
          <h1 className={`${kicker ? 'mt-1.5' : ''} ${PAGE_TITLE_CLASS} truncate`}>{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-zinc-400">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Section heading used inside pages ("Top Tracks", "Recently Played", …). */
export function Section({
  title,
  action,
  children,
  aside,
}: {
  title: string
  /** e.g. a ghost "Show more" button. */
  action?: ReactNode
  /** Small element next to the title (provider badge, count). */
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400">{title}</h2>
          {aside}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * Centered loading / empty message for a page or a page area. `fill` stretches
 * it over the remaining height of a flex column; otherwise it pads itself.
 */
export function PageStatus({
  loading = false,
  title,
  hint,
  fill = false,
}: {
  loading?: boolean
  title?: ReactNode
  hint?: ReactNode
  fill?: boolean
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-6 text-center ${fill ? 'flex-1' : 'py-16'}`}>
      {loading && <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />}
      <p className="text-sm text-zinc-400">{title ?? (loading ? 'Loading…' : null)}</p>
      {hint && <p className="max-w-md text-xs text-zinc-500">{hint}</p>}
    </div>
  )
}

/** Inline notice box for empty sections ("Open or play a playlist and it will appear here."). */
export function SectionNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.03] px-5 py-4 text-sm text-zinc-500">
      {children}
    </div>
  )
}
