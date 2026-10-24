/**
 * Page scroll areas fade and blur into the title bar instead of being cut off
 * by it (see the [data-scroll-fade] rules in index.css). The effect ramps in
 * over the first SCROLL_FADE_PX of scrolling so content at rest stays sharp.
 */
export const SCROLL_FADE_PX = 64

/** Capture-phase scroll listener for a column that holds page scroll areas. */
export function trackScrollFade(column: HTMLElement): () => void {
  const onScroll = (event: Event) => {
    const page = event.target
    if (!(page instanceof HTMLElement) || !page.classList.contains('overflow-y-auto')) return
    const fade = Math.min(page.scrollTop, SCROLL_FADE_PX)
    page.style.setProperty('--scroll-fade', `${fade}px`)
    page.style.setProperty('--scroll-fade-amount', String(fade / SCROLL_FADE_PX))
    page.toggleAttribute('data-scrolled', fade > 0)
  }
  // Scroll events don't bubble, but they do pass through ancestors in the capture phase.
  column.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => column.removeEventListener('scroll', onScroll, { capture: true })
}
