import type { FormatInfo, OutputMode } from '../services/local/formats'

export const badgeBase = 'px-2 py-0.5 rounded text-xs font-mono'

export const badgeToneClasses = {
  pristine: 'bg-green-950 text-green-400',
  processed: 'bg-purple-950 text-purple-300',
  warning: 'bg-orange-950 text-orange-400',
  resampled: 'bg-yellow-950 text-yellow-400',
  neutral: 'bg-zinc-700 text-zinc-200',
  muted: 'bg-zinc-800 text-zinc-400',
  hiRes: 'bg-blue-950 text-blue-300',
  dsd: 'bg-green-950 text-green-400',
} as const

export function formatBadgeClasses(info: FormatInfo): string {
  if (info.isDsd) return badgeToneClasses.dsd
  if (info.isMqa) return badgeToneClasses.processed
  if (info.isHiRes) return badgeToneClasses.hiRes
  if (info.isLossless) return badgeToneClasses.neutral
  return badgeToneClasses.muted
}

export function outputModeBadgeClasses(mode: OutputMode, isBluetooth: boolean): string {
  switch (mode) {
    case 'EXCLUSIVE':
      return badgeToneClasses.pristine
    case 'SHARED':
      return isBluetooth
        ? 'bg-amber-950 text-amber-400'
        : badgeToneClasses.warning
    case 'AIRPLAY':
      return 'bg-red-950 text-red-400'
  }
}
