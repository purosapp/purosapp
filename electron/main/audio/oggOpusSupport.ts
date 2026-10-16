import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 0.2 s of a 440 Hz stereo tone as Ogg Opus (libopus, 48 kHz, 312-sample
 * pre-skip). Embedded so the probe needs no encoder; a correct decoder yields
 * exactly 9,600 frames after trimming pre-skip and end padding.
 */
const OPUS_PROBE_BASE64 = [
  'T2dnUwACAAAAAAAAAAAAAAAAAAAAABzVxfcBE09wdXNIZWFkAQI4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAAAAAAABAAAASZW+',
  'VAEuT3B1c1RhZ3MGAAAAZmZtcGVnAQAAABQAAABlbmNvZGVyPUxhdmMgbGlib3B1c09nZ1MABLgmAAAAAAAAAAAAAAIAAAAQ',
  'wLOsC05APzo+PUZEPjAefIf8uEuEg/0yaAApqKeqsPT4aKUygXsb8JzR8VEa3TecPgC69KeXazJnA6y1axr4EXkqpYar8rDA',
  'BybeEoJdJW27qP3fkhWxZpfOds5AfIf/MsPKsDaaM0jUhq6S4kJVM9vtsskMGvIu1h+2LuMfIClSgNGaSdPyrsgU4N73rXPZ',
  'QyiKpoRfM32U3fDb8HyIAmQBY7hqkLHFgfZHZsw1edH7RuTwoAM2nhVvdN6E0YFZ6348Glbyjemme+Sv7YnFAN405FgxxeW3',
  'AYTwynyIAmQBY7hqkFJnr2+W3lNzx1JhbBKawkc4GN1+pbfIAf2TdE1Li/WLlF9MXIU6rzSK9+UMWPoBBA98iAJkAWOn25w5',
  'BQYuvO4khPRcbvHX/ULAMYmLQkuOm7E63E1a3DuwlstD6JEgv6Zaw4KHz8E7Yq0Z90KEynyIAmQBY7hqkLTwrDJOGlPE0eOx',
  'fXJ8OL+jhtE4MX5/q9kaeiv4FGFv6VQB0ehGyf2pRmuYr2PSFdOMTM98iAJkAWOnu2+m9wYNOplcUpqqpG/+98Y5rEdKOmdl',
  'exwqZ9vM1UhjfQ4Rwk/JJob8tQGeDbOUAG6/7Lbr/ZTsHZTd8NgPfIgCZAFjuIq9R24YGBOPGzwdIzfCMlCvvb6N0I165fSA',
  'mQe0JfbajieLc2vfoUP8RVgwphDpEl6lXUFQf/9ltwGE8Mp8iAJkAWOnu29qS0nh3kLxtSQlAuAIBAB+xyWtEcFn2uIXBECg',
  'Vy25NFWwE0yn/XJYet03BxtwUQGLHm3wD0yIAmJaILZ5GBlQB5q3OMf2u9sI0q2LYX8h1n8WPaZuh1P6Fw88kd42ECmmd9oB',
  'gEwIAdsnQFAHzgM6erI/Mp0US3g1BMtiix30r+e44A==',
].join('')
export const OPUS_PROBE_FRAMES = 9_600
const PROBE_TIMEOUT_MS = 10_000

export interface OggOpusProbeDeps {
  /** Decode `input` to 16-bit little-endian WAV at `output` through the system AudioToolbox. */
  decode(input: string, output: string): Promise<void>
  tempDir(): Promise<string>
}

export function oggOpusProbeSample(): Buffer {
  return Buffer.from(OPUS_PROBE_BASE64, 'base64')
}

/** Byte length of the first RIFF `data` chunk, or null when the file is not a WAV. */
export function wavDataBytes(wav: Buffer): number | null {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return Math.min(size, wav.length - offset - 8)
    offset += 8 + size + (size % 2)
  }
  return null
}

const defaultDeps: OggOpusProbeDeps = {
  decode(input, output) {
    return new Promise((resolve, reject) => {
      // afconvert decodes through the same AudioToolbox converters as ExtAudioFile in the engine.
      execFile('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', input, output], { timeout: PROBE_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve()))
    })
  },
  tempDir: () => fs.mkdtemp(path.join(os.tmpdir(), 'puros-opus-probe-')),
}

/**
 * Whether this Mac's AudioToolbox decodes Ogg Opus with correct pre-skip and
 * end trimming. The Ogg file type is not public API, so it is probed once per
 * run instead of being inferred from the macOS version. Opus inside WebM/MP4
 * is never opened by the engine; providers remux such streams to Ogg first.
 */
export async function probeOggOpusDecoding(deps: OggOpusProbeDeps = defaultDeps): Promise<boolean> {
  let directory: string | null = null
  try {
    directory = await deps.tempDir()
    const input = path.join(directory, 'probe.opus')
    const output = path.join(directory, 'probe.wav')
    await fs.writeFile(input, oggOpusProbeSample())
    await deps.decode(input, output)
    const bytes = wavDataBytes(await fs.readFile(output))
    // Stereo 16-bit: 4 bytes per frame. Allow one Opus frame (20 ms) of slack for decoder differences.
    return bytes !== null && Math.abs(bytes / 4 - OPUS_PROBE_FRAMES) <= 960
  } catch (error) {
    console.info('[Puros][Audio] Ogg Opus is not decodable by this system:', error instanceof Error ? error.message : error)
    return false
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

let cached: Promise<boolean> | null = null

export function canDecodeOggOpus(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  cached ??= probeOggOpusDecoding()
  return cached
}
