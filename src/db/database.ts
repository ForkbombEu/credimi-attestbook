// SQLite connection setup for the AttestBook registry.
//
// The Phase 1 persistence decision (D-7) is a single SQLite database file
// behind a repository/service layer. Every connection enables WAL, foreign
// keys and a busy timeout so the documented invariants (ownership, cascades,
// draft-only writes) are enforced by the database and not only by TypeScript.

import { Database } from 'bun:sqlite'

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

export interface OpenDatabaseOptions {
  /** Create the database file when it does not exist. Defaults to `true`. */
  readonly create?: boolean
  /** How long a locked database is retried before failing. Defaults to 5 s. */
  readonly busyTimeoutMs?: number
}

/**
 * Opens a SQLite database with the Phase 1 pragmas applied. The caller owns
 * the returned handle and must close it. In-memory paths are supported and are
 * useful for isolated tests; production uses a file path.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  if (path.trim() === '') {
    throw new Error('database path must not be empty')
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
    throw new Error('busyTimeoutMs must be a positive integer')
  }

  const database = new Database(path, { create: options.create ?? true })

  try {
    // `journal_mode` returns the resulting mode; in-memory databases report
    // "memory", which is expected and not an error.
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
