import { useEffect } from 'react'
import { useLastFmStore } from '../../store/lastfmStore'
import { Button, SelectField } from '../ui'
import { Switch } from './controls'

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
      <h3 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 mb-3">
        Last.fm
      </h3>

      <div className="bg-white/[0.03] rounded-2xl p-4 space-y-4">
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
              <Button variant="secondary" size="sm" label="Disconnect" onClick={() => { void disconnect() }} />
            ) : (
              <Button
                variant="primary"
                size="sm"
                label={authenticating ? 'Connecting…' : 'Connect'}
                onClick={() => { void startAuth() }}
                disabled={!configured || authenticating}
              />
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
              <Switch checked={config.enabled} onChange={(value) => { void updateConfig({ enabled: value }) }} label="Enable scrobbling" />
            </label>

            <label className="flex items-center justify-between gap-4 py-1 cursor-pointer group">
              <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors select-none">
                Show scrobble notifications
              </span>
              <Switch checked={config.showScrobbleToasts} onChange={(value) => { void updateConfig({ showScrobbleToasts: value }) }} label="Show scrobble notifications" />
            </label>

            <label className="block space-y-2 max-w-xs">
              <span className="block text-xs uppercase tracking-wider text-zinc-500">
                Scrobble threshold
              </span>
              <SelectField
                size="md"
                value={config.scrobbleThreshold}
                onChange={(event) => {
                  void updateConfig({ scrobbleThreshold: Number(event.target.value) })
                }}
                className="w-full"
              >
                <option value={0.5}>50% (default)</option>
                <option value={0.7}>70%</option>
                <option value={1}>100%</option>
              </SelectField>
            </label>

            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>Scrobbled this session: {scrobbleCount}</span>
              <span className="text-zinc-700">•</span>
              <span>Queued offline: {offlineQueue.length}</span>
              {offlineQueue.length > 0 ? (
                <Button variant="quiet" size="xs" label="Send now" onClick={() => { void flushOfflineQueue() }} className="ml-1" />
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
