// HTTP contract tests for the issuer fixture-generation route (FR-013, #44).
//
// The route is exercised through the real Hono application and a real
// temporary SQLite registry. Fixture generation is local and synchronous, so
// the tests need no network or service double.

import { afterEach, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'

import { createApp } from '../app'
import { IssuerFixtureGenerator } from '../fixtures'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import type { SchemaSandboxLimits } from '../validation/schema-sandbox'
import { sha256Sri } from '../validation/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'

const SCHEMA_URI = 'https://schemas.example.test/http-claims.json'
const CLAIMS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 40 },
    age: { type: 'integer', minimum: 18, maximum: 120 },
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

function setup(
  options: {
    readonly sandbox?: SchemaSandboxLimits
    readonly schemaContent?: string
  } = {},
): Setup {
  fixture = createRegistryFixture()
  const schemaContent = options.schemaContent ?? SCHEMA_TEXT
  const provider = provisionProvider(fixture.database, {
    name: 'Fixture Provider',
    publicationAuthority: 'fixture-authority',
  })
  const token = provider.token.secret
  const rulebook = fixture.registry.createRulebook(token, {
    name: 'HTTP Fixture Rulebook',
    description: 'HTTP fixture rulebook',
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
    app: createApp({
      registry: fixture.registry,
      ...(options.sandbox === undefined
        ? {}
        : {
            issuerFixtures: new IssuerFixtureGenerator({
              source: fixture.registry,
              sandbox: options.sandbox,
            }),
          }),
    }),
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
  return app.request('/api/v1/issuers/fixtures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('POST /api/v1/issuers/fixtures', () => {
  test('returns an unsigned fixture with attribute definitions and negative cases', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, body(setupFixture))

    expect(response.status).toBe(200)
    const parsed = (await response.json()) as { data: Record<string, unknown> }
    assertSchema('IssuerFixtureResponse', parsed)
    expect(parsed.data).toMatchObject({
      kind: 'attestbook.unsigned-issuer-fixture@1',
      signed: false,
      issued: false,
      formats: ['dc+sd-jwt'],
      payloadValidation: { status: 'PASS' },
      rulebook: { id: setupFixture.rulebookId, version: '1.0' },
    })
    expect(Array.isArray(parsed.data['attributes'])).toBe(true)
    expect((parsed.data['negativeCases'] as unknown[]).length).toBeGreaterThan(0)
  })

  test('applies overrides from the request', async () => {
    const setupFixture = setup()
    const response = await post(
      setupFixture.app,
      body(setupFixture, { overrides: [{ path: '/name', value: 'Ada' }] }),
    )

    expect(response.status).toBe(200)
    const parsed = (await response.json()) as {
      data: { payload: Record<string, unknown>; overrides: unknown[] }
    }
    expect(parsed.data.payload['name']).toBe('Ada')
    expect(parsed.data.overrides).toEqual([{ path: '/name', value: 'Ada', applied: true }])
  })

  test('rejects a malformed request body with invalid_request', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, { rulebookId: 'only-one-field' })

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string } }
    expect(parsed.error.code).toBe('invalid_request')
  })

  test('rejects a request without schema documents', async () => {
    const setupFixture = setup()
    const withoutDocuments = { ...(body(setupFixture) as Record<string, unknown>) }
    delete withoutDocuments['schemaDocuments']
    const response = await post(setupFixture.app, withoutDocuments)

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string } }
    expect(parsed.error.code).toBe('invalid_request')
  })

  test('answers 404 for an unknown rulebook version', async () => {
    const setupFixture = setup()
    const response = await post(setupFixture.app, body(setupFixture, { rulebookVersion: '9.9' }))

    expect(response.status).toBe(404)
    const parsed = (await response.json()) as { error: { code: string } }
    expect(parsed.error.code).toBe('not_found')
  })

  test('answers 503 when the generator is not configured', async () => {
    const response = await post(createApp(), {
      rulebookId: 'rulebook',
      rulebookVersion: '1.0',
      attestationType: 'PID',
      schemaDocuments: [{ uri: SCHEMA_URI, content: SCHEMA_TEXT }],
    })

    expect(response.status).toBe(503)
    const parsed = (await response.json()) as { error: { code: string } }
    expect(parsed.error.code).toBe('registry_unavailable')
  })

  test('answers fixture_unavailable when the sandbox cannot run', async () => {
    const setupFixture = setup({ sandbox: { platform: 'darwin' } })
    const response = await post(setupFixture.app, body(setupFixture))

    expect(response.status).toBe(503)
    const parsed = (await response.json()) as { error: { code: string; message: string } }
    assertSchema('ErrorEnvelope', parsed)
    expect(parsed.error.code).toBe('fixture_unavailable')
    expect(parsed.error.message).toContain('unavailable')
  })

  test('rejects a schema document that declares a __proto__ property', async () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['__proto__', 'b'],
      properties: {
        ['__proto__']: {
          type: 'object',
          required: ['x'],
          properties: { x: { type: 'string' } },
        },
        b: { type: 'string' },
      },
    })
    const setupFixture = setup({ schemaContent: schema })
    const response = await post(setupFixture.app, body(setupFixture))

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string } }
    assertSchema('ErrorEnvelope', parsed)
    expect(parsed.error.code).toBe('invalid_request')
  })

  test('rejects an empty-name required claim the evaluator cannot enforce', async () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['address'],
      properties: {
        address: {
          type: 'object',
          required: ['', 'city'],
          properties: {
            '': { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    })
    const setupFixture = setup({ schemaContent: schema })
    const response = await post(
      setupFixture.app,
      body(setupFixture, {
        overrides: [{ path: '/address', value: { city: 'x' } }],
      }),
    )

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string } }
    assertSchema('ErrorEnvelope', parsed)
    expect(parsed.error.code).toBe('invalid_request')
  })

  test('rejects an undeclared __proto__ key in an HTTP override value', async () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['address'],
      properties: {
        address: {
          type: 'object',
          required: ['city'],
          properties: { city: { type: 'string' } },
          additionalProperties: false,
        },
      },
    })
    const setupFixture = setup({ schemaContent: schema })
    // The raw JSON keeps __proto__ as an own override key; an object literal
    // would set the prototype instead.
    const raw = `{"rulebookId":${JSON.stringify(setupFixture.rulebookId)},"rulebookVersion":${JSON.stringify(setupFixture.version)},"attestationType":${JSON.stringify(setupFixture.attestationName)},"schemaDocuments":[{"uri":${JSON.stringify(SCHEMA_URI)},"content":${JSON.stringify(setupFixture.schemaContent)}}],"overrides":[{"path":"/address","value":{"city":"x","__proto__":5}}]}`
    const response = await setupFixture.app.request('/api/v1/issuers/fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    })

    expect(response.status).toBe(200)
    const parsed = (await response.json()) as {
      data: {
        payloadValidation: {
          status: string
          findings: { keyword?: string; path?: string }[]
        }
      }
    }
    expect(parsed.data.payloadValidation.status).toBe('FAIL')
    expect(parsed.data.payloadValidation.findings[0]).toMatchObject({
      keyword: 'additionalProperties',
      path: '/address',
    })
  })

  test('keeps /health responsive while fixture generation runs in the sandbox', async () => {
    const slowEntry = fileURLToPath(
      new URL('../validation/test-fixtures/slow-entry.ts', import.meta.url),
    )
    const setupFixture = setup({
      sandbox: { entry: slowEntry, timeoutMs: 1_000 },
    })

    const generation = post(setupFixture.app, body(setupFixture))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const healthStarted = Date.now()
    const healthPromise = Promise.resolve(setupFixture.app.request('/health'))
    const winner = await Promise.race([
      healthPromise.then(() => 'health' as const),
      generation.then(() => 'fixture' as const),
    ])
    expect(winner).toBe('health')
    const health = await healthPromise
    expect(health.status).toBe(200)
    expect(Date.now() - healthStarted).toBeLessThan(200)

    const response = await generation
    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('invalid_request')
    expect(parsed.error.message).toContain('1000 ms')
  })
})
