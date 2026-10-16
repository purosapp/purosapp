// Small form controls shared by the Audio settings screens.

import type { ReactNode } from 'react'

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
        disabled ? 'opacity-40 cursor-not-allowed' : ''
      } ${checked ? 'bg-blue-600' : 'bg-zinc-700'}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-150 ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

export function SettingRow({
  title,
  description,
  children,
  stacked = false,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  stacked?: boolean
}) {
  return (
    <div className={`py-3 border-b border-white/5 last:border-b-0 ${stacked ? 'space-y-2' : 'flex items-start justify-between gap-4'}`}>
      <div className="min-w-0">
        <p className="text-sm text-zinc-200">{title}</p>
        {description && <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{description}</p>}
      </div>
      <div className={stacked ? '' : 'shrink-0'}>{children}</div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: ReadonlyArray<{ id: T; label: string; disabled?: boolean; title?: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex flex-wrap rounded-md border border-white/10 bg-white/[0.03] p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={`px-2.5 py-1 text-xs rounded transition-colors ${
            value === option.id
              ? 'bg-white/15 text-zinc-100'
              : option.disabled
                ? 'text-zinc-600 cursor-not-allowed'
                : 'text-zinc-400 hover:text-zinc-100'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Select({
  value,
  onChange,
  options,
  label,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  label: string
  disabled?: boolean
}) {
  return (
    <select
      aria-label={label}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="bg-zinc-800 border border-white/10 rounded-md px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  format,
  disabled = false,
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  label: string
  format: (value: number) => string
  disabled?: boolean
}) {
  return (
    <div className={`flex items-center gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="flex-1 accent-blue-500"
      />
      <output className="w-16 text-right text-xs tabular-nums text-zinc-300">{format(value)}</output>
    </div>
  )
}
