import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyIsolatedNodeModules } from './isolated-node-modules.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const providerId = process.argv[2]
if (!providerId || !/^[a-z][a-z0-9-]{1,31}$/.test(providerId)) {
  throw new Error('Usage: node scripts/verify-one-provider.mjs <provider-id>')
}
const providerDirectory = providerId === 'example' ? '_example' : providerId
const sourceProvider = path.join(repoRoot, 'providers', providerDirectory)
if (!fs.statSync(sourceProvider, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`Provider directory is missing: ${providerId}`)
}
const providerManifests = fs.readdirSync(path.join(repoRoot, 'providers'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(repoRoot, 'providers', entry.name, 'provider.manifest.json'))
  .filter((manifestPath) => fs.existsSync(manifestPath))
  .map((manifestPath) => JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
const selectedManifest = providerManifests.find((manifest) => manifest.id === providerId)
const selectedDisplayName = selectedManifest?.displayName
if (typeof selectedDisplayName !== 'string') {
  throw new Error(`Provider manifest ID mismatch: ${providerId}`)
}
const absentDisplayNames = providerManifests
  .filter((manifest) => manifest.id !== providerId)
  .map((manifest) => manifest.displayName)

const excludedTopLevel = new Set([
  '.git', '.npm-cache', '.venv-apple', '.venv-tidal', 'dist', 'dist-electron',
  'node_modules', 'providers', 'release',
])
function shouldCopy(sourcePath) {
  const relative = path.relative(repoRoot, sourcePath)
  if (!relative) return true
  const parts = relative.split(path.sep)
  if (excludedTopLevel.has(parts[0])) return false
  if (parts[0] === 'build' && ['apple-bridge', 'tidal-bridge', 'providers.generated.json'].includes(parts[1])) return false
  if (parts.some((part) => part === '.env' || part === '.env.local' || part.endsWith('.p8'))) return false
  // Nested checkouts (provider-sdk/, see repos.json) bring their own git data and dependencies.
  if (parts.slice(1).some((part) => part === '.git' || part === 'node_modules')) return false
  return true
}

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, PUROS_PROVIDERS: providerId },
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 'unknown'}`)
}

function findAppBundle(root) {
  if (!fs.existsSync(root)) return null
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory() && entry.name === 'Puros.app') return entryPath
    if (entry.isDirectory()) {
      const nested = findAppBundle(entryPath)
      if (nested) return nested
    }
  }
  return null
}

async function smokeLaunch(appBundle, temporaryRoot) {
  const executable = path.join(appBundle, 'Contents', 'MacOS', 'Puros')
  const profile = path.join(temporaryRoot, 'smoke-profile')
  const resultPath = path.join(temporaryRoot, 'renderer-smoke.json')
  fs.mkdirSync(profile)
  const output = []
  const launchEnvironment = {
    ...process.env,
    PUROS_PROVIDERS: providerId,
    PUROS_RENDERER_SMOKE: '1',
    PUROS_RENDERER_SMOKE_RESULT: resultPath,
    ...(providerId === 'example' ? { PUROS_PROVIDER_SMOKE_PLAYBACK: '1', PUROS_PROVIDER_SMOKE_FAULTS: '1' } : {}),
  }
  delete launchEnvironment.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [`--user-data-dir=${profile}`], {
    cwd: temporaryRoot,
    env: launchEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))
  try {
    const startedAt = Date.now()
    while (!fs.existsSync(resultPath)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Packaged app exited during smoke launch: ${child.exitCode ?? child.signalCode}\n${output.join('')}`)
      }
      if (Date.now() - startedAt > 35_000) {
        throw new Error(`Packaged renderer did not report its state within 35 seconds:\n${output.join('')}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    if (result.error || result.errors?.length) {
      throw new Error(`Packaged renderer emitted an error: ${JSON.stringify(result.error ?? result.errors)}`)
    }
    if (!result.home?.hasRoot || !/\bpuros\b/i.test(result.home.text)) {
      throw new Error('Packaged renderer did not render the Puros app shell')
    }
    if (!result.settings?.includes(selectedDisplayName)) {
      throw new Error(`Packaged renderer did not display the ${providerId} provider settings card`)
    }
    const selectedStatus = result.providers?.find(({ manifest }) => manifest.id === providerId)?.status?.state
    if (!['ready', 'degraded'].includes(selectedStatus)) {
      throw new Error(`Packaged ${providerId} process did not activate: ${selectedStatus ?? 'missing status'}`)
    }
    if (providerId === 'example' && (!result.providerPlayback?.ok || result.providerPlayback.value?.lifecycle !== 'complete')) {
      throw new Error(`Packaged example provider could not resolve its fixture audio: ${JSON.stringify(result.providerPlayback)}`)
    }
    if (providerId === 'example' && !result.providerRecovery?.ok) {
      throw new Error(`Packaged example provider did not recover from crash and event flood: ${JSON.stringify(result.providerRecovery)}`)
    }
    const renderedText = `${result.home.text}\n${result.settings}`
    const unexpectedName = absentDisplayNames.find((name) => renderedText.includes(name))
    if (unexpectedName) {
      throw new Error(`Packaged renderer displayed absent provider UI: ${unexpectedName}`)
    }
    const combinedOutput = output.join('')
    if (/\b(?:unhandled|uncaught|typeerror|referenceerror)\b|provider:.*load failed/i.test(combinedOutput)) {
      throw new Error(`Packaged app emitted a process-console error:\n${combinedOutput}`)
    }
  } finally {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `puros-${providerId}-only-`))
const copyRoot = path.join(temporaryRoot, 'repo')
try {
  fs.cpSync(repoRoot, copyRoot, { recursive: true, dereference: false, filter: shouldCopy })
  fs.mkdirSync(path.join(copyRoot, 'providers'))
  fs.cpSync(sourceProvider, path.join(copyRoot, 'providers', providerDirectory), {
    recursive: true,
    filter: (sourcePath) => !path.relative(sourceProvider, sourcePath).split(path.sep)
      .some((part) => ['work', '__pycache__', '.git', '.venv', 'node_modules', 'release'].includes(part)),
  })
  copyIsolatedNodeModules(repoRoot, copyRoot)

  run('npm', ['run', 'typecheck'], copyRoot)
  // Build steps are checked separately; this gate packages their already-built outputs.
  run('node', ['scripts/providers.mjs', providerId === 'example' ? '--mode=test' : '--mode=release', '--skip-build'], copyRoot)
  run(path.join(copyRoot, 'node_modules', '.bin', 'vite'), ['build'], copyRoot)
  run(path.join(copyRoot, 'node_modules', '.bin', 'electron-builder'), [
    '--dir', '--config', 'build/providers.generated.json',
    '--config.mac.identity=null', '--config.mac.hardenedRuntime=false',
  ], copyRoot)

  const generatedRegistry = fs.readFileSync(path.join(copyRoot, 'electron/main/providers/generated.ts'), 'utf8')
  const generatedRuntime = fs.readFileSync(path.join(copyRoot, 'electron/generated-provider-runtime.ts'), 'utf8')
  if (/^import[^\n]*providers\//m.test(generatedRegistry) || !generatedRuntime.includes(`providers/${providerDirectory}/src/index`)) {
    throw new Error(`Only the generated utility-process registry may import ${providerId}`)
  }
  if (process.platform === 'darwin') {
    const appBundle = findAppBundle(path.join(copyRoot, 'release'))
    if (!appBundle) throw new Error('electron-builder did not produce Puros.app')
    const resourceRoot = path.join(appBundle, 'Contents', 'Resources', 'providers')
    const packagedProviders = fs.readdirSync(resourceRoot).filter((name) => fs.statSync(path.join(resourceRoot, name)).isDirectory())
    if (packagedProviders.length !== 1 || packagedProviders[0] !== providerId) {
      throw new Error(`Packaged provider resource mismatch: ${packagedProviders.join(', ')}`)
    }
    const resourcesRoot = path.join(appBundle, 'Contents', 'Resources')
    for (const resource of selectedManifest.build?.extraResources ?? []) {
      const resourcePath = path.resolve(resourcesRoot, resource.to)
      if (!resourcePath.startsWith(`${resourcesRoot}${path.sep}`) || !fs.existsSync(resourcePath)) {
        throw new Error(`Declared provider resource is missing: ${resource.to}`)
      }
    }
    for (const binary of selectedManifest.build?.binaries ?? []) {
      const binaryPath = path.resolve(resourcesRoot, binary)
      if (!binaryPath.startsWith(`${resourcesRoot}${path.sep}`) || !fs.statSync(binaryPath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Declared provider binary is missing: ${binary}`)
      }
      if ((fs.statSync(binaryPath).mode & 0o111) === 0) {
        throw new Error(`Declared provider binary is not executable: ${binary}`)
      }
    }
    for (const helper of selectedManifest.permissions?.helpers ?? []) {
      if (!(helper.allowedArguments ?? []).includes('--help')) continue
      const providerResourceRoot = path.join(resourceRoot, providerId)
      const executable = path.resolve(providerResourceRoot, helper.executable)
      if (!executable.startsWith(`${providerResourceRoot}${path.sep}`)) throw new Error('Provider helper escaped its resource root')
      const probe = spawnSync(executable, ['--help'], { timeout: 15_000, encoding: 'utf8' })
      if (probe.status !== 0) throw new Error(`Packaged provider helper did not start: ${helper.id}: ${probe.stderr}`)
    }
    await smokeLaunch(appBundle, temporaryRoot)
  }
  console.log(`${providerId}-only package and renderer verification passed.`)
} finally {
  if (process.env.PUROS_KEEP_ONE_PROVIDER_TEMP === '1') console.log(`Preserved temporary copy: ${temporaryRoot}`)
  else fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
