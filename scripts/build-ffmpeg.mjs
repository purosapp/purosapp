import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ensureSelfContainedFfmpeg, installSelfContainedFfmpeg } from '../provider-sdk/tooling/ffmpeg.mjs'

// The pinned ffmpeg recipe is shared with provider helpers and lives in the SDK checkout.
export * from '../provider-sdk/tooling/ffmpeg.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const install = process.argv.find((arg) => arg.startsWith('--install='))
  if (install) console.log(installSelfContainedFfmpeg(path.resolve(repoRoot, install.slice('--install='.length))))
  else console.log(path.join(ensureSelfContainedFfmpeg(), 'ffmpeg'))
}
