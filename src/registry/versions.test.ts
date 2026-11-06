import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { provisionProvider } from './bootstrap'
import { sha256Hex } from './digest'
import { isRegistryError, RegistryError, type RegistryErrorCode } from './errors'
import { Registry } from './registry'
import { createRegistryFixture, openMigratedDatabase, type RegistryFixture } from './test-support'
import {
  RULEBOOK_VERSION_FORMAT,
  RULEBOOK_VERSION_MEDIA_TYPE,
  type RulebookVersionDocument,
} from './versioning'
import type { JsonObject, Rulebook } from './types'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup(): RegistryFixture {
  fixture = createRegistryFixture()
  return fixture
}

function expectRegistryError(action: () => unknown, code: RegistryErrorCode): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RegistryError)
  expect(isRegistryError(caught) ? caught.code : undefined).toBe(code)
}

function provision(suffix: string) {
  if (fixture === undefined) {
    throw new Error('test fixture is not initialized')
  }
  return provisionProvider(fixture.database, {
    name: `Provider ${suffix}`,
    publicationAuthority: `account-${suffix}`,
  })
}

/** Creates a rulebook with attestation types, an attestation schema and a rulebook-level schema. */
function createSeedRulebook(registry: Registry, token: string): Rulebook {
  const rulebook = registry.createRulebook(token, {
    name: 'PID Rulebook',
    description: 'Person Identification Data',
    sourceUrl: 'https://example.org/catalog/pid',
    applicableSpec: 'ts11@1.0.1',
    provenance: { importedFrom: 'fixture', vendor: 'example' },
    attestations: [
      {
        name: 'PID',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
      },
      { name: 'EHIC', attestationLoS: 'iso_18045_moderate', bindingType: 'key' },
    ],
  })
  const [pid] = registry.listAttestations(rulebook.id)
  if (pid === undefined) {
    throw new Error('expected the created attestation')
  }
  registry.addSchemaReference(token, rulebook.id, {
    formatIdentifier: 'dc+sd-jwt',
    uri: 'https://example.org/schemas/pid.json',
    integrity: 'sha256-abc123',
    attestationId: pid.id,
  })
  registry.addSchemaReference(token, rulebook.id, {
    formatIdentifier: 'vc+sd-jwt',
    uri: 'https://example.org/schemas/rulebook.json',
  })
  return rulebook
}

function parseSnapshot(content: { bytes: Uint8Array }): RulebookVersionDocument {
  return JSON.parse(Buffer.from(content.bytes).toString('utf8')) as RulebookVersionDocument
}

function readAudit(action: string) {
  if (fixture === undefined) {
    throw new Error('test fixture is not initialized')
  }
  return fixture.database
    .query<{ action: string; detail_json: string | null }, [string]>(
      'SELECT action, detail_json FROM audit_log WHERE action = ? ORDER BY id',
    )
    .all(action)
}

describe('rulebook version snapshots', () => {
  test('creates a deterministic draft version with digest, provenance and exact bytes', () => {
    const { registry, database } = setup()
    const { token } = provision('a')
    const rulebook = createSeedRulebook(registry, token.secret)

    const version = registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })

    expect(version.status).toBe('draft')
    expect(version.publishedAt).toBeNull()
    expect(version.specVersion).toBe('ts11@1.0.1')
    expect(version.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(version.provenance).toEqual(rulebook.provenance)
    expect(registry.getRulebookVersion(rulebook.id, '1.0')).toEqual(version)
    expect(registry.listRulebookVersions(rulebook.id)).toEqual([version])

    const content = registry.getRulebookVersionContent(rulebook.id, '1.0')
    expect(content).not.toBeNull()
    if (content === null) {
      throw new Error('expected the stored version content')
    }
    expect(content.mediaType).toBe(RULEBOOK_VERSION_MEDIA_TYPE)
    expect(sha256Hex(content.bytes)).toBe(version.contentDigest)

    const snapshot = parseSnapshot(content)
    const expectedSnapshot: RulebookVersionDocument = {
      format: RULEBOOK_VERSION_FORMAT,
      rulebookId: rulebook.id,
      version: '1.0',
      specVersion: 'ts11@1.0.1',
      name: 'PID Rulebook',
      description: 'Person Identification Data',
      sourceUrl: 'https://example.org/catalog/pid',
      attestations: [
        {
          name: 'PID',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [
            {
              formatIdentifier: 'dc+sd-jwt',
              uri: 'https://example.org/schemas/pid.json',
              integrity: 'sha256-abc123',
            },
          ],
        },
        {
          name: 'EHIC',
          attestationLoS: 'iso_18045_moderate',
          bindingType: 'key',
          supportedFormats: [],
          schemaReferences: [],
        },
      ],
      schemaReferences: [
        {
          formatIdentifier: 'vc+sd-jwt',
          uri: 'https://example.org/schemas/rulebook.json',
          integrity: null,
        },
      ],
    }
    expect(snapshot).toEqual(expectedSnapshot)

    // Pin the exact snapshot bytes (including field order), not just the
    // parsed value: a serializer change must break this test on purpose.
    const expectedBytes = Buffer.from(JSON.stringify(expectedSnapshot), 'utf8')
    expect(Buffer.from(content.bytes).toString('utf8')).toBe(expectedBytes.toString('utf8'))
    expect(version.contentDigest).toBe(sha256Hex(expectedBytes))

    expect(registry.verifyRulebookVersionDigest(rulebook.id, '1.0')).toEqual({
      version,
      expectedDigest: version.contentDigest,
      actualDigest: version.contentDigest,
      verified: true,
    })

    const artifacts = database
      .query<{ digest: string; media_type: string; bytes: Uint8Array }, []>(
        'SELECT digest, media_type, bytes FROM artifacts',
      )
      .all()
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.digest).toBe(version.contentDigest)
    expect(artifacts[0]?.media_type).toBe(RULEBOOK_VERSION_MEDIA_TYPE)
    expect(sha256Hex(artifacts[0]?.bytes ?? new Uint8Array())).toBe(version.contentDigest)

    const audit = readAudit('version.create')
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0]?.detail_json ?? '{}')).toMatchObject({
      rulebookId: rulebook.id,
      version: '1.0',
      contentDigest: version.contentDigest,
      specVersion: 'ts11@1.0.1',
    })
  })

  test('uses the supplied version provenance and keeps public reads token-free', () => {
    const { registry } = setup()
    const { token } = provision('a')
    const rulebook = createSeedRulebook(registry, token.secret)

    registry.createRulebookVersion(token.secret, rulebook.id, {
      version: '2.0',
      provenance: { importedFrom: 'remote-json', fetchedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(registry.getRulebookVersion(rulebook.id, '2.0')?.provenance).toEqual({
      importedFrom: 'remote-json',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    })

    // Every version read is public: no token is accepted or required.
    expect(registry.listRulebookVersions(rulebook.id)).toHaveLength(1)
    expect(registry.getRulebookVersionContent(rulebook.id, '2.0')).not.toBeNull()
    expect(registry.verifyRulebookVersionDigest(rulebook.id, '2.0')?.verified).toBe(true)
  })

  test('rejects duplicate and malformed version labels as typed errors', () => {
    const { registry } = setup()
    const { token } = provision('a')
    const rulebook = registry.createRulebook(token.secret, {
      name: 'Labels',
      applicableSpec: 'ts11@1.0.1',
    })

    registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })
    expectRegistryError(
      () => registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' }),
      'conflict',
    )

    for (const candidate of ['v1.0', '1', '1.0.0.0', '01.0', '1.0-beta', '1.0.0-rc.1']) {
      expectRegistryError(
        () => registry.createRulebookVersion(token.secret, rulebook.id, { version: candidate }),
        'invalid_input',
      )
    }
    expectRegistryError(
      () =>
        registry.createRulebookVersion(token.secret, rulebook.id, {
          version: '2.0',
          provenance: [] as unknown as JsonObject,
        }),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.createRulebookVersion(token.secret, 'missing-rulebook', { version: '1.0' }),
      'not_found',
    )
    expect(() =>
      registry.createRulebookVersion(
        token.secret,
        rulebook.id,
        null as unknown as { version: string },
      ),
    ).toThrow()

    expect(registry.listRulebookVersions(rulebook.id)).toHaveLength(1)
  })

  test('refreshes a draft snapshot and deduplicates identical bytes', () => {
    const { registry, database } = setup()
    const { token } = provision('a')
    const rulebook = createSeedRulebook(registry, token.secret)
    const draft = registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })

    // Unchanged content is a no-op: same digest, no second artifact, no audit.
    expect(registry.refreshDraftRulebookVersion(token.secret, rulebook.id, '1.0')).toEqual(draft)
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM artifacts').get()?.count,
    ).toBe(1)
    expect(readAudit('version.refresh')).toHaveLength(0)

    registry.addAttestation(token.secret, rulebook.id, {
      name: 'Residence Permit',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
    })
    const refreshed = registry.refreshDraftRulebookVersion(token.secret, rulebook.id, '1.0')
    expect(refreshed.status).toBe('draft')
    expect(refreshed.contentDigest).not.toBe(draft.contentDigest)
    expect(refreshed.id).toBe(draft.id)
    expect(refreshed.publishedAt).toBeNull()

    const content = registry.getRulebookVersionContent(rulebook.id, '1.0')
    if (content === null) {
      throw new Error('expected the refreshed content')
    }
    expect(parseSnapshot(content).attestations.map((attestation) => attestation.name)).toEqual([
      'PID',
      'EHIC',
      'Residence Permit',
    ])
    expect(sha256Hex(content.bytes)).toBe(refreshed.contentDigest)
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM artifacts').get()?.count,
    ).toBe(2)

    const refreshAudit = readAudit('version.refresh')
    expect(refreshAudit).toHaveLength(1)
    expect(JSON.parse(refreshAudit[0]?.detail_json ?? '{}')).toMatchObject({
      version: '1.0',
      previousDigest: draft.contentDigest,
      contentDigest: refreshed.contentDigest,
    })

    expectRegistryError(
      () => registry.refreshDraftRulebookVersion(token.secret, rulebook.id, '9.9'),
      'not_found',
    )
  })
})

describe('publication lifecycle and immutability', () => {
  test('publishes a draft version and freezes it in the service and the database', () => {
    const { registry, database } = setup()
    const { token } = provision('a')
    const rulebook = createSeedRulebook(registry, token.secret)
    const draft = registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })

    const published = registry.publishRulebookVersion(token.secret, rulebook.id, '1.0')
    const publishedAt = published.publishedAt
    if (publishedAt === null) {
      throw new Error('expected a publication timestamp')
    }
    expect(published.status).toBe('published')
    expect(published.contentDigest).toBe(draft.contentDigest)
    expect(registry.getRulebookVersion(rulebook.id, '1.0')).toEqual(published)
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('published')
    expect(registry.getRulebook(rulebook.id)?.updatedAt).toBe(publishedAt)

    const audit = readAudit('version.publish')
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0]?.detail_json ?? '{}')).toMatchObject({
      rulebookId: rulebook.id,
      version: '1.0',
      contentDigest: published.contentDigest,
      specVersion: 'ts11@1.0.1',
      supersededVersions: [],
    })

    // The snapshot bytes survive publication unchanged and still verify.
    expect(registry.verifyRulebookVersionDigest(rulebook.id, '1.0')?.verified).toBe(true)

    // Service-level immutability.
    expectRegistryError(
      () => registry.publishRulebookVersion(token.secret, rulebook.id, '1.0'),
      'immutable',
    )
    expectRegistryError(
      () => registry.refreshDraftRulebookVersion(token.secret, rulebook.id, '1.0'),
      'immutable',
    )
    expectRegistryError(
      () => registry.updateRulebook(token.secret, rulebook.id, { name: 'Changed' }),
      'immutable',
    )
    expectRegistryError(() => registry.deleteRulebook(token.secret, rulebook.id), 'immutable')
    expectRegistryError(
      () =>
        registry.addAttestation(token.secret, rulebook.id, {
          name: 'New',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
        }),
      'immutable',
    )

    // Database-level immutability: even a caller that bypasses the service
    // cannot overwrite the published content, the provenance or the row.
    expect(() =>
      database
        .query('UPDATE rulebook_versions SET content_digest = ? WHERE id = ?')
        .run('0'.repeat(64), published.id),
    ).toThrow(/immutable/i)
    expect(() =>
      database
        .query("UPDATE rulebook_versions SET provenance_json = '{}' WHERE id = ?")
        .run(published.id),
    ).toThrow(/immutable/i)
    expect(() =>
      database
        .query("UPDATE rulebook_versions SET status = 'draft' WHERE id = ?")
        .run(published.id),
    ).toThrow(/immutable/i)
    expect(() =>
      database.query('DELETE FROM rulebook_versions WHERE id = ?').run(published.id),
    ).toThrow(/immutable/i)
    expect(() =>
      database
        .query("UPDATE artifacts SET bytes = 'tampered' WHERE digest = ?")
        .run(published.contentDigest),
    ).toThrow(/immutable/i)
    expect(() =>
      database.query('DELETE FROM artifacts WHERE digest = ?').run(published.contentDigest),
    ).toThrow(/immutable/i)

    // REPLACE resolves SQLite conflicts by deleting the replaced row without
    // firing DELETE triggers, so identity re-inserts are rejected before that.
    expect(() =>
      database
        .query(
          `INSERT OR REPLACE INTO rulebook_versions (
            id, rulebook_id, version, status, content_digest, spec_version,
            provenance_json, created_at, published_at
          ) VALUES (?, ?, '1.0', 'published', ?, 'ts11@1.0.1', '{"x":1}', ?, ?)`,
        )
        .run(
          published.id,
          rulebook.id,
          published.contentDigest,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ),
    ).toThrow(/identity already exists/i)
    expect(() =>
      database
        .query(
          `INSERT OR REPLACE INTO artifacts (digest, media_type, bytes, created_at)
           VALUES (?, 'application/json', X'00', '2026-01-01T00:00:00.000Z')`,
        )
        .run(published.contentDigest),
    ).toThrow(/artifact digest already exists/i)
    // Deleting the parent cascades to versions, and the version DELETE trigger
    // aborts the whole statement.
    expect(() => database.query('DELETE FROM rulebooks WHERE id = ?').run(rulebook.id)).toThrow(
      /immutable/i,
    )

    // The only permitted transition is published -> historical.
    expect(() =>
      database
        .query(
          "UPDATE rulebook_versions SET status = 'historical' WHERE id = ? AND status = 'published'",
        )
        .run(published.id),
    ).not.toThrow()
    expect(() =>
      database
        .query('UPDATE rulebook_versions SET content_digest = ? WHERE id = ?')
        .run('1'.repeat(64), published.id),
    ).toThrow(/immutable/i)
    expect(() =>
      database.query('DELETE FROM rulebook_versions WHERE id = ?').run(published.id),
    ).toThrow(/immutable/i)
  })

  test('rejects publishing a leftover draft while the rulebook is published', () => {
    const { registry } = setup()
    const { token } = provision('a')
    const rulebook = createSeedRulebook(registry, token.secret)
    registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })
    registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.1' })
    registry.publishRulebookVersion(token.secret, rulebook.id, '1.1')

    expectRegistryError(
      () => registry.publishRulebookVersion(token.secret, rulebook.id, '1.0'),
      'immutable',
    )
    expect(registry.getRulebookVersion(rulebook.id, '1.1')?.status).toBe('published')

    // Creating the next version reopens the working copy; only then can the
    // leftover draft transition to published.
    registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.2' })
    const published = registry.publishRulebookVersion(token.secret, rulebook.id, '1.0')
    expect(published.status).toBe('published')
    expect(registry.getRulebookVersion(rulebook.id, '1.1')?.status).toBe('historical')
  })

  test('publishing a newer version supersedes the previous one and reopens the rulebook', () => {
    const { registry } = setup()
    const { token } = provision('a')
    const rulebook = createSeedRulebook(registry, token.secret)

    registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })
    const first = registry.publishRulebookVersion(token.secret, rulebook.id, '1.0')

    // Authoring the next version reopens the working copy...
    const secondDraft = registry.createRulebookVersion(token.secret, rulebook.id, {
      version: '2.0',
    })
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('draft')
    expect(registry.getRulebookVersion(rulebook.id, '1.0')?.status).toBe('published')

    // ... while the previous published version stays immutable.
    expectRegistryError(
      () => registry.refreshDraftRulebookVersion(token.secret, rulebook.id, '1.0'),
      'immutable',
    )

    registry.updateRulebook(token.secret, rulebook.id, { name: 'PID Rulebook v2' })

    // Publishing a snapshot that no longer matches the draft content is refused.
    expectRegistryError(
      () => registry.publishRulebookVersion(token.secret, rulebook.id, '2.0'),
      'conflict',
    )

    const refreshed = registry.refreshDraftRulebookVersion(token.secret, rulebook.id, '2.0')
    expect(refreshed.contentDigest).not.toBe(secondDraft.contentDigest)

    const second = registry.publishRulebookVersion(token.secret, rulebook.id, '2.0')
    expect(second.status).toBe('published')
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('published')

    const historical = registry.getRulebookVersion(rulebook.id, '1.0')
    expect(historical).not.toBeNull()
    if (historical === null) {
      throw new Error('expected the superseded version')
    }
    expect(historical.status).toBe('historical')
    expect(historical.publishedAt).toBe(first.publishedAt)
    expect(historical.contentDigest).toBe(first.contentDigest)

    // Both versions remain retrievable by identity and by digest.
    expect(registry.findRulebookVersionsByDigest(first.contentDigest)).toEqual([historical])
    expect(registry.findRulebookVersionsByDigest(second.contentDigest)).toEqual([second])
    expect(registry.verifyRulebookVersionDigest(rulebook.id, '1.0')?.verified).toBe(true)

    const audit = readAudit('version.publish')
    expect(audit).toHaveLength(2)
    expect(JSON.parse(audit[1]?.detail_json ?? '{}')).toMatchObject({
      version: '2.0',
      supersededVersions: ['1.0'],
    })

    // A superseded (historical) version is never mutable again.
    expectRegistryError(
      () => registry.publishRulebookVersion(token.secret, rulebook.id, '1.0'),
      'immutable',
    )
    expectRegistryError(
      () => registry.refreshDraftRulebookVersion(token.secret, rulebook.id, '1.0'),
      'immutable',
    )
  })

  test('refuses to delete a rulebook whose published versions would be destroyed', () => {
    const { registry } = setup()
    const { token } = provision('a')
    const rulebook = createSeedRulebook(registry, token.secret)

    registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })
    registry.publishRulebookVersion(token.secret, rulebook.id, '1.0')
    registry.createRulebookVersion(token.secret, rulebook.id, { version: '2.0' })

    // The working copy is a draft, but the published 1.0 row must survive.
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('draft')
    expectRegistryError(() => registry.deleteRulebook(token.secret, rulebook.id), 'immutable')
    expect(registry.getRulebook(rulebook.id)).not.toBeNull()
  })

  test('rejects unauthorized version mutations while keeping reads public', () => {
    const { registry } = setup()
    const owner = provision('owner')
    const stranger = provision('stranger')
    const rulebook = createSeedRulebook(registry, owner.token.secret)
    const draft = registry.createRulebookVersion(owner.token.secret, rulebook.id, {
      version: '1.0',
    })

    // No token, an unknown token and a revoked token are all unauthorized.
    expectRegistryError(
      () => registry.createRulebookVersion('', rulebook.id, { version: '2.0' }),
      'unauthorized',
    )
    expectRegistryError(
      () => registry.createRulebookVersion('att_unknown', rulebook.id, { version: '2.0' }),
      'unauthorized',
    )
    const revoked = registry.issueToken(owner.token.secret, 'revoked')
    registry.revokeToken(owner.token.secret, revoked.id)
    expectRegistryError(
      () => registry.createRulebookVersion(revoked.secret, rulebook.id, { version: '2.0' }),
      'unauthorized',
    )
    expectRegistryError(
      () => registry.refreshDraftRulebookVersion(revoked.secret, rulebook.id, '1.0'),
      'unauthorized',
    )
    expectRegistryError(
      () => registry.publishRulebookVersion(revoked.secret, rulebook.id, '1.0'),
      'unauthorized',
    )

    // Another provider can read the catalogue but cannot mutate the versions.
    expectRegistryError(
      () => registry.createRulebookVersion(stranger.token.secret, rulebook.id, { version: '2.0' }),
      'forbidden',
    )
    expectRegistryError(
      () => registry.refreshDraftRulebookVersion(stranger.token.secret, rulebook.id, '1.0'),
      'forbidden',
    )
    expectRegistryError(
      () => registry.publishRulebookVersion(stranger.token.secret, rulebook.id, '1.0'),
      'forbidden',
    )

    expect(registry.listRulebookVersions(rulebook.id)).toEqual([draft])
    expect(registry.getRulebookVersion(rulebook.id, '1.0')).toEqual(draft)
    expect(registry.getRulebookVersionContent(rulebook.id, '1.0')).not.toBeNull()
    expect(registry.verifyRulebookVersionDigest(rulebook.id, '1.0')?.verified).toBe(true)
    expect(registry.findRulebookVersionsByDigest(draft.contentDigest)).toEqual([draft])
    expect(registry.getRulebookVersion(rulebook.id, '2.0')).toBeNull()
  })

  test('rejects malformed version identifiers and digests on reads', () => {
    const { registry } = setup()
    const { token } = provision('a')
    const rulebook = createSeedRulebook(registry, token.secret)
    registry.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })

    expectRegistryError(() => registry.listRulebookVersions(''), 'invalid_input')
    expectRegistryError(() => registry.getRulebookVersion(rulebook.id, 'latest'), 'invalid_input')
    expectRegistryError(
      () => registry.findRulebookVersionsByDigest('not-a-digest'),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.findRulebookVersionsByDigest('A'.repeat(64)),
      'invalid_input',
    )

    expect(registry.getRulebookVersionContent(rulebook.id, '9.9')).toBeNull()
    expect(registry.verifyRulebookVersionDigest(rulebook.id, '9.9')).toBeNull()
    expect(registry.findRulebookVersionsByDigest('f'.repeat(64))).toEqual([])
  })
})

describe('version persistence', () => {
  test('persists versions, artifacts and published immutability across a reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'attestbook-versions-reopen-'))
    const databasePath = join(directory, 'attestbook.sqlite')
    let database = openMigratedDatabase(databasePath)

    try {
      const first = new Registry({ database })
      const { token } = provisionProvider(database, {
        name: 'Persistent Provider',
        publicationAuthority: 'account-persistent',
      })
      const rulebook = first.createRulebook(token.secret, {
        name: 'Persistent Rulebook',
        applicableSpec: 'ts11@1.0.1',
      })
      const draft = first.createRulebookVersion(token.secret, rulebook.id, { version: '1.0' })
      const published = first.publishRulebookVersion(token.secret, rulebook.id, '1.0')
      const bytes = first.getRulebookVersionContent(rulebook.id, '1.0')?.bytes

      database.close()
      database = openMigratedDatabase(databasePath)
      const second = new Registry({ database })

      expect(second.getRulebookVersion(rulebook.id, '1.0')).toEqual(published)
      expect(second.listRulebookVersions(rulebook.id)).toEqual([published])
      expect(second.getRulebookVersionContent(rulebook.id, '1.0')?.bytes).toEqual(bytes)
      expect(second.verifyRulebookVersionDigest(rulebook.id, '1.0')).toEqual({
        version: published,
        expectedDigest: draft.contentDigest,
        actualDigest: draft.contentDigest,
        verified: true,
      })
      expect(() =>
        database
          .query('UPDATE rulebook_versions SET content_digest = ? WHERE id = ?')
          .run('2'.repeat(64), published.id),
      ).toThrow(/immutable/i)
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
