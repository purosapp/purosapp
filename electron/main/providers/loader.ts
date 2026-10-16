import { app } from 'electron'
import path from 'node:path'
import type { ProviderManifestV1 } from '../../../src/provider-api/v1'
import { ProviderProcessManager } from './processManager'
import { ProviderRegistry } from './registry'
import { validateProviderManifest } from './validation'

export interface GeneratedProviderDefinitionV1 {
  directoryName: string
  manifest: ProviderManifestV1
}

/** A provider ready to launch: compiled into the build, or installed from a package. */
export interface ProviderDefinition {
  manifest: ProviderManifestV1
  /** Code/resource root handed to the host as `getResourceRoot()`. */
  providerRoot: string
  origin: 'bundled' | 'installed'
  /** Installed packages only: absolute path of the verified compiled entry inside `providerRoot`. */
  entryPath?: string
}

export function validateGeneratedProviderDefinition(definition: GeneratedProviderDefinitionV1): void {
  const validation = validateProviderManifest(definition.manifest)
  if (!validation.ok) throw new Error(`Invalid manifest for ${definition.directoryName}: ${validation.errors.join('; ')}`)
  if (definition.directoryName !== definition.manifest.id && !(definition.directoryName === '_example' && definition.manifest.id === 'example')) {
    throw new Error(`Provider directory ${definition.directoryName} does not match manifest ID ${definition.manifest.id}`)
  }
}

export function bundledProviderRoot(definition: GeneratedProviderDefinitionV1): string {
  const appRoot = process.env.APP_ROOT ?? process.cwd()
  // app.isPackaged, not NODE_ENV: packaged builds do not set NODE_ENV at runtime.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'providers', definition.manifest.id)
    : path.join(appRoot, 'providers', definition.directoryName)
}

/**
 * Registers the provider and starts its utility process. Rejects when the
 * process cannot activate; the registry entry then shows the error.
 */
export async function startProviderDefinition(definition: ProviderDefinition, registry: ProviderRegistry): Promise<void> {
  registry.addManifest(definition.manifest, definition.providerRoot)
  const manager = new ProviderProcessManager(definition.manifest, definition.providerRoot, registry, definition.entryPath)
  try {
    await manager.start()
  } catch (error) {
    registry.markError(definition.manifest.id, error)
    throw error
  }
}

export async function activateGeneratedProvider(
  definition: GeneratedProviderDefinitionV1,
  registry: ProviderRegistry,
): Promise<void> {
  validateGeneratedProviderDefinition(definition)
  await startProviderDefinition({ manifest: definition.manifest, providerRoot: bundledProviderRoot(definition), origin: 'bundled' }, registry)
    .catch(() => {
      // Activation failures are recorded on the registry entry and must not stop other providers.
    })
}
