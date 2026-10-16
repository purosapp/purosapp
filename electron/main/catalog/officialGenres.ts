import { invokeProvider } from '../providers'
import { normalizeGenreTags } from '../shared/normalize'

/** `null` when the provider has no genre index; genre enrichment is opt-in through `getArtistGenres`. */
export async function fetchOfficialArtistGenreMap(providerId: string, sourceIds: string[]): Promise<Map<string, string[]> | null> {
  const artistIds = [...new Set(sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean))]
  if (artistIds.length === 0) return new Map()

  const response = await invokeProvider(providerId, 'catalog.entities', 'getArtistGenres', [artistIds])
  if (!response.ok) {
    if (response.error.code === 'NOT_SUPPORTED') return null
    console.warn(`[Puros][${providerId}] Official genre index scan skipped:`, response.error.message)
    return new Map()
  }
  const raw = response.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map()
  const genreMap = new Map<string, string[]>()
  for (const [sourceId, genres] of Object.entries(raw)) {
    const normalizedGenres = normalizeGenreTags(genres)
    if (normalizedGenres.length > 0) genreMap.set(sourceId, normalizedGenres)
  }
  return genreMap
}
