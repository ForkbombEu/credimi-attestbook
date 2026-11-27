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
        'admin_sessions',
        'artifacts',
        'attestations',
        'audit_log',
        'auth_tokens',
        'capture_correlations',
        'capture_evidence',
        'capture_evidence_artifacts',
        'credential_schema_documents',
        'providers',
        'publication_events',
        'rulebook_versions',
        'rulebooks',
        'schema_migrations',
        'schema_refs',
        'subscriptions',
        'webhook_delivery_outbox',
        'webhook_delivery_outbox_state',
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
      // The identity trigger rejects the duplicate before the UNIQUE index does.
      expect(() =>
        database.query(insertVersionSql).run('version-duplicate', '1.0', digest, FIXED_NOW),
      ).toThrow(/identity already exists/i)
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

      // A draft version can exist alongside the published one.
      expect(() =>
        database.query(insertVersionSql).run('version-2', '2.0', digest, FIXED_NOW),
      ).not.toThrow()

      // REPLACE resolves conflicts by deleting the replaced row without firing
      // DELETE triggers, so identity re-inserts/updates are rejected up front.
      expect(() =>
        database
          .query(
            `INSERT OR REPLACE INTO rulebook_versions (
              id, rulebook_id, version, status, content_digest, spec_version,
              provenance_json, created_at, published_at
            ) VALUES ('version-1', 'rulebook-1', '1.0', 'published', ?, 'ts11@1.0.1', '{}', ?, ?)`,
          )
          .run(digest, FIXED_NOW, FIXED_NOW),
      ).toThrow(/identity already exists/i)
      expect(() =>
        database
          .query(
            `INSERT OR REPLACE INTO artifacts (digest, media_type, bytes, created_at)
             VALUES (?, 'application/json', X'00', ?)`,
          )
          .run(digest, FIXED_NOW),
      ).toThrow(/artifact digest already exists/i)
      expect(() =>
        database
          .query("UPDATE OR REPLACE rulebook_versions SET version = '1.0' WHERE id = 'version-2'")
          .run(),
      ).toThrow(/identity already exists/i)

      // Deleting the parent cascades to versions, and the published DELETE
      // trigger aborts the statement, including in an INSERT OR REPLACE.
      expect(() => database.query("DELETE FROM rulebooks WHERE id = 'rulebook-1'").run()).toThrow(
        /immutable/i,
      )
      expect(() =>
        database
          .query(
            `INSERT OR REPLACE INTO rulebooks (
              id, provider_id, name, applicable_spec, created_at, updated_at
            ) VALUES ('rulebook-1', 'provider-1', 'Hijacked', 'ts11@1.0.1', ?, ?)`,
          )
          .run(FIXED_NOW, FIXED_NOW),
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

      // A draft version can still be deleted; its artifact remains.
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

  test('backfills a CSRF token for sessions created before the column existed', () => {
    const database = createDatabase()
    try {
      applyMigrations(database, { now: () => FIXED_NOW })
      const csrfMigration = MIGRATIONS.find(
        (migration) => migration.version === '0005_admin_session_csrf',
      )
      if (csrfMigration === undefined) {
        throw new Error('missing the admin-session CSRF migration')
      }

      // Recreate the pre-migration shape: no column, and a live session row
      // that predates it. The migration's backfill must give every such row a
      // random token instead of leaving it unable to authorize a write.
      database.exec('ALTER TABLE admin_sessions DROP COLUMN csrf_token')
      database.exec('PRAGMA foreign_keys = OFF')
      database
        .query(
          `INSERT INTO admin_sessions
             (session_hash, provider_id, auth_fingerprint, created_at, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run('a'.repeat(64), 'legacy-provider', 'b'.repeat(64), FIXED_NOW, FIXED_NOW)

      database.transaction(() => {
        database.exec(csrfMigration.sql)
      })()

      const row = database
        .query<{ csrf_token: string }, []>('SELECT csrf_token FROM admin_sessions')
        .get()
      expect(row?.csrf_token).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      database.close()
    }
  })

  test('starts the delivery cursor at the newest event that existed before the outbox migration', () => {
    const database = createDatabase()
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version TEXT PRIMARY KEY,
          checksum TEXT NOT NULL CHECK (length(checksum) = 64),
          applied_at TEXT NOT NULL
        )
      `)
      for (const migration of MIGRATIONS.filter(
        (candidate) => candidate.version !== '0011_webhook_delivery_outbox',
      )) {
        database.exec(migration.sql)
        database
          .query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migrationChecksum(migration.sql), FIXED_NOW)
      }
      database
        .query(
          `INSERT INTO providers (id, name, publication_authority, metadata_json, created_at)
           VALUES ('provider-cursor', 'Provider', 'account-cursor', '{}', ?)`,
        )
        .run(FIXED_NOW)
      database
        .query(
          `INSERT INTO rulebooks (id, provider_id, name, applicable_spec, created_at, updated_at)
           VALUES ('rulebook-cursor', 'provider-cursor', 'Cursor', 'ts11@1.0.1', ?, ?)`,
        )
        .run(FIXED_NOW, FIXED_NOW)
      const digest = 'b'.repeat(64)
      database
        .query(
          `INSERT INTO artifacts (digest, media_type, bytes, created_at)
           VALUES (?, 'application/vnd.attestbook.rulebook-version+json', X'7b7d', ?)`,
        )
        .run(digest, FIXED_NOW)
      database
        .query(
          `INSERT INTO rulebook_versions (
             id, rulebook_id, version, status, content_digest, spec_version,
             provenance_json, created_at, published_at
           ) VALUES ('version-cursor', 'rulebook-cursor', '1.0', 'published', ?,
             'ts11@1.0.1', '{}', ?, ?)`,
        )
        .run(digest, FIXED_NOW, FIXED_NOW)
      database
        .query(
          `INSERT INTO publication_events (
             id, format, event_type, rulebook_id, version_id, version,
             content_digest, published_at
           ) VALUES ('event-cursor', 'attestbook.rulebook-publication-event@1',
             'rulebook.published', 'rulebook-cursor', 'version-cursor', '1.0', ?, ?)`,
        )
        .run(digest, FIXED_NOW)

      const applied = applyMigrations(database, { now: () => FIXED_NOW })
      expect(applied.map((migration) => migration.version)).toEqual([
        '0011_webhook_delivery_outbox',
      ])
      const eventSequence = database
        .query<{ sequence: number }, []>(
          "SELECT sequence FROM publication_events WHERE id = 'event-cursor'",
        )
        .get()?.sequence
      expect(eventSequence).toBeDefined()
      const state = database
        .query<{ last_event_sequence: number }, []>(
          'SELECT last_event_sequence FROM webhook_delivery_outbox_state WHERE id = 1',
        )
        .get()
      expect(state?.last_event_sequence).toBe(eventSequence)
      // Existing history is not backfilled into notifications.
      const jobs = database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM webhook_delivery_outbox')
        .get()
      expect(jobs?.count).toBe(0)
    } finally {
      database.close()
    }
  })

  test('adds credential schema documents and publication events to a populated pre-feature database', () => {
    const database = createDatabase()
    try {
      // Reproduce a deployed database that predates issues #97 and #116: every
      // earlier migration is applied and real registry, artifact and version
      // rows exist.
      database.exec(`
        CREATE TABLE schema_migrations (
          version TEXT PRIMARY KEY,
          checksum TEXT NOT NULL CHECK (length(checksum) = 64),
          applied_at TEXT NOT NULL
        )
      `)
      for (const migration of MIGRATIONS.filter(
        (candidate) =>
          candidate.version !== '0006_credential_schema_documents' &&
          candidate.version !== '0007_publication_events' &&
          // The outbox migration reads publication_events, so it must apply
          // after 0007 in this reproduction of a pre-feature database.
          candidate.version !== '0011_webhook_delivery_outbox',
      )) {
        database.exec(migration.sql)
        database
          .query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migrationChecksum(migration.sql), FIXED_NOW)
      }

      database
        .query(
          `INSERT INTO providers (id, name, publication_authority, metadata_json, created_at)
           VALUES ('provider-legacy', 'Provider', 'account-legacy', '{}', ?)`,
        )
        .run(FIXED_NOW)
      database
        .query(
          `INSERT INTO rulebooks (id, provider_id, name, applicable_spec, created_at, updated_at)
           VALUES ('rulebook-legacy', 'provider-legacy', 'Legacy', 'ts11@1.0.1', ?, ?)`,
        )
        .run(FIXED_NOW, FIXED_NOW)
      const artifactDigest = 'a'.repeat(64)
      database
        .query(
          `INSERT INTO artifacts (digest, media_type, bytes, created_at)
           VALUES (?, 'application/vnd.attestbook.rulebook-version+json', X'7b7d', ?)`,
        )
        .run(artifactDigest, FIXED_NOW)
      database
        .query(
          `INSERT INTO rulebook_versions (
             id, rulebook_id, version, status, content_digest, spec_version,
             provenance_json, created_at, published_at
           ) VALUES ('version-legacy', 'rulebook-legacy', '1.0', 'published', ?,
             'ts11@1.0.1', '{}', ?, ?)`,
        )
        .run(artifactDigest, FIXED_NOW, FIXED_NOW)

      const applied = applyMigrations(database, { now: () => FIXED_NOW })
      expect(applied.map((migration) => migration.version)).toEqual([
        '0006_credential_schema_documents',
        '0007_publication_events',
        '0011_webhook_delivery_outbox',
      ])
      expect(listAppliedMigrations(database)).toHaveLength(MIGRATIONS.length)

      // Existing frozen content and metadata are byte-for-byte unchanged.
      const legacyVersion = database
        .query<{ content_digest: string; status: string }, []>(
          "SELECT content_digest, status FROM rulebook_versions WHERE id = 'version-legacy'",
        )
        .get()
      expect(legacyVersion).toEqual({ content_digest: artifactDigest, status: 'published' })
      const legacyArtifact = database
        .query<{ bytes: Uint8Array }, [string]>('SELECT bytes FROM artifacts WHERE digest = ?')
        .get(artifactDigest)
      expect(Array.from(legacyArtifact?.bytes ?? [])).toEqual([0x7b, 0x7d])

      const documentTable = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential_schema_documents'",
        )
        .get()
      expect(documentTable?.name).toBe('credential_schema_documents')

      // The new feed starts empty: migration never fabricates a publication
      // event for a version published before the feature existed.
      const eventTable = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publication_events'",
        )
        .get()
      expect(eventTable?.name).toBe('publication_events')
      expect(
        database
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM publication_events')
          .get()?.count,
      ).toBe(0)
    } finally {
      database.close()
    }
  })

  test('adds durable capture evidence, segregated artifacts and correlations', () => {
    const database = createDatabase()
    try {
      applyMigrations(database, { now: () => FIXED_NOW })
      expect(listAppliedMigrations(database).map((migration) => migration.version)).toContain(
        '0012_capture_evidence',
      )

      const digest = 'a'.repeat(64)
      database
        .query(
          `INSERT INTO capture_evidence (
             capture_id, envelope_json, source_id, source_component, source_transport,
             source_description, received_at, captured_at_ms, submission_digest
           ) VALUES ('capture-1', '{}', 'mock-capture-issuer', 'capture-issuer', 'mock',
             'Deterministic local mock fixtures', ?, 0, ?)`,
        )
        .run(FIXED_NOW, digest)
      database
        .query(
          `INSERT INTO capture_evidence_artifacts (
             capture_id, media_type, encoding, byte_length, digest, bytes
           ) VALUES ('capture-1', 'application/json', 'utf8', 2, ?, X'00ff')`,
        )
        .run(digest)
      database
        .query(
          `INSERT INTO capture_correlations (capture_id, binding_json, validation_json, updated_at)
           VALUES ('capture-1', '{}', '{}', ?)`,
        )
        .run(FIXED_NOW)

      // The raw bytes are reachable only through the artifact table.
      const artifact = database
        .query<{ bytes: Uint8Array }, []>('SELECT bytes FROM capture_evidence_artifacts')
        .get()
      expect(Array.from(artifact?.bytes ?? [])).toEqual([0x00, 0xff])

      // A correlation is the one mutable row: upsert replaces both halves.
      database
        .query(
          `INSERT INTO capture_correlations (capture_id, binding_json, validation_json, updated_at)
           VALUES ('capture-1', '{"rulebookId":"r"}', '{"validationId":"v"}', ?)
           ON CONFLICT (capture_id) DO UPDATE SET
             binding_json = excluded.binding_json,
             validation_json = excluded.validation_json,
             updated_at = excluded.updated_at`,
        )
        .run('2026-01-02T00:00:00.000Z')
      const correlation = database
        .query<{ binding_json: string; updated_at: string }, []>(
          'SELECT binding_json, updated_at FROM capture_correlations',
        )
        .get()
      expect(correlation).toEqual({
        binding_json: '{"rulebookId":"r"}',
        updated_at: '2026-01-02T00:00:00.000Z',
      })

      // Evidence identity and normalized metadata are insert-once, including
      // `INSERT OR REPLACE`, which would otherwise cascade-delete the
      // correlation without firing a DELETE trigger.
      expect(() =>
        database
          .query(
            `INSERT OR REPLACE INTO capture_evidence (
               capture_id, envelope_json, source_id, source_component, source_transport,
               source_description, received_at, captured_at_ms, submission_digest
             ) VALUES ('capture-1', '{"changed":true}', 'mock-capture-issuer', 'capture-issuer',
               'mock', 'Deterministic local mock fixtures', ?, 1, ?)`,
          )
          .run(FIXED_NOW, 'b'.repeat(64)),
      ).toThrow(/already exists/)
      expect(() =>
        database.query("UPDATE capture_evidence SET received_at = 'changed'").run(),
      ).toThrow(/immutable/)

      // Closed enumerations and orphan rows are rejected by the schema.
      expect(() =>
        database
          .query(
            `INSERT INTO capture_evidence (
               capture_id, envelope_json, source_id, source_component, source_transport,
               source_description, received_at, captured_at_ms, submission_digest
             ) VALUES ('capture-2', '{}', 'source', 'capture-issuer', 'live', 'source', ?, 0, ?)`,
          )
          .run(FIXED_NOW, digest),
      ).toThrow(/CHECK/)
      expect(() =>
        database
          .query(
            `INSERT INTO capture_evidence_artifacts (
               capture_id, media_type, encoding, byte_length, digest, bytes
             ) VALUES ('missing', 'application/json', 'utf8', 0, ?, X'')`,
          )
          .run(digest),
      ).toThrow(/FOREIGN KEY/i)
      expect(() =>
        database
          .query(
            `INSERT INTO capture_correlations (capture_id, binding_json, validation_json, updated_at)
             VALUES ('missing', '{}', '{}', ?)`,
          )
          .run(FIXED_NOW),
      ).toThrow(/FOREIGN KEY/i)
    } finally {
      database.close()
    }
  })
})
