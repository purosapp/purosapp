import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { artCacheDir } from './artwork/cache'
import { getLocalDsdCacheDir } from './audio/localPlayback'
import { getDb } from './db'
import { resolveAllowedExistingFile } from './security/pathPolicy'
import { getStreamingAudioCacheRoot } from './streamingCache'

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'media',
    privileges: { stream: true, supportFetchAPI: true, secure: true },
  }, {
    scheme: 'artwork',
    privileges: { supportFetchAPI: true, standard: true, secure: true },
  }])
}

function getWatchFolderRoots(): string[] {
  return (getDb().prepare(`SELECT path FROM watch_folders`).all() as Array<{ path: string }>)
    .map(({ path: folderPath }) => folderPath)
}

function getAllowedMediaRoots(): string[] {
  return [
    ...getWatchFolderRoots(),
    getStreamingAudioCacheRoot(),
    getLocalDsdCacheDir(),
  ]
}

function getAllowedArtworkRoots(): string[] {
  return [...getWatchFolderRoots(), artCacheDir()]
}

function forbiddenPathResponse(): Response {
  return new Response('File is outside an allowed media root', { status: 403 })
}

export function registerProtocolHandlers(): void {
  protocol.handle('media', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'file') return new Response('Unsupported media request', { status: 404 })
      const requestedPath = decodeURIComponent(url.pathname)
      const filePath = resolveAllowedExistingFile(requestedPath, getAllowedMediaRoots())
      return filePath ? net.fetch(pathToFileURL(filePath).toString()) : forbiddenPathResponse()
    } catch {
      return new Response('Invalid media request', { status: 400 })
    }
  })

  protocol.handle('artwork', async (request) => {
    const url = new URL(request.url)

    if (url.hostname === 'cache') {
      const artworkId = decodeURIComponent(url.pathname.slice(1))
      const row = getDb().prepare(
        `SELECT mime_type, data FROM artwork_cache WHERE id = ?`
      ).get(artworkId) as { mime_type: string; data: Buffer } | undefined

      if (!row) return new Response('Artwork not found', { status: 404 })

      return new Response(new Uint8Array(row.data), {
        headers: {
          'Content-Type': row.mime_type,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }

    if (url.hostname === 'file') {
      const filePath = url.searchParams.get('path')
      if (!filePath) return new Response('Missing artwork path', { status: 400 })
      const allowedPath = resolveAllowedExistingFile(filePath, getAllowedArtworkRoots())
      return allowedPath
        ? net.fetch(pathToFileURL(allowedPath).toString())
        : forbiddenPathResponse()
    }

    return new Response('Unsupported artwork request', { status: 404 })
  })
}
