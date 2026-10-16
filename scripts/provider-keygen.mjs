import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { generateSigningKey } from '../provider-sdk/tooling/keygen.mjs'

export { describePublicKey } from '../provider-sdk/tooling/keygen.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function main() {
  const outArg = process.argv.slice(2).find((arg) => arg.startsWith('--out='))
  if (!outArg || process.argv.length !== 3) throw new Error('Usage: npm run providers:keygen -- --out=<path outside the repository>')
  // Keys must never be committed or packaged; refuse any location inside the checkout.
  const key = generateSigningKey(outArg.slice('--out='.length), { forbiddenRoots: [repoRoot] })
  console.log(`Private key written to ${key.path} (mode 0600). Keep it offline or in Keychain; never commit it.`)
  console.log(`Public key (base64): ${key.publicKey}`)
  console.log(`Publisher key ID:    ${key.keyId}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
