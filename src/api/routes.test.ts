import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import { validTs11Document } from '../import/test/fixtures'
import { provisionProvider } from '../registry/bootstrap'
import type { Registry } from '../registry/registry'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { CredentialValidator } from '../validation'
import {
  issueTestCredential,
  seedPublishedRulebook,
  type SeededRulebook,
} from '../validation/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'
import type {
  AttestationDetailResource,
  CredentialValidationResource,
  ImportPreviewResource,
  ImportResultResource,
  RulebookPageResource,
  RulebookResource,
  RulebookVersionDocumentResource,
  RulebookVersionResource,
  SchemaReferenceResource,
} from './schemas'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

interface Setup {
  readonly app: Hono
  readonly registry: Registry
  readonly seeded: SeededRulebook
}

function setup(): Setup {
  fixture = createRegistryFixture()
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry)
  const validator = new CredentialValidator({
    source: fixture.registry,
    now: () => '2026-01-01T00:00:00.000Z',
    generateId: () => 'http-validation-id',
  })
  return {
    app: createApp({ registry: fixture.registry, validation: validator }),
    registry: fixture.registry,
    seeded,
  }
}

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

interface DataBody<T> {
  readonly data: T
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

async function postJson(app: Hono, path: string, body: unknown, token?: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  })
}

describe('rulebook read API', () => {
  test('lists the public catalogue with pagination and without internal fields', async () => {
    const { app } = setup()
    const response = await app.request('/api/v1/rulebooks')

    expect(response.status).toBe(200)
    const body = await json<RulebookPageResource>(response)
    assertSchema('RulebookPageResponse', body)
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ limit: 50, offset: 0, total: 1 })
    expect(body.data[0]).not.toHaveProperty('importKey')
    expect(body.data[0]).not.toHaveProperty('provenance')
    expect(body.data[0]).not.toHaveProperty('metadata')
  })

  test('filters by status and provider and paginates the filtered catalogue', async () => {
    const { app, registry, seeded } = setup()
    registry.createRulebook(seeded.token, {
      name: 'Second Rulebook',
      applicableSpec: 'ts11@1.0.1',
    })

    const page = await app.request('/api/v1/rulebooks?limit=1&offset=1')
    expect(page.status).toBe(200)
    const pageBody = await json<RulebookPageResource>(page)
    assertSchema('RulebookPageResponse', pageBody)
    expect(pageBody.pagination).toEqual({ limit: 1, offset: 1, total: 2 })
    expect(pageBody.data).toHaveLength(1)

    const published = await app.request('/api/v1/rulebooks?status=published')
    expect((await json<RulebookPageResource>(published)).pagination.total).toBe(1)

    const drafts = await app.request('/api/v1/rulebooks?status=draft')
    expect((await json<RulebookPageResource>(drafts)).pagination.total).toBe(1)

    const provider = await app.request('/api/v1/rulebooks?providerId=missing-provider')
    expect(provider.status).toBe(200)
    expect((await json<RulebookPageResource>(provider)).pagination.total).toBe(0)

    const unknown = await app.request('/api/v1/rulebooks?status=bogus')
    expect(unknown.status).toBe(400)
    expect((await errorJson(unknown)).error.code).toBe('invalid_request')

    const invalidLimit = await app.request('/api/v1/rulebooks?limit=0')
    expect(invalidLimit.status).toBe(400)
    expect((await errorJson(invalidLimit)).error.code).toBe('invalid_request')
  })

  test('gets one rulebook and reports an unknown id as a typed 404', async () => {
    const { app, seeded } = setup()

    const response = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}`)
    expect(response.status).toBe(200)
    const body = await json<DataBody<RulebookResource>>(response)
    assertSchema('RulebookResponse', body)
    expect(body.data.id).toBe(seeded.rulebookId)
    expect(body.data.publicationStatus).toBe('published')

    const missing = await app.request('/api/v1/rulebooks/does-not-exist')
    expect(missing.status).toBe(404)
    const error = await errorJson(missing)
    assertSchema('ErrorEnvelope', error)
    expect(error.error.code).toBe('not_found')
  })

  test('lists attestation types with their schema references', async () => {
    const { app, seeded } = setup()

    const response = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}/attestations`)
    expect(response.status).toBe(200)
    const body = await json<DataBody<readonly AttestationDetailResource[]>>(response)
    assertSchema('AttestationListResponse', body)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(seeded.attestationName)
    expect(body.data[0]?.schemaReferences).toHaveLength(1)
    expect(body.data[0]).not.toHaveProperty('metadata')
  })

  test('lists every schema reference of the working copy', async () => {
    const { app, seeded } = setup()

    const response = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}/schema-references`)
    expect(response.status).toBe(200)
    const body = await json<DataBody<readonly SchemaReferenceResource[]>>(response)
    assertSchema('SchemaReferenceListResponse', body)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.uri).toBe(seeded.schemaUri)
    expect(body.data[0]).not.toHaveProperty('metadata')
  })
})

describe('version read API', () => {
  test('lists versions and gets one version with its digest', async () => {
    const { app, seeded } = setup()

    const list = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}/versions`)
    expect(list.status).toBe(200)
    const listed = await json<DataBody<readonly RulebookVersionResource[]>>(list)
    assertSchema('RulebookVersionListResponse', listed)
    expect(listed.data).toHaveLength(1)
    expect(listed.data[0]?.status).toBe('published')

    const one = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}/versions/1.0`)
    expect(one.status).toBe(200)
    const single = await json<DataBody<RulebookVersionResource>>(one)
    assertSchema('RulebookVersionResponse', single)
    expect(single.data.contentDigest).toBe(seeded.digest)

    const missing = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}/versions/9.9`)
    expect(missing.status).toBe(404)
    expect((await errorJson(missing)).error.code).toBe('not_found')
  })

  test('downloads exact snapshot bytes with a verifiable digest', async () => {
    const { app, seeded } = setup()

    const response = await app.request(
      `/api/v1/rulebooks/${seeded.rulebookId}/versions/1.0/content`,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain(
      'application/vnd.attestbook.rulebook-version+json',
    )
    const expectedBase64 = Buffer.from(seeded.digest, 'hex').toString('base64')
    expect(response.headers.get('content-digest')).toBe(`sha-256=:${expectedBase64}:`)
    expect(response.headers.get('etag')).toBe(`"${seeded.digest}"`)

    const document = await json<RulebookVersionDocumentResource>(response)
    assertSchema('RulebookVersionDocument', document)
    expect(document.rulebookId).toBe(seeded.rulebookId)
    expect(document.version).toBe('1.0')

    const missing = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}/versions/9.9/content`)
    expect(missing.status).toBe(404)
  })
})

describe('rulebook write API', () => {
  test('creates a draft rulebook and hides internal fields from the request', async () => {
    const { app, registry, seeded } = setup()

    const response = await postJson(
      app,
      '/api/v1/rulebooks',
      {
        name: 'New Rulebook',
        description: 'Created through the API',
        applicableSpec: 'ts11@1.0.1',
        metadata: { should: 'be ignored' },
        provenance: { should: 'be ignored' },
        importKey: 'a'.repeat(64),
        attestations: [
          {
            name: 'PID',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt'],
            metadata: { should: 'be ignored' },
          },
        ],
      },
      seeded.token,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toMatch(/^\/api\/v1\/rulebooks\//)
    const body = await json<DataBody<RulebookResource>>(response)
    assertSchema('RulebookResponse', body)
    expect(body.data.name).toBe('New Rulebook')
    expect(body.data).not.toHaveProperty('importKey')

    const stored = registry.getRulebook(body.data.id)
    expect(stored).not.toBeNull()
    expect(stored?.provenance).toEqual({})
    expect(stored?.metadata).toEqual({})
    expect(stored?.importKey).toBeNull()
    expect(registry.listAttestations(body.data.id)).toHaveLength(1)

    const unauthenticated = await postJson(app, '/api/v1/rulebooks', {
      name: 'No token',
      applicableSpec: 'ts11@1.0.1',
    })
    expect(unauthenticated.status).toBe(401)
    expect((await errorJson(unauthenticated)).error.code).toBe('unauthorized')

    const invalid = await postJson(app, '/api/v1/rulebooks', {}, seeded.token)
    expect(invalid.status).toBe(400)
    expect((await errorJson(invalid)).error.code).toBe('invalid_request')
  })

  test('creates and publishes versions with auth and lifecycle errors', async () => {
    const { app, registry, seeded } = setup()
    if (fixture === undefined) {
      throw new Error('test fixture was not created')
    }
    const other = provisionProvider(fixture.database, {
      name: 'Other Provider',
      publicationAuthority: 'authority-other',
    })

    const created = await postJson(
      app,
      `/api/v1/rulebooks/${seeded.rulebookId}/versions`,
      { version: '2.0' },
      seeded.token,
    )
    expect(created.status).toBe(201)
    const versionBody = await json<DataBody<RulebookVersionResource>>(created)
    assertSchema('RulebookVersionResponse', versionBody)
    expect(versionBody.data.status).toBe('draft')

    const duplicate = await postJson(
      app,
      `/api/v1/rulebooks/${seeded.rulebookId}/versions`,
      { version: '2.0' },
      seeded.token,
    )
    expect(duplicate.status).toBe(409)

    const crossProvider = await postJson(
      app,
      `/api/v1/rulebooks/${seeded.rulebookId}/versions`,
      { version: '3.0' },
      other.token.secret,
    )
    expect(crossProvider.status).toBe(403)

    const unauthenticated = await postJson(app, `/api/v1/rulebooks/${seeded.rulebookId}/versions`, {
      version: '4.0',
    })
    expect(unauthenticated.status).toBe(401)

    const published = await postJson(
      app,
      `/api/v1/rulebooks/${seeded.rulebookId}/versions/2.0/publish`,
      {},
      seeded.token,
    )
    expect(published.status).toBe(200)
    const publishedBody = await json<DataBody<RulebookVersionResource>>(published)
    expect(publishedBody.data.status).toBe('published')
    expect(registry.getRulebookVersion(seeded.rulebookId, '1.0')?.status).toBe('historical')

    // Replaying the publication is idempotent and does not resurrect anything.
    const replay = await postJson(
      app,
      `/api/v1/rulebooks/${seeded.rulebookId}/versions/2.0/publish`,
      {},
      seeded.token,
    )
    expect(replay.status).toBe(200)
    expect((await json<DataBody<RulebookVersionResource>>(replay)).data.status).toBe('published')

    const historical = await postJson(
      app,
      `/api/v1/rulebooks/${seeded.rulebookId}/versions/1.0/publish`,
      {},
      seeded.token,
    )
    expect(historical.status).toBe(409)
    expect((await errorJson(historical)).error.code).toBe('immutable')

    const foreignPublish = await postJson(
      app,
      `/api/v1/rulebooks/${seeded.rulebookId}/versions/2.0/publish`,
      {},
      other.token.secret,
    )
    expect(foreignPublish.status).toBe(403)
  })
})

describe('import API', () => {
  const source = (): Record<string, unknown> => ({
    source: {
      kind: 'json',
      content: JSON.stringify(validTs11Document),
      name: 'fixture.json',
    },
  })

  test('previews a JSON source without writing', async () => {
    const { app, registry } = setup()
    const before = registry.listRulebooks().length

    const response = await postJson(app, '/api/v1/imports/preview', source())
    expect(response.status).toBe(200)
    const body = await json<DataBody<ImportPreviewResource>>(response)
    assertSchema('ImportPreviewResponse', body)
    expect(body.data.compatibility.compatible).toBe(true)
    expect(body.data.entries).toHaveLength(1)
    expect(body.data.entries[0]).not.toHaveProperty('canonical')
    expect(registry.listRulebooks()).toHaveLength(before)

    const invalid = await postJson(app, '/api/v1/imports/preview', {
      source: { kind: 'json', content: '{not-json' },
    })
    expect(invalid.status).toBe(422)
    const invalidBody = await errorJson(invalid)
    assertSchema('ErrorEnvelope', invalidBody)
    expect(invalidBody.error.code).toBe('import_rejected')
    expect(invalidBody.error.details?.['reason']).toBe('invalid_json')

    const malformed = await postJson(app, '/api/v1/imports/preview', {})
    expect(malformed.status).toBe(400)
    expect((await errorJson(malformed)).error.code).toBe('invalid_request')

    const insecureUrl = await postJson(app, '/api/v1/imports/preview', {
      source: { kind: 'url', url: 'http://catalog.example.test/x.json' },
    })
    expect(insecureUrl.status).toBe(400)
    expect((await errorJson(insecureUrl)).error.details?.['reason']).toBe('invalid_url')
  })

  test('imports drafts, then re-imports the same source idempotently', async () => {
    const { app, registry, seeded } = setup()
    const before = registry.listRulebooks().length

    const imported = await postJson(app, '/api/v1/imports', source(), seeded.token)
    expect(imported.status).toBe(200)
    const body = await json<DataBody<ImportResultResource>>(imported)
    assertSchema('ImportResultResponse', body)
    expect(body.data.entries[0]?.disposition).toBe('created')
    expect(body.data.rulebooks).toHaveLength(1)
    expect(body.data.rulebooks[0]).not.toHaveProperty('importKey')
    expect(registry.listRulebooks()).toHaveLength(before + 1)

    const again = await postJson(app, '/api/v1/imports', source(), seeded.token)
    expect(again.status).toBe(200)
    const replay = await json<DataBody<ImportResultResource>>(again)
    assertSchema('ImportResultResponse', replay)
    expect(replay.data.entries[0]?.disposition).toBe('unchanged')
    expect(replay.data.rulebooks).toHaveLength(0)
    expect(registry.listRulebooks()).toHaveLength(before + 1)

    const unauthenticated = await postJson(app, '/api/v1/imports', source())
    expect(unauthenticated.status).toBe(401)
    expect((await errorJson(unauthenticated)).error.code).toBe('unauthorized')
  })
})

describe('credential validation API', () => {
  test('returns the wrapped dimension-aware result and typed request errors', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()

    const response = await postJson(app, '/api/v1/credentials/validate', {
      rulebookId: seeded.rulebookId,
      rulebookVersion: seeded.version,
      attestationType: seeded.attestationName,
      credential,
      schemaDocuments: [{ uri: seeded.schemaUri, content: seeded.schemaContent }],
    })
    expect(response.status).toBe(200)
    const body = await json<DataBody<CredentialValidationResource>>(response)
    assertSchema('CredentialValidationResponse', body)
    expect(body.data.rulebook.digest).toBe(seeded.digest)
    expect(body.data.overallStatus).toBe('NOT_TESTED')

    const invalid = await postJson(app, '/api/v1/credentials/validate', {})
    expect(invalid.status).toBe(400)
    expect((await errorJson(invalid)).error.code).toBe('invalid_request')

    const unknown = await postJson(app, '/api/v1/credentials/validate', {
      rulebookId: 'missing',
      rulebookVersion: '1.0',
      attestationType: 'PID',
      credential: 'x',
    })
    expect(unknown.status).toBe(404)
    expect((await errorJson(unknown)).error.code).toBe('not_found')
  })

  test('answers 503 when validation is not wired', async () => {
    const { registry } = setup()
    const app = createApp({ registry })

    const response = await app.request('/api/v1/credentials/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(503)
    expect((await errorJson(response)).error.code).toBe('validation_unavailable')
  })
})

describe('missing service wiring', () => {
  test('answers 503 instead of a placeholder for registry routes', async () => {
    const app = createApp()
    const response = await app.request('/api/v1/rulebooks')
    expect(response.status).toBe(503)
    expect((await errorJson(response)).error.code).toBe('registry_unavailable')
  })
})
