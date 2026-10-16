import path from 'node:path'

export function mimeTypeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    default:
      return 'image/jpeg'
  }
}

export function detectImageMime(data: Buffer, fallback = 'image/jpeg'): string {
  if (data.length >= 8 &&
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
      data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length >= 6) {
    const sig = data.subarray(0, 6).toString('ascii')
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12 &&
      data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return 'image/bmp'
  }
  return fallback
}

export function normalizeArtworkMime(raw: string | null | undefined, filePath?: string): string {
  const mime = raw?.toLowerCase().trim()
  if (!mime) return filePath ? mimeTypeFromPath(filePath) : 'image/jpeg'
  if (mime === 'jpg' || mime === 'jpeg' || mime === 'image/jpg') return 'image/jpeg'
  if (mime === 'png') return 'image/png'
  if (mime === 'webp') return 'image/webp'
  if (mime === 'gif') return 'image/gif'
  if (mime === 'bmp') return 'image/bmp'
  if (mime.startsWith('image/')) return mime
  return filePath ? mimeTypeFromPath(filePath) : 'image/jpeg'
}

export function extensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'image/bmp':
      return '.bmp'
    default:
      return '.jpg'
  }
}

export function decodeDataUri(dataUri: string): { mimeType: string; data: Buffer } | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(dataUri)
  if (!match) return null
  const mimeType = normalizeArtworkMime(match[1])
  try {
    return {
      mimeType,
      data: Buffer.from(match[2], 'base64'),
    }
  } catch {
    return null
  }
}
