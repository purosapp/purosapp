import { app, safeStorage } from 'electron'
import type Database from 'better-sqlite3'

interface TidalStoredSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenType: string
  scopes: string[]
  countryCode: string
  userId?: string
  isPkce?: boolean
  sessionId?: string
}

const TIDAL_SESSION_KEY = 'tidal:session'
const PROVIDER_ID = 'tidal'
const SECRET_KEY = 'session'

export class TidalSecureStore {
  private readonly db: Database.Database
  private memorySession: TidalStoredSession | null = null

  constructor(db: Database.Database) {
    this.db = db
  }

  async load(): Promise<TidalStoredSession | null> {
    if (this.memorySession) return this.memorySession
    const secureRow = this.db.prepare(
      `SELECT ciphertext FROM provider_secrets WHERE provider = ? AND key = ?`,
    ).get(PROVIDER_ID, SECRET_KEY) as { ciphertext: Buffer } | undefined

    try {
      if (!safeStorage.isEncryptionAvailable() && app.isPackaged) return null
      if (secureRow && safeStorage.isEncryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(secureRow.ciphertext)) as TidalStoredSession
      }
    } catch {
      // An intact legacy value may still be recoverable after a failed migration.
    }

    const legacy = this.db.prepare(
      `SELECT value FROM settings WHERE key = ?`,
    ).get(TIDAL_SESSION_KEY) as { value: string } | undefined
    if (!legacy?.value) return null
    try {
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(legacy.value, 'base64'))
        : legacy.value
      return JSON.parse(json) as TidalStoredSession
    } catch {
      return null
    }
  }

  async save(session: TidalStoredSession): Promise<void> {
    const raw = JSON.stringify(session)
    if (!safeStorage.isEncryptionAvailable() && app.isPackaged) {
      throw new Error('Secure TIDAL session storage is unavailable')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      this.memorySession = session
      return
    }
    const ciphertext = safeStorage.encryptString(raw)
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO provider_secrets (provider, key, ciphertext, encryption_version, updated_at)
        VALUES (?, ?, ?, 1, strftime('%s', 'now'))
        ON CONFLICT(provider, key) DO UPDATE SET
          ciphertext = excluded.ciphertext,
          encryption_version = excluded.encryption_version,
          updated_at = excluded.updated_at
      `).run(PROVIDER_ID, SECRET_KEY, ciphertext)
      const stored = this.db.prepare(
        `SELECT ciphertext FROM provider_secrets WHERE provider = ? AND key = ?`,
      ).get(PROVIDER_ID, SECRET_KEY) as { ciphertext: Buffer } | undefined
      if (!stored || safeStorage.decryptString(stored.ciphertext) !== raw) {
        throw new Error('TIDAL session verification failed')
      }
      this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(TIDAL_SESSION_KEY)
    })()
    this.memorySession = null
  }

  async clear(): Promise<void> {
    this.memorySession = null
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM provider_secrets WHERE provider = ? AND key = ?`).run(PROVIDER_ID, SECRET_KEY)
      this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(TIDAL_SESSION_KEY)
    })()
  }
}
