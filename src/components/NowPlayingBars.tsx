/**
 * Equalizer-style bars for the row that is playing: they bounce while music
 * plays and settle smoothly to a flat resting height when it pauses. Filled
 * with the accent (bottom to top, so a gradient accent shows in each bar).
 */

import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { usePlayerStore } from '../store/playerStore'

/** Different speeds and start offsets so the bars never move in step. */
const BARS = [
  { duration: '0.9s', delay: '0s' },
  { duration: '0.7s', delay: '0.12s' },
  { duration: '1.05s', delay: '0.24s' },
  { duration: '0.8s', delay: '0.36s' },
]

/** Matches the 0% / 100% keyframe in index.css, so resuming starts where pausing ended. */
const REST = 'scaleY(0.2)'
const SETTLE = 'transform 450ms cubic-bezier(0.2, 0.7, 0.2, 1)'

export default function NowPlayingBars({ className = '' }: { className?: string }) {
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])
  const firstRunRef = useRef(true)

  useLayoutEffect(() => {
    const bars = barsRef.current.filter((bar): bar is HTMLSpanElement => bar !== null)
    const firstRun = firstRunRef.current
    firstRunRef.current = false

    if (isPlaying) {
      // Restart the cycle from the resting height (each bar after its delay).
      for (const bar of bars) {
        bar.style.transition = ''
        bar.style.transform = ''
        bar.style.animation = 'none'
        void bar.offsetHeight
        bar.style.animation = ''
      }
      return
    }

    for (const bar of bars) {
      // CSS cannot transition out of a running animation: hold the bar at its
      // current height, then ease it down to rest.
      const current = getComputedStyle(bar).transform
      bar.style.animation = 'none'
      bar.style.transition = ''
      bar.style.transform = firstRun || current === 'none' ? REST : current
      if (firstRun) continue
      void bar.offsetHeight
      bar.style.transition = SETTLE
      bar.style.transform = REST
    }
  }, [isPlaying])

  return (
    <span
      role="img"
      aria-label={isPlaying ? 'Playing' : 'Paused'}
      className={`inline-flex h-3.5 items-end gap-[2px] ${className}`}
    >
      {BARS.map((bar, index) => (
        <span
          key={index}
          ref={(element) => { barsRef.current[index] = element }}
          className="now-playing-bar h-full w-[3px] rounded-full"
          style={{
            '--bar-duration': bar.duration,
            '--bar-delay': bar.delay,
            background: 'linear-gradient(to top, var(--accent-from), var(--accent-to))',
          } as CSSProperties}
        />
      ))}
    </span>
  )
}
