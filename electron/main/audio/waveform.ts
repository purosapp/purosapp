/**
 * Seek-bar waveforms: a loudness envelope of the playing file, decoded by a
 * separate low-priority ffmpeg so the audio engine never shares its work.
 *
 * Finished files are read through an inherited descriptor. A provider's
 * growing file is tailed into ffmpeg's stdin as it is written, so its
 * waveform fills in alongside the download; the descriptor stays valid when
 * the provider renames the file on completion.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'
import { getFfmpegPath } from './ffmpegPath'

/** Mono analysis rate: ample for a loudness envelope and cheap to produce. */
const ANALYSIS_RATE = 8000
const EMIT_INTERVAL_MS = 150
const TAIL_POLL_MS = 300
const TAIL_READ_BYTES = 256 * 1024
/** A growing file that stops changing for this long is treated as finished. */
const TAIL_IDLE_LIMIT_MS = 5 * 60_000
const CACHE_LIMIT = 32

export interface WaveformRequest {
  path: string
  /** Still being written by a provider; finishWaveformSource() marks the end. */
  growing: boolean
  startSeconds: number
  /** Length of a CUE slice; null reads to the end of the file. */
  durationSeconds: number | null
  binSeconds: number
}

export interface WaveformChunk {
  requestId: string
  binSeconds: number
  /** Index of the first bin in `bins`; later chunks may rewrite earlier bins. */
  offset: number
  bins: number[]
  done: boolean
  error?: string
}

const cache = new Map<string, Float32Array>()
const jobs = new Map<string, WaveformJob>()

function remember(key: string, bins: Float32Array) {
  cache.delete(key)
  cache.set(key, bins)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}

function sanitizeRequest(raw: unknown): WaveformRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.path !== 'string' || !path.isAbsolute(r.path)) return null
  const binSeconds = Number(r.binSeconds)
  const startSeconds = Number(r.startSeconds ?? 0)
  const durationSeconds = r.durationSeconds == null ? null : Number(r.durationSeconds)
  if (!Number.isFinite(binSeconds) || binSeconds < 0.01 || binSeconds > 5) return null
  if (!Number.isFinite(startSeconds) || startSeconds < 0) return null
  if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) return null
  return { path: r.path, growing: r.growing === true, startSeconds, durationSeconds, binSeconds }
}

class WaveformJob {
  private cancelled = false
  private sourceComplete: boolean
  private child: ChildProcess | null = null
  private handle: fs.promises.FileHandle | null = null
  private bins: number[] = []
  private emitted = 0
  private emitTimer: NodeJS.Timeout | null = null
  private readonly samplesPerBin: number
  private sumSquares = 0
  private sampleCount = 0
  private remainder: Buffer | null = null

  constructor(
    readonly requestId: string,
    readonly sender: WebContents,
    private readonly request: WaveformRequest,
  ) {
    this.sourceComplete = !request.growing
    this.samplesPerBin = Math.max(1, Math.round(request.binSeconds * ANALYSIS_RATE))
  }

  finishSource() {
    this.sourceComplete = true
  }

  cancel() {
    this.cancelled = true
    this.child?.kill('SIGKILL')
    this.stopEmitting()
  }

  async run() {
    try {
      this.handle = await fs.promises.open(this.request.path, 'r')
      const cacheKey = await this.cacheKey()
      const cached = cacheKey ? cache.get(cacheKey) : undefined
      if (cached) {
        this.bins = Array.from(cached)
        this.flush(true)
        return
      }

      this.startEmitting()
      // ffmpeg exits cleanly without output for input it cannot demux.
      let ok = await this.decode(this.request.growing) && this.bins.length > 0
      // A container that needs seeking (e.g. MP4 with a trailing index) cannot
      // be read as a stream; read it again once the provider has finished it.
      if (!ok && this.request.growing && !this.cancelled && await this.waitForSourceComplete()) {
        this.resetAccumulator()
        ok = await this.decode(false)
      }
      if (this.cancelled) return
      this.stopEmitting()
      if (!ok && this.bins.length === 0) {
        this.send({ offset: 0, bins: [], done: true, error: 'Waveform analysis failed' })
        return
      }
      if (ok && cacheKey) remember(cacheKey, Float32Array.from(this.bins))
      this.flush(true)
    } catch (error) {
      if (!this.cancelled) {
        this.stopEmitting()
        this.send({ offset: 0, bins: [], done: true, error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      this.stopEmitting()
      await this.handle?.close().catch(() => undefined)
      this.handle = null
      if (jobs.get(this.requestId) === this) jobs.delete(this.requestId)
    }
  }

  private async cacheKey(): Promise<string | null> {
    if (this.request.growing || !this.handle) return null
    const stat = await this.handle.stat()
    const { startSeconds, durationSeconds, binSeconds } = this.request
    return [this.request.path, stat.size, stat.mtimeMs, startSeconds, durationSeconds ?? '', binSeconds].join('|')
  }

  private async waitForSourceComplete(): Promise<boolean> {
    const started = Date.now()
    while (!this.cancelled && !this.sourceComplete) {
      if (Date.now() - started > TAIL_IDLE_LIMIT_MS) return false
      await new Promise((resolve) => setTimeout(resolve, TAIL_POLL_MS))
    }
    return !this.cancelled
  }

  private decode(tail: boolean): Promise<boolean> {
    const { startSeconds, durationSeconds } = this.request
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-threads', '1']
    if (!tail && startSeconds > 0) args.push('-ss', String(startSeconds))
    args.push('-i', tail ? 'pipe:0' : 'file:/dev/fd/3')
    if (durationSeconds !== null) args.push('-t', String(durationSeconds))
    args.push('-vn', '-sn', '-dn', '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', 'pipe:1')

    return new Promise((resolve) => {
      let settled = false
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      let child: ChildProcess
      try {
        child = spawn(getFfmpegPath(), args, {
          stdio: [tail ? 'pipe' : 'ignore', 'pipe', 'ignore', tail ? 'ignore' : this.handle!.fd],
        })
      } catch {
        settle(false)
        return
      }
      this.child = child
      // Lowest CPU priority: the analysis may take as long as it likes.
      if (child.pid) {
        try { os.setPriority(child.pid, 19) } catch { /* already exited */ }
      }
      child.stdout!.on('data', (chunk: Buffer) => this.consume(chunk))
      child.on('error', () => settle(false))
      child.on('close', (code) => {
        if (this.child === child) this.child = null
        this.finishBin()
        settle(code === 0 && !this.cancelled)
      })
      if (tail) {
        child.stdin!.on('error', () => undefined)
        void this.pump(child)
      }
    })
  }

  /** Feeds the growing file to ffmpeg as it is written. */
  private async pump(child: ChildProcess) {
    const stdin = child.stdin!
    let position = 0
    let lastGrowth = Date.now()
    try {
      while (!this.cancelled && this.child === child && !stdin.destroyed) {
        const completeBeforeRead = this.sourceComplete
        const buffer = Buffer.allocUnsafe(TAIL_READ_BYTES)
        const { bytesRead } = await this.handle!.read(buffer, 0, buffer.length, position)
        if (bytesRead > 0) {
          position += bytesRead
          lastGrowth = Date.now()
          if (!stdin.write(buffer.subarray(0, bytesRead))) {
            await new Promise<void>((resolve) => {
              const done = () => {
                stdin.off('drain', done)
                stdin.off('close', done)
                resolve()
              }
              stdin.once('drain', done)
              stdin.once('close', done)
            })
          }
          continue
        }
        if (completeBeforeRead) break
        if (Date.now() - lastGrowth > TAIL_IDLE_LIMIT_MS) break
        await new Promise((resolve) => setTimeout(resolve, TAIL_POLL_MS))
      }
    } catch {
      // The file vanished or ffmpeg exited; close() reports the outcome.
    }
    stdin.end()
  }

  private consume(chunk: Buffer) {
    let data = this.remainder ? Buffer.concat([this.remainder, chunk]) : chunk
    const sampleCount = data.length >> 2
    this.remainder = data.length & 3 ? Buffer.from(data.subarray(sampleCount << 2)) : null
    if (data.byteOffset & 3) data = Buffer.from(data.subarray(0, sampleCount << 2))
    const samples = new Float32Array(data.buffer, data.byteOffset, sampleCount)
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]
      this.sumSquares += s * s
      if (++this.sampleCount === this.samplesPerBin) this.pushBin()
    }
  }

  private pushBin() {
    this.bins.push(Math.sqrt(this.sumSquares / Math.max(1, this.sampleCount)))
    this.sumSquares = 0
    this.sampleCount = 0
  }

  /** Keeps a trailing partial bin unless it is too short to mean anything. */
  private finishBin() {
    if (this.sampleCount >= this.samplesPerBin / 4) this.pushBin()
    this.sumSquares = 0
    this.sampleCount = 0
    this.remainder = null
  }

  private resetAccumulator() {
    this.sumSquares = 0
    this.sampleCount = 0
    this.remainder = null
    // Bins are rewritten in place from the start; the renderer overwrites them.
    this.bins = []
    this.emitted = 0
  }

  private startEmitting() {
    this.emitTimer = setInterval(() => this.flush(false), EMIT_INTERVAL_MS)
  }

  private stopEmitting() {
    if (this.emitTimer) clearInterval(this.emitTimer)
    this.emitTimer = null
  }

  private flush(done: boolean) {
    if (this.cancelled) return
    if (!done && this.emitted >= this.bins.length) return
    const offset = this.emitted
    this.emitted = this.bins.length
    this.send({ offset, bins: this.bins.slice(offset), done })
  }

  private send(chunk: Omit<WaveformChunk, 'requestId' | 'binSeconds'>) {
    if (this.sender.isDestroyed()) return
    this.sender.send('waveform:chunk', {
      requestId: this.requestId,
      binSeconds: this.request.binSeconds,
      ...chunk,
    } satisfies WaveformChunk)
  }
}

/** Starts analysing a file; one waveform per window, so older requests stop. */
export function startWaveform(sender: WebContents, requestId: unknown, rawRequest: unknown): boolean {
  const request = sanitizeRequest(rawRequest)
  if (typeof requestId !== 'string' || !requestId || !request) return false
  for (const job of jobs.values()) {
    if (job.sender === sender) job.cancel()
  }
  const job = new WaveformJob(requestId, sender, request)
  jobs.set(requestId, job)
  void job.run()
  return true
}

/** The growing file a request reads is now complete. */
export function finishWaveformSource(requestId: unknown) {
  if (typeof requestId === 'string') jobs.get(requestId)?.finishSource()
}

export function cancelWaveform(requestId: unknown) {
  if (typeof requestId !== 'string') return
  jobs.get(requestId)?.cancel()
  jobs.delete(requestId)
}

export function cancelAllWaveforms() {
  for (const job of jobs.values()) job.cancel()
  jobs.clear()
}
