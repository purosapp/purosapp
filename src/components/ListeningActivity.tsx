import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  LISTENING_STATS_CHANGED_EVENT,
  dayKey,
  loadListeningStats,
  type ListeningStats,
} from '../services/listeningStats'

const WEEKS = 53
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', '']
const CELL_GAP = 3
const DAY_LABEL_WIDTH = 32
const MIN_CELL = 10
const MAX_CELL = 18
/** Minutes a day needs to reach each colour step. */
const LEVEL_MINUTES = [1, 30, 90, 180]
const LEVEL_CLASSES = [
  'bg-white/[0.05]',
  'bg-blue-900',
  'bg-blue-700',
  'bg-blue-500',
  'bg-blue-400',
]

function formatDuration(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} min`
  if (hours >= 100 || minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
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

function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1.5 text-xl font-semibold text-zinc-100 tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] text-zinc-600 tabular-nums">{detail}</p>
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
    const interval = window.setInterval(load, 60_000)
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
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Listening Activity</h2>
        <p className="text-xs text-zinc-500 tabular-nums">
          {formatHours(summary.year.seconds)} listened in the last year
        </p>
      </div>

      <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-5 space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label="Today" value={formatDuration(summary.today.seconds)} detail={playsLabel(summary.today.plays)} />
          <StatTile label="This week" value={formatDuration(summary.week.seconds)} detail={playsLabel(summary.week.plays)} />
          <StatTile label="This month" value={formatDuration(summary.month.seconds)} detail={playsLabel(summary.month.plays)} />
          <StatTile
            label="All time"
            value={formatDuration(summary.allTime.seconds)}
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
                      title={future ? undefined : `${entry ? formatDuration(entry.seconds) : 'No listening'} on ${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}${entry?.plays ? ` · ${playsLabel(entry.plays)}` : ''}`}
                      className={`rounded-[3px] ${future ? 'invisible' : LEVEL_CLASSES[levelFor(entry?.seconds ?? 0)]}`}
                      style={{ width: cellSize, height: cellSize }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-zinc-600">
          <p>Counts time actually played. Skipped and seeked-over parts don’t count; a play counts after 30 seconds.</p>
          <div className="flex items-center gap-1.5">
            <span>Less</span>
            {LEVEL_CLASSES.map((className) => (
              <span key={className} className={`w-[11px] h-[11px] rounded-[3px] ${className}`} />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
    </section>
  )
}
