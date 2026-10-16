import {
  CatalogBrowseService,
  CatalogIngestService,
  CatalogRegistry,
  CatalogSearchService,
  LocalCatalogProvider,
  type CatalogBrowseScope,
  type CatalogEntityType,
  type CatalogProviderName,
} from "../../../src/services/catalog"
import type { CatalogProvider } from '../../../src/services/catalog/CatalogProvider'
import { getDb } from "../db"
import { rebuildSearchIndex } from "../library/scanner"
import { clearMetadataCacheOnly } from "../metadata/artwork"
import { getSettingValue } from "../settings/store"
import { emitLibraryCatalogChanged } from '../rendererBridge'

type CatalogServicesDeps = {
  getCatalogProviders: () => CatalogProvider[]
  getProviderPriorities: () => Array<{ id: string; defaultPriority: number }>
  isProviderAvailable: (providerId: string) => boolean
  cacheRemoteArtwork: typeof import("../artwork/cache").cacheRemoteArtwork
  syncHostManagedLibraries: () => Promise<number>
  onCatalogChanged: () => void
}

let catalogServicesDeps: CatalogServicesDeps | null = null
let catalogRegistry: CatalogRegistry | null = null
let catalogIngestService: CatalogIngestService | null = null
let catalogBrowseService: CatalogBrowseService | null = null
let catalogSearchService: CatalogSearchService | null = null
let catalogReadyPromise: Promise<void> | null = null

export function initCatalogServices(deps: CatalogServicesDeps) {
  catalogServicesDeps = deps
}

function getCatalogServicesDeps(): CatalogServicesDeps {
  if (!catalogServicesDeps) throw new Error("Catalog services are not configured")
  return catalogServicesDeps
}

export function resetCatalogServices() {
  catalogRegistry = null
  catalogIngestService = null
  catalogBrowseService = null
  catalogSearchService = null
  catalogReadyPromise = null
}

export function rebuildUnifiedSearchIndex() {
  rebuildSearchIndex(getDb())
}

export function getCatalogRegistry(): CatalogRegistry {
  if (!catalogRegistry) {
    catalogRegistry = new CatalogRegistry()
    catalogRegistry.register(new LocalCatalogProvider(getDb()))
    for (const provider of getCatalogServicesDeps().getCatalogProviders()) {
      catalogRegistry.register(provider)
    }
  }
  return catalogRegistry
}

export function getCatalogIngestService(): CatalogIngestService {
  if (!catalogIngestService) {
    catalogIngestService = new CatalogIngestService({
      dbContext: {
        db: getDb(),
        rebuildSearchIndex: rebuildUnifiedSearchIndex,
      },
      artworkCache: {
        cacheRemoteArtwork: getCatalogServicesDeps().cacheRemoteArtwork,
      },
      getLocalCreditGuidanceMode: () => 'local_only',
      isProviderAvailable: (providerId) => (
        providerId === 'local' || getCatalogServicesDeps().isProviderAvailable(providerId)
      ),
    })
  }
  return catalogIngestService
}

export function getCatalogBrowseService(): CatalogBrowseService {
  if (!catalogBrowseService) {
    const ingest = getCatalogIngestService()
    catalogBrowseService = new CatalogBrowseService({
      db: getDb(),
      registry: getCatalogRegistry(),
      ingest,
      onBundleRefreshed: () => {
        getCatalogServicesDeps().onCatalogChanged()
      },
    })
  }
  return catalogBrowseService
}

export function getCatalogSearchService(): CatalogSearchService {
  if (!catalogSearchService) {
    catalogSearchService = new CatalogSearchService({
      db: getDb(),
      registry: getCatalogRegistry(),
      ingest: getCatalogIngestService(),
      browse: getCatalogBrowseService(),
      getShowUnavailableSources: () => getSettingValue(getDb(), 'showUnavailableSources') === 'true',
    })
  }
  return catalogSearchService
}

export async function rebuildCatalogGraphFromSources() {
  const promise = getCatalogIngestService().rebuildFromLibrarySources()
  catalogReadyPromise = promise
  try {
    await promise
    getDb().prepare(`DELETE FROM settings WHERE key = 'catalog:needsSourceRebuild'`).run()
  } finally {
    if (catalogReadyPromise === promise) {
      catalogReadyPromise = Promise.resolve()
    }
  }
}

function isCatalogPopulated(): boolean {
  return !!getDb().prepare(`SELECT 1 FROM catalog_tracks LIMIT 1`).get()
}

export async function ensureCatalogReady() {
  if (catalogReadyPromise) return catalogReadyPromise

  // The catalog_* tables persist across sessions and the browse service reads
  // them directly, so an already-populated catalog is immediately usable. The
  // full rebuild is a single large synchronous SQLite transaction that blocks
  // the main process (and starves the renderer → blank screen) for a long time
  // on big libraries, so only run it when the catalog is actually empty. Every
  // path that changes library data calls rebuildCatalogGraphFromSources()
  // directly, so this lazy guard never serves stale data after a real change.
  if (isCatalogPopulated() && getSettingValue(getDb(), 'catalog:needsSourceRebuild') !== 'true') {
    catalogReadyPromise = Promise.resolve()
    return catalogReadyPromise
  }

  catalogReadyPromise = rebuildCatalogGraphFromSources().catch((error) => {
    catalogReadyPromise = null
    throw error
  })
  return catalogReadyPromise
}

export async function browseCatalog(providerId: string, scope?: CatalogBrowseScope, limit?: number) {
  await ensureCatalogReady()
  return getCatalogSearchService().browse(providerId, scope ?? 'all', limit ?? 24)
}

export async function browseCatalogArtists(providerId: string, scope?: CatalogBrowseScope, limit?: number) {
  await ensureCatalogReady()
  return getCatalogSearchService().browseArtists(providerId, scope ?? 'library', limit ?? 2000)
}

export async function browseCatalogAlbums(providerId: string, scope?: CatalogBrowseScope, limit?: number) {
  await ensureCatalogReady()
  return getCatalogSearchService().browseAlbums(providerId, scope ?? 'library', limit ?? 2000)
}

export async function browseCatalogTracks(providerId: string, scope?: CatalogBrowseScope, limit?: number) {
  await ensureCatalogReady()
  return getCatalogSearchService().browseTracks(providerId, scope ?? 'library', limit ?? 2000)
}

export async function searchCatalog(providerId: string, query: string, limit?: number, scope?: CatalogBrowseScope) {
  await ensureCatalogReady()
  const results = await getCatalogSearchService().search(providerId, query, limit ?? 12, scope ?? 'all')
  return results
}

export async function searchLocalCatalog(providerId: string, query: string, limit?: number, scope?: CatalogBrowseScope) {
  await ensureCatalogReady()
  return getCatalogSearchService().searchLocalOnly(providerId, query, limit ?? 12, scope ?? 'all')
}

export async function searchRemoteCatalog(providerId: string, query: string, limit?: number, scope?: CatalogBrowseScope) {
  await ensureCatalogReady()
  const results = await getCatalogSearchService().searchRemote(providerId, query, limit ?? 12, scope ?? 'all')
  return results
}

export async function getCatalogArtistCounts(catalogArtistId: string) {
  await ensureCatalogReady()
  return getCatalogBrowseService().getArtistCounts(catalogArtistId)
}

export async function getCatalogArtist(catalogArtistId: string) {
  await ensureCatalogReady()
  const artist = await getCatalogBrowseService().getArtistPage(catalogArtistId)
  return artist
}

export async function getCatalogArtistPreview(
  catalogArtistId: string,
  _onChanged: () => void,
) {
  await ensureCatalogReady()
  const result = getCatalogBrowseService().getArtistPreviewPage(catalogArtistId)
  return result
}

export async function getCatalogTrack(catalogTrackId: string) {
  await ensureCatalogReady()
  const track = getCatalogBrowseService().getTrackSummary(catalogTrackId)
  return track
}

export async function getCatalogArtistReleases(catalogArtistId: string) {
  await ensureCatalogReady()
  return getCatalogBrowseService().getArtistReleases(catalogArtistId)
}

export async function getCatalogArtistTopTracks(catalogArtistId: string) {
  await ensureCatalogReady()
  const tracks = await getCatalogBrowseService().getArtistTopTracks(catalogArtistId)
  return tracks
}

export async function getCatalogArtistRelated(catalogArtistId: string) {
  await ensureCatalogReady()
  return getCatalogBrowseService().getArtistRelated(catalogArtistId)
}

export async function getCatalogArtistPlaylists(catalogArtistId: string) {
  await ensureCatalogReady()
  return getCatalogBrowseService().getArtistPlaylists(catalogArtistId)
}

export async function getCatalogArtistRadioTracks(options: {
  catalogArtistId: string | null
  artistName: string | null
  excludeTrackIds: string[]
  providerId?: string
}) {
  await ensureCatalogReady()
  return getCatalogBrowseService().getArtistRadioTracks(options)
}

export async function getCatalogAlbum(catalogAlbumId: string) {
  await ensureCatalogReady()
  const album = await getCatalogBrowseService().getAlbumPage(catalogAlbumId)
  return album
}

export async function getCatalogAlbumPreview(
  catalogAlbumId: string,
  _onChanged: () => void,
) {
  await ensureCatalogReady()
  const result = getCatalogBrowseService().getAlbumPreviewPage(catalogAlbumId)
  return result
}

export async function getCatalogAlbumTracks(catalogAlbumId: string) {
  await ensureCatalogReady()
  const tracks = await getCatalogBrowseService().getAlbumTracks(catalogAlbumId)
  return tracks
}

export async function resolveCatalogPlayback(
  catalogTrackId: string,
  preferredProvider?: CatalogProviderName | null,
  preferredSourceId?: string | null,
  options?: { allowDiscovery?: boolean },
) {
  await ensureCatalogReady()
  return getCatalogBrowseService().resolvePlayback(
    catalogTrackId,
    preferredProvider ?? null,
    preferredSourceId ?? null,
    options,
  )
}

export async function addCatalogEntityToLibrary(
  entityType: CatalogEntityType,
  catalogId: string,
  preferredProvider?: CatalogProviderName | null,
) {
  await ensureCatalogReady()
  const added = await getCatalogBrowseService().addToLibrary(entityType, catalogId, preferredProvider ?? null)
  if (added) {
    try {
      const synced = await getCatalogServicesDeps().syncHostManagedLibraries()
      if (synced === 0) {
        await rebuildCatalogGraphFromSources()
      }
    } catch {
      await rebuildCatalogGraphFromSources()
    }
    emitLibraryCatalogChanged()
  }
  return { success: added }
}

async function getCatalogEntityPage(entityType: CatalogEntityType, catalogId: string) {
  if (entityType === 'artist') return getCatalogBrowseService().getArtistPage(catalogId)
  if (entityType === 'album') return getCatalogBrowseService().getAlbumPage(catalogId)
  return null
}

export async function refreshCatalogEntity(
  entityType: CatalogEntityType,
  catalogId: string,
  onChanged: () => void,
) {
  await ensureCatalogReady()
  await getCatalogBrowseService().refreshEntity(entityType, catalogId)
  onChanged()
  return getCatalogEntityPage(entityType, catalogId)
}

export async function clearCatalogMetadataCache() {
  await ensureCatalogReady()
  await clearMetadataCacheOnly(getDb())
  await rebuildCatalogGraphFromSources()
  emitLibraryCatalogChanged()
  return { success: true }
}
