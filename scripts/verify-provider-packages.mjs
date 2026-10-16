import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packProvider } from './provider-package.mjs'
import { discoverProviders } from './providers.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runBuild = process.argv.includes('--build')
if (process.argv.slice(2).some((arg) => arg !== '--build')) throw new Error('Usage: node scripts/verify-provider-packages.mjs [--build]')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit code ${result.status ?? result.signal ?? 'unknown'}`)
}

// Loads the compiled entry with Electron's embedded Node.js, the same runtime
// as the provider utility process, and compares its manifest with the package.
const LOAD_PROBE = `
const [entryUrl, manifestPath] = process.argv.slice(-2)
const fs = await import('node:fs')
const plugin = (await import(entryUrl)).default
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (plugin?.apiVersion !== 1 || typeof plugin.activate !== 'function') throw new Error('Compiled entry is not a ProviderPluginV1')
if (JSON.stringify(plugin.manifest) !== JSON.stringify(manifest)) throw new Error('Compiled manifest differs from packaged manifest')
`

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-provider-packages-'))
try {
  const providers = discoverProviders()
  const archives = []
  for (const provider of providers) {
    const first = await packProvider(provider, { skipBuild: !runBuild, outputRoot: path.join(workRoot, 'a') })
    const second = await packProvider(provider, { skipBuild: true, outputRoot: path.join(workRoot, 'b') })
    if (!fs.readFileSync(first.zipPath).equals(fs.readFileSync(second.zipPath))) {
      throw new Error(`Provider package ${provider.manifest.id} is not reproducible: two packs of the same inputs differ`)
    }
    run('unzip', ['-tq', first.zipPath], { stdio: ['ignore', 'ignore', 'inherit'] })

    const extracted = path.join(workRoot, 'extract', provider.manifest.id)
    fs.mkdirSync(extracted, { recursive: true })
    run('unzip', ['-q', first.zipPath, '-d', extracted])
    run(path.join(repoRoot, 'node_modules', '.bin', 'electron'), [
      '--input-type=module', '-e', LOAD_PROBE,
      pathToFileURL(path.join(extracted, first.descriptor.entry)).href,
      path.join(extracted, first.descriptor.manifest),
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })

    archives.push(first.zipPath)
    const platform = first.descriptor.platform ? `darwin/${first.descriptor.platform.arch.join('+')}` : 'any'
    console.log(`${provider.manifest.id}: reproducible ${first.size}-byte package (${platform}), sha256 ${first.sha256}`)
  }
  if (archives.length > 0) {
    run(path.join(repoRoot, 'node_modules', '.bin', 'vitest'), ['run', 'tests/provider-contract.test.ts'], {
      env: { ...process.env, PUROS_CONTRACT_PACKAGES: archives.join(',') },
    })
  }
  console.log(`Provider packages verified: ${providers.map(({ manifest }) => manifest.id).join(', ') || 'none installed'}.`)
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true })
}
