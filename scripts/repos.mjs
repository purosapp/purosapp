import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The SDK and the separately published providers are their own git
// repositories, cloned in place (and ignored by this repository). An optional,
// ignored repos.local.json adds private checkouts of your own in the same shape.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_REPOSITORIES = path.join(repoRoot, 'repos.local.json')
const repositories = {
  ...JSON.parse(fs.readFileSync(path.join(repoRoot, 'repos.json'), 'utf8')),
  ...(fs.existsSync(LOCAL_REPOSITORIES) ? JSON.parse(fs.readFileSync(LOCAL_REPOSITORIES, 'utf8')) : {}),
}
const SDK_DIRECTORY = 'provider-sdk'

function git(args, cwd = repoRoot, stdio = 'inherit') {
  const result = spawnSync('git', args, { cwd, stdio, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

function isCheckout(directory) {
  return fs.existsSync(path.join(repoRoot, directory, '.git'))
}

function buildSdk() {
  // Editors resolve `puros-provider-sdk` in provider checkouts through the
  // node_modules link to provider-sdk/, whose types live in dist/.
  if (!isCheckout(SDK_DIRECTORY)) return
  const sdkRoot = path.join(repoRoot, SDK_DIRECTORY)
  if (!fs.existsSync(path.join(sdkRoot, 'node_modules'))) {
    // A fresh clone has no SDK dependencies yet; the build needs its tsc and vite.
    const install = spawnSync('npm', ['ci', '--silent'], { cwd: sdkRoot, stdio: 'inherit' })
    if (install.status !== 0) throw new Error('Installing provider-sdk dependencies failed')
  }
  const result = spawnSync('npm', ['run', 'build', '--silent'], { cwd: sdkRoot, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Building provider-sdk failed')
}

function clone() {
  for (const [directory, url] of Object.entries(repositories)) {
    const target = path.join(repoRoot, directory)
    if (isCheckout(directory)) {
      console.log(`${directory}: present`)
      continue
    }
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      throw new Error(`${directory} exists but is not a git checkout; move it aside before cloning ${url}`)
    }
    console.log(`${directory}: cloning ${url}`)
    if (git(['clone', url, directory]).status !== 0) throw new Error(`Cloning ${url} failed`)
  }
  buildSdk()
}

function pull() {
  let failed = false
  for (const directory of Object.keys(repositories)) {
    if (!isCheckout(directory)) {
      console.log(`${directory}: missing (npm run repos:clone)`)
      continue
    }
    console.log(`${directory}:`)
    if (git(['pull', '--ff-only'], path.join(repoRoot, directory)).status !== 0) failed = true
  }
  buildSdk()
  if (failed) process.exitCode = 1
}

function status() {
  for (const directory of ['.', ...Object.keys(repositories)]) {
    if (directory !== '.' && !isCheckout(directory)) {
      console.log(`## ${directory}: missing (npm run repos:clone)`)
      continue
    }
    const result = git(['status', '--short', '--branch'], path.join(repoRoot, directory), 'pipe')
    const [branch, ...changes] = result.stdout.trimEnd().split('\n')
    console.log(`${branch.replace(/^## /, `## ${directory === '.' ? 'puros' : directory}: `)}${changes.length > 0 ? `  (${changes.length} changed)` : ''}`)
  }
}

const commands = { clone, pull, status }
const command = commands[process.argv[2]]
if (!command || process.argv.length !== 3) {
  console.error(`Usage: node scripts/repos.mjs <${Object.keys(commands).join('|')}>`)
  process.exitCode = 1
} else {
  command()
}
