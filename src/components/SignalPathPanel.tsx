import { useEffect, useRef, useState } from 'react'
import { Airplay, Bluetooth, Sparkle, Volume2 } from 'lucide-react'
import { GlassPopover } from './GlassPanel'
import type { AudioDevice, ResamplerStatus, RestoreStatus } from '../../electron/preload'
import { useDSPStore } from '../store/dspStore'
import { useAudioSetupStore } from '../store/audioSetupStore'
import { effectiveResampling } from '../services/audioDeviceConfig'
import {
  DSD_MODULATORS,
  describeDither,
  describeResampler,
  dsdRateName as dsdOutputRateName,
} from '../services/resamplingSettings'
import { usePlayerStore } from '../store/playerStore'
import { useProviderStatusStore } from '../store/providerStatusStore'
import {
  badgeToneClasses,
  formatBadgeClasses,
} from './formatBadgeStyles'
import {
  dsdRateName,
  formatBitDepth,
  formatBitrate,
  formatDisplayBitDepth,
  formatLabel,
  formatSampleRate,
  formatDsdRateMHz,
  isHighQualityLossyFormat,
} from '../services/local/formats'
import { isLiveRadioTrack } from '../services/liveRadio/track'
import { isBluetoothTransport } from '../utils/audioDeviceTransport'
import {
  formatDecibels,
  gainToDecibels,
  isDspVolumeAttenuating,
  userVolumeToGain,
} from '../services/volumeControl'
import { isWindowHidden } from '../services/windowActivity'

type SignalPathTier = 'lossless' | 'enhanced' | 'highQuality' | 'lowQuality' | 'muted'

type SignalPathStage = {
  id: string
  stage: string
  label: string
  detail: string
  tier: SignalPathTier
}

/** Plain-language explanation shown when a stage is clicked. */
const STAGE_INFO: Record<string, string> = {
  source: 'The audio as it comes from the file or the streaming service, before Puros changes anything.',
  decode: 'Unpacks the file into raw samples. Lossless formats come out identical to the original recording.',
  convert: 'This output cannot take DSD natively (or processing needs PCM), so Puros decimates the 1-bit stream to high-resolution 64-bit PCM as it plays, with linear-phase filters that keep the DSD noise out of the audio band.',
  bitdepthIn: 'Before any processing the samples are widened to 64-bit floating point, so every step that follows keeps far more precision than the source has. Nothing is lost.',
  bitdepthOut: 'After processing the 64-bit samples are converted to the format the output takes. Dither turns the final rounding into inaudible noise instead of distortion.',
  dsp: 'The equalizer, crossfeed or plug-ins you enabled change the sound on purpose, so the output is no longer bit-perfect.',
  restore: 'Puros Restore rebuilds a plausible top end above the codec\'s low-pass, smooths coding artifacts and sharpens smeared attacks. It cannot recover what the encoder discarded; its latency is compensated, so timing is unchanged.',
  mixer: 'In shared mode macOS mixes Puros with other apps and may change the sample rate. Exclusive mode skips this step.',
  deemphasis: 'This CD was mastered with pre-emphasis; Puros applies the matching filter so it sounds as intended.',
  resample: 'Changes the sample rate to one the output accepts or the one you chose. Integer ratios such as 44.1 → 88.2 kHz are the cleanest.',
  room: 'Applies your room-correction impulse response to compensate for the room and the speakers.',
  modulator: 'Converts PCM to DSD with a delta-sigma modulator and sends it to the DAC as DoP.',
  level: 'Processing can push peaks past full scale; Puros lowers the level by the headroom shown so nothing clips.',
  volume: 'Where the volume lowers the level: in the DAC, in software (64-bit with dither), or, in shared mode, on Puros\'s stream before the system mixer.',
  output: 'The device that turns the signal into sound, and the exact format it receives.',
}

/** Glyph colours per tier, the same palette as the format badges. */
const TIER_COLOR: Record<SignalPathTier, string> = {
  lossless: '#4ade80',
  enhanced: '#d8b4fe',
  highQuality: '#60a5fa',
  lowQuality: '#facc15',
  muted: '#71717a',
}

const TIER_LABEL: Record<Exclude<SignalPathTier, 'muted'>, string> = {
  lossless: 'Lossless',
  enhanced: 'Enhanced',
  highQuality: 'High quality',
  lowQuality: 'Low quality',
}

/** Roon-style quality mark: a glowing sparkle for lossless / enhanced, a glowing dot below that. */
function TierGlyph({ tier, size = 12 }: { tier: SignalPathTier; size?: number }) {
  const color = TIER_COLOR[tier]
  const glow = { filter: `drop-shadow(0 0 ${size / 3}px ${color})` }
  if (tier === 'lossless' || tier === 'enhanced') {
    return <Sparkle aria-hidden width={size} height={size} strokeWidth={0} fill={color} style={glow} className="shrink-0" />
  }
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-full"
      style={{ width: size * 0.55, height: size * 0.55, background: color, boxShadow: `0 0 ${size / 2}px ${color}` }}
    />
  )
}

function tierRank(tier: SignalPathTier): number {
  switch (tier) {
    case 'lowQuality':
      return 4
    case 'highQuality':
      return 3
    case 'enhanced':
      return 2
    case 'lossless':
      return 1
    default:
      return 0
  }
}

function getLowerTier(current: SignalPathTier, next: SignalPathTier): SignalPathTier {
  return tierRank(next) > tierRank(current) ? next : current
}

function isIntegerRatioResample(
  decision: ReturnType<typeof usePlayerStore.getState>['playbackDecision'],
): boolean {
  if (!decision || decision.mode !== 'RESAMPLED') return true
  const higherRate = Math.max(decision.originalSampleRate, decision.deviceSampleRate)
  const lowerRate = Math.min(decision.originalSampleRate, decision.deviceSampleRate)
  return lowerRate > 0 ? higherRate % lowerRate === 0 : false
}

function formatChannels(channels: number): string {
  if (channels === 1) return 'Mono'
  if (channels === 2) return 'Stereo'
  return `${channels}ch`
}

function headroomLabel(status: ResamplerStatus): string {
  return `−${status.headroomDb} dB headroom${status.headroomAuto ? ' (auto)' : ''}`
}

const RESAMPLER_STATUS_POLL_MS = 1000
const VOLUME_CHANGE_HIGHLIGHT_MS = 1200

function formatSourceLabel(
  formatInfo: ReturnType<typeof usePlayerStore.getState>['formatInfo'],
  currentTrack: ReturnType<typeof usePlayerStore.getState>['currentTrack'],
  providerName: string | null,
): string {
  if (!formatInfo) return 'Unknown'
  const baseLabel = formatInfo.isDsd
    ? dsdRateName(formatInfo.dsdRate ?? formatInfo.sampleRate)
    : formatLabel(formatInfo.format)

  const provider = currentTrack?.provider?.trim()
  if (provider?.toLowerCase() === 'live-radio') return 'Live Stream'
  if (!provider || provider.toLowerCase() === 'local') return baseLabel

  return `${providerName ?? provider.toUpperCase()} ${baseLabel}`
}

function formatSourceDetail(
  formatInfo: ReturnType<typeof usePlayerStore.getState>['formatInfo'],
): string {
  if (!formatInfo) return 'No source loaded'
  if (isLiveRadioTrack(usePlayerStore.getState().currentTrack)) {
    const parts = ['Internet radio']
    if (formatInfo.bitrate > 0) parts.push(formatBitrate(formatInfo.bitrate))
    parts.push('Bit-perfect not applicable')
    return parts.join(' / ')
  }

  const parts: string[] = []
  if (formatInfo.isDsd) {
    if ((formatInfo.dsdRate ?? formatInfo.sampleRate) > 0) {
      parts.push(formatDsdRateMHz(formatInfo.dsdRate ?? formatInfo.sampleRate))
    }
  } else {
    const bitDepth = formatDisplayBitDepth(formatInfo)
    if (bitDepth) parts.push(bitDepth)
    if (formatInfo.sampleRate > 0) parts.push(formatSampleRate(formatInfo.sampleRate))
  }
  if (formatInfo.channels > 0) parts.push(formatChannels(formatInfo.channels))
  if (formatInfo.bitrate > 0) parts.push(formatBitrate(formatInfo.bitrate))

  return parts.join(' / ')
}

function getSourceTier(
  formatInfo: ReturnType<typeof usePlayerStore.getState>['formatInfo'],
): SignalPathTier {
  if (!formatInfo) return 'muted'
  if (isLiveRadioTrack(usePlayerStore.getState().currentTrack)) return 'highQuality'
  if (!formatInfo.isLossless) {
    return isHighQualityLossyFormat(formatInfo) ? 'highQuality' : 'lowQuality'
  }
  if (formatInfo.isMqa) return 'enhanced'
  return formatBadgeClasses(formatInfo) === badgeToneClasses.muted ? 'lowQuality' : 'lossless'
}

function formatOverallStatus(tier: SignalPathTier, bitPerfect: boolean): string {
  if (tier === 'muted') return 'Idle'
  return tier === 'lossless' && bitPerfect ? 'Bit-perfect' : TIER_LABEL[tier]
}

/** Short format text for the source node (FLAC, DSF, MP3…). */
function sourceNodeText(formatInfo: ReturnType<typeof usePlayerStore.getState>['formatInfo']): string {
  if (!formatInfo) return '—'
  if (formatInfo.isDsd) return 'DSD'
  const label = formatLabel(formatInfo.format).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return label.slice(0, 4) || 'PCM'
}

export default function SignalPathPanel() {
  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [resampler, setResampler] = useState<ResamplerStatus | null>(null)
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus | null>(null)
  const [expandedStage, setExpandedStage] = useState<string | null>(null)
  const [volumeChanged, setVolumeChanged] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const audioSetup = useAudioSetupStore((s) => s.setup)

  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const providerName = useProviderStatusStore((s) => {
    const id = currentTrack?.provider?.trim()
    return id ? s.providers.find(({ manifest }) => manifest.id === id)?.manifest.displayName ?? null : null
  })
  const formatInfo = usePlayerStore((s) => s.formatInfo)
  const outputMode = usePlayerStore((s) => s.outputMode)
  const audioDevice = usePlayerStore((s) => s.audioDevice)
  const audioMode = usePlayerStore((s) => s.audioMode)
  const deviceName = usePlayerStore((s) => s.deviceName)
  const playbackDecision = usePlayerStore((s) => s.playbackDecision)
  const deviceFormat = usePlayerStore((s) => s.deviceFormat)
  const bluetoothInfo = usePlayerStore((s) => s.bluetoothInfo)
  const processingSpeed = usePlayerStore((s) => s.processingSpeed)
  const resolvedDeviceName = usePlayerStore((s) => s.resolvedDeviceName)
  const volume = usePlayerStore((s) => s.volume)
  const volumeControl = usePlayerStore((s) => s.volumeControl)
  const hardwareDecibels = volumeControl.hardware?.decibels ?? null
  const hardwareMuted = !!volumeControl.hardware?.muted

  const eqEnabled = useDSPStore((s) => s.eqEnabled)
  const activeProfile = useDSPStore((s) => s.activeProfile)
  const peqEnabled = useDSPStore((s) => s.peqEnabled)
  const peqBands = useDSPStore((s) => s.peqBands)
  const crossfeedEnabled = useDSPStore((s) => s.crossfeedEnabled)
  const plugins = useDSPStore((s) => s.plugins)

  useEffect(() => {
    let cancelled = false

    void window.puros.audio.listDevices().then((list) => {
      if (!cancelled) setDevices(list)
    }).catch(() => {
      if (!cancelled) setDevices([])
    })

    return () => {
      cancelled = true
    }
  }, [audioDevice, deviceName, resolvedDeviceName])

  // What the engine does to the samples right now (resampler / dither).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const poll = () => {
      void window.puros.audio.getResamplerStatus()
        .then((status) => { if (!cancelled) setResampler(status) })
        .catch(() => { if (!cancelled) setResampler(null) })
      void window.puros.dsp.getRestoreStatus()
        .then((status) => { if (!cancelled) setRestoreStatus(status) })
        .catch(() => { if (!cancelled) setRestoreStatus(null) })
    }
    poll()
    const id = window.setInterval(() => { if (!isWindowHidden()) poll() }, RESAMPLER_STATUS_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [open, currentTrack, playbackDecision])

  useEffect(() => {
    if (!open) return

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (panelRef.current && !panelRef.current.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false)
      }
    }

    window.addEventListener('mousedown', handleMouseDown)
    return () => window.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  useEffect(() => {
    if (currentTrack) return
    setOpen(false)
  }, [currentTrack])

  // Briefly highlight the volume stage so a level change shows where it lands in the chain.
  const volumeMountedRef = useRef(false)
  useEffect(() => {
    if (!volumeMountedRef.current) {
      volumeMountedRef.current = true
      return
    }
    setVolumeChanged(true)
    const id = window.setTimeout(() => setVolumeChanged(false), VOLUME_CHANGE_HIGHLIGHT_MS)
    return () => window.clearTimeout(id)
  }, [volume, hardwareDecibels, hardwareMuted])

  const virtualDefault = devices.find((device) => device.isVirtual)
  const activePhysicalUid = audioDevice === '__default__'
    ? (virtualDefault?.resolvedUid ?? null)
    : audioDevice
  const activePhysicalDevice = activePhysicalUid
    ? devices.find((device) => !device.isVirtual && device.uid === activePhysicalUid) ?? null
    : null
  const manualEqActive = peqEnabled && peqBands.some((band) => band.enabled)
  const activePlugins = plugins.filter((plugin) => plugin.enabled)
  const liveRadioActive = isLiveRadioTrack(currentTrack)
  // DSD heard as PCM: the engine decodes it. Its status says so once polled; until then
  // shared mode and a PCM-fallback decision imply it.
  const dsdDecodedRate = resampler?.dsdSourceRate ?? 0
  const dsdAsPcm = !!formatInfo?.isDsd &&
    (
      dsdDecodedRate > 0 ||
      audioMode !== 'exclusive' ||
      (
        playbackDecision?.mode === 'RESAMPLED' &&
        playbackDecision.reason.includes('DSD source converted to PCM fallback')
      )
    )
  const dspActive = (!formatInfo?.isDsd || dsdAsPcm) &&
    ((eqEnabled && !!activeProfile) || manualEqActive || crossfeedEnabled || activePlugins.length > 0)
  const isBluetoothOutput = audioDevice === '__default__'
    ? !!bluetoothInfo?.isBluetooth
    : isBluetoothTransport(activePhysicalDevice?.transportType)
  const bluetoothCodec = audioDevice === '__default__' ? bluetoothInfo?.codec ?? null : null
  const actualOutputSampleRate = deviceFormat?.sampleRate && deviceFormat.sampleRate > 0
    ? (isBluetoothOutput ? Math.min(deviceFormat.sampleRate, 48_000) : deviceFormat.sampleRate)
    : null
  const actualOutputBitDepth = deviceFormat?.bitDepth && deviceFormat.bitDepth > 0
    ? deviceFormat.bitDepth
    : null
  const resamplingSettings = effectiveResampling(audioSetup, audioDevice)
  const outputLabel = audioDevice === '__default__'
    ? (resolvedDeviceName || activePhysicalDevice?.name || 'Default System Settings')
    : (deviceName || activePhysicalDevice?.name || 'Output Device')

  const stages: SignalPathStage[] = [
    {
      id: 'source',
      stage: 'SOURCE',
      label: formatSourceLabel(formatInfo, currentTrack, providerName),
      detail: formatSourceDetail(formatInfo),
      tier: getSourceTier(formatInfo),
    },
    {
      id: 'decode',
      stage: 'DECODE',
      label: 'Decoder',
      detail: (() => {
        const decoderLabel = dsdAsPcm
          ? 'Native DSD'
          : liveRadioActive
            ? 'Network stream'
          : formatInfo?.isDsd
            ? 'Native DoP'
            : 'Native'
        return decoderLabel
      })(),
      tier: liveRadioActive ? 'highQuality' : 'lossless',
    },
  ]

  if (dsdAsPcm && formatInfo) {
    // Decimated straight to 64-bit float, so no separate bit depth step follows.
    const dsdRate = dsdDecodedRate || (formatInfo.dsdRate ?? formatInfo.sampleRate)
    stages.push({
      id: 'convert',
      stage: 'CONVERT',
      label: 'DSD to PCM conversion',
      detail: (resampler && dsdDecodedRate > 0
        ? [
            `${dsdRateName(dsdRate)} to ${formatSampleRate(resampler.inputRate)} PCM`,
            '64bit Float',
            `${resampler.dsdStages}-stage linear phase`,
            resampler.dsdFilterHz > 0 ? `${resampler.dsdFilterHz / 1000} kHz ultrasonic filter` : null,
            resampler.dsdGainDb > 0 ? `+${resampler.dsdGainDb} dB` : null,
          ]
        : [`${dsdRateName(dsdRate)} to PCM`]
      ).filter(Boolean).join(' • '),
      tier: 'highQuality',
    })
  }

  // Roon-style: any processing widens the samples to 64-bit float first and requantizes at the end.
  const float64 = !!resampler?.float64
  if (float64 && resampler && dsdDecodedRate === 0) {
    const sourceDepth = resampler.sourceFloat
      ? `${formatBitDepth(resampler.sourceBits || 32)} Float`
      : resampler.sourceBits > 0
        ? formatBitDepth(resampler.sourceBits)
        : (formatInfo && formatDisplayBitDepth(formatInfo)) || 'PCM'
    stages.push({
      id: 'bitdepthIn',
      stage: 'CONVERT',
      label: 'Bit depth conversion',
      detail: `${sourceDepth} to 64bit Float`,
      tier: 'lossless',
    })
  }

  if (resampler?.deemphasis) {
    stages.push({
      id: 'deemphasis',
      stage: 'DE-EMPHASIS',
      label: 'CD de-emphasis',
      detail: '50/15 µs pre-emphasis removed',
      tier: 'enhanced',
    })
  }

  const restoreStage: SignalPathStage | null = restoreStatus?.state === 'active'
    ? {
        id: 'restore',
        stage: 'RESTORE',
        label: 'Puros Restore',
        detail: [
          restoreStatus.codec,
          restoreStatus.cutoffHz > 0
            ? `top end rebuilt above ${(restoreStatus.cutoffHz / 1000).toFixed(1)} kHz`
            : 'full bandwidth source',
          restoreStatus.mode === 'auto' ? 'auto: lossy source' : 'manual',
        ].filter(Boolean).join(' • '),
        tier: 'enhanced',
      }
    : null
  if (restoreStage && restoreStatus?.position === 'source') stages.push(restoreStage)

  if (resampler?.resampling && resampler.inputRate > 0 && resampler.outputRate > 0) {
    const integerRatio = Math.max(resampler.inputRate, resampler.outputRate) % Math.min(resampler.inputRate, resampler.outputRate) === 0
    const engineLabel = describeResampler(resamplingSettings, resampler.filter, resampler.engine ?? 'soxr') +
      (resampler.engine === 'fir' && resampler.firTaps > 0 ? ` · ${resampler.firTaps.toLocaleString()} taps` : '')
    stages.push({
      id: 'resample',
      stage: 'RESAMPLE',
      label: 'Sample rate conversion',
      detail: `${formatSampleRate(resampler.inputRate)} → ${formatSampleRate(resampler.outputRate)} • ${engineLabel}`,
      tier: integerRatio || resamplingSettings.soxrPreset !== 'quick' ? 'highQuality' : 'lowQuality',
    })
  } else if (
    outputMode === 'EXCLUSIVE' &&
    playbackDecision?.mode === 'RESAMPLED' &&
    playbackDecision.originalSampleRate !== playbackDecision.deviceSampleRate &&
    !dsdAsPcm
  ) {
    stages.push({
      id: 'resample',
      stage: 'RESAMPLE',
      label: 'Sample rate conversion',
      detail: `${formatSampleRate(playbackDecision.originalSampleRate)} → ${formatSampleRate(actualOutputSampleRate ?? playbackDecision.deviceSampleRate)}`,
      tier: isIntegerRatioResample(playbackDecision) ? 'highQuality' : 'lowQuality',
    })
  }

  if (resampler && (resampler.convolutionTaps > 0 || resampler.convolutionError)) {
    const fileName = resamplingSettings.convolution.path?.split('/').pop() ?? 'Room correction'
    stages.push({
      id: 'room',
      stage: 'CONVOLUTION',
      label: resampler.convolutionError ? 'Room correction off' : 'Room correction',
      detail: resampler.convolutionError
        ? resampler.convolutionError
        : `${fileName} • ${resampler.convolutionTaps.toLocaleString()} taps • 64-bit`,
      tier: resampler.convolutionError ? 'lowQuality' : 'enhanced',
    })
  }

  if (float64 && resampler && resampler.dsdOutputRate === 0) {
    const clipped = resampler.clippedSamples > 0
    const peak = resampler.peakDb > -150 ? `peak ${resampler.peakDb > 0 ? '+' : '−'}${Math.abs(resampler.peakDb).toFixed(1)} dBFS` : null
    stages.push({
      id: 'level',
      stage: 'LEVEL',
      label: clipped ? 'Clipping' : 'Headroom adjustment',
      detail: [
        resampler.headroomDb > 0 ? headroomLabel(resampler) : resampler.headroomAuto ? 'No headroom needed' : 'No headroom',
        peak,
        clipped
          ? `${resampler.clippedSamples.toLocaleString()} clipped samples — raise headroom`
          : 'no clipping',
      ].filter(Boolean).join(' • '),
      tier: clipped ? 'lowQuality' : 'enhanced',
    })
  }

  if (dspActive) {
    const activeStages = [
      eqEnabled && activeProfile ? activeProfile.name : null,
      manualEqActive ? 'Custom EQ' : null,
      crossfeedEnabled ? 'Crossfeed' : null,
      ...activePlugins.map((plugin) => plugin.name),
    ].filter((value): value is string => !!value)
    // Audio Unit / VST plug-ins only take float32, so the 64-bit chain narrows around them.
    const pluginPrecision = float64 && activePlugins.length > 0 ? ' • plug-ins at 32bit Float' : ''

    stages.push({
      id: 'dsp',
      stage: 'DSP ENGINE',
      label: 'Audio effects',
      detail: activeStages.join(' + ') + pluginPrecision,
      tier: 'enhanced',
    })
  }

  if (restoreStage && restoreStatus?.position === 'afterDsp') stages.push(restoreStage)

  if (resampler && resampler.dsdOutputRate > 0) {
    // PCM → DSD: the modulator replaces requantization; overloads are its "clipping".
    const modulator = DSD_MODULATORS.find((entry) => entry.id === resampler.modulator)?.label ?? 'Delta-sigma'
    const overloaded = resampler.modulatorOverloads > 0
    const peak = resampler.peakDb > -150 ? `peak ${resampler.peakDb > 0 ? '+' : '−'}${Math.abs(resampler.peakDb).toFixed(1)} dBFS` : null
    stages.push({
      id: 'modulator',
      stage: 'MODULATOR',
      label: `PCM → ${dsdOutputRateName(resampler.dsdOutputRate)}`,
      detail: [
        `${modulator} delta-sigma`,
        `${(resampler.dsdOutputRate / 1e6).toFixed(1)} MHz 1-bit • DoP`,
        resampler.headroomDb > 0 ? headroomLabel(resampler) : null,
        peak,
        overloaded
          ? `${resampler.modulatorOverloads.toLocaleString()} overloads — raise headroom`
          : 'stable',
      ].filter(Boolean).join(' • '),
      tier: overloaded ? 'lowQuality' : 'enhanced',
    })
  } else if (float64 && resampler) {
    const plainFloat = resampler.outputFloat && resampler.outputBits === 0
    const targetDepth = plainFloat ? '32bit Float' : formatBitDepth(resampler.outputBits)
    // Fewer bits than the source carried: dither keeps it clean, but it is no longer lossless.
    const reducesBits = !plainFloat &&
      (resampler.sourceFloat ? resampler.outputBits < 24 : resampler.sourceBits > resampler.outputBits)
    stages.push({
      id: 'bitdepthOut',
      stage: 'REQUANTIZE',
      label: 'Bit depth conversion',
      detail: [
        `64bit Float to ${targetDepth}`,
        resampler.ditherBits > 0 ? `${describeDither(resampler.dither)} dither` : null,
      ].filter(Boolean).join(' • '),
      tier: reducesBits ? 'highQuality' : 'lossless',
    })
  }

  const volumeStage = (() => {
    switch (volumeControl.effective) {
      case 'system': {
        // Shared / AirPlay: the HAL output unit scales Puros's stream before macOS mixes it.
        if (outputMode === 'EXCLUSIVE') return null
        const gain = userVolumeToGain(volume)
        if (gain >= 1) return null
        return {
          label: 'App volume',
          detail: `${formatDecibels(gainToDecibels(gain))} • before the system mixer`,
          tier: 'enhanced' as const,
        }
      }
      case 'dsp': {
        if (outputMode !== 'EXCLUSIVE' || !isDspVolumeAttenuating(volumeControl, volume)) return null
        const ditherBits = actualOutputBitDepth ? ` • TPDF dither to ${formatBitDepth(actualOutputBitDepth)}` : ' • TPDF dither'
        return {
          label: 'DSP volume',
          detail: `${formatDecibels(gainToDecibels(userVolumeToGain(volume)))} • 64-bit${ditherBits}`,
          tier: 'enhanced' as const,
        }
      }
      case 'device': {
        if (outputMode !== 'EXCLUSIVE') return null
        const hardware = volumeControl.hardware
        // At the DAC's maximum (or reading 0 dB) the device passes the level through unchanged.
        const atUnity = (hardware ? hardware.scalar >= 1 : volume >= 1) ||
          (hardware?.decibels != null && Math.round(hardware.decibels * 10) === 0)
        if (!hardware?.muted && atUnity) return null
        const level = hardware?.muted ? 'Muted' : formatDecibels(hardware?.decibels) || `${Math.round(volume * 100)}%`
        return { label: 'Device volume', detail: `${level} • DAC hardware control`, tier: 'lossless' as const }
      }
      default:
        return null
    }
  })()

  // Only shown when it changes the level. System volume is applied ahead of the mixer;
  // DSP / device volume sit at the end of the exclusive chain.
  if (volumeStage && volumeControl.effective === 'system') {
    stages.push({ id: 'volume', stage: 'VOLUME', ...volumeStage })
  }

  if (outputMode === 'SHARED') {
    stages.push({
      id: 'mixer',
      stage: 'MIXER',
      label: 'System mixer',
      detail: actualOutputSampleRate
        ? `Shared ${formatSampleRate(actualOutputSampleRate)} output`
        : 'Shared output path',
      tier: 'highQuality',
    })
  }

  if (volumeStage && volumeControl.effective !== 'system') {
    stages.push({ id: 'volume', stage: 'VOLUME', ...volumeStage })
  }

  const outputParts: string[] = []
  outputParts.push(
    outputMode === 'EXCLUSIVE'
      ? 'Exclusive'
      : outputMode === 'AIRPLAY'
        ? 'AirPlay'
        : 'Shared'
  )
  if (isBluetoothOutput && bluetoothCodec) {
    outputParts.push(bluetoothCodec)
  }
  if (resampler && resampler.dsdOutputRate > 0) {
    // The DoP carrier is not a PCM rate: name the DSD stream instead.
    outputParts.push(`DoP ${dsdOutputRateName(resampler.dsdOutputRate)}`)
  } else {
    if (actualOutputSampleRate) {
      outputParts.push(formatSampleRate(actualOutputSampleRate))
    }
    if (actualOutputBitDepth && !isBluetoothOutput) {
      outputParts.push(formatBitDepth(actualOutputBitDepth))
    }
  }

  let outputTier: SignalPathTier = 'lossless'
  if (
    outputMode === 'AIRPLAY' ||
    isBluetoothOutput ||
    bluetoothCodec === 'SBC'
  ) {
    outputTier = 'highQuality'
  } else if (outputMode !== 'EXCLUSIVE') {
    outputTier = 'highQuality'
  }

  stages.push({
    id: 'output',
    stage: 'OUTPUT',
    label: outputLabel,
    detail: outputParts.join(' • '),
    tier: outputTier,
  })

  let overallTier: SignalPathTier = 'muted'
  for (const stage of stages) {
    overallTier = getLowerTier(overallTier, stage.tier)
  }

  const displayTier: SignalPathTier = currentTrack ? overallTier : 'muted'
  const bitPerfect =
    overallTier === 'lossless' && outputMode === 'EXCLUSIVE' && playbackDecision?.mode === 'BIT_PERFECT'
  const OutputIcon = outputMode === 'AIRPLAY' ? Airplay : isBluetoothOutput ? Bluetooth : Volume2

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => {
          if (!currentTrack) return
          setOpen((value) => !value)
        }}
        disabled={!currentTrack}
        className={`group flex h-7 w-7 items-center justify-center rounded-full border transition-all duration-200 ease-out ${
          currentTrack
            ? 'border-white/10 bg-white/[0.04] hover:border-white/15 hover:bg-white/[0.06]'
            : 'border-white/8 bg-white/[0.02]'
        } ${open ? 'border-white/15 bg-white/[0.08] shadow-[0_0_0_1px_rgba(255,255,255,0.04)]' : ''}`}
        title={currentTrack ? `Signal path: ${formatOverallStatus(displayTier, bitPerfect)}` : 'Signal path unavailable'}
      >
        <TierGlyph tier={displayTier} size={13} />
      </button>

      <GlassPopover
        ref={popoverRef}
        anchorRef={panelRef}
        open={open}
        gap={12}
        radius={26}
        className={`w-[24rem] max-w-[calc(100vw-1rem)] overflow-hidden border border-transparent transition-[max-height,opacity,transform] duration-200 ease-out ${
          open ? 'pointer-events-auto max-h-[calc(100vh-8rem)] translate-y-0 opacity-100' : 'pointer-events-none max-h-0 translate-y-2 opacity-0'
        }`}
      >
        <div className="max-h-[calc(100vh-8rem)] overflow-y-auto px-5 pt-5 pb-4">
          {/* Header */}
          <h2 className="text-[19px] tracking-tight text-white">
            <span className="font-semibold">Signal path:</span>{' '}
            <span className="font-normal text-zinc-200">{formatOverallStatus(displayTier, bitPerfect)}</span>
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">Click any stage to learn more</p>

          <div className="mt-4 flex items-center gap-2 text-[13px] text-zinc-200">
            <span className="truncate">{outputLabel}</span>
            <TierGlyph tier={displayTier} />
          </div>
          {processingSpeed != null && processingSpeed > 0 && (
            <p className="mt-1 text-xs text-zinc-500 tabular-nums">Processing speed: {processingSpeed.toFixed(1)}x</p>
          )}

          {/* Timeline */}
          <ol className="mt-4">
            {stages.map((stage, index) => {
              const major = stage.id === 'source' || stage.id === 'output'
              const first = index === 0
              const last = index === stages.length - 1
              const expanded = expandedStage === stage.id
              const highlighted = stage.id === 'volume' && volumeChanged
              const title = stage.id === 'source' ? 'Source' : stage.label
              const detail = (stage.id === 'source' ? [stage.label, stage.detail].filter(Boolean).join(' · ') : stage.detail)
                .replace(/ [•/] /g, ' · ')
              return (
                <li key={stage.id} className="relative flex gap-3">
                  {/* Rail: node centred on the title line, with the line above and below it. */}
                  <div className="relative w-9 shrink-0">
                    {!first && <span className="absolute left-1/2 top-0 h-[18px] w-px -translate-x-1/2 bg-white/25" />}
                    {!last && <span className="absolute left-1/2 top-[18px] bottom-0 w-px -translate-x-1/2 bg-white/25" />}
                    {major ? (
                      <span className="absolute left-0 top-0 flex h-9 w-9 items-center justify-center rounded-full border border-white/40 bg-zinc-950/70 text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-md">
                        {stage.id === 'source'
                          ? <span className="text-[9px] font-semibold tracking-wide">{sourceNodeText(formatInfo)}</span>
                          : <OutputIcon className="h-4 w-4" />}
                      </span>
                    ) : (
                      <span
                        className={`absolute left-1/2 top-[18px] h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background-color,box-shadow] duration-300 ${
                          highlighted ? 'bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]' : 'bg-zinc-300'
                        }`}
                      />
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setExpandedStage(expanded ? null : stage.id)}
                    aria-expanded={expanded}
                    className={`group/stage min-w-0 flex-1 rounded-xl px-2 -mx-2 pt-1.5 text-left transition-colors duration-300 hover:bg-white/[0.04] ${highlighted ? 'bg-white/[0.06]' : ''} ${last ? 'pb-1.5' : 'pb-4'}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-zinc-100">{title}</span>
                      <TierGlyph tier={stage.tier} />
                    </span>
                    {detail && <span className="mt-0.5 block text-[13px] leading-snug text-zinc-400">{detail}</span>}
                    <span
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
                    >
                      <span className="overflow-hidden">
                        <span className="mt-2 block rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-xs leading-relaxed text-zinc-300">
                          <span className="block font-medium text-zinc-100">{title}</span>
                          {STAGE_INFO[stage.id]}
                          <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
                            <TierGlyph tier={stage.tier} size={10} />
                            {stage.tier === 'muted' ? 'Inactive' : TIER_LABEL[stage.tier]}
                          </span>
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>

          {/* Legend */}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/5 pt-3 text-[11px] text-zinc-500">
            {(Object.keys(TIER_LABEL) as Array<keyof typeof TIER_LABEL>).map((tier) => (
              <span key={tier} className="inline-flex items-center gap-1.5">
                <TierGlyph tier={tier} size={10} />
                {TIER_LABEL[tier]}
              </span>
            ))}
          </div>
        </div>
      </GlassPopover>
    </div>
  )
}
