import { useEffect, useRef, useState } from 'react'
import type { AudioDevice, ResamplerStatus } from '../../electron/preload'
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

type SignalPathTier = 'lossless' | 'enhanced' | 'highQuality' | 'lowQuality' | 'muted'

type SignalPathStage = {
  id: string
  stage: string
  label: string
  detail: string
  tier: SignalPathTier
}

const toneStyles: Record<SignalPathTier, { dot: string; border: string; pill: string }> = {
  lossless: {
    dot: 'bg-green-400',
    border: 'border-green-400/45',
    pill: badgeToneClasses.pristine,
  },
  enhanced: {
    dot: 'bg-purple-300',
    border: 'border-purple-300/45',
    pill: badgeToneClasses.processed,
  },
  highQuality: {
    dot: 'bg-blue-400',
    border: 'border-blue-400/45',
    pill: badgeToneClasses.hiRes,
  },
  lowQuality: {
    dot: 'bg-yellow-400',
    border: 'border-yellow-400/45',
    pill: badgeToneClasses.resampled,
  },
  muted: {
    dot: 'bg-zinc-500',
    border: 'border-zinc-500/35',
    pill: badgeToneClasses.muted,
  },
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

function getDsdPcmFallbackBitDepth(): number {
  return 32
}

const RESAMPLER_STATUS_POLL_MS = 1000

function formatSourceLabel(
  formatInfo: ReturnType<typeof usePlayerStore.getState>['formatInfo'],
  currentTrack: ReturnType<typeof usePlayerStore.getState>['currentTrack'],
): string {
  if (!formatInfo) return 'Unknown'
  const baseLabel = formatInfo.isDsd
    ? dsdRateName(formatInfo.dsdRate ?? formatInfo.sampleRate)
    : formatLabel(formatInfo.format)

  const provider = currentTrack?.provider?.trim()
  if (provider?.toLowerCase() === 'live-radio') return 'Live Stream'
  if (!provider || provider.toLowerCase() === 'local') return baseLabel

  return `${provider.toUpperCase()} ${baseLabel}`
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
  switch (tier) {
    case 'lossless':
      return bitPerfect ? 'BIT-PERFECT' : 'LOSSLESS'
    case 'enhanced':
      return 'ENHANCED'
    case 'highQuality':
      return 'HIGH QUALITY'
    case 'lowQuality':
      return 'LOW QUALITY'
    default:
      return 'IDLE'
  }
}

export default function SignalPathPanel() {
  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [resampler, setResampler] = useState<ResamplerStatus | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const audioSetup = useAudioSetupStore((s) => s.setup)

  const currentTrack = usePlayerStore((s) => s.currentTrack)
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
    }
    poll()
    const id = window.setInterval(poll, RESAMPLER_STATUS_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [open, currentTrack, playbackDecision])

  useEffect(() => {
    if (!open) return

    const handleMouseDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
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
  const usingFfmpegDecode = !!formatInfo?.isDsd &&
    (
      audioMode !== 'exclusive' ||
      (
        playbackDecision?.mode === 'RESAMPLED' &&
        playbackDecision.reason.includes('DSD source converted to PCM fallback')
      )
    )
  const dspActive = (!formatInfo?.isDsd || usingFfmpegDecode) &&
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
  const dsdPcmFallbackActive = !!formatInfo?.isDsd && usingFfmpegDecode
  const resamplingSettings = effectiveResampling(audioSetup, audioDevice)
  // The prepared PCM file's rate is what the engine decodes (its input rate).
  const dsdPcmFallbackSampleRate = dsdPcmFallbackActive
    ? (resampler?.inputRate || (playbackDecision?.mode === 'RESAMPLED' ? playbackDecision.deviceSampleRate : null))
    : null
  const dsdPcmFallbackBitDepth = dsdPcmFallbackActive ? getDsdPcmFallbackBitDepth() : null
  const outputLabel = audioDevice === '__default__'
    ? (resolvedDeviceName || activePhysicalDevice?.name || 'Default System Settings')
    : (deviceName || activePhysicalDevice?.name || 'Output Device')

  const stages: SignalPathStage[] = [
    {
      id: 'source',
      stage: 'SOURCE',
      label: formatSourceLabel(formatInfo, currentTrack),
      detail: formatSourceDetail(formatInfo),
      tier: getSourceTier(formatInfo),
    },
    {
      id: 'decode',
      stage: 'DECODE',
      label: 'Decoder',
      detail: (() => {
        const decoderLabel = usingFfmpegDecode
          ? 'FFmpeg PCM fallback'
          : liveRadioActive
            ? 'Network stream'
          : formatInfo?.isDsd
            ? 'Native DoP'
            : 'Native'
        if (!processingSpeed || processingSpeed <= 0) return decoderLabel
        return `${decoderLabel} • ${processingSpeed.toFixed(1)}x realtime`
      })(),
      tier: usingFfmpegDecode || liveRadioActive ? 'highQuality' : 'lossless',
    },
  ]

  if (dsdPcmFallbackActive && dsdPcmFallbackSampleRate && dsdPcmFallbackBitDepth) {
    stages.push({
      id: 'convert',
      stage: 'CONVERT',
      label: 'DSD to PCM',
      detail: [
        `${formatDsdRateMHz(formatInfo.dsdRate ?? formatInfo.sampleRate)} / 1bit → ${formatSampleRate(dsdPcmFallbackSampleRate)} / ${formatBitDepth(dsdPcmFallbackBitDepth)}`,
        'SoX',
        resamplingSettings.dsdFilter !== 'off' ? `${resamplingSettings.dsdFilter / 1000} kHz filter` : null,
        resamplingSettings.dsdGainDb > 0 ? `+${resamplingSettings.dsdGainDb} dB` : null,
      ].filter(Boolean).join(' • '),
      tier: 'highQuality',
    })
  }

  if (dspActive) {
    const activeStages = [
      eqEnabled && activeProfile ? activeProfile.name : null,
      manualEqActive ? 'Custom EQ' : null,
      crossfeedEnabled ? 'Crossfeed' : null,
      ...activePlugins.map((plugin) => plugin.name),
    ].filter((value): value is string => !!value)
    const dspDetail = activeStages.join(' + ')

    stages.push({
      id: 'dsp',
      stage: 'DSP ENGINE',
      label: 'EQ / DSP',
      detail: dspDetail,
      tier: 'enhanced',
    })
  }

  if (outputMode === 'SHARED') {
    stages.push({
      id: 'mixer',
      stage: 'MIXER',
      label: 'System Mixer',
      detail: actualOutputSampleRate
        ? `Shared ${formatSampleRate(actualOutputSampleRate)} output`
        : 'Shared output path',
      tier: 'highQuality',
    })
  }

  if (resampler?.deemphasis) {
    stages.push({
      id: 'deemphasis',
      stage: 'DE-EMPHASIS',
      label: 'CD De-emphasis',
      detail: '50/15 µs pre-emphasis removed',
      tier: 'enhanced',
    })
  }

  if (resampler?.resampling && resampler.inputRate > 0 && resampler.outputRate > 0) {
    const integerRatio = Math.max(resampler.inputRate, resampler.outputRate) % Math.min(resampler.inputRate, resampler.outputRate) === 0
    const engineLabel = describeResampler(resamplingSettings, resampler.filter, resampler.engine ?? 'soxr') +
      (resampler.engine === 'fir' && resampler.firTaps > 0 ? ` · ${resampler.firTaps.toLocaleString()} taps` : '')
    stages.push({
      id: 'resample',
      stage: 'RESAMPLE',
      label: 'Sample Rate Conversion',
      detail: `${formatSampleRate(resampler.inputRate)} → ${formatSampleRate(resampler.outputRate)} • ${engineLabel}`,
      tier: integerRatio || resamplingSettings.soxrPreset !== 'quick' ? 'highQuality' : 'lowQuality',
    })
  } else if (
    outputMode === 'EXCLUSIVE' &&
    playbackDecision?.mode === 'RESAMPLED' &&
    playbackDecision.originalSampleRate !== playbackDecision.deviceSampleRate &&
    !dsdPcmFallbackActive
  ) {
    stages.push({
      id: 'resample',
      stage: 'RESAMPLE',
      label: 'Sample Rate Conversion',
      detail: `${formatSampleRate(playbackDecision.originalSampleRate)} → ${formatSampleRate(actualOutputSampleRate ?? playbackDecision.deviceSampleRate)}`,
      tier: isIntegerRatioResample(playbackDecision) ? 'highQuality' : 'lowQuality',
    })
  }

  if (resampler && (resampler.convolutionTaps > 0 || resampler.convolutionError)) {
    const fileName = resamplingSettings.convolution.path?.split('/').pop() ?? 'Room correction'
    stages.push({
      id: 'room',
      stage: 'CONVOLUTION',
      label: resampler.convolutionError ? 'Room correction off' : 'Room Correction',
      detail: resampler.convolutionError
        ? resampler.convolutionError
        : `${fileName} • ${resampler.convolutionTaps.toLocaleString()} taps • 64-bit`,
      tier: resampler.convolutionError ? 'lowQuality' : 'enhanced',
    })
  }

  const processing = !!resampler &&
    (resampler.resampling || resampler.deemphasis || resampler.ditherBits > 0 || resampler.convolutionTaps > 0 ||
      resampler.dsdOutputRate > 0)
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
        resampler.headroomDb > 0 ? `−${resampler.headroomDb} dB headroom` : null,
        peak,
        overloaded
          ? `${resampler.modulatorOverloads.toLocaleString()} overloads — raise headroom`
          : 'stable',
      ].filter(Boolean).join(' • '),
      tier: overloaded ? 'lowQuality' : 'enhanced',
    })
  } else if (processing && resampler) {
    const clipped = resampler.clippedSamples > 0
    const peak = resampler.peakDb > -150 ? `peak ${resampler.peakDb > 0 ? '+' : '−'}${Math.abs(resampler.peakDb).toFixed(1)} dBFS` : null
    stages.push({
      id: 'level',
      stage: 'LEVEL',
      label: clipped ? 'Clipping' : 'Headroom',
      detail: [
        resampler.headroomDb > 0 ? `−${resampler.headroomDb} dB headroom` : 'No headroom',
        peak,
        clipped
          ? `${resampler.clippedSamples.toLocaleString()} clipped samples — raise headroom`
          : 'no clipping',
      ].filter(Boolean).join(' • '),
      tier: clipped ? 'lowQuality' : 'enhanced',
    })
  }

  if (resampler && resampler.ditherBits > 0) {
    stages.push({
      id: 'dither',
      stage: 'REQUANTIZE',
      label: 'Dither',
      detail: `${describeDither(resampler.dither)} to ${formatBitDepth(resampler.ditherBits)}`,
      tier: 'highQuality',
    })
  }

  if (outputMode === 'EXCLUSIVE') {
    const volumeStage = (() => {
      switch (volumeControl.effective) {
        case 'dsp': {
          if (!isDspVolumeAttenuating(volumeControl, volume)) {
            return { label: 'DSP Volume', detail: '0.0 dB • bypassed, samples untouched', tier: 'lossless' as const }
          }
          const ditherBits = actualOutputBitDepth ? ` • TPDF dither to ${formatBitDepth(actualOutputBitDepth)}` : ' • TPDF dither'
          return {
            label: 'DSP Volume',
            detail: `${formatDecibels(gainToDecibels(userVolumeToGain(volume)))} • 64-bit${ditherBits}`,
            tier: 'enhanced' as const,
          }
        }
        case 'device': {
          const hardware = volumeControl.hardware
          const level = hardware?.muted ? 'Muted' : formatDecibels(hardware?.decibels) || `${Math.round(volume * 100)}%`
          return { label: 'Device Volume', detail: `${level} • DAC hardware control`, tier: 'lossless' as const }
        }
        case 'fixed':
          return { label: 'Fixed Volume', detail: '100% • level set on the amplifier', tier: 'lossless' as const }
        default:
          return null
      }
    })()
    if (volumeStage) stages.push({ id: 'volume', stage: 'VOLUME', ...volumeStage })
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

  const overallTone = toneStyles[currentTrack ? overallTier : 'muted']
  const bitPerfect =
    overallTier === 'lossless' && outputMode === 'EXCLUSIVE' && playbackDecision?.mode === 'BIT_PERFECT'

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
        title={currentTrack ? 'Signal Path' : 'Signal Path unavailable'}
      >
        <span className={`h-2.5 w-2.5 rounded-full ${overallTone.dot}`} />
      </button>

      <div
        className={`absolute bottom-full right-0 z-50 mb-3 w-[26rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-white/10 bg-zinc-900/95 shadow-2xl backdrop-blur-xl transition-[max-height,opacity,transform] duration-200 ease-out ${
          open ? 'pointer-events-auto max-h-[calc(100vh-8rem)] translate-y-0 opacity-100' : 'pointer-events-none max-h-0 translate-y-2 opacity-0'
        }`}
      >
        <div className="border-b border-white/8 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${overallTone.dot}`} />
              <p className="text-[12px] font-medium uppercase tracking-[0.2em] text-zinc-100">
                Signal Path
              </p>
            </div>
            <span className={`rounded px-2 py-0.5 text-[10px] font-mono ${overallTone.pill}`}>
              {formatOverallStatus(overallTier, bitPerfect)}
            </span>
          </div>
        </div>

        <div className="max-h-[calc(100vh-13rem)] overflow-y-auto px-4 py-4">
          <div className="space-y-0">
            {stages.map((stage, index) => {
              const tone = toneStyles[stage.tier]

              return (
                <div key={stage.id}>
                  <div className={`rounded-xl border border-l-2 bg-white/[0.035] p-3 ${tone.border}`}>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                        {stage.stage}
                      </p>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <p className="min-w-0 text-[13px] font-medium text-zinc-100">
                        {stage.label}
                      </p>
                      <p className="max-w-[58%] text-right text-[11px] leading-4 text-zinc-500">
                        {stage.detail}
                      </p>
                    </div>
                  </div>

                  {index < stages.length - 1 && (
                    <div className="ml-3 h-4 w-px bg-white/15" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
