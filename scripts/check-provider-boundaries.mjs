import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GENERATED_PROVIDER_REGISTRY = path.join(repoRoot, 'electron', 'main', 'providers', 'generated.ts')
const GENERATED_PROVIDER_RUNTIME = path.join(repoRoot, 'electron', 'generated-provider-runtime.ts')
const CORE_ROOTS = [path.join(repoRoot, 'src'), path.join(repoRoot, 'electron')]
const PROVIDERS_ROOT = path.join(repoRoot, 'providers')
// Apple is a parked, private checkout that still reads core types; every other
// provider is (or is the template for) a public repository of its own.
const IN_REPOSITORY_PROVIDERS = new Set(['apple'])

function listSourceFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return []
  const files = []
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) files.push(...listSourceFiles(entryPath))
    else if (entry.isFile() && /\.(?:c|m)?(?:j|t)sx?$/.test(entry.name)) files.push(entryPath)
  }
  return files
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function isProviderImplementationSpecifier(specifier, filePath) {
  if (specifier === 'providers' || specifier.startsWith('providers/') || specifier.startsWith('@providers/')) {
    return true
  }
  if (!specifier.startsWith('.') || !path.isAbsolute(filePath)) return false
  return isPathInside(path.resolve(path.dirname(filePath), specifier), path.join(repoRoot, 'providers'))
}

export function findForbiddenProviderImports(source, filePath = '<source>') {
  const issues = []
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!isProviderImplementationSpecifier(match[1], filePath)) continue
      issues.push({ filePath, line: lineNumber(source, match.index ?? 0), specifier: match[1] })
    }
  }
  return issues
}

export function checkProviderBoundaries(rootPaths = CORE_ROOTS) {
  const issues = []
  for (const rootPath of rootPaths) {
    for (const filePath of listSourceFiles(rootPath)) {
      if (path.resolve(filePath) === GENERATED_PROVIDER_RUNTIME) continue
      issues.push(...findForbiddenProviderImports(fs.readFileSync(filePath, 'utf8'), filePath))
    }
  }
  return issues
}

const IMPORT_PATTERNS = [
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** Relative imports that leave the provider's own directory (core code a public repository must not contain). */
export function findProviderEscapes(source, filePath, providerRoot) {
  const issues = []
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      if (isPathInside(path.resolve(path.dirname(filePath), specifier), providerRoot)) continue
      issues.push({ filePath, line: lineNumber(source, match.index ?? 0), specifier })
    }
  }
  return issues
}

export function checkProviderSelfContainment(providersRoot = PROVIDERS_ROOT) {
  if (!fs.existsSync(providersRoot)) return []
  const issues = []
  for (const entry of fs.readdirSync(providersRoot, { withFileTypes: true })) {
    const providerRoot = path.join(providersRoot, entry.name)
    if (!entry.isDirectory() || IN_REPOSITORY_PROVIDERS.has(entry.name) || !fs.existsSync(path.join(providerRoot, 'provider.manifest.json'))) continue
    for (const filePath of listSourceFiles(path.join(providerRoot, 'src'))) {
      issues.push(...findProviderEscapes(fs.readFileSync(filePath, 'utf8'), filePath, providerRoot))
    }
  }
  return issues
}

export function findProviderIdentityLiterals(source, filePath = '<source>') {
  const issues = []
  for (const match of source.matchAll(/tidal|apple music|'apple'|"apple"/gi)) {
    issues.push({ filePath, line: lineNumber(source, match.index ?? 0), literal: match[0] })
  }
  return issues
}

export function checkProviderIdentityLiterals(rootPaths = CORE_ROOTS) {
  const issues = []
  for (const rootPath of rootPaths) {
    for (const filePath of listSourceFiles(rootPath)) {
      if (path.resolve(filePath) === GENERATED_PROVIDER_REGISTRY
        || path.resolve(filePath) === GENERATED_PROVIDER_RUNTIME
        || /(?:^|[/\\])(?:tests|fixtures)(?:[/\\])/.test(filePath)
        || /(?:\.test|\.spec|migrations)\.tsx?$/.test(filePath)) continue
      issues.push(...findProviderIdentityLiterals(fs.readFileSync(filePath, 'utf8'), filePath))
    }
  }
  return issues
}

function main() {
  const importIssues = checkProviderBoundaries()
  const identityIssues = checkProviderIdentityLiterals()
  const escapeIssues = checkProviderSelfContainment()
  if (importIssues.length > 0 || identityIssues.length > 0 || escapeIssues.length > 0) {
    console.error('Provider boundary check failed:')
    for (const issue of importIssues) {
      console.error(`  ${path.relative(repoRoot, issue.filePath)}:${issue.line} imports ${issue.specifier}`)
    }
    for (const issue of identityIssues) {
      console.error(`  ${path.relative(repoRoot, issue.filePath)}:${issue.line} contains provider identity ${issue.literal}`)
    }
    for (const issue of escapeIssues) {
      console.error(`  ${path.relative(repoRoot, issue.filePath)}:${issue.line} imports ${issue.specifier} from outside its provider; use puros-provider-sdk`)
    }
    process.exitCode = 1
    return
  }
  console.log('Provider boundary check passed: core has no provider imports or fixed provider identities, and providers import only their own files and the SDK.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
