import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { provisionProvider } from './bootstrap'
import { sha256Hex } from './digest'
import { isRegistryError, RegistryError, type RegistryErrorCode } from './errors'
import { Registry } from './registry'
import { MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES } from './schema-documents'
import { createRegistryFixture, openMigratedDatabase, type RegistryFixture } from './test-support'
import type { CredentialSchemaKind } from './types'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

const JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['family_name'],
  properties: {
    family_name: { type: 'string' },
  },
  additionalProperties: false,
}

const TYPE_METADATA = {
  vct: 'https://example.org/vct/pid',
  name: 'Person Identification Data',
  claims: [{ path: ['family_name'], mandatory: true }],
}

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup(): RegistryFixture {
  fixture = createRegistryFixture()
  return fixture
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
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

function artifactCount(database: RegistryFixture['database']): number {
  return (
    database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM artifacts').get()?.count ??
    0
  )
}

function documentCount(database: RegistryFixture['database']): number {
  return (
    database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM credential_schema_documents')
      .get()?.count ?? 0
  )
}

function auditCount(database: RegistryFixture['database']): number {
  return (
    database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'schema_document.create'",
      )
      .get()?.count ?? 0
  )
}

describe('credential schema documents', () => {
  test('persists an immutable JSON Schema document with its exact bytes, digest and provenance', () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const bytes = encodeJson(JSON_SCHEMA)

    const document = registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes,
      provenance: { source: 'operator', note: 'pid schema' },
    })

    expect(document.providerId).toBe(provider.provider.id)
    expect(document.kind).toBe('json_schema_2020_12')
    expect(document.mediaType).toBe('application/schema+json')
    expect(document.contentDigest).toBe(sha256Hex(bytes))
    expect(document.provenance).toEqual({ source: 'operator', note: 'pid schema' })
    expect(document.createdAt).toBe(FIXED_NOW)

    const content = registry.getCredentialSchemaDocumentContent(document.id)
    expect(content?.document).toEqual(document)
    expect(content?.bytes).toEqual(bytes)
    expect(registry.getCredentialSchemaDocument(document.id)).toEqual(document)

    const artifact = database
      .query<{ media_type: string; bytes: Uint8Array }, [string]>(
        'SELECT media_type, bytes FROM artifacts WHERE digest = ?',
      )
      .get(document.contentDigest)
    expect(artifact?.media_type).toBe('application/schema+json')
    expect(artifact?.bytes).toEqual(bytes)
    expect(auditCount(database)).toBe(1)
  })

  test('supports SD-JWT VC Type Metadata with its canonical media type', () => {
    const { registry } = setup()
    const provider = provision('one')
    const bytes = encodeJson(TYPE_METADATA)

    const document = registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'sd_jwt_vc_type_metadata',
      bytes,
    })

    expect(document.kind).toBe('sd_jwt_vc_type_metadata')
    expect(document.mediaType).toBe('application/json')
    expect(document.contentDigest).toBe(sha256Hex(bytes))
    expect(registry.getCredentialSchemaDocumentContent(document.id)?.bytes).toEqual(bytes)
  })

  test('accepts a boolean JSON Schema document as exact bytes', () => {
    const { registry } = setup()
    const provider = provision('one')
    const bytes = new TextEncoder().encode('true')

    const document = registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes,
    })

    expect(document.contentDigest).toBe(sha256Hex(bytes))
    expect(registry.getCredentialSchemaDocumentContent(document.id)?.bytes).toEqual(bytes)
  })

  test('is idempotent for the same provider and content and stores the bytes once', () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const bytes = encodeJson(JSON_SCHEMA)

    const first = registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes,
      provenance: { source: 'first' },
    })
    const second = registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes,
      provenance: { source: 'second' },
    })

    expect(second).toEqual(first)
    expect(second.provenance).toEqual({ source: 'first' })
    expect(documentCount(database)).toBe(1)
    expect(artifactCount(database)).toBe(1)
    expect(auditCount(database)).toBe(1)
  })

  test('deduplicates content across providers while keeping ownership separate', () => {
    const { registry, database } = setup()
    const first = provision('one')
    const second = provision('two')
    const bytes = encodeJson(JSON_SCHEMA)

    const firstDocument = registry.registerCredentialSchemaDocument(first.actor, {
      kind: 'json_schema_2020_12',
      bytes,
      provenance: { owner: 'one' },
    })
    const secondDocument = registry.registerCredentialSchemaDocument(second.actor, {
      kind: 'json_schema_2020_12',
      bytes,
      provenance: { owner: 'two' },
    })

    expect(secondDocument.id).not.toBe(firstDocument.id)
    expect(secondDocument.providerId).toBe(second.provider.id)
    expect(secondDocument.contentDigest).toBe(firstDocument.contentDigest)
    expect(artifactCount(database)).toBe(1)
    expect(documentCount(database)).toBe(2)
    expect(registry.listCredentialSchemaDocuments(first.provider.id)).toEqual([firstDocument])
    expect(registry.listCredentialSchemaDocuments(second.provider.id)).toEqual([secondDocument])
    expect(registry.getCredentialSchemaDocument(firstDocument.id)).toEqual(firstDocument)
    expect(registry.getCredentialSchemaDocument(secondDocument.id)).toEqual(secondDocument)
  })

  test('rejects the same content under another schema profile for a provider', () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const bytes = encodeJson(JSON_SCHEMA)

    registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes,
    })
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'sd_jwt_vc_type_metadata',
          bytes,
        }),
      'conflict',
    )
    expect(documentCount(database)).toBe(1)
  })

  test('rejects the same content registered with another media type by another provider', () => {
    const { registry, database } = setup()
    const first = provision('one')
    const second = provision('two')
    const bytes = encodeJson(JSON_SCHEMA)

    registry.registerCredentialSchemaDocument(first.actor, {
      kind: 'json_schema_2020_12',
      bytes,
    })
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(second.actor, {
          kind: 'sd_jwt_vc_type_metadata',
          bytes,
        }),
      'conflict',
    )
    expect(documentCount(database)).toBe(1)
    expect(artifactCount(database)).toBe(1)
  })

  test('keeps document associations immutable even through direct SQL', () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const document = registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes: encodeJson(JSON_SCHEMA),
    })

    expect(() =>
      database
        .query('UPDATE credential_schema_documents SET provenance_json = \'{"owner":"other"}\'')
        .run(),
    ).toThrow(/immutable/i)
    expect(() =>
      database.query('DELETE FROM credential_schema_documents WHERE id = ?').run(document.id),
    ).toThrow(/immutable/i)
    expect(() =>
      database
        .query(
          `INSERT OR REPLACE INTO credential_schema_documents
             (id, provider_id, content_digest, kind, media_type, provenance_json, created_at)
           VALUES (?, ?, ?, 'json_schema_2020_12', 'application/schema+json', '{}', ?)`,
        )
        .run(document.id, provider.provider.id, document.contentDigest, '2026-01-02T00:00:00.000Z'),
    ).toThrow(/identity already exists/i)

    expect(registry.getCredentialSchemaDocument(document.id)).toEqual(document)
  })

  test('rejects an expected digest that does not match the exact bytes', () => {
    const { registry, database } = setup()
    const provider = provision('one')

    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson(JSON_SCHEMA),
          expectedDigest: '0'.repeat(64),
        }),
      'invalid_input',
    )
    expect(documentCount(database)).toBe(0)
    expect(artifactCount(database)).toBe(0)
  })

  test('detects a hash collision or corrupted artifact before associating bytes', () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const bytes = encodeJson(JSON_SCHEMA)
    const digest = sha256Hex(bytes)

    // Simulate a corrupted/colliding store: the digest exists but the stored
    // bytes are different. Registration must not associate the document.
    database
      .query(
        `INSERT INTO artifacts (digest, media_type, bytes, created_at)
         VALUES (?, 'application/schema+json', ?, ?)`,
      )
      .run(digest, encodeJson({ type: 'object' }), FIXED_NOW)

    expect(() =>
      registry.registerCredentialSchemaDocument(provider.actor, {
        kind: 'json_schema_2020_12',
        bytes,
      }),
    ).toThrow(/do not match their content digest/)
    expect(documentCount(database)).toBe(0)
  })

  test('reports a digest mismatch when stored bytes are verified', () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const corruptBytes = encodeJson({ type: 'object' })
    const corruptDigest = sha256Hex(corruptBytes)

    database
      .query(
        `INSERT INTO artifacts (digest, media_type, bytes, created_at)
         VALUES (?, 'application/schema+json', ?, ?)`,
      )
      .run(corruptDigest, encodeJson({ type: 'array' }), FIXED_NOW)
    database
      .query(
        `INSERT INTO credential_schema_documents
           (id, provider_id, content_digest, kind, media_type, provenance_json, created_at)
         VALUES ('document-corrupt', ?, ?, 'json_schema_2020_12',
           'application/schema+json', '{}', ?)`,
      )
      .run(provider.provider.id, corruptDigest, FIXED_NOW)

    const verification = registry.verifyCredentialSchemaDocumentDigest('document-corrupt')
    expect(verification?.expectedDigest).toBe(corruptDigest)
    expect(verification?.actualDigest).toBe(sha256Hex(encodeJson({ type: 'array' })))
    expect(verification?.verified).toBe(false)
    expect(registry.verifyCredentialSchemaDocumentDigest('missing')).toBeNull()

    const valid = registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes: encodeJson(JSON_SCHEMA),
    })
    expect(registry.verifyCredentialSchemaDocumentDigest(valid.id)?.verified).toBe(true)
  })

  test('rejects malformed, non-UTF-8, oversized and deeply nested bytes', () => {
    const { registry, database } = setup()
    const provider = provision('one')

    const invalidDocuments: Uint8Array[] = [
      new TextEncoder().encode('{'),
      new TextEncoder().encode(''),
      new Uint8Array([0xff, 0xfe, 0xfd]),
      new Uint8Array(MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES + 1),
    ]
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 70; depth += 1) {
      nested = { nested }
    }
    invalidDocuments.push(encodeJson(nested))

    for (const bytes of invalidDocuments) {
      expectRegistryError(
        () =>
          registry.registerCredentialSchemaDocument(provider.actor, {
            kind: 'json_schema_2020_12',
            bytes,
          }),
        'invalid_input',
      )
    }
    expect(documentCount(database)).toBe(0)
    expect(artifactCount(database)).toBe(0)
  })

  test('rejects malformed and unsupported document profiles', () => {
    const { registry } = setup()
    const provider = provision('one')

    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'not-a-kind' as CredentialSchemaKind,
          bytes: encodeJson(JSON_SCHEMA),
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson({ $schema: 'https://json-schema.org/draft/2019-09/schema' }),
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson({ $ref: 'https://example.org/schema.json' }),
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson({ type: 'not-a-json-schema-type' }),
        }),
      'invalid_input',
    )
    for (const document of [[], null, 'schema', 42]) {
      expectRegistryError(
        () =>
          registry.registerCredentialSchemaDocument(provider.actor, {
            kind: 'json_schema_2020_12',
            bytes: encodeJson(document),
          }),
        'invalid_input',
      )
      expectRegistryError(
        () =>
          registry.registerCredentialSchemaDocument(provider.actor, {
            kind: 'sd_jwt_vc_type_metadata',
            bytes: encodeJson(document),
          }),
        'invalid_input',
      )
    }
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'sd_jwt_vc_type_metadata',
          bytes: encodeJson({ name: 'missing vct' }),
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'sd_jwt_vc_type_metadata',
          bytes: encodeJson({ vct: '   ' }),
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: '{}' as unknown as Uint8Array,
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson(JSON_SCHEMA),
          provenance: [] as unknown as Record<string, never>,
        }),
      'invalid_input',
    )
  })

  test('blocks provider deletion while it still owns a schema document', () => {
    const { registry } = setup()
    const provider = provision('one')
    registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes: encodeJson(JSON_SCHEMA),
    })

    expectRegistryError(() => registry.deleteProvider(provider.actor), 'conflict')
  })

  test('persists documents across a database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'attestbook-schema-documents-'))
    const databasePath = join(directory, 'attestbook.sqlite')
    try {
      const bytes = encodeJson(JSON_SCHEMA)
      let database = openMigratedDatabase(databasePath)
      let registry = new Registry({ database })
      const provider = provisionProvider(database, {
        name: 'Provider',
        publicationAuthority: 'account-persist',
      })
      const document = registry.registerCredentialSchemaDocument(provider.actor, {
        kind: 'json_schema_2020_12',
        bytes,
        provenance: { source: 'persist' },
      })
      database.close()

      database = openMigratedDatabase(databasePath)
      registry = new Registry({ database })
      const content = registry.getCredentialSchemaDocumentContent(document.id)
      expect(content?.bytes).toEqual(bytes)
      expect(content?.document).toEqual(document)
      expect(registry.verifyCredentialSchemaDocumentDigest(document.id)?.verified).toBe(true)
      database.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
