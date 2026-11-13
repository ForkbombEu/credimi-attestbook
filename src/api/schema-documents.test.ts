// HTTP and integration tests for hosted credential schema documents (issue
// #98). The tests exercise the real registry and a real temporary SQLite file
// through `app.request`, so the public route, its integrity headers, the
// configured-origin URL construction and restart persistence are the ones the
// server actually exposes.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import { provisionProvider } from '../registry/bootstrap'
import { sha256Hex } from '../registry/digest'
import { Registry } from '../registry/registry'
import {
  createRegistryFixture,
  openMigratedDatabase,
  type RegistryFixture,
} from '../registry/test-support'
import type { CredentialSchemaDocument } from '../registry/types'

import { API_ROUTES, MAX_API_BODY_BYTES } from './routes'
import { componentJsonSchema, type OpenApiComponentName } from './schemas'
import type { CredentialSchemaDocumentResource } from './schemas'

const PUBLIC_BASE_URL = 'https://schemas.example'

/** The exact registered JSON Schema bytes. */
const JSON_SCHEMA_TEXT =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["family_name"],"properties":{"family_name":{"type":"string"}}}'

/** The exact registered SD-JWT VC Type Metadata bytes. */
const TYPE_METADATA_TEXT =
  '{"vct":"https://example.org/vct/pid","name":"Person Identification Data","claims":[{"path":["family_name"],"mandatory":true}]}'

let fixture: RegistryFixture | undefined
let app: Hono
let providerId: string
let schemaDocument: CredentialSchemaDocument
let typeMetadataDocument: CredentialSchemaDocument
const schemaBytes = new TextEncoder().encode(JSON_SCHEMA_TEXT)
const typeMetadataBytes = new TextEncoder().encode(TYPE_METADATA_TEXT)

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const validators = new Map<string, ValidateFunction>()

function assertSchema(name: OpenApiComponentName, value: unknown): void {
  let validate = validators.get(name)
  if (validate === undefined) {
    validate = ajv.compile(componentJsonSchema(name))
    validators.set(name, validate)
  }
  expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true)
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function errorJson(response: Response): Promise<ErrorEnvelope> {
  return json<ErrorEnvelope>(response)
}

function documentCount(database: Database): number {
  return (
    database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM credential_schema_documents')
      .get()?.count ?? 0
  )
}

function contentPath(document: CredentialSchemaDocument): string {
  return `/api/v1/schema-documents/${document.id}/content`
}

beforeAll(async () => {
  fixture = createRegistryFixture()
  const provisioned = provisionProvider(fixture.database, {
    name: 'Hosted Schema Provider',
    publicationAuthority: 'hosted-schema-provider',
  })
  providerId = provisioned.provider.id
  schemaDocument = await fixture.registry.registerCredentialSchemaDocument(provisioned.actor, {
    kind: 'json_schema_2020_12',
    bytes: schemaBytes,
    provenance: { source: 'http-test' },
  })
  typeMetadataDocument = await fixture.registry.registerCredentialSchemaDocument(
    provisioned.actor,
    {
      kind: 'sd_jwt_vc_type_metadata',
      bytes: typeMetadataBytes,
      provenance: { source: 'http-test-type-metadata' },
    },
  )
  app = createApp({ registry: fixture.registry, publicBaseUrl: PUBLIC_BASE_URL })
})

afterAll(() => {
  fixture?.cleanup()
  fixture = undefined
})

describe('hosted schema content route', () => {
  test('returns the exact registered bytes without authentication', async () => {
    const response = await app.request(contentPath(schemaDocument))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(schemaBytes)
    expect(response.headers.get('content-type')).toBe('application/schema+json')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')

    const digest = sha256Hex(schemaBytes)
    expect(digest).toBe(schemaDocument.contentDigest)
    expect(response.headers.get('etag')).toBe(`"${digest}"`)
    expect(response.headers.get('content-digest')).toBe(
      `sha-256=:${Buffer.from(digest, 'hex').toString('base64')}:`,
    )
  })

  test('serves SD-JWT VC Type Metadata under its canonical JSON media type', async () => {
    const response = await app.request(contentPath(typeMetadataDocument))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(typeMetadataBytes)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('content-digest')).toBe(
      `sha-256=:${Buffer.from(typeMetadataDocument.contentDigest, 'hex').toString('base64')}:`,
    )
  })

  test('honours If-None-Match and sends no body on 304', async () => {
    const path = contentPath(schemaDocument)
    const first = await app.request(path)
    const etag = first.headers.get('etag')
    expect(etag).not.toBeNull()

    const conditional = await app.request(path, {
      headers: { 'if-none-match': etag ?? '' },
    })
    expect(conditional.status).toBe(304)
    expect(await conditional.text()).toBe('')
    expect(conditional.headers.get('etag')).toBe(etag)
    expect(conditional.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const weak = await app.request(path, { headers: { 'if-none-match': `W/${etag}` } })
    expect(weak.status).toBe(304)

    const star = await app.request(path, { headers: { 'if-none-match': '*' } })
    expect(star.status).toBe(304)

    const stale = await app.request(path, { headers: { 'if-none-match': '"stale"' } })
    expect(stale.status).toBe(200)
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(schemaBytes)
  })

  test('answers 404 for an unknown identifier without internal storage details', async () => {
    const response = await app.request('/api/v1/schema-documents/does-not-exist/content')
    expect(response.status).toBe(404)
    const body = await errorJson(response)
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe('The requested credential schema document does not exist.')
    expect(JSON.stringify(body)).not.toContain('artifact')
    expect(JSON.stringify(body)).not.toContain('SELECT')
  })

  test('rejects an oversized document identifier with a typed 400', async () => {
    const oversized = 'a'.repeat(1_000)
    const response = await app.request(`/api/v1/schema-documents/${oversized}/content`)
    expect(response.status).toBe(400)
    const body = await errorJson(response)
    expect(body.error.code).toBe('invalid_request')
  })

  test('the content route has no mutation method and no write replaces or deletes a document', async () => {
    if (fixture === undefined) {
      throw new Error('fixture is not initialized')
    }
    const before = documentCount(fixture.database)
    // The exact-bytes route is read-only: no method mutates one document.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await app.request(contentPath(schemaDocument), { method })
      expect([404, 405]).toContain(response.status)
    }
    expect(documentCount(fixture.database)).toBe(before)
    // Issue #99 adds exactly one write route, the collection-level registration;
    // there is no per-document replacement or deletion route.
    const writes = API_ROUTES.filter(
      (route) => route.path.startsWith('/api/v1/schema-documents') && route.method !== 'get',
    )
    expect(writes.map((route) => route.operationId)).toEqual(['registerSchemaDocument'])
    expect(writes.map((route) => route.path)).toEqual(['/api/v1/schema-documents'])
  })

  test('rejects an oversized request body before it reaches the route', async () => {
    if (fixture === undefined) {
      throw new Error('fixture is not initialized')
    }
    const before = documentCount(fixture.database)
    const response = await app.request(contentPath(schemaDocument), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(MAX_API_BODY_BYTES + 1),
    })
    expect(response.status).toBe(413)
    expect((await errorJson(response)).error.code).toBe('payload_too_large')
    expect(documentCount(fixture.database)).toBe(before)
  })
})

describe('hosted schema metadata routes', () => {
  test('builds the permanent URL from configuration, not host headers', async () => {
    const response = await app.request(`/api/v1/schema-documents/${schemaDocument.id}`, {
      headers: {
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
        forwarded: 'host=attacker.example;proto=https',
      },
    })
    expect(response.status).toBe(200)
    const body = await json<{ data: CredentialSchemaDocumentResource }>(response)
    assertSchema('CredentialSchemaDocumentResponse', { data: body.data })

    expect(body.data).toEqual({
      id: schemaDocument.id,
      kind: 'json_schema_2020_12',
      mediaType: 'application/schema+json',
      contentDigest: schemaDocument.contentDigest,
      integrity: `sha256-${Buffer.from(schemaDocument.contentDigest, 'hex').toString('base64')}`,
      url: `${PUBLIC_BASE_URL}/api/v1/schema-documents/${schemaDocument.id}/content`,
      createdAt: schemaDocument.createdAt,
    })
    expect(body.data.url).not.toContain('attacker.example')

    // Provider ownership, provenance and any token material stay internal.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(providerId)
    expect(serialized).not.toContain('provenance')
    expect(serialized).not.toContain('http-test')
  })

  test('lists only public metadata with pagination', async () => {
    const response = await app.request('/api/v1/schema-documents?limit=1&offset=0')
    expect(response.status).toBe(200)
    const body = await json<{
      data: readonly CredentialSchemaDocumentResource[]
      pagination: { limit: number; offset: number; total: number }
    }>(response)
    assertSchema('CredentialSchemaDocumentPageResponse', body)
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ limit: 1, offset: 0, total: 2 })
    expect(body.data[0]?.url.startsWith(`${PUBLIC_BASE_URL}/api/v1/schema-documents/`)).toBe(true)

    const second = await app.request('/api/v1/schema-documents?limit=1&offset=1')
    const secondBody = await json<{ data: readonly CredentialSchemaDocumentResource[] }>(second)
    expect(secondBody.data[0]?.id).toBe(typeMetadataDocument.id)
  })

  test('rejects invalid pagination values', async () => {
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc']) {
      const response = await app.request(`/api/v1/schema-documents?${query}`)
      expect(response.status, query).toBe(400)
      expect((await errorJson(response)).error.code).toBe('invalid_request')
    }
  })

  test('answers 404 for unknown metadata identifiers', async () => {
    const response = await app.request('/api/v1/schema-documents/missing')
    expect(response.status).toBe(404)
    expect((await errorJson(response)).error.code).toBe('not_found')
  })

  test('rejects metadata reads explicitly when no public origin is configured', async () => {
    if (fixture === undefined) {
      throw new Error('fixture is not initialized')
    }
    const unconfigured = createApp({ registry: fixture.registry })
    for (const path of [
      '/api/v1/schema-documents',
      `/api/v1/schema-documents/${schemaDocument.id}`,
    ]) {
      const response = await unconfigured.request(path)
      expect(response.status, path).toBe(503)
      const body = await errorJson(response)
      expect(body.error.code).toBe('public_base_url_unavailable')
    }
    // The bytes themselves do not need an origin and stay retrievable.
    const content = await unconfigured.request(contentPath(schemaDocument))
    expect(content.status).toBe(200)
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(schemaBytes)
  })
})

describe('hosted schema restart persistence', () => {
  test('returns byte-identical content and digest after reopening the database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attestbook-hosted-schema-restart-'))
    try {
      const databasePath = join(directory, 'attestbook.sqlite')
      const firstDatabase = openMigratedDatabase(databasePath)
      const firstRegistry = new Registry({ database: firstDatabase })
      const owner = provisionProvider(firstDatabase, {
        name: 'Restart Provider',
        publicationAuthority: 'restart-provider',
      })
      const registered = await firstRegistry.registerCredentialSchemaDocument(owner.actor, {
        kind: 'json_schema_2020_12',
        bytes: schemaBytes,
      })
      const firstApp = createApp({ registry: firstRegistry, publicBaseUrl: PUBLIC_BASE_URL })
      const firstResponse = await firstApp.request(contentPath(registered))
      expect(firstResponse.status).toBe(200)
      const firstBody = new Uint8Array(await firstResponse.arrayBuffer())
      const firstEtag = firstResponse.headers.get('etag')
      const firstDigest = firstResponse.headers.get('content-digest')
      firstDatabase.close()

      const reopenedDatabase = openMigratedDatabase(databasePath)
      try {
        const reopenedRegistry = new Registry({ database: reopenedDatabase })
        const reopenedApp = createApp({
          registry: reopenedRegistry,
          publicBaseUrl: PUBLIC_BASE_URL,
        })
        const secondResponse = await reopenedApp.request(contentPath(registered))
        expect(secondResponse.status).toBe(200)
        expect(new Uint8Array(await secondResponse.arrayBuffer())).toEqual(firstBody)
        expect(secondResponse.headers.get('etag')).toBe(firstEtag)
        expect(secondResponse.headers.get('content-digest')).toBe(firstDigest)
        expect(secondResponse.headers.get('content-type')).toBe('application/schema+json')

        const metadata = await reopenedApp.request(`/api/v1/schema-documents/${registered.id}`)
        expect(metadata.status).toBe(200)
        const body = await json<{ data: CredentialSchemaDocumentResource }>(metadata)
        expect(body.data.contentDigest).toBe(registered.contentDigest)
        expect(body.data.url).toBe(
          `${PUBLIC_BASE_URL}/api/v1/schema-documents/${registered.id}/content`,
        )
      } finally {
        reopenedDatabase.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
