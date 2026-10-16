import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ensureSoxr, installSoxr } from '../provider-sdk/tooling/soxr.mjs'

// The pinned libsoxr recipe is shared with the SDK's ffmpeg build and lives in the SDK checkout.
export * from '../provider-sdk/tooling/soxr.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const install = process.argv.find((arg) => arg.startsWith('--install='))
  if (install) console.log(installSoxr(path.resolve(repoRoot, install.slice('--install='.length))))
  else console.log(ensureSoxr())
}
