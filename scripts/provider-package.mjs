import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packProvider as packWithSdk, signDescriptor as signWithSdk } from '../provider-sdk/tooling/package.mjs'
import { PROVIDER_CLI_PATH } from '../provider-sdk/tooling/manifest.mjs'
import { isInside } from '../provider-sdk/tooling/keygen.mjs'
import { discoverProviders } from './providers.mjs'

// The package format and packer live in the SDK checkout (repos.json); this
// module keeps the repository defaults for in-process gates and tests.
export * from '../provider-sdk/tooling/package.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutputRoot = path.join(repoRoot, 'release', 'providers')

/** Packs from the repository root into release/providers unless the options say otherwise. */
export function packProvider(provider, options = {}) {
  return packWithSdk(provider, { outputRoot: defaultOutputRoot, buildRoot: repoRoot, ...options })
}

export function signDescriptor(descriptorBytes, signingKeyPath) {
  return signWithSdk(descriptorBytes, signingKeyPath, { forbiddenRoots: [repoRoot] })
}

function parseCli(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'))
  const outArg = argv.find((arg) => arg.startsWith('--out='))
  const signArg = argv.find((arg) => arg.startsWith('--sign-key='))
  const unknown = argv.filter((arg) => arg.startsWith('--') && arg !== '--skip-build' && !arg.startsWith('--out=') && !arg.startsWith('--sign-key='))
  if (positional.length !== 1 || unknown.length > 0) {
    throw new Error('Usage: npm run providers:pack -- <provider-id|all> [--skip-build] [--out=<directory>] [--sign-key=<ed25519 key outside the repo>]')
  }
  return {
    selection: positional[0],
    skipBuild: argv.includes('--skip-build'),
    signingKeyPath: signArg ? path.resolve(signArg.slice('--sign-key='.length)) : process.env.PUROS_PROVIDER_SIGNING_KEY || null,
    outputRoot: outArg ? path.resolve(outArg.slice('--out='.length)) : defaultOutputRoot,
  }
}

function main() {
  const { selection, skipBuild, outputRoot, signingKeyPath } = parseCli(process.argv.slice(2))
  if (signingKeyPath && isInside(path.resolve(signingKeyPath), repoRoot)) throw new Error('The provider signing key must live outside the repository')
  const discovered = discoverProviders()
  // `all` means every distributable provider; the example fixture is packed only by name.
  const selected = selection === 'all'
    ? discovered.filter(({ directoryName }) => directoryName !== '_example')
    : discovered.filter(({ manifest }) => manifest.id === selection)
  if (selected.length === 0) throw new Error(`Unknown provider: ${selection}`)
  for (const provider of selected) {
    // The SDK CLI packs from the provider root, exactly as the provider repository's CI does.
    const args = [PROVIDER_CLI_PATH, 'pack', `--out=${outputRoot}`, ...(skipBuild ? ['--skip-build'] : []), ...(signingKeyPath ? [`--sign-key=${path.resolve(signingKeyPath)}`] : [])]
    const result = spawnSync(process.execPath, args, { cwd: provider.root, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Packing ${provider.manifest.id} failed with exit code ${result.status ?? result.signal}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
