import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const providerId = process.argv[2]
if (!providerId || !/^[a-z][a-z0-9-]{1,31}$/.test(providerId) || process.argv.length !== 3) {
  throw new Error('Usage: npm run test:provider -- <provider-id>')
}

const providersRoot = path.join(repoRoot, 'providers')
const matches = fs.readdirSync(providersRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const file = path.join(providersRoot, entry.name, 'provider.manifest.json')
    if (!fs.existsSync(file)) return []
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    return manifest.id === providerId ? [{ directory: entry.name, manifest }] : []
  })
if (matches.length !== 1) throw new Error(`Expected exactly one installed provider with ID ${providerId}`)
const mode = matches[0].directory === '_example' ? 'test' : 'release'
const selectedEnvironment = { ...process.env, PUROS_PROVIDERS: providerId, PUROS_CONTRACT_PROVIDER: providerId }

function run(command, args, env) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? result.signal ?? 'unknown'}`)
}

let failed = null
try {
  // This executes declared provider build steps. The package gate below then
  // copies their products into a fresh isolated checkout and launches it.
  run('node', ['scripts/providers.mjs', `--mode=${mode}`], selectedEnvironment)
  run('npm', ['run', 'typecheck'], selectedEnvironment)
  run('npm', ['run', 'pretest'], selectedEnvironment)
  run(path.join(repoRoot, 'node_modules', '.bin', 'vitest'), ['run', 'tests/provider-contract.test.ts'], selectedEnvironment)
  run('node', ['scripts/verify-one-provider.mjs', providerId], selectedEnvironment)
} catch (error) {
  failed = error
} finally {
  try {
    // Vitest requires Node's native-module ABI; leave the developer checkout
    // ready for Electron again even when a provider contract fails.
    run('npm', ['run', 'predev'], process.env)
  } catch (restoreError) {
    if (!failed) failed = restoreError
    else console.error('Electron ABI restoration also failed:', restoreError)
  }
}
if (failed) throw failed
console.log(`Provider ${providerId} passed its offline contract and isolated package/renderer gate.`)
