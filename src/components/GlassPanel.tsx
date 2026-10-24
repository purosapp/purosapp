/**
 * Liquid-glass panels for popovers, modals and dialogs: the floating player
 * bar's glass, with a slightly darker tint so dense text stays readable.
 *
 * An element with a backdrop filter only samples what is painted inside its
 * nearest ancestor that also has one (and becomes the containing block of
 * fixed descendants), so glass that sits over the page is portalled to
 * <body> instead of living inside the player bar or the settings modal.
 */

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useLiquidGlass } from './useLiquidGlass'

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Corner radius in px; keep it in sync with any rounded-* class. */
  radius: number
  /** Opacity of the black tint over the glass. */
  tint?: number
}

/**
 * Shared glass for the player bar, the queue and the popovers (signal path,
 * audio effects). The bar keeps a light blur so what scrolls under it stays
 * recognisable; the panels blur more because they hold denser text. The tint
 * keeps small text readable over bright artwork, a little lighter on the bar
 * because its type is larger.
 */
export const BAR_BLUR = 1.5
export const PANEL_BLUR = 7
export const GLASS_SATURATION = 1.5
export const BAR_TINT = 0.48
export const PANEL_TINT = 0.55
const TINT = PANEL_TINT
/** Settings and its dialogs are dense forms: nearly opaque, only the rim stays glassy. */
export const SOLID_GLASS_TINT = 0.92

/** A rounded panel of liquid glass. The caller positions it (relative, absolute or fixed). */
export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(function GlassPanel(
  { radius, tint = TINT, style, children, ...rest },
  ref,
) {
  const panelRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => panelRef.current!, [])
  const glass = useLiquidGlass(panelRef, { radius, blur: PANEL_BLUR, saturation: GLASS_SATURATION })
  return (
    <div
      ref={panelRef}
      {...rest}
      style={{
        borderRadius: radius,
        ...glass.style,
        background: `rgba(0, 0, 0, ${tint})`,
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 12px 40px rgba(0, 0, 0, 0.45)',
        ...style,
      }}
    >
      {glass.layers}
      {children}
    </div>
  )
})

interface GlassPopoverProps extends Omit<GlassPanelProps, 'style'> {
  /** Element the popover opens from. */
  anchorRef: RefObject<HTMLElement | null>
  /** above: over the anchor, right-aligned to it; left: beside it, vertically centred on it. */
  placement?: 'above' | 'left'
  /** Space between the anchor and the popover, in px. */
  gap?: number
  /**
   * For popovers that stay mounted while closed: the anchor can move after
   * mount (the player bar reflows as tracks load, especially in a narrow
   * window), so it is measured again each time this turns true.
   */
  open?: boolean
  style?: CSSProperties
  children: ReactNode
}

type PopoverPosition =
  | { placement: 'above'; bottom: number; right: number }
  | { placement: 'left'; top: number; right: number }

/** Glass popover opening above or beside `anchorRef`, rendered at the document root. */
export const GlassPopover = forwardRef<HTMLDivElement, GlassPopoverProps>(function GlassPopover(
  { anchorRef, placement = 'above', gap = 8, open = true, className = '', style, children, ...rest },
  ref,
) {
  const [position, setPosition] = useState<PopoverPosition | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const update = () => {
      const anchor = anchorRef.current
      // A popover rendered inside its anchor mounts before the anchor's ref is
      // attached; measure again next frame instead of staying hidden.
      if (!anchor) {
        frame = requestAnimationFrame(update)
        return
      }
      const rect = anchor.getBoundingClientRect()
      setPosition(placement === 'left'
        ? { placement, top: rect.top + rect.height / 2, right: window.innerWidth - rect.left + gap }
        : { placement, bottom: window.innerHeight - rect.top + gap, right: Math.max(8, window.innerWidth - rect.right) })
    }
    update()
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
    }
  }, [anchorRef, gap, placement, open])

  return createPortal(
    <GlassPanel
      ref={ref}
      {...rest}
      className={className}
      style={{
        position: 'fixed',
        zIndex: 60,
        ...(position?.placement === 'left'
          // Centred on the anchor; `transform` leaves Tailwind's `translate` free for enter animations.
          ? { top: position.top, right: position.right, transform: 'translateY(-50%)' }
          : { bottom: position?.bottom ?? 0, right: position?.right ?? 0 }),
        visibility: position ? undefined : 'hidden',
        ...style,
      }}
    >
      {children}
    </GlassPanel>,
    document.body,
  )
})
