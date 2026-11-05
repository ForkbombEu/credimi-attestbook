import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Verification gate from the Phase 0 implementation plan: the Phase 1
 * persistence decision (D-7) assumes Bun's built-in SQLite supports WAL and
 * foreign keys. This test proves the runtime surface exists before the
 * registry issue builds on it; it does not create the product schema.
 */
describe('Bun SQLite compatibility', () => {
  let temporaryDirectory: string | undefined

  afterEach(() => {
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true })
      temporaryDirectory = undefined
    }
  })

  test('opens a temporary database with WAL and enforced foreign keys', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'attestbook-sqlite-smoke-'))
    const database = new Database(join(temporaryDirectory, 'attestbook.sqlite'), {
      create: true,
    })

    try {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
      database.exec(
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))',
      )

      const journalMode = database.query('PRAGMA journal_mode').get() as {
        journal_mode: string
      }
      expect(journalMode.journal_mode).toBe('wal')

      const foreignKeys = database.query('PRAGMA foreign_keys').get() as {
        foreign_keys: number
      }
      expect(foreignKeys.foreign_keys).toBe(1)

      database.exec('INSERT INTO parent (id) VALUES (1)')
      expect(() => database.exec('INSERT INTO child (id, parent_id) VALUES (1, 999)')).toThrow()
    } finally {
      database.close()
    }
  })
})
