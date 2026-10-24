import { parseFfmpegAudioCodec } from '../../../src/services/restoreSettings'

/**
 * Reads ffmpeg's level-tagged stderr (`-loglevel level+info`): the input stream's
 * codec is reported once, warnings and errors are kept for status messages.
 */
export function createFfmpegLogReader(onCodec: (codec: string) => void) {
  let partial = ''
  let inInput = false
  let codecReported = false
  let problems = ''
  return {
    push(chunk: string) {
      partial += chunk
      const lines = partial.split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) {
        const level = line.match(/\[(info|warning|error|fatal|panic)\]\s?/)
        if (level && level[1] !== 'info') {
          problems += `${line.replace(level[0], '')}\n`
          if (problems.length > 4000) problems = problems.slice(-4000)
          continue
        }
        if (/Input #\d+/.test(line)) inInput = true
        else if (/Output #\d+|Stream mapping:/.test(line)) inInput = false
        if (!inInput || codecReported) continue
        const codec = parseFfmpegAudioCodec(line)
        if (!codec) continue
        codecReported = true
        onCodec(codec)
      }
    },
    /** Warnings and errors so far, including an unterminated last line (ffmpeg exiting). */
    problems: () => {
      const level = partial.match(/\[(warning|error|fatal|panic)\]\s?/)
      return level ? `${problems}${partial.replace(level[0], '')}` : problems
    },
  }
}
