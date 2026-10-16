import path from 'node:path'
import {
  API_VERSION,
  PROVIDER_CAPABILITIES_V1,
  PROVIDER_HOST_FEATURES_V1,
  PROVIDER_SESSION_ID_PATTERN,
  ProviderApiError,
  isValidProviderId,
  type FormatInfoV1,
  type PlaybackArtifactV1,
  type ProviderCapabilityV1,
  type ProviderErrorCodeV1,
  type ProviderErrorV1,
  type ProviderManifestV1,
  type ProviderValueV1,
} from '../../../src/provider-api/v1'
import { resolveAllowedExistingFile } from '../security/pathPolicy'

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i
const MAX_VALUE_DEPTH = 32
const MAX_VALUE_BYTES = 8 * 1024 * 1024
const capabilities = new Set<string>(PROVIDER_CAPABILITIES_V1)

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

function isRelativeContainedPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300 || path.isAbsolute(value)) return false
  return !value.split(/[\\/]/).includes('..')
}

function isHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && url.pathname === '/'
  } catch {
    return false
  }
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function validateSettings(settings: unknown, errors: string[]): void {
  if (settings === undefined) return
  if (!Array.isArray(settings)) {
    errors.push('settings must be an array')
    return
  }
  const ids = new Set<string>()
  for (const [index, setting] of settings.entries()) {
    if (!isRecord(setting)) {
      errors.push(`settings[${index}] must be an object`)
      continue
    }
    if (!isIdentifier(setting.id) || ids.has(setting.id)) errors.push(`settings[${index}].id is invalid or duplicated`)
    else ids.add(setting.id)
    if (typeof setting.label !== 'string' || setting.label.length === 0 || setting.label.length > 100) {
      errors.push(`settings[${index}].label is invalid`)
    }
    if (setting.description !== undefined && (typeof setting.description !== 'string' || setting.description.length > 300)) {
      errors.push(`settings[${index}].description is invalid`)
    }
    if (!['text', 'select', 'toggle', 'action', 'status', 'form'].includes(String(setting.type))) {
      errors.push(`settings[${index}].type is invalid`)
      continue
    }
    if (setting.type === 'text') {
      if (!isIdentifier(setting.key) || !['setting', 'secret'].includes(String(setting.storage))) {
        errors.push(`settings[${index}] has an invalid text storage declaration`)
      }
    } else if (setting.type === 'select') {
      if (!isIdentifier(setting.key) || setting.storage !== 'setting' || !Array.isArray(setting.options) || setting.options.length === 0) {
        errors.push(`settings[${index}] has an invalid select declaration`)
      }
    } else if (setting.type === 'toggle') {
      if (!isIdentifier(setting.key) || setting.storage !== 'setting') errors.push(`settings[${index}] has an invalid toggle declaration`)
    } else if (setting.type === 'action') {
      const action = setting.action
      if (!isRecord(action) || !capabilities.has(String(action.capability)) || !isIdentifier(action.method)) {
        errors.push(`settings[${index}] has an invalid action declaration`)
      }
    } else if (setting.type === 'form') {
      validateFormSetting(setting, index, errors)
    } else if (!isIdentifier(setting.statusKey)) {
      errors.push(`settings[${index}].statusKey is invalid`)
    }
  }
}

const MAX_FORM_FIELDS = 8
export const MAX_FORM_FIELD_LENGTH = 65_536

function validateFormSetting(setting: Record<string, unknown>, index: number, errors: string[]): void {
  const submit = setting.submit
  if (!isRecord(submit) || !capabilities.has(String(submit.capability)) || !isIdentifier(submit.method)
    || typeof submit.label !== 'string' || submit.label.length === 0 || submit.label.length > 60) {
    errors.push(`settings[${index}] has an invalid form submit declaration`)
  }
  if (setting.instructions !== undefined && (
    !isStringArray(setting.instructions) || setting.instructions.length > 12
    || !setting.instructions.every((step) => step.length > 0 && step.length <= 300)
  )) errors.push(`settings[${index}].instructions is invalid`)
  const fields = setting.fields
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_FORM_FIELDS) {
    errors.push(`settings[${index}].fields must list 1-${MAX_FORM_FIELDS} fields`)
    return
  }
  const ids = new Set<string>()
  for (const [fieldIndex, field] of fields.entries()) {
    const at = `settings[${index}].fields[${fieldIndex}]`
    if (!isRecord(field) || !isIdentifier(field.id) || ids.has(field.id)) {
      errors.push(`${at}.id is invalid or duplicated`)
      continue
    }
    ids.add(field.id)
    if (typeof field.label !== 'string' || field.label.length === 0 || field.label.length > 100) errors.push(`${at}.label is invalid`)
    for (const key of ['description', 'placeholder'] as const) {
      if (field[key] !== undefined && (typeof field[key] !== 'string' || String(field[key]).length > 300)) errors.push(`${at}.${key} is invalid`)
    }
    for (const key of ['multiline', 'sensitive', 'required'] as const) {
      if (field[key] !== undefined && typeof field[key] !== 'boolean') errors.push(`${at}.${key} must be boolean`)
    }
    if (field.maxLength !== undefined && (
      !Number.isInteger(field.maxLength) || Number(field.maxLength) < 1 || Number(field.maxLength) > MAX_FORM_FIELD_LENGTH
    )) errors.push(`${at}.maxLength is invalid`)
  }
}

function validatePermissions(permissions: unknown, errors: string[]): void {
  if (permissions === undefined) return
  if (!isRecord(permissions)) {
    errors.push('permissions must be an object')
    return
  }
  if (permissions.runtimeEnvironment !== undefined && (
    !isStringArray(permissions.runtimeEnvironment)
    || !permissions.runtimeEnvironment.every((name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name))
    || !hasUniqueStrings(permissions.runtimeEnvironment)
  )) errors.push('permissions.runtimeEnvironment must contain unique environment names')
  for (const key of ['networkOrigins', 'externalOrigins'] as const) {
    const origins = permissions[key]
    if (origins !== undefined && (!isStringArray(origins) || !origins.every(isHttpsOrigin) || !hasUniqueStrings(origins))) {
      errors.push(`permissions.${key} must contain unique HTTPS origins`)
    }
  }
  if (permissions.secrets !== undefined && (
    !isStringArray(permissions.secrets)
    || !permissions.secrets.every(isIdentifier)
    || !hasUniqueStrings(permissions.secrets)
  )) errors.push('permissions.secrets must contain unique identifiers')

  if (permissions.helpers !== undefined) {
    if (!Array.isArray(permissions.helpers)) errors.push('permissions.helpers must be an array')
    else for (const [index, helper] of permissions.helpers.entries()) {
      if (!isRecord(helper) || !isIdentifier(helper.id) || !isRelativeContainedPath(helper.executable)) {
        errors.push(`permissions.helpers[${index}] is invalid`)
        continue
      }
      if (helper.processPriority !== undefined && helper.processPriority !== 'below-normal') {
        errors.push(`permissions.helpers[${index}].processPriority is invalid`)
      }
      if (helper.allowedArguments !== undefined && (
        !isStringArray(helper.allowedArguments)
        || !helper.allowedArguments.every((argument) => argument.length <= 100)
        || !hasUniqueStrings(helper.allowedArguments)
      )) errors.push(`permissions.helpers[${index}].allowedArguments is invalid`)
      if (helper.argumentTemplate !== undefined) {
        const template = helper.argumentTemplate
        if (helper.allowedArguments !== undefined || !Array.isArray(template) || template.length < 2 || template.length > 32) {
          errors.push(`permissions.helpers[${index}].argumentTemplate is invalid`)
          continue
        }
        const slots: string[] = []
        for (const argument of template) {
          if (typeof argument === 'string' && argument.length > 0 && argument.length <= 100) continue
          if (isRecord(argument) && Object.keys(argument).length === 1 && ['input', 'output'].includes(String(argument.cachePath))) {
            slots.push(String(argument.cachePath))
            continue
          }
          errors.push(`permissions.helpers[${index}].argumentTemplate has an invalid slot`)
        }
        if (slots.filter((slot) => slot === 'input').length !== 1 || slots.filter((slot) => slot === 'output').length > 1) {
          errors.push(`permissions.helpers[${index}].argumentTemplate requires one cache input and at most one output`)
        }
      }
    }
  }
  if (permissions.authCollections !== undefined) {
    if (!Array.isArray(permissions.authCollections)) errors.push('permissions.authCollections must be an array')
    else for (const [index, collection] of permissions.authCollections.entries()) {
      if (!isRecord(collection) || !isIdentifier(collection.id)) {
        errors.push(`permissions.authCollections[${index}] is invalid`)
        continue
      }
      if (!isStringArray(collection.allowedOrigins) || !collection.allowedOrigins.every(isHttpsOrigin)) {
        errors.push(`permissions.authCollections[${index}].allowedOrigins is invalid`)
      }
      if (!Array.isArray(collection.values)) errors.push(`permissions.authCollections[${index}].values must be an array`)
      else for (const [valueIndex, descriptor] of collection.values.entries()) {
        if (!isAuthCollectDescriptor(descriptor)) errors.push(`permissions.authCollections[${index}].values[${valueIndex}] is invalid`)
      }
    }
  }
}

const COOKIE_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function isAuthCollectDescriptor(value: unknown): boolean {
  if (!isRecord(value) || !isIdentifier(value.name)) return false
  const hasOnly = (...keys: string[]) => Object.keys(value).every((key) => keys.includes(key))
  switch (value.source) {
    case 'cookie':
      return hasOnly('name', 'source', 'cookieName', 'domain', 'path') && typeof value.cookieName === 'string' && value.cookieName.length > 0
        && (value.domain === undefined || typeof value.domain === 'string') && (value.path === undefined || typeof value.path === 'string')
    case 'localStorage':
    case 'url.searchParam':
      return hasOnly('name', 'source', 'origin', 'key') && isHttpsOrigin(value.origin) && typeof value.key === 'string' && value.key.length > 0
    case 'cookieJar':
      return hasOnly('name', 'source', 'origin', 'domains', 'requiredCookies') && isHttpsOrigin(value.origin)
        && isStringArray(value.domains) && value.domains.length >= 1 && value.domains.length <= 8 && hasUniqueStrings(value.domains)
        && value.domains.every((domain) => COOKIE_DOMAIN_PATTERN.test(domain))
        && isStringArray(value.requiredCookies) && value.requiredCookies.length >= 1 && value.requiredCookies.length <= 16
        && hasUniqueStrings(value.requiredCookies) && value.requiredCookies.every((name) => COOKIE_NAME_PATTERN.test(name))
    default:
      return false
  }
}

function validateBuild(build: unknown, errors: string[]): void {
  if (build === undefined) return
  if (!isRecord(build)) {
    errors.push('build must be an object')
    return
  }
  if (build.steps !== undefined) {
    if (!Array.isArray(build.steps)) errors.push('build.steps must be an array')
    else for (const [index, step] of build.steps.entries()) {
      if (!isRecord(step) || !isRelativeContainedPath(step.command) || (step.cwd !== undefined && !isRelativeContainedPath(step.cwd))) {
        errors.push(`build.steps[${index}] must use provider-relative paths`)
      }
    }
  }
  if (build.extraResources !== undefined) {
    if (!Array.isArray(build.extraResources)) errors.push('build.extraResources must be an array')
    else for (const [index, resource] of build.extraResources.entries()) {
      if (!isRecord(resource) || !isRelativeContainedPath(resource.from) || !isRelativeContainedPath(resource.to)) {
        errors.push(`build.extraResources[${index}] is invalid`)
      }
    }
  }
  if (build.binaries !== undefined && (
    !isStringArray(build.binaries)
    || !build.binaries.every(isRelativeContainedPath)
    || !hasUniqueStrings(build.binaries)
  )) errors.push('build.binaries must contain unique relative paths')
}

export function validateProviderManifest(value: unknown): { ok: true; manifest: ProviderManifestV1 } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['manifest must be an object'] }
  const knownKeys = new Set([
    'schemaVersion', 'apiVersion', 'id', 'version', 'displayName', 'description', 'homepage',
    'icon', 'brandColor', 'defaultPriority', 'capabilities', 'librarySyncMode', 'playbackTimeoutMs', 'requiredHostFeatures',
    'settings', 'permissions', 'build',
  ])
  for (const key of Object.keys(value)) if (!knownKeys.has(key)) errors.push(`unknown manifest property: ${key}`)
  if (value.requiredHostFeatures !== undefined) {
    if (!isStringArray(value.requiredHostFeatures) || !hasUniqueStrings(value.requiredHostFeatures)) {
      errors.push('requiredHostFeatures must contain unique feature names')
    } else {
      const supported: readonly string[] = PROVIDER_HOST_FEATURES_V1
      for (const feature of value.requiredHostFeatures) {
        if (!supported.includes(feature)) errors.push(`provider requires a host feature this Puros does not support: ${feature}`)
      }
    }
  }
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (value.apiVersion !== API_VERSION) errors.push(`apiVersion must be ${API_VERSION}`)
  if (!isValidProviderId(value.id)) errors.push('id is invalid or reserved')
  if (typeof value.version !== 'string' || value.version.length < 1 || value.version.length > 64) errors.push('version is invalid')
  if (typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 80) errors.push('displayName is invalid')
  if (!isRelativeContainedPath(value.icon)) errors.push('icon must be a provider-relative path')
  if (typeof value.brandColor !== 'string' || !HEX_COLOR_PATTERN.test(value.brandColor)) errors.push('brandColor must be #RRGGBB')
  if (!Number.isInteger(value.defaultPriority) || Number(value.defaultPriority) < 0 || Number(value.defaultPriority) > 1_000_000) {
    errors.push('defaultPriority must be an integer from 0 to 1000000')
  }
  if (!isStringArray(value.capabilities) || !value.capabilities.every((item) => capabilities.has(item)) || !hasUniqueStrings(value.capabilities)) {
    errors.push('capabilities must contain unique v1 capability names')
  }
  if (value.librarySyncMode !== undefined && (
    value.librarySyncMode !== 'host-mirror'
    || !Array.isArray(value.capabilities)
    || !value.capabilities.includes('library.sync')
  )) errors.push('librarySyncMode requires library.sync and must be host-mirror')
  if (value.playbackTimeoutMs !== undefined && (
    !Number.isInteger(value.playbackTimeoutMs)
    || Number(value.playbackTimeoutMs) < 120_000
    || Number(value.playbackTimeoutMs) > 1_800_000
    || !Array.isArray(value.capabilities)
    || !value.capabilities.includes('playback.resolve')
  )) errors.push('playbackTimeoutMs requires playback.resolve and must be an integer from 120000 to 1800000')
  if (value.homepage !== undefined && (typeof value.homepage !== 'string' || !value.homepage.startsWith('https://'))) {
    errors.push('homepage must be an HTTPS URL')
  }
  validateSettings(value.settings, errors)
  if (Array.isArray(value.settings) && value.settings.some((setting) => isRecord(setting) && setting.type === 'form')
    && !(Array.isArray(value.requiredHostFeatures) && value.requiredHostFeatures.includes('settings.form'))) {
    errors.push('form settings require the settings.form host feature')
  }
  if (isRecord(value.permissions) && Array.isArray(value.permissions.authCollections)
    && value.permissions.authCollections.some((collection) => isRecord(collection) && Array.isArray(collection.values)
      && collection.values.some((descriptor) => isRecord(descriptor) && descriptor.source === 'cookieJar'))
    && !(Array.isArray(value.requiredHostFeatures) && value.requiredHostFeatures.includes('auth.browser-session'))) {
    errors.push('cookieJar auth collections require the auth.browser-session host feature')
  }
  validatePermissions(value.permissions, errors)
  if (isRecord(value.permissions) && Array.isArray(value.permissions.runtimeEnvironment) && typeof value.id === 'string') {
    const prefix = `${value.id.replace(/-/g, '_').toUpperCase()}_`
    if (value.permissions.runtimeEnvironment.some((name) => typeof name !== 'string' || !name.startsWith(prefix))) {
      errors.push('permissions.runtimeEnvironment must use the provider namespace')
    }
  }
  validateBuild(value.build, errors)
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, manifest: value as unknown as ProviderManifestV1 }
}

export function assertProviderValue(
  value: unknown,
  options: { allowUndefined?: boolean; allowUint8Array?: boolean; maxBytes?: number; maxDepth?: number } = {},
): asserts value is ProviderValueV1 | undefined {
  const seen = new Set<object>()
  let bytes = 0
  const maxBytes = options.maxBytes ?? MAX_VALUE_BYTES
  const maxDepth = options.maxDepth ?? MAX_VALUE_DEPTH
  const visit = (current: unknown, depth: number): void => {
    if (depth > maxDepth) throw new TypeError('Provider payload exceeds the nesting limit')
    if (current === undefined && options.allowUndefined) return
    if (current === null || typeof current === 'boolean') { bytes += 4; return }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Provider payload numbers must be finite')
      bytes += 8
      return
    }
    if (typeof current === 'string') { bytes += Buffer.byteLength(current); return }
    if (current instanceof Uint8Array && options.allowUint8Array) { bytes += current.byteLength; return }
    if (typeof current !== 'object' || current === null) throw new TypeError('Provider payload is not structured-clone safe')
    if (seen.has(current)) throw new TypeError('Provider payload must not contain cycles')
    if (!Array.isArray(current) && !isPlainRecord(current)) throw new TypeError('Provider payload must contain only arrays and plain objects')
    seen.add(current)
    if (Array.isArray(current)) current.forEach((item) => visit(item, depth + 1))
    else for (const [key, item] of Object.entries(current)) {
      bytes += Buffer.byteLength(key)
      visit(item, depth + 1)
    }
    seen.delete(current)
    if (bytes > maxBytes) throw new TypeError('Provider payload exceeds the size limit')
  }
  visit(value, 0)
}

export function validateInvokeInput(
  providerId: unknown,
  capability: unknown,
  method: unknown,
  args: unknown,
): { providerId: string; capability: ProviderCapabilityV1; method: string; args: ProviderValueV1[] } {
  if (!isValidProviderId(providerId)) throw new TypeError('Invalid provider ID')
  if (typeof capability !== 'string' || !capabilities.has(capability)) throw new TypeError('Invalid provider capability')
  if (typeof method !== 'string' || !METHOD_PATTERN.test(method)) throw new TypeError('Invalid provider method')
  if (!Array.isArray(args)) throw new TypeError('Provider args must be an array')
  assertProviderValue(args)
  return { providerId, capability: capability as ProviderCapabilityV1, method, args: args as ProviderValueV1[] }
}

const AUDIO_FORMATS_V1: ReadonlySet<string> = new Set([
  'FLAC', 'FLAC_HIRES', 'MQA', 'DSD', 'ALAC', 'AIFF', 'WAV', 'MP3', 'AAC', 'VORBIS', 'OPUS',
])

/** Lossy codecs: never lossless, Hi-Res, MQA or DSD, whatever the decoder's PCM looks like. */
const LOSSY_AUDIO_FORMATS_V1: ReadonlySet<string> = new Set(['MP3', 'AAC', 'VORBIS', 'OPUS'])

/** Shape check for a provider-supplied `FormatInfoV1`. */
export function validateFormatInfo(format: FormatInfoV1): void {
  assertProviderValue(format)
  if (!format || typeof format.format !== 'string' || !AUDIO_FORMATS_V1.has(format.format)) {
    throw new TypeError('Invalid provider audio format')
  }
  for (const key of ['sampleRate', 'bitDepth', 'bitrate', 'channels'] as const) {
    if (!Number.isFinite(format[key]) || format[key] < 0) throw new TypeError(`Invalid provider format ${key}`)
  }
  for (const key of ['isLossless', 'isHiRes', 'isMqa', 'isDsd'] as const) {
    if (typeof format[key] !== 'boolean') throw new TypeError(`Invalid provider format ${key}`)
  }
  if (LOSSY_AUDIO_FORMATS_V1.has(format.format) && (format.isLossless || format.isHiRes || format.isMqa || format.isDsd)) {
    throw new TypeError(`Provider format ${format.format} is lossy and cannot be labelled lossless, Hi-Res, MQA or DSD`)
  }
  // The Opus decoder always runs at 48 kHz; the header's input rate is informational only.
  if (format.format === 'OPUS' && format.sampleRate !== 0 && format.sampleRate !== 48_000) {
    throw new TypeError('Provider OPUS format must report the 48 kHz decode rate')
  }
}

export function validatePlaybackArtifact(
  artifact: PlaybackArtifactV1,
  cacheRoot: string,
  hasProgressiveCapability: boolean,
): PlaybackArtifactV1 {
  if (!isRecord(artifact) || (artifact.lifecycle !== 'complete' && artifact.lifecycle !== 'growing')) {
    throw new TypeError('Provider returned an invalid playback artifact')
  }
  if (artifact.lifecycle === 'growing' && (!artifact.sessionId || !hasProgressiveCapability)) {
    throw new TypeError('Growing playback artifacts require a sessionId and playback.progressive capability')
  }
  if (artifact.sessionId !== undefined && (
    typeof artifact.sessionId !== 'string' || !PROVIDER_SESSION_ID_PATTERN.test(artifact.sessionId)
  )) throw new TypeError('Invalid playback artifact session ID')
  if (artifact.sourceFormat !== undefined) validateFormatInfo(artifact.sourceFormat)
  const allowedPath = resolveAllowedExistingFile(artifact.path, [cacheRoot])
  if (!allowedPath) throw new TypeError('Playback artifact path is outside the provider cache root')
  return { ...artifact, path: allowedPath }
}

const PROVIDER_ERROR_CODES: ReadonlySet<ProviderErrorCodeV1> = new Set<ProviderErrorCodeV1>([
  'INVALID_ARGUMENT', 'NOT_SUPPORTED', 'NOT_AUTHENTICATED', 'AUTH_EXPIRED', 'NOT_FOUND', 'RATE_LIMITED',
  'NETWORK', 'TIMEOUT', 'CANCELLED', 'PATH_OUTSIDE_CACHE', 'PERMISSION_DENIED', 'INCOMPATIBLE_API',
  'PROVIDER_UNAVAILABLE', 'PROVIDER_CRASHED', 'INTERNAL',
])

/**
 * Typed provider failure carried by `error`, or null. Separately compiled
 * provider packages bundle their own copy of `ProviderApiError`, so the class
 * identity cannot be relied on; a same-named error with a valid v1 error shape
 * is accepted, and only its known fields are copied.
 */
export function toProviderError(error: unknown): ProviderErrorV1 | null {
  if (error instanceof ProviderApiError) return error.providerError
  if (!error || typeof error !== 'object' || (error as { name?: unknown }).name !== 'ProviderApiError') return null
  const candidate = (error as { providerError?: unknown }).providerError
  if (!candidate || typeof candidate !== 'object') return null
  const { code, message, retryable, retryAfterMs, details } = candidate as Record<string, unknown>
  if (typeof code !== 'string' || !PROVIDER_ERROR_CODES.has(code as ProviderErrorCodeV1)) return null
  if (typeof message !== 'string' || typeof retryable !== 'boolean') return null
  const normalized: ProviderErrorV1 = { code: code as ProviderErrorCodeV1, message: message.slice(0, 2_000), retryable }
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) normalized.retryAfterMs = retryAfterMs
  if (details !== undefined) {
    try {
      assertProviderValue(details)
      if (details && typeof details === 'object' && !Array.isArray(details)) normalized.details = details as Record<string, ProviderValueV1>
    } catch {
      // Malformed details are dropped; the typed code and message still reach the caller.
    }
  }
  return normalized
}
