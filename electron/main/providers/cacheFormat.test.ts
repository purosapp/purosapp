import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canCorePlayFormat, inspectProviderCacheFormat } from './cacheFormat'

describe('provider cache format inspection', () => {
  it('inspects only canonical files inside the granted cache root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-cache-inspect-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-cache-inspect-outside-'))
    try {
      const allowed = path.join(root, 'track.flac')
      const disallowed = path.join(outside, 'track.flac')
      fs.writeFileSync(allowed, 'fixture')
      fs.writeFileSync(disallowed, 'fixture')
      fs.symlinkSync(disallowed, path.join(root, 'escape.flac'))
      const inspect = vi.fn(async () => null)
      const canonicalRoot = fs.realpathSync(root)
      await inspectProviderCacheFormat(allowed, canonicalRoot, inspect)
      expect(inspect).toHaveBeenCalledExactlyOnceWith(fs.realpathSync(allowed))
      await expect(inspectProviderCacheFormat(disallowed, canonicalRoot, inspect)).rejects.toThrow(/outside/)
      await expect(inspectProviderCacheFormat(path.join(root, 'escape.flac'), canonicalRoot, inspect)).rejects.toThrow(/outside/)
      expect(inspect).toHaveBeenCalledTimes(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('core playable formats', () => {
  it('plays ExtAudioFile formats directly and asks the system about Ogg Vorbis and Ogg Opus', async () => {
    const probes = { oggVorbis: vi.fn(async () => true), oggOpus: vi.fn(async () => true) }
    expect(await canCorePlayFormat('FLAC', probes)).toBe(true)
    expect(await canCorePlayFormat('AAC', probes)).toBe(true)
    expect(probes.oggVorbis).not.toHaveBeenCalled()
    expect(probes.oggOpus).not.toHaveBeenCalled()
    expect(await canCorePlayFormat('VORBIS', probes)).toBe(true)
    expect(await canCorePlayFormat('OPUS', probes)).toBe(true)
    expect(probes.oggVorbis).toHaveBeenCalledTimes(1)
    expect(probes.oggOpus).toHaveBeenCalledTimes(1)
    const none = { oggVorbis: async () => false, oggOpus: async () => false }
    expect(await canCorePlayFormat('VORBIS', none)).toBe(false)
    expect(await canCorePlayFormat('OPUS', none)).toBe(false)
    expect(await canCorePlayFormat('DSD', probes)).toBe(false)
    await expect(canCorePlayFormat(42, probes)).rejects.toThrow(/format/)
  })
})

