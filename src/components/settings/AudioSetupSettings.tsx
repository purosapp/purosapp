/**
 * Settings → Audio: Roon-style Audio Setup.
 *
 * Lists every CoreAudio output grouped by connection type. Each output can be
 * enabled/disabled for Puros (disabled outputs are hidden from the output menu)
 * and configured in a Device Setup dialog with General and Advanced settings.
 * Nothing in the dialog is saved until "Save Settings".
 */

import {
  Airplay,
  Bluetooth,
  Cable,
  Cpu,
  Layers,
  Monitor,
  Network,
  RefreshCw,
  Settings2,
  Speaker,
  Usb,
  Volume2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AudioDevice } from '../../../electron/preload'
import { audioService } from '../../services/AudioService'
import {
  RESYNC_DELAY_OPTIONS_MS,
  deviceDisplayName,
  deviceGroupForTransport,
  dsdRateLabel,
  dsdRateLimitsFor,
  editableDeviceConfig,
  getDeviceConfig,
  groupDevicesByType,
  isDeviceEnabled,
  sameHardwareBufferOptions,
  transportDisplayName,
  type AudioDeviceConfig,
  type AudioDeviceGroupId,
  type DsdRateLimit,
  type ExclusivePreference,
} from '../../services/audioDeviceConfig'
import {
  VOLUME_MODE_SETTINGS,
  resolveVolumeMode,
  volumeModeDescription,
  volumeModeLabel,
  type VolumeModeSetting,
} from '../../services/volumeControl'
import { useAudioSetupStore } from '../../store/audioSetupStore'
import { usePlayerStore } from '../../store/playerStore'
import { isSharedOnlyTransport } from '../../utils/audioDeviceTransport'
import { useSettingsStore } from '../../store/settingsStore'
import {
  DEFAULT_RESAMPLING,
  describeDither,
  describeResampler,
  type ResamplingSettings,
} from '../../services/resamplingSettings'
import ResamplingSettingsPanel from './ResamplingSettingsPanel'
import { GlassPanel, SOLID_GLASS_TINT } from '../GlassPanel'
import { Segmented, Select, SettingRow, Switch } from './controls'
import { Button, FIELD_CLASS } from '../ui'
import { isWindowHidden } from '../../services/windowActivity'

const DEVICE_POLL_INTERVAL_MS = 3000

const EXCLUSIVE_OPTIONS: ReadonlyArray<{ id: ExclusivePreference; label: string; description: string }> = [
  { id: 'remember', label: 'Follow output menu', description: 'Uses the Exclusive Mode switch in the output menu' },
  { id: 'exclusive', label: 'Exclusive', description: 'Always takes full control of the DAC — bit-perfect, other apps are silenced' },
  { id: 'shared', label: 'Shared', description: 'Always plays through the macOS mixer, alongside other apps' },
]

function formatRate(rate: number): string {
  return `${Number((rate / 1000).toFixed(1))} kHz`
}

function formatCapsSummary(device: AudioDevice): string {
  const formats = device.supportedFormats
  if (formats.length === 0) return 'No formats reported'
  const maxRate = Math.max(...formats.map((format) => format.sampleRate))
  const maxDepth = Math.max(...formats.map((format) => format.bitDepth))
  return `Up to ${formatRate(maxRate)} / ${maxDepth} bit`
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function formatLastSeen(timestamp: number | undefined): string {
  if (!timestamp) return 'Not connected'
  return `Last seen ${new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

function GroupIcon({ group, className = 'w-4 h-4' }: { group: AudioDeviceGroupId; className?: string }) {
  switch (group) {
    case 'usb': return <Usb className={className} />
    case 'built-in': return <Speaker className={className} />
    case 'display': return <Monitor className={className} />
    case 'thunderbolt-pci': return <Cpu className={className} />
    case 'network': return <Network className={className} />
    case 'bluetooth': return <Bluetooth className={className} />
    case 'airplay': return <Airplay className={className} />
    case 'virtual': return <Layers className={className} />
    default: return <Cable className={className} />
  }
}

// ---------------------------------------------------------------------------
// Device Setup dialog
// ---------------------------------------------------------------------------

type SetupTab = 'general' | 'advanced' | 'resampling'

const GLOBAL_RESAMPLING_SAVE_DELAY_MS = 400

function DeviceSetupDialog({ device, onClose }: { device: AudioDevice; onClose: () => void }) {
  const setup = useAudioSetupStore((s) => s.setup)
  const saveDeviceConfig = useAudioSetupStore((s) => s.saveDeviceConfig)
  const audioDevice = usePlayerStore((s) => s.audioDevice)
  const audioMode = usePlayerStore((s) => s.audioMode)
  const strictSampleRate = useSettingsStore((s) => s.strictSampleRate)

  const savedConfig = getDeviceConfig(setup, device.uid)
  const savedVolumeMode = audioService.getVolumeMode(device.uid)
  const [draft, setDraft] = useState<AudioDeviceConfig>(() => ({
    ...editableDeviceConfig(savedConfig),
    enabled: isDeviceEnabled(setup, device.uid),
  }))
  const [volumeMode, setVolumeMode] = useState<VolumeModeSetting>(savedVolumeMode)
  const [tab, setTab] = useState<SetupTab>('general')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sharedOnly = isSharedOnlyTransport(device.transportType)
  const hardwareVolume = !!device.hardwareVolume
  const dopCapability = device.dopCapability ?? 'FallbackPCM'
  const supportsDop = dopCapability !== 'FallbackPCM'
  const sampleRates = useMemo(() => uniqueSorted(device.supportedFormats.map((f) => f.sampleRate)), [device])
  const bitDepths = useMemo(() => uniqueSorted(device.supportedFormats.map((f) => f.bitDepth)), [device])
  const effectiveVolumeMode = resolveVolumeMode('exclusive', volumeMode, hardwareVolume)
  const isActive = audioDevice === device.uid

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Close only this dialog, not the whole Settings modal underneath.
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  const update = (patch: Partial<AudioDeviceConfig>) => setDraft((current) => ({ ...current, ...patch }))

  const restoreDefaults = () => {
    setDraft({ enabled: draft.enabled })
    setVolumeMode('auto')
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const previous = savedConfig
      await saveDeviceConfig(device, draft)
      if (volumeMode !== savedVolumeMode) await audioService.setVolumeMode(device.uid, volumeMode)

      // Apply to the live output right away where a reopen is needed (Roon does the same).
      const latest = usePlayerStore.getState()
      if (latest.audioDevice === device.uid && draft.enabled !== false && !sharedOnly) {
        const currentMode = latest.audioMode === 'exclusive' ? 'exclusive' : 'shared'
        const wantedMode = draft.exclusive === 'exclusive' || draft.exclusive === 'shared'
          ? draft.exclusive
          : currentMode
        const bufferChanged = !sameHardwareBufferOptions(previous, draft)
        const resamplingChanged = JSON.stringify(previous.resampling ?? null) !== JSON.stringify(draft.resampling ?? null)
        if (wantedMode !== currentMode || (wantedMode === 'exclusive' && bufferChanged) || resamplingChanged) {
          await audioService.setDevice(device.uid, wantedMode)
        }
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save device settings')
    } finally {
      setSaving(false)
    }
  }

  const exclusiveValue: ExclusivePreference = draft.exclusive ?? 'remember'

  // At the document root: the settings modal's glass would otherwise contain and clip it.
  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <GlassPanel
        role="dialog"
        aria-modal="true"
        aria-label={`Device Setup: ${deviceDisplayName(setup, device)}`}
        radius={16}
        tint={SOLID_GLASS_TINT}
        className="relative border border-transparent w-[min(620px,92vw)] max-h-[82vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 p-2 rounded-xl bg-white/5 text-zinc-300">
              <GroupIcon group={deviceGroupForTransport(device.transportType)} />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Device Setup</p>
              <h3 className="text-sm font-semibold text-zinc-100 truncate">{deviceDisplayName(setup, device)}</h3>
              <p className="text-xs text-zinc-500 truncate">
                {transportDisplayName(device.transportType)} · {device.channels} ch · {formatCapsSummary(device)}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={X}
            iconOnly
            label="Close Device Setup"
            onClick={onClose}
            aria-label="Close Device Setup"
          />
        </div>

        {/* Tabs */}
        <div className="px-6 pt-4 pb-1 shrink-0">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { id: 'general', label: 'General' },
              { id: 'advanced', label: 'Advanced' },
              { id: 'resampling', label: 'Resampling' },
            ]}
          />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-2">
          {tab === 'resampling' ? (
            <div className="py-2 space-y-3">
              <SettingRow
                title="Use global settings"
                description={draft.resampling
                  ? 'This output uses its own resampling, dither and DSD settings.'
                  : `${describeResampler(setup.resampling)} · dither ${describeDither(setup.resampling.dither)} — edit these in Settings → Audio.`}
              >
                <Switch
                  label="Use global resampling settings"
                  checked={!draft.resampling}
                  onChange={(useGlobal) => update({ resampling: useGlobal ? undefined : { ...setup.resampling } })}
                />
              </SettingRow>
              {draft.resampling && (
                <ResamplingSettingsPanel
                  value={draft.resampling}
                  onChange={(resampling) => update({ resampling })}
                  strictSampleRate={strictSampleRate}
                />
              )}
            </div>
          ) : tab === 'general' ? (
            <>
              <SettingRow
                title="Enabled"
                description="Disabled outputs are hidden from the output menu and never opened by Puros."
              >
                <Switch
                  label="Enable device"
                  checked={draft.enabled !== false}
                  onChange={(enabled) => update({ enabled })}
                />
              </SettingRow>

              <SettingRow title="Device name" description={`Shown in Puros instead of “${device.name}”.`} stacked>
                <input
                  type="text"
                  value={draft.displayName ?? ''}
                  placeholder={device.name}
                  maxLength={80}
                  onChange={(event) => update({ displayName: event.target.value })}
                  className={`${FIELD_CLASS} w-full`}
                />
              </SettingRow>

              <SettingRow
                title="Exclusive mode"
                description={sharedOnly
                  ? `${transportDisplayName(device.transportType)} outputs always use shared mode on macOS.`
                  : EXCLUSIVE_OPTIONS.find((option) => option.id === exclusiveValue)?.description}
                stacked
              >
                <Segmented
                  value={sharedOnly ? 'shared' : exclusiveValue}
                  onChange={(exclusive) => update({ exclusive })}
                  options={EXCLUSIVE_OPTIONS.map((option) => ({
                    id: option.id,
                    label: option.label,
                    disabled: sharedOnly,
                  }))}
                />
              </SettingRow>

              <SettingRow
                title="Volume control"
                description={
                  <>
                    {volumeMode === 'auto' ? `${volumeModeLabel(effectiveVolumeMode)}: ` : ''}
                    {volumeModeDescription(effectiveVolumeMode)}. Applies in exclusive mode; shared mode uses the macOS volume.
                  </>
                }
                stacked
              >
                <Segmented
                  value={volumeMode}
                  onChange={setVolumeMode}
                  options={VOLUME_MODE_SETTINGS.map((mode) => ({
                    id: mode,
                    label: mode === 'device' ? 'Device' : volumeModeLabel(mode),
                    disabled: mode === 'device' && !hardwareVolume,
                    title: mode === 'device' && !hardwareVolume ? 'This device has no hardware volume control' : undefined,
                  }))}
                />
              </SettingRow>

              <SettingRow
                title="DSD playback strategy"
                description={supportsDop
                  ? 'DoP sends DSD untouched inside 24-bit PCM frames. Use Convert to PCM if the DAC plays noise or clicks with DSD.'
                  : 'No DoP carrier was detected on this device — DSD is always converted to PCM.'}
                stacked
              >
                <Segmented
                  value={supportsDop ? draft.dsdStrategy ?? 'dop' : 'pcm'}
                  onChange={(dsdStrategy) => update({ dsdStrategy })}
                  options={[
                    { id: 'dop', label: 'DSD over PCM (DoP)', disabled: !supportsDop },
                    { id: 'pcm', label: 'Convert to PCM', disabled: !supportsDop },
                  ]}
                />
              </SettingRow>

              <SettingRow
                title="Resync delay"
                description="Silence played after the output opens or changes sample rate, so S/PDIF, AES or I²S DACs can lock on without cutting off the start of a track."
              >
                <Select
                  label="Resync delay"
                  value={String(draft.resyncDelayMs ?? 0)}
                  onChange={(value) => update({ resyncDelayMs: Number(value) || undefined })}
                  options={RESYNC_DELAY_OPTIONS_MS.map((ms) => ({ value: String(ms), label: ms === 0 ? 'None' : `${ms} ms` }))}
                />
              </SettingRow>
            </>
          ) : (
            <>
              <SettingRow
                title="Max sample rate (PCM)"
                description="Higher-rate content is converted down to the best rate at or below this limit."
              >
                <Select
                  label="Max sample rate"
                  value={String(draft.maxSampleRate ?? '')}
                  onChange={(value) => update({ maxSampleRate: Number(value) || undefined })}
                  options={[
                    { value: '', label: 'No limit' },
                    ...sampleRates.map((rate) => ({ value: String(rate), label: formatRate(rate) })),
                  ]}
                />
              </SettingRow>

              <SettingRow
                title="Max bits per sample (PCM)"
                description="Use when a DAC or digital link over-reports its bit depth."
              >
                <Select
                  label="Max bits per sample"
                  value={String(draft.maxBitDepth ?? '')}
                  onChange={(value) => update({ maxBitDepth: Number(value) || undefined })}
                  options={[
                    { value: '', label: 'No limit' },
                    ...bitDepths.map((depth) => ({ value: String(depth), label: `${depth} bit` })),
                  ]}
                />
              </SettingRow>

              <SettingRow
                title="Max DSD sample rate"
                description={supportsDop
                  ? `Device reports DoP up to ${dsdRateLabel(dopCapability)}. Higher DSD rates are converted to PCM.`
                  : 'DoP is not available on this device.'}
              >
                <Select
                  label="Max DSD sample rate"
                  disabled={!supportsDop || draft.dsdStrategy === 'pcm'}
                  value={draft.maxDsdRate ?? ''}
                  onChange={(value) => update({ maxDsdRate: (value || undefined) as DsdRateLimit | undefined })}
                  options={[
                    { value: '', label: supportsDop ? 'No limit' : 'PCM only' },
                    ...dsdRateLimitsFor(dopCapability).map((rate) => ({ value: rate, label: dsdRateLabel(rate) })),
                  ]}
                />
              </SettingRow>

              <SettingRow
                title="Use max hardware buffer size"
                description="Exclusive mode only. Largest IO buffer the device allows — can cure dropouts and clicks at the cost of latency."
              >
                <Switch
                  label="Use max hardware buffer size"
                  checked={!!draft.maxHardwareBuffer}
                  disabled={sharedOnly}
                  onChange={(maxHardwareBuffer) => update({ maxHardwareBuffer })}
                />
              </SettingRow>

              <SettingRow
                title="Use power-of-2 hardware buffer size"
                description="Exclusive mode only. Works around drivers that misbehave with other buffer sizes."
              >
                <Switch
                  label="Use power-of-2 hardware buffer size"
                  checked={!!draft.powerOfTwoBuffer}
                  disabled={sharedOnly}
                  onChange={(powerOfTwoBuffer) => update({ powerOfTwoBuffer })}
                />
              </SettingRow>

              <SettingRow
                title="Set max volume at playback start"
                description={hardwareVolume
                  ? 'With DSP or Fixed volume, sets the DAC’s own volume control to 100% whenever the output opens.'
                  : 'This device has no hardware volume control.'}
              >
                <Switch
                  label="Set max volume at playback start"
                  checked={!!draft.maxVolumeAtStart}
                  disabled={!hardwareVolume}
                  onChange={(maxVolumeAtStart) => update({ maxVolumeAtStart })}
                />
              </SettingRow>

              <div className="py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Device information</p>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-zinc-500">Name</dt>
                  <dd className="text-zinc-300 truncate">{device.name}</dd>
                  <dt className="text-zinc-500">Connection</dt>
                  <dd className="text-zinc-300">{transportDisplayName(device.transportType)}</dd>
                  <dt className="text-zinc-500">Channels</dt>
                  <dd className="text-zinc-300">{device.channels}</dd>
                  <dt className="text-zinc-500">Sample rates</dt>
                  <dd className="text-zinc-300">{sampleRates.length ? sampleRates.map(formatRate).join(', ') : '—'}</dd>
                  <dt className="text-zinc-500">Bit depths</dt>
                  <dd className="text-zinc-300">{bitDepths.length ? bitDepths.map((depth) => `${depth}`).join(', ') + ' bit' : '—'}</dd>
                  <dt className="text-zinc-500">DSD</dt>
                  <dd className="text-zinc-300">{supportsDop ? `DoP up to ${dsdRateLabel(dopCapability)}` : 'PCM only'}</dd>
                  <dt className="text-zinc-500">Hardware volume</dt>
                  <dd className="text-zinc-300">{hardwareVolume ? 'Yes' : 'No'}</dd>
                  <dt className="text-zinc-500">Status</dt>
                  <dd className="text-zinc-300">{isActive ? `Active (${audioMode})` : 'Idle'}</dd>
                  <dt className="text-zinc-500">UID</dt>
                  <dd className="text-zinc-400 font-mono break-all select-text">{device.uid}</dd>
                </dl>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-white/10 shrink-0">
          <Button variant="ghost" size="sm" label="Restore Defaults" onClick={restoreDefaults} />
          <div className="flex items-center gap-2">
            {error && <p className="text-xs text-red-400">{error}</p>}
            <Button variant="ghost" size="sm" label="Cancel" onClick={onClose} />
            <Button
              variant="primary"
              size="sm"
              label={saving ? 'Saving…' : 'Save Settings'}
              onClick={() => { void save() }}
              disabled={saving}
            />
          </div>
        </div>
      </GlassPanel>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Device list
// ---------------------------------------------------------------------------

function DeviceRow({
  device,
  onConfigure,
}: {
  device: AudioDevice
  onConfigure: (device: AudioDevice) => void
}) {
  const setup = useAudioSetupStore((s) => s.setup)
  const setDeviceEnabled = useAudioSetupStore((s) => s.setDeviceEnabled)
  const audioDevice = usePlayerStore((s) => s.audioDevice)
  const audioMode = usePlayerStore((s) => s.audioMode)
  const enabled = isDeviceEnabled(setup, device.uid)
  const displayName = deviceDisplayName(setup, device)
  const isActive = audioDevice === device.uid
  const config = getDeviceConfig(setup, device.uid)
  const configured = Object.keys(editableDeviceConfig(config)).some((key) => key !== 'enabled')

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${enabled ? 'hover:bg-white/[0.03]' : 'opacity-60'}`}>
      <div className={`p-1.5 rounded-md ${enabled ? 'bg-white/5 text-zinc-300' : 'bg-white/[0.02] text-zinc-600'}`}>
        <GroupIcon group={deviceGroupForTransport(device.transportType)} className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className={`text-sm truncate ${enabled ? 'text-zinc-100' : 'text-zinc-400'}`}>{displayName}</p>
          {isActive && (
            <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded-full bg-green-950 text-green-400 shrink-0">
              {audioMode === 'exclusive' ? 'Active · Exclusive' : 'Active'}
            </span>
          )}
          {configured && (
            <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded-full bg-white/5 text-zinc-400 shrink-0">
              Custom
            </span>
          )}
        </div>
        <p className="text-[11px] text-zinc-500 truncate">
          {displayName !== device.name ? `${device.name} · ` : ''}
          {device.channels} ch · {formatCapsSummary(device)}
          {device.dopCapability && device.dopCapability !== 'FallbackPCM' ? ` · ${dsdRateLabel(device.dopCapability)} DoP` : ''}
          {device.hardwareVolume ? ' · HW volume' : ''}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon={Settings2}
        iconOnly
        label="Device Setup"
        onClick={() => onConfigure(device)}
        title="Device Setup"
        aria-label={`Configure ${displayName}`}
      />
      <Switch
        label={`${enabled ? 'Disable' : 'Enable'} ${displayName}`}
        checked={enabled}
        onChange={(value) => { void setDeviceEnabled(device, value) }}
      />
    </div>
  )
}

function GlobalResamplingSection() {
  const saved = useAudioSetupStore((s) => s.setup.resampling)
  const setGlobalResampling = useAudioSetupStore((s) => s.setGlobalResampling)
  const strictSampleRate = useSettingsStore((s) => s.strictSampleRate)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const [draft, setDraft] = useState<ResamplingSettings>(saved)
  const [dirtySinceApply, setDirtySinceApply] = useState(false)
  const [applying, setApplying] = useState(false)
  const saveTimer = useRef<number | null>(null)

  useEffect(() => { setDraft(saved) }, [saved])
  useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current) }, [])

  // Sliders fire continuously; persist once they settle.
  const change = (next: ResamplingSettings) => {
    setDraft(next)
    setDirtySinceApply(true)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void setGlobalResampling(next)
    }, GLOBAL_RESAMPLING_SAVE_DELAY_MS)
  }

  const applyNow = async () => {
    setApplying(true)
    try {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
        await setGlobalResampling(draft)
      }
      await audioService.reapplyOutput()
      setDirtySinceApply(false)
    } finally {
      setApplying(false)
    }
  }

  return (
    <section className="pt-2">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-1">Resampling &amp; DSD</h3>
          <p className="text-xs text-zinc-600 max-w-lg">
            Global settings for every output; any device can override them in Device Setup → Resampling.
            Changes apply from the next track{currentTrack ? ', or apply them now' : ''}.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="xs" label="Restore Defaults" onClick={() => change({ ...DEFAULT_RESAMPLING })} />
          {currentTrack && (
            <Button
              variant="primary"
              size="xs"
              label={applying ? 'Applying…' : 'Apply now'}
              disabled={applying || !dirtySinceApply}
              onClick={() => { void applyNow() }}
            />
          )}
        </div>
      </div>
      <ResamplingSettingsPanel value={draft} onChange={change} strictSampleRate={strictSampleRate} />
    </section>
  )
}

export default function AudioSetupSettings() {
  const setup = useAudioSetupStore((s) => s.setup)
  const loaded = useAudioSetupStore((s) => s.loaded)
  const setAutoEnableNewDevices = useAudioSetupStore((s) => s.setAutoEnableNewDevices)
  const setDeviceEnabled = useAudioSetupStore((s) => s.setDeviceEnabled)
  const forgetDevice = useAudioSetupStore((s) => s.forgetDevice)
  const audioDevice = usePlayerStore((s) => s.audioDevice)
  const resolvedDeviceName = usePlayerStore((s) => s.resolvedDeviceName)

  const [devices, setDevices] = useState<AudioDevice[] | null>(null)
  const [configuring, setConfiguring] = useState<AudioDevice | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      setDevices(await window.puros.audio.listDevices())
    } catch {
      setDevices([])
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void useAudioSetupStore.getState().ensureLoaded()
    void refresh()
    const id = window.setInterval(() => {
      if (isWindowHidden()) return
      void window.puros.audio.listDevices().then(setDevices).catch(() => undefined)
    }, DEVICE_POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  const physicalDevices = useMemo(() => (devices ?? []).filter((device) => !device.isVirtual), [devices])
  const systemDefault = devices?.find((device) => device.isVirtual) ?? null
  const groups = useMemo(() => groupDevicesByType(physicalDevices), [physicalDevices])
  const disconnected = useMemo(() => {
    const connected = new Set(physicalDevices.map((device) => device.uid))
    return Object.entries(setup.devices)
      .filter(([uid]) => !connected.has(uid))
      .map(([uid, config]) => ({ uid, config }))
      .sort((a, b) => (b.config.lastSeenAt ?? 0) - (a.config.lastSeenAt ?? 0))
  }, [physicalDevices, setup.devices])
  const enabledCount = physicalDevices.filter((device) => isDeviceEnabled(setup, device.uid)).length

  // Keep the dialog on fresh device data while it is open (format lists can change on reconnect).
  const configuringDevice = configuring
    ? physicalDevices.find((device) => device.uid === configuring.uid) ?? configuring
    : null

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-1">Audio Setup</h3>
            <p className="text-xs text-zinc-600 max-w-lg">
              Choose which outputs Puros may use and configure each one. Disabled outputs are hidden from the output
              menu. Open <span className="text-zinc-400">Device Setup</span> for exclusive mode, volume control, DSD and
              resolution limits.
            </p>
          </div>
          <Button
            variant="secondary"
            size="xs"
            icon={RefreshCw}
            label="Refresh"
            onClick={() => { void refresh() }}
            className={`shrink-0 ${refreshing ? '[&_svg]:animate-spin' : ''}`}
          />
        </div>

        <label className="mt-4 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 cursor-pointer">
          <span>
            <span className="block text-sm text-zinc-200">Enable new devices automatically</span>
            <span className="block text-xs text-zinc-500 mt-0.5">
              When off, outputs Puros has not seen before start disabled until you enable them here.
            </span>
          </span>
          <Switch
            label="Enable new devices automatically"
            checked={setup.autoEnableNewDevices}
            disabled={!loaded}
            onChange={(value) => { void setAutoEnableNewDevices(value, physicalDevices) }}
          />
        </label>
      </div>

      {/* System default */}
      {systemDefault && (
        <section>
          <h4 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-1 px-3">System</h4>
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl">
            <div className="p-1.5 rounded-md bg-white/5 text-zinc-300">
              <Volume2 className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm text-zinc-100 truncate">{systemDefault.name}</p>
                {audioDevice === systemDefault.uid && (
                  <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded-full bg-green-950 text-green-400 shrink-0">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-500 truncate">
                Follows the macOS output · shared mode
                {(resolvedDeviceName || systemDefault.resolvedName) ? ` · ${resolvedDeviceName || systemDefault.resolvedName}` : ''}
              </p>
            </div>
            <span className="text-[11px] text-zinc-500 shrink-0">Always available</span>
          </div>
        </section>
      )}

      {devices === null ? (
        <p className="text-xs text-zinc-500 px-3">Looking for audio devices…</p>
      ) : physicalDevices.length === 0 ? (
        <p className="text-xs text-zinc-500 px-3">No audio output devices found.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-[11px] text-zinc-500 px-3 pb-1 border-b border-white/5">
            Connected to this Mac · {enabledCount} of {physicalDevices.length} enabled
          </p>
          {groups.map((group) => (
            <section key={group.id}>
              <h4 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-1 px-3">
                {group.label}
              </h4>
              <div className="space-y-0.5">
                {group.devices.map((device) => (
                  <DeviceRow key={device.uid} device={device} onConfigure={setConfiguring} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {disconnected.length > 0 && (
        <section>
          <h4 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-1 px-3">Not connected</h4>
          <div className="space-y-0.5">
            {disconnected.map(({ uid, config }) => {
              const name = config.displayName || config.lastSeenName || uid
              const enabled = isDeviceEnabled(setup, uid)
              return (
                <div key={uid} className="flex items-center gap-3 px-3 py-2.5 rounded-xl opacity-70">
                  <div className="p-1.5 rounded-md bg-white/[0.02] text-zinc-500">
                    <GroupIcon group={deviceGroupForTransport(config.lastSeenTransport)} className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-300 truncate">{name}</p>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {transportDisplayName(config.lastSeenTransport)} · {formatLastSeen(config.lastSeenAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    label="Forget"
                    onClick={() => { void forgetDevice(uid) }}
                    title="Remove this device's settings"
                  />
                  <Switch
                    label={`${enabled ? 'Disable' : 'Enable'} ${name}`}
                    checked={enabled}
                    onChange={(value) => {
                      void setDeviceEnabled({ uid, name, transportType: config.lastSeenTransport ?? 0 }, value, { connected: false })
                    }}
                  />
                </div>
              )
            })}
          </div>
        </section>
      )}

      <GlobalResamplingSection />

      {configuringDevice && (
        <DeviceSetupDialog
          key={configuringDevice.uid}
          device={configuringDevice}
          onClose={() => setConfiguring(null)}
        />
      )}
    </div>
  )
}
