// HTTP tests for provider-authorized schema registration and reference use
// (issue #99). They drive the real Hono application and a real temporary
// SQLite registry, so authentication, provider ownership, the content-addressed
// write, the returned hosted URI/SRI pair, the typed failures and the ordinary
// `schemaReferences` round-trip are the ones the server actually exposes.
//
// The point of the reference tests is deliberately narrow: a stored document's
// `url` and `integrity` are consumed by the existing external-reference path as
// plain `uri`/`integrity` values. No proprietary field is added to a version
// snapshot, and an external HTTPS reference keeps working without an upload.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import {
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  AdminAuth,
  LoginRateLimiter,
  type AdminLoginConfig,
} from '../auth'
import { provisionProvider } from '../registry/bootstrap'
import { sha256Hex } from '../registry/digest'
import { MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES } from '../registry/schema-documents'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { buildOpenApiDocument } from './openapi'
import { componentJsonSchema, type OpenApiComponentName } from './schemas'

const PUBLIC_BASE_URL = 'https://schemas.example'
const PASSWORD = 'uat-schema-registration-password'
const PASSWORD_HASH = await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' })
const FIXED_NOW = '2026-01-01T00:00:00.000Z'

/** A supported JSON Schema 2020-12 fixture, sent as the exact request body. */
const JSON_SCHEMA_TEXT =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["family_name"],"properties":{"family_name":{"type":"string"}},"additionalProperties":false}'

/** A supported SD-JWT VC Type Metadata fixture. */
const TYPE_METADATA_TEXT =
  '{"vct":"https://example.org/vct/pid","name":"Person Identification Data","claims":[{"path":["family_name"],"mandatory":true}]}'

const typeMetadataBytes = new TextEncoder().encode(TYPE_METADATA_TEXT)

let fixture: RegistryFixture | undefined
let app: Hono
let owner: ReturnType<typeof provisionProvider>
let adminSession: { cookie: string; csrfToken: string; providerId: string }

const validators = new Map<string, ValidateFunction>()

function assertSchema(name: OpenApiComponentName, value: unknown): void {
  let validate = validators.get(name)
  if (validate === undefined) {
    validate = ajv.compile(componentJsonSchema(name))
    validators.set(name, validate)
  }
  expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true)
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function errorJson(response: Response): Promise<ErrorEnvelope> {
  return json<ErrorEnvelope>(response)
}

function requireFixture(): RegistryFixture {
  if (fixture === undefined) {
    throw new Error('test fixture is not initialized')
  }
  return fixture
}

function bearer(secret: string): string {
  return `Bearer ${secret}`
}

interface RegistrationOptions {
  readonly body?: string | Uint8Array
  readonly kind?: string | null
  readonly authorization?: string
  readonly cookie?: string
  readonly csrfToken?: string | null
  readonly contentType?: string
}

function registrationPath(kind: string | null | undefined): string {
  if (kind === null) {
    return '/api/v1/schema-documents'
  }
  const value = kind ?? 'json_schema_2020_12'
  return `/api/v1/schema-documents?kind=${encodeURIComponent(value)}`
}

function register(options: RegistrationOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
  }
  if (options.authorization !== undefined) {
    headers['authorization'] = options.authorization
  }
  if (options.cookie !== undefined) {
    headers['cookie'] = options.cookie
  }
  if (options.csrfToken !== undefined && options.csrfToken !== null) {
    headers[ADMIN_CSRF_HEADER_NAME] = options.csrfToken
  }
  return Promise.resolve(
    app.request(registrationPath(options.kind), {
      method: 'POST',
      headers,
      body: options.body ?? JSON_SCHEMA_TEXT,
    }),
  )
}

function registerAsOwner(
  options: Omit<RegistrationOptions, 'authorization'> = {},
): Promise<Response> {
  return register({ ...options, authorization: bearer(owner.token.secret) })
}

/** A distinct valid JSON Schema 2020-12 document for one test scenario. */
function schemaFor(marker: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { [marker]: { type: 'string' } },
    }),
  )
}

async function login(): Promise<{ cookie: string; csrfToken: string; providerId: string }> {
  const response = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'uat-admin', password: PASSWORD }),
  })
  expect(response.status).toBe(200)
  const setCookie = response.headers.get('set-cookie') ?? ''
  const match = new RegExp(`(?:^|,\\s*)${ADMIN_SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie)
  const value = match?.[1]
  if (value === undefined) {
    throw new Error('login did not set the administrator session cookie')
  }
  const body = (await response.json()) as {
    data: { provider: { id: string }; csrfToken: string }
  }
  return {
    cookie: `${ADMIN_SESSION_COOKIE_NAME}=${value}`,
    csrfToken: body.data.csrfToken,
    providerId: body.data.provider.id,
  }
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

beforeAll(async () => {
  fixture = createRegistryFixture()
  owner = provisionProvider(fixture.database, {
    name: 'Schema Registration Owner',
    publicationAuthority: 'schema-registration-owner',
  })
  const admin = provisionProvider(fixture.database, {
    name: 'Schema Registration Administrator',
    publicationAuthority: 'schema-registration-admin',
  })
  const config: AdminLoginConfig = {
    status: 'configured',
    username: 'uat-admin',
    passwordHash: PASSWORD_HASH,
    providerId: admin.provider.id,
  }
  const adminAuth = new AdminAuth({
    database: fixture.database,
    registry: fixture.registry,
    config,
    now: () => FIXED_NOW,
    accountRateLimiter: new LoginRateLimiter({ maxFailures: 10, now: () => Date.parse(FIXED_NOW) }),
    clientRateLimiter: new LoginRateLimiter({
      maxFailures: 100,
      now: () => Date.parse(FIXED_NOW),
    }),
  })
  app = createApp({
    registry: fixture.registry,
    publicBaseUrl: PUBLIC_BASE_URL,
    adminAuth,
  })
  adminSession = await login()
})

afterAll(() => {
  fixture?.cleanup()
  fixture = undefined
})

describe('registration authorization', () => {
  test('rejects anonymous and invalid credentials before any write', async () => {
    const before = {
      documents: documentCount(requireFixture().database),
      audit: auditCount(requireFixture().database),
    }

    const anonymous = await register()
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer realm="attestbook"')
    expect((await errorJson(anonymous)).error.code).toBe('unauthorized')

    const badBearer = await register({ authorization: bearer('att_not_a_valid_token') })
    expect(badBearer.status).toBe(401)

    const missingCsrf = await register({ cookie: adminSession.cookie })
    expect(missingCsrf.status).toBe(403)
    expect((await errorJson(missingCsrf)).error.code).toBe('csrf_failed')

    const wrongCsrf = await register({
      cookie: adminSession.cookie,
      csrfToken: 'not-the-session-token',
    })
    expect(wrongCsrf.status).toBe(403)

    expect(documentCount(requireFixture().database)).toBe(before.documents)
    expect(auditCount(requireFixture().database)).toBe(before.audit)
  })

  test('a provider bearer token registers under its own provider only', async () => {
    const bytes = new TextEncoder().encode(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"bearer_only":{"type":"string"}}}',
    )
    const response = await registerAsOwner({
      body: bytes,
      contentType: 'application/schema+json',
    })
    expect(response.status).toBe(201)

    const body = await json<{ data: CredentialSchemaDocumentResourceLike }>(response)
    assertSchema('CredentialSchemaDocumentResponse', body)
    expect(body.data.mediaType).toBe('application/schema+json')
    expect(body.data.contentDigest).toBe(sha256Hex(bytes))
    expect(body.data.integrity).toBe(`sha256-${sha256Base64(bytes)}`)
    expect(body.data.url).toBe(`${PUBLIC_BASE_URL}/api/v1/schema-documents/${body.data.id}/content`)
    expect(response.headers.get('location')).toBe(body.data.url)
    expect(requireFixture().registry.getCredentialSchemaDocument(body.data.id)?.providerId).toBe(
      owner.provider.id,
    )
  })

  test('the administrator session with its CSRF token registers for the bound provider', async () => {
    const bytes = new TextEncoder().encode(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"session_registered":{"type":"string"}}}',
    )
    const response = await register({
      body: bytes,
      cookie: adminSession.cookie,
      csrfToken: adminSession.csrfToken,
    })
    expect(response.status).toBe(201)
    const body = await json<{ data: CredentialSchemaDocumentResourceLike }>(response)
    expect(requireFixture().registry.getCredentialSchemaDocument(body.data.id)?.providerId).toBe(
      adminSession.providerId,
    )
    // The same content under another provider is a separate association with
    // its own stable hosted URL, while the bytes stay shared.
    const second = await registerAsOwner({ body: bytes })
    expect(second.status).toBe(201)
    const secondBody = await json<{ data: CredentialSchemaDocumentResourceLike }>(second)
    expect(secondBody.data.contentDigest).toBe(body.data.contentDigest)
    expect(secondBody.data.id).not.toBe(body.data.id)
    expect(secondBody.data.url).not.toBe(body.data.url)
  })
})

describe('registration results and idempotency', () => {
  test('serves the exact registered bytes at the returned URI without authentication', async () => {
    const bytes = new TextEncoder().encode(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"retrievable":{"type":"string"}}}',
    )
    const response = await registerAsOwner({ body: bytes })
    expect(response.status).toBe(201)
    const body = await json<{ data: CredentialSchemaDocumentResourceLike }>(response)

    const content = await app.request(new URL(body.data.url).pathname)
    expect(content.status).toBe(200)
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes)
    expect(content.headers.get('content-type')).toBe('application/schema+json')
    expect(content.headers.get('content-digest')).toBe(`sha-256=:${sha256Base64(bytes)}:`)

    const metadata = await app.request(`/api/v1/schema-documents/${body.data.id}`)
    expect(metadata.status).toBe(200)
    const metadataBody = await json<{ data: CredentialSchemaDocumentResourceLike }>(metadata)
    expect(metadataBody.data).toEqual(body.data)
  })

  test('supports SD-JWT VC Type Metadata under its canonical media type', async () => {
    const response = await registerAsOwner({
      kind: 'sd_jwt_vc_type_metadata',
      body: typeMetadataBytes,
    })
    expect(response.status).toBe(201)
    const body = await json<{ data: CredentialSchemaDocumentResourceLike }>(response)
    expect(body.data.kind).toBe('sd_jwt_vc_type_metadata')
    expect(body.data.mediaType).toBe('application/json')

    const content = await app.request(new URL(body.data.url).pathname)
    expect(content.headers.get('content-type')).toBe('application/json')
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(typeMetadataBytes)
  })

  test('is idempotent for the same provider and identical content', async () => {
    const bytes = new TextEncoder().encode(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"idempotent":{"type":"string"}}}',
    )
    const first = await registerAsOwner({ body: bytes })
    expect(first.status).toBe(201)
    const firstBody = await json<{ data: CredentialSchemaDocumentResourceLike }>(first)

    const documentsAfterFirst = documentCount(requireFixture().database)
    const second = await registerAsOwner({ body: bytes })
    expect(second.status).toBe(200)
    const secondBody = await json<{ data: CredentialSchemaDocumentResourceLike }>(second)
    expect(secondBody.data).toEqual(firstBody.data)
    expect(second.headers.get('location')).toBe(firstBody.data.url)
    expect(documentCount(requireFixture().database)).toBe(documentsAfterFirst)
  })

  test('has no route that replaces or deletes a stored document', async () => {
    const response = await registerAsOwner({ body: schemaFor('replace_or_delete') })
    expect(response.status).toBe(201)
    const body = await json<{ data: CredentialSchemaDocumentResourceLike }>(response)
    const path = new URL(body.data.url).pathname

    for (const method of ['PUT', 'DELETE']) {
      const attempt = await app.request(`/api/v1/schema-documents/${body.data.id}`, {
        method,
        headers: { authorization: bearer(owner.token.secret) },
      })
      expect(attempt.status, method).toBe(404)
    }
    expect((await app.request(path)).status).toBe(200)
  })
})

describe('typed registration failures', () => {
  test('rejects a missing or unsupported kind with invalid_request', async () => {
    const missing = await registerAsOwner({ kind: null })
    expect(missing.status).toBe(400)
    expect((await errorJson(missing)).error.code).toBe('invalid_request')

    const unsupported = await registerAsOwner({ kind: 'not_a_supported_profile' })
    expect(unsupported.status).toBe(400)
    expect((await errorJson(unsupported)).error.code).toBe('invalid_request')
  })

  test('rejects malformed JSON without echoing the body or writing', async () => {
    const before = documentCount(requireFixture().database)
    const response = await registerAsOwner({ body: '{"type": "object", SECRET_MARKER' })
    expect(response.status).toBe(400)
    const body = await errorJson(response)
    expect(body.error.code).toBe('invalid_request')
    expect(JSON.stringify(body)).not.toContain('SECRET_MARKER')
    expect(documentCount(requireFixture().database)).toBe(before)
  })

  test('rejects an unsupported or unsafe schema construct', async () => {
    const response = await registerAsOwner({
      body: JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $ref: 'https://attacker.example/schema.json',
      }),
    })
    expect(response.status).toBe(400)
    expect((await errorJson(response)).error.code).toBe('invalid_request')
  })

  test('rejects an oversized document with payload_too_large', async () => {
    const oversized = new Uint8Array(MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES + 1).fill(0x20)
    const response = await registerAsOwner({ body: oversized })
    expect(response.status).toBe(413)
    expect((await errorJson(response)).error.code).toBe('payload_too_large')
  })

  test('rejects the same content under a contradictory profile with conflict', async () => {
    const bytes = new TextEncoder().encode(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"conflict":{"type":"string"}}}',
    )
    const first = await registerAsOwner({ body: bytes })
    expect(first.status).toBe(201)

    const conflicting = await registerAsOwner({ kind: 'sd_jwt_vc_type_metadata', body: bytes })
    expect(conflicting.status).toBe(409)
    expect((await errorJson(conflicting)).error.code).toBe('conflict')
  })

  test('answers public_base_url_unavailable instead of writing without a hosted origin', async () => {
    const before = documentCount(requireFixture().database)
    const noOrigin = createApp({ registry: requireFixture().registry })
    const response = await noOrigin.request(registrationPath('json_schema_2020_12'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: bearer(owner.token.secret),
      },
      body: JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { no_origin: { type: 'string' } },
      }),
    })
    expect(response.status).toBe(503)
    expect((await errorJson(response)).error.code).toBe('public_base_url_unavailable')
    expect(documentCount(requireFixture().database)).toBe(before)
  })
})

describe('schema references', () => {
  test('accepts the returned URI and SRI as an ordinary per-attestation reference', async () => {
    const registered = await registerAsOwner({ body: schemaFor('stored_reference') })
    expect(registered.status).toBe(201)
    const document = (await json<{ data: CredentialSchemaDocumentResourceLike }>(registered)).data

    const created = await app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: bearer(owner.token.secret),
      },
      body: JSON.stringify({
        name: 'Stored Schema Reference Rulebook',
        applicableSpec: 'ts11@1.0.1',
        attestations: [
          {
            name: 'Person Identification Data',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt'],
            schemaReferences: [
              {
                formatIdentifier: 'dc+sd-jwt',
                uri: document.url,
                integrity: document.integrity,
              },
            ],
          },
        ],
        schemaReferences: [],
      }),
    })
    expect(created.status).toBe(201)
    const rulebook = (await json<{ data: { id: string } }>(created)).data

    const draft = await app.request(`/api/v1/rulebooks/${rulebook.id}/draft`)
    expect(draft.status).toBe(200)
    const draftBody = await json<{
      data: {
        attestations: readonly {
          schemaReferences: readonly { uri: string; integrity: string }[]
        }[]
      }
    }>(draft)
    const reference = draftBody.data.attestations[0]?.schemaReferences[0]
    expect(reference?.uri).toBe(document.url)
    expect(reference?.integrity).toBe(document.integrity)

    const froze = await app.request(`/api/v1/rulebooks/${rulebook.id}/versions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: bearer(owner.token.secret),
      },
      body: JSON.stringify({ version: '1.0' }),
    })
    expect(froze.status).toBe(201)

    const snapshot = await app.request(`/api/v1/rulebooks/${rulebook.id}/versions/1.0/content`)
    expect(snapshot.status).toBe(200)
    const snapshotDocument = JSON.parse(await snapshot.text()) as {
      attestations: readonly {
        schemaReferences: readonly Record<string, unknown>[]
      }[]
    }
    // Exactly the TS11-compatible reference members: the hosted URL and SRI are
    // ordinary values, and no proprietary field was introduced.
    expect(snapshotDocument.attestations[0]?.schemaReferences[0]).toEqual({
      formatIdentifier: 'dc+sd-jwt',
      uri: document.url,
      integrity: document.integrity,
    })
  })

  test('keeps an external HTTPS schema reference external, with no upload', async () => {
    const before = documentCount(requireFixture().database)
    const externalUri = 'https://issuer.example.org/schemas/pid.json'
    const externalSri = `sha256-${sha256Base64(new TextEncoder().encode('external schema'))}`

    const created = await app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: bearer(owner.token.secret),
      },
      body: JSON.stringify({
        name: 'External Schema Reference Rulebook',
        applicableSpec: 'ts11@1.0.1',
        attestations: [
          {
            name: 'Person Identification Data',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt'],
            schemaReferences: [
              { formatIdentifier: 'dc+sd-jwt', uri: externalUri, integrity: externalSri },
              { formatIdentifier: 'application/json-schema', uri: externalUri },
            ],
          },
        ],
        schemaReferences: [{ formatIdentifier: 'rulebook-level', uri: externalUri }],
      }),
    })
    expect(created.status).toBe(201)
    const rulebook = (await json<{ data: { id: string } }>(created)).data

    const draft = await app.request(`/api/v1/rulebooks/${rulebook.id}/draft`)
    const draftBody = await json<{
      data: {
        attestations: readonly {
          schemaReferences: readonly { uri: string; integrity: string | null }[]
        }[]
        schemaReferences: readonly { uri: string; integrity: string | null }[]
      }
    }>(draft)
    expect(draftBody.data.attestations[0]?.schemaReferences[0]).toMatchObject({
      uri: externalUri,
      integrity: externalSri,
    })
    // The optional SRI stays absent (null) instead of being invented.
    expect(draftBody.data.attestations[0]?.schemaReferences[1]).toMatchObject({
      uri: externalUri,
      integrity: null,
    })
    expect(draftBody.data.schemaReferences[0]?.uri).toBe(externalUri)

    // The external reference was not fetched, converted or uploaded.
    expect(documentCount(requireFixture().database)).toBe(before)
  })

  test('an editor draft save preserves both a stored URI/SRI pair and an external URI', async () => {
    const registered = await registerAsOwner({ body: schemaFor('editor_draft_save') })
    expect(registered.status).toBe(201)
    const document = (await json<{ data: CredentialSchemaDocumentResourceLike }>(registered)).data
    const externalUri = 'https://issuer.example.org/schemas/editor-external.json'

    const created = await app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: bearer(owner.token.secret),
      },
      body: JSON.stringify({ name: 'Editor Draft Rulebook', applicableSpec: 'ts11@1.0.1' }),
    })
    expect(created.status).toBe(201)
    const rulebook = (await json<{ data: { id: string } }>(created)).data

    const documentsBeforeSave = documentCount(requireFixture().database)
    const saved = await app.request(`/api/v1/rulebooks/${rulebook.id}/draft`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: bearer(owner.token.secret),
      },
      body: JSON.stringify({
        name: 'Editor Draft Rulebook',
        applicableSpec: 'ts11@1.0.1',
        attestations: [
          {
            name: 'Person Identification Data',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt'],
            schemaReferences: [
              { formatIdentifier: 'dc+sd-jwt', uri: document.url, integrity: document.integrity },
              { formatIdentifier: 'application/json-schema', uri: externalUri },
            ],
          },
        ],
        schemaReferences: [],
      }),
    })
    expect(saved.status).toBe(200)

    const draft = await app.request(`/api/v1/rulebooks/${rulebook.id}/draft`)
    const draftBody = await json<{
      data: {
        attestations: readonly {
          schemaReferences: readonly { uri: string; integrity: string | null }[]
        }[]
      }
    }>(draft)
    const references = draftBody.data.attestations[0]?.schemaReferences ?? []
    expect(references[0]).toMatchObject({ uri: document.url, integrity: document.integrity })
    expect(references[1]).toMatchObject({ uri: externalUri, integrity: null })
    // A draft save neither re-registers nor uploads the stored document.
    expect(documentCount(requireFixture().database)).toBe(documentsBeforeSave)
  })
})

describe('registration OpenAPI contract', () => {
  test('documents the authenticated raw-body registration and its reference values', () => {
    const document = buildOpenApiDocument()
    const operation = document.paths['/api/v1/schema-documents']?.['post'] as
      Record<string, unknown> | undefined
    expect(operation).toBeDefined()
    expect(operation?.['security']).toEqual([{ bearerAuth: [] }, { sessionAuth: [] }])

    const parameters = (operation?.['parameters'] ?? []) as readonly Record<string, unknown>[]
    const kind = parameters.find((parameter) => parameter['name'] === 'kind')
    expect(kind?.['required']).toBe(true)
    expect(kind?.['in']).toBe('query')
    expect(
      parameters.some(
        (parameter) =>
          String(parameter['name']).toLowerCase() === ADMIN_CSRF_HEADER_NAME &&
          parameter['in'] === 'header',
      ),
      'a cookie registration must document the CSRF header',
    ).toBe(true)

    expect(operation?.['requestBody']).toMatchObject({ required: true })
    const responses = (operation?.['responses'] ?? {}) as Record<string, unknown>
    for (const status of ['200', '201', '400', '401', '403', '404', '409', '413', '500', '503']) {
      expect(responses[status], `missing ${status} response`).toBeDefined()
    }
  })
})

/** The public projection shape asserted by these tests. */
interface CredentialSchemaDocumentResourceLike {
  readonly id: string
  readonly kind: 'json_schema_2020_12' | 'sd_jwt_vc_type_metadata'
  readonly mediaType: 'application/schema+json' | 'application/json'
  readonly contentDigest: string
  readonly integrity: string
  readonly url: string
  readonly createdAt: string
}

/** The `integrity` value the registry/API derives for exact bytes. */
function sha256Base64(bytes: Uint8Array): string {
  return Buffer.from(sha256Hex(bytes), 'hex').toString('base64')
}
