/**
 * Resampling, bit depth / dither and DSD → PCM settings (PowerAmp / HQPlayer-style).
 * Controlled: used for the global Audio Setup settings and for per-device overrides.
 */

import { useEffect, useState, type ReactNode } from 'react'
import {
  APPLE_COMPLEXITY_LABELS,
  APPLE_QUALITY_LABELS,
  DITHER_OPTIONS,
  DSD_MODULATORS,
  FIR_LENGTHS,
  FIR_WINDOWS,
  FIXED_RATE_OPTIONS,
  HEADROOM_OPTIONS,
  MAX_OUTPUT_RATE_OPTIONS,
  PHASE_PRESETS,
  SOXR_PRESETS,
  formatMaxRate,
  pickFilter,
  type AppleComplexity,
  type AppleQuality,
  type DitherSetting,
  type DsdModulatorSetting,
  type DsdOutputSetting,
  type FirFilterSettings,
  type FirLengthSetting,
  type FirWindowSetting,
  type ImpulseResponseInspection,
  type MaxOutputRateSetting,
  type ResamplingSettings,
  type SoxrFilterSettings,
  type SoxrPreset,
  type TargetRatePolicy,
  type UpsamplingMode,
} from '../../services/resamplingSettings'
import { Segmented, Select, SettingRow, Slider, Switch } from './controls'
import FirPreviewChart from './FirPreviewChart'

function formatRate(rate: number): string {
  return `${Number((rate / 1000).toFixed(1))} kHz`
}

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 bg-zinc-800/30 px-4 py-1">
      <div className="pt-3 pb-1">
        <h5 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</h5>
        {description && <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** One SoX filter: preset, custom design parameters, phase, steepness, aliasing. */
function FilterEditor({
  value,
  onChange,
  title,
}: {
  value: SoxrFilterSettings
  onChange: (next: SoxrFilterSettings) => void
  title: string
}) {
  const update = (patch: Partial<SoxrFilterSettings>) => onChange({ ...value, ...patch })
  const preset = SOXR_PRESETS.find((entry) => entry.id === value.soxrPreset)
  const custom = value.soxrPreset === 'custom'
  const apodizing = value.soxrPreset === 'apodizing'
  const phasePreset = PHASE_PRESETS.find((entry) => entry.value === value.phaseResponse)

  return (
    <>
      <SettingRow title={title} description={preset?.description} stacked>
        <Segmented<SoxrPreset>
          value={value.soxrPreset}
          onChange={(soxrPreset) => update({ soxrPreset })}
          options={SOXR_PRESETS.map((entry) => ({ id: entry.id, label: entry.label }))}
        />
      </SettingRow>

      {custom && (
        <>
          <SettingRow title="Precision" description="Bit precision of the filter. 20 bits is transparent for 16-bit audio, 28+ for 24-bit." stacked>
            <Slider
              label="Precision"
              min={16}
              max={32}
              step={1}
              value={value.soxrPrecision}
              onChange={(soxrPrecision) => update({ soxrPrecision })}
              format={(bits) => `${bits} bit`}
            />
          </SettingRow>
          <SettingRow title="Pass-band (cutoff)" description="Frequency up to which the response stays flat, as % of the lower Nyquist. Higher keeps more treble but needs a steeper filter." stacked>
            <Slider
              label="Pass-band"
              min={80}
              max={99.5}
              step={0.1}
              value={value.passbandPercent}
              onChange={(passbandPercent) => update({
                passbandPercent,
                stopbandPercent: Math.max(value.stopbandPercent, passbandPercent + 0.5),
              })}
              format={(percent) => `${percent.toFixed(1)}%`}
            />
          </SettingRow>
          <SettingRow title="Stop-band" description="Where full attenuation begins. 100% blocks all aliasing at Nyquist (apodizing when upsampling)." stacked>
            <Slider
              label="Stop-band"
              min={100}
              max={150}
              step={0.5}
              value={value.stopbandPercent}
              disabled={value.allowAliasing}
              onChange={(stopbandPercent) => update({ stopbandPercent })}
              format={(percent) => `${percent.toFixed(1)}%`}
            />
          </SettingRow>
        </>
      )}

      {value.soxrPreset !== 'quick' && (
        <>
          <SettingRow
            title="Phase response"
            description="Linear phase has no phase distortion but pre-ringing; minimum phase moves all ringing after the transient."
            stacked
          >
            <div className="space-y-2">
              <Segmented
                value={phasePreset ? String(phasePreset.value) : 'custom'}
                onChange={(phase) => { if (phase !== 'custom') update({ phaseResponse: Number(phase) }) }}
                options={[
                  ...PHASE_PRESETS.map((entry) => ({ id: String(entry.value), label: entry.label })),
                  { id: 'custom', label: 'Custom', disabled: true },
                ]}
              />
              <Slider
                label="Phase response"
                min={0}
                max={100}
                step={1}
                value={value.phaseResponse}
                onChange={(phaseResponse) => update({ phaseResponse })}
                format={(phase) => String(phase)}
              />
            </div>
          </SettingRow>
          <SettingRow title="Steep filter" description="Narrower transition band: flatter top octave, longer ringing.">
            <Switch label="Steep filter" checked={value.steepFilter} onChange={(steepFilter) => update({ steepFilter })} />
          </SettingRow>
          <SettingRow
            title="Allow aliasing"
            description={apodizing
              ? 'Not available with the apodizing filter, which must reach full attenuation at Nyquist.'
              : 'Lets the transition band straddle Nyquist (SoX rate -a): extends the pass-band at the cost of some aliasing above it.'}
          >
            <Switch
              label="Allow aliasing"
              checked={value.allowAliasing && !apodizing}
              disabled={apodizing}
              onChange={(allowAliasing) => update({ allowAliasing })}
            />
          </SettingRow>
        </>
      )}
    </>
  )
}

const PREVIEW_RATIOS = [2, 4, 8, 16] as const

/** Long-FIR design (engine "fir"), with a live preview of its responses. */
function FirEditor({
  value,
  onChange,
  title,
  sourceRate,
  defaultRatio,
}: {
  value: FirFilterSettings
  onChange: (next: FirFilterSettings) => void
  title: string
  sourceRate: number
  defaultRatio: number
}) {
  const update = (patch: Partial<FirFilterSettings>) => onChange({ ...value, ...patch })
  const [ratio, setRatio] = useState<number>(defaultRatio)
  useEffect(() => { setRatio(defaultRatio) }, [defaultRatio])
  const windowOption = FIR_WINDOWS.find((entry) => entry.id === value.window)
  const lengthOption = FIR_LENGTHS.find((entry) => entry.id === value.length)

  return (
    <>
      <SettingRow title={title} description={windowOption?.description} stacked>
        <Segmented<FirWindowSetting>
          value={value.window}
          onChange={(next) => update({ window: next })}
          options={FIR_WINDOWS.map((entry) => ({ id: entry.id, label: entry.label }))}
        />
      </SettingRow>
      <SettingRow title="Length" description={lengthOption?.description} stacked>
        <Segmented<FirLengthSetting>
          value={value.length}
          onChange={(next) => update({ length: next })}
          options={FIR_LENGTHS.map((entry) => ({ id: entry.id, label: entry.label }))}
        />
      </SettingRow>
      <SettingRow
        title="Phase"
        description={value.phase === 'minimum'
          ? 'All ringing after the transient (no pre-ringing); slight phase shift near the top of the band. Capped at ~512k taps.'
          : 'Symmetric impulse: no phase distortion, ringing split before and after the transient.'}
        stacked
      >
        <Segmented
          value={value.phase}
          onChange={(phase) => update({ phase })}
          options={[{ id: 'linear', label: 'Linear' }, { id: 'minimum', label: 'Minimum' }]}
        />
      </SettingRow>
      <SettingRow
        title="Apodizing"
        description="Reach full attenuation at the lower Nyquist, so the recording's own filter ringing (≈20–22 kHz at 44.1 kHz) is removed. Off: −6 dB at the cutoff below."
      >
        <Switch label="Apodizing" checked={value.apodizing} onChange={(apodizing) => update({ apodizing })} />
      </SettingRow>
      {!value.apodizing && (
        <SettingRow title="Cutoff (−6 dB)" description="As % of the lower Nyquist. Above 100% lets some imaging/aliasing through." stacked>
          <Slider
            label="Cutoff"
            min={80}
            max={110}
            step={0.5}
            value={value.cutoffPercent}
            onChange={(cutoffPercent) => update({ cutoffPercent })}
            format={(percent) => `${percent.toFixed(1)}%`}
          />
        </SettingRow>
      )}
      {value.window === 'kaiser' && (
        <SettingRow title="Stopband attenuation" description="Kaiser window depth. 144 dB covers 24-bit; more only matters for float output." stacked>
          <Slider
            label="Stopband attenuation"
            min={80}
            max={200}
            step={2}
            value={value.attenuationDb}
            onChange={(attenuationDb) => update({ attenuationDb })}
            format={(db) => `−${db} dB`}
          />
        </SettingRow>
      )}
      <div className="py-3 border-b border-white/5 last:border-b-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-zinc-200">Preview</p>
          <Select
            label="Preview conversion"
            value={String(ratio)}
            onChange={(next) => setRatio(Number(next))}
            options={PREVIEW_RATIOS.map((r) => ({
              value: String(r),
              label: `${Number((sourceRate / 1000).toFixed(1))} → ${Number((sourceRate * r / 1000).toFixed(1))} kHz (×${r})`,
            }))}
          />
        </div>
        <FirPreviewChart design={value} inputRate={sourceRate} outputRate={sourceRate * ratio} />
      </div>
    </>
  )
}

/** Room-correction filter file, its details, gain and delay compensation. */
function ConvolutionEditor({
  value,
  onChange,
}: {
  value: ResamplingSettings['convolution']
  onChange: (next: ResamplingSettings['convolution']) => void
}) {
  const [info, setInfo] = useState<ImpulseResponseInspection | null>(null)
  useEffect(() => {
    setInfo(null)
    if (!value.path) return
    let cancelled = false
    void window.puros.audio.inspectImpulseResponse(value.path)
      .then((result) => { if (!cancelled) setInfo(result) })
      .catch((err: unknown) => { if (!cancelled) setInfo({ success: false, error: err instanceof Error ? err.message : String(err) }) })
    return () => { cancelled = true }
  }, [value.path])

  const choose = async () => {
    const path = await window.puros.audio.pickImpulseResponse()
    if (path) onChange({ ...value, path })
  }
  const fileName = value.path ? value.path.split('/').pop() : null

  return (
    <>
      <SettingRow
        title="Filter file"
        description={value.path
          ? info?.success
            ? `${info.channels === 1 ? 'Mono (both channels)' : info.channels === 2 ? 'Stereo (L / R)' : `${info.channels} channels (first two used)`} · ${Number((info.sampleRate / 1000).toFixed(1))} kHz · ${info.taps.toLocaleString()} taps · peak ${info.peakDb.toFixed(1)} dBFS at ${(info.peakIndex / info.sampleRate * 1000).toFixed(1)} ms`
            : info ? `Cannot read this file: ${info.error}` : 'Reading…'
          : 'A FIR impulse response from REW, Dirac, Acourate, rePhase… (WAV / AIFF / FLAC). Resampled to the output rate automatically.'}
        stacked
      >
        <div className="flex items-center gap-2 min-w-0">
          {fileName && <span className="text-xs text-zinc-300 truncate" title={value.path ?? undefined}>{fileName}</span>}
          <button
            type="button"
            onClick={() => { void choose() }}
            className="shrink-0 px-2.5 py-1 text-xs rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            {value.path ? 'Change…' : 'Choose…'}
          </button>
          {value.path && (
            <button
              type="button"
              onClick={() => onChange({ ...value, path: null })}
              className="shrink-0 px-2.5 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      </SettingRow>
      {value.path && (
        <>
          <SettingRow title="Filter gain" description="Most correction filters boost some frequencies; lower the gain (or raise headroom) if Signal Path reports clipping." stacked>
            <Slider
              label="Filter gain"
              min={-30}
              max={12}
              step={0.5}
              value={value.gainDb}
              onChange={(gainDb) => onChange({ ...value, gainDb })}
              format={(db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`}
            />
          </SettingRow>
          <SettingRow title="Compensate filter delay" description="Skip the samples before the filter's main peak, so the position, lyrics and the visualizer stay in sync.">
            <Switch
              label="Compensate filter delay"
              checked={value.compensateDelay}
              onChange={(compensateDelay) => onChange({ ...value, compensateDelay })}
            />
          </SettingRow>
        </>
      )}
    </>
  )
}

export default function ResamplingSettingsPanel({
  value,
  onChange,
  strictSampleRate = false,
}: {
  value: ResamplingSettings
  onChange: (next: ResamplingSettings) => void
  /** "Never resample in exclusive mode" is on: upsampling / fixed rate are ignored there. */
  strictSampleRate?: boolean
}) {
  const update = (patch: Partial<ResamplingSettings>) => onChange({ ...value, ...patch })
  const dither = DITHER_OPTIONS.find((option) => option.id === value.dither)
  const previewRatio = value.upsampling === '2x' ? 2 : value.upsampling === '8x' ? 8 : 4

  return (
    <div className="space-y-3">
      <Group
        title="Resampler"
        description="Used only when the output cannot play the source rate (or a rate policy below asks for another rate). Bit-perfect playback never goes through it."
      >
        <SettingRow title="Engine" stacked>
          <Segmented
            value={value.engine}
            onChange={(engine) => update({ engine })}
            options={[
              { id: 'soxr', label: 'SoX (libsoxr)' },
              { id: 'fir', label: 'FIR (integer ratios)' },
              { id: 'apple', label: 'Apple CoreAudio' },
            ]}
          />
        </SettingRow>

        {value.engine === 'fir' && (
          <>
            <FirEditor
              title={value.firNx ? 'FIR window — 44.1 / 48 kHz sources (1x)' : 'FIR window'}
              value={value.fir}
              onChange={(fir) => update({ fir })}
              sourceRate={44100}
              defaultRatio={previewRatio}
            />
            <SettingRow
              title="Separate FIR for hi-res sources"
              description="A different design for 88.2 kHz and higher — e.g. long apodizing for CD rips, short minimum phase for hi-res."
            >
              <Switch
                label="Separate FIR for hi-res sources"
                checked={!!value.firNx}
                onChange={(separate) => update({ firNx: separate ? { ...value.fir } : null })}
              />
            </SettingRow>
            {value.firNx && (
              <FirEditor
                title="FIR window — hi-res sources (Nx)"
                value={value.firNx}
                onChange={(firNx) => update({ firNx })}
                sourceRate={96000}
                defaultRatio={2}
              />
            )}
            <p className="pt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Non-integer ratios (44.1 ↔ 48 kHz families) use SoX:
            </p>
          </>
        )}

        {value.engine !== 'apple' ? (
          <>
            <FilterEditor
              title={value.nxFilter ? 'Filter for 44.1 / 48 kHz sources (1x)' : 'Filter'}
              value={pickFilter(value)}
              onChange={(filter) => update(filter)}
            />
            <SettingRow
              title="Separate filter for hi-res sources"
              description="Use a different filter for 88.2 kHz and higher (Nx) sources — e.g. apodizing for CD rips, a short minimum-phase filter for hi-res."
            >
              <Switch
                label="Separate filter for hi-res sources"
                checked={!!value.nxFilter}
                onChange={(separate) => update({ nxFilter: separate ? pickFilter(value) : null })}
              />
            </SettingRow>
            {value.nxFilter && (
              <FilterEditor
                title="Filter for hi-res sources (Nx)"
                value={value.nxFilter}
                onChange={(nxFilter) => update({ nxFilter })}
              />
            )}
          </>
        ) : (
          <>
            <SettingRow title="Complexity" description="Mastering uses the longest, highest-quality filter." stacked>
              <Segmented<AppleComplexity>
                value={value.appleComplexity}
                onChange={(appleComplexity) => update({ appleComplexity })}
                options={(Object.keys(APPLE_COMPLEXITY_LABELS) as AppleComplexity[]).map((id) => ({ id, label: APPLE_COMPLEXITY_LABELS[id] }))}
              />
            </SettingRow>
            <SettingRow title="Quality" stacked>
              <Segmented<AppleQuality>
                value={value.appleQuality}
                onChange={(appleQuality) => update({ appleQuality })}
                options={(Object.keys(APPLE_QUALITY_LABELS) as AppleQuality[]).map((id) => ({ id, label: APPLE_QUALITY_LABELS[id] }))}
              />
            </SettingRow>
          </>
        )}
      </Group>

      <Group
        title="Output sample rate"
        description={strictSampleRate
          ? '“Never resample in exclusive mode” is on (Playback tab): in exclusive mode upsampling and a fixed rate are ignored.'
          : undefined}
      >
        <SettingRow title="When the source rate is not supported" stacked>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<TargetRatePolicy>
              value={value.targetRate}
              onChange={(targetRate) => update({ targetRate })}
              options={[
                { id: 'family-max', label: 'Highest in family' },
                { id: 'lowest-above', label: 'Lowest ≥ source' },
                { id: 'fixed', label: 'Fixed rate' },
              ]}
            />
            {value.targetRate === 'fixed' && (
              <Select
                label="Fixed output rate"
                value={String(value.fixedSampleRate)}
                onChange={(rate) => update({ fixedSampleRate: Number(rate) })}
                options={FIXED_RATE_OPTIONS.map((rate) => ({ value: String(rate), label: formatRate(rate) }))}
              />
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-2 leading-relaxed">
            {value.targetRate === 'family-max'
              ? '44.1 kHz material goes to 88.2/176.4 kHz, 48 kHz material to 96/192 kHz — whole-number ratios where possible.'
              : value.targetRate === 'lowest-above'
                ? 'The smallest supported rate at or above the source — least processing.'
                : 'Every track plays at this rate, even when the source rate is supported. Falls back to the rules above if the output lacks it.'}
          </p>
        </SettingRow>
        <SettingRow
          title="Upsampling"
          description={value.upsampling === '2x' || value.upsampling === '4x' || value.upsampling === '8x'
            ? `Up to ${value.upsampling.replace('x', '×')} the source rate in its own family (44.1 → ${formatRate(44100 * Number.parseInt(value.upsampling, 10))}, 48 → ${formatRate(48000 * Number.parseInt(value.upsampling, 10))}), or the largest whole multiple the output supports.`
            : 'Resample even when the source rate is supported.'}
          stacked
        >
          <Segmented<UpsamplingMode>
            value={value.upsampling}
            onChange={(upsampling) => update({ upsampling })}
            options={[
              { id: 'off', label: 'Off (bit-perfect)' },
              { id: '2x', label: '2×' },
              { id: '4x', label: '4×' },
              { id: '8x', label: '8×' },
              { id: 'family-max', label: 'Max in family' },
              { id: 'device-max', label: 'Device max' },
            ]}
          />
        </SettingRow>
        <SettingRow title="Maximum output rate" description="Upper limit for upsampling — useful for DACs that sound or lock better at lower rates.">
          <Select
            label="Maximum output rate"
            value={String(value.maxOutputRate)}
            onChange={(rate) => update({ maxOutputRate: Number(rate) as MaxOutputRateSetting })}
            options={MAX_OUTPUT_RATE_OPTIONS.map((rate) => ({ value: String(rate), label: formatMaxRate(rate) }))}
          />
        </SettingRow>
      </Group>

      <Group title="Level, bit depth & dither">
        <SettingRow
          title="Headroom"
          description="Attenuation whenever Puros processes the signal (resampling, requantization, de-emphasis), so inter-sample peaks rebuilt by the filter don't clip. Bit-perfect playback is never attenuated. Signal Path shows the peak and any clipped samples."
        >
          <Select
            label="Headroom"
            value={String(value.headroomDb)}
            onChange={(db) => update({ headroomDb: Number(db) as ResamplingSettings['headroomDb'] })}
            options={HEADROOM_OPTIONS.map((db) => ({ value: String(db), label: db === 0 ? 'None' : `−${db} dB` }))}
          />
        </SettingRow>
        <SettingRow title="Output bit depth" description="Auto uses the source depth when the output supports it, else the nearest higher one." stacked>
          <Segmented
            value={String(value.outputBitDepth)}
            onChange={(depth) => update({ outputBitDepth: depth === 'auto' ? 'auto' : Number(depth) as 16 | 24 | 32 })}
            options={[
              { id: 'auto', label: 'Auto' },
              { id: '16', label: '16 bit' },
              { id: '24', label: '24 bit' },
              { id: '32', label: '32 bit' },
            ]}
          />
        </SettingRow>
        <SettingRow
          title="Dither & noise shaping"
          description={`${dither?.description ?? ''} Applied when samples are requantized to 24 bits or fewer; shaping curves are chosen for the output rate.`}
          stacked
        >
          <Segmented<DitherSetting>
            value={value.dither}
            onChange={(next) => update({ dither: next })}
            options={DITHER_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
          />
        </SettingRow>
      </Group>

      <Group
        title="Room correction"
        description="Convolve the output with a FIR correction filter for your room or headphones. Runs in 64-bit after resampling, at the output rate; playback with a filter is never bit-perfect."
      >
        <ConvolutionEditor value={value.convolution} onChange={(convolution) => update({ convolution })} />
      </Group>

      <Group title="De-emphasis">
        <SettingRow
          title="Undo CD pre-emphasis"
          description="Some early CDs were mastered with 50/15 µs pre-emphasis and sound harsh without the matching de-emphasis. Auto applies it when the CUE sheet has FLAGS PRE or the file is tagged PRE_EMPHASIS / EMPHASIS."
        >
          <Segmented
            value={value.deemphasis}
            onChange={(deemphasis) => update({ deemphasis })}
            options={[
              { id: 'auto', label: 'Auto' },
              { id: 'off', label: 'Off' },
            ]}
          />
        </SettingRow>
      </Group>

      <Group
        title="DSD output (PCM → DSD)"
        description="Upsample everything to DSD with a delta-sigma modulator and send it to the DAC as DoP — exclusive mode on DoP-capable outputs only. PCM is first resampled to 352.8 kHz with the resampler above; EQ and room correction run there. At least 3 dB of headroom is kept so loud masters cannot overload the modulator. DSD cannot be attenuated digitally: with DSP volume Puros plays PCM instead, so set the level on the DAC or amplifier."
      >
        <SettingRow title="DSD rate" description="Max picks the highest rate the output's DoP supports (DSD256 needs a 705.6 kHz carrier)." stacked>
          <Segmented
            value={String(value.dsdOutput)}
            onChange={(rate) => update({
              dsdOutput: rate === 'off' || rate === 'max' ? rate : Number(rate) as DsdOutputSetting,
            })}
            options={[
              { id: 'off', label: 'Off (PCM)' },
              { id: '64', label: 'DSD64' },
              { id: '128', label: 'DSD128' },
              { id: '256', label: 'DSD256' },
              { id: 'max', label: 'Max' },
            ]}
          />
        </SettingRow>
        {value.dsdOutput !== 'off' && (
          <>
            <SettingRow
              title="Modulator"
              description={DSD_MODULATORS.find((entry) => entry.id === value.dsdModulator)?.description}
              stacked
            >
              <Segmented<DsdModulatorSetting>
                value={value.dsdModulator}
                onChange={(dsdModulator) => update({ dsdModulator })}
                options={DSD_MODULATORS.map((entry) => ({ id: entry.id, label: entry.label }))}
              />
            </SettingRow>
            <SettingRow
              title="Remodulate DSD sources"
              description="Off: DSD files keep their native rate (bit-perfect DoP). On: they are decoded and remodulated to the rate above, e.g. DSD64 → DSD256."
            >
              <Switch label="Remodulate DSD sources" checked={value.dsdRemodulate} onChange={(dsdRemodulate) => update({ dsdRemodulate })} />
            </SettingRow>
          </>
        )}
      </Group>

      <Group
        title="DSD to PCM"
        description="For outputs without DoP, or when DSD must be converted (DSP volume, “Convert to PCM”)."
      >
        <SettingRow title="PCM sample rate" description="Auto picks the highest of 88.2 / 176.4 / 352.8 kHz the output supports." stacked>
          <Segmented
            value={String(value.dsdPcmRate)}
            onChange={(rate) => update({ dsdPcmRate: rate === 'auto' ? 'auto' : Number(rate) as 88200 | 176400 | 352800 })}
            options={[
              { id: 'auto', label: 'Auto' },
              { id: '88200', label: '88.2 kHz' },
              { id: '176400', label: '176.4 kHz' },
              { id: '352800', label: '352.8 kHz' },
            ]}
          />
        </SettingRow>
        <SettingRow title="Ultrasonic filter" description="Low-pass for the DSD noise shelf above the audio band. Skipped when it would sit at or above the new Nyquist.">
          <Select
            label="Ultrasonic filter"
            value={String(value.dsdFilter)}
            onChange={(filter) => update({ dsdFilter: filter === 'off' ? 'off' : Number(filter) as 20000 | 24000 | 30000 | 50000 })}
            options={[
              { value: 'off', label: 'Off' },
              { value: '20000', label: '20 kHz' },
              { value: '24000', label: '24 kHz' },
              { value: '30000', label: '30 kHz' },
              { value: '50000', label: '50 kHz' },
            ]}
          />
        </SettingRow>
        <SettingRow title="Level compensation" description="DSD reference level sits 6 dB below PCM full scale.">
          <Segmented
            value={String(value.dsdGainDb)}
            onChange={(gain) => update({ dsdGainDb: Number(gain) as 0 | 3 | 6 })}
            options={[
              { id: '0', label: '0 dB' },
              { id: '3', label: '+3 dB' },
              { id: '6', label: '+6 dB' },
            ]}
          />
        </SettingRow>
      </Group>
    </div>
  )
}
