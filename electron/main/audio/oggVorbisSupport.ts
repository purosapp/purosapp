import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getFfmpegPath } from './ffmpegPath'

/** 0.2 s of 44.1 kHz stereo s16 silence. */
const PROBE_PCM_BYTES = 44_100 * 4 / 5
const PROBE_TIMEOUT_MS = 10_000

export interface OggVorbisProbeDeps {
  /** Encode `pcm` (s16le, 44.1 kHz, stereo) into an Ogg Vorbis file at `output`. */
  encode(pcm: Buffer, output: string): Promise<void>
  /** Decode `input` to WAV at `output` through the system AudioToolbox. */
  decode(input: string, output: string): Promise<void>
  tempDir(): Promise<string>
}

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), PROBE_TIMEOUT_MS) }),
  ]).finally(() => clearTimeout(timer))
}

const defaultDeps: OggVorbisProbeDeps = {
  encode(pcm, output) {
    return new Promise((resolve, reject) => {
      // The pinned LGPL build carries ffmpeg's native (experimental) Vorbis encoder.
      const child = spawn(getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
        '-c:a', 'vorbis', '-strict', '-2', '-f', 'ogg', '-y', output,
      ], { stdio: ['pipe', 'ignore', 'ignore'] })
      child.once('error', reject)
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))))
      child.stdin.end(pcm)
    })
  },
  decode(input, output) {
    return new Promise((resolve, reject) => {
      // afconvert decodes through the same AudioToolbox converters as ExtAudioFile in the engine.
      execFile('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', input, output], (error) => (error ? reject(error) : resolve()))
    })
  },
  tempDir: () => fs.mkdtemp(path.join(os.tmpdir(), 'puros-vorbis-probe-')),
}

/**
 * Whether this Mac's AudioToolbox decodes Ogg Vorbis. Recent macOS does, but
 * neither the format nor the Ogg file type is public API, so it is probed once
 * per run by decoding a generated sample rather than assumed from the version.
 */
export async function probeOggVorbisDecoding(deps: OggVorbisProbeDeps = defaultDeps): Promise<boolean> {
  let directory: string | null = null
  try {
    directory = await deps.tempDir()
    const ogg = path.join(directory, 'probe.ogg')
    const wav = path.join(directory, 'probe.wav')
    await withTimeout(deps.encode(Buffer.alloc(PROBE_PCM_BYTES), ogg), 'Vorbis probe encode')
    await withTimeout(deps.decode(ogg, wav), 'Vorbis probe decode')
    // A WAV header alone is 44 bytes; a real decode carries PCM after it.
    return (await fs.stat(wav)).size > 44
  } catch (error) {
    console.info('[Puros][Audio] Ogg Vorbis is not decodable by this system:', error instanceof Error ? error.message : error)
    return false
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

let cached: Promise<boolean> | null = null

export function canDecodeOggVorbis(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  cached ??= probeOggVorbisDecoding()
  return cached
}
