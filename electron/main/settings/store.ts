import type Database from 'better-sqlite3'
import {
  type CatalogAlbumArtworkProvider,
  type CatalogArtistArtworkProvider,
  type CatalogBioProvider,
  type CatalogLocalCreditGuidanceMode,
} from '../../../src/services/catalog'
import type { LyricsProviderId } from '../../../src/renderer/components/NowPlaying/LyricsProviderService'
import {
  normalizeDiscordArtworkUploadProvider,
  type DiscordArtworkUploadProvider,
} from '../../DiscordArtworkUploader'
import { getDb } from '../db'

export const DISCORD_RICH_PRESENCE_ENABLED_KEY = 'discordRichPresenceEnabled'
export const DISCORD_ARTWORK_UPLOAD_PROVIDER_KEY = 'discordArtworkUploadProvider'
export const DISCORD_CLOUDINARY_CLOUD_NAME_KEY = 'discordCloudinaryCloudName'
export const DISCORD_CLOUDINARY_UPLOAD_PRESET_KEY = 'discordCloudinaryUploadPreset'
export const DISCORD_CLOUDINARY_API_KEY_KEY = 'discordCloudinaryApiKey'
export const DISCORD_CLOUDINARY_API_SECRET_KEY = 'discordCloudinaryApiSecret'

export const STREAMING_AUDIO_CACHE_LIMIT_GB_KEY = 'streamingAudioCacheLimitGb'
export const DEFAULT_STREAMING_AUDIO_CACHE_LIMIT_GB = 10
export const LYRICS_MUSIXMATCH_API_KEY_KEY = 'lyricsMusixmatchApiKey'
export const LYRICS_GENIUS_API_KEY_KEY = 'lyricsGeniusApiKey'
export const LOCAL_ARTIST_SPLIT_VERSION_KEY = 'localArtistSplitVersion'
export const LOCAL_ARTIST_SPLIT_VERSION = 5

type ArtistBioSource = 'wikipedia' | 'metal-archives' | 'none'

const BUILTIN_ARTIST_BIO_PRIORITY: CatalogBioProvider[] = ['wikipedia', 'metal-archives', 'none']
const BUILTIN_ARTIST_ARTWORK_PRIORITY: CatalogArtistArtworkProvider[] = ['wikipedia', 'itunes', 'none']
const BUILTIN_ALBUM_ARTWORK_PRIORITY: CatalogAlbumArtworkProvider[] = ['coverartarchive', 'none']
const DEFAULT_LOCAL_CREDIT_GUIDANCE_MODE: CatalogLocalCreditGuidanceMode = 'provider_when_matched'

let getMetadataProviderIds = (_capability: 'metadata.bio' | 'metadata.artwork'): string[] => []

export function configureProviderMetadataSettings(
  resolver: (capability: 'metadata.bio' | 'metadata.artwork') => string[],
): void {
  getMetadataProviderIds = resolver
}

function artistBioDefaults(): CatalogBioProvider[] {
  return [...getMetadataProviderIds('metadata.bio'), ...BUILTIN_ARTIST_BIO_PRIORITY]
}

function artistArtworkDefaults(): CatalogArtistArtworkProvider[] {
  return [...getMetadataProviderIds('metadata.artwork'), ...BUILTIN_ARTIST_ARTWORK_PRIORITY]
}

function albumArtworkDefaults(): CatalogAlbumArtworkProvider[] {
  return [...getMetadataProviderIds('metadata.artwork'), ...BUILTIN_ALBUM_ARTWORK_PRIORITY]
}

export function getSettingForIpc(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined
  if (!row) {
    if (key === DISCORD_RICH_PRESENCE_ENABLED_KEY) {
      return process.env.DISCORD_RICH_PRESENCE_ENABLED ?? null
    }
    if (key === DISCORD_ARTWORK_UPLOAD_PROVIDER_KEY) {
      return process.env.DISCORD_ARTWORK_UPLOAD_PROVIDER ?? null
    }
    if (key === DISCORD_CLOUDINARY_CLOUD_NAME_KEY) {
      return process.env.DISCORD_CLOUDINARY_CLOUD_NAME ?? null
    }
    if (key === DISCORD_CLOUDINARY_UPLOAD_PRESET_KEY) {
      return process.env.DISCORD_CLOUDINARY_UPLOAD_PRESET ?? null
    }
    if (key === DISCORD_CLOUDINARY_API_KEY_KEY) {
      return process.env.DISCORD_CLOUDINARY_API_KEY ?? null
    }
    if (key === DISCORD_CLOUDINARY_API_SECRET_KEY) {
      return process.env.DISCORD_CLOUDINARY_API_SECRET ?? null
    }
    if (key === LYRICS_MUSIXMATCH_API_KEY_KEY) {
      return process.env.MUSIXMATCH_API_KEY ?? null
    }
    if (key === LYRICS_GENIUS_API_KEY_KEY) {
      return process.env.GENIUS_API_KEY ?? null
    }
    if (key === STREAMING_AUDIO_CACHE_LIMIT_GB_KEY) {
      return String(DEFAULT_STREAMING_AUDIO_CACHE_LIMIT_GB)
    }
  }
  return row?.value ?? null
}

export function setSettingValue(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}

export function deleteSettingValue(key: string): void {
  getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key)
}

export type SettingSideEffectDeps = {
  onDiscordSettingChanged: () => void
  onCatalogPriorityChanged: () => void
  onStreamingCacheLimitChanged: () => void
  onCreditGuidanceChanged: (action: 'change' | 'deletion') => void
  onMusicBrainzToggled: (value: string | null) => void
  onArtworkPriorityChanged: () => void
}

export function setSettingForIpc(
  key: string,
  value: string,
  deps: SettingSideEffectDeps,
): void {
  setSettingValue(key, value)
  if (key === DISCORD_RICH_PRESENCE_ENABLED_KEY) {
    deps.onDiscordSettingChanged()
  }
  if (key === 'catalogSourcePriority') {
    deps.onCatalogPriorityChanged()
  }
  if (key === STREAMING_AUDIO_CACHE_LIMIT_GB_KEY) {
    deps.onStreamingCacheLimitChanged()
  }
  if (key === 'localCreditGuidanceMode') {
    deps.onCreditGuidanceChanged('change')
  }
  if (key === 'metadataMusicBrainzEnabled') {
    deps.onMusicBrainzToggled(value)
  }
  if (
    key === 'artistArtworkSourcePriority'
    || key === 'albumArtworkSourcePriority'
  ) {
    deps.onArtworkPriorityChanged()
  }
}

export function deleteSettingForIpc(
  key: string,
  deps: SettingSideEffectDeps,
): void {
  deleteSettingValue(key)
  if (key === DISCORD_RICH_PRESENCE_ENABLED_KEY) {
    deps.onDiscordSettingChanged()
  }
  if (
    key === 'artistArtworkSourcePriority'
    || key === 'albumArtworkSourcePriority'
  ) {
    deps.onArtworkPriorityChanged()
  }
  if (key === 'localCreditGuidanceMode') {
    deps.onCreditGuidanceChanged('deletion')
  }
  if (key === 'metadataMusicBrainzEnabled') {
    deps.onMusicBrainzToggled(null)
  }
}

export function getSettingValue(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function getNumericSettingValue(db: Database.Database, key: string): number | null {
  const raw = getSettingValue(db, key)
  if (raw == null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function getDiscordRichPresenceEnabled(db: Database.Database): boolean {
  const stored = getSettingValue(db, DISCORD_RICH_PRESENCE_ENABLED_KEY)
  if (stored === 'true') return true
  if (stored === 'false') return false
  return process.env.DISCORD_RICH_PRESENCE_ENABLED === 'true'
}

export function getDiscordArtworkUploadProvider(db: Database.Database): DiscordArtworkUploadProvider {
  const stored = getSettingValue(db, DISCORD_ARTWORK_UPLOAD_PROVIDER_KEY)
  if (stored) return normalizeDiscordArtworkUploadProvider(stored)
  return normalizeDiscordArtworkUploadProvider(process.env.DISCORD_ARTWORK_UPLOAD_PROVIDER)
}

export function getDiscordCloudinaryCloudName(db: Database.Database): string {
  const stored = getSettingValue(db, DISCORD_CLOUDINARY_CLOUD_NAME_KEY)?.trim()
  if (stored) return stored
  return process.env.DISCORD_CLOUDINARY_CLOUD_NAME?.trim() ?? ''
}

export function getDiscordCloudinaryUploadPreset(db: Database.Database): string {
  const stored = getSettingValue(db, DISCORD_CLOUDINARY_UPLOAD_PRESET_KEY)?.trim()
  if (stored) return stored
  return process.env.DISCORD_CLOUDINARY_UPLOAD_PRESET?.trim() ?? ''
}

export function getDiscordCloudinaryApiKey(db: Database.Database): string {
  const stored = getSettingValue(db, DISCORD_CLOUDINARY_API_KEY_KEY)?.trim()
  if (stored) return stored
  return process.env.DISCORD_CLOUDINARY_API_KEY?.trim() ?? ''
}

export function getDiscordCloudinaryApiSecret(db: Database.Database): string {
  const stored = getSettingValue(db, DISCORD_CLOUDINARY_API_SECRET_KEY)?.trim()
  if (stored) return stored
  return process.env.DISCORD_CLOUDINARY_API_SECRET?.trim() ?? ''
}

export function getLyricsProviderApiKey(
  db: Database.Database,
  provider: Exclude<LyricsProviderId, 'lrclib'>,
): string {
  const key = provider === 'musixmatch'
    ? LYRICS_MUSIXMATCH_API_KEY_KEY
    : LYRICS_GENIUS_API_KEY_KEY
  const stored = getSettingValue(db, key)?.trim()
  if (stored) return stored
  return provider === 'musixmatch'
    ? process.env.MUSIXMATCH_API_KEY?.trim() ?? ''
    : process.env.GENIUS_API_KEY?.trim() ?? ''
}

export function getArtistBioSource(db: Database.Database): ArtistBioSource {
  const value = getSettingValue(db, 'artistBioSource')
  return value === 'none' ? 'none' : 'wikipedia'
}

export function getLocalCreditGuidanceMode(): CatalogLocalCreditGuidanceMode {
  const raw = getSettingValue(getDb(), 'localCreditGuidanceMode')
  return raw === 'local_only' ? 'local_only' : DEFAULT_LOCAL_CREDIT_GUIDANCE_MODE
}

export function getArtistBioSourcePriority(db: Database.Database): CatalogBioProvider[] {
  const defaults = artistBioDefaults()
  const allowed = new Set(defaults)
  const raw = getSettingValue(db, 'artistBioSourcePriority')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const normalized = parsed.filter((value): value is CatalogBioProvider => typeof value === 'string' && allowed.has(value))
        const next = [...normalized]
        for (const provider of defaults) {
          if (!next.includes(provider)) next.push(provider)
        }
        return next
      }
    } catch {
      // ignore malformed preference
    }
  }

  const legacy = getArtistBioSource(db)
  if (legacy === 'none') return ['none', ...defaults.filter((source) => source !== 'none')]
  return ['wikipedia', ...defaults.filter((source) => source !== 'wikipedia')]
}

export function getArtistArtworkSourcePriority(db: Database.Database): CatalogArtistArtworkProvider[] {
  const defaults = artistArtworkDefaults()
  const allowed = new Set(defaults)
  const raw = getSettingValue(db, 'artistArtworkSourcePriority')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const normalized = parsed.filter((value): value is CatalogArtistArtworkProvider => typeof value === 'string' && allowed.has(value))
        const next = [...normalized]
        for (const provider of defaults) {
          if (!next.includes(provider)) next.push(provider)
        }
        return next
      }
    } catch {
      // ignore malformed preference
    }
  }
  return defaults
}

export function getAlbumArtworkSourcePriority(db: Database.Database): CatalogAlbumArtworkProvider[] {
  const defaults = albumArtworkDefaults()
  const allowed = new Set(defaults)
  const raw = getSettingValue(db, 'albumArtworkSourcePriority')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const normalized = parsed.filter((value): value is CatalogAlbumArtworkProvider => typeof value === 'string' && allowed.has(value))
        const next = [...normalized]
        for (const provider of defaults) {
          if (!next.includes(provider)) next.push(provider)
        }
        return next
      }
    } catch {
      // ignore malformed preference
    }
  }
  return defaults
}

export function getMetadataMusicBrainzEnabled(db: Database.Database): boolean {
  const raw = getSettingValue(db, 'metadataMusicBrainzEnabled')
  return raw == null ? true : raw === 'true'
}
