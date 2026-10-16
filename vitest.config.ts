import fs from 'node:fs'
import path from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

// Providers in separate repositories are cloned in place (repos.json); core
// tests that drive one of them are skipped while its checkout is absent.
const absentProviders = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, 'repos.json'), 'utf8')) as Record<string, string>)
  .filter((directory) => directory.startsWith('providers/') && !fs.existsSync(path.join(__dirname, directory)))
  .map((directory) => directory.slice('providers/'.length))

export default defineConfig({
  resolve: {
    alias: [{ find: /^puros-provider-sdk$/, replacement: path.join(__dirname, 'provider-sdk', 'src', 'index.ts') }],
  },
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'scripts/**/*.test.ts', 'src/**/*.test.ts', 'providers/**/*.test.ts', 'provider-sdk/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...absentProviders.map((id) => `tests/providers/${id}/**`)],
  },
})
