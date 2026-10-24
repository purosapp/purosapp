export interface MediaTabOption<T extends string> {
  id: T
  label: string
}

/** Pill segmented control for switching what a page shows (search result types, pin categories). */
export default function MediaTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<MediaTabOption<T>>
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center gap-2 px-6 pb-2 shrink-0">
      <div role="tablist" className="inline-flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] p-1">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={option.id === value}
            onClick={() => onChange(option.id)}
            className={`h-7 rounded-full px-3.5 text-[13px] font-medium transition-colors ${
              option.id === value
                ? 'bg-white text-zinc-950'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
