import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from './database'
import { applyMigrations, listAppliedMigrations, MIGRATIONS, migrationChecksum } from './migrations'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

let temporaryDirectory: string | undefined

function createDatabase(): ReturnType<typeof openDatabase> {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'attestbook-migrations-'))
  return openDatabase(join(temporaryDirectory, 'attestbook.sqlite'))
}

afterEach(() => {
  if (temporaryDirectory !== undefined) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

describe('registry migrations', () => {
  test('applies every migration from an empty database and records checksums', () => {
    const database = createDatabase()
    try {
      const applied = applyMigrations(database, { now: () => FIXED_NOW })

      expect(applied.map((migration) => migration.version)).toEqual(
        MIGRATIONS.map((migration) => migration.version),
      )
      expect(applied[0]?.checksum).toBe(migrationChecksum(MIGRATIONS[0]?.sql ?? ''))
      expect(applied[0]?.appliedAt).toBe(FIXED_NOW)

      const recorded = listAppliedMigrations(database)
      expect(recorded).toEqual(applied)

      const tables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => row.name)
      for (const table of [
        'artifacts',
        'attestations',
        'audit_log',
        'auth_tokens',
        'providers',
        'rulebook_versions',
        'rulebooks',
        'schema_migrations',
        'schema_refs',
      ]) {
        expect(tables).toContain(table)
      }
    } finally {
      database.close()
    }
  })

  test('is idempotent when every migration is already applied', () => {
    const database = createDatabase()
    try {
      applyMigrations(database, { now: () => FIXED_NOW })
      expect(applyMigrations(database, { now: () => FIXED_NOW })).toEqual([])
      expect(listAppliedMigrations(database)).toHaveLength(MIGRATIONS.length)
    } finally {
      database.close()
    }
  })

  test('enables WAL and foreign-key enforcement on the connection', () => {
    const database = createDatabase()
    try {
      expect(
        (database.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      ).toBe('wal')
      expect(
        (database.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
      ).toBe(1)
    } finally {
      database.close()
    }
  })

  test('rejects a checksum mismatch for an already-applied migration', () => {
    const database = createDatabase()
    try {
      applyMigrations(database, { now: () => FIXED_NOW })
      database
        .query('UPDATE schema_migrations SET checksum = ? WHERE version = ?')
        .run('0'.repeat(64), MIGRATIONS[0]?.version ?? '')

      expect(() => applyMigrations(database)).toThrow('checksum mismatch')
    } finally {
      database.close()
    }
  })

  test('rejects a migration recorded by a newer build', () => {
    const database = createDatabase()
    try {
      applyMigrations(database, { now: () => FIXED_NOW })
      database
        .query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
        .run('9999_future', '1'.repeat(64), FIXED_NOW)

      expect(() => applyMigrations(database)).toThrow('does not know')
    } finally {
      database.close()
    }
  })

  test('the schema rejects orphaned, duplicated and malformed rows', () => {
    const database = createDatabase()
    try {
      applyMigrations(database, { now: () => FIXED_NOW })

      expect(() =>
        database
          .query(
            `INSERT INTO rulebooks (id, provider_id, name, applicable_spec, created_at, updated_at)
             VALUES ('orphan', 'missing-provider', 'Orphan', 'ts11@1.0.1', ?, ?)`,
          )
          .run(FIXED_NOW, FIXED_NOW),
      ).toThrow(/FOREIGN KEY/i)

      database
        .query(
          `INSERT INTO providers (id, name, publication_authority, metadata_json, created_at)
           VALUES ('provider-1', 'Provider', 'account-1', '{}', ?)`,
        )
        .run(FIXED_NOW)

      expect(() =>
        database
          .query(
            `INSERT INTO providers (id, name, publication_authority, metadata_json, created_at)
             VALUES ('provider-duplicate', 'Provider', 'account-1', '{}', ?)`,
          )
          .run(FIXED_NOW),
      ).toThrow(/UNIQUE constraint/i)

      // Publication authority uniqueness is case-insensitive.
      expect(() =>
        database
          .query(
            `INSERT INTO providers (id, name, publication_authority, metadata_json, created_at)
             VALUES ('provider-case-duplicate', 'Provider', 'ACCOUNT-1', '{}', ?)`,
          )
          .run(FIXED_NOW),
      ).toThrow(/UNIQUE constraint/i)

      expect(() =>
        database
          .query(
            `INSERT INTO providers (id, name, publication_authority, metadata_json, created_at)
             VALUES ('provider-2', 'Provider', 'account-2', '[]', ?)`,
          )
          .run(FIXED_NOW),
      ).toThrow(/CHECK constraint/i)

      database
        .query(
          `INSERT INTO providers (id, name, publication_authority, metadata_json, created_at)
           VALUES ('provider-2', 'Provider', 'account-2', '{}', ?)`,
        )
        .run(FIXED_NOW)

      database
        .query(
          `INSERT INTO rulebooks (id, provider_id, name, applicable_spec, created_at, updated_at)
           VALUES ('rulebook-1', 'provider-1', 'Rulebook', 'ts11@1.0.1', ?, ?)`,
        )
        .run(FIXED_NOW, FIXED_NOW)

      database
        .query(
          `INSERT INTO rulebooks (id, provider_id, name, applicable_spec, created_at, updated_at)
           VALUES ('rulebook-2', 'provider-1', 'Other Rulebook', 'ts11@1.0.1', ?, ?)`,
        )
        .run(FIXED_NOW, FIXED_NOW)

      database
        .query(
          `INSERT INTO attestations (id, rulebook_id, name, attestation_los, binding_type, created_at)
           VALUES ('attestation-1', 'rulebook-1', 'Same', 'iso_18045_high', 'key', ?)`,
        )
        .run(FIXED_NOW)

      database
        .query(
          `INSERT INTO attestations (id, rulebook_id, name, attestation_los, binding_type, created_at)
           VALUES ('attestation-2', 'rulebook-2', 'Same', 'iso_18045_high', 'key', ?)`,
        )
        .run(FIXED_NOW)

      expect(() =>
        database
          .query(
            `INSERT INTO attestations (id, rulebook_id, name, attestation_los, binding_type, created_at)
             VALUES ('attestation-3', 'rulebook-1', 'Same', 'iso_18045_high', 'key', ?)`,
          )
          .run(FIXED_NOW),
      ).toThrow(/UNIQUE constraint/i)

      // A schema reference must point at an attestation of its own rulebook.
      expect(() =>
        database
          .query(
            `INSERT INTO schema_refs (id, rulebook_id, attestation_id, format_identifier, uri, created_at)
             VALUES ('schema-ref-cross', 'rulebook-1', 'attestation-2', 'dc+sd-jwt', 'https://example.org/schema.json', ?)`,
          )
          .run(FIXED_NOW),
      ).toThrow(/FOREIGN KEY/i)

      expect(() =>
        database
          .query(
            `INSERT INTO schema_refs (id, rulebook_id, attestation_id, format_identifier, uri, created_at)
             VALUES ('schema-ref-valid', 'rulebook-1', 'attestation-1', 'dc+sd-jwt', 'https://example.org/schema.json', ?)`,
          )
          .run(FIXED_NOW),
      ).not.toThrow()

      database
        .query(
          `INSERT INTO attestations (id, rulebook_id, name, attestation_los, binding_type, created_at)
           VALUES ('attestation-4', 'rulebook-1', 'Other', 'iso_18045_high', 'key', ?)`,
        )
        .run(FIXED_NOW)

      // The same format is allowed for a different attestation type...
      expect(() =>
        database
          .query(
            `INSERT INTO schema_refs (id, rulebook_id, attestation_id, format_identifier, uri, created_at)
             VALUES ('schema-ref-other-attestation', 'rulebook-1', 'attestation-4', 'dc+sd-jwt', 'https://example.org/other.json', ?)`,
          )
          .run(FIXED_NOW),
      ).not.toThrow()

      // ... but not twice for the same attestation type.
      expect(() =>
        database
          .query(
            `INSERT INTO schema_refs (id, rulebook_id, attestation_id, format_identifier, uri, created_at)
             VALUES ('schema-ref-same-attestation', 'rulebook-1', 'attestation-1', 'dc+sd-jwt', 'https://example.org/duplicate.json', ?)`,
          )
          .run(FIXED_NOW),
      ).toThrow(/UNIQUE constraint/i)

      // Rulebook-level references have their own uniqueness scope.
      expect(() =>
        database
          .query(
            `INSERT INTO schema_refs (id, rulebook_id, attestation_id, format_identifier, uri, created_at)
             VALUES ('schema-ref-rulebook', 'rulebook-1', NULL, 'dc+sd-jwt', 'https://example.org/rulebook.json', ?)`,
          )
          .run(FIXED_NOW),
      ).not.toThrow()

      expect(() =>
        database
          .query(
            `INSERT INTO schema_refs (id, rulebook_id, attestation_id, format_identifier, uri, created_at)
             VALUES ('schema-ref-rulebook-duplicate', 'rulebook-1', NULL, 'dc+sd-jwt', 'https://example.org/rulebook-2.json', ?)`,
          )
          .run(FIXED_NOW),
      ).toThrow(/UNIQUE constraint/i)
    } finally {
      database.close()
    }
  })

  test('protects content-addressed artifacts and published versions at the schema level', () => {
    const database = createDatabase()
    try {
      applyMigrations(database, { now: () => FIXED_NOW })
      database
        .query(
          `INSERT INTO providers (id, name, publication_authority, metadata_json, created_at)
           VALUES ('provider-1', 'Provider', 'account-1', '{}', ?)`,
        )
        .run(FIXED_NOW)
      database
        .query(
          `INSERT INTO rulebooks (id, provider_id, name, applicable_spec, created_at, updated_at)
           VALUES ('rulebook-1', 'provider-1', 'Rulebook', 'ts11@1.0.1', ?, ?)`,
        )
        .run(FIXED_NOW, FIXED_NOW)

      const digest = 'a'.repeat(64)
      database
        .query(
          `INSERT INTO artifacts (digest, media_type, bytes, created_at)
           VALUES (?, 'application/json', X'7b7d', ?)`,
        )
        .run(digest, FIXED_NOW)

      const insertVersionSql = `INSERT INTO rulebook_versions (
          id, rulebook_id, version, status, content_digest, spec_version,
          provenance_json, created_at
        ) VALUES (?, 'rulebook-1', ?, 'draft', ?, 'ts11@1.0.1', '{}', ?)`

      database.query(insertVersionSql).run('version-1', '1.0', digest, FIXED_NOW)

      // A version label is unique per rulebook and must point at stored bytes.
      expect(() =>
        database.query(insertVersionSql).run('version-duplicate', '1.0', digest, FIXED_NOW),
      ).toThrow(/UNIQUE constraint/i)
      expect(() =>
        database.query(insertVersionSql).run('version-orphan', '2.0', 'b'.repeat(64), FIXED_NOW),
      ).toThrow(/FOREIGN KEY/i)
      // Draft rows cannot carry a publication timestamp.
      expect(() =>
        database
          .query("UPDATE rulebook_versions SET published_at = ? WHERE id = 'version-1'")
          .run(FIXED_NOW),
      ).toThrow(/CHECK constraint/i)

      // A draft row can be refreshed, but an artifact never changes.
      expect(() =>
        database
          .query('UPDATE rulebook_versions SET content_digest = ? WHERE id = ?')
          .run(digest, 'version-1'),
      ).not.toThrow()
      expect(() =>
        database.query("UPDATE artifacts SET bytes = X'00' WHERE digest = ?").run(digest),
      ).toThrow(/immutable/i)
      expect(() => database.query('DELETE FROM artifacts WHERE digest = ?').run(digest)).toThrow(
        /immutable/i,
      )

      database
        .query(
          "UPDATE rulebook_versions SET status = 'published', published_at = ? WHERE id = 'version-1'",
        )
        .run(FIXED_NOW)
      expect(() =>
        database
          .query('UPDATE rulebook_versions SET content_digest = ? WHERE id = ?')
          .run('c'.repeat(64), 'version-1'),
      ).toThrow(/immutable/i)
      expect(() =>
        database
          .query("UPDATE rulebook_versions SET status = 'draft' WHERE id = 'version-1'")
          .run(),
      ).toThrow(/immutable/i)
      expect(() =>
        database.query("DELETE FROM rulebook_versions WHERE id = 'version-1'").run(),
      ).toThrow(/immutable/i)

      // A status-only transition is the exception; changing any other column at
      // the same time is still rejected.
      expect(() =>
        database
          .query(
            "UPDATE rulebook_versions SET status = 'historical', provenance_json = '{\"changed\":true}' WHERE id = 'version-1'",
          )
          .run(),
      ).toThrow(/immutable/i)

      // The only permitted transition is published -> historical, once.
      expect(() =>
        database
          .query("UPDATE rulebook_versions SET status = 'historical' WHERE id = 'version-1'")
          .run(),
      ).not.toThrow()
      expect(() =>
        database
          .query("UPDATE rulebook_versions SET status = 'published' WHERE id = 'version-1'")
          .run(),
      ).toThrow(/immutable/i)

      // A draft version still can be created and deleted; its artifact remains.
      expect(() =>
        database.query(insertVersionSql).run('version-2', '2.0', digest, FIXED_NOW),
      ).not.toThrow()
      expect(() =>
        database.query("DELETE FROM rulebook_versions WHERE id = 'version-2'").run(),
      ).not.toThrow()
      expect(
        database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM artifacts').get()
          ?.count,
      ).toBe(1)
    } finally {
      database.close()
    }
  })
})
