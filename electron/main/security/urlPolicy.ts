export function normalizeHttpExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8_192) return null

  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}
