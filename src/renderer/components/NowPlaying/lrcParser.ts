export interface LrcLine {
  time: number
  text: string
}

const TIMESTAMP_PATTERN = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g

export function parseLRC(rawText: string): LrcLine[] {
  const lines: LrcLine[] = []

  for (const rawLine of rawText.split(/\r?\n/)) {
    const text = rawLine.replace(TIMESTAMP_PATTERN, '').trim()
    const matches = [...rawLine.matchAll(TIMESTAMP_PATTERN)]
    if (matches.length === 0) continue

    for (const match of matches) {
      const minutes = Number(match[1] ?? 0)
      const seconds = Number(match[2] ?? 0)
      const fractionRaw = match[3] ?? '0'
      const fraction = fractionRaw.length === 3
        ? Number(fractionRaw) / 1000
        : Number(fractionRaw) / 100

      lines.push({
        time: minutes * 60 + seconds + fraction,
        text,
      })
    }
  }

  return lines.sort((a, b) => a.time - b.time)
}
