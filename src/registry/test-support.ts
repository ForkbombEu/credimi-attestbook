// Shared test fixture for the registry tests.
//
// Each fixture gets its own temporary SQLite database so tests exercise real
// migrations, WAL, foreign keys and file persistence instead of an in-memory
// fake.

import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../db/database'
import { applyMigrations } from '../db/migrations'
import { Registry } from './registry'

export interface RegistryFixture {
  readonly registry: Registry
  readonly database: Database
  readonly directory: string
  readonly databasePath: string
  cleanup(): void
}

/** Monotonic test clock; readable ISO timestamps in insertion order. */
export function createClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1_000).toISOString()
}

export function openMigratedDatabase(databasePath: string): Database {
  const database = openDatabase(databasePath)
  applyMigrations(database, { now: () => '2026-01-01T00:00:00.000Z' })
  return database
}

export function createRegistryFixture(): RegistryFixture {
  const directory = mkdtempSync(join(tmpdir(), 'attestbook-registry-'))
  const databasePath = join(directory, 'attestbook.sqlite')
  const database = openMigratedDatabase(databasePath)
  const registry = new Registry({ database, now: createClock() })

  return {
    registry,
    database,
    directory,
    databasePath,
    cleanup() {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
