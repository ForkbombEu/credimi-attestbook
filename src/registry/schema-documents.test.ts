import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { provisionProvider } from './bootstrap'
import { sha256Hex } from './digest'
import { isRegistryError, RegistryError, type RegistryErrorCode } from './errors'
import { Registry } from './registry'
import {
  MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES,
  MAX_CREDENTIAL_SCHEMA_DOCUMENTS_PER_PROVIDER,
} from './schema-documents'
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

async function expectRegistryError(action: () => unknown, code: RegistryErrorCode): Promise<void> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RegistryError)
  expect(isRegistryError(caught) ? caught.code : undefined).toBe(code)
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  return caught
}

/** A schema that is small enough to store but expensive for Ajv to compile. */
function expensiveJsonSchema(): Uint8Array {
  let schema: unknown = { type: 'object' }
  for (let level = 0; level < 8; level += 1) {
    schema = { if: schema, then: schema, else: schema }
  }
  return encodeJson(schema)
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
  test('persists an immutable JSON Schema document with its exact bytes, digest and provenance', async () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const bytes = encodeJson(JSON_SCHEMA)

    const document = await registry.registerCredentialSchemaDocument(provider.actor, {
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

  test('supports SD-JWT VC Type Metadata with its canonical media type', async () => {
    const { registry } = setup()
    const provider = provision('one')
    const bytes = encodeJson(TYPE_METADATA)

    const document = await registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'sd_jwt_vc_type_metadata',
      bytes,
    })

    expect(document.kind).toBe('sd_jwt_vc_type_metadata')
    expect(document.mediaType).toBe('application/json')
    expect(document.contentDigest).toBe(sha256Hex(bytes))
    expect(registry.getCredentialSchemaDocumentContent(document.id)?.bytes).toEqual(bytes)
  })

  test('accepts a boolean JSON Schema document as exact bytes', async () => {
    const { registry } = setup()
    const provider = provision('one')
    const bytes = new TextEncoder().encode('true')

    const document = await registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes,
    })

    expect(document.contentDigest).toBe(sha256Hex(bytes))
    expect(registry.getCredentialSchemaDocumentContent(document.id)?.bytes).toEqual(bytes)
  })

  test('is idempotent for the same provider and content and stores the bytes once', async () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const bytes = encodeJson(JSON_SCHEMA)

    const first = await registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes,
      provenance: { source: 'first' },
    })
    const second = await registry.registerCredentialSchemaDocument(provider.actor, {
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

  test('deduplicates content across providers while keeping ownership separate', async () => {
    const { registry, database } = setup()
    const first = provision('one')
    const second = provision('two')
    const bytes = encodeJson(JSON_SCHEMA)

    const firstDocument = await registry.registerCredentialSchemaDocument(first.actor, {
      kind: 'json_schema_2020_12',
      bytes,
      provenance: { owner: 'one' },
    })
    const secondDocument = await registry.registerCredentialSchemaDocument(second.actor, {
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

  test('rejects the same content under another schema profile for a provider', async () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const bytes = encodeJson(JSON_SCHEMA)

    await registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes,
    })
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'sd_jwt_vc_type_metadata',
          bytes,
        }),
      'conflict',
    )
    expect(documentCount(database)).toBe(1)
  })

  test('rejects the same content registered with another media type by another provider', async () => {
    const { registry, database } = setup()
    const first = provision('one')
    const second = provision('two')
    const bytes = encodeJson(JSON_SCHEMA)

    await registry.registerCredentialSchemaDocument(first.actor, {
      kind: 'json_schema_2020_12',
      bytes,
    })
    await expectRegistryError(
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

  test('keeps document associations immutable even through direct SQL', async () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const document = await registry.registerCredentialSchemaDocument(provider.actor, {
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

  test('rejects an expected digest that does not match the exact bytes', async () => {
    const { registry, database } = setup()
    const provider = provision('one')

    await expectRegistryError(
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

  test('detects a hash collision or corrupted artifact before associating bytes', async () => {
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

    const caught = await captureError(() =>
      registry.registerCredentialSchemaDocument(provider.actor, {
        kind: 'json_schema_2020_12',
        bytes,
      }),
    )
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/do not match their content digest/)
    expect(documentCount(database)).toBe(0)
  })

  test('reports a digest mismatch when stored bytes are verified', async () => {
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

    const valid = await registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes: encodeJson(JSON_SCHEMA),
    })
    expect(registry.verifyCredentialSchemaDocumentDigest(valid.id)?.verified).toBe(true)
  })

  test('rejects malformed, non-UTF-8, oversized and deeply nested bytes', async () => {
    const { registry, database } = setup()
    const provider = provision('one')

    const invalidDocuments: Uint8Array[] = [
      new TextEncoder().encode('{'),
      new TextEncoder().encode(''),
      new TextEncoder().encode('{"type":"object","type":"string"}'),
      new TextEncoder().encode('{"\\u0074ype":"object","type":"string"}'),
      // The duplicate scanner must bound the text it walks even when the
      // collapsed parsed value is shallow.
      new TextEncoder().encode(`{"hidden": ${'['.repeat(70)}${']'.repeat(70)}, "hidden": 1}`),
      new Uint8Array([0xff, 0xfe, 0xfd]),
      new Uint8Array(MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES + 1),
    ]
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 70; depth += 1) {
      nested = { nested }
    }
    invalidDocuments.push(encodeJson(nested))

    for (const bytes of invalidDocuments) {
      await expectRegistryError(
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

  test('rejects malformed and unsupported document profiles', async () => {
    const { registry } = setup()
    const provider = provision('one')

    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'not-a-kind' as CredentialSchemaKind,
          bytes: encodeJson(JSON_SCHEMA),
        }),
      'invalid_input',
    )
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson({ $schema: 'https://json-schema.org/draft/2019-09/schema' }),
        }),
      'invalid_input',
    )
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson({ $ref: 'https://example.org/schema.json' }),
        }),
      'invalid_input',
    )
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson({ type: 'not-a-json-schema-type' }),
        }),
      'invalid_input',
    )
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson({ 'x-custom': 1 }),
        }),
      'invalid_input',
    )
    for (const document of [[], null, 'schema', 42]) {
      await expectRegistryError(
        () =>
          registry.registerCredentialSchemaDocument(provider.actor, {
            kind: 'json_schema_2020_12',
            bytes: encodeJson(document),
          }),
        'invalid_input',
      )
      await expectRegistryError(
        () =>
          registry.registerCredentialSchemaDocument(provider.actor, {
            kind: 'sd_jwt_vc_type_metadata',
            bytes: encodeJson(document),
          }),
        'invalid_input',
      )
    }
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'sd_jwt_vc_type_metadata',
          bytes: encodeJson({ name: 'missing vct' }),
        }),
      'invalid_input',
    )
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'sd_jwt_vc_type_metadata',
          bytes: encodeJson({ vct: '   ' }),
        }),
      'invalid_input',
    )
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: '{}' as unknown as Uint8Array,
        }),
      'invalid_input',
    )
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: encodeJson(JSON_SCHEMA),
          provenance: [] as unknown as Record<string, never>,
        }),
      'invalid_input',
    )
  })

  test('rejects a schema that exceeds the compilation sandbox resource limits', async () => {
    const { database } = setup()
    const provider = provision('one')
    const restricted = new Registry({
      database,
      now: () => FIXED_NOW,
      schemaSandboxLimits: { timeoutMs: 200 },
    })

    await expectRegistryError(
      () =>
        restricted.registerCredentialSchemaDocument(provider.actor, {
          kind: 'json_schema_2020_12',
          bytes: expensiveJsonSchema(),
        }),
      'invalid_input',
    )
    expect(documentCount(database)).toBe(0)
    expect(artifactCount(database)).toBe(0)
  })

  test('keeps the server responsive while a schema compiles in the sandbox', async () => {
    const { registry } = setup()
    const provider = provision('one')

    const registration = registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes: expensiveJsonSchema(),
    })
    const started = performance.now()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(performance.now() - started).toBeLessThan(300)
    await registration.catch(() => undefined)
  })

  test('fails closed when the schema compilation sandbox is unavailable', async () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const unavailable = new Registry({
      database,
      now: () => FIXED_NOW,
      schemaSandboxLimits: { platform: 'darwin' },
    })

    const caught = await captureError(() =>
      unavailable.registerCredentialSchemaDocument(provider.actor, {
        kind: 'json_schema_2020_12',
        bytes: encodeJson(JSON_SCHEMA),
      }),
    )
    expect(caught).toBeInstanceOf(Error)
    expect(isRegistryError(caught)).toBe(false)
    expect(documentCount(database)).toBe(0)
    expect(artifactCount(database)).toBe(0)
    expect(registry.listCredentialSchemaDocuments()).toHaveLength(0)
  })

  test('returns the existing document when concurrent registrations race', async () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const bytes = encodeJson(JSON_SCHEMA)

    const [first, second] = await Promise.all([
      registry.registerCredentialSchemaDocument(provider.actor, {
        kind: 'json_schema_2020_12',
        bytes,
      }),
      registry.registerCredentialSchemaDocument(provider.actor, {
        kind: 'json_schema_2020_12',
        bytes,
      }),
    ])

    expect(second.id).toBe(first.id)
    expect(documentCount(database)).toBe(1)
    expect(artifactCount(database)).toBe(1)
    expect(auditCount(database)).toBe(1)
  })

  test('blocks provider deletion while it still owns a schema document', async () => {
    const { registry } = setup()
    const provider = provision('one')
    await registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'json_schema_2020_12',
      bytes: encodeJson(JSON_SCHEMA),
    })

    await expectRegistryError(() => registry.deleteProvider(provider.actor), 'conflict')
  })

  test('persists documents across a database reopen', async () => {
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
      const document = await registry.registerCredentialSchemaDocument(provider.actor, {
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

  test('bounds how many documents one provider may create', async () => {
    const { registry, database } = setup()
    const provider = provision('quota')
    const typeMetadata = (index: number) =>
      encodeJson({ vct: `https://example.org/vct/quota-${index}` })

    for (let index = 0; index < MAX_CREDENTIAL_SCHEMA_DOCUMENTS_PER_PROVIDER; index += 1) {
      await registry.registerCredentialSchemaDocument(provider.actor, {
        kind: 'sd_jwt_vc_type_metadata',
        bytes: typeMetadata(index),
      })
    }
    expect(documentCount(database)).toBe(MAX_CREDENTIAL_SCHEMA_DOCUMENTS_PER_PROVIDER)

    // A new document is refused once the provider owns the maximum.
    await expectRegistryError(
      () =>
        registry.registerCredentialSchemaDocument(provider.actor, {
          kind: 'sd_jwt_vc_type_metadata',
          bytes: typeMetadata(MAX_CREDENTIAL_SCHEMA_DOCUMENTS_PER_PROVIDER),
        }),
      'conflict',
    )
    expect(documentCount(database)).toBe(MAX_CREDENTIAL_SCHEMA_DOCUMENTS_PER_PROVIDER)

    // Replaying an existing provider/content registration stays idempotent.
    const existing = await registry.registerCredentialSchemaDocument(provider.actor, {
      kind: 'sd_jwt_vc_type_metadata',
      bytes: typeMetadata(0),
    })
    expect(existing.contentDigest).toBe(sha256Hex(typeMetadata(0)))
    expect(documentCount(database)).toBe(MAX_CREDENTIAL_SCHEMA_DOCUMENTS_PER_PROVIDER)

    // The bound is per provider: another provider starts with its own slots.
    const other = provision('quota-other')
    await registry.registerCredentialSchemaDocument(other.actor, {
      kind: 'sd_jwt_vc_type_metadata',
      bytes: typeMetadata(0),
    })
    expect(documentCount(database)).toBe(MAX_CREDENTIAL_SCHEMA_DOCUMENTS_PER_PROVIDER + 1)
  })
})
