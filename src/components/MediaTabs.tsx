export interface MediaTabOption<T extends string> {
  id: T
  label: string
}

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
    <div className="flex items-center gap-2 px-6 pt-3 shrink-0">
      <div className="inline-flex items-center rounded-2xl border border-white/8 bg-white/[0.03] p-1">
        {options.map((option) => (
          <button
            key={option.id}
            onClick={() => onChange(option.id)}
            className={`px-3 py-1.5 rounded-xl text-sm transition-colors ${
              option.id === value
                ? 'bg-white text-zinc-950 font-medium'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
