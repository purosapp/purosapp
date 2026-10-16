/** Pure parts of `host.openAuthWindow`; the window itself lives in ProviderHost. */

export interface AuthWindowCookie {
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  expirationDate?: number
}

/**
 * Which partition a provider may open: `persist:puros-provider-<id>[-suffix]`
 * on disk, or the same name without `persist:` in memory.
 */
export function authPartitionKind(providerId: string, partition: string): 'persistent' | 'memory' | null {
  const matches = (name: string, base: string) => name === base || name.startsWith(`${base}-`)
  if (matches(partition, `persist:puros-provider-${providerId}`)) return 'persistent'
  if (matches(partition, `puros-provider-${providerId}`)) return 'memory'
  return null
}

/**
 * Firefox ESR 140 on macOS. Some sign-in pages (Google's) refuse any Chromium
 * they cannot tell from an embedded one; as Firefox the window sends no
 * Chromium client hints that would contradict the user agent.
 */
export const FIREFOX_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'

/** What the embedded Chromium reports through `navigator.userAgentData` in a secure context. */
export interface NativeUserAgentData {
  brands: Array<{ brand: string; version: string }>
  fullVersionList: Array<{ brand: string; version: string }>
  platform: string
  platformVersion: string
  architecture: string
  bitness: string
  model: string
  mobile: boolean
  wow64: boolean
}

/**
 * DevTools `userAgentMetadata` of Google Chrome built on this Chromium: the
 * engine's own client hints (including its GREASE brand) plus the "Google
 * Chrome" brand Chrome adds, so headers, `navigator.userAgentData` and the
 * user agent agree.
 */
export function googleChromeMetadata(native: NativeUserAgentData) {
  const chromium = (list: NativeUserAgentData['brands']) => list.find((entry) => entry.brand === 'Chromium')
  const major = chromium(native.brands)?.version
  const full = chromium(native.fullVersionList)?.version
  if (!major || !full) throw new Error('The embedded Chromium reported no Chromium brand')
  const withChrome = (list: NativeUserAgentData['brands'], version: string) => [
    ...list.filter((entry) => entry.brand !== 'Google Chrome'),
    { brand: 'Google Chrome', version },
  ]
  return {
    brands: withChrome(native.brands, major),
    fullVersionList: withChrome(native.fullVersionList, full),
    platform: native.platform,
    platformVersion: native.platformVersion,
    architecture: native.architecture,
    bitness: native.bitness,
    model: native.model,
    mobile: native.mobile,
    wow64: native.wow64,
  }
}

/**
 * The low-entropy client hints Chrome sends with every secure request. Electron
 * leaves them off navigations even with a DevTools override, so the host adds
 * them where they are missing, formatted as Chromium formats them.
 */
export function lowEntropyClientHints(metadata: ReturnType<typeof googleChromeMetadata>): Record<string, string> {
  return {
    'sec-ch-ua': metadata.brands.map((entry) => `"${entry.brand}";v="${entry.version}"`).join(', '),
    'sec-ch-ua-mobile': metadata.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${metadata.platform}"`,
  }
}

/**
 * The embedded Chromium's user agent as a browser presents it: only the
 * Mozilla/AppleWebKit/Chrome/Safari products, with Chrome's reduced version
 * (`<major>.0.0.0`). Drops the app name and `Electron/x` that `app.userAgentFallback` adds.
 */
export function browserUserAgent(fallback: string): string {
  const products = new Set(['Mozilla', 'AppleWebKit', 'Chrome', 'Safari'])
  return fallback
    .replace(/\s*\b([A-Za-z][\w.-]*)\/(\S+)/g, (token, product: string, version: string) => {
      if (!products.has(product)) return ''
      const lead = token.match(/^\s*/)![0]
      return product === 'Chrome' ? `${lead}Chrome/${version.split('.')[0]}.0.0.0` : token
    })
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function domainMatches(cookieDomain: string, domain: string): boolean {
  const host = cookieDomain.replace(/^\./, '').toLowerCase()
  return host === domain || host.endsWith(`.${domain}`)
}

/** Whether every required cookie name exists in the collected domains. */
export function hasRequiredCookies(cookies: AuthWindowCookie[], domains: string[], required: string[]): boolean {
  const names = new Set(cookies.filter((cookie) => domains.some((domain) => domainMatches(cookie.domain ?? '', domain))).map((cookie) => cookie.name))
  return required.every((name) => names.has(name))
}

/**
 * A Netscape cookie file of the cookies in `domains`, as curl and yt-dlp read
 * it. Duplicates (same domain, path and name) keep the first.
 */
export function serializeCookieJar(cookies: AuthWindowCookie[], domains: string[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const cookie of cookies) {
    const domain = (cookie.domain ?? '').toLowerCase()
    if (!domain || !domains.some((candidate) => domainMatches(domain, candidate))) continue
    const cookiePath = cookie.path || '/'
    const key = `${domain}\t${cookiePath}\t${cookie.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const includeSubdomains = cookie.hostOnly === undefined ? domain.startsWith('.') : !cookie.hostOnly
    const expires = cookie.session || !Number.isFinite(cookie.expirationDate) ? 0 : Math.floor(cookie.expirationDate!)
    lines.push(`${cookie.httpOnly ? '#HttpOnly_' : ''}${[
      domain,
      includeSubdomains ? 'TRUE' : 'FALSE',
      cookiePath,
      cookie.secure ? 'TRUE' : 'FALSE',
      String(expires),
      cookie.name,
      cookie.value,
    ].join('\t')}`)
  }
  return `# Netscape HTTP Cookie File\n\n${lines.join('\n')}\n`
}
