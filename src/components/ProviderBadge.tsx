import { Folder } from 'lucide-react'
import type { CatalogProviderName } from '../services/catalog/types'
import { useProviderStatusStore } from '../store/providerStatusStore'

function FolderLogo({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return <Folder className={`${className} text-white shrink-0`.trim()} />
}

export function useProviderPresentation(provider: string) {
  const descriptor = useProviderStatusStore((state) => (
    state.providers.find(({ manifest }) => manifest.id === provider)
  ))
  return {
    label: provider === 'local' ? 'Local' : provider === 'mixed' ? 'Mixed archive' : (descriptor?.manifest.displayName ?? provider),
    iconUrl: descriptor?.iconUrl ?? null,
    brandColor: descriptor?.manifest.brandColor ?? null,
  }
}

export function ProviderIcon({ provider, compact = false, className }: { provider: string; compact?: boolean; className?: string }) {
  const presentation = useProviderPresentation(provider)
  const size = className ?? (compact ? 'w-3 h-3' : 'w-3.5 h-3.5')
  if (provider === 'local') return <FolderLogo className={size} />
  if (presentation.iconUrl) return <img src={presentation.iconUrl} alt="" className={`${size} shrink-0 object-contain`} />
  return <span className={`${size} shrink-0 rounded-sm`} style={{ backgroundColor: presentation.brandColor ?? '#71717a' }} />
}

export default function ProviderBadge({ provider, compact = false, iconOnly = false, className = '' }: {
  provider: CatalogProviderName | string
  compact?: boolean
  iconOnly?: boolean
  className?: string
}) {
  const presentation = useProviderPresentation(provider)
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.05] text-zinc-300 ${compact ? 'text-[10px] uppercase tracking-wider' : 'text-xs'} ${className}`.trim()}>
      <ProviderIcon provider={provider} compact={compact} />
      {!iconOnly && <span>{presentation.label}</span>}
    </span>
  )
}

export function ProviderInlineLabel({ provider, className = '' }: { provider: CatalogProviderName | string; className?: string }) {
  const presentation = useProviderPresentation(provider)
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`.trim()}>
      <ProviderIcon provider={provider} compact={false} />
      <span>{presentation.label}</span>
    </span>
  )
}
