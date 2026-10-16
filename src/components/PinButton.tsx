/**
 * Small pin toggle used on cards (albums/artists). Solid when pinned, outline
 * otherwise; appears on hover and stays visible while pinned.
 */

import { Pin } from 'lucide-react'

export default function PinButton({
  pinned,
  onToggle,
  className = '',
}: {
  pinned: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      title={pinned ? 'Unpin' : 'Pin'}
      aria-pressed={pinned}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className={`flex items-center justify-center w-7 h-7 rounded-full border backdrop-blur transition-colors ${
        pinned
          ? 'border-white/20 bg-white text-zinc-900'
          : 'border-white/15 bg-black/50 text-zinc-200 hover:bg-black/70 opacity-0 group-hover:opacity-100'
      } ${className}`.trim()}
    >
      <Pin className="w-3.5 h-3.5" fill={pinned ? 'currentColor' : 'none'} />
    </button>
  )
}
