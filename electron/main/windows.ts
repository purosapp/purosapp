import { app, BrowserWindow, Menu, nativeImage, nativeTheme } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import liquidGlass from 'electron-liquid-glass'
import {
  RENDERER_DIST,
  VITE_DEV_SERVER_URL,
} from './env'
import {
  getMainWindow,
  setMainWindow,
} from './rendererBridge'
import { flushPendingLastFmAuthToken } from './lastfm'
import { trackWindowActivity } from './windowActivity'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function setMacDevDockIcon(): void {
  // electron-builder icon config affects packaged apps; this enables a custom icon in dev.
  if (process.platform !== 'darwin' || !VITE_DEV_SERVER_URL) return

  const iconPath = path.join(process.env.APP_ROOT!, 'build', 'icon.icns')
  if (!fs.existsSync(iconPath)) return

  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) return

  // Force a dock refresh because macOS can cache app icons aggressively in dev.
  app.dock?.setIcon(nativeImage.createEmpty())
  setTimeout(() => {
    app.dock?.setIcon(icon)
  }, 50)
}

let visualizerWindow: BrowserWindow | null = null

export function openVisualizerWindow(): void {
  if (visualizerWindow && !visualizerWindow.isDestroyed()) {
    if (visualizerWindow.isMinimized()) visualizerWindow.restore()
    visualizerWindow.focus()
    return
  }
  const vizWin = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  visualizerWindow = vizWin
  trackWindowActivity(vizWin)

  if (VITE_DEV_SERVER_URL) {
    void vizWin.loadURL(VITE_DEV_SERVER_URL + '?visualizer=1')
  } else {
    void vizWin.loadFile(path.join(RENDERER_DIST, 'index.html'), { query: { visualizer: '1' } })
  }

  getMainWindow()?.webContents.send('visualizer:detached')
  vizWin.on('closed', () => {
    visualizerWindow = null
    getMainWindow()?.webContents.send('visualizer:attached')
  })
}

export function closeVisualizerWindow(): void {
  if (visualizerWindow && !visualizerWindow.isDestroyed()) visualizerWindow.close()
}

export function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => { getMainWindow()?.webContents.send('app:open-settings') },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function createWindow(): void {
  // The UI is dark-only; keep the sidebar material dark in light mode too.
  nativeTheme.themeSource = 'dark'
  // macOS 26+: native Liquid Glass (NSGlassEffectView) behind the web
  // contents; older macOS keeps the sidebar vibrancy material.
  const useLiquidGlass = liquidGlass.isGlassSupported()
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    // Vertically centred in the renderer's 68px title bar (TopBar, h-17).
    trafficLightPosition: { x: 20, y: 27 },
    // Transparent so the sidebar column shows the native material behind it;
    // the renderer paints everything else opaque. Liquid Glass must not be
    // combined with vibrancy, which would cover it with the blurry material.
    ...(useLiquidGlass
      ? { transparent: true }
      : { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const }),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  setMainWindow(win)
  trackWindowActivity(win)

  if (process.env.PUROS_RENDERER_SMOKE === '1') {
    const resultPath = process.env.PUROS_RENDERER_SMOKE_RESULT
    const rendererErrors: string[] = []
    const report = (result: unknown) => {
      if (!resultPath) return
      fs.writeFileSync(`${resultPath}.tmp`, JSON.stringify(result))
      fs.renameSync(`${resultPath}.tmp`, resultPath)
    }
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') rendererErrors.push(event.message)
    })
    win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame) {
        const error = `Load failed (${code}): ${description}`
        rendererErrors.push(error)
        report({ error, errors: rendererErrors })
      }
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      const error = `Renderer exited: ${details.reason}`
      rendererErrors.push(error)
      report({ error, errors: rendererErrors })
    })
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        const home = await win.webContents.executeJavaScript(
          "({ hasRoot: Boolean(document.querySelector('#root')?.firstElementChild), text: document.body.innerText })",
        ) as { hasRoot: boolean; text: string }
        win.webContents.send('app:open-settings')
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        const settings = await win.webContents.executeJavaScript('document.body.innerText') as string
        const providers = await win.webContents.executeJavaScript('window.puros.provider.list()')
        const localPlaybackPath = process.env.PUROS_LOCAL_SMOKE_FILE
        const localPlayback = localPlaybackPath
          ? await win.webContents.executeJavaScript(`(async () => {
              const audio = window.puros.audio
              try {
                const opened = await audio.openShared('__default__')
                if (!opened.success) return { ok: false, stage: 'open', error: opened.error }
                const played = await audio.playFile(${JSON.stringify(localPlaybackPath)})
                if (!played.success) return { ok: false, stage: 'play', error: played.error }
                const duration = await audio.getDuration()
                const deadline = Date.now() + 4_000
                let position = await audio.getPosition()
                while (position <= 0.05 && Date.now() < deadline) {
                  await new Promise((resolve) => setTimeout(resolve, 100))
                  position = await audio.getPosition()
                }
                const format = await audio.getCurrentFormat()
                const mode = await audio.getMode()
                return {
                  ok: mode === 'shared' && duration > 1.8 && duration < 2.2 &&
                    position > 0.05 && format.sampleRate > 0 && format.channels > 0,
                  mode, duration, position, format,
                }
              } finally {
                await audio.stopPlayback()
                await audio.close()
              }
            })()`)
          : undefined
        const providerPlayback = process.env.PUROS_PROVIDER_SMOKE_PLAYBACK === '1'
          ? await win.webContents.executeJavaScript(`(async () => {
              const provider = (await window.puros.provider.list()).find(({ manifest }) =>
                manifest.capabilities.includes('catalog.search') && manifest.capabilities.includes('playback.resolve'))
              if (!provider) return { ok: false, error: { message: 'No playable provider fixture' } }
              const search = await window.puros.provider.invoke(provider.manifest.id, 'catalog.search', 'search', [{ query: 'contract' }])
              if (!search.ok || !search.value?.tracks?.[0]?.sourceId) return search
              return window.puros.provider.invoke(provider.manifest.id, 'playback.resolve', 'resolve', [
                { sourceId: search.value.tracks[0].sourceId, intent: 'playback' },
              ])
            })()`)
          : undefined
        const providerRecovery = process.env.PUROS_PROVIDER_SMOKE_FAULTS === '1'
          ? await win.webContents.executeJavaScript(`(async () => {
              const provider = (await window.puros.provider.list()).find(({ manifest }) =>
                manifest.capabilities.includes('catalog.search'))
              if (!provider) return { ok: false, error: 'No searchable provider fixture' }
              const id = provider.manifest.id
              const waitForReady = async () => {
                const deadline = Date.now() + 8_000
                while (Date.now() < deadline) {
                  if ((await window.puros.provider.status(id)).state === 'ready') return true
                  await new Promise((resolve) => setTimeout(resolve, 100))
                }
                return false
              }
              const search = (query) => window.puros.provider.invoke(id, 'catalog.search', 'search', [{ query }])
              await search('__puros_fixture_crash__')
              const afterCrash = await waitForReady() && (await search('contract')).ok
              await search('__puros_fixture_flood__')
              const afterFlood = await waitForReady() && (await search('contract')).ok
              return { ok: Boolean(afterCrash && afterFlood), afterCrash, afterFlood }
            })()`)
          : undefined
        const providerErrors = process.env.PUROS_PROVIDER_SMOKE_ERRORS === '1'
          ? await win.webContents.executeJavaScript(`(async () => {
              const provider = (await window.puros.provider.list()).find(({ manifest }) =>
                manifest.capabilities.includes('catalog.entities'))
              if (!provider) return { ok: false, error: { message: 'No catalog fixture' } }
              return window.puros.provider.invoke(provider.manifest.id, 'catalog.entities', 'getTrack', ['__puros_missing_track__'])
            })()`)
          : undefined
        const packageUiId = process.env.PUROS_SMOKE_PACKAGE_UI_ID
        const packageUi = packageUiId
          ? await win.webContents.executeJavaScript(`(async () => {
              const id = ${JSON.stringify(packageUiId)}
              const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
              const q = (testId) => document.querySelector('[data-testid="' + testId + '"]')
              const until = async (check, ms = 10000) => {
                const end = Date.now() + ms
                while (Date.now() < end) { const value = await check(); if (value) return value; await wait(100) }
                return null
              }
              const state = async () => (await window.puros.provider.list()).find(({ manifest }) => manifest.id === id)?.status.state ?? null
              const steps = {}
              const installThrough = async (expectIncompatible) => {
                ;(q('provider-package-update-' + id) ?? q('install-provider-button')).click()
                const consent = await until(() => q('provider-package-consent'))
                if (!consent) return { consent: false, message: q('provider-package-message')?.innerText ?? null }
                const text = consent.innerText
                const installDisabledBeforeAck = q('provider-package-install').disabled
                q('provider-package-acknowledge').click()
                await wait(150)
                q('provider-package-install').click()
                const popup = await until(() => q('provider-package-incompatible'), expectIncompatible ? 3000 : 500)
                const incompatible = Boolean(popup && /may be incompatible/i.test(popup.innerText))
                if (popup) q('provider-package-install-anyway')?.click()
                await until(() => !q('provider-package-consent'))
                return { consent: true, text, installDisabledBeforeAck, incompatible }
              }
              const rowText = () => q('provider-package-row-' + id)?.innerText ?? ''
              steps.install = await installThrough(false)
              steps.installedReady = (await until(async () => (await state()) === 'ready')) === true
              steps.rowAfterInstall = (await until(() => q('provider-package-row-' + id)))?.innerText ?? null
              steps.downgrade = await installThrough(true)
              steps.downgradeReady = (await until(async () => (await state()) === 'ready')) === true
              steps.rowAfterDowngrade = (await until(() => /v1\.0\.0/.test(rowText()) && rowText()))
              steps.update = await installThrough(false)
              steps.updateReady = (await until(async () => (await state()) === 'ready')) === true
              steps.rowAfterUpdate = (await until(() => /v2\.0\.0/.test(rowText()) && rowText()))
              q('install-provider-button').click()
              steps.badZipMessage = (await until(() => /cannot be installed/.test(q('provider-package-message')?.innerText ?? '') && q('provider-package-message').innerText)) || null
              steps.badZipOpenedConsent = Boolean(q('provider-package-consent'))
              steps.rowAfterBadZip = rowText()
              steps.stateAfterBadZip = await state()
              q('provider-package-toggle-' + id).click()
              steps.disabled = (await until(async () => (await state()) === null)) === true
              await until(() => q('provider-package-toggle-' + id) && !q('provider-package-toggle-' + id).disabled)
              q('provider-package-toggle-' + id).click()
              steps.reenabled = (await until(async () => (await state()) === 'ready')) === true
              await until(() => !q('provider-package-toggle-' + id)?.disabled)
              // Provider data written through the host must survive removing and reinstalling its code.
              await window.puros.provider.setSetting(id, 'enabled', false)
              q('provider-package-remove-' + id).click()
              ;(await until(() => q('provider-package-remove-confirm-' + id))).click()
              steps.removed = (await until(async () => !q('provider-package-row-' + id) && (await state()) === null)) === true
              steps.reinstall = await installThrough(false)
              steps.reinstallReady = (await until(async () => (await state()) === 'ready')) === true
              steps.settingAfterReinstall = await window.puros.provider.getSetting(id, 'enabled')
              // Data of a provider that is not running is removable from its own Settings row.
              await until(() => !q('provider-package-toggle-' + id)?.disabled)
              q('provider-package-toggle-' + id).click()
              steps.retainedRow = (await until(() => q('retained-data-row-' + id)))?.innerText ?? null
              q('retained-data-remove-' + id)?.click()
              ;(await until(() => q('retained-data-remove-confirm-' + id)))?.click()
              steps.retainedRemoved = (await until(() => !q('retained-data-row-' + id))) === true
              steps.retainedAfterRemoval = (await window.puros.provider.retainedData()).map((entry) => entry.providerId)
              await until(() => !q('provider-package-toggle-' + id)?.disabled)
              q('provider-package-toggle-' + id).click()
              steps.readyAfterDataRemoval = (await until(async () => (await state()) === 'ready')) === true
              steps.settingAfterDataRemoval = (await window.puros.provider.getSetting(id, 'enabled')) ?? null
              return steps
            })()`)
          : undefined
        report({ home, settings, providers, localPlayback, providerPlayback, providerRecovery, providerErrors, packageUi, errors: rendererErrors })
      })().catch((error: unknown) => {
        report({ error: String(error), errors: rendererErrors })
      })
    })
  }

  if (useLiquidGlass) {
    // Transparent windows hide the traffic lights by default.
    win.setWindowButtonVisibility(true)
  }

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  win.webContents.once('did-finish-load', () => {
    flushPendingLastFmAuthToken()
    if (useLiquidGlass) {
      // A light black tint cancels the glass's own grey fill so the sidebar
      // reads as black without losing its see-through look.
      liquidGlass.addView(win.getNativeWindowHandle(), { tintColor: '#00000059' })
    }
  })
}

export function createWindowIfNeeded(): void {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
}
