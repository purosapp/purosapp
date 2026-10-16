import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { probeOggVorbisDecoding } from './oggVorbisSupport'

vi.mock('./ffmpegPath', () => ({ getFfmpegPath: () => path.resolve('build/audio/ffmpeg') }))

function deps(decodeBytes: number | Error) {
  let dir = ''
  return {
    get dir() { return dir },
    value: {
      tempDir: async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puros-vorbis-test-')); return dir },
      encode: vi.fn(async (_pcm: Buffer, output: string) => { await fs.writeFile(output, 'OggS') }),
      decode: vi.fn(async (_input: string, output: string) => {
        if (decodeBytes instanceof Error) throw decodeBytes
        await fs.writeFile(output, Buffer.alloc(decodeBytes))
      }),
    },
  }
}

describe('Ogg Vorbis decode probe', () => {
  it('reports support only when the system decoder produced PCM, and cleans up', async () => {
    const ok = deps(4_000)
    expect(await probeOggVorbisDecoding(ok.value)).toBe(true)
    await expect(fs.stat(ok.dir)).rejects.toThrow()

    expect(await probeOggVorbisDecoding(deps(44).value)).toBe(false)
    const failing = deps(new Error('unsupported file type'))
    expect(await probeOggVorbisDecoding(failing.value)).toBe(false)
    await expect(fs.stat(failing.dir)).rejects.toThrow()
  })

  it.runIf(process.platform === 'darwin')('runs against the real ffmpeg and AudioToolbox without throwing', async () => {
    await fs.access(path.resolve('build/audio/ffmpeg')).then(async () => {
      expect(typeof await probeOggVorbisDecoding()).toBe('boolean')
    }, () => {})
  })
})
