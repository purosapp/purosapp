import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../db/schema'

const context = vi.hoisted(() => ({ db: null as Database.Database | null }))
vi.mock('../db', () => ({ getDb: () => context.db! }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
import { getCachedStreamingAudio, registerStreamingAudioCacheEntry } from './index'

const folders: string[] = []
afterEach(() => {
  context.db?.close(); context.db = null
  folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true }))
})

describe('streaming cache source ownership', () => {
  it('requires the exact provider and track and ignores old matched replacements', () => {
    context.db = new Database(':memory:')
    initSchema(context.db, () => {})
    const folder = mkdtempSync(join(tmpdir(), 'puros-source-cache-')); folders.push(folder)
    const file = join(folder, 'track.flac'); writeFileSync(file, 'fixture')
    const put = context.db.prepare(`INSERT INTO streaming_audio_cache
      (provider, source_id, quality_key, resolved_source_id, file_path, format, lossless)
      VALUES (?, ?, 'MAX', ?, ?, 'FLAC', 1)`)
    put.run('tidal', 'requested', 'replacement', file)
    put.run('apple', 'requested', 'requested', file)
    expect(getCachedStreamingAudio('tidal', 'requested', 'MAX')).toBeNull()
    expect(getCachedStreamingAudio('tidal', 'replacement', 'MAX')).toBeNull()
    expect(getCachedStreamingAudio('apple', 'requested', 'MAX')).toMatchObject({ resolvedTrackId: 'requested', playbackPath: file })
    put.run('tidal', 'replacement', 'replacement', file)
    expect(getCachedStreamingAudio('tidal', 'replacement', 'MAX')).toMatchObject({ resolvedTrackId: 'replacement', playbackPath: file })
  })

  it('keeps source provenance across restarts and never lets a lossy source satisfy a lossless key', () => {
    context.db = new Database(':memory:')
    initSchema(context.db, () => {})
    const folder = mkdtempSync(join(tmpdir(), 'puros-source-cache-')); folders.push(folder)
    const file = join(folder, 'track.flac'); writeFileSync(file, 'fixture')
    const flac = { format: 'FLAC' as const, sampleRate: 44_100, bitDepth: 16, bitrate: 0, channels: 2, isLossless: true, isHiRes: false, isMqa: false, isDsd: false }
    const vorbis = { ...flac, format: 'VORBIS' as const, bitDepth: 0, bitrate: 320, isLossless: false }
    registerStreamingAudioCacheEntry('spotify', 'track', 'vorbis-320', { playbackPath: file, quality: flac, sourceQuality: vorbis }, false)
    expect(getCachedStreamingAudio('spotify', 'track', 'vorbis-320', false)).toMatchObject({ quality: flac, sourceQuality: vorbis })
    registerStreamingAudioCacheEntry('spotify', 'track', 'LOSSLESS', { playbackPath: file, quality: flac, sourceQuality: vorbis })
    expect(getCachedStreamingAudio('spotify', 'track', 'LOSSLESS')).toBeNull()
    // Rows written before v31 have no provenance and keep meaning "the file is the source".
    context.db.prepare(`INSERT INTO streaming_audio_cache (provider, source_id, quality_key, file_path, format, lossless)
      VALUES ('tidal', 'old', 'MAX', ?, 'FLAC', 1)`).run(file)
    expect(getCachedStreamingAudio('tidal', 'old', 'MAX')).toMatchObject({ sourceQuality: undefined, quality: { format: 'FLAC' } })
  })
})
