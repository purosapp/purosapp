/**
 * Format badges — inline badges showing format, bit depth, sample rate,
 * bitrate, output mode, device name, and playback decision (bit-perfect vs resampled).
 */

import type { FormatInfo, OutputMode } from '../services/local/formats'
import type { PlaybackDecision } from '../services/formatCompatibility'
import type { BluetoothInfo } from '../../electron/preload'
import {
  formatLabel,
  formatSampleRate,
  formatBitDepth,
  formatBitrate,
  formatDisplayBitDepth,
  formatDsdRateMHz,
  dsdRateName,
} from '../services/local/formats'
import { useSettingsStore } from '../store/settingsStore'
import { useDSPStore } from '../store/dspStore'
import { usePlayerStore } from '../store/playerStore'
import {
  formatDecibels,
  gainToDecibels,
  isDspVolumeAttenuating,
  userVolumeToGain,
} from '../services/volumeControl'
import { badgeBase, formatBadgeClasses, outputModeBadgeClasses } from './formatBadgeStyles'

interface FormatBadgesProps {
  formatInfo: FormatInfo | null
  outputMode?: OutputMode
  deviceName?: string | null
  playbackDecision?: PlaybackDecision | null
  bluetoothInfo?: BluetoothInfo | null
  qualityOnly?: boolean
  className?: string
}

const BLUETOOTH_TOOLTIP =
  'Bluetooth output detected. Exclusive mode is not available. ' +
  'Audio is transmitted lossy — bit-perfect playback is not possible.'

function formatSharedPlaybackLabel(playbackDecision: PlaybackDecision): string {
  if (playbackDecision.mode === 'RESAMPLED') {
    return `SYSTEM MIXER ${playbackDecision.originalSampleRate / 1000}\u2192${playbackDecision.deviceSampleRate / 1000}kHz`
  }
  return `SYSTEM MIXER ${playbackDecision.deviceSampleRate / 1000}kHz`
}

export default function FormatBadges({
  formatInfo,
  outputMode,
  deviceName,
  playbackDecision,
  bluetoothInfo,
  qualityOnly = false,
  className = 'mt-1 flex-wrap',
}: FormatBadgesProps) {
  const tags = useSettingsStore((s) => s.playerTags)
  // Manual Restore processes lossless PCM too; Auto leaves lossless sources bit-perfect.
  const dspActive = useDSPStore((s) =>
    (s.eqEnabled && !!s.activeProfile) ||
    (s.peqEnabled && s.peqBands.some((band) => band.enabled)) ||
    s.crossfeedEnabled || s.plugins.some((plugin) => plugin.enabled) ||
    s.restore.mode === 'manual')
  const volume = usePlayerStore((s) => s.volume)
  const volumeControl = usePlayerStore((s) => s.volumeControl)

  if (!formatInfo) return null

  const dspVolumeActive = outputMode === 'EXCLUSIVE' && isDspVolumeAttenuating(volumeControl, volume)

  const isBluetooth = bluetoothInfo?.isBluetooth ?? false
  const showExclusiveBitPerfect =
    tags.playbackDecision &&
    !isBluetooth &&
    (!dspActive || !!formatInfo.isDsd) &&
    !dspVolumeActive &&
    playbackDecision?.mode === 'BIT_PERFECT' &&
    outputMode === 'EXCLUSIVE'
  const showExclusiveNativeRate =
    tags.playbackDecision &&
    !isBluetooth &&
    playbackDecision?.mode === 'NATIVE_RATE' &&
    outputMode === 'EXCLUSIVE'
  const showSharedPlaybackSummary =
    tags.playbackDecision &&
    !!playbackDecision &&
    (playbackDecision.mode === 'RESAMPLED' || outputMode !== 'EXCLUSIVE')
  const showBluetoothLossy =
    tags.bluetooth &&
    isBluetooth &&
    !!bluetoothInfo?.codec &&
    !showSharedPlaybackSummary

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {/* Format badge */}
      {(qualityOnly || tags.format) && (
        <span className={`${badgeBase} ${formatBadgeClasses(formatInfo)}`}>
          {formatInfo.isDsd ? dsdRateName(formatInfo.dsdRate ?? formatInfo.sampleRate) : formatLabel(formatInfo.format)}
        </span>
      )}

      {/* Bit depth */}
      {(qualityOnly || tags.bitDepth) && (formatInfo.isDsd || formatDisplayBitDepth(formatInfo)) && (
        <span className={`${badgeBase} bg-zinc-700 text-zinc-200`}>
          {formatInfo.isDsd ? formatBitDepth(Math.max(formatInfo.bitDepth, 1)) : formatDisplayBitDepth(formatInfo)}
        </span>
      )}

      {/* Sample rate / DSD rate */}
      {(qualityOnly || tags.sampleRate) && (
        (formatInfo.isDsd && (formatInfo.dsdRate ?? formatInfo.sampleRate) > 0) ||
        (!formatInfo.isDsd && formatInfo.sampleRate > 0)
      ) && (
        <span className={`${badgeBase} bg-zinc-700 text-zinc-200`}>
          {formatInfo.isDsd
            ? formatDsdRateMHz(formatInfo.dsdRate ?? formatInfo.sampleRate)
            : formatSampleRate(formatInfo.sampleRate)}
        </span>
      )}

      {/* Bitrate */}
      {(qualityOnly || tags.bitrate) && formatInfo.bitrate > 0 && (
        <span className={`${badgeBase} bg-zinc-700 text-zinc-200`}>
          {formatBitrate(formatInfo.bitrate)}
        </span>
      )}

      {/* Output mode badge */}
      {!qualityOnly && tags.outputMode && outputMode && (
        <span
          className={`${badgeBase} ${outputModeBadgeClasses(outputMode, isBluetooth)}`}
          title={isBluetooth ? BLUETOOTH_TOOLTIP : undefined}
        >
          {outputMode}
        </span>
      )}

      {/* Playback decision badge — BIT-PERFECT only if actually in exclusive mode */}
      {!qualityOnly && showExclusiveBitPerfect && (
        <span
          className={`${badgeBase} bg-green-950 text-green-400`}
          title={playbackDecision.reason}
        >
          BIT-PERFECT
        </span>
      )}
      {!qualityOnly && showExclusiveNativeRate && (
        <span
          className={`${badgeBase} bg-sky-950 text-sky-300`}
          title={playbackDecision.reason}
        >
          NATIVE {playbackDecision.deviceSampleRate / 1000}kHz
        </span>
      )}
      {!qualityOnly && tags.playbackDecision && dspActive && !formatInfo.isDsd &&
        playbackDecision?.mode !== 'RESAMPLED' && !!playbackDecision && outputMode === 'EXCLUSIVE' && (
        <span className={`${badgeBase} bg-purple-950 text-purple-300`} title="DSP processing changes PCM samples">
          DSP ACTIVE
        </span>
      )}
      {!qualityOnly && tags.playbackDecision && dspVolumeActive && !!playbackDecision && (
        <span
          className={`${badgeBase} bg-purple-950 text-purple-300`}
          title="Exclusive DSP volume attenuates the samples (64-bit, TPDF dither). Bit-perfect again at 100%."
        >
          DSP VOL {formatDecibels(gainToDecibels(userVolumeToGain(volume)))}
        </span>
      )}
      {!qualityOnly && showSharedPlaybackSummary && (
        <span
          className={`${badgeBase} bg-yellow-950 text-yellow-400`}
          title={
            outputMode !== 'EXCLUSIVE'
              ? playbackDecision?.reason
              : playbackDecision?.reason
          }
        >
          {outputMode !== 'EXCLUSIVE'
            ? formatSharedPlaybackLabel(playbackDecision)
            : playbackDecision?.mode === 'RESAMPLED' && playbackDecision.dsdOutputRate
              ? `${playbackDecision.originalSampleRate / 1000}kHz \u2192 DSD${Math.round(playbackDecision.dsdOutputRate / 44100)}`
              : playbackDecision?.mode === 'RESAMPLED'
                ? `RESAMPLED ${playbackDecision.originalSampleRate / 1000}\u2192${playbackDecision.deviceSampleRate / 1000}kHz`
                : 'RESAMPLED'}
        </span>
      )}

      {/* Bluetooth: codec + lossy indicator */}
      {!qualityOnly && showBluetoothLossy && (
        <span
          className="text-xs text-amber-600/80"
          title={BLUETOOTH_TOOLTIP}
        >
          {bluetoothInfo.codec} · Lossy
        </span>
      )}

      {/* Device name */}
      {!qualityOnly && tags.deviceName && deviceName && (
        <span className="text-xs text-zinc-500">
          &rarr; {deviceName}
        </span>
      )}
    </div>
  )
}
