import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OPUS_PROBE_FRAMES, oggOpusProbeSample, probeOggOpusDecoding, wavDataBytes } from './oggOpusSupport'

function wav(dataBytes: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}

function deps(result: Buffer | Error) {
  let dir = ''
  return {
    get dir() { return dir },
    value: {
      tempDir: async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puros-opus-test-')); return dir },
      decode: vi.fn(async (_input: string, output: string) => {
        if (result instanceof Error) throw result
        await fs.writeFile(output, result)
      }),
    },
  }
}

describe('Ogg Opus decode probe', () => {
  it('embeds a real Ogg Opus stream', () => {
    const sample = oggOpusProbeSample()
    expect(sample.subarray(0, 4).toString('ascii')).toBe('OggS')
    expect(sample.includes(Buffer.from('OpusHead'))).toBe(true)
  })

  it('accepts only a decode with the trimmed frame count, and cleans up', async () => {
    const ok = deps(wav(OPUS_PROBE_FRAMES * 4))
    expect(await probeOggOpusDecoding(ok.value)).toBe(true)
    await expect(fs.stat(ok.dir)).rejects.toThrow()
    // A decoder that ignores the 312-sample pre-skip and end trim is still within one frame; empty output is not.
    expect(await probeOggOpusDecoding(deps(wav(0)).value)).toBe(false)
    expect(await probeOggOpusDecoding(deps(Buffer.from('not a wav')).value)).toBe(false)
    const failing = deps(new Error('unsupported file type'))
    expect(await probeOggOpusDecoding(failing.value)).toBe(false)
    await expect(fs.stat(failing.dir)).rejects.toThrow()
  })

  it('reads the RIFF data chunk after padding chunks', () => {
    const padded = Buffer.concat([
      Buffer.from('RIFF\0\0\0\0WAVE', 'ascii'),
      Buffer.from('FLLR', 'ascii'), Buffer.from([4, 0, 0, 0]), Buffer.alloc(4),
      Buffer.from('data', 'ascii'), Buffer.from([8, 0, 0, 0]), Buffer.alloc(8),
    ])
    expect(wavDataBytes(padded)).toBe(8)
    expect(wavDataBytes(Buffer.from('nope'))).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('runs against the real AudioToolbox without throwing', async () => {
    expect(typeof await probeOggOpusDecoding()).toBe('boolean')
  })
})
