import type { ProviderManifestV1 } from '../../../src/provider-api/v1'

/** No ambient main-process variables are inherited by the provider utility process. */
export function providerProcessEnvironment(
  manifest: ProviderManifestV1,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const prefix = `${manifest.id.replace(/-/g, '_').toUpperCase()}_`
  const result: Record<string, string> = {}
  for (const name of manifest.permissions?.runtimeEnvironment ?? []) {
    if (!name.startsWith(prefix)) throw new TypeError('Provider environment name is outside its namespace')
    const value = source[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

/** Helper subprocesses receive a private home/temp directory, never the main environment. */
export function providerHelperEnvironment(dataRoot: string): Record<string, string> {
  return {
    HOME: dataRoot,
    TMPDIR: dataRoot,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
  }
}
