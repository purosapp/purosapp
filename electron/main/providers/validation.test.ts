import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertProviderValue, toProviderError, validatePlaybackArtifact, validateProviderManifest } from './validation'

const temporaryRoots: string[] = []
const manifest = {
  schemaVersion: 1,
  apiVersion: 1,
  id: 'fixture',
  version: '1.0.0',
  displayName: 'Fixture',
  icon: 'assets/icon.svg',
  brandColor: '#123456',
  defaultPriority: 10,
  capabilities: ['catalog.search'],
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('provider boundary validation', () => {
  it('validates the example manifest and rejects reserved IDs', () => {
    expect(validateProviderManifest(manifest).ok).toBe(true)
    expect(validateProviderManifest({ ...manifest, id: 'local' }).ok).toBe(false)
  })

  it('requires library.sync when a provider opts into core-owned mirroring', () => {
    expect(validateProviderManifest({ ...manifest, librarySyncMode: 'host-mirror' }).ok).toBe(false)
    expect(validateProviderManifest({ ...manifest, capabilities: ['library.sync'], librarySyncMode: 'host-mirror' }).ok).toBe(true)
    expect(validateProviderManifest({ ...manifest, capabilities: ['library.sync'], librarySyncMode: 'unknown' }).ok).toBe(false)
  })

  it('bounds a playback-only manifest deadline', () => {
    expect(validateProviderManifest({ ...manifest, playbackTimeoutMs: 180_000 }).ok).toBe(false)
    const playable = { ...manifest, capabilities: ['playback.resolve'] }
    expect(validateProviderManifest({ ...playable, playbackTimeoutMs: 180_000 }).ok).toBe(true)
    expect(validateProviderManifest({ ...playable, playbackTimeoutMs: 119_999 }).ok).toBe(false)
    expect(validateProviderManifest({ ...playable, playbackTimeoutMs: 1_800_001 }).ok).toBe(false)
    expect(validateProviderManifest({ ...playable, playbackTimeoutMs: 180_000.5 }).ok).toBe(false)
  })

  it('validates exact helper templates with one cache input and optional output', () => {
    const helper = {
      id: 'remux', executable: 'helper/dist/ffmpeg',
      argumentTemplate: ['-i', { cachePath: 'input' }, { cachePath: 'output' }],
    }
    expect(validateProviderManifest({ ...manifest, permissions: { helpers: [helper] } }).ok).toBe(true)
    expect(validateProviderManifest({ ...manifest, permissions: { helpers: [{ ...helper, allowedArguments: ['-i'] }] } }).ok).toBe(false)
    expect(validateProviderManifest({ ...manifest, permissions: { helpers: [{ ...helper, argumentTemplate: ['-i', { cachePath: 'input' }] }] } }).ok).toBe(true)
    expect(validateProviderManifest({ ...manifest, permissions: { helpers: [{ ...helper, argumentTemplate: ['-i', { cachePath: 'output' }] }] } }).ok).toBe(false)
    expect(validateProviderManifest({ ...manifest, permissions: { helpers: [{ ...helper, argumentTemplate: ['-i', { cachePath: 'input' }, { cachePath: 'input' }] }] } }).ok).toBe(false)
  })

  it('accepts known required host features and rejects unknown or duplicated ones', () => {
    expect(validateProviderManifest({ ...manifest, requiredHostFeatures: ['audio-format.vorbis', 'playback.source-format'] }).ok).toBe(true)
    const unknown = validateProviderManifest({ ...manifest, requiredHostFeatures: ['playback.pcm-sink'] })
    expect(unknown).toMatchObject({ ok: false, errors: [expect.stringContaining('playback.pcm-sink')] })
    expect(validateProviderManifest({ ...manifest, requiredHostFeatures: ['audio-format.vorbis', 'audio-format.vorbis'] }).ok).toBe(false)
    expect(validateProviderManifest({ ...manifest, requiredHostFeatures: 'audio-format.vorbis' }).ok).toBe(false)
  })

  it('allows only the declared best-effort helper scheduling mode', () => {
    const helper = { id: 'ffmpeg', executable: 'helper/dist/ffmpeg', allowedArguments: ['-version'] }
    expect(validateProviderManifest({ ...manifest, permissions: { helpers: [{ ...helper, processPriority: 'below-normal' }] } }).ok).toBe(true)
    expect(validateProviderManifest({ ...manifest, permissions: { helpers: [{ ...helper, processPriority: 'realtime' }] } }).ok).toBe(false)
  })

  it('rejects cycles and non-finite numbers at the clone boundary', () => {
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(() => assertProviderValue(cyclic)).toThrow(/cycles/)
    expect(() => assertProviderValue({ value: Number.NaN })).toThrow(/finite/)
  })

  it('accepts playback files only from the granted provider cache root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-provider-validation-'))
    temporaryRoots.push(root)
    const allowed = path.join(root, 'allowed.wav')
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.wav`)
    fs.writeFileSync(allowed, 'fixture')
    fs.writeFileSync(outside, 'fixture')
    temporaryRoots.push(outside)
    const format = {
      format: 'WAV' as const,
      sampleRate: 48_000,
      bitDepth: 16,
      bitrate: 768_000,
      channels: 1,
      isLossless: true,
      isHiRes: false,
      isMqa: false,
      isDsd: false,
    }
    expect(validatePlaybackArtifact({ path: allowed, lifecycle: 'complete', format }, root, false).path).toBe(fs.realpathSync(allowed))
    expect(validatePlaybackArtifact({ path: allowed, lifecycle: 'complete', format, sessionId: 'session-123' }, root, false).sessionId).toBe('session-123')
    expect(() => validatePlaybackArtifact({ path: allowed, lifecycle: 'complete', format, sessionId: '../escape' }, root, false)).toThrow(/session ID/)
    expect(() => validatePlaybackArtifact({ path: outside, lifecycle: 'complete', format }, root, false)).toThrow(/outside/)
    const sourceFormat = { ...format, format: 'VORBIS' as const, bitrate: 320, bitDepth: 0, isLossless: false, isHiRes: false }
    expect(validatePlaybackArtifact({ path: allowed, lifecycle: 'complete', format, sourceFormat }, root, false).sourceFormat).toEqual(sourceFormat)
    expect(() => validatePlaybackArtifact({
      path: allowed, lifecycle: 'complete', format, sourceFormat: { ...sourceFormat, format: 'WMA' as never },
    }, root, false)).toThrow(/audio format/)
  })

  it('accepts Opus only at its 48 kHz decode rate and never labels lossy codecs lossless or Hi-Res', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-provider-validation-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'track.opus')
    fs.writeFileSync(file, 'fixture')
    const opus = {
      format: 'OPUS' as const, sampleRate: 48_000, bitDepth: 0, bitrate: 160, channels: 2,
      isLossless: false, isHiRes: false, isMqa: false, isDsd: false,
    }
    const artifact = (sourceFormat: typeof opus) => ({ path: file, lifecycle: 'complete' as const, format: opus, sourceFormat })
    expect(validatePlaybackArtifact(artifact(opus), root, false).sourceFormat).toEqual(opus)
    expect(() => validatePlaybackArtifact(artifact({ ...opus, sampleRate: 44_100 }), root, false)).toThrow(/48 kHz/)
    expect(() => validatePlaybackArtifact(artifact({ ...opus, isLossless: true }), root, false)).toThrow(/lossy/)
    expect(() => validatePlaybackArtifact(artifact({ ...opus, format: 'AAC' as never, isHiRes: true }), root, false)).toThrow(/lossy/)
  })

  it('validates form settings and requires the settings.form host feature', () => {
    const form = {
      id: 'import', label: 'Import', type: 'form',
      instructions: ['Paste the export.'],
      fields: [{ id: 'cookies', label: 'Cookies', multiline: true, sensitive: true, required: true, maxLength: 65_536 }],
      submit: { label: 'Connect', capability: 'auth', method: 'login' },
    }
    const withAuth = { ...manifest, capabilities: ['auth'], requiredHostFeatures: ['settings.form'] }
    expect(validateProviderManifest({ ...withAuth, settings: [form] }).ok).toBe(true)
    expect(validateProviderManifest({ ...withAuth, requiredHostFeatures: [], settings: [form] })).toMatchObject({
      ok: false, errors: [expect.stringContaining('settings.form')],
    })
    expect(validateProviderManifest({ ...withAuth, settings: [{ ...form, fields: [] }] }).ok).toBe(false)
    expect(validateProviderManifest({ ...withAuth, settings: [{ ...form, fields: [form.fields[0], form.fields[0]] }] }).ok).toBe(false)
    expect(validateProviderManifest({ ...withAuth, settings: [{ ...form, fields: [{ ...form.fields[0], maxLength: 70_000 }] }] }).ok).toBe(false)
    expect(validateProviderManifest({ ...withAuth, settings: [{ ...form, submit: { ...form.submit, capability: 'unknown' } }] }).ok).toBe(false)
    expect(validateProviderManifest({ ...withAuth, requiredHostFeatures: ['audio-format.opus', 'settings.form'], settings: [form] }).ok).toBe(true)
  })

  it('validates auth collection values and requires auth.browser-session for cookie jars', () => {
    const jar = { name: 'cookies', source: 'cookieJar', origin: 'https://music.example.com', domains: ['example.com'], requiredCookies: ['SID'] }
    const withCollection = (values: unknown[], requiredHostFeatures: string[] = ['auth.browser-session']) => ({
      ...manifest,
      requiredHostFeatures,
      permissions: { authCollections: [{ id: 'sign-in', allowedOrigins: ['https://music.example.com'], values }] },
    })
    expect(validateProviderManifest(withCollection([jar])).ok).toBe(true)
    expect(validateProviderManifest(withCollection([jar], []))).toMatchObject({ ok: false, errors: [expect.stringContaining('auth.browser-session')] })
    expect(validateProviderManifest(withCollection([{ name: 'token', source: 'cookie', cookieName: 'token' }], [])).ok).toBe(true)
    for (const invalid of [
      { ...jar, domains: [] },
      { ...jar, domains: ['.example.com'] },
      { ...jar, requiredCookies: ['bad name'] },
      { ...jar, origin: 'http://music.example.com' },
      { ...jar, extra: true },
      { name: 'x', source: 'indexedDB' },
    ]) expect(validateProviderManifest(withCollection([invalid])).ok).toBe(false)
  })
})

describe('toProviderError', () => {
  // Stands in for the ProviderApiError class compiled into a separate provider package.
  class PackagedProviderApiError extends Error {
    constructor(readonly providerError: unknown) {
      super('packaged')
      this.name = 'ProviderApiError'
    }
  }

  it('keeps typed codes from a separately compiled ProviderApiError copy', () => {
    const error = new PackagedProviderApiError({ code: 'NOT_FOUND', message: 'Track not found', retryable: false, retryAfterMs: 5, details: { id: 'x' }, extra: 'dropped' })
    expect(toProviderError(error)).toEqual({ code: 'NOT_FOUND', message: 'Track not found', retryable: false, retryAfterMs: 5, details: { id: 'x' } })
  })

  it('rejects unknown codes, wrong names, and malformed shapes', () => {
    expect(toProviderError(new PackagedProviderApiError({ code: 'ROOT', message: 'x', retryable: false }))).toBeNull()
    expect(toProviderError(new PackagedProviderApiError({ code: 'NOT_FOUND', message: 1, retryable: false }))).toBeNull()
    expect(toProviderError(Object.assign(new Error('x'), { providerError: { code: 'NOT_FOUND', message: 'x', retryable: false } }))).toBeNull()
    expect(toProviderError('NOT_FOUND')).toBeNull()
    expect(toProviderError(new PackagedProviderApiError({ code: 'NETWORK', message: 'x', retryable: true, details: { bad: () => 1 } })))
      .toEqual({ code: 'NETWORK', message: 'x', retryable: true })
  })
})
