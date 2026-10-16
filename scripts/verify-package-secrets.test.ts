import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findBuilderSecretReferences,
  isForbiddenPackagedFileName,
  scanPackagedPaths,
} from './verify-package-secrets.mjs'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-secret-test-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('package secret verification', () => {
  it('rejects dotenv and private-key filenames', () => {
    expect(isForbiddenPackagedFileName('/Resources/.env')).toBe(true)
    expect(isForbiddenPackagedFileName('/Resources/.env.production')).toBe(true)
    expect(isForbiddenPackagedFileName('/Resources/AuthKey.p8')).toBe(true)
    expect(isForbiddenPackagedFileName('/Resources/app.js')).toBe(false)
  })

  it('reports private-key markers without returning file contents', () => {
    const directory = makeTemporaryDirectory()
    const keyPath = path.join(directory, 'credential.txt')
    fs.writeFileSync(keyPath, ['-----', 'BEGIN PRIVATE KEY', '-----'].join(''))

    expect(scanPackagedPaths([directory])).toEqual([
      { filePath: keyPath, reason: 'private-key marker' },
    ])
  })

  it('rejects secret resource references in builder config', () => {
    expect(findBuilderSecretReferences(`{ "extraResources": [".env.local"] }`)).toHaveLength(1)
    expect(findBuilderSecretReferences(`{ "extraResources": ["AuthKey.p8"] }`)).toHaveLength(1)
    expect(findBuilderSecretReferences(`{ "extraResources": ["native/addon.node"] }`)).toEqual([])
  })
})
