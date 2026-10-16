import { nativeImage } from 'electron'
import { createHash } from 'node:crypto'

export type DiscordArtworkUploadProvider = 'none' | 'cloudinary'

export interface DiscordArtworkUploadConfig {
  provider: DiscordArtworkUploadProvider
  cloudinaryCloudName: string
  cloudinaryUploadPreset: string
  cloudinaryApiKey: string
  cloudinaryApiSecret: string
}

export interface DiscordArtworkAsset {
  mimeType: string
  data: Buffer
}

export interface PreparedDiscordArtworkUpload {
  contentHash: string
  mimeType: string
  data: Buffer
  fileName: string
}

const MAX_UPLOAD_DIMENSION = 1024
const MAX_UPLOAD_BYTES = 9 * 1024 * 1024

export function normalizeDiscordArtworkUploadProvider(value: string | null | undefined): DiscordArtworkUploadProvider {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === 'cloudinary' ? 'cloudinary' : 'none'
}

export function prepareDiscordArtworkUpload(asset: DiscordArtworkAsset): PreparedDiscordArtworkUpload | null {
  if (!asset.data.length) return null

  let data = asset.data
  let mimeType = asset.mimeType
  let fileName = 'puros-discord-cover'

  try {
    const image = nativeImage.createFromBuffer(asset.data)
    const size = image.getSize()
    if (size.width > 0 && size.height > 0) {
      const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(size.width, size.height))
      const target = scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'best',
          })
        : image

      data = target.toJPEG(90)
      mimeType = 'image/jpeg'
      fileName = 'puros-discord-cover.jpg'
    }
  } catch {
    // Fall back to the original bytes when Electron cannot decode the image.
  }

  if (!data.length || data.length > MAX_UPLOAD_BYTES) return null

  return {
    contentHash: createHash('sha256').update(data).digest('hex'),
    mimeType,
    data,
    fileName,
  }
}

export async function uploadDiscordArtwork(
  config: DiscordArtworkUploadConfig,
  asset: PreparedDiscordArtworkUpload,
): Promise<string | null> {
  if (config.provider !== 'cloudinary') return null

  const cloudName = config.cloudinaryCloudName.trim()
  const uploadPreset = config.cloudinaryUploadPreset.trim()
  const apiKey = config.cloudinaryApiKey.trim()
  const apiSecret = config.cloudinaryApiSecret.trim()
  const useBasicAuth = apiKey.length > 0 && apiSecret.length > 0

  if (!cloudName) return null
  if (!useBasicAuth && !uploadPreset) return null

  const body = new URLSearchParams()
  body.set('file', `data:${asset.mimeType};base64,${asset.data.toString('base64')}`)
  if (uploadPreset) {
    body.set('upload_preset', uploadPreset)
  }
  body.set('tags', 'puros,discord-rich-presence')
  body.set('context', 'alt=Puros album cover|caption=Puros album cover')
  body.set('display_name', 'Puros album cover')

  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, {
    method: 'POST',
    headers: useBasicAuth ? {
      'Authorization': `Basic ${Buffer.from(`${apiKey}:${apiSecret}`, 'utf8').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    } : {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  })

  const payload = await response.json().catch(() => null) as
    | { secure_url?: unknown; error?: { message?: unknown } }
    | null

  const link = typeof payload?.secure_url === 'string' ? payload.secure_url.trim() : ''
  if (!response.ok || !link.startsWith('http')) {
    const message = typeof payload?.error?.message === 'string' ? payload.error.message.trim() : ''
    throw new Error(message ? `Cloudinary upload failed: ${message}` : 'Cloudinary upload failed')
  }

  return link
}
