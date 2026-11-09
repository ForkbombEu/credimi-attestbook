// HTTP contract tests for the verifier-constraint route (FR-014, #45).
//
// The route is exercised through the real Hono application and a real temporary
// SQLite registry. Constraint inspection is local and synchronous, so the tests
// need no network or service double.

import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'

import { createApp } from '../app'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { sha256Sri } from '../validation/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'

const SCHEMA_URI = 'https://schemas.example.test/http-verifier.json'
const CLAIMS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 40 },
    age: { type: 'integer', minimum: 18, maximum: 120 },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
  },
}
const SCHEMA_TEXT = JSON.stringify(CLAIMS_SCHEMA)

interface Setup {
  readonly fixture: RegistryFixture
  readonly app: ReturnType<typeof createApp>
  readonly rulebookId: string
  readonly attestationName: string
  readonly version: string
  readonly schemaContent: string
}

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup(options: { readonly schemaContent?: string } = {}): Setup {
  fixture = createRegistryFixture()
  const schemaContent = options.schemaContent ?? SCHEMA_TEXT
  const provider = provisionProvider(fixture.database, {
    name: 'Verifier HTTP Provider',
    publicationAuthority: 'verifier-http-authority',
  })
  const token = provider.token.secret
  const rulebook = fixture.registry.createRulebook(token, {
    name: 'HTTP Verifier Rulebook',
    description: 'HTTP verifier rulebook',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'PID',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
      },
    ],
  })
  const attestation = fixture.registry
    .listAttestations(rulebook.id)
    .find((candidate) => candidate.name === 'PID')
  if (attestation === undefined) {
    throw new Error('test setup failed to create the attestation type')
  }
  fixture.registry.addSchemaReference(token, rulebook.id, {
    formatIdentifier: 'dc+sd-jwt',
    uri: SCHEMA_URI,
    integrity: sha256Sri(schemaContent),
    attestationId: attestation.id,
  })
  const version = fixture.registry.createRulebookVersion(token, rulebook.id, { version: '1.0' })
  fixture.registry.publishRulebookVersion(token, rulebook.id, '1.0')

  return {
    fixture,
    app: createApp({ registry: fixture.registry }),
    rulebookId: rulebook.id,
    attestationName: 'PID',
    version: version.version,
    schemaContent,
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

function body(setupFixture: Setup, extra: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    rulebookId: setupFixture.rulebookId,
    rulebookVersion: setupFixture.version,
    attestationType: setupFixture.attestationName,
    schemaDocuments: [{ uri: SCHEMA_URI, content: setupFixture.schemaContent }],
    ...extra,
  }
}

async function post(app: ReturnType<typeof createApp>, payload: unknown): Promise<Response> {
  return app.request('/api/v1/verifiers/constraints', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('POST /api/v1/verifiers/constraints', () => {
  test('returns typed constraints and a partial DCQL mapping', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, body(setupFixture))
    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      data: Record<string, unknown>
    }
    assertSchema('VerifierConstraintsResponse', payload)

    const result = payload.data
    expect(result['kind']).toBe('attestbook.verifier-constraints@1')
    expect(result['nonClaims']).toEqual({
      presentationRequest: false,
      proof: false,
      cryptographicVerification: 'NOT_TESTED',
      protocolConformance: 'NOT_TESTED',
      interoperability: 'NOT_TESTED',
    })

    const formats = result['formats'] as readonly Record<string, unknown>[]
    const policy = formats[0]
    expect(policy?.['format']).toBe('dc+sd-jwt')
    expect(policy?.['grounding']).toBe('verified')
    const dcql = policy?.['dcql'] as Record<string, unknown>
    expect(dcql['complete']).toBe(false)
    expect(dcql['credentialQuery']).toEqual({
      id: 'credential-1',
      format: 'dc+sd-jwt',
      claims: [{ path: ['age'] }, { path: ['name'] }, { path: ['tags'] }],
    })

    const attributes = policy?.['attributes'] as readonly Record<string, unknown>[]
    expect(attributes.map((attribute) => attribute['pointer'])).toEqual([
      '/age',
      '/name',
      '/tags',
      '/tags/*',
    ])
    expect(attributes.find((attribute) => attribute['pointer'] === '/name')).toMatchObject({
      required: true,
      types: ['string'],
      constraints: { type: 'string', minLength: 1, maxLength: 40 },
    })

    const interfaces = result['policyInterfaces'] as readonly Record<string, unknown>[]
    expect(interfaces.map((entry) => [entry['id'], entry['status']])).toEqual([
      ['attestbook.attribute-constraints@1', 'supported'],
      ['openid4vp.dcql@1', 'partial'],
      ['openid4vp.presentation-exchange@1', 'unsupported'],
    ])
  })

  test('restricts the response when a format is selected', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, body(setupFixture, { format: 'dc+sd-jwt' }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { data: { formats: { format: string }[] } }
    expect(payload.data.formats.map((policy) => policy.format)).toEqual(['dc+sd-jwt'])
  })

  test('reports unsupported mappings instead of fabricating request members', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, body(setupFixture))
    const payload = (await response.json()) as {
      data: { formats: { dcql: { unsupported: { code: string }[] } }[] }
    }
    const codes = payload.data.formats[0]?.dcql.unsupported.map((entry) => entry.code) ?? []
    expect(codes).toContain('type_identifier_unavailable')
    expect(codes).toContain('value_constraint_not_expressible')
    expect(codes).toContain('proof_and_protocol_not_built')
  })

  test('exposes the constraints without documents and reports the missing grounding', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, body(setupFixture, { schemaDocuments: [] }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      data: {
        formats: {
          grounding: string
          attributes: unknown[]
          diagnostics: { code: string }[]
        }[]
      }
    }
    expect(payload.data.formats[0]?.grounding).toBe('not_supplied')
    expect(payload.data.formats[0]?.attributes).toEqual([])
    expect(payload.data.formats[0]?.diagnostics.map((entry) => entry.code)).toContain(
      'schema_document_not_supplied',
    )
  })

  test('rejects a malformed request body with invalid_request', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, { rulebookId: 1 })
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('invalid_request')
  })

  test('accepts schema members that shadow Object.prototype names', async () => {
    const schemaText = JSON.stringify({
      type: 'object',
      properties: { identifier: { type: 'string', toString: 1, constructor: {} } },
    })
    const setupFixture = setup({ schemaContent: schemaText })
    const response = await post(setupFixture.app, body(setupFixture))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    assertSchema('VerifierConstraintsResponse', payload)
    const data = payload['data'] as { formats: { attributes: { pointer: string }[] }[] }
    const identifier = data.formats
      .flatMap((policy) => policy.attributes)
      .find((attribute) => attribute.pointer === '/identifier')
    expect(identifier).toBeDefined()
  })

  test('rejects a schema document that does not match the pinned integrity', async () => {
    const setupFixture = setup()
    const response = await post(
      setupFixture.app,
      body(setupFixture, {
        schemaDocuments: [{ uri: SCHEMA_URI, content: '{"type":"object"}' }],
      }),
    )
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('invalid_request')
  })

  test('rejects a document URI the attestation type does not reference', async () => {
    const setupFixture = setup()
    const response = await post(
      setupFixture.app,
      body(setupFixture, {
        schemaDocuments: [
          { uri: 'https://schemas.example.test/unreferenced.json', content: SCHEMA_TEXT },
        ],
      }),
    )
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('invalid_request')
  })

  test('rejects a format the attestation type does not support', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, body(setupFixture, { format: 'mso_mdoc' }))
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('invalid_request')
  })

  test('answers 404 for an unknown rulebook version', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, body(setupFixture, { rulebookVersion: '9.9' }))
    expect(response.status).toBe(404)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('not_found')
  })

  test('answers 503 when the resolver is not configured', async () => {
    const app = createApp()
    const response = await post(app, {
      rulebookId: 'missing',
      rulebookVersion: '1.0',
      attestationType: 'PID',
    })
    expect(response.status).toBe(503)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('registry_unavailable')
  })
})
