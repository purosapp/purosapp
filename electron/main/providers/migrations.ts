import { safeStorage, session } from 'electron'
import type Database from 'better-sqlite3'
import { getDb } from '../db'

type LegacyValueMigration = {
  provider: string
  legacyKey: string
  destinationKey: string
  kind: 'secret' | 'storage'
  decode?(raw: string): string | null
}

const migrations: LegacyValueMigration[] = [
  {
    provider: 'tidal',
    legacyKey: 'tidal:session',
    destinationKey: 'session',
    kind: 'secret',
    decode: decodeLegacyEncryptedJson,
  },
  { provider: 'tidal', legacyKey: 'tidal:lastSyncAt', destinationKey: 'lastSyncAt', kind: 'storage' },
  { provider: 'apple', legacyKey: 'apple:webPlayerToken', destinationKey: 'webPlayerToken', kind: 'secret' },
  { provider: 'apple', legacyKey: 'apple:lastSyncAt', destinationKey: 'lastSyncAt', kind: 'storage' },
]

function validJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function decodeLegacyEncryptedJson(raw: string): string | null {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'))
      if (validJsonObject(decrypted)) return decrypted
    } catch {
      // A development build may have persisted the historical plaintext fallback.
    }
  }
  return validJsonObject(raw) ? raw : null
}

function parseLegacyStorageValue(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || ['string', 'number', 'boolean'].includes(typeof parsed)) return parsed
  } catch {
    // Preserve the exact legacy string when it was not JSON encoded.
  }
  return raw
}

function migrateSecret(
  db: Database.Database,
  migration: LegacyValueMigration,
  raw: string,
  retainLegacy: boolean,
): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const plaintext = migration.decode ? migration.decode(raw) : raw
  if (plaintext === null) return false
  const ciphertext = safeStorage.encryptString(plaintext)
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO provider_secrets (provider, key, ciphertext, encryption_version, updated_at)
      VALUES (?, ?, ?, 1, strftime('%s', 'now'))
      ON CONFLICT(provider, key) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        encryption_version = excluded.encryption_version,
        updated_at = excluded.updated_at
    `).run(migration.provider, migration.destinationKey, ciphertext)
    const stored = db.prepare(
      `SELECT ciphertext FROM provider_secrets WHERE provider = ? AND key = ?`,
    ).get(migration.provider, migration.destinationKey) as { ciphertext: Buffer } | undefined
    if (!stored || safeStorage.decryptString(stored.ciphertext) !== plaintext) {
      throw new Error(`Provider secret migration verification failed for ${migration.provider}`)
    }
    if (!retainLegacy) db.prepare(`DELETE FROM settings WHERE key = ?`).run(migration.legacyKey)
  })
  transaction()
  return true
}

function migrateStorage(
  db: Database.Database,
  migration: LegacyValueMigration,
  raw: string,
  retainLegacy: boolean,
): boolean {
  const encoded = JSON.stringify(parseLegacyStorageValue(raw))
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO provider_kv (provider, key, value, updated_at)
      VALUES (?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(provider, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(migration.provider, migration.destinationKey, encoded)
    const stored = db.prepare(
      `SELECT value FROM provider_kv WHERE provider = ? AND key = ?`,
    ).get(migration.provider, migration.destinationKey) as { value: string } | undefined
    if (!stored || stored.value !== encoded) {
      throw new Error(`Provider storage migration verification failed for ${migration.provider}`)
    }
    if (!retainLegacy) db.prepare(`DELETE FROM settings WHERE key = ?`).run(migration.legacyKey)
  })
  transaction()
  return true
}

export function migrateLegacyProviderState(
  db = getDb(),
  options: { retainLegacy?: boolean } = {},
): void {
  // Preserve retired provider keys until a future account-tested restoration
  // verifies its provider-owned copy; never erase them during migration.
  const retainsLegacy = (provider: string) => options.retainLegacy ?? provider === 'apple'
  const pendingProviders = new Set<string>()
  for (const migration of migrations) {
    const legacy = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(migration.legacyKey) as { value: string } | undefined
    if (!legacy) continue
    try {
      const migrated = migration.kind === 'secret'
        ? migrateSecret(db, migration, legacy.value, retainsLegacy(migration.provider))
        : migrateStorage(db, migration, legacy.value, retainsLegacy(migration.provider))
      if (!migrated) {
        pendingProviders.add(migration.provider)
        console.warn(`[Puros][Providers] Secure migration for ${migration.provider} is pending; the legacy value was retained`)
      }
    } catch (error) {
      pendingProviders.add(migration.provider)
      console.warn(`[Puros][Providers] Legacy state migration for ${migration.provider} failed; the legacy value was retained`, error)
    }
  }

  for (const provider of new Set(migrations.map(({ provider }) => provider))) {
    db.prepare(`
      INSERT INTO provider_kv (provider, key, value, updated_at)
      VALUES (?, '_migration.legacySettings.v1', ?, strftime('%s', 'now'))
      ON CONFLICT(provider, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(provider, JSON.stringify({
      complete: !pendingProviders.has(provider),
      retainedForLegacyAdapter: retainsLegacy(provider),
    }))
  }
}

/** Called only by the user's explicit reset-all action. */
export async function clearLegacyProviderAuthSessions(): Promise<void> {
  for (const partition of ['persist:puros-apple-music-auth', 'persist:puros-provider-apple-auth']) {
    try {
      const authSession = session.fromPartition(partition)
      await authSession.clearStorageData()
      await authSession.clearCache()
      authSession.flushStorageData()
    } catch (error) {
      console.warn('[Puros][Providers] Could not clear a retired auth partition during reset:', error)
    }
  }
}
