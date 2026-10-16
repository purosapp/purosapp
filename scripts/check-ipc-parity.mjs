import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntryPath = path.join(repoRoot, 'electron', 'main.ts')
const mainModulesPath = path.join(repoRoot, 'electron', 'main')
const preloadPath = path.join(repoRoot, 'electron', 'preload.ts')
const rendererPath = path.join(repoRoot, 'src')

const EXPECTED_PUSH_CHANNELS = [
  'app:open-settings',
  'audio:bluetooth-info',
  'audio:default-device-changed',
  'audio:mode-changed',
  'dsp:plugin-parameter-changed',
  'autoeq:index-updated',
  'catalog:changed',
  'lastfm:auth-token',
  'library:changed',
  'library:scan-progress',
  'live-radio:changed',
  'live-radio:playback-status',
  'player:media-command',
  'playlists:changed',
  'provider:warning',
  'provider:event',
  'visualizer:attached',
  'visualizer:detached',
]

function listTypeScriptFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return []

  const files = []
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(entryPath))
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(entryPath)
    }
  }
  return files
}

function readSource(filePath) {
  return {
    filePath,
    source: fs.readFileSync(filePath, 'utf8'),
  }
}

function extractLiteralCalls(sources, expression) {
  const calls = []
  const pattern = new RegExp(`${expression}\\(\\s*(['"])([^'"]+)\\1`, 'g')

  for (const { filePath, source } of sources) {
    for (const match of source.matchAll(pattern)) {
      calls.push({
        channel: match[2],
        filePath,
        offset: match.index ?? 0,
      })
    }
  }
  return calls
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function formatCall(call, sourcesByPath) {
  const relativePath = path.relative(repoRoot, call.filePath)
  return `${call.channel} (${relativePath}:${lineNumber(sourcesByPath.get(call.filePath), call.offset)})`
}

function groupByChannel(calls) {
  const grouped = new Map()
  for (const call of calls) {
    const entries = grouped.get(call.channel) ?? []
    entries.push(call)
    grouped.set(call.channel, entries)
  }
  return grouped
}

function sortedDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort()
}

function extractStringArray(source, name) {
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`))
  if (!match) return null
  return new Set([...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]))
}

const mainSources = [mainEntryPath, ...listTypeScriptFiles(mainModulesPath)]
  .sort()
  .map(readSource)
const preloadSources = [readSource(preloadPath)]
const rendererSources = listTypeScriptFiles(rendererPath).sort().map(readSource)
const sourcesByPath = new Map(
  [...mainSources, ...preloadSources, ...rendererSources].map(({ filePath, source }) => [filePath, source]),
)

const mainCalls = extractLiteralCalls(mainSources, 'ipcMain\\.handle')
const preloadCalls = extractLiteralCalls(preloadSources, 'ipcRenderer\\.invoke')
const mainByChannel = groupByChannel(mainCalls)
const preloadByChannel = groupByChannel(preloadCalls)
const mainChannels = new Set(mainByChannel.keys())
const preloadChannels = new Set(preloadByChannel.keys())

const missingFromMain = sortedDifference(preloadChannels, mainChannels)
const missingFromPreload = sortedDifference(mainChannels, preloadChannels)
const duplicateMainHandlers = [...mainByChannel.entries()].filter(([, calls]) => calls.length > 1)
const errors = []

if (missingFromMain.length > 0) {
  errors.push(`Missing from main: ${missingFromMain.join(', ')}`)
}
if (missingFromPreload.length > 0) {
  errors.push(`Missing from preload: ${missingFromPreload.join(', ')}`)
}
if (duplicateMainHandlers.length > 0) {
  errors.push(
    `Duplicate main handlers:\n${duplicateMainHandlers
      .flatMap(([channel, calls]) =>
        calls.map((call) => `  ${formatCall({ ...call, channel }, sourcesByPath)}`),
      )
      .join('\n')}`,
  )
}

const pushCalls = [
  ...extractLiteralCalls(mainSources, '(?:[\\w?.]+\\.)?webContents\\.send'),
  ...extractLiteralCalls(mainSources, '(?:[\\w?.]+\\.)?sender\\.send'),
  ...extractLiteralCalls(mainSources, 'sendToRenderer'),
]
const pushChannels = new Set(pushCalls.map(({ channel }) => channel))
const expectedPushChannels = new Set(EXPECTED_PUSH_CHANNELS)
const unknownPushChannels = sortedDifference(pushChannels, expectedPushChannels)
const missingPushChannels = sortedDifference(expectedPushChannels, pushChannels)

if (unknownPushChannels.length > 0) {
  errors.push(`Unlisted main→renderer channels: ${unknownPushChannels.join(', ')}`)
}
if (missingPushChannels.length > 0) {
  errors.push(`Expected main→renderer channels not found: ${missingPushChannels.join(', ')}`)
}

const genericEventChannels = extractStringArray(preloadSources[0].source, 'GENERIC_EVENT_CHANNELS')
const rendererGenericCalls = extractLiteralCalls(rendererSources, 'window\\.puros\\.on')
const rendererGenericChannels = new Set(rendererGenericCalls.map(({ channel }) => channel))

if (!genericEventChannels) {
  errors.push('Could not parse GENERIC_EVENT_CHANNELS from electron/preload.ts')
} else {
  const rendererChannelsMissingFromAllowlist = sortedDifference(rendererGenericChannels, genericEventChannels)
  const unusedAllowlistChannels = sortedDifference(genericEventChannels, rendererGenericChannels)
  if (rendererChannelsMissingFromAllowlist.length > 0) {
    errors.push(`Renderer event channels missing from preload allowlist: ${rendererChannelsMissingFromAllowlist.join(', ')}`)
  }
  if (unusedAllowlistChannels.length > 0) {
    errors.push(`Unused channels in preload generic event allowlist: ${unusedAllowlistChannels.join(', ')}`)
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(
    `IPC parity OK: ${mainChannels.size} invoke channels, ` +
      `${duplicateMainHandlers.length} duplicate handlers, ` +
      `${pushChannels.size}/${EXPECTED_PUSH_CHANNELS.length} expected push channels found, ` +
      `${rendererGenericChannels.size} generic event channels allowlisted.`,
  )
}
