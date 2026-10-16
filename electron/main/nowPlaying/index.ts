import { setVisualizerTrack, setVisualizerPlaying, clearVisualizerTrack } from './visualizerState'
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import { DiscordRichPresenceService } from "../../DiscordRichPresence"
import {
  prepareDiscordArtworkUpload,
  uploadDiscordArtwork,
  type DiscordArtworkUploadProvider,
} from "../../DiscordArtworkUploader"
import { getAudioEngine } from "../audio/engine"
import { getDb } from "../db"
import { setPlaybackState } from "../playbackCoordinator"
import { invokeProvider, listProviderDescriptors } from "../providers"
import { parseSourceEntityId } from "../../../src/services/catalog/sourceIdentity"
import { decodeDataUri, detectImageMime, mimeTypeFromPath, normalizeArtworkMime } from "../shared/mime"
import {
  getDiscordArtworkUploadProvider,
  getDiscordCloudinaryApiKey,
  getDiscordCloudinaryApiSecret,
  getDiscordCloudinaryCloudName,
  getDiscordCloudinaryUploadPreset,
  getDiscordRichPresenceEnabled,
} from "../settings/store"

const discordPresence = new DiscordRichPresenceService()
const discordArtworkUploadTasks = new Map<string, Promise<string | null>>()
const discordProviderLinkTasks = new Map<string, Promise<{
  providerLabel: string; providerTrackUrl: string
} | null>>()
let discordNowPlayingRevision = 0

function resolveArtworkAssetForNowPlaying(
  artwork: string | null | undefined,
): { mimeType: string; data: Buffer } | null {
  if (!artwork) return null

  if (artwork.startsWith('data:')) {
    return decodeDataUri(artwork)
  }

  try {
    const url = new URL(artwork)

    if (url.protocol === 'artwork:') {
      if (url.hostname === 'cache') {
        const artworkId = decodeURIComponent(url.pathname.slice(1))
        const row = getDb().prepare(
          `SELECT mime_type, data FROM artwork_cache WHERE id = ?`
        ).get(artworkId) as { mime_type: string; data: Buffer } | undefined

        if (!row) return null

        return {
          mimeType: normalizeArtworkMime(row.mime_type),
          data: row.data,
        }
      }

      if (url.hostname === 'file') {
        const filePath = url.searchParams.get('path')
        if (!filePath) return null
        const data = fs.readFileSync(filePath)
        return {
          mimeType: detectImageMime(data, mimeTypeFromPath(filePath)),
          data,
        }
      }
    }

    if (url.protocol === 'file:') {
      const filePath = fileURLToPath(url)
      const data = fs.readFileSync(filePath)
      return {
        mimeType: detectImageMime(data, mimeTypeFromPath(filePath)),
        data,
      }
    }
  } catch {
    // fall through to path-based resolution below
  }

  if (path.isAbsolute(artwork) && fs.existsSync(artwork)) {
    const data = fs.readFileSync(artwork)
    return {
      mimeType: detectImageMime(data, mimeTypeFromPath(artwork)),
      data,
    }
  }

  return null
}

function normalizeDiscordExternalImageUrl(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null
  if (normalized.startsWith('https://') || normalized.startsWith('http://')) return normalized
  return null
}

function resolveDirectDiscordArtworkUrl(payload: {
  title?: string | null
  artist?: string | null
  album?: string | null
  artworkUrl?: string | null
  discordArtworkUrl?: string | null
  sourceType?: string | null
  sourceId?: string | null
  provider?: string | null
  catalogTrackId?: string | null
}): string | null {
  const direct = normalizeDiscordExternalImageUrl(payload.discordArtworkUrl)
    ?? normalizeDiscordExternalImageUrl(payload.artworkUrl)
  if (direct) return direct
  const preferredProvider = payload.provider?.trim() || payload.sourceType?.trim() || null

  if (payload.catalogTrackId) {
    const row = getDb().prepare(`
      SELECT artwork_url
      FROM catalog_tracks
      WHERE id = ?
      LIMIT 1
    `).get(payload.catalogTrackId) as { artwork_url: string | null } | undefined
    const resolved = normalizeDiscordExternalImageUrl(row?.artwork_url)
    if (resolved) return resolved
  }

  if (payload.sourceId) {
    const syncedTrackRow = getDb().prepare(`
      SELECT
        t.source,
        t.art_path AS track_art_path,
        al.art_path AS album_art_path
      FROM tracks t
      LEFT JOIN albums al ON al.id = t.album_id
      WHERE t.source_id = ?
      ORDER BY CASE WHEN t.source = ? THEN 0 ELSE 1 END, t.id ASC
      LIMIT 1
    `).get(payload.sourceId, preferredProvider) as {
      source: string | null
      track_art_path: string | null
      album_art_path: string | null
    } | undefined

    const syncedResolved = normalizeDiscordExternalImageUrl(syncedTrackRow?.album_art_path)
      ?? normalizeDiscordExternalImageUrl(syncedTrackRow?.track_art_path)
    if (syncedResolved) return syncedResolved

    const row = getDb().prepare(`
      SELECT ct.artwork_url
      FROM catalog_track_sources cts
      JOIN catalog_tracks ct ON ct.id = cts.catalog_track_id
      WHERE cts.source_id = ?
      ORDER BY CASE WHEN cts.provider = ? THEN 0 ELSE 1 END, cts.catalog_track_id ASC
      LIMIT 1
    `).get(payload.sourceId, preferredProvider) as { artwork_url: string | null } | undefined
    const resolved = normalizeDiscordExternalImageUrl(row?.artwork_url)
    if (resolved) return resolved
  }

  const normalizedTitle = String(payload.title ?? '').trim().toLowerCase()
  const normalizedArtist = String(payload.artist ?? '').trim().toLowerCase()
  const normalizedAlbum = String(payload.album ?? '').trim().toLowerCase()
  if (normalizedTitle && normalizedArtist) {
    const fuzzyRow = getDb().prepare(`
      SELECT
        t.source,
        t.art_path AS track_art_path,
        al.art_path AS album_art_path,
        ct.artwork_url
      FROM tracks t
      LEFT JOIN albums al ON al.id = t.album_id
      LEFT JOIN catalog_track_sources cts
        ON cts.source_id = COALESCE(t.source_id, CAST(t.id AS TEXT))
        AND cts.provider = t.source
      LEFT JOIN catalog_tracks ct ON ct.id = cts.catalog_track_id
      LEFT JOIN artists ar ON ar.id = t.artist_id
      WHERE lower(t.title) = ?
        AND lower(COALESCE(ar.name, '')) = ?
        AND (? = '' OR lower(COALESCE(al.title, '')) = ?)
      ORDER BY CASE WHEN t.source = ? THEN 0 ELSE 1 END, t.id ASC
      LIMIT 1
    `).get(
      normalizedTitle,
      normalizedArtist,
      normalizedAlbum,
      normalizedAlbum,
      preferredProvider,
    ) as {
      source: string | null
      track_art_path: string | null
      album_art_path: string | null
      artwork_url: string | null
    } | undefined

    const fuzzyResolved = normalizeDiscordExternalImageUrl(fuzzyRow?.album_art_path)
      ?? normalizeDiscordExternalImageUrl(fuzzyRow?.artwork_url)
      ?? normalizeDiscordExternalImageUrl(fuzzyRow?.track_art_path)
    if (fuzzyResolved) return fuzzyResolved
  }

  return null
}

function getCachedDiscordArtworkUpload(provider: DiscordArtworkUploadProvider, contentHash: string): string | null {
  const row = getDb().prepare(`
    SELECT external_url
    FROM discord_artwork_uploads
    WHERE provider = ? AND content_hash = ?
    LIMIT 1
  `).get(provider, contentHash) as { external_url: string | null } | undefined

  const url = normalizeDiscordExternalImageUrl(row?.external_url)
  if (!url) return null

  getDb().prepare(`
    UPDATE discord_artwork_uploads
    SET last_used_at = strftime('%s', 'now')
    WHERE provider = ? AND content_hash = ?
  `).run(provider, contentHash)

  return url
}

function storeDiscordArtworkUpload(provider: DiscordArtworkUploadProvider, contentHash: string, externalUrl: string) {
  getDb().prepare(`
    INSERT INTO discord_artwork_uploads (
      provider, content_hash, external_url, created_at, updated_at, last_used_at
    ) VALUES (
      ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'), strftime('%s', 'now')
    )
    ON CONFLICT(provider, content_hash) DO UPDATE SET
      external_url = excluded.external_url,
      updated_at = strftime('%s', 'now'),
      last_used_at = strftime('%s', 'now')
  `).run(provider, contentHash, externalUrl)
}

async function resolveUploadedDiscordArtworkUrl(payload: {
  artworkUrl?: string | null
}): Promise<string | null> {
  const db = getDb()
  const provider = getDiscordArtworkUploadProvider(db)
  if (provider === 'none') return null

  const cloudinaryCloudName = getDiscordCloudinaryCloudName(db)
  const cloudinaryUploadPreset = getDiscordCloudinaryUploadPreset(db)
  const cloudinaryApiKey = getDiscordCloudinaryApiKey(db)
  const cloudinaryApiSecret = getDiscordCloudinaryApiSecret(db)
  if (
    provider === 'cloudinary' &&
    (
      !cloudinaryCloudName ||
      (
        !cloudinaryUploadPreset &&
        !(cloudinaryApiKey && cloudinaryApiSecret)
      )
    )
  ) return null

  const artworkAsset = resolveArtworkAssetForNowPlaying(payload.artworkUrl)
  if (!artworkAsset) return null

  const prepared = prepareDiscordArtworkUpload(artworkAsset)
  if (!prepared) return null

  const cached = getCachedDiscordArtworkUpload(provider, prepared.contentHash)
  if (cached) return cached

  const taskKey = `${provider}:${prepared.contentHash}`
  const existingTask = discordArtworkUploadTasks.get(taskKey)
  if (existingTask) return await existingTask

  const task = uploadDiscordArtwork(
    {
      provider,
      cloudinaryCloudName,
      cloudinaryUploadPreset,
      cloudinaryApiKey,
      cloudinaryApiSecret,
    },
    prepared,
  ).then((externalUrl) => {
    const normalized = normalizeDiscordExternalImageUrl(externalUrl)
    if (!normalized) return null
    storeDiscordArtworkUpload(provider, prepared.contentHash, normalized)
    return normalized
  }).catch((error) => {
    console.warn('[Puros][Discord] Artwork upload failed:', error)
    return null
  }).finally(() => {
    discordArtworkUploadTasks.delete(taskKey)
  })

  discordArtworkUploadTasks.set(taskKey, task)
  return await task
}

function getDiscordProviderLabel(provider: string | null | undefined) {
  const providerId = String(provider ?? '').trim().toLowerCase()
  if (!providerId || providerId === 'local') return null
  return listProviderDescriptors()
    .find(({ manifest }) => manifest.id === providerId)
    ?.manifest.displayName ?? null
}

type ProviderTrackIdentity = {
  sourceType?: string | null
  sourceId?: string | null
  provider?: string | null
  catalogTrackId?: string | null
}

function getProviderTrackIdentity(payload: ProviderTrackIdentity) {
  const ref = parseSourceEntityId(payload.catalogTrackId ?? '')
  const trackRef = ref?.entityType === 'track' ? ref : null
  const provider = String(payload.provider || payload.sourceType || trackRef?.providerId || '').trim().toLowerCase()
  const sourceId = String(payload.sourceId || (trackRef?.providerId === provider ? trackRef.sourceId : '')).trim()
  return { provider, sourceId }
}

function resolveDiscordProviderTrackUrl(payload: ProviderTrackIdentity): {
  providerLabel: string | null; providerTrackUrl: string | null
} {
  const { provider: preferredProvider, sourceId: preferredSourceId } = getProviderTrackIdentity(payload)

  const resolveByCatalogTrackId = () => {
    if (!payload.catalogTrackId) return null
    return getDb().prepare(`
      SELECT provider, provider_url
      FROM catalog_track_sources
      WHERE catalog_track_id = ?
        AND (? = '' OR provider = ?)
        AND (? = '' OR source_id = ?)
      ORDER BY
        CASE
          WHEN provider = ? THEN 0
          ELSE 1
        END,
        available DESC,
        CASE WHEN provider_url IS NOT NULL AND trim(provider_url) <> '' THEN 0 ELSE 1 END
      LIMIT 1
    `).get(payload.catalogTrackId, preferredProvider, preferredProvider, preferredSourceId, preferredSourceId, preferredProvider) as {
      provider: string | null
      provider_url: string | null
    } | undefined
  }

  const resolveBySourceId = () => {
    if (!preferredSourceId) return null
    return getDb().prepare(`
      SELECT provider, provider_url
      FROM catalog_track_sources
      WHERE source_id = ?
        AND (? = '' OR provider = ?)
      ORDER BY
        CASE
          WHEN provider = ? THEN 0
          ELSE 1
        END,
        available DESC,
        CASE WHEN provider_url IS NOT NULL AND trim(provider_url) <> '' THEN 0 ELSE 1 END
      LIMIT 1
    `).get(preferredSourceId, preferredProvider, preferredProvider, preferredProvider) as {
      provider: string | null
      provider_url: string | null
    } | undefined
  }

  const resolved = resolveByCatalogTrackId() ?? resolveBySourceId()
  const resolvedProvider = String(resolved?.provider ?? preferredProvider).trim().toLowerCase() || null
  const resolvedProviderLabel = getDiscordProviderLabel(resolvedProvider)
  const directUrl = normalizeDiscordExternalImageUrl(resolved?.provider_url ?? null)

  if (directUrl && resolvedProviderLabel) {
    return {
      providerLabel: resolvedProviderLabel,
      providerTrackUrl: directUrl,
    }
  }

  return {
    providerLabel: null,
    providerTrackUrl: null,
  }
}

async function resolveMissingDiscordProviderTrackUrl(payload: ProviderTrackIdentity) {
  const { provider, sourceId } = getProviderTrackIdentity(payload)
  const descriptor = listProviderDescriptors().find(({ manifest }) => manifest.id === provider)
  if (!sourceId || !descriptor) return null

  if (!getDiscordRichPresenceEnabled(getDb())) return null
  const taskKey = JSON.stringify([provider, sourceId])
  const existingTask = discordProviderLinkTasks.get(taskKey)
  if (existingTask) return await existingTask

  const task = (async () => {
    // Older provider packages may return stored catalog data without links;
    // their richer track metadata can supply the official URL on first play.
    const lookups = [
      { capability: 'catalog.entities', method: 'getTrack' },
      { capability: 'metadata.credits', method: 'getTrackDetails' },
    ] as const
    for (const { capability, method } of lookups) {
      if (!descriptor.manifest.capabilities.includes(capability)) continue
      try {
        const result = await invokeProvider(provider, capability, method, [sourceId])
        if (!result.ok || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) continue
        if (result.value.sourceId !== sourceId || typeof result.value.providerUrl !== 'string') continue
        const providerTrackUrl = normalizeDiscordExternalImageUrl(result.value.providerUrl)
        if (!providerTrackUrl) continue

        getDb().prepare(`
          UPDATE catalog_track_sources SET provider_url = ?
          WHERE provider = ? AND source_id = ?
        `).run(providerTrackUrl, provider, sourceId)
        return { providerLabel: descriptor.manifest.displayName, providerTrackUrl }
      } catch {
        // Optional metadata must not block playback or other providers' links.
      }
    }
    return null
  })().finally(() => {
    discordProviderLinkTasks.delete(taskKey)
  })
  discordProviderLinkTasks.set(taskKey, task)
  return await task
}

export function syncDiscordPresenceSettingsFromDb() {
  const currentDb = getDb()
  const smallImageKey = process.env.DISCORD_SMALL_IMAGE_KEY?.trim() || 'puros'
  discordPresence.configure({
    enabled: getDiscordRichPresenceEnabled(currentDb),
    smallImageKey,
    smallImageUrl: process.env.DISCORD_SMALL_IMAGE_URL?.trim(),
    fallbackLargeImageKey: process.env.DISCORD_LARGE_IMAGE_KEY?.trim(),
    fallbackLargeImageUrl: process.env.DISCORD_LARGE_IMAGE_URL?.trim(),
  })
}

export type NowPlayingPayload = {
  title: string
  artist: string
  album: string
  duration: number
  position: number
  artworkUrl?: string | null
  discordArtworkUrl?: string | null
  sourceType?: string | null
  sourceId?: string | null
  provider?: string | null
  catalogTrackId?: string | null
  providerLabel?: string | null
  providerTrackUrl?: string | null
}

export type PlaybackStatePayload = {
  state: 'playing' | 'paused' | 'stopped'
  position: number
  duration: number
}

export async function setNowPlaying(payload: NowPlayingPayload) {
  setVisualizerTrack(payload)
  try {
    const artwork = resolveArtworkAssetForNowPlaying(payload.artworkUrl)
    getAudioEngine().setNowPlayingInfo({
      title: payload.title,
      artist: payload.artist,
      album: payload.album,
      duration: payload.duration,
      position: payload.position,
      artworkMimeType: artwork?.mimeType,
      artworkData: artwork?.data,
    })
  } catch (err) {
    console.warn('[Puros] Failed to update native now playing info:', err)
  }
  const revision = ++discordNowPlayingRevision
  const providerLink = resolveDiscordProviderTrackUrl(payload)
  const directArtworkUrl = resolveDirectDiscordArtworkUrl(payload)
  discordPresence.setNowPlaying({
    ...payload,
    artworkUrl: directArtworkUrl,
    providerLabel: providerLink.providerLabel,
    providerTrackUrl: providerLink.providerTrackUrl,
  })

  const [resolvedProviderLink, uploadedArtworkUrl] = await Promise.all([
    providerLink.providerTrackUrl ? Promise.resolve(null) : resolveMissingDiscordProviderTrackUrl(payload),
    directArtworkUrl ? Promise.resolve(null) : resolveUploadedDiscordArtworkUrl(payload),
  ])
  if (revision !== discordNowPlayingRevision || (!resolvedProviderLink && !uploadedArtworkUrl)) return

  discordPresence.setNowPlaying({
    ...payload,
    artworkUrl: directArtworkUrl ?? uploadedArtworkUrl,
    providerLabel: resolvedProviderLink?.providerLabel ?? providerLink.providerLabel,
    providerTrackUrl: resolvedProviderLink?.providerTrackUrl ?? providerLink.providerTrackUrl,
  })
}

export function updateNowPlayingPlaybackState(payload: PlaybackStatePayload) {
  setVisualizerPlaying(payload.state === 'playing')
  setPlaybackState(payload.state)
  try {
    getAudioEngine().updateNowPlayingPlaybackState(
      payload.state,
      payload.position,
      payload.duration,
    )
  } catch (err) {
    console.warn('[Puros] Failed to update native playback state:', err)
  }
  discordPresence.updatePlaybackState(payload)
}

export function clearNowPlaying() {
  clearVisualizerTrack()
  discordNowPlayingRevision += 1
  setPlaybackState('stopped')
  try {
    getAudioEngine().clearNowPlayingInfo()
  } catch (err) {
    console.warn('[Puros] Failed to clear native now playing info:', err)
  }
  discordPresence.clearNowPlaying()
}

export function shutdownDiscordPresence() {
  discordPresence.shutdown()
}
