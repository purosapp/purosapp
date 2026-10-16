export interface SourceEntityRef {
  providerId: string
  entityType: 'artist' | 'album' | 'track' | 'playlist'
  sourceId: string
}

export function sourceEntityId(ref: SourceEntityRef): string {
  if (!ref.providerId.trim() || !ref.sourceId.trim()) throw new Error('Source identity requires a provider and item ID')
  return `catalog:${ref.entityType}:${encodeURIComponent(ref.providerId)}:${encodeURIComponent(ref.sourceId)}`
}

export function parseSourceEntityId(id: string): SourceEntityRef | null {
  const parts = id.split(':')
  if (parts.length !== 4 || parts[0] !== 'catalog' || !['artist', 'album', 'track', 'playlist'].includes(parts[1])) return null
  try {
    const providerId = decodeURIComponent(parts[2])
    const sourceId = decodeURIComponent(parts[3])
    if (!providerId || !sourceId) return null
    return { providerId, entityType: parts[1] as SourceEntityRef['entityType'], sourceId }
  } catch { return null }
}
