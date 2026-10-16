import { Folder, Plus, RotateCw, X } from 'lucide-react'
import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react'
import {
  useSettingsStore,
  PLAYER_TAG_LABELS,
  LYRICS_PROVIDER_LABELS,
  type PlayerTagSettings,
  type LyricsFontSize,
  type LyricsProviderId,
  type ResumeRewindSeconds,
} from '../store/settingsStore'
import { useLibraryStore } from '../store/libraryStore'
import { clearRecentlyPlayedHistory } from '../services/homeRecents'
import LastFmSettings from './settings/LastFmSettings'
import AudioSetupSettings from './settings/AudioSetupSettings'
import type { SettingsTab } from '../utils/openSettings'
import ProviderPackagesSettings from './settings/ProviderPackagesSettings'
import { Segmented } from './settings/controls'
import { useVisualizerStore } from '../store/visualizerStore'
import { importMilkPreset } from '../renderer/visualizer/importPreset'
import { useProviderStatusStore } from '../store/providerStatusStore'
import type {
  ProviderDescriptorV1,
  ProviderFormSettingV1,
  ProviderPrimitiveV1,
  ProviderSettingControlV1,
} from '../provider-api/v1'

interface SettingsProps {
  onClose: () => void
  initialTab?: Tab
}

type Tab = SettingsTab
type ProviderStatusTone = 'ok' | 'error' | 'idle'

interface ProviderStatus {
  tone: ProviderStatusTone
  message: string
}

const LYRICS_FONT_LABELS: Record<LyricsFontSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
}

const DEFAULT_PROVIDER_STATUS: Record<LyricsProviderId, ProviderStatus> = {
  lrclib: { tone: 'idle', message: 'No setup needed' },
  musixmatch: { tone: 'idle', message: 'Not configured' },
  genius: { tone: 'idle', message: 'Not configured' },
}

function statusToneClasses(tone: ProviderStatusTone): string {
  if (tone === 'ok') return 'bg-emerald-400'
  if (tone === 'error') return 'bg-red-400'
  return 'bg-zinc-500'
}

// ---------------------------------------------------------------------------
// Toggle row
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-2 cursor-pointer group">
      <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors select-none">
        {label}
      </span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
          checked ? 'bg-blue-600' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-150 ${
            checked ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </button>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Accounts tab
// ---------------------------------------------------------------------------

function ProviderSettingControl({
  descriptor,
  control,
  value,
  secretPresent,
  onValueChanged,
  onSecretChanged,
  onActionComplete,
}: {
  descriptor: ProviderDescriptorV1
  control: ProviderSettingControlV1
  value: ProviderPrimitiveV1 | undefined
  secretPresent: boolean
  onValueChanged: (key: string, value: ProviderPrimitiveV1) => Promise<void>
  onSecretChanged: (key: string, value: string | null) => Promise<void>
  onActionComplete: () => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  if (control.type === 'status') {
    const statusValue = descriptor.status.values?.[control.statusKey]
    return (
      <div className="py-2">
        <p className="text-sm text-zinc-300">{control.label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{statusValue === undefined ? 'Unavailable' : String(statusValue)}</p>
      </div>
    )
  }

  if (control.type === 'action') {
    const run = async () => {
      setRunning(true)
      setActionError(null)
      try {
        const result = await window.puros.provider.invoke(
          descriptor.manifest.id,
          control.action.capability,
          control.action.method,
          control.action.args ?? [],
        )
        if (!result.ok) throw new Error(result.error.message)
        await onActionComplete()
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Provider action failed')
      } finally {
        setRunning(false)
      }
    }
    return (
      <div className="py-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-300">{control.label}</p>
            {control.description && <p className="text-xs text-zinc-600 mt-0.5">{control.description}</p>}
          </div>
          <button
            type="button"
            disabled={running}
            onClick={() => { void run() }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 ${
              control.destructive ? 'bg-red-500/15 text-red-200' : 'bg-white/5 border border-white/10 text-zinc-300'
            }`}
          >
            {running ? 'Working…' : control.label}
          </button>
        </div>
        {actionError && <p role="alert" className="mt-2 text-xs text-red-300">{actionError}</p>}
      </div>
    )
  }

  if (control.type === 'toggle') {
    return (
      <div>
        <ToggleRow
          label={control.label}
          checked={typeof value === 'boolean' ? value : (control.defaultValue ?? false)}
          onChange={(next) => { void onValueChanged(control.key, next) }}
        />
        {control.description && <p className="text-xs text-zinc-600 -mt-1 mb-2">{control.description}</p>}
      </div>
    )
  }

  if (control.type === 'select') {
    return (
      <label className="block py-2">
        <span className="text-sm text-zinc-300">{control.label}</span>
        <select
          value={typeof value === 'string' ? value : (control.defaultValue ?? '')}
          onChange={(event) => { void onValueChanged(control.key, event.target.value) }}
          className="mt-2 w-full px-3 py-2 bg-zinc-900/80 border border-white/10 rounded-lg text-sm text-zinc-100"
        >
          {control.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {control.description && <span className="block text-xs text-zinc-600 mt-1">{control.description}</span>}
      </label>
    )
  }

  if (control.type === 'form') {
    return <ProviderFormControl descriptor={descriptor} control={control} onSubmitted={onActionComplete} />
  }

  const isSecret = control.storage === 'secret'
  const displayedValue = isSecret ? draft : (typeof value === 'string' ? value : '')
  return (
    <label className="block py-2">
      <span className="text-sm text-zinc-300">{control.label}</span>
      <div className="mt-2 flex gap-2">
        <input
          type={isSecret ? 'password' : 'text'}
          value={displayedValue}
          placeholder={isSecret && secretPresent ? 'Saved securely' : control.placeholder}
          onChange={(event) => {
            if (isSecret) setDraft(event.target.value)
            else void onValueChanged(control.key, event.target.value)
          }}
          className="min-w-0 flex-1 px-3 py-2 bg-zinc-900/80 border border-white/10 rounded-lg text-sm text-zinc-100"
        />
        {isSecret && (
          <>
            <button
              type="button"
              disabled={!draft}
              onClick={() => {
                void onSecretChanged(control.key, draft).then(() => setDraft(''))
              }}
              className="px-3 py-2 rounded-lg text-xs bg-blue-600 text-white disabled:opacity-40"
            >Save</button>
            {secretPresent && (
              <button
                type="button"
                onClick={() => { void onSecretChanged(control.key, null) }}
                className="px-3 py-2 rounded-lg text-xs bg-white/5 text-zinc-300"
              >Clear</button>
            )}
          </>
        )}
      </div>
      {control.description && <span className="block text-xs text-zinc-600 mt-1">{control.description}</span>}
    </label>
  )
}

/**
 * Manifest `form` control. Field values live only in this component's state:
 * they are sent once to the declared capability method and cleared after every
 * submission, success or failure. Sensitive fields are masked and never
 * persisted by core; the provider stores what it accepts in `host.secrets`.
 */
function ProviderFormControl({
  descriptor,
  control,
  onSubmitted,
}: {
  descriptor: ProviderDescriptorV1
  control: ProviderFormSettingV1
  onSubmitted: () => Promise<void>
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const missing = control.fields.some((field) => field.required && !(values[field.id] ?? '').trim())

  const submit = async () => {
    setRunning(true)
    setResult(null)
    const submitted = Object.fromEntries(control.fields.map((field) => [field.id, values[field.id] ?? '']))
    // Drop the draft before the call so nothing sensitive outlives the submission.
    setValues({})
    try {
      const response = await window.puros.provider.invoke(
        descriptor.manifest.id,
        control.submit.capability,
        control.submit.method,
        [{ form: control.id, values: submitted }],
      )
      if (!response.ok) throw new Error(response.error.message)
      setResult({ ok: true, message: 'Done' })
      setOpen(false)
      await onSubmitted()
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : 'Provider action failed' })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-300">{control.label}</p>
          {control.description && <p className="text-xs text-zinc-600 mt-0.5">{control.description}</p>}
        </div>
        <button
          type="button"
          onClick={() => { setOpen((current) => !current); setValues({}); setResult(null) }}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-zinc-300"
        >{open ? 'Cancel' : control.label}</button>
      </div>
      {open && (
        <form
          className="mt-3 space-y-3"
          autoComplete="off"
          onSubmit={(event) => { event.preventDefault(); if (!missing && !running) void submit() }}
        >
          {control.instructions && control.instructions.length > 0 && (
            <ol className="list-decimal space-y-1 pl-5 text-xs text-zinc-400">
              {control.instructions.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
          )}
          {control.fields.map((field) => {
            const common = {
              id: `${descriptor.manifest.id}-${control.id}-${field.id}`,
              value: values[field.id] ?? '',
              placeholder: field.placeholder,
              maxLength: Math.min(field.maxLength ?? 65_536, 65_536),
              required: field.required,
              spellCheck: false,
              autoCorrect: 'off',
              autoCapitalize: 'off',
              autoComplete: 'off',
              onChange: (event: { target: { value: string } }) => {
                const next = event.target.value
                setValues((current) => ({ ...current, [field.id]: next }))
              },
              className: 'mt-1 w-full px-3 py-2 bg-zinc-900/80 border border-white/10 rounded-lg text-xs font-mono text-zinc-100',
            }
            return (
              <label key={field.id} htmlFor={common.id} className="block">
                <span className="text-xs text-zinc-300">{field.label}{field.required ? '' : ' (optional)'}</span>
                {field.multiline ? (
                  <textarea
                    {...common}
                    rows={4}
                    // Masked like a password field; the text never leaves this form except on submit.
                    style={field.sensitive ? { WebkitTextSecurity: 'disc' } as unknown as CSSProperties : undefined}
                  />
                ) : (
                  <input {...common} type={field.sensitive ? 'password' : 'text'} />
                )}
                {field.description && <span className="block text-[11px] text-zinc-600 mt-1">{field.description}</span>}
              </label>
            )
          })}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={missing || running}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white disabled:opacity-40"
            >{running ? 'Working…' : control.submit.label}</button>
          </div>
        </form>
      )}
      {result && (
        <p role={result.ok ? 'status' : 'alert'} className={`mt-2 text-xs ${result.ok ? 'text-emerald-300' : 'text-red-300'}`}>
          {result.message}
        </p>
      )}
    </div>
  )
}

function ProviderSettingsCard({ descriptor }: { descriptor: ProviderDescriptorV1 }) {
  const refreshProvider = useProviderStatusStore((state) => state.refreshProvider)
  const [values, setValues] = useState<Record<string, ProviderPrimitiveV1 | undefined>>({})
  const [secrets, setSecrets] = useState<Record<string, boolean>>({})
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const [removing, setRemoving] = useState(false)

  const loadValues = useCallback(async () => {
    const nextValues: Record<string, ProviderPrimitiveV1 | undefined> = {}
    const nextSecrets: Record<string, boolean> = {}
    await Promise.all((descriptor.manifest.settings ?? []).map(async (control) => {
      if (!('key' in control)) return
      if (control.storage === 'secret') {
        nextSecrets[control.key] = await window.puros.provider.hasSecret(descriptor.manifest.id, control.key)
      } else {
        nextValues[control.key] = await window.puros.provider.getSetting(descriptor.manifest.id, control.key)
      }
    }))
    setValues(nextValues)
    setSecrets(nextSecrets)
  }, [descriptor.manifest.id, descriptor.manifest.settings])

  useEffect(() => { void loadValues() }, [loadValues])

  const stateLabel = descriptor.status.message
    ?? (descriptor.status.authenticated === true ? 'Connected' : descriptor.status.authenticated === false ? 'Not connected' : descriptor.status.state)

  return (
    <div className="rounded-lg bg-zinc-800/60 p-4" style={{ borderLeft: `3px solid ${descriptor.manifest.brandColor}` }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {descriptor.iconUrl ? <img src={descriptor.iconUrl} alt="" className="h-8 w-8 rounded-md" /> : (
            <span className="h-8 w-8 rounded-md" style={{ backgroundColor: descriptor.manifest.brandColor }} />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">{descriptor.manifest.displayName}</p>
            <p className="mt-0.5 text-xs capitalize text-zinc-500">{stateLabel}</p>
          </div>
        </div>
        <span className="text-[10px] text-zinc-600">v{descriptor.manifest.version}</span>
      </div>
      {descriptor.manifest.description && <p className="mt-3 text-xs text-zinc-500">{descriptor.manifest.description}</p>}
      {(descriptor.manifest.settings?.length ?? 0) > 0 && (
        <div className="mt-3 divide-y divide-white/5">
          {descriptor.manifest.settings!.map((control) => (
            <ProviderSettingControl
              key={control.id}
              descriptor={descriptor}
              control={control}
              value={'key' in control ? values[control.key] : undefined}
              secretPresent={'key' in control ? !!secrets[control.key] : false}
              onValueChanged={async (key, next) => {
                await window.puros.provider.setSetting(descriptor.manifest.id, key, next)
                setValues((current) => ({ ...current, [key]: next }))
              }}
              onSecretChanged={async (key, next) => {
                if (next === null) await window.puros.provider.deleteSecret(descriptor.manifest.id, key)
                else await window.puros.provider.setSecret(descriptor.manifest.id, key, next)
                setSecrets((current) => ({ ...current, [key]: next !== null }))
              }}
              onActionComplete={async () => {
                await refreshProvider(descriptor.manifest.id)
                await loadValues()
              }}
            />
          ))}
        </div>
      )}
      <div className="mt-4 border-t border-white/5 pt-3">
        {removeConfirm ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-red-200">Remove imported library rows, settings, sessions, secrets, and cache?</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setRemoveConfirm(false)} className="px-2 py-1 text-xs text-zinc-400">Cancel</button>
              <button
                type="button"
                disabled={removing}
                onClick={() => {
                  setRemoving(true)
                  void window.puros.provider.removeData(descriptor.manifest.id).then(() => window.location.reload())
                }}
                className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-200 disabled:opacity-50"
              >{removing ? 'Removing…' : 'Remove all data'}</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setRemoveConfirm(true)} className="text-xs text-red-300/80 hover:text-red-200">
            Remove all provider data…
          </button>
        )}
      </div>
    </div>
  )
}

function AccountsTab() {
  const providers = useProviderStatusStore((state) => state.providers)
  const providersLoaded = useProviderStatusStore((state) => state.loaded)
  const streamingAudioCacheLimitGb = useSettingsStore((s) => s.streamingAudioCacheLimitGb)
  const setStreamingAudioCacheLimitGb = useSettingsStore((s) => s.setStreamingAudioCacheLimitGb)
  const [cacheLimitDraft, setCacheLimitDraft] = useState(String(streamingAudioCacheLimitGb))
  const [cacheStats, setCacheStats] = useState<{
    totalBytes: number
    totalGb: number
    fileCount: number
    limitGb: number
    limitBytes: number
  } | null>(null)

  useEffect(() => {
    setCacheLimitDraft(String(streamingAudioCacheLimitGb))
  }, [streamingAudioCacheLimitGb])

  const refreshCacheStats = useCallback(async () => {
    const next = await window.puros.app.getStreamingAudioCacheStats().catch(() => null)
    setCacheStats(next)
  }, [])

  useEffect(() => {
    void refreshCacheStats()
  }, [refreshCacheStats])

  const commitCacheLimit = async () => {
    const parsed = Number(cacheLimitDraft)
    await setStreamingAudioCacheLimitGb(Number.isFinite(parsed) ? parsed : streamingAudioCacheLimitGb)
    await refreshCacheStats()
  }

  const formattedCacheSize = cacheStats
    ? cacheStats.totalGb >= 0.1
      ? `${cacheStats.totalGb.toFixed(1)} GB`
      : `${Math.round(cacheStats.totalBytes / (1024 * 1024))} MB`
    : 'Calculating...'

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Streaming providers
        </h3>
        <div className="space-y-3">
          {providers.map((descriptor) => <ProviderSettingsCard key={descriptor.manifest.id} descriptor={descriptor} />)}
          {providersLoaded && providers.length === 0 && (
            <p className="rounded-lg bg-zinc-800/40 px-4 py-5 text-sm text-zinc-500">No streaming providers are installed.</p>
          )}
        </div>
      </div>

      <ProviderPackagesSettings />

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Streaming audio cache
        </h3>
        <div className="bg-zinc-800/60 rounded-lg p-4 max-w-md">
          <label className="block">
            <span className="text-sm text-zinc-200 font-medium">Cache limit</span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={1}
                max={500}
                step={1}
                value={cacheLimitDraft}
                onChange={(event) => setCacheLimitDraft(event.target.value)}
                onBlur={() => { void commitCacheLimit() }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
                className="w-28 px-3 py-2 bg-zinc-900/80 border border-white/10 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-white/20"
              />
              <span className="text-sm text-zinc-500">GB</span>
              <span className="text-xs text-zinc-600">•</span>
              <span className="text-xs text-zinc-400">
                Using {formattedCacheSize}
              </span>
              {cacheStats && (
                <span className="text-xs text-zinc-600">
                  ({cacheStats.fileCount} {cacheStats.fileCount === 1 ? 'file' : 'files'})
                </span>
              )}
            </div>
          </label>
          <p className="mt-3 text-[11px] text-zinc-600 leading-relaxed">
            Puros keeps recently played streaming audio on disk so repeat plays can avoid resolving the same provider stream again. When the limit is exceeded, the least recently played cached files are removed first. Metadata such as format, bitrate, and artwork is kept separately.
          </p>
        </div>
      </div>

      <LastFmSettings />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Player tab
// ---------------------------------------------------------------------------

function PlayerTab() {
  const {
    playerTags,
    setPlayerTag,
    discordRichPresenceEnabled,
    discordArtworkUploadProvider,
    discordCloudinaryCloudName,
    discordCloudinaryUploadPreset,
    discordCloudinaryApiKey,
    discordCloudinaryApiSecret,
    streamingPlaybackMode,
    setDiscordRichPresenceEnabled,
    setDiscordArtworkUploadProvider,
    setDiscordCloudinaryCloudName,
    setDiscordCloudinaryUploadPreset,
    setDiscordCloudinaryApiKey,
    setDiscordCloudinaryApiSecret,
    setStreamingPlaybackMode,
    showLyricsInNowPlaying,
    endlessPlaybackEnabled,
    rememberPlaybackSession,
    resumePlaybackOnLaunch,
    resumeRewindSeconds,
    strictSampleRate,
    lyricsProviderPriority,
    lyricsApiKeys,
    lyricsFontSize,
    dimAlbumArtWhenLyricsVisible,
    setShowLyricsInNowPlaying,
    setEndlessPlaybackEnabled,
    setRememberPlaybackSession,
    setResumePlaybackOnLaunch,
    setResumeRewindSeconds,
    setStrictSampleRate,
    setLyricsProviderPriority,
    setLyricsApiKey,
    setLyricsFontSize,
    setDimAlbumArtWhenLyricsVisible,
  } = useSettingsStore()
  const [discordCloudinaryCloudNameDraft, setDiscordCloudinaryCloudNameDraft] = useState(discordCloudinaryCloudName)
  const [discordCloudinaryUploadPresetDraft, setDiscordCloudinaryUploadPresetDraft] = useState(discordCloudinaryUploadPreset)
  const [discordCloudinaryApiKeyDraft, setDiscordCloudinaryApiKeyDraft] = useState(discordCloudinaryApiKey)
  const [discordCloudinaryApiSecretDraft, setDiscordCloudinaryApiSecretDraft] = useState(discordCloudinaryApiSecret)
  const [lyricsApiKeyDrafts, setLyricsApiKeyDrafts] = useState(lyricsApiKeys)
  const [providerStatuses, setProviderStatuses] = useState(DEFAULT_PROVIDER_STATUS)
  const [testingProvider, setTestingProvider] = useState<LyricsProviderId | null>(null)
  const dragProviderIdRef = useRef<LyricsProviderId | null>(null)

  useEffect(() => {
    setDiscordCloudinaryCloudNameDraft(discordCloudinaryCloudName)
  }, [discordCloudinaryCloudName])

  useEffect(() => {
    setDiscordCloudinaryUploadPresetDraft(discordCloudinaryUploadPreset)
  }, [discordCloudinaryUploadPreset])

  useEffect(() => {
    setDiscordCloudinaryApiKeyDraft(discordCloudinaryApiKey)
  }, [discordCloudinaryApiKey])

  useEffect(() => {
    setDiscordCloudinaryApiSecretDraft(discordCloudinaryApiSecret)
  }, [discordCloudinaryApiSecret])

  useEffect(() => {
    setLyricsApiKeyDrafts(lyricsApiKeys)
  }, [lyricsApiKeys])

  useEffect(() => {
    setProviderStatuses({
      lrclib: { tone: 'ok', message: 'Ready' },
      musixmatch: lyricsApiKeys.musixmatch
        ? { tone: 'idle', message: 'Configured' }
        : { tone: 'idle', message: 'Not configured' },
      genius: lyricsApiKeys.genius
        ? { tone: 'idle', message: 'Configured' }
        : { tone: 'idle', message: 'Not configured' },
    })
  }, [lyricsApiKeys.genius, lyricsApiKeys.musixmatch])

  const commitLyricsApiKey = async (provider: Exclude<LyricsProviderId, 'lrclib'>) => {
    await setLyricsApiKey(provider, lyricsApiKeyDrafts[provider])
  }

  const moveLyricsProvider = async (fromId: LyricsProviderId, toId: LyricsProviderId) => {
    if (fromId === toId) return

    const fromIndex = lyricsProviderPriority.findIndex((provider) => provider.id === fromId)
    const toIndex = lyricsProviderPriority.findIndex((provider) => provider.id === toId)
    if (fromIndex < 0 || toIndex < 0) return

    const next = [...lyricsProviderPriority]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    await setLyricsProviderPriority(next)
  }

  const handleLyricsProviderToggle = async (providerId: LyricsProviderId, enabled: boolean) => {
    const next = lyricsProviderPriority.map((provider) =>
      provider.id === providerId ? { ...provider, enabled } : provider,
    )
    await setLyricsProviderPriority(next)
  }

  const handleTestProvider = async (providerId: LyricsProviderId) => {
    setTestingProvider(providerId)
    try {
      const apiKey = providerId === 'lrclib'
        ? undefined
        : providerId === 'musixmatch'
          ? lyricsApiKeyDrafts.musixmatch
          : lyricsApiKeyDrafts.genius
      const result = await window.puros.lyrics.testProvider(providerId, apiKey)
      setProviderStatuses((current) => ({
        ...current,
        [providerId]: {
          tone: result.ok ? 'ok' : 'error',
          message: result.message,
        },
      }))
    } finally {
      setTestingProvider(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Playback Source
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          Choose how provider tracks are prepared before they are handed to the audio engine.
        </p>
        <div className="space-y-2 max-w-lg">
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-zinc-800/40 px-4 py-3">
            <input
              type="radio"
              name="streaming-playback-mode"
              value="progressive-cache"
              checked={streamingPlaybackMode === 'progressive-cache'}
              onChange={() => { void setStreamingPlaybackMode('progressive-cache') }}
              className="mt-0.5 accent-blue-600"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-100">
                Stream immediately and cache in background
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-zinc-600">
                Starts playback right away when the selected provider supports progressive playback, and falls back to downloading first otherwise.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-zinc-800/40 px-4 py-3">
            <input
              type="radio"
              name="streaming-playback-mode"
              value="download-first"
              checked={streamingPlaybackMode === 'download-first'}
              onChange={() => { void setStreamingPlaybackMode('download-first') }}
              className="mt-0.5 accent-blue-600"
            />
            <span>
              <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                Download full track before playback
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Legacy
                </span>
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-zinc-600">
                Waits for the whole track to download before handing it to the audio engine.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Discord Rich Presence
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          Show the currently playing song in Discord as <span className="text-zinc-400">Listening to Puros</span>. Requires the Discord desktop app.
        </p>
        <div className="space-y-3 max-w-lg">
          <ToggleRow
            label="Enable Discord Rich Presence"
            checked={discordRichPresenceEnabled}
            onChange={(value) => {
              void setDiscordRichPresenceEnabled(value)
            }}
          />

          <div className="space-y-2">
            <label className="block text-xs uppercase tracking-wider text-zinc-500">
              Local Artwork Hosting
            </label>
            <select
              value={discordArtworkUploadProvider}
              onChange={(event) => { void setDiscordArtworkUploadProvider(event.target.value === 'cloudinary' ? 'cloudinary' : 'none') }}
              className="w-full px-3 py-2 bg-zinc-800/60 border border-white/10 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-white/20"
            >
              <option value="none">Disabled</option>
              <option value="cloudinary">Cloudinary</option>
            </select>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              Local or embedded album covers are not publicly reachable by Discord. Choose a host if you want Puros to upload them and reuse the hosted URL in Rich Presence.
            </p>
          </div>

          {discordArtworkUploadProvider === 'cloudinary' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="block text-xs uppercase tracking-wider text-zinc-500">
                  Cloudinary Cloud Name
                </label>
                <input
                  type="text"
                  value={discordCloudinaryCloudNameDraft}
                  onChange={(event) => setDiscordCloudinaryCloudNameDraft(event.target.value)}
                  onBlur={() => { void setDiscordCloudinaryCloudName(discordCloudinaryCloudNameDraft) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur()
                    }
                  }}
                  placeholder="Your Cloudinary cloud name"
                  className="w-full px-3 py-2 bg-zinc-800/60 border border-white/10 rounded-lg text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/20"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-xs uppercase tracking-wider text-zinc-500">
                  Cloudinary Upload Preset
                </label>
                <input
                  type="text"
                  value={discordCloudinaryUploadPresetDraft}
                  onChange={(event) => setDiscordCloudinaryUploadPresetDraft(event.target.value)}
                  onBlur={() => { void setDiscordCloudinaryUploadPreset(discordCloudinaryUploadPresetDraft) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur()
                    }
                  }}
                  placeholder="Unsigned upload preset name"
                  className="w-full px-3 py-2 bg-zinc-800/60 border border-white/10 rounded-lg text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/20"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-xs uppercase tracking-wider text-zinc-500">
                  Cloudinary API Key
                </label>
                <input
                  type="text"
                  value={discordCloudinaryApiKeyDraft}
                  onChange={(event) => setDiscordCloudinaryApiKeyDraft(event.target.value)}
                  onBlur={() => { void setDiscordCloudinaryApiKey(discordCloudinaryApiKeyDraft) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur()
                    }
                  }}
                  placeholder="Optional: API key for signed/basic-auth uploads"
                  className="w-full px-3 py-2 bg-zinc-800/60 border border-white/10 rounded-lg text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/20"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-xs uppercase tracking-wider text-zinc-500">
                  Cloudinary API Secret
                </label>
                <input
                  type="password"
                  value={discordCloudinaryApiSecretDraft}
                  onChange={(event) => setDiscordCloudinaryApiSecretDraft(event.target.value)}
                  onBlur={() => { void setDiscordCloudinaryApiSecret(discordCloudinaryApiSecretDraft) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur()
                    }
                  }}
                  placeholder="Optional: API secret for signed/basic-auth uploads"
                  className="w-full px-3 py-2 bg-zinc-800/60 border border-white/10 rounded-lg text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/20"
                />
              </div>

              <p className="text-[11px] text-zinc-600 leading-relaxed">
                Puros first tries unsigned upload preset flow. If that is flaky in your Cloudinary account, you can also provide API key and secret and Puros will use authenticated upload requests from the Electron main process instead.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Sample rate
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          In exclusive mode Puros opens the device at the source's own rate (48 kHz for Opus). When the device cannot run at that rate, Puros normally resamples and shows it in the signal path. With this option it stops with an error instead.
        </p>
        <div className="rounded-lg border border-white/10 bg-zinc-800/40 px-4 py-3 max-w-lg">
          <ToggleRow
            label="Never resample in exclusive mode"
            checked={strictSampleRate}
            onChange={(value) => { void setStrictSampleRate(value) }}
          />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Queue playback
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          When your current queue runs out, Puros can continue with a shuffled radio queue from the last artist you played.
        </p>
        <div className="rounded-lg border border-white/10 bg-zinc-800/40 px-4 py-3 max-w-lg">
          <ToggleRow
            label="Enable endless playback"
            checked={endlessPlaybackEnabled}
            onChange={(value) => { void setEndlessPlaybackEnabled(value) }}
          />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Session
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          Puros can remember the queue, the last track, where you stopped in it, and shuffle and repeat, and bring them back the next time you open the app.
        </p>
        <div className="rounded-lg border border-white/10 bg-zinc-800/40 px-4 py-3 max-w-lg">
          <ToggleRow
            label="Remember last session"
            checked={rememberPlaybackSession}
            onChange={(value) => { void setRememberPlaybackSession(value) }}
          />
          {rememberPlaybackSession ? (
            <>
              <ToggleRow
                label="Start playing on launch"
                checked={resumePlaybackOnLaunch}
                onChange={(value) => { void setResumePlaybackOnLaunch(value) }}
              />
              <div className="flex items-center justify-between gap-4 py-2">
                <span className="text-sm text-zinc-300 select-none">Rewind when resuming</span>
                <Segmented
                  value={String(resumeRewindSeconds) as '0' | '5' | '10'}
                  options={[
                    { id: '0', label: 'Off' },
                    { id: '5', label: '5 s' },
                    { id: '10', label: '10 s' },
                  ]}
                  onChange={(value) => { void setResumeRewindSeconds(Number(value) as ResumeRewindSeconds) }}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Lyrics
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          Configure synced lyrics for the full-screen Now Playing view. Providers are tried from top to bottom.
        </p>

        <div className="space-y-4">
          <div className="rounded-lg border border-white/10 bg-zinc-800/40 px-4 py-3">
            <ToggleRow
              label="Show lyrics in Now Playing view"
              checked={showLyricsInNowPlaying}
              onChange={(value) => { void setShowLyricsInNowPlaying(value) }}
            />
            <ToggleRow
              label="Dim album art when lyrics are visible"
              checked={dimAlbumArtWhenLyricsVisible}
              onChange={(value) => { void setDimAlbumArtWhenLyricsVisible(value) }}
            />
          </div>

          <div className="rounded-lg border border-white/10 bg-zinc-800/40 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-zinc-100">Lyrics font size</p>
                <p className="mt-1 text-[11px] text-zinc-600">
                  Fine-tunes legibility in the overlay without changing the rest of the interface.
                </p>
              </div>
              <div className="w-52">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={1}
                  value={lyricsFontSize === 'small' ? 0 : lyricsFontSize === 'large' ? 2 : 1}
                  onChange={(event) => {
                    const next = event.target.value === '0'
                      ? 'small'
                      : event.target.value === '2'
                        ? 'large'
                        : 'medium'
                    void setLyricsFontSize(next)
                  }}
                  className="w-full accent-white"
                />
                <div className="mt-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-zinc-500">
                  {(Object.keys(LYRICS_FONT_LABELS) as LyricsFontSize[]).map((size) => (
                    <span
                      key={size}
                      className={lyricsFontSize === size ? 'text-zinc-200' : undefined}
                    >
                      {LYRICS_FONT_LABELS[size]}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {lyricsProviderPriority.map((provider) => {
              const status = providerStatuses[provider.id]
              const isApiKeyProvider = provider.id !== 'lrclib'
              const draftApiKey = provider.id === 'musixmatch'
                ? lyricsApiKeyDrafts.musixmatch
                : provider.id === 'genius'
                  ? lyricsApiKeyDrafts.genius
                  : ''
              return (
                <div
                  key={provider.id}
                  draggable
                  onDragStart={() => {
                    dragProviderIdRef.current = provider.id
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const draggedId = dragProviderIdRef.current
                    dragProviderIdRef.current = null
                    if (!draggedId) return
                    void moveLyricsProvider(draggedId, provider.id)
                  }}
                  onDragEnd={() => {
                    dragProviderIdRef.current = null
                  }}
                  className="rounded-xl border border-white/10 bg-zinc-800/50 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 cursor-grab text-zinc-500">⋮⋮</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-zinc-100">
                            {LYRICS_PROVIDER_LABELS[provider.id]}
                          </p>
                          <span className={`h-2.5 w-2.5 rounded-full ${statusToneClasses(status.tone)}`} />
                          <span className="text-xs text-zinc-500">{status.message}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-zinc-600">
                          Priority {lyricsProviderPriority.findIndex((entry) => entry.id === provider.id) + 1}
                        </p>
                      </div>
                    </div>
                    <ToggleRow
                      label=""
                      checked={provider.enabled}
                      onChange={(value) => { void handleLyricsProviderToggle(provider.id, value) }}
                    />
                  </div>

                  <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
                    <div className="flex-1 space-y-2">
                      <label className="block text-xs uppercase tracking-wider text-zinc-500">
                        API key
                      </label>
                      <input
                        type="password"
                        value={isApiKeyProvider ? draftApiKey : ''}
                        disabled={!isApiKeyProvider}
                        onChange={(event) => {
                          if (!isApiKeyProvider) return
                          if (provider.id === 'musixmatch') {
                            setLyricsApiKeyDrafts((current) => ({
                              ...current,
                              musixmatch: event.target.value,
                            }))
                            return
                          }
                          if (provider.id === 'genius') {
                            setLyricsApiKeyDrafts((current) => ({
                              ...current,
                              genius: event.target.value,
                            }))
                          }
                        }}
                        onBlur={() => {
                          if (provider.id === 'musixmatch' || provider.id === 'genius') {
                            void commitLyricsApiKey(provider.id)
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                        }}
                        placeholder={isApiKeyProvider ? `${LYRICS_PROVIDER_LABELS[provider.id]} API key` : 'No API key required'}
                        className="w-full rounded-lg border border-white/10 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 disabled:cursor-default disabled:opacity-60 focus:outline-none focus:border-white/20"
                      />
                    </div>
                    <button
                      onClick={() => { void handleTestProvider(provider.id) }}
                      disabled={testingProvider === provider.id}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/10 disabled:opacity-50"
                    >
                      {testingProvider === provider.id ? 'Testing…' : 'Test connection'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Player badges
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          Choose which tags are shown in the now-playing bar.
        </p>
        <div className="divide-y divide-white/5">
          {(Object.keys(PLAYER_TAG_LABELS) as (keyof PlayerTagSettings)[]).map((key) => (
            <ToggleRow
              key={key}
              label={PLAYER_TAG_LABELS[key]}
              checked={playerTags[key]}
              onChange={(v) => setPlayerTag(key, v)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Library tab
// ---------------------------------------------------------------------------

function LibraryTab() {
  const { isScanning, scanFolder, rescan, clearLibrary, loadAlbums, loadArtists, loadTracks } = useLibraryStore()
  const {
    homeDisplayName,
    setHomeDisplayName,
    showUnavailableSources,
    setShowUnavailableSources,
    groupPlaylistsByProvider,
    setGroupPlaylistsByProvider,
  } = useSettingsStore()
  const [homeNameDraft, setHomeNameDraft] = useState(homeDisplayName)
  const [folders, setFolders] = useState<Array<{ id: string; path: string; last_scanned_at: number | null }>>([])
  const [clearConfirm, setClearConfirm] = useState(false)
  const [clearHistoryConfirm, setClearHistoryConfirm] = useState(false)
  const [clearCachesConfirm, setClearCachesConfirm] = useState(false)
  const [clearMetadataCacheConfirm, setClearMetadataCacheConfirm] = useState(false)
  const [resetAppConfirm, setResetAppConfirm] = useState(false)
  const [confirmRemoveFolderId, setConfirmRemoveFolderId] = useState<string | null>(null)
  const [removingFolderId, setRemovingFolderId] = useState<string | null>(null)
  const [debugActionRunning, setDebugActionRunning] = useState<'clearCaches' | 'clearMetadata' | 'resetApp' | null>(null)

  const loadFolders = useCallback(async () => {
    const rows = await window.puros.library.getFolders()
    setFolders(rows)
  }, [])

  useEffect(() => { loadFolders() }, [loadFolders])
  useEffect(() => { setHomeNameDraft(homeDisplayName) }, [homeDisplayName])

  const handleAddFolder = useCallback(async () => {
    await scanFolder()
    await loadFolders()
    await loadAlbums()
    await loadArtists()
    await loadTracks()
  }, [scanFolder, loadFolders, loadAlbums, loadArtists, loadTracks])

  const handleRescan = useCallback(async () => {
    await rescan()
    await loadFolders()
    await loadAlbums()
    await loadArtists()
    await loadTracks()
  }, [rescan, loadFolders, loadAlbums, loadArtists, loadTracks])

  const handleRemoveFolder = useCallback(async (folderId: string) => {
    setRemovingFolderId(folderId)
    try {
      await window.puros.library.removeFolder(folderId)
      await loadFolders()
      await loadAlbums()
      setConfirmRemoveFolderId(null)
    } finally {
      setRemovingFolderId(null)
    }
  }, [loadFolders, loadAlbums])

  const handleClear = useCallback(async () => {
    await clearLibrary()
    await loadFolders()
    await loadAlbums()
    setClearConfirm(false)
  }, [clearLibrary, loadFolders, loadAlbums])

  const handleClearCaches = useCallback(async () => {
    setDebugActionRunning('clearCaches')
    try {
      await window.puros.app.clearCaches()
      window.location.reload()
    } finally {
      setDebugActionRunning(null)
      setClearCachesConfirm(false)
    }
  }, [])

  const handleClearMetadataCache = useCallback(async () => {
    setDebugActionRunning('clearMetadata')
    try {
      await window.puros.catalog.clearMetadataCache()
      await loadFolders()
      await loadAlbums()
      await loadArtists()
      await loadTracks()
      window.location.reload()
    } finally {
      setDebugActionRunning(null)
      setClearMetadataCacheConfirm(false)
    }
  }, [loadAlbums, loadArtists, loadFolders, loadTracks])

  const handleClearPlaybackHistory = useCallback(async () => {
    await clearRecentlyPlayedHistory()
    setClearHistoryConfirm(false)
  }, [])

  const handleResetAppData = useCallback(async () => {
    setDebugActionRunning('resetApp')
    try {
      await window.puros.app.resetAppData()
      window.location.reload()
    } finally {
      setDebugActionRunning(null)
      setResetAppConfirm(false)
    }
  }, [])

  function fmtDate(ts: number | null): string {
    if (!ts) return 'Never'
    return new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  }

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Home
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          Customize the greeting shown on the Home screen.
        </p>
        <div className="max-w-md space-y-2">
          <input
            type="text"
            value={homeNameDraft}
            onChange={(event) => setHomeNameDraft(event.target.value)}
            onBlur={() => { void setHomeDisplayName(homeNameDraft) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            placeholder="Your name"
            className="w-full px-3 py-2 bg-zinc-800/60 border border-white/10 rounded-lg text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/20"
          />
          <p className="text-[11px] text-zinc-600">
            Preview: {homeNameDraft.trim() ? `Welcome, ${homeNameDraft.trim()}` : 'Welcome back'}
          </p>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">Playlists</h3>
        <p className="text-xs text-zinc-600 mb-2">Show each provider's playlists and synced folders inside a folder for that provider in the sidebar. Your own folders are grouped under the provider their playlists come from.</p>
        <div className="max-w-md rounded-lg border border-white/10 bg-zinc-800/60 px-3 py-2">
          <ToggleRow
            label="Group playlists by provider"
            checked={groupPlaylistsByProvider}
            onChange={(value) => { void setGroupPlaylistsByProvider(value) }}
          />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">Unavailable sources</h3>
        <p className="text-xs text-zinc-600 mb-2">Provider imports are retained when a plugin is absent. They remain inert and hidden unless you enable this view.</p>
        <div className="max-w-md rounded-lg border border-white/10 bg-zinc-800/60 px-3 py-2">
          <ToggleRow
            label="Show unavailable provider imports"
            checked={showUnavailableSources}
            onChange={(value) => { void setShowUnavailableSources(value).then(() => window.location.reload()) }}
          />
        </div>
      </div>









      {/* Music folders */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Music folders
        </h3>

        {folders.length === 0 ? (
          <p className="text-xs text-zinc-600 mb-3">No folders added yet.</p>
        ) : (
          <div className="space-y-1 mb-3">
            {folders.map((f) => (
              <div key={f.id} className="px-3 py-2.5 bg-zinc-800/60 rounded-lg">
                <div className="flex items-center gap-3">
                  <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-zinc-200 truncate font-mono">{f.path}</p>
                    <p className="text-[10px] text-zinc-600 mt-0.5">Last scanned: {fmtDate(f.last_scanned_at)}</p>
                  </div>
                  {confirmRemoveFolderId !== f.id ? (
                    <button
                      onClick={() => setConfirmRemoveFolderId(f.id)}
                      disabled={isScanning || removingFolderId != null}
                      className="shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                    >
                      Remove
                    </button>
                  ) : (
                    <div className="shrink-0 max-w-[18rem] rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2">
                      <p className="text-[11px] text-zinc-300 leading-relaxed">
                        Remove this folder from local files and forget tracks imported from it.
                      </p>
                      <div className="mt-2 flex flex-wrap justify-end gap-2">
                        <button
                          onClick={() => void handleRemoveFolder(f.id)}
                          disabled={removingFolderId === f.id}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
                        >
                          {removingFolderId === f.id ? 'Removing…' : 'Yes, remove'}
                        </button>
                        <button
                          onClick={() => setConfirmRemoveFolderId(null)}
                          disabled={removingFolderId === f.id}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleAddFolder}
            disabled={isScanning}
            className="flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-zinc-300 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            {isScanning ? 'Scanning…' : 'Add folder…'}
          </button>

          <button
            onClick={handleRescan}
            disabled={isScanning || folders.length === 0}
            className="flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-zinc-300 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
          >
            <RotateCw className="w-3.5 h-3.5" />
            {isScanning ? 'Rescanning…' : 'Rescan library'}
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          History
        </h3>
        <div className="border border-white/10 rounded-lg p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-zinc-200 font-medium">Clear playback history</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Remove recently played songs, albums, and playlists from the Home screen without touching your library, playlists, or provider content.
              </p>
            </div>
            {!clearHistoryConfirm ? (
              <button
                onClick={() => setClearHistoryConfirm(true)}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors"
              >
                Clear history…
              </button>
            ) : (
              <div className="shrink-0 max-w-[18rem] rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Only Home playback history will be removed.
                </p>
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button
                    onClick={handleClearPlaybackHistory}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-200 text-zinc-950 hover:bg-white transition-colors"
                  >
                    Yes, clear
                  </button>
                  <button
                    onClick={() => setClearHistoryConfirm(false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Danger zone */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-red-500/70 mb-3">
          Danger zone
        </h3>
        <div className="border border-red-500/20 rounded-lg p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-zinc-200 font-medium">Clear library</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Remove all indexed tracks, albums, and artists from Puros only. This does not delete audio files on disk or content from streaming providers.
              </p>
            </div>
            {!clearConfirm ? (
              <button
                onClick={() => setClearConfirm(true)}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
              >
                Clear…
              </button>
            ) : (
              <div className="shrink-0 max-w-[18rem] rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2">
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Only Puros library data will be removed.
                </p>
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button
                    onClick={handleClear}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-500 transition-colors"
                  >
                    Yes, clear
                  </button>
                  <button
                    onClick={() => setClearConfirm(false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-white/5 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-zinc-200 font-medium">Clear metadata cache</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Drop cached MusicBrainz matches, artwork provenance, biographies, and other metadata enrichment without removing your library, playlists, or playback mappings.
              </p>
            </div>
            {!clearMetadataCacheConfirm ? (
              <button
                onClick={() => setClearMetadataCacheConfirm(true)}
                disabled={debugActionRunning !== null}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 transition-colors disabled:opacity-50"
              >
                Clear metadata…
              </button>
            ) : (
              <div className="shrink-0 max-w-[18rem] rounded-xl border border-sky-500/20 bg-sky-500/[0.06] px-3 py-2">
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Only derived metadata will be removed. Local files and provider library data stay intact.
                </p>
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button
                    onClick={handleClearMetadataCache}
                    disabled={debugActionRunning !== null}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 text-white hover:bg-sky-500 transition-colors disabled:opacity-50"
                  >
                    {debugActionRunning === 'clearMetadata' ? 'Clearing…' : 'Yes, clear'}
                  </button>
                  <button
                    onClick={() => setClearMetadataCacheConfirm(false)}
                    disabled={debugActionRunning !== null}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-white/5 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-zinc-200 font-medium">Clear caches</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Clear artwork, temporary streaming playback files, AutoEQ data, and other app-side cached state. Your library and provider content stay untouched.
              </p>
            </div>
            {!clearCachesConfirm ? (
              <button
                onClick={() => setClearCachesConfirm(true)}
                disabled={debugActionRunning !== null}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
              >
                Clear caches…
              </button>
            ) : (
              <div className="shrink-0 max-w-[18rem] rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2">
                <p className="text-xs text-zinc-300 leading-relaxed">
                  This only clears Puros caches.
                </p>
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button
                    onClick={handleClearCaches}
                    disabled={debugActionRunning !== null}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors disabled:opacity-50"
                  >
                    {debugActionRunning === 'clearCaches' ? 'Clearing…' : 'Yes, clear'}
                  </button>
                  <button
                    onClick={() => setClearCachesConfirm(false)}
                    disabled={debugActionRunning !== null}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-white/5 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-zinc-200 font-medium">Reset app data</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Remove Puros database contents, settings, playlists, cached metadata, and connected-provider session state. This does not delete files on disk or anything from remote providers.
              </p>
            </div>
            {!resetAppConfirm ? (
              <button
                onClick={() => setResetAppConfirm(true)}
                disabled={debugActionRunning !== null}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                Reset app…
              </button>
            ) : (
              <div className="shrink-0 max-w-[18rem] rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2">
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Only Puros app data will be removed.
                </p>
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button
                    onClick={handleResetAppData}
                    disabled={debugActionRunning !== null}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
                  >
                    {debugActionRunning === 'resetApp' ? 'Resetting…' : 'Yes, reset'}
                  </button>
                  <button
                    onClick={() => setResetAppConfirm(false)}
                    disabled={debugActionRunning !== null}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Visualizer tab
// ---------------------------------------------------------------------------

function VisualizerTab() {
  const { customPresets, addPresets, removePreset, cycleInterval, setCycleInterval, randomize, setRandomize,
    brightness, setBrightness, reactivity, setReactivity, showFps, setShowFps, renderScale, setRenderScale } = useVisualizerStore()
  const [intervalDraft, setIntervalDraft] = useState(String(cycleInterval))
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [lastFolderResult, setLastFolderResult] = useState<{ count: number; total: number } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const parseMilkFiles = async (files: File[]): Promise<Record<string, unknown>> => {
    const parsed: Record<string, unknown> = {}
    const errors: string[] = []
    for (const file of files) {
      const name = file.name.replace(/\.milk$/i, '')
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('Preset exceeds the 2 MB import limit')
        const text = await file.text()
        parsed[name] = await importMilkPreset(name, text, window.puros.app.convertVisualizerShaders)
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setImportError(errors.length > 0 ? errors.join('\n') : null)
    return parsed
  }

  const handleFileImport = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setImporting(true)
    setImportError(null)
    setLastFolderResult(null)
    try {
      const parsed = await parseMilkFiles(Array.from(files))
      const count = Object.keys(parsed).length
      if (count > 0) addPresets(parsed)
      setLastFolderResult({ count, total: files.length })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleFolderImport = async (files: FileList | null) => {
    if (!files) return
    setImporting(true)
    setImportError(null)
    setLastFolderResult(null)
    try {
      const milkFiles = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.milk'))
      const parsed = milkFiles.length > 0 ? await parseMilkFiles(milkFiles) : {}
      const imported = Object.keys(parsed).length
      if (imported > 0) addPresets(parsed)
      setLastFolderResult({ count: imported, total: milkFiles.length })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
      if (folderInputRef.current) folderInputRef.current.value = ''
    }
  }

  const [showAll, setShowAll] = useState(false)
  const [removeAllConfirm, setRemoveAllConfirm] = useState(false)

  const presetNames = Object.keys(customPresets).sort()
  const visiblePresets = showAll ? presetNames : presetNames.slice(0, 5)
  const hiddenCount = presetNames.length - visiblePresets.length

  const handleRemoveAll = () => {
    for (const name of presetNames) removePreset(name)
    setRemoveAllConfirm(false)
    setShowAll(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Rendering
        </h3>
        <div className="rounded-lg border border-white/10 bg-zinc-800/40 px-4">
          <ToggleRow label="Show FPS" checked={showFps} onChange={setShowFps} />
          <p className="pb-3 text-xs text-zinc-500">Shows the frame rate in the top-right corner of the visualizer.</p>
          <div className="border-t border-white/5 py-3">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="visualizer-render-scale" className="text-sm text-zinc-200">Render scale</label>
              <output htmlFor="visualizer-render-scale" className="text-xs tabular-nums text-zinc-300">{renderScale.toFixed(2)}×</output>
            </div>
            <p id="visualizer-render-scale-description" className="mt-0.5 text-xs text-zinc-500">
              1× matches the visualizer’s native display resolution, including Retina. Lower values improve performance; higher values increase detail. Limited by your GPU’s maximum resolution.
            </p>
            <input
              id="visualizer-render-scale"
              type="range"
              min={0.25}
              max={3}
              step={0.05}
              value={renderScale}
              onChange={(event) => setRenderScale(Number(event.target.value))}
              aria-describedby="visualizer-render-scale-description"
              aria-valuetext={`${renderScale.toFixed(2)} times`}
              className="mt-3 w-full accent-white"
            />
            <div className="flex items-center justify-between text-[11px] text-zinc-500">
              <span>0.25×</span>
              <button type="button" onClick={() => setRenderScale(1)} className="hover:text-zinc-200 transition-colors">Reset to 1×</button>
              <span>3×</span>
            </div>
          </div>
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Visual intensity
        </h3>
        <div className="rounded-lg border border-white/10 bg-zinc-800/40 px-4 divide-y divide-white/5">
          {[
            { id: 'visualizer-brightness', label: 'Brightness', value: brightness, onChange: setBrightness,
              description: 'Dims the visualizer image. Default: 80%.', defaultValue: 0.8 },
            { id: 'visualizer-reactivity', label: 'Music reactivity', value: reactivity, onChange: setReactivity,
              description: 'Reduces music-driven pulses and waves without changing playback volume. Default: 100%.', defaultValue: 1 },
          ].map(({ id, label, value, onChange, description, defaultValue }) => (
            <div key={id} className="py-3">
              <div className="flex items-center justify-between gap-4">
                <label htmlFor={id} className="text-sm text-zinc-200">{label}</label>
                <output htmlFor={id} className="text-xs tabular-nums text-zinc-300">{Math.round(value * 100)}%</output>
              </div>
              <p id={`${id}-description`} className="text-xs text-zinc-500 mt-0.5">{description}</p>
              <input
                id={id}
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(value * 100)}
                onChange={(event) => onChange(Number(event.target.value) / 100)}
                aria-describedby={`${id}-description`}
                aria-valuetext={`${Math.round(value * 100)}%`}
                className="mt-3 w-full accent-white"
              />
              <div className="flex items-center justify-between text-[11px] text-zinc-500">
                <span>{id === 'visualizer-brightness' ? 'Dark' : 'Calm'}</span>
                <button type="button" onClick={() => onChange(defaultValue)} className="hover:text-zinc-200 transition-colors">
                  Reset to default
                </button>
                <span>100%</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Preset cycling
        </h3>
        <div className="rounded-lg border border-white/10 bg-zinc-800/40 px-4 divide-y divide-white/5">
          <div className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm text-zinc-200">Cycle presets every</p>
              <p className="text-xs text-zinc-500 mt-0.5">Seconds between automatic preset changes</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={5}
                step={1}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                onBlur={() => {
                  const n = Number(intervalDraft)
                  const clamped = Number.isFinite(n) && n >= 5 ? n : cycleInterval
                  setIntervalDraft(String(clamped))
                  setCycleInterval(clamped)
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className="w-20 px-2 py-1.5 bg-zinc-900/80 border border-white/10 rounded-lg text-sm text-zinc-100 text-center focus:outline-none focus:border-white/20"
              />
              <span className="text-sm text-zinc-500">s</span>
            </div>
          </div>
          <ToggleRow
            label="Randomize next preset"
            checked={randomize}
            onChange={setRandomize}
          />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
          Custom Milkdrop presets
        </h3>
        <p className="text-xs text-zinc-600 mb-3">
          Import <span className="text-zinc-400">.milk</span> files or pick a folder. Shaders are converted during import. Presets are mixed with built-in effects and persist across restarts. Re-import previously added files to restore their shaders.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".milk"
          multiple
          className="hidden"
          onChange={(e) => { void handleFileImport(e.target.files) }}
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error — webkitdirectory is not in React's typings
          webkitdirectory=""
          className="hidden"
          onChange={(e) => { void handleFolderImport(e.target.files) }}
        />

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { setLastFolderResult(null); fileInputRef.current?.click() }}
            disabled={importing}
            className="flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-zinc-300 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            {importing ? 'Importing…' : 'Import .milk files…'}
          </button>

          <button
            onClick={() => { setLastFolderResult(null); folderInputRef.current?.click() }}
            disabled={importing}
            className="flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-zinc-300 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
          >
            <Folder className="w-3.5 h-3.5" />
            {importing ? 'Importing…' : 'Import from folder…'}
          </button>
        </div>

        {lastFolderResult !== null && (
          <p className="mt-2 text-xs text-zinc-400">
            {lastFolderResult.total === 0
              ? 'No .milk files found.'
              : `Imported ${lastFolderResult.count} of ${lastFolderResult.total} .milk file${lastFolderResult.total !== 1 ? 's' : ''}.`}
          </p>
        )}
        {importError && (
          <p role="status" className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-red-400">{importError}</p>
        )}
      </div>

      {presetNames.length > 0 ? (
        <div>
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Imported presets ({presetNames.length})
            </h3>
            {removeAllConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-zinc-400">Remove all?</span>
                <button
                  onClick={handleRemoveAll}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-red-600 text-white hover:bg-red-500 transition-colors"
                >
                  Yes
                </button>
                <button
                  onClick={() => setRemoveAllConfirm(false)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setRemoveAllConfirm(true)}
                className="text-[11px] text-red-400 hover:text-red-300 transition-colors"
              >
                Remove all
              </button>
            )}
          </div>
          <div className="space-y-1">
            {visiblePresets.map((name) => (
              <div
                key={name}
                className="flex items-center justify-between gap-3 px-3 py-2 bg-zinc-800/60 rounded-lg"
              >
                <p className="text-sm text-zinc-200 truncate min-w-0">{name}</p>
                <button
                  onClick={() => removePreset(name)}
                  className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-2 w-full py-1.5 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            >
              Show {hiddenCount} more…
            </button>
          )}
          {showAll && presetNames.length > 5 && (
            <button
              onClick={() => setShowAll(false)}
              className="mt-1 w-full py-1.5 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            >
              Show less
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs text-zinc-600">No custom presets imported yet.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export default function Settings({ onClose, initialTab }: SettingsProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'accounts')

  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab])
  const load = useSettingsStore((s) => s.load)
  const loaded = useSettingsStore((s) => s.loaded)

  useEffect(() => {
    if (!loaded) load()
  }, [load, loaded])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'accounts', label: 'Accounts' },
    { id: 'player', label: 'Playback' },
    { id: 'audio', label: 'Audio' },
    { id: 'visualizer', label: 'Visualizer' },
    { id: 'library', label: 'Library & Home' },
  ]

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl w-[min(760px,94vw)] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <nav className="w-36 shrink-0 border-r border-white/10 py-3 px-2 space-y-0.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  tab === t.id
                    ? 'bg-white/10 text-zinc-100'
                    : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {tab === 'accounts' && <AccountsTab />}
            {tab === 'player' && <PlayerTab />}
            {tab === 'audio' && <AudioSetupSettings />}
            {tab === 'library' && <LibraryTab />}
            {tab === 'visualizer' && <VisualizerTab />}
          </div>
        </div>
      </div>
    </div>
  )
}
