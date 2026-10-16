import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

// Intentionally retained for manual use. The Electron application does not import
// or start this standalone artwork server during normal runtime.
export interface DiscordArtworkAsset {
  mimeType: string
  data: Buffer
}

type ArtworkResolver = (source: string) => Promise<DiscordArtworkAsset | null>

type CacheEntry = {
  source: string
  lastAccessAt: number
  asset?: DiscordArtworkAsset
  cachedAt?: number
}

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_LIMIT = 128

export class DiscordArtworkServer {
  private server: http.Server | null = null
  private port: number | null = null
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<DiscordArtworkAsset | null>>()
  private readonly badgeData: Buffer

  constructor(
    appRoot: string,
    private readonly resolveArtwork: ArtworkResolver,
  ) {
    this.badgeData = fs.readFileSync(path.join(appRoot, 'src', 'assets', 'puros.png'))
  }

  async start() {
    if (this.server && this.port) return
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to bind Discord artwork server'))
          return
        }
        this.server = server
        this.port = address.port
        resolve()
      })
    })
  }

  async stop() {
    const current = this.server
    this.server = null
    this.port = null
    this.entries.clear()
    this.inflight.clear()
    if (!current) return
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
    })
  }

  getBadgeUrl() {
    if (!this.port) return null
    return `http://127.0.0.1:${this.port}/discord/badge.png`
  }

  registerArtwork(source: string | null | undefined) {
    const normalized = String(source ?? '').trim()
    if (!normalized || !this.port) return null

    const token = createHash('sha256').update(normalized).digest('hex')
    const existing = this.entries.get(token)
    if (existing) {
      existing.lastAccessAt = Date.now()
    } else {
      this.entries.set(token, {
        source: normalized,
        lastAccessAt: Date.now(),
      })
      this.prune()
    }

    return `http://127.0.0.1:${this.port}/discord/artwork/${token}`
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (requestUrl.pathname === '/discord/badge.png') {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      res.end(this.badgeData)
      return
    }

    const artworkMatch = /^\/discord\/artwork\/([a-f0-9]{64})$/.exec(requestUrl.pathname)
    if (!artworkMatch) {
      res.writeHead(404).end('Not found')
      return
    }

    const token = artworkMatch[1]
    const entry = this.entries.get(token)
    if (!entry) {
      res.writeHead(404).end('Unknown artwork')
      return
    }

    entry.lastAccessAt = Date.now()
    const asset = await this.getOrResolveAsset(token, entry)
    if (!asset) {
      res.writeHead(404).end('Artwork unavailable')
      return
    }

    res.writeHead(200, {
      'Content-Type': asset.mimeType,
      'Cache-Control': 'public, max-age=3600',
    })
    res.end(asset.data)
  }

  private async getOrResolveAsset(token: string, entry: CacheEntry) {
    const now = Date.now()
    if (entry.asset && entry.cachedAt && now - entry.cachedAt < CACHE_TTL_MS) {
      return entry.asset
    }

    const existing = this.inflight.get(token)
    if (existing) return existing

    const promise = this.resolveArtwork(entry.source)
      .then((asset) => {
        if (asset) {
          entry.asset = asset
          entry.cachedAt = Date.now()
        }
        return asset
      })
      .finally(() => {
        this.inflight.delete(token)
      })

    this.inflight.set(token, promise)
    return promise
  }

  private prune() {
    const entries = [...this.entries.entries()]
      .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
    while (entries.length > CACHE_LIMIT) {
      const next = entries.shift()
      if (!next) break
      this.entries.delete(next[0])
    }
  }
}
