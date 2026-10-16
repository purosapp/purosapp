import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyIsolatedNodeModules } from './isolated-node-modules.mjs'
import { findNonSystemLibraries } from './build-ffmpeg.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const keepTemporaryCopy = process.env.PUROS_KEEP_NO_PROVIDER_TEMP === '1'
const skipLaunch = process.argv.includes('--skip-launch')
const excludedTopLevel = new Set([
  '.git', '.npm-cache', '.venv-apple', '.venv-tidal', 'dist', 'dist-electron',
  'node_modules', 'providers', 'release', 'vendor',
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

function run(command, args, cwd, extraEnv = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, PUROS_PROVIDERS: 'none', ...extraEnv },
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

function writeSilentWav(filePath) {
  const sampleRate = 48_000
  const channels = 2
  const bitsPerSample = 16
  const frames = sampleRate * 2
  const dataBytes = frames * channels * (bitsPerSample / 8)
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28)
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32)
  wav.writeUInt16LE(bitsPerSample, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataBytes, 40)
  fs.writeFileSync(filePath, wav)
}

/** Launches the packaged app once with an isolated profile and returns the renderer probe result. */
async function launchSmoke(appBundle, { profile, resultPath, cwd, extraEnv = {} }) {
  const executable = path.join(appBundle, 'Contents', 'MacOS', 'Puros')
  fs.mkdirSync(profile, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  const output = []
  const launchEnvironment = {
    ...process.env,
    PUROS_PROVIDERS: 'none',
    PUROS_RENDERER_SMOKE: '1',
    PUROS_RENDERER_SMOKE_RESULT: resultPath,
    ...extraEnv,
  }
  delete launchEnvironment.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [`--user-data-dir=${profile}`], { cwd, env: launchEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))
  try {
    const startedAt = Date.now()
    while (!fs.existsSync(resultPath)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Packaged app exited during smoke launch: ${child.exitCode ?? child.signalCode}\n${output.join('')}`)
      }
      if (Date.now() - startedAt > 45_000) {
        throw new Error(`Packaged renderer did not report its state within 45 seconds:\n${output.join('')}`)
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
    return { result, output: output.join('') }
  } finally {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

const PROCESS_ERROR_PATTERN = /\b(?:unhandled|uncaught|typeerror|referenceerror)\b|provider:.*load failed/i

async function smokeLaunch(appBundle, temporaryRoot) {
  const localPlaybackPath = path.join(temporaryRoot, 'local-playback-smoke.wav')
  writeSilentWav(localPlaybackPath)
  const { result, output } = await launchSmoke(appBundle, {
    profile: path.join(temporaryRoot, 'smoke-profile'),
    resultPath: path.join(temporaryRoot, 'renderer-smoke.json'),
    cwd: temporaryRoot,
    extraEnv: { PUROS_LOCAL_SMOKE_FILE: localPlaybackPath },
  })
  if (!result.settings?.includes('No streaming providers are installed.')) {
    throw new Error('Packaged renderer did not show the empty-provider Settings state')
  }
  if (!Array.isArray(result.providers) || result.providers.length !== 0) {
    throw new Error('Packaged no-provider registry is not empty')
  }
  if (result.localPlayback?.ok !== true) {
    throw new Error(`Packaged no-provider local playback failed: ${JSON.stringify(result.localPlayback)}`)
  }
  if (/\b(?:Tidal|Apple Music)\b/i.test(`${result.home.text}\n${result.settings}`)) {
    throw new Error('Packaged renderer displayed provider-specific UI with no providers installed')
  }
  if (PROCESS_ERROR_PATTERN.test(output)) throw new Error(`Packaged app emitted a process-console error:\n${output}`)
}

const FIXTURE_ID = 'smoke-fixture'
const FIXTURE_NAME = 'Smoke Fixture Provider'

/**
 * Builds a signed third-party-style package from the example provider source
 * under a different ID, outside the repository (the example ID itself is
 * refused by packaged builds).
 */
async function buildFixturePackage(temporaryRoot, version = null) {
  const { packProvider } = await import('./provider-package.mjs')
  const sourceRoot = path.join(temporaryRoot, `fixture-src-${version ?? 'default'}`)
  const providerRoot = path.join(sourceRoot, 'providers', FIXTURE_ID)
  fs.cpSync(path.join(repoRoot, 'providers', '_example'), providerRoot, {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts'),
  })
  const manifestPath = path.join(providerRoot, 'provider.manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.id = FIXTURE_ID
  manifest.displayName = FIXTURE_NAME
  if (version) manifest.version = version
  manifest.build.extraResources = manifest.build.extraResources.map((resource) => ({ ...resource, to: resource.to.replace('providers/example/', `providers/${FIXTURE_ID}/`) }))
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  // One publisher key per run, so successive versions look like updates from the same author.
  const keyPath = path.join(temporaryRoot, 'fixture-publisher.pem')
  if (!fs.existsSync(keyPath)) {
    const { generateKeyPairSync } = await import('node:crypto')
    fs.writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  }
  const packaged = await packProvider({ directoryName: FIXTURE_ID, root: providerRoot, manifest }, {
    skipBuild: true, outputRoot: path.join(temporaryRoot, 'fixture-package'), signingKeyPath: keyPath,
  })
  return packaged.zipPath
}

function assertFixtureRunning(result, label) {
  const provider = result.providers?.find(({ manifest }) => manifest.id === FIXTURE_ID)
  if (!provider || provider.status.state !== 'ready') throw new Error(`${label}: installed provider is not ready: ${JSON.stringify(provider?.status)}`)
  if (!result.settings?.includes(FIXTURE_NAME)) throw new Error(`${label}: Settings does not show the installed provider`)
  if (result.providerPlayback?.ok !== true || result.providerPlayback.value?.lifecycle !== 'complete') {
    throw new Error(`${label}: installed provider playback failed: ${JSON.stringify(result.providerPlayback)}`)
  }
  if (result.providerErrors?.ok !== false || result.providerErrors.error?.code !== 'NOT_FOUND') {
    throw new Error(`${label}: typed provider error did not survive the process boundary: ${JSON.stringify(result.providerErrors)}`)
  }
}

/**
 * Drives the real Settings UI: consent, install, downgrade with the incompatibility popup, update,
 * a corrupt ZIP, disable/enable, remove code, and reinstall with provider data intact.
 */
async function verifyPackageSettingsUi(appBundle, temporaryRoot) {
  const newer = await buildFixturePackage(temporaryRoot, '2.0.0')
  const older = await buildFixturePackage(temporaryRoot, '1.0.0')
  const corrupt = path.join(temporaryRoot, 'corrupt-provider.zip')
  const newerBytes = fs.readFileSync(newer)
  fs.writeFileSync(corrupt, newerBytes.subarray(0, Math.floor(newerBytes.length / 2)))
  const profile = path.join(temporaryRoot, 'package-ui-profile')
  // Successive dialog answers: install, downgrade, update, corrupt file, reinstall after code removal.
  const dialogAnswers = [newer, older, newer, corrupt, newer].join(',')
  const { result, output } = await launchSmoke(appBundle, {
    profile, resultPath: path.join(temporaryRoot, 'package-ui-smoke.json'), cwd: temporaryRoot,
    extraEnv: { PUROS_SMOKE_PACKAGE_DIALOG_PATH: dialogAnswers, PUROS_SMOKE_PACKAGE_UI_ID: FIXTURE_ID },
  })
  const steps = result.packageUi ?? {}
  const failures = []
  if (!steps.install?.consent || steps.install.installDisabledBeforeAck !== true) failures.push('consent dialog did not require acknowledgement')
  if (!/not a security sandbox/.test(steps.install?.text ?? '') || !/First package from publisher key/.test(steps.install?.text ?? '')) failures.push('consent dialog lacked the privilege or publisher warning')
  // innerText reflects the CSS uppercase transform of section labels.
  if (!/native programs|capabilities/i.test(steps.install?.text ?? '')) failures.push('consent dialog did not list permissions')
  if (!steps.installedReady || !/v2\.0\.0/.test(steps.rowAfterInstall ?? '')) failures.push('installed v2.0.0 did not become ready in Settings')
  if (!steps.downgrade?.consent || !/older version than the installed 2\.0\.0/.test(steps.downgrade.text ?? '') || !steps.downgrade.incompatible) {
    failures.push('downgrade did not show its warning and the "may be incompatible" popup')
  }
  if (!steps.downgradeReady || !/v1\.0\.0/.test(steps.rowAfterDowngrade || '') || !/previous v2\.0\.0 kept/.test(steps.rowAfterDowngrade || '')) failures.push('downgrade to v1.0.0 did not take effect')
  if (!steps.update?.consent || steps.update.incompatible || !/Update from 1\.0\.0/.test(steps.update.text ?? '')) failures.push('update did not show as an update without the incompatibility popup')
  if (!steps.updateReady || !/v2\.0\.0/.test(steps.rowAfterUpdate || '') || !/previous v1\.0\.0 kept/.test(steps.rowAfterUpdate || '')) failures.push('update to v2.0.0 did not take effect')
  if (!steps.badZipMessage || steps.badZipOpenedConsent || !/v2\.0\.0/.test(steps.rowAfterBadZip ?? '') || steps.stateAfterBadZip !== 'ready') {
    failures.push('a corrupt ZIP was not rejected with a message and without changing the installed provider')
  }
  if (!steps.disabled || !steps.reenabled) failures.push('disable/enable did not stop and restart the provider')
  if (!steps.removed) failures.push('remove code did not remove the provider')
  if (!steps.reinstall?.consent || !steps.reinstallReady || steps.settingAfterReinstall !== false) {
    failures.push('reinstalling after code removal did not keep the provider setting written before removal')
  }
  if (!/installed, not running/.test(steps.retainedRow ?? '') || !steps.retainedRemoved || steps.retainedAfterRemoval?.includes(FIXTURE_ID)
    // The stored `false` must be gone, so the manifest default (`true`) is read again.
    || !steps.readyAfterDataRemoval || steps.settingAfterDataRemoval !== true) {
    failures.push('removing the data of a disabled provider from Settings did not delete its setting while keeping its code')
  }
  if (failures.length > 0) throw new Error(`Provider package Settings UI failed: ${failures.join('; ')}\n${JSON.stringify(steps, null, 2)}`)
  if (!fs.existsSync(path.join(profile, 'providers', FIXTURE_ID))) throw new Error('Removing provider code deleted the provider data directory')
  if (PROCESS_ERROR_PATTERN.test(output)) throw new Error(`Package Settings UI launch emitted a process-console error:\n${output}`)
}

/** Import → verify → launch from the user directory, restart persistence, and tamper refusal, all without a rebuild. */
async function verifyInstalledPackage(appBundle, temporaryRoot) {
  const zipPath = await buildFixturePackage(temporaryRoot)
  const profile = path.join(temporaryRoot, 'package-profile')
  const resultPath = path.join(temporaryRoot, 'package-smoke.json')
  const probes = { PUROS_PROVIDER_SMOKE_PLAYBACK: '1', PUROS_PROVIDER_SMOKE_ERRORS: '1' }

  const first = await launchSmoke(appBundle, {
    profile, resultPath, cwd: temporaryRoot,
    extraEnv: { ...probes, PUROS_PROVIDER_SMOKE_FAULTS: '1', PUROS_SMOKE_PROVIDER_PACKAGE: zipPath },
  })
  assertFixtureRunning(first.result, 'Imported package')
  if (first.result.providerRecovery?.ok !== true) throw new Error(`Installed provider did not recover from crash/flood: ${JSON.stringify(first.result.providerRecovery)}`)
  if (PROCESS_ERROR_PATTERN.test(first.output)) throw new Error(`Imported package launch emitted a process-console error:\n${first.output}`)
  const packageRoot = path.join(profile, 'provider-packages', 'packages', FIXTURE_ID)
  const [versionDirectory] = fs.readdirSync(packageRoot)
  if (!versionDirectory || !fs.existsSync(path.join(packageRoot, versionDirectory, 'puros-provider.sig'))) {
    throw new Error('Imported package was not installed under the user provider-packages directory')
  }

  // Simulate a crash mid-install: a half-extracted staging tree and a renamed version directory
  // that never reached installed.json. Startup recovery must discard both and keep the provider.
  const installRoot = path.join(profile, 'provider-packages')
  const abandonedStaging = path.join(installRoot, '.staging', '00000000-0000-4000-8000-000000000000')
  fs.mkdirSync(path.join(abandonedStaging, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(abandonedStaging, 'dist', 'index.mjs'), 'export default {}\n')
  const orphanVersion = path.join(packageRoot, '9.9.9-deadbeefcafe')
  fs.mkdirSync(orphanVersion)
  fs.writeFileSync(path.join(orphanVersion, 'puros-provider.json'), '{}\n')

  const restarted = await launchSmoke(appBundle, { profile, resultPath, cwd: temporaryRoot, extraEnv: probes })
  assertFixtureRunning(restarted.result, 'Restarted app')
  if (PROCESS_ERROR_PATTERN.test(restarted.output)) throw new Error(`Restarted app emitted a process-console error:\n${restarted.output}`)
  if (fs.existsSync(abandonedStaging) || fs.existsSync(orphanVersion)) throw new Error('Startup recovery left interrupted-install debris behind')
  if (fs.readdirSync(packageRoot).join() !== versionDirectory) throw new Error('Startup recovery changed the active installed version')

  // Same-size edit, so only the SHA-256 re-verification can catch it.
  const entryPath = path.join(packageRoot, versionDirectory, 'dist', 'index.mjs')
  const code = fs.readFileSync(entryPath)
  code[code.length - 1] = code[code.length - 1] === 0x20 ? 0x0a : 0x20
  fs.writeFileSync(entryPath, code)
  const tampered = await launchSmoke(appBundle, { profile, resultPath, cwd: temporaryRoot, extraEnv: probes })
  if (tampered.result.providers?.some(({ manifest }) => manifest.id === FIXTURE_ID)) {
    throw new Error('A tampered installed package was started')
  }
  if (!/installed package failed to start: .*does not match its recorded SHA-256/.test(tampered.output)) {
    throw new Error(`Tampered package refusal was not reported:\n${tampered.output}`)
  }
}

/**
 * Imports the real package of every repository provider (except the example fixture) into the
 * no-provider app: each must start offline from the user directory with its Settings card and icon,
 * and every declared native binary must be validly signed and actually launch from there.
 */
async function verifyRepositoryProviderPackages(appBundle, temporaryRoot) {
  const { packProvider } = await import('./provider-package.mjs')
  const { discoverProviders } = await import('./providers.mjs')
  const providers = discoverProviders().filter(({ directoryName }) => directoryName !== '_example')
  if (providers.length === 0) return []
  const zips = []
  for (const provider of providers) {
    try {
      zips.push((await packProvider(provider, { skipBuild: true, outputRoot: path.join(temporaryRoot, 'repository-packages') })).zipPath)
    } catch (error) {
      throw new Error(`Cannot pack ${provider.manifest.id} for the installed-package gate (build it first, e.g. npm run test:provider -- ${provider.manifest.id}): ${error.message}`)
    }
  }
  const profile = path.join(temporaryRoot, 'repository-packages-profile')
  const { result, output } = await launchSmoke(appBundle, {
    profile, resultPath: path.join(temporaryRoot, 'repository-packages-smoke.json'), cwd: temporaryRoot,
    extraEnv: { PUROS_SMOKE_PROVIDER_PACKAGE: zips.join(',') },
  })
  if (PROCESS_ERROR_PATTERN.test(output) || /installed package failed to start/.test(output)) {
    throw new Error(`Repository provider packages did not start cleanly:\n${output}`)
  }
  for (const { manifest } of providers) {
    const descriptor = result.providers?.find((item) => item.manifest.id === manifest.id)
    if (!descriptor || !['ready', 'degraded'].includes(descriptor.status.state)) {
      throw new Error(`Installed ${manifest.id} package did not start: ${JSON.stringify(descriptor?.status)}`)
    }
    if (!descriptor.iconUrl) throw new Error(`Installed ${manifest.id} package has no icon in Settings`)
    if (!result.settings?.includes(manifest.displayName)) throw new Error(`Settings does not show the installed ${manifest.displayName} package`)
    const providerPackages = path.join(profile, 'provider-packages', 'packages', manifest.id)
    const [versionDirectory] = fs.readdirSync(providerPackages)
    const prefix = `providers/${manifest.id}/`
    for (const binary of manifest.build?.binaries ?? []) {
      const installedBinary = path.join(providerPackages, versionDirectory, ...binary.slice(prefix.length).split('/'))
      const signature = spawnSync('/usr/bin/codesign', ['--verify', '--strict', installedBinary], { encoding: 'utf8' })
      if (signature.status !== 0) throw new Error(`Installed binary ${binary} fails code-signature verification: ${signature.stderr}`)
      // A macOS code-signing or quarantine refusal kills the process with a signal; any exit code proves it ran.
      const launched = spawnSync(installedBinary, ['--help'], { stdio: 'ignore', timeout: 20_000 })
      if (launched.error || launched.status === null) {
        throw new Error(`Installed binary ${binary} did not launch from the user directory (${launched.error?.message ?? launched.signal})`)
      }
    }
  }
  return providers.map(({ manifest }) => manifest.id)
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-no-providers-'))
let importedRepositoryProviders = []
const copyRoot = path.join(temporaryRoot, 'repo')

try {
  fs.cpSync(repoRoot, copyRoot, { recursive: true, dereference: false, filter: shouldCopy })
  copyIsolatedNodeModules(repoRoot, copyRoot)

  run('npm', ['run', 'typecheck'], copyRoot)
  run('node', ['scripts/providers.mjs', '--mode=release'], copyRoot)
  run(path.join(copyRoot, 'node_modules', '.bin', 'vite'), ['build'], copyRoot)
  run(path.join(copyRoot, 'node_modules', '.bin', 'electron-builder'), [
    '--dir',
    '--config', 'build/providers.generated.json',
    '--config.mac.identity=null',
    '--config.mac.hardenedRuntime=false',
  ], copyRoot)

  const generatedRegistry = fs.readFileSync(path.join(copyRoot, 'electron/main/providers/generated.ts'), 'utf8')
  if (!/generatedProviders[^=]*=\s*\[\s*\]/s.test(generatedRegistry)) {
    throw new Error('The no-provider build generated a non-empty provider registry')
  }
  const generatedRuntime = fs.readFileSync(path.join(copyRoot, 'electron/generated-provider-runtime.ts'), 'utf8')
  if (!/generatedRuntimePlugins[^=]*=\s*\{\s*\}/s.test(generatedRuntime) || /from\s+['"][^'"]*providers\//.test(generatedRuntime)) {
    throw new Error('The no-provider build generated a non-empty utility-process plugin registry')
  }
  const generatedBuilder = fs.readFileSync(path.join(copyRoot, 'build/providers.generated.json'), 'utf8')
  if (/providers\//i.test(generatedBuilder)) throw new Error('The no-provider builder config contains provider resources')

  if (process.platform === 'darwin') {
    const appBundle = findAppBundle(path.join(copyRoot, 'release'))
    if (!appBundle) throw new Error('electron-builder did not produce Puros.app')
    const coreFfmpeg = path.join(appBundle, 'Contents', 'Resources', 'audio', 'ffmpeg')
    if (!fs.existsSync(coreFfmpeg)) throw new Error('The no-provider package is missing core ffmpeg for local DSD-to-PCM playback')
    const ffmpegProbe = spawnSync(coreFfmpeg, ['-version'], { timeout: 3_000, stdio: 'ignore' })
    if (ffmpegProbe.status !== 0) throw new Error('The no-provider package contains a non-working core ffmpeg executable')
    const nonSystemLibraries = findNonSystemLibraries(coreFfmpeg)
    if (nonSystemLibraries.length > 0) throw new Error(`The packaged core ffmpeg links libraries outside macOS: ${nonSystemLibraries.join(', ')}`)
    if (!fs.existsSync(path.join(path.dirname(coreFfmpeg), 'FFMPEG-COPYING.LGPLv2.1'))) throw new Error('The no-provider package is missing the ffmpeg LGPL notice')
    if (!skipLaunch) {
      await smokeLaunch(appBundle, temporaryRoot)
      await verifyInstalledPackage(appBundle, temporaryRoot)
      await verifyPackageSettingsUi(appBundle, temporaryRoot)
      importedRepositoryProviders = await verifyRepositoryProviderPackages(appBundle, temporaryRoot)
    }
  }

  console.log(`No-provider verification passed${skipLaunch ? ' (launch explicitly skipped)' : ''}.`)
  console.log('The build-time provider registry and packaged provider resources are empty.')
  if (process.platform === 'darwin' && !skipLaunch) {
    console.log('Packaged local WAV playback advanced through the native shared-output path.')
    console.log('A signed third-party-style provider ZIP was imported, verified, launched from the user directory, played, recovered, kept typed errors, survived restart after interrupted-install recovery, and was refused after tampering.')
    console.log('The Settings UI installed it behind the consent dialog, downgraded it through the incompatibility popup, updated it, rejected a corrupt ZIP, disabled/enabled it, removed and reinstalled its code with its data kept, then removed the data of the disabled provider from Settings.')
    console.log(`Repository provider packages imported into the no-provider app and started with their native binaries runnable: ${importedRepositoryProviders.join(', ') || 'none present'}.`)
  }
} finally {
  if (keepTemporaryCopy) console.log(`Preserved temporary copy: ${temporaryRoot}`)
  else fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
