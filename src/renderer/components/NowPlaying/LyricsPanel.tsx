import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { LYRICS_PROVIDER_LABELS, type LyricsFontSize } from '../../../store/settingsStore'
import type { ResolvedLyrics } from './LyricsProviderService'

interface LyricsPanelProps {
  lyrics: ResolvedLyrics | null
  loading: boolean
  position: number
  fontSize: LyricsFontSize
  onSeekToTime?: (time: number) => void
  headerContent?: ReactNode
}

const FONT_SIZE_CLASS: Record<LyricsFontSize, string> = {
  small: 'text-lg md:text-xl',
  medium: 'text-xl md:text-2xl',
  large: 'text-2xl md:text-[2rem]',
}

function lineOpacity(distance: number): number {
  if (distance <= 0) return 1
  if (distance === 1) return 0.5
  if (distance === 2) return 0.42
  return 0.35
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
  headerContent,
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
    <div className="relative flex h-full min-h-[24rem] flex-col overflow-hidden rounded-[32px] border border-white/8 bg-black/18 shadow-[0_24px_70px_rgba(0,0,0,0.22)] backdrop-blur-2xl">
      <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
        {headerContent ?? (
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Lyrics</p>
            <p className="mt-1 text-xs text-zinc-400">
              {lyrics?.providerId ? `Source: ${LYRICS_PROVIDER_LABELS[lyrics.providerId]}` : 'No lyrics source'}
            </p>
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-6 py-6 md:px-8 md:py-8"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Finding lyrics…
          </div>
        ) : null}

        {!loading && (!lyrics || lyrics.kind === 'none' || (!lyrics.synced && !lyrics.plainText)) ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-zinc-500">
            No lyrics available
          </div>
        ) : null}

        {!loading && lyrics?.synced ? (
          <div className={`space-y-4 ${FONT_SIZE_CLASS[fontSize]} font-medium leading-[1.35]`}>
            {lyrics.lines.map((line, index) => {
              const distance = currentIndex < 0 ? 3 : Math.abs(currentIndex - index)
              return (
                <p
                  key={`${line.time}-${index}-${line.text}`}
                  ref={(element) => {
                    lineRefs.current[index] = element
                  }}
                  className={`transition-[opacity,transform,color] duration-500 ${
                    onSeekToTime ? 'cursor-pointer hover:text-white' : ''
                  }`}
                  onClick={() => {
                    if (!onSeekToTime) return
                    onSeekToTime(line.time)
                  }}
                  title={onSeekToTime ? `Jump to ${Math.floor(line.time / 60)}:${Math.floor(line.time % 60).toString().padStart(2, '0')}` : undefined}
                  style={{
                    opacity: line.text ? lineOpacity(distance) : 0.18,
                    color: distance === 0 ? 'rgb(255 255 255)' : 'rgb(228 228 231)',
                    transform: distance === 0 ? 'scale(1.01)' : 'scale(1)',
                  }}
                >
                  {line.text || '\u00A0'}
                </p>
              )
            })}
          </div>
        ) : null}

        {!loading && lyrics && !lyrics.synced && lyrics.plainText ? (
          <div className={`space-y-3 ${FONT_SIZE_CLASS[fontSize]} leading-[1.5] text-zinc-200/82`}>
            {lyrics.staticLines.map((line, index) => (
              <p
                key={`${index}-${line}`}
                className="transition-opacity duration-300"
                style={{ opacity: line ? 0.88 : 0.3 }}
              >
                {line || '\u00A0'}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
