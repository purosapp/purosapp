/**
 * Album artwork thumbnail with:
 * - 150ms opacity crossfade when track changes
 * - Preloads new image before swapping (never flashes broken image)
 * - Dark placeholder with music note when no artwork
 *
 * Every transition is tied to the effect run that started it, so rapid
 * src changes (e.g. X → null → X while a track's metadata hydrates) cancel
 * cleanly instead of leaving the image stuck mid-fade.
 */

import { Music } from 'lucide-react'
import { useState, useEffect } from 'react'

interface Props {
  src: string | null | undefined
  size?: number
}

const FADE_MS = 150

export default function ArtworkThumbnail({ src, size = 56 }: Props) {
  // The currently displayed image
  const [displaySrc, setDisplaySrc] = useState<string | null>(src ?? null)
  // Controls fade-out of current image during swap
  const [fading, setFading] = useState(false)

  useEffect(() => {
    const next = src ?? null
    if (next === displaySrc) {
      setFading(false)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const swapTo = (value: string | null) => {
      if (cancelled) return
      if (!displaySrc) {
        setDisplaySrc(value)
        return
      }
      // Fade the current image out, swap, and fade back in.
      setFading(true)
      timer = setTimeout(() => {
        if (cancelled) return
        setDisplaySrc(value)
        setFading(false)
      }, FADE_MS)
    }

    if (!next) {
      swapTo(null)
    } else {
      // Preload so the swap never shows a half-loaded or broken image.
      const img = new Image()
      img.src = next
      img.decode().then(() => swapTo(next), () => swapTo(null))
    }

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [src, displaySrc])

  return (
    <div
      className="relative shrink-0 rounded-[6px] overflow-hidden bg-zinc-800"
      style={{ width: size, height: size }}
    >
      {/* Placeholder — always underneath, visible when no artwork */}
      <div className="absolute inset-0 flex items-center justify-center">
        <Music className="text-zinc-600" style={{ width: size * 0.4, height: size * 0.4 }} />
      </div>

      {/* Current artwork */}
      {displaySrc && (
        <img
          src={displaySrc}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            opacity: fading ? 0 : 1,
            transition: `opacity ${FADE_MS}ms ease-in-out`,
          }}
        />
      )}
    </div>
  )
}
