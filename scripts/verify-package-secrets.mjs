import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage, statFile } from '@electron/asar'
import { containsPrivateKeyMarker, isForbiddenPackagedFileName } from '../provider-sdk/tooling/secrets.mjs'

export { containsPrivateKeyMarker, isForbiddenPackagedFileName }

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.ini', '.js', '.json', '.json5', '.map', '.mjs',
  '.plist', '.svg', '.txt', '.xml', '.yaml', '.yml',
])

function isTextCandidate(filePath, size) {
  return size <= 5 * 1024 * 1024 && TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function visitFiles(rootPath, visit) {
  if (!fs.existsSync(rootPath)) return
  const stat = fs.lstatSync(rootPath)
  if (stat.isSymbolicLink()) {
    visit(rootPath, stat, true)
    return
  }
  if (stat.isFile()) {
    visit(rootPath, stat, false)
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of fs.readdirSync(rootPath)) {
    visitFiles(path.join(rootPath, entry), visit)
  }
}

function scanAsarArchive(archivePath) {
  const issues = []
  for (const rawEntryPath of listPackage(archivePath)) {
    const entryPath = rawEntryPath.replace(/^\//, '')
    const displayPath = `${archivePath}:${entryPath}`
    if (isForbiddenPackagedFileName(entryPath)) {
      issues.push({ filePath: displayPath, reason: 'forbidden secret filename in app.asar' })
      continue
    }

    const stat = statFile(archivePath, entryPath)
    if (stat.files || !isTextCandidate(entryPath, stat.size ?? Number.POSITIVE_INFINITY)) continue
    const contents = extractFile(archivePath, entryPath).toString('utf8')
    if (containsPrivateKeyMarker(contents)) {
      issues.push({ filePath: displayPath, reason: 'private-key marker in app.asar' })
    }
  }
  return issues
}

export function scanPackagedPaths(rootPaths) {
  const issues = []
  for (const rootPath of rootPaths) {
    visitFiles(rootPath, (filePath, stat, isSymlink) => {
      if (isForbiddenPackagedFileName(filePath)) {
        issues.push({ filePath, reason: 'forbidden secret filename' })
        return
      }
      if (!isSymlink && path.extname(filePath).toLowerCase() === '.asar') {
        issues.push(...scanAsarArchive(filePath))
        return
      }
      if (isSymlink || !isTextCandidate(filePath, stat.size)) return
      const contents = fs.readFileSync(filePath, 'utf8')
      if (containsPrivateKeyMarker(contents)) {
        issues.push({ filePath, reason: 'private-key marker' })
      }
    })
  }
  return issues
}

export function findBuilderSecretReferences(configSource) {
  const issues = []
  if (/['"]\.env(?:\.[^'"]*)?['"]/i.test(configSource)) {
    issues.push('electron-builder config references an environment file')
  }
  if (/['"][^'"]+\.(?:p8|p12|pem|key)['"]/i.test(configSource)) {
    issues.push('electron-builder config references a private-key file')
  }
  return issues
}

function findPackagedResourceRoots() {
  const roots = [path.join(repoRoot, 'dist'), path.join(repoRoot, 'dist-electron')]
  const releaseRoot = path.join(repoRoot, 'release')
  if (!fs.existsSync(releaseRoot)) return roots

  const visitDirectories = (directoryPath) => {
    if (directoryPath.endsWith(path.join('Contents', 'Resources'))) {
      roots.push(directoryPath)
      return
    }
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (entry.isDirectory()) visitDirectories(path.join(directoryPath, entry.name))
    }
  }
  visitDirectories(releaseRoot)
  return roots
}

export function verifyPackageSecrets(rootPaths = findPackagedResourceRoots()) {
  const configPath = path.join(repoRoot, 'electron-builder.json5')
  const configIssues = findBuilderSecretReferences(fs.readFileSync(configPath, 'utf8'))
  const packagedIssues = scanPackagedPaths(rootPaths)
  return { configIssues, packagedIssues }
}

function main() {
  const requestedRoots = process.argv.slice(2).map((value) => path.resolve(value))
  const { configIssues, packagedIssues } = verifyPackageSecrets(
    requestedRoots.length > 0 ? requestedRoots : undefined,
  )
  const errors = [
    ...configIssues,
    ...packagedIssues.map(({ filePath, reason }) => `${reason}: ${path.relative(repoRoot, filePath)}`),
  ]
  if (errors.length > 0) {
    console.error(`Package secret check failed:\n${errors.map((error) => `  ${error}`).join('\n')}`)
    process.exitCode = 1
    return
  }
  console.log('Package secret check passed: no dotenv or private-key material is configured or packaged.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
