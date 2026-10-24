import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  LISTENING_STATS_CHANGED_EVENT,
  dayKey,
  loadListeningStats,
  type ListeningStats,
} from '../services/listeningStats'
import { formatTotalDuration } from '../utils/formatTime'
import { Section } from './ui'
import { isWindowHidden } from '../services/windowActivity'

const WEEKS = 53
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', '']
const CELL_GAP = 3
const DAY_LABEL_WIDTH = 32
const MIN_CELL = 10
/** Large enough that the year fills the panel on wide windows. */
const MAX_CELL = 28
/** Minutes a day needs to reach each colour step. */
const LEVEL_MINUTES = [1, 30, 90, 180]
/** Opacity of the accent at each level; level 0 is an empty cell. */
const LEVEL_ALPHAS = [0, 25, 45, 70, 100]

/**
 * A cell's colour: the accent, stronger with more listening. With a gradient
 * accent the colour runs across the year (oldest week = start, today = end).
 */
function levelBackground(level: number, position: number): string | undefined {
  if (level === 0) return undefined
  const along = `color-mix(in oklab, var(--accent-to) ${Math.round(position * 100)}%, var(--accent-from))`
  return `color-mix(in oklab, ${along} ${LEVEL_ALPHAS[level]}%, transparent)`
}

function formatHours(seconds: number): string {
  const hours = seconds / 3600
  if (hours < 1) return `${Math.floor(seconds / 60)} minutes`
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`
}

function levelFor(seconds: number): number {
  const minutes = seconds / 60
  let level = 0
  LEVEL_MINUTES.forEach((threshold, index) => { if (minutes >= threshold) level = index + 1 })
  return level
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** Monday of the week containing `date`. */
function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -((date.getDay() + 6) % 7))
}

function sumRange(stats: ListeningStats, from: Date, to: Date) {
  let seconds = 0
  let plays = 0
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const entry = stats[dayKey(day)]
    if (!entry) continue
    seconds += entry.seconds
    plays += entry.plays
  }
  return { seconds, plays }
}

function hasListening(stats: ListeningStats, date: Date) {
  return (stats[dayKey(date)]?.seconds ?? 0) >= 60
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 px-5 py-1 first:pl-0">
      <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{label}</p>
      <p className="mt-2 truncate text-2xl font-bold tracking-tight text-white tabular-nums">{value}</p>
      <p className="mt-1 truncate text-xs text-zinc-500 tabular-nums">{detail}</p>
    </div>
  )
}

function playsLabel(plays: number) {
  return `${plays} ${plays === 1 ? 'play' : 'plays'}`
}

export default function ListeningActivity() {
  const [stats, setStats] = useState<ListeningStats>({})
  const [today, setToday] = useState(() => startOfDay(new Date()))

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void loadListeningStats().then((next) => { if (!cancelled) setStats(next) })
      const now = startOfDay(new Date())
      setToday((current) => (current.getTime() === now.getTime() ? current : now))
    }
    load()
    window.addEventListener(LISTENING_STATS_CHANGED_EVENT, load)
    const interval = window.setInterval(() => { if (!isWindowHidden()) load() }, 60_000)
    return () => {
      cancelled = true
      window.removeEventListener(LISTENING_STATS_CHANGED_EVENT, load)
      window.clearInterval(interval)
    }
  }, [])

  const summary = useMemo(() => {
    const yearStart = addDays(startOfWeek(today), -7 * (WEEKS - 1))
    const allTime = Object.values(stats).reduce(
      (total, day) => ({ seconds: total.seconds + day.seconds, plays: total.plays + day.plays }),
      { seconds: 0, plays: 0 },
    )

    let streak = 0
    let cursor = hasListening(stats, today) ? today : addDays(today, -1)
    while (hasListening(stats, cursor)) {
      streak += 1
      cursor = addDays(cursor, -1)
    }

    return {
      today: sumRange(stats, today, today),
      week: sumRange(stats, startOfWeek(today), today),
      month: sumRange(stats, new Date(today.getFullYear(), today.getMonth(), 1), today),
      year: sumRange(stats, yearStart, today),
      allTime,
      streak,
    }
  }, [stats, today])

  const weeks = useMemo(() => {
    const firstDay = addDays(startOfWeek(today), -7 * (WEEKS - 1))
    return Array.from({ length: WEEKS }, (_, week) => Array.from({ length: 7 }, (_, weekday) => {
      const date = addDays(firstDay, week * 7 + weekday)
      return { date, entry: stats[dayKey(date)] ?? null, future: date > today }
    }))
  }, [stats, today])

  const monthLabels = useMemo(() => {
    const labels: Array<string | null> = weeks.map((days, week) => {
      const monthStart = days.find(({ date }) => date.getDate() === 1)
      // The last two columns have no room for a label without overflowing.
      return monthStart && week < WEEKS - 2 ? MONTH_LABELS[monthStart.date.getMonth()] : null
    })
    // Label the partial first month only when it has room before the next one.
    const nextLabelledWeek = labels.findIndex((label, week) => week > 0 && label)
    if (!labels[0] && (nextLabelledWeek === -1 || nextLabelledWeek >= 3)) {
      labels[0] = MONTH_LABELS[weeks[0][0].date.getMonth()]
    }
    return labels
  }, [weeks])

  // Cells grow to fill the card (within limits); narrower windows scroll,
  // starting at the most recent weeks.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [cellSize, setCellSize] = useState(MIN_CELL)
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => {
      const available = scroller.clientWidth - DAY_LABEL_WIDTH - CELL_GAP * WEEKS
      setCellSize(Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(available / WEEKS))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollLeft = scroller.scrollWidth
  }, [weeks, cellSize])

  return (
    <Section
      title="Listening Activity"
      action={(
        <p className="text-xs text-zinc-500 tabular-nums">
          {formatHours(summary.year.seconds)} listened in the last year
        </p>
      )}
    >

      <div className="rounded-2xl border border-white/5 p-5 space-y-6">
        <div className="grid grid-cols-2 gap-y-4 lg:grid-cols-4 lg:divide-x lg:divide-white/5">
          <Stat label="Today" value={formatTotalDuration(summary.today.seconds)} detail={playsLabel(summary.today.plays)} />
          <Stat label="This week" value={formatTotalDuration(summary.week.seconds)} detail={playsLabel(summary.week.plays)} />
          <Stat label="This month" value={formatTotalDuration(summary.month.seconds)} detail={playsLabel(summary.month.plays)} />
          <Stat
            label="All time"
            value={formatTotalDuration(summary.allTime.seconds)}
            detail={`${playsLabel(summary.allTime.plays)} · ${summary.streak}-day streak`}
          />
        </div>

        <div ref={scrollerRef} className="overflow-x-auto">
          <div className="inline-flex flex-col text-zinc-500" style={{ gap: CELL_GAP * 2 }}>
            <div className="flex" style={{ gap: CELL_GAP, paddingLeft: DAY_LABEL_WIDTH + CELL_GAP }}>
              {monthLabels.map((label, week) => (
                <span key={week} className="shrink-0 text-[11px] leading-4 whitespace-nowrap overflow-visible" style={{ width: cellSize }}>
                  {label}
                </span>
              ))}
            </div>
            <div className="flex" style={{ gap: CELL_GAP }}>
              <div className="shrink-0 flex flex-col" style={{ width: DAY_LABEL_WIDTH, gap: CELL_GAP }}>
                {DAY_LABELS.map((label, weekday) => (
                  <span key={weekday} className="flex items-center text-[10px]" style={{ height: cellSize }}>{label}</span>
                ))}
              </div>
              {weeks.map((days, week) => (
                <div key={week} className="shrink-0 flex flex-col" style={{ gap: CELL_GAP }}>
                  {days.map(({ date, entry, future }) => (
                    <div
                      key={dayKey(date)}
                      title={future ? undefined : `${entry ? formatTotalDuration(entry.seconds) : 'No listening'} on ${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}${entry?.plays ? ` · ${playsLabel(entry.plays)}` : ''}`}
                      className={`rounded-[4px] bg-white/[0.05] transition-colors hover:ring-1 hover:ring-white/60 ${future ? 'invisible' : ''}`}
                      style={{
                        width: cellSize,
                        height: cellSize,
                        background: future ? undefined : levelBackground(levelFor(entry?.seconds ?? 0), week / (WEEKS - 1)),
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-zinc-500">
          <p>Counts time actually played. Skipped and seeked-over parts don’t count; a play counts after 30 seconds.</p>
          <div className="flex items-center gap-1.5">
            <span>Less</span>
            {LEVEL_ALPHAS.map((_, level) => (
              <span key={level} className="w-[11px] h-[11px] rounded-[4px] bg-white/[0.05]" style={{ background: levelBackground(level, 0.5) }} />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
    </Section>
  )
}
