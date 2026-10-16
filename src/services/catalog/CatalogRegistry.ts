import type { CatalogProviderName } from './types'
import type { CatalogProvider } from './CatalogProvider'

export class CatalogRegistry {
  private readonly providers = new Map<CatalogProviderName, CatalogProvider>()

  register(provider: CatalogProvider) {
    this.providers.set(provider.name, provider)
  }

  unregister(name: CatalogProviderName) {
    this.providers.delete(name)
  }

  clearRemoteProviders() {
    for (const name of this.providers.keys()) {
      if (name !== 'local') this.providers.delete(name)
    }
  }

  getProvider(name: CatalogProviderName) {
    return this.providers.get(name) ?? null
  }

  getProviders() {
    return [...this.providers.values()]
  }

  async getAuthenticatedProviders() {
    const providers = await Promise.all(
      this.getProviders().map(async (provider) => ({
        provider,
        authenticated: await provider.isAuthenticated().catch(() => false),
      })),
    )
    return providers.filter((entry) => entry.authenticated).map((entry) => entry.provider)
  }
}
