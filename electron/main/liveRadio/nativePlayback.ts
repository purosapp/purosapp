import { spawn, type ChildProcess } from 'node:child_process'
import type { LiveRadioPlaybackStatus } from '../../../src/services/liveRadio/types'
import { getAudioEngine } from '../audio/engine'
import { getFfmpegPath } from '../audio/localPlayback'
import { setPlaybackState } from '../playbackCoordinator'
import { sendToRenderer } from '../rendererBridge'

let liveRadioProcess: {
  stationId: string
  streamUrl: string
  child: ChildProcess
} | null = null

export function sendLiveRadioStatus(status: LiveRadioPlaybackStatus) {
  sendToRenderer('live-radio:playback-status', status)
}

export function stopLiveRadioNativePlayback(stationId?: string | null) {
  if (!liveRadioProcess) return
  if (stationId && liveRadioProcess.stationId !== stationId) return
  const child = liveRadioProcess.child
  liveRadioProcess = null
  child.stdout?.removeAllListeners()
  child.stderr?.removeAllListeners()
  child.removeAllListeners()
  if (!child.killed) child.kill('SIGTERM')
}

function pcmCodecForCurrentOutput(format: { bitDepth: number }): string {
  return format.bitDepth > 16 ? 'pcm_s32le' : 'pcm_s16le'
}

export async function startLiveRadioNativePlayback(stationId: string, streamUrl: string): Promise<{ success: boolean; error?: string }> {
  stopLiveRadioNativePlayback()
  const engine = getAudioEngine()
  const currentFormat = engine.getCurrentFormat()
  if (!currentFormat.sampleRate || !currentFormat.channels) {
    return { success: false, error: 'Output device is not ready for live radio playback.' }
  }

  const startResult = await engine.startPcmStream()
  if (!startResult.success) return startResult

  const ffmpegPath = getFfmpegPath()
  const pcmCodec = pcmCodecForCurrentOutput(currentFormat)
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '8',
    '-headers', 'Icy-MetaData: 1\r\n',
    '-i', streamUrl,
    '-vn',
    '-map_metadata', '-1',
    '-f', pcmCodec === 'pcm_s32le' ? 's32le' : 's16le',
    '-acodec', pcmCodec,
    '-ar', String(Math.round(currentFormat.sampleRate)),
    '-ac', String(Math.max(1, Math.min(2, currentFormat.channels || 2))),
    'pipe:1',
  ]

  try {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let settled = false
    liveRadioProcess = { stationId, streamUrl, child }

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        engine.write(chunk)
      } catch (error) {
        console.warn('[Puros][LiveRadio] Native PCM write failed:', error)
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    child.once('error', (error) => {
      if (liveRadioProcess?.child === child) liveRadioProcess = null
      sendLiveRadioStatus({
        stationId,
        state: 'error',
        message: error.message,
        attempt: 0,
      })
    })

    child.once('exit', (code, signal) => {
      const wasActive = liveRadioProcess?.child === child
      if (wasActive) liveRadioProcess = null
      if (!wasActive) return
      sendLiveRadioStatus({
        stationId,
        state: code === 0 ? 'stopped' : 'error',
        message: stderr.trim() || (signal ? `ffmpeg stopped (${signal})` : `ffmpeg exited with code ${code}`),
        attempt: 0,
      })
    })

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, 700)
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
      })
      child.stdout.once('data', () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      })
    })

    sendLiveRadioStatus({
      stationId,
      state: 'playing',
      message: streamUrl,
      attempt: 0,
    })
    setPlaybackState('playing')
    return { success: true }
  } catch (error) {
    stopLiveRadioNativePlayback(stationId)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
