import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isPathInsideRoot, resolveAllowedExistingFile } from './pathPolicy'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function makeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-path-test-'))
  temporaryDirectories.push(directory)
  const root = path.join(directory, 'library')
  const outside = path.join(directory, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  const insideFile = path.join(root, 'track.flac')
  const outsideFile = path.join(outside, 'private.flac')
  fs.writeFileSync(insideFile, 'audio')
  fs.writeFileSync(outsideFile, 'private')
  return { root, insideFile, outsideFile }
}

describe('protocol path policy', () => {
  it('recognizes path containment without prefix confusion', () => {
    expect(isPathInsideRoot('/music/album/track.flac', '/music')).toBe(true)
    expect(isPathInsideRoot('/music-other/track.flac', '/music')).toBe(false)
  })

  it('allows existing files inside a granted root', () => {
    const fixture = makeFixture()
    expect(resolveAllowedExistingFile(fixture.insideFile, [fixture.root])).toBe(
      fs.realpathSync.native(fixture.insideFile),
    )
  })

  it('rejects files outside the root and symlink escapes', () => {
    const fixture = makeFixture()
    expect(resolveAllowedExistingFile(fixture.outsideFile, [fixture.root])).toBeNull()

    const linkPath = path.join(fixture.root, 'escape.flac')
    fs.symlinkSync(fixture.outsideFile, linkPath)
    expect(resolveAllowedExistingFile(linkPath, [fixture.root])).toBeNull()
  })

  it('rejects relative, missing, and directory paths', () => {
    const fixture = makeFixture()
    expect(resolveAllowedExistingFile('track.flac', [fixture.root])).toBeNull()
    expect(resolveAllowedExistingFile(path.join(fixture.root, 'missing.flac'), [fixture.root])).toBeNull()
    expect(resolveAllowedExistingFile(fixture.root, [fixture.root])).toBeNull()
  })
})
