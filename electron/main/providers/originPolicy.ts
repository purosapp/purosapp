/** Match only declared HTTPS origins. A leading `*.` permits subdomains, not the apex. */
export function isAllowedExternalUrl(value: string, declaredOrigins: readonly string[]): boolean {
  let requested: URL
  try { requested = new URL(value) } catch { return false }
  if (requested.protocol !== 'https:' || requested.username || requested.password) return false

  return declaredOrigins.some((declaration) => {
    if (!declaration.startsWith('https://*.')) return requested.origin === declaration
    const suffix = declaration.slice('https://*.'.length).toLowerCase()
    return !!suffix
      && !requested.port
      && requested.hostname.toLowerCase().endsWith(`.${suffix}`)
      && requested.hostname.length > suffix.length + 1
  })
}

/** Return only an HTTPS origin, never an auth URL's path, query or fragment. */
export function authNavigationOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null
  } catch {
    return null
  }
}
