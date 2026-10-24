import { describe, expect, it } from 'vitest'
import { createFfmpegLogReader } from './ffmpegLog'

// Captured from the bundled ffmpeg with `-loglevel level+info`.
const BANNER = [
  "[info] Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'https://example.com/stream':",
  '[info]   Duration: N/A, start: 0.047891, bitrate: 64 kb/s',
  '[info]   Stream #0:0[0x1](eng): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 63 kb/s (default)',
  '[info] Stream mapping:',
  '[info]   Stream #0:0 -> #0:0 (aac (native) -> pcm_s16le (native))',
  "[info] Output #0, s16le, to 'pipe:1':",
  '[info]   Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo, s16, 1411 kb/s (default)',
  '',
].join('\n')

describe('createFfmpegLogReader', () => {
  it('reports the input codec once, never the PCM output stream', () => {
    const codecs: string[] = []
    const reader = createFfmpegLogReader((codec) => codecs.push(codec))
    // Split mid-line, as pipe chunks arrive.
    reader.push(BANNER.slice(0, 120))
    reader.push(BANNER.slice(120))
    reader.push('[info]   Stream #0:0: Audio: mp3, 44100 Hz\n')
    expect(codecs).toEqual(['aac'])
    expect(reader.problems()).toBe('')
  })

  it('keeps warnings and errors for status messages, without the level tags', () => {
    const reader = createFfmpegLogReader(() => {})
    reader.push('[in#0 @ 0xabf00c000] [error] Error opening input: No such file or directory\n')
    reader.push('[fatal] Error opening input files: No such file or directory')
    expect(reader.problems()).toBe(
      '[in#0 @ 0xabf00c000] Error opening input: No such file or directory\nError opening input files: No such file or directory',
    )
  })
})
