interface LastFmCredentials {
  apiKey: string
  apiSecret: string
}

declare const __PUROS_LASTFM_CREDENTIALS__: LastFmCredentials

export function getLastFmCredentials(): LastFmCredentials {
  const bundled = typeof __PUROS_LASTFM_CREDENTIALS__ === 'undefined'
    ? { apiKey: '', apiSecret: '' }
    : __PUROS_LASTFM_CREDENTIALS__

  return {
    apiKey: process.env.LASTFM_API_KEY?.trim() || bundled.apiKey,
    apiSecret: process.env.LASTFM_API_SECRET?.trim() || bundled.apiSecret,
  }
}
