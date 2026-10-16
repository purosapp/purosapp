import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import manifestJson from '../provider.manifest.json'
import {
  API_VERSION,
  ProviderApiError,
  providerError,
  type ProviderAlbumV1,
  type ProviderArtistV1,
  type ProviderHostV1,
  type ProviderManifestV1,
  type ProviderPluginV1,
  type ProviderRuntimeV1,
  type ProviderTrackV1,
} from 'puros-provider-sdk'

export const manifest = manifestJson as ProviderManifestV1

const artist: ProviderArtistV1 = {
  sourceId: 'example-artist',
  name: 'Example Artist',
  genres: ['Fixture'],
  albumCount: 1,
  trackCount: 1,
  inLibrary: true,
}

const album: ProviderAlbumV1 = {
  sourceId: 'example-album',
  title: 'Contract Tones',
  year: 2026,
  releaseType: 'album',
  primaryArtistSourceId: artist.sourceId,
  primaryArtistName: artist.name,
  totalTracks: 1,
  totalDiscs: 1,
  inLibrary: true,
}

const track: ProviderTrackV1 = {
  sourceId: 'example-track',
  title: 'A440 Contract Tone',
  durationMs: 500,
  trackNumber: 1,
  discNumber: 1,
  albumSourceId: album.sourceId,
  albumTitle: album.title,
  primaryArtistSourceId: artist.sourceId,
  primaryArtistName: artist.name,
  inLibrary: true,
  format: {
    format: 'WAV',
    sampleRate: 48_000,
    bitDepth: 16,
    bitrate: 768_000,
    channels: 1,
    isLossless: true,
    isHiRes: false,
    isMqa: false,
    isDsd: false,
  },
}

function createRuntime(host: ProviderHostV1): ProviderRuntimeV1 {
  let authenticated = true
  let active = true
  const ensureActive = () => {
    if (!active) throw new Error('Example provider has been deactivated')
  }
  const resolveFixture = async () => {
    ensureActive()
    const cacheRoot = await host.paths.getCacheRoot()
    const resourceRoot = await host.paths.getResourceRoot()
    const destination = path.join(cacheRoot, 'example.wav')
    if (!fs.existsSync(destination)) {
      const source = path.join(resourceRoot, 'assets', 'example.wav')
      fs.copyFileSync(source, destination)
    }
    return {
      path: destination,
      lifecycle: 'complete' as const,
      format: track.format!,
    }
  }

  return {
    capabilities: {
      auth: {
        async getStatus() { ensureActive(); return { authenticated, accountLabel: authenticated ? 'Fixture Account' : null } },
        async login() { ensureActive(); authenticated = true; return { status: { authenticated, accountLabel: 'Fixture Account' } } },
        async logout() { ensureActive(); authenticated = false },
      },
      'catalog.search': {
        async search(request) {
          ensureActive()
          if (request.query === '__puros_fixture_crash__') process.exit(83)
          if (request.query === '__puros_fixture_flood__') {
            for (let index = 0; index < 31; index += 1) {
              await host.events.emit({ type: 'warning', code: 'fixture-flood', message: String(index) })
            }
          }
          const matches = request.query.trim() === '' || 'a440 contract tone example artist'.includes(request.query.toLowerCase())
          return {
            artists: matches ? [artist] : [],
            albums: matches ? [album] : [],
            tracks: matches ? [track] : [],
            playlists: matches ? [{ sourceId: 'example-playlist', title: 'Fixture Playlist', trackCount: 1 }] : [],
            nextCursor: null,
          }
        },
      },
      'catalog.entities': {
        async getArtist(sourceId) { ensureActive(); if (sourceId !== artist.sourceId) throw new Error('Artist not found'); return artist },
        async getArtistBundle(sourceId) {
          ensureActive(); if (sourceId !== artist.sourceId) throw new Error('Artist not found')
          return { artist, releases: [album], playlists: [], topTracks: [track], relatedArtists: [] }
        },
        async getAlbum(sourceId) { ensureActive(); if (sourceId !== album.sourceId) throw new Error('Album not found'); return album },
        async getAlbumBundle(sourceId) {
          ensureActive(); if (sourceId !== album.sourceId) throw new Error('Album not found')
          return { album, tracks: [track] }
        },
        async getTrack(sourceId) { ensureActive(); if (sourceId !== track.sourceId) throw new ProviderApiError(providerError('NOT_FOUND', 'Track not found', { retryable: false })); return track },
      },
      'catalog.home': {
        async getShelves() {
          ensureActive()
          return { items: [{ id: 'fixture', title: 'Fixture Picks', kind: 'tracks', items: [track] }], nextCursor: null }
        },
        async getCollection() { ensureActive(); return { title: 'Fixture Collection', tracks: [track] } },
      },
      'library.sync': {
        async enumerate() {
          ensureActive()
          return {
            records: [
              { type: 'artist' as const, value: artist },
              { type: 'album' as const, value: album },
              { type: 'track' as const, value: track },
            ],
            nextCursor: null,
            complete: true,
          }
        },
      },
      playlists: {
        async list() { ensureActive(); return { items: [{ sourceId: 'example-playlist', title: 'Fixture Playlist', trackCount: 1 }], nextCursor: null } },
        async get() { ensureActive(); return { sourceId: 'example-playlist', title: 'Fixture Playlist', trackCount: 1 } },
        async getTracks() { ensureActive(); return { items: [track], nextCursor: null } },
      },
      'playback.resolve': { async resolve() { return resolveFixture() } },
      'playback.prefetch': { async prefetch() { return resolveFixture() } },
      'quality.tiers': {
        async list() { ensureActive(); return [{ id: 'fixture-lossless', label: 'Fixture Lossless', rank: 1, lossless: true }] },
        async getSelected() { ensureActive(); return 'fixture-lossless' },
        async select({ tierId }) { ensureActive(); if (tierId !== 'fixture-lossless') throw new Error('Unknown fixture quality') },
      },
      'metadata.artwork': {
        async getArtwork() { ensureActive(); return { url: pathToFileURL(path.join(await host.paths.getResourceRoot(), 'assets', 'icon.svg')).toString(), mimeType: 'image/svg+xml' } },
      },
      'metadata.bio': {
        async getBio() { ensureActive(); return { text: 'Deterministic metadata from the offline example provider.', genres: ['Fixture'] } },
      },
      'metadata.credits': {
        async getCredits() { ensureActive(); return [{ name: artist.name, role: 'primary', artistSourceId: artist.sourceId, position: 0 }] },
      },
    },
    async getStatus() {
      return { state: active ? 'ready' : 'inactive', authenticated, updatedAt: Date.now(), values: { fixture: 'offline' } }
    },
    async deactivate() { active = false },
  }
}

const plugin: ProviderPluginV1 = {
  apiVersion: API_VERSION,
  manifest,
  async activate(host) {
    await host.logger.info('Example provider activated')
    return createRuntime(host)
  },
}

export default plugin
