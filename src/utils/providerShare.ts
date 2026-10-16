export function getProviderTrackShareUrl(input: {
  provider?: string | null
  sourceId?: string | null
  providerUrl?: string | null
  storefront?: string | null
}): string | null {
  const directUrl = typeof input.providerUrl === 'string' ? input.providerUrl.trim() : ''
  if (directUrl) return directUrl

  return null
}
