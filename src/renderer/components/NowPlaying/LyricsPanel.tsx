import { useEffect, useRef } from 'react'
import type { LyricsFontSize } from '../../../store/settingsStore'
import type { ResolvedLyrics } from './LyricsProviderService'

interface LyricsPanelProps {
  lyrics: ResolvedLyrics | null
  loading: boolean
  position: number
  fontSize: LyricsFontSize
  onSeekToTime?: (time: number) => void
}

const FONT_SIZE_CLASS: Record<LyricsFontSize, string> = {
  small: 'text-xl md:text-2xl',
  medium: 'text-2xl md:text-[1.75rem]',
  large: 'text-[1.75rem] md:text-[2.25rem]',
}

/** Fades the lines in and out at the panel's edges, like Apple Music's lyrics. */
export const EDGE_FADE_MASK = 'linear-gradient(to bottom, transparent 0, black 12%, black 82%, transparent 100%)'

function lineOpacity(distance: number): number {
  if (distance <= 0) return 1
  if (distance === 1) return 0.42
  return 0.3
}

/**
 * Blur grows with distance from the current line, like Apple Music. The
 * current line stays centred, so the lines leaving at the top and bottom are
 * the softest. Per line rather than a backdrop band, which shows its edges
 * against the ambient background.
 */
function lineBlur(distance: number): number {
  return Math.min(2.5, Math.max(0, (distance - 2) * 0.6))
}

function activeLyricIndex(lyrics: ResolvedLyrics | null, position: number): number {
  if (!lyrics?.synced || lyrics.lines.length === 0) return -1

  if (position < lyrics.lines[0].time) return -1

  for (let index = lyrics.lines.length - 1; index >= 0; index -= 1) {
    if (position >= lyrics.lines[index].time) return index
  }

  return -1
}

export default function LyricsPanel({
  lyrics,
  loading,
  position,
  fontSize,
  onSeekToTime,
}: LyricsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])
  const currentIndex = activeLyricIndex(lyrics, position)

  useEffect(() => {
    if (!lyrics?.synced || currentIndex < 0) return
    lineRefs.current[currentIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })
  }, [currentIndex, lyrics])

  useEffect(() => {
    if (!lyrics || lyrics.synced) return
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [lyrics])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto pr-2"
      style={{ maskImage: EDGE_FADE_MASK, scrollbarWidth: 'none' }}
    >
      {loading ? (
        <div className="flex h-full items-center text-lg font-semibold text-white/40">
          Finding lyrics…
        </div>
      ) : null}

      {!loading && (!lyrics || lyrics.kind === 'none' || (!lyrics.synced && !lyrics.plainText)) ? (
        <div className="flex h-full items-center text-lg font-semibold text-white/40">
          No lyrics available
        </div>
      ) : null}

      {!loading && lyrics?.synced ? (
        // Padding lets the first and last lines scroll to the centre.
        <div className={`space-y-5 py-[40cqh] ${FONT_SIZE_CLASS[fontSize]} font-bold leading-[1.25] tracking-tight`}>
          {lyrics.lines.map((line, index) => {
            const distance = currentIndex < 0 ? 2 : Math.abs(currentIndex - index)
            return (
              <p
                key={`${line.time}-${index}-${line.text}`}
                ref={(element) => {
                  lineRefs.current[index] = element
                }}
                className={`origin-left text-white transition-[opacity,transform,filter] duration-500 ease-out ${
                  onSeekToTime ? 'cursor-pointer hover:opacity-80! hover:blur-none!' : ''
                }`}
                onClick={() => {
                  if (!onSeekToTime) return
                  onSeekToTime(line.time)
                }}
                title={onSeekToTime ? `Jump to ${Math.floor(line.time / 60)}:${Math.floor(line.time % 60).toString().padStart(2, '0')}` : undefined}
                style={{
                  opacity: line.text ? lineOpacity(distance) : 0.18,
                  transform: distance === 0 ? 'scale(1.02)' : 'scale(1)',
                  filter: lineBlur(distance) > 0 ? `blur(${lineBlur(distance)}px)` : undefined,
                }}
              >
                {line.text || '\u00A0'}
              </p>
            )
          })}
        </div>
      ) : null}

      {!loading && lyrics && !lyrics.synced && lyrics.plainText ? (
        <div className={`space-y-3 py-[12cqh] ${FONT_SIZE_CLASS[fontSize]} font-semibold leading-[1.35] tracking-tight text-white/85`}>
          {lyrics.staticLines.map((line, index) => (
            <p
              key={`${index}-${line}`}
              className="transition-opacity duration-300"
              style={{ opacity: line ? 1 : 0.3 }}
            >
              {line || '\u00A0'}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
