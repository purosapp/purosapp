import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const providersRoot = path.join(repoRoot, 'providers')
const providers = fs.existsSync(providersRoot)
  ? fs.readdirSync(providersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(providersRoot, entry.name, 'provider.manifest.json')
      if (!fs.existsSync(file)) return []
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      return [{ id: manifest.id, fixture: entry.name === '_example' }]
    })
    .sort((left, right) => left.id.localeCompare(right.id))
  : []
const releaseIds = providers.filter(({ fixture }) => !fixture).map(({ id }) => id)

function run(command, args, extraEnv = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? result.signal ?? 'unknown'}`)
}

let failed = null
try {
  // A fresh checkout needs the core addon before electron-builder can package
  // the local playback engine. This compiles native code without editing it.
  run('npm', ['run', 'build:native'])
  // Builds (or reuses) the pinned self-contained ffmpeg and runs every invocation Puros makes of it.
  run('node', ['scripts/verify-ffmpeg.mjs'])
  run('npm', ['run', 'typecheck'])
  run('npm', ['test'])
  for (const script of ['lint', 'check:ipc', 'check:boundaries', 'check:secrets']) run('npm', ['run', script])

  run('node', ['scripts/providers.mjs', '--mode=release', '--skip-build'], { PUROS_PROVIDERS: 'none' })
  run('node', ['scripts/providers.mjs', '--mode=release', '--skip-build'], { PUROS_PROVIDERS: 'all' })
  for (const id of releaseIds) {
    run('node', ['scripts/providers.mjs', '--mode=release', '--skip-build'], { PUROS_PROVIDERS: id })
  }
  for (const { id, fixture } of providers) {
    if (fixture) run('node', ['scripts/providers.mjs', '--mode=test', '--skip-build'], { PUROS_PROVIDERS: id })
  }

  // Every package gate copies the repository into a temporary checkout, so
  // production Vite/build output never overwrites the developer's dist files.
  for (const { id } of providers) run('npm', ['run', 'test:provider', '--', id])
  // After the provider builds: the no-provider gate also imports every repository provider's ZIP.
  run('node', ['scripts/verify-no-providers.mjs'])
  // Provider builds above produced the declared helper resources; each
  // standalone package must now compile, pack reproducibly and pass the contract.
  run('node', ['scripts/verify-provider-packages.mjs'])
  run('git', ['diff', '--check'])
} catch (error) {
  failed = error
} finally {
  try {
    run('npm', ['run', 'predev'])
  } catch (restoreError) {
    if (!failed) failed = restoreError
    else console.error('Electron ABI restoration also failed:', restoreError)
  }
}
if (failed) throw failed
console.log(`All automated provider gates passed: zero providers and ${providers.map(({ id }) => id).join(', ') || 'no installed plugins'}.`)
