import type { GeneratedProviderDefinitionV1 } from './loader'
import { activateGeneratedProvider, bundledProviderRoot } from './loader'
import { ProviderRegistry } from './registry'

export class ProviderLifecycle {
  constructor(
    readonly registry: ProviderRegistry,
    private readonly definitions: readonly GeneratedProviderDefinitionV1[],
    /** Starts enabled installed provider packages after the bundled ones. */
    private readonly activateInstalled: () => Promise<void> = async () => {},
  ) {}

  async activateAll(): Promise<void> {
    for (const definition of this.definitions) {
      try {
        await activateGeneratedProvider(definition, this.registry)
      } catch (error) {
        console.error(`[Puros][Provider:${definition.manifest?.id ?? definition.directoryName}] load failed:`, error)
        if (definition.manifest?.id && !this.registry.has(definition.manifest.id)) {
          try {
            this.registry.addManifest(definition.manifest, bundledProviderRoot(definition))
            this.registry.markError(definition.manifest.id, error)
          } catch {
            // Invalid or duplicate manifests are isolated from the rest of main.
          }
        }
      }
    }
    try {
      await this.activateInstalled()
    } catch (error) {
      console.error('[Puros][ProviderPackages] installed provider startup failed:', error)
    }
  }

  async deactivateAll(): Promise<void> {
    await this.registry.deactivateAll()
  }
}
