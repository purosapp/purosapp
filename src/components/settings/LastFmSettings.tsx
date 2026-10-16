import { useEffect } from 'react'
import { useLastFmStore } from '../../store/lastfmStore'

export default function LastFmSettings() {
  const {
    config,
    configured,
    isConnected,
    authenticating,
    authError,
    offlineQueue,
    scrobbleCount,
    load,
    updateConfig,
    disconnect,
    flushOfflineQueue,
  } = useLastFmStore()

  useEffect(() => {
    void load()
  }, [load])

  const startAuth = async () => {
    if (!configured || authenticating) return

    const authUrl = await window.puros.lastfm.getAuthUrl()
    if (!authUrl) return

    await window.puros.app.openExternal(authUrl)
  }

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
        Last.fm
      </h3>

      <div className="bg-zinc-800/60 rounded-lg p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {isConnected ? (
              <>
                <p className="text-sm text-zinc-100 font-medium">
                  Connected{config.username ? ` as ${config.username}` : ''}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Now Playing is sent on playback start. Scrobbles are sent after 50% or 4 minutes, with a 30 second minimum.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-200 font-medium">Not connected</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Connect your account to start scrobbling.
                </p>
              </>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isConnected ? (
              <button
                onClick={() => { void disconnect() }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition-colors"
              >
                Disconnect
              </button>
            ) : (
              <button
                onClick={() => { void startAuth() }}
                disabled={!configured || authenticating}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                {authenticating ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </div>
        </div>

        {!configured ? (
          <p className="text-xs text-amber-200">
            Last.fm is not configured for this build.
          </p>
        ) : null}

        {isConnected ? (
          <div className="space-y-3 border-t border-white/5 pt-4">
            <label className="flex items-center justify-between gap-4 py-1 cursor-pointer group">
              <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors select-none">
                Enable scrobbling
              </span>
              <button
                role="switch"
                aria-checked={config.enabled}
                onClick={() => { void updateConfig({ enabled: !config.enabled }) }}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                  config.enabled ? 'bg-blue-600' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-150 ${
                    config.enabled ? 'left-4.5' : 'left-0.5'
                  }`}
                />
              </button>
            </label>

            <label className="flex items-center justify-between gap-4 py-1 cursor-pointer group">
              <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors select-none">
                Show scrobble notifications
              </span>
              <button
                role="switch"
                aria-checked={config.showScrobbleToasts}
                onClick={() => { void updateConfig({ showScrobbleToasts: !config.showScrobbleToasts }) }}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                  config.showScrobbleToasts ? 'bg-blue-600' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-150 ${
                    config.showScrobbleToasts ? 'left-4.5' : 'left-0.5'
                  }`}
                />
              </button>
            </label>

            <label className="block space-y-2 max-w-xs">
              <span className="block text-xs uppercase tracking-wider text-zinc-500">
                Scrobble threshold
              </span>
              <select
                value={config.scrobbleThreshold}
                onChange={(event) => {
                  void updateConfig({ scrobbleThreshold: Number(event.target.value) })
                }}
                className="w-full px-3 py-2 bg-zinc-900/80 border border-white/10 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-white/20"
              >
                <option value={0.5}>50% (default)</option>
                <option value={0.7}>70%</option>
                <option value={1}>100%</option>
              </select>
            </label>

            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>Scrobbled this session: {scrobbleCount}</span>
              <span className="text-zinc-700">•</span>
              <span>Queued offline: {offlineQueue.length}</span>
              {offlineQueue.length > 0 ? (
                <button
                  onClick={() => { void flushOfflineQueue() }}
                  className="ml-1 px-2 py-1 rounded-md border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  Send now
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {authError ? (
          <p className="text-xs text-red-300">{authError}</p>
        ) : null}
      </div>
    </div>
  )
}
