// HTTP contract tests for the rulebook draft editor (#40).
//
// The editor needs one readable working-copy document, one authorized full
// replacement and one read-only live-validation endpoint. These tests exercise
// the real registry and the real standards adapter through `app.request`.

import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'
import type { DraftRulebookResource, DraftValidationResource } from './schemas'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup(): {
  readonly app: Hono
  readonly registry: RegistryFixture['registry']
  readonly token: string
  readonly otherToken: string
  readonly rulebookId: string
  readonly publishedRulebookId: string
} {
  fixture = createRegistryFixture()
  const owner = provisionProvider(fixture.database, {
    name: 'Editor Provider',
    publicationAuthority: 'editor-provider',
  })
  const other = provisionProvider(fixture.database, {
    name: 'Other Provider',
    publicationAuthority: 'other-provider',
  })
  const rulebook = fixture.registry.createRulebook(owner.actor, {
    name: 'Editor Draft',
    description: 'A draft to edit.',
    sourceUrl: 'https://issuer.example.org/rulebooks/editor',
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
            uri: 'https://issuer.example.org/schemas/pid',
          },
        ],
      },
    ],
  })
  const published = fixture.registry.createRulebook(owner.actor, {
    name: 'Published Rulebook',
    applicableSpec: 'ts11@1.0.1',
  })
  fixture.registry.createRulebookVersion(owner.actor, published.id, { version: '1.0' })
  fixture.registry.publishRulebookVersion(owner.actor, published.id, '1.0')

  return {
    app: createApp({ registry: fixture.registry }),
    registry: fixture.registry,
    token: owner.token.secret,
    otherToken: other.token.secret,
    rulebookId: rulebook.id,
    publishedRulebookId: published.id,
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

function headers(token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

const SAVE_BODY = {
  name: 'Edited draft',
  description: 'Edited description',
  sourceUrl: 'https://issuer.example.org/rulebooks/edited',
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
          uri: 'https://issuer.example.org/schemas/pid-edited',
          integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
        },
      ],
    },
  ],
  schemaReferences: [
    { formatIdentifier: 'vc+sd-jwt', uri: 'https://issuer.example.org/schemas/rb' },
  ],
}

describe('draft editor read API', () => {
  test('returns the working copy as one public document without internal metadata', async () => {
    const { app, rulebookId } = setup()

    const response = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`)
    expect(response.status).toBe(200)
    const body = await json<{ data: DraftRulebookResource }>(response)
    assertSchema('DraftRulebookResponse', body)

    expect(body.data.id).toBe(rulebookId)
    expect(body.data.publicationStatus).toBe('draft')
    expect(body.data.attestations).toHaveLength(1)
    expect(body.data.attestations[0]?.schemaReferences[0]?.uri).toBe(
      'https://issuer.example.org/schemas/pid',
    )
    expect(body.data).not.toHaveProperty('provenance')
    expect(body.data).not.toHaveProperty('metadata')
    expect(body.data.attestations[0]).not.toHaveProperty('metadata')
  })

  test('answers 404 for an unknown draft', async () => {
    const { app } = setup()
    const response = await app.request('/api/v1/rulebooks/missing/draft')
    expect(response.status).toBe(404)
    expect((await errorJson(response)).error.code).toBe('not_found')
  })
})

describe('draft editor write API', () => {
  test('persists an authorized replacement and returns the editable document', async () => {
    const { app, rulebookId, token } = setup()

    const response = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify(SAVE_BODY),
    })
    expect(response.status).toBe(200)
    const body = await json<{ data: DraftRulebookResource }>(response)
    assertSchema('DraftRulebookResponse', body)
    expect(body.data.name).toBe('Edited draft')
    expect(body.data.attestations).toHaveLength(1)
    expect(body.data.schemaReferences).toHaveLength(1)
    expect(body.data.attestations[0]?.schemaReferences[0]?.integrity).toBe(
      'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    )

    const reread = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`)
    expect((await json<{ data: DraftRulebookResource }>(reread)).data.name).toBe('Edited draft')
  })

  test('creates a draft with rulebook-level schema references in one call', async () => {
    const { app, token } = setup()
    const response = await app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ ...SAVE_BODY, name: 'Created by the editor' }),
    })
    expect(response.status).toBe(201)
    const created = await json<{ data: { id: string } }>(response)

    const draft = await app.request(`/api/v1/rulebooks/${created.data.id}/draft`)
    const body = await json<{ data: DraftRulebookResource }>(draft)
    expect(body.data.name).toBe('Created by the editor')
    expect(body.data.attestations).toHaveLength(1)
    expect(body.data.schemaReferences).toEqual([
      {
        formatIdentifier: 'vc+sd-jwt',
        uri: 'https://issuer.example.org/schemas/rb',
        integrity: null,
      },
    ])
  })

  test('keeps registry-internal metadata when the editable projection is saved back', async () => {
    const { app, registry, token } = setup()
    const created = registry.createRulebook(registry.authenticateBearer(token), {
      name: 'Imported draft',
      applicableSpec: 'ts11@1.0.1',
      attestations: [
        {
          name: 'Imported attestation',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          metadata: { profile: 'ts11@1.0.1', conformance: 'conformant_subset' },
          schemaReferences: [
            {
              formatIdentifier: 'dc+sd-jwt',
              uri: 'https://issuer.example.org/schemas/pid',
              metadata: { meta: { vct: 'eu.example.pid' } },
            },
          ],
        },
      ],
    })

    const draftResponse = await app.request(`/api/v1/rulebooks/${created.id}/draft`)
    const draft = (await json<{ data: DraftRulebookResource }>(draftResponse)).data
    const save = await app.request(`/api/v1/rulebooks/${created.id}/draft`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({
        name: draft.name,
        description: draft.description,
        sourceUrl: draft.sourceUrl,
        applicableSpec: draft.applicableSpec,
        attestations: draft.attestations,
        schemaReferences: draft.schemaReferences,
      }),
    })
    expect(save.status).toBe(200)

    expect(registry.listAttestations(created.id)[0]?.metadata).toEqual({
      profile: 'ts11@1.0.1',
      conformance: 'conformant_subset',
    })
    expect(registry.listSchemaReferences(created.id)[0]?.metadata).toEqual({
      meta: { vct: 'eu.example.pid' },
    })
  })

  test('creates a rulebook when sourceUrl is null or omitted', async () => {
    const { app, token } = setup()
    const withoutUrl = {
      name: 'No source URL',
      description: '',
      applicableSpec: 'ts11@1.0.1',
      attestations: [],
      schemaReferences: [],
    }

    for (const body of [withoutUrl, { ...withoutUrl, sourceUrl: null }]) {
      const response = await app.request('/api/v1/rulebooks', {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(201)
      const created = await json<{ data: { id: string; sourceUrl: string | null } }>(response)
      expect(created.data.sourceUrl).toBeNull()
    }
  })

  test('requires a bearer token before reading the body', async () => {
    const { app, rulebookId } = setup()
    for (const authorization of [undefined, 'Bearer bogus']) {
      const response = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: '{not-json',
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="attestbook"')
    }
  })

  test('rejects a provider that does not own the rulebook', async () => {
    const { app, rulebookId, otherToken } = setup()
    const response = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`, {
      method: 'PUT',
      headers: headers(otherToken),
      body: JSON.stringify(SAVE_BODY),
    })
    expect(response.status).toBe(403)
    expect((await errorJson(response)).error.code).toBe('forbidden')
  })

  test('refuses to edit a published rulebook', async () => {
    const { app, publishedRulebookId, token } = setup()
    const response = await app.request(`/api/v1/rulebooks/${publishedRulebookId}/draft`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({ ...SAVE_BODY, name: 'Should not apply' }),
    })
    expect(response.status).toBe(409)
    expect((await errorJson(response)).error.code).toBe('immutable')
  })

  test('rejects an invalid draft without changing the working copy', async () => {
    const { app, rulebookId, token } = setup()
    const response = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({ ...SAVE_BODY, attestations: [{ name: '', attestationLoS: 'x' }] }),
    })
    expect(response.status).toBe(400)
    expect((await errorJson(response)).error.code).toBe('invalid_request')

    const reread = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`)
    const body = await json<{ data: DraftRulebookResource }>(reread)
    expect(body.data.name).toBe('Editor Draft')
    expect(body.data.attestations[0]?.name).toBe('Person Identification Data')
  })

  test('ignores internal fields a caller tries to inject', async () => {
    const { app, rulebookId, token, registry } = setup()
    const response = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({
        ...SAVE_BODY,
        publicationStatus: 'published',
        providerId: 'attacker',
        provenance: { injected: true },
        metadata: { injected: true },
      }),
    })
    expect(response.status).toBe(200)
    const rulebook = registry.getRulebook(rulebookId)
    expect(rulebook?.publicationStatus).toBe('draft')
    expect(rulebook?.provenance).toEqual({})
    expect(rulebook?.metadata).toEqual({})
  })
})

describe('live draft validation API', () => {
  test('is public and reports structural and standards findings without writing', async () => {
    const { app, rulebookId, registry } = setup()
    const before = registry.getDraftContent(rulebookId).rulebook.updatedAt

    const response = await app.request('/api/v1/rulebooks/validate-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'PID draft',
        applicableSpec: 'ts11@1.0.1',
        attestations: [
          {
            name: 'PID',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt'],
            schemaReferences: [],
          },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const body = await json<{ data: DraftValidationResource }>(response)
    assertSchema('DraftValidationResponse', body)
    expect(body.data.valid).toBe(true)
    expect(body.data.profile).toBe('ts11@1.0.1')
    expect(body.data.diagnostics[0]?.code).toBe('incomplete_attestation')
    expect(body.data.limitations.length).toBeGreaterThan(0)
    expect(registry.getDraftContent(rulebookId).rulebook.updatedAt).toBe(before)
  })

  test('reports a malformed document as invalid', async () => {
    const { app } = setup()
    const response = await app.request('/api/v1/rulebooks/validate-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', applicableSpec: 'ts11@1.0.1' }),
    })
    expect(response.status).toBe(200)
    const body = await json<{ data: DraftValidationResource }>(response)
    assertSchema('DraftValidationResponse', body)
    expect(body.data.valid).toBe(false)
    expect(body.data.diagnostics[0]?.severity).toBe('error')
  })

  test('rejects a non-JSON body with the shared error envelope', async () => {
    const { app } = setup()
    const response = await app.request('/api/v1/rulebooks/validate-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(response.status).toBe(400)
    expect((await errorJson(response)).error.code).toBe('invalid_request')
  })
})
