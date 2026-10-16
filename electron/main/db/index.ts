import { app } from 'electron'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { initSchema } from './schema'

const require = createRequire(import.meta.url)

let db: Database.Database | null = null
let backfillArtworkCache: ((db: Database.Database) => void) | null = null

export function configureDatabase(deps: {
  backfillArtworkCache: (db: Database.Database) => void
}) {
  backfillArtworkCache = deps.backfillArtworkCache
}

function sqliteTableExists(dbHandle: Database.Database, tableName: string): boolean {
  const row = dbHandle.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(tableName) as { name: string } | undefined
  return !!row
}

function sqliteTableRowCount(dbHandle: Database.Database, tableName: string): number {
  if (!sqliteTableExists(dbHandle, tableName)) return 0
  const row = dbHandle.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number }
  return row.count
}

function sqliteDbHasUserData(
  BetterSqlite3: typeof import('better-sqlite3'),
  dbPath: string,
): boolean {
  if (!fs.existsSync(dbPath)) return false

  let candidateDb: Database.Database | null = null
  try {
    candidateDb = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
    return ['tracks', 'albums', 'artists', 'playlists', 'watch_folders']
      .some((tableName) => sqliteTableRowCount(candidateDb!, tableName) > 0)
  } catch {
    return fs.statSync(dbPath).size > 0
  } finally {
    candidateDb?.close()
  }
}

function copySqliteDatabaseWithWal(sourceDbPath: string, targetDbPath: string): void {
  fs.mkdirSync(path.dirname(targetDbPath), { recursive: true })
  fs.copyFileSync(sourceDbPath, targetDbPath)

  for (const suffix of ['-wal', '-shm']) {
    const sourceSidecar = `${sourceDbPath}${suffix}`
    if (!fs.existsSync(sourceSidecar)) continue
    fs.copyFileSync(sourceSidecar, `${targetDbPath}${suffix}`)
  }
}

function migrateLegacyPurosDatabase(
  BetterSqlite3: typeof import('better-sqlite3'),
  targetDbPath: string,
): void {
  const legacyCandidates = getLegacyPurosDatabaseCandidates(targetDbPath)
  const legacyDbPath = legacyCandidates.find((candidate) => fs.existsSync(candidate))
  if (!legacyDbPath) return

  const targetHasUserData = sqliteDbHasUserData(BetterSqlite3, targetDbPath)
  const legacyHasUserData = sqliteDbHasUserData(BetterSqlite3, legacyDbPath)
  if (!legacyHasUserData || targetHasUserData) return

  if (fs.existsSync(targetDbPath)) {
    const backupPath = `${targetDbPath}.empty-before-puros-migration-${Date.now()}`
    fs.renameSync(targetDbPath, backupPath)
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${targetDbPath}${suffix}`
      if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${backupPath}${suffix}`)
    }
  }

  copySqliteDatabaseWithWal(legacyDbPath, targetDbPath)
  console.info(`[Puros] Migrated existing database from ${legacyDbPath} to ${targetDbPath}`)
}

function getLegacyPurosDatabaseCandidates(targetDbPath?: string): string[] {
  const resolvedTargetDbPath = targetDbPath ?? path.join(app.getPath('userData'), 'puros.db')
  return [
    path.join(app.getPath('appData'), 'purist', 'purist.db'),
    path.join(path.dirname(resolvedTargetDbPath), 'purist.db'),
  ]
}

function removePathIfExists(targetPath: string) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only.
  }
}

export function removeSqliteDatabaseWithWal(dbPath: string): void {
  removePathIfExists(dbPath)
  removePathIfExists(`${dbPath}-wal`)
  removePathIfExists(`${dbPath}-shm`)
}

export function clearLegacyPurosDatabases(targetDbPath?: string): void {
  const candidates = getLegacyPurosDatabaseCandidates(targetDbPath)
  for (const candidate of candidates) {
    removeSqliteDatabaseWithWal(candidate)
  }
}

export function getDb(): Database.Database {
  if (!db) {
    if (!backfillArtworkCache) {
      throw new Error('Database must be configured before first use')
    }
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const dbPath = getCurrentDatabasePath()
    migrateLegacyPurosDatabase(BetterSqlite3, dbPath)
    db = new BetterSqlite3(dbPath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      if ((db.pragma('user_version', { simple: true }) as number) < 30) {
        const backupPath = `${dbPath}.before-provider-separation`
        if (!fs.existsSync(backupPath)) db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
      }
      initSchema(db, backfillArtworkCache)
    } catch (error) {
      db.close()
      db = null
      throw error
    }
  }
  return db
}

export function getCurrentDatabasePath(): string {
  return path.join(app.getPath('userData'), 'puros.db')
}

export function closeCurrentDatabase() {
  if (!db) return
  try {
    db.close()
  } finally {
    db = null
  }
}
