// Ordered SQL migrations for the AttestBook registry.
//
// Migration files live in the repository's `migrations/` directory and are
// imported as text, so the production bundle carries them without relying on a
// runtime working directory. Applied versions are recorded with a SHA-256
// checksum: editing an already-applied migration is an error, not a silent
// drift, and the fix is a new migration file.

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

import initialRegistry from '../../migrations/0001_registry.sql' with { type: 'text' }
import versionsAndArtifacts from '../../migrations/0002_versions_artifacts.sql' with { type: 'text' }

export interface Migration {
  /** Stable, ordered version such as `0001_registry`. */
  readonly version: string
  readonly sql: string
}

export interface AppliedMigration {
  readonly version: string
  readonly checksum: string
  readonly appliedAt: string
}

export interface ApplyMigrationsOptions {
  /** Clock used for `applied_at`; injectable for deterministic tests. */
  readonly now?: () => string
}

const MIGRATION_VERSION_PATTERN = /^\d{4}_[a-z0-9_]+$/

export const MIGRATIONS: readonly Migration[] = [
  { version: '0001_registry', sql: initialRegistry },
  { version: '0002_versions_artifacts', sql: versionsAndArtifacts },
]

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

function validateMigrations(migrations: readonly Migration[]): void {
  let previous = ''
  for (const migration of migrations) {
    if (!MIGRATION_VERSION_PATTERN.test(migration.version)) {
      throw new Error(`invalid migration version "${migration.version}"`)
    }
    if (migration.version <= previous) {
      throw new Error(
        `migrations must be unique and ordered: "${migration.version}" follows "${previous}"`,
      )
    }
    if (migration.sql.trim() === '') {
      throw new Error(`migration "${migration.version}" is empty`)
    }
    previous = migration.version
  }
}

function ensureMigrationTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    )
  `)
}

/** Returns the migrations recorded in the database, ordered by version. */
export function listAppliedMigrations(database: Database): readonly AppliedMigration[] {
  ensureMigrationTable(database)
  return database
    .query<{ version: string; checksum: string; applied_at: string }, []>(
      'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version',
    )
    .all()
    .map((row) => ({ version: row.version, checksum: row.checksum, appliedAt: row.applied_at }))
}

/**
 * Applies every pending migration in a transaction, then verifies that the
 * recorded checksums still match the checked-in SQL. Returns the migrations
 * applied by this call; calling it again on an up-to-date database is a no-op.
 */
export function applyMigrations(
  database: Database,
  options: ApplyMigrationsOptions = {},
): readonly AppliedMigration[] {
  validateMigrations(MIGRATIONS)
  ensureMigrationTable(database)

  const now = options.now ?? (() => new Date().toISOString())
  const applied = new Map(
    listAppliedMigrations(database).map((migration) => [migration.version, migration]),
  )
  const knownVersions = new Set(MIGRATIONS.map((migration) => migration.version))

  for (const version of applied.keys()) {
    if (!knownVersions.has(version)) {
      throw new Error(
        `database has migration "${version}" which this build does not know; ` +
          'deploy a newer application version instead of downgrading the schema',
      )
    }
  }

  const newlyApplied: AppliedMigration[] = []

  for (const migration of MIGRATIONS) {
    const checksum = migrationChecksum(migration.sql)
    const existing = applied.get(migration.version)

    if (existing !== undefined) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `checksum mismatch for applied migration "${migration.version}"; ` +
            'never edit an applied migration, add a new one instead',
        )
      }
      continue
    }

    const appliedAt = now()
    database.transaction(() => {
      database.exec(migration.sql)
      database
        .query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, checksum, appliedAt)
    })()

    const record = { version: migration.version, checksum, appliedAt }
    applied.set(migration.version, record)
    newlyApplied.push(record)
  }

  return newlyApplied
}
