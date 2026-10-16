import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
if (target !== 'electron' && target !== 'node') {
  throw new Error('Usage: node scripts/ensure-native-abi.mjs electron|node')
}

const electronExecutable = path.join(repoRoot, 'node_modules', '.bin', 'electron')
const electronRebuild = path.join(repoRoot, 'node_modules', '.bin', 'electron-rebuild')
const executable = target === 'electron' ? electronExecutable : process.execPath
const probeEnvironment = { ...process.env }
if (target === 'electron') probeEnvironment.ELECTRON_RUN_AS_NODE = '1'
else delete probeEnvironment.ELECTRON_RUN_AS_NODE

function probe() {
  return spawnSync(executable, [
    '-e',
    "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close(); process.stdout.write(process.versions.modules)",
  ], {
    cwd: repoRoot,
    env: probeEnvironment,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

let result = probe()
if (result.status === 0) {
  console.log(`better-sqlite3 already matches ${target} ABI ${result.stdout}.`)
  process.exit(0)
}

const diagnostic = `${result.stderr ?? ''}${result.stdout ?? ''}`
if (!/NODE_MODULE_VERSION|compiled against a different Node\.js version/.test(diagnostic)) {
  throw new Error(`Cannot load better-sqlite3 with ${target}; not an ABI mismatch:\n${diagnostic}`)
}

let command
let args
if (target === 'electron') {
  if (!fs.existsSync(electronRebuild)) throw new Error('Missing local electron-rebuild executable')
  const electronPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8'))
  command = electronRebuild
  args = ['--force', '--only', 'better-sqlite3', '--version', electronPackage.version]
} else {
  command = 'npm'
  args = ['rebuild', 'better-sqlite3']
}

console.log(`Rebuilding better-sqlite3 for ${target}...`)
const rebuild = spawnSync(command, args, { cwd: repoRoot, env: process.env, stdio: 'inherit' })
if (rebuild.status !== 0) throw new Error(`Native rebuild failed: ${rebuild.status ?? 'unknown'}`)

result = probe()
if (result.status !== 0) {
  throw new Error(`better-sqlite3 still cannot load with ${target}:\n${result.stderr ?? ''}`)
}
console.log(`better-sqlite3 matches ${target} ABI ${result.stdout}.`)
