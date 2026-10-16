import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, string>()
beforeEach(() => {
  vi.resetModules(); storage.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('window', { puros: { catalog: {} } })
})
afterEach(() => vi.unstubAllGlobals())

async function load() {
  const { useNavigationStore } = await import('./navigationStore')
  const { useAppShellStore } = await import('./appShellStore')
  const { useCatalogStore } = await import('./catalogStore')
  const shell = () => useAppShellStore.getState()
  const catalog = () => useCatalogStore.getState()
  const nav = () => useNavigationStore.getState()
  return { shell, catalog, nav }
}

describe('global back/forward navigation', () => {
  it('replays shell and catalog steps in the order they were taken', async () => {
    const { shell, catalog, nav } = await load()
    expect(nav()).toMatchObject({ canGoBack: false, canGoForward: false })

    shell().setActiveView('pins')                  // shell step
    catalog().setProvider('tidal', { browse: false }) // catalog step
    shell().setActiveView('history')               // shell step

    nav().goBack()
    expect(shell().activeView).toBe('pins')
    expect(catalog().activeProviderId).toBe('tidal')
    nav().goBack()
    expect(catalog().activeProviderId).toBe('local')
    expect(shell().activeView).toBe('pins')
    nav().goBack()
    expect(shell().activeView).toBe('library')
    expect(nav()).toMatchObject({ canGoBack: false, canGoForward: true })

    nav().goForward()
    expect(shell().activeView).toBe('pins')
    nav().goForward()
    expect(catalog().activeProviderId).toBe('tidal')
    nav().goForward()
    expect(shell().activeView).toBe('history')
    expect(nav()).toMatchObject({ canGoBack: true, canGoForward: false })
  })

  it('drops forward steps from both stores after a fresh navigation', async () => {
    const { shell, catalog, nav } = await load()
    catalog().setProvider('tidal', { browse: false })
    shell().setActiveView('pins')
    nav().goBack()
    nav().goBack()
    expect(nav().canGoForward).toBe(true)

    shell().setActiveView('history')
    expect(nav()).toMatchObject({ canGoBack: true, canGoForward: false })
    expect(shell().future).toEqual([])
    expect(catalog().future).toEqual([])
  })
})
