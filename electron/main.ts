import { app } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadMainProcessEnv, RENDERER_DIST, VITE_DEV_SERVER_URL } from './main/env'
import { closeCurrentDatabase, configureDatabase, getDb } from './main/db'
import { emitLibraryCatalogChanged, getMainWindow, sendToRenderer, setMainWindow } from './main/rendererBridge'
import { runPlaybackIdleTask } from './main/playbackCoordinator'
import { backfillArtworkCache, cacheRemoteArtwork, clearArtworkMemoryCache } from './main/artwork/cache'
import { registerAudioIpc } from './main/audio/ipc'
import { registerNowPlayingIpc } from './main/nowPlaying/ipc'
import { registerLiveRadioIpc } from './main/liveRadio/ipc'
import { registerHomeIpc } from './main/home/ipc'
import { registerCatalogIpc } from './main/catalog/ipc'
import { registerLibraryIpc } from './main/library/ipc'
import { registerPlaylistsIpc } from './main/playlists/ipc'
import { registerLastFmIpc } from './main/lastfm/ipc'
import { registerDownloadsIpc } from './main/downloads/ipc'
import { registerLyricsIpc } from './main/lyrics/ipc'
import { registerSettingsIpc } from './main/settings/ipc'
import { clearAutoEQMemoryCache } from './main/audio/autoeq'
import { clearPendingLastFmAuthToken, handleLastFmCallbackUrl, registerLastFmProtocolHandler } from './main/lastfm'
import { configureLyricsProviders } from './main/lyrics/providers'
import { getAudioEngine, openSystemSoundOutputPicker } from './main/audio/engine'
import { configureLocalPlayback, removeLegacyDsdCache } from './main/audio/localPlayback'
import { startDeviceChangeWatcher } from './main/audio/devices'
import { getStreamingAudioCacheStats, scheduleStreamingAudioCacheTrim } from './main/streamingCache'
import { configureLibraryScanner, parseTrackFile, rescanWatchFolders, resetLibraryScanner } from './main/library/scanner'
import { ensureArtistProfile, namesLikelyMatch, titlesLikelyMatch } from './main/metadata/bios'
import { clearMetadataCacheOnly, configureMetadataArtwork, resetMetadataBackfills } from './main/metadata/artwork'
import { ensureCatalogReady, getCatalogRegistry, initCatalogServices, rebuildCatalogGraphFromSources, rebuildUnifiedSearchIndex, resetCatalogServices } from './main/catalog/services'
import { preserveOfficialProviderArtistGenresFromCatalog } from './main/catalog/genres'
import { shutdownDiscordPresence, syncDiscordPresenceSettingsFromDb } from './main/nowPlaying'
import { clearAppCaches, registerReset, registerShutdown, resetAppData } from './main/maintenance'
import { registerAppIpc } from './main/appIpc'
import { registerPrivilegedSchemes, registerProtocolHandlers } from './main/protocols'
import { buildAppMenu, createWindow, createWindowIfNeeded, openVisualizerWindow, closeVisualizerWindow, setMacDevDockIcon } from './main/windows'
import { registerMediaKeyShortcuts, registerNativeRemoteCommandBridge, unregisterMediaKeyShortcuts } from './main/mediaKeys'
import { clearDockMenu } from './main/dockMenu'
import { configureProviderMetadataSettings } from './main/settings/store'
import {
  createCatalogProviderAdapters,
  clearLegacyProviderAuthSessions,
  configureProviderLibrarySync,
  getActiveProviderLibrarySyncPromise,
  getProviderPriorities,
  getSelectedProviderIds,
  isProviderAvailable,
  listProviderDescriptors,
  migrateLegacyProviderState,
  providerLifecycle,
  providerLibrarySync,
  providerRegistry,
  reconcileProviderAvailability,
  registerProviderIpcHandlers,
  syncHostManagedLibraries,
  watchProviderAvailability,
} from './main/providers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let stopProviderAvailabilityWatch: () => void = () => {}

if (process.env.PUROS_RENDERER_SMOKE === '1' && process.env.PUROS_RENDERER_SMOKE_RESULT) {
  const resultPath = process.env.PUROS_RENDERER_SMOKE_RESULT
  const reportStartupError = (error: unknown) => {
    writeFileSync(`${resultPath}.tmp`, JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined }))
    renameSync(`${resultPath}.tmp`, resultPath)
  }
  process.on('uncaughtException', reportStartupError)
  process.on('unhandledRejection', reportStartupError)
}

process.env.APP_ROOT = path.join(__dirname, '..')

const BOOT_LIBRARY_SYNC_INTERVAL_MS = 6 * 60 * 60_000

loadMainProcessEnv(getSelectedProviderIds())
configureDatabase({ backfillArtworkCache })
configureLyricsProviders({ titlesLikelyMatch, namesLikelyMatch })
configureProviderMetadataSettings((capability) => listProviderDescriptors()
  .filter(({ manifest }) => manifest.capabilities.includes(capability))
  .map(({ manifest }) => manifest.id))
initCatalogServices({
  getCatalogProviders: () => createCatalogProviderAdapters(getDb()),
  getProviderPriorities,
  isProviderAvailable,
  cacheRemoteArtwork,
  syncHostManagedLibraries,
  onCatalogChanged: () => sendToRenderer('catalog:changed'),
})
configureProviderLibrarySync({
  getDb,
  cacheArtwork: cacheRemoteArtwork,
  afterSync: async (providerId) => {
    rebuildUnifiedSearchIndex()
    preserveOfficialProviderArtistGenresFromCatalog(providerId)
    // Artist genre enrichment (one provider lookup per artist) stays off until
    // genres work reliably; it made every boot sync crawl.
    await rebuildCatalogGraphFromSources()
    sendToRenderer('playlists:changed')
    sendToRenderer('library:changed')
    sendToRenderer('catalog:changed')
  },
})
configureMetadataArtwork({ getCatalogRegistry })
configureLibraryScanner({
  ensureArtistProfile,
  getProviderLibrarySyncPromise: getActiveProviderLibrarySyncPromise,
  rebuildCatalogGraphFromSources,
})
configureLocalPlayback({ parseTrackFile })
registerReset([
  async () => { providerLibrarySync.cancelPending(); await providerLibrarySync.waitForAll() },
  resetCatalogServices,
  resetLibraryScanner,
  resetMetadataBackfills,
  clearPendingLastFmAuthToken,
  clearArtworkMemoryCache,
  clearAutoEQMemoryCache,
])
registerShutdown([
  () => providerLifecycle.deactivateAll(),
])

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers() {
  registerProviderIpcHandlers(getMainWindow)

  registerAudioIpc({ get win() { return getMainWindow() } })

  registerNowPlayingIpc()


  registerLiveRadioIpc({ get win() { return getMainWindow() } })

  registerHomeIpc()


  registerCatalogIpc({ get win() { return getMainWindow() } })

  registerLibraryIpc({ get win() { return getMainWindow() } })

  registerPlaylistsIpc({ get win() { return getMainWindow() } })

  registerDownloadsIpc()

  registerLastFmIpc()

  registerLyricsIpc()

  // --- Settings (key/value persistence) ---
  registerSettingsIpc({
    onDiscordSettingChanged: syncDiscordPresenceSettingsFromDb,
    onCatalogPriorityChanged: () => {
      getMainWindow()?.webContents.send('catalog:changed')
    },
    onStreamingCacheLimitChanged: () => {
      scheduleStreamingAudioCacheTrim()
    },
    onCreditGuidanceChanged: (action) => {
      void rebuildCatalogGraphFromSources().then(() => {
        emitLibraryCatalogChanged()
      }).catch((error) => {
        console.warn(`[Puros][Catalog] Failed to rebuild catalog after credit guidance ${action}:`, error)
      })
    },
    onMusicBrainzToggled: (value) => {
      if (value === null) {
        void rebuildCatalogGraphFromSources().then(() => {
          emitLibraryCatalogChanged()
        }).catch((error) => {
          console.warn('[Puros][Catalog] Failed to rebuild catalog after MusicBrainz setting deletion:', error)
        })
        return
      }

      const enabled = value === 'true'
      void (async () => {
        try {
          if (!enabled) {
            clearMetadataCacheOnly(getDb())
          }
          await rebuildCatalogGraphFromSources()
          emitLibraryCatalogChanged()
        } catch (error) {
          console.warn('[Puros][Catalog] Failed to rebuild catalog after MusicBrainz setting change:', error)
        }
      })()
    },
    onArtworkPriorityChanged: () => {
    },
  })

  // --- App state ---
  registerAppIpc({
    getMainWindow,
    openVisualizerWindow,
    closeVisualizerWindow,
    clearAppCaches: () => {
      clearAppCaches()
      emitLibraryCatalogChanged()
      getMainWindow()?.webContents.send('catalog:changed')
      getMainWindow()?.webContents.send('playlists:changed')
      getMainWindow()?.webContents.send('library:changed')
    },
    getStreamingAudioCacheStats,
    openSystemSoundOutputPicker,
    resetAppData: async () => {
      providerLibrarySync.cancelPending()
      await providerLibrarySync.waitForAll()
      try {
        await getAudioEngine().stopPlayback()
        await getAudioEngine().clearQueuedFile()
      } catch {
        // ignore if audio engine is unavailable
      }
      for (const { manifest } of providerRegistry.list()) {
        if (!manifest.capabilities.includes('auth')) continue
        const result = await providerRegistry.invoke(manifest.id, 'auth', 'logout', [])
        if (!result.ok) console.warn(`[Puros][Provider:${manifest.id}] Logout before app reset failed:`, result.error.message)
      }
      await clearLegacyProviderAuthSessions()
      await resetAppData()
      emitLibraryCatalogChanged()
      getMainWindow()?.webContents.send('catalog:changed')
      getMainWindow()?.webContents.send('playlists:changed')
      getMainWindow()?.webContents.send('library:changed')
    },
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  if (VITE_DEV_SERVER_URL) {
    console.error('[Puros] Another Puros instance is already running. Quit the installed app before starting npm run dev.')
  }
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith('puros://'))
    if (url) handleLastFmCallbackUrl(url)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

registerPrivilegedSchemes()

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
  // Playback lived in that window; the Dock keeps only its own items until a new one reports in.
  clearDockMenu()
  setMainWindow(null)
})

app.on('activate', () => {
  createWindowIfNeeded()
})

app.on('before-quit', () => {
  providerLibrarySync.cancelPending()
  stopProviderAvailabilityWatch()
  stopProviderAvailabilityWatch = () => {}
  void providerLifecycle.deactivateAll()
  unregisterMediaKeyShortcuts()
  shutdownDiscordPresence()
  try {
    getAudioEngine().clearNowPlayingInfo()
    getAudioEngine().closeSync()
  } catch {
    // The engine may already be closed during shutdown.
  }
  closeCurrentDatabase()
})

app.on('open-url', (event, url) => {
  if (handleLastFmCallbackUrl(url)) {
    event.preventDefault()
  }
})

app.whenReady().then(async () => {
  registerLastFmProtocolHandler()
  setMacDevDockIcon()
  if (!registerNativeRemoteCommandBridge()) {
    registerMediaKeyShortcuts()
  }

  registerProtocolHandlers()
  migrateLegacyProviderState(getDb())

  buildAppMenu()
  registerIpcHandlers()
  await providerLifecycle.activateAll()
  reconcileProviderAvailability(getDb())
  stopProviderAvailabilityWatch = watchProviderAvailability(getDb(), () => {
    sendToRenderer('catalog:changed')
    sendToRenderer('library:changed')
  })
  syncDiscordPresenceSettingsFromDb()
  createWindow()
  const startupLastFmCallback = process.argv.find((arg) => arg.startsWith('puros://lastfm/callback'))
  if (startupLastFmCallback) {
    handleLastFmCallbackUrl(startupLastFmCallback)
  }
  startDeviceChangeWatcher()

  setTimeout(() => {
    runPlaybackIdleTask('local library rescan', async () => {
      await rescanWatchFolders({ emitProgress: false })
    })
  }, 1500)

  runPlaybackIdleTask('initial catalog rebuild', async () => {
    await ensureCatalogReady()
  })

  // DSD is now decoded by the engine as it plays; converted WAVs are no longer used.
  runPlaybackIdleTask('legacy DSD cache cleanup', removeLegacyDsdCache)

  runPlaybackIdleTask('provider library sync', async () => {
    try {
      // Libraries synced in the last few hours are left alone; signing in and
      // adding to the library still sync right away.
      await syncHostManagedLibraries({ skipSyncedWithinMs: BOOT_LIBRARY_SYNC_INTERVAL_MS })
    } catch (error) {
      console.warn('[Puros][Providers] Background library sync failed:', error)
    }
  })
})
