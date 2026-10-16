import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureSelfContainedFfmpeg, verifySelfContainedFfmpeg } from './build-ffmpeg.mjs'
import { discoverProviders } from './providers.mjs'

/** A 1-bit stereo DSF (DSD64) file holding DSD silence, per the Sony DSF 1.01 layout. */
export function createDsfFixture(blocksPerChannel = 16) {
  const channels = 2
  const blockSize = 4096
  const dataBytes = blocksPerChannel * blockSize * channels
  const header = Buffer.alloc(28 + 52 + 12)
  header.write('DSD ', 0, 'latin1')
  header.writeBigUInt64LE(28n, 4)
  header.writeBigUInt64LE(BigInt(header.length + dataBytes), 12)
  header.writeBigUInt64LE(0n, 20)
  header.write('fmt ', 28, 'latin1')
  header.writeBigUInt64LE(52n, 32)
  header.writeUInt32LE(1, 40) // format version
  header.writeUInt32LE(0, 44) // DSD raw
  header.writeUInt32LE(2, 48) // stereo
  header.writeUInt32LE(channels, 52)
  header.writeUInt32LE(2_822_400, 56)
  header.writeUInt32LE(1, 60) // LSB-first bits per sample
  header.writeBigUInt64LE(BigInt(blocksPerChannel * blockSize * 8), 64)
  header.writeUInt32LE(blockSize, 72)
  header.write('data', 80, 'latin1')
  header.writeBigUInt64LE(BigInt(12 + dataBytes), 84)
  return Buffer.concat([header, Buffer.alloc(dataBytes, 0x69)])
}

/** 16-bit stereo PCM WAV with a 440 Hz tone. */
export function createWavFixture(seconds = 1, sampleRate = 44_100) {
  const frames = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(frames * 4)
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 12_000)
    data.writeInt16LE(value, frame * 4)
    data.writeInt16LE(value, frame * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function runFfmpeg(ffmpeg, args, label) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (${result.status ?? result.error?.message}): ${(result.stderr ?? '').trim().slice(-1500)}`)
  }
  return result
}

/** Container signatures of the stream-copy outputs provider helpers declare with `-f`. */
const OUTPUT_SIGNATURES = {
  flac: { offset: 0, magic: 'fLaC' },
  ogg: { offset: 0, magic: 'OggS' },
  ipod: { offset: 4, magic: 'ftyp' },
  mp4: { offset: 4, magic: 'ftyp' },
}

function assertContainer(filePath, format, label) {
  const signature = OUTPUT_SIGNATURES[format]
  const bytes = fs.readFileSync(filePath)
  if (!signature || bytes.length < 100 || bytes.toString('latin1', signature.offset, signature.offset + 4) !== signature.magic) {
    throw new Error(`${label} did not produce a ${format} file`)
  }
}

// Mirrors electron/main/audio/localPlayback.ts (local DSD → PCM preparation).
export function verifyDsdPreparation(ffmpeg, work) {
  const input = path.join(work, 'fixture.dsf')
  const output = path.join(work, 'dsd.wav')
  fs.writeFileSync(input, createDsfFixture())
  runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-map_metadata', '-1',
    '-c:a', 'pcm_f32le', '-ar', '88200', '-ac', '2', output], 'DSD→PCM preparation')
  const wav = fs.readFileSync(output)
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.readUInt32LE(24) !== 88_200 || wav.length < 10_000) {
    throw new Error('DSD→PCM preparation produced an unexpected WAV')
  }
}

// Mirrors electron/main/liveRadio/nativePlayback.ts: HTTP input with reconnect and ICY header, raw PCM on stdout.
export async function verifyLiveRadio(ffmpeg, work) {
  const aac = path.join(work, 'radio.aac')
  runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(work, 'tone.wav'), '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', aac], 'AAC fixture')
  const body = fs.readFileSync(aac)
  let sawIcyHeader = false
  const server = http.createServer((request, response) => {
    sawIcyHeader ||= request.headers['icy-metadata'] === '1'
    response.writeHead(200, { 'Content-Type': 'audio/aac', 'Content-Length': body.length })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/stream`
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-reconnect', '1', '-reconnect_streamed', '1',
      '-reconnect_delay_max', '8', '-headers', 'Icy-MetaData: 1\r\n', '-i', url, '-vn', '-map_metadata', '-1',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let pcmBytes = 0
    let stderr = ''
    child.stdout.on('data', (chunk) => { pcmBytes += chunk.length })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Live-radio ffmpeg timed out')) }, 30_000)
      child.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    })
    if (code !== 0) throw new Error(`Live-radio decode failed (${code}): ${stderr.trim().slice(-1500)}`)
    // One second of 48 kHz stereo s16 is 192,000 bytes; allow for AAC priming/padding.
    if (pcmBytes < 150_000) throw new Error(`Live-radio decode produced only ${pcmBytes} PCM bytes`)
    if (!sawIcyHeader) throw new Error('Live-radio request did not carry the Icy-MetaData header')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// Every manifest-declared ffmpeg helper is run with its exact declared argv. The input is the
// stream its declared output container carries: FLAC-in-MP4 for `-f flac` (or no `-f`), Opus-in-WebM for
// `-f ogg`, AAC-in-MP4 for `-f ipod`/`-f mp4`; probe-only helpers get the FLAC-in-MP4 file.
export function verifyProviderHelpers(ffmpeg, work) {
  const tone = path.join(work, 'tone.wav')
  const inputs = {
    flac: path.join(work, 'track.m4a'),
    ogg: path.join(work, 'track.webm'),
    ipod: path.join(work, 'track-aac.m4a'),
  }
  inputs.mp4 = inputs.ipod
  runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tone, '-c:a', 'flac', '-f', 'mp4', inputs.flac], 'FLAC-in-MP4 fixture')
  // The native Opus encoder is experimental; it only makes a fixture here.
  runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tone, '-ar', '48000', '-c:a', 'opus', '-strict', '-2', '-b:a', '96k', '-f', 'webm', inputs.ogg], 'Opus-in-WebM fixture')
  runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tone, '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', inputs.ipod], 'AAC-in-MP4 fixture')
  const checked = []
  for (const { manifest } of discoverProviders()) {
    for (const helper of manifest.permissions?.helpers ?? []) {
      if (path.basename(helper.executable) !== 'ffmpeg') continue
      const label = `${manifest.id} helper ${helper.id}`
      if (helper.argumentTemplate) {
        const formatIndex = helper.argumentTemplate.indexOf('-f')
        // Without `-f`, ffmpeg picks the container from the output name; those helpers write FLAC.
        const format = formatIndex >= 0 ? helper.argumentTemplate[formatIndex + 1] : 'flac'
        const writes = helper.argumentTemplate.some((part) => part?.cachePath === 'output')
        const input = writes ? inputs[format] : inputs.flac
        if (!input) throw new Error(`${label} declares an output format the verifier has no fixture for: ${format}`)
        const output = path.join(work, `${manifest.id}-${helper.id}.${format}`)
        fs.rmSync(output, { force: true })
        const args = helper.argumentTemplate.map((part) => typeof part === 'string' ? part : part.cachePath === 'input' ? input : output)
        const result = runFfmpeg(ffmpeg, args, label)
        if (writes) assertContainer(output, format, label)
        else if (!/Duration:\s*\d/.test(result.stderr)) throw new Error(`${label} did not report a duration`)
      } else {
        for (const argument of helper.allowedArguments ?? []) runFfmpeg(ffmpeg, [argument], `${label} ${argument}`)
      }
      checked.push(label)
    }
  }
  return checked
}

export async function verifyFfmpegForPuros(ffmpeg) {
  const archs = verifySelfContainedFfmpeg(ffmpeg)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-ffmpeg-verify-'))
  try {
    fs.writeFileSync(path.join(work, 'tone.wav'), createWavFixture())
    verifyDsdPreparation(ffmpeg, work)
    await verifyLiveRadio(ffmpeg, work)
    const helpers = verifyProviderHelpers(ffmpeg, work)
    return { archs, helpers }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ffmpeg = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ensureSelfContainedFfmpeg(), 'ffmpeg')
  const { archs, helpers } = await verifyFfmpegForPuros(ffmpeg)
  console.log(`ffmpeg verified (${archs.join('+')}): self-contained LGPL build; DSD→PCM, live-radio HTTP decode${helpers.length ? `, ${helpers.join(', ')}` : ''}.`)
}
