// HTTP contract tests for hosted-schema issuer fixtures (#102).
//
// The route is exercised through the real Hono application and a real
// temporary SQLite registry. A canonical hosted reference is resolved from the
// immutable local store by the application wiring, with no network and no
// caller-supplied `schemaDocuments`.

import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'

import { createApp } from '../app'
import { IssuerFixtureGenerator } from '../fixtures'
import { credentialSchemaDocumentUrl, sha256Sri as sriForDigest } from '../public-urls'
import { provisionProvider } from '../registry/bootstrap'
import type { AuthenticatedActor, CredentialSchemaDocument } from '../registry/types'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import type { HostedSchemaDocumentStore } from '../validation/hosted-schema'
import {
  PID_TYPE_METADATA_TEXT,
  seedPublishedRulebook,
  sha256Sri,
} from '../validation/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'

const PUBLIC_BASE_URL = 'https://schemas.example'
const MISSING_DOCUMENT_ID = '44444444-4444-4444-8444-444444444444'
const EXTERNAL_SCHEMA_URI = 'https://example.org/schemas/external.json'

const HOSTED_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['family_name'],
  properties: {
    family_name: { type: 'string', minLength: 1, maxLength: 60 },
    age: { type: 'integer', minimum: 18, maximum: 120 },
    nickname: { type: 'string', minLength: 1, maxLength: 20 },
  },
})

const EXTERNAL_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['nickname'],
  properties: {
    family_name: { type: 'string', minLength: 1, maxLength: 60 },
    age: { type: 'integer', minimum: 18, maximum: 120 },
    nickname: { type: 'string', minLength: 1, maxLength: 20 },
  },
})

interface Setup {
  readonly fixture: RegistryFixture
  readonly app: ReturnType<typeof createApp>
  readonly document: CredentialSchemaDocument
  readonly hostedUri: string
  readonly rulebookId: string
  readonly version: string
  readonly attestationName: string
}

let active: RegistryFixture | undefined

afterEach(() => {
  active?.cleanup()
  active = undefined
})

async function registerHosted(
  fixture: RegistryFixture,
  actor: AuthenticatedActor,
  kind: 'json_schema_2020_12' | 'sd_jwt_vc_type_metadata' = 'json_schema_2020_12',
): Promise<CredentialSchemaDocument> {
  return fixture.registry.registerCredentialSchemaDocument(actor, {
    kind,
    bytes: new TextEncoder().encode(
      kind === 'json_schema_2020_12' ? HOSTED_SCHEMA_TEXT : PID_TYPE_METADATA_TEXT,
    ),
    provenance: { source: 'hosted-fixture-api-test' },
  })
}

function createHostedApp(
  fixture: RegistryFixture,
  options: {
    readonly store?: HostedSchemaDocumentStore
    readonly withPublicBaseUrl?: boolean
  } = {},
): ReturnType<typeof createApp> {
  if (options.store === undefined) {
    return createApp({
      registry: fixture.registry,
      ...(options.withPublicBaseUrl === false ? {} : { publicBaseUrl: PUBLIC_BASE_URL }),
    })
  }
  return createApp({
    registry: fixture.registry,
    issuerFixtures: new IssuerFixtureGenerator({
      source: fixture.registry,
      hostedSchemas: { publicBaseUrl: PUBLIC_BASE_URL, store: options.store },
    }),
  })
}

async function setup(
  options: {
    readonly kind?: 'json_schema_2020_12' | 'sd_jwt_vc_type_metadata'
    readonly integrity?: string | null
    readonly store?: HostedSchemaDocumentStore
    readonly withPublicBaseUrl?: boolean
  } = {},
): Promise<Setup> {
  const fixture = createRegistryFixture()
  active = fixture
  const provider = provisionProvider(fixture.database, {
    name: 'Hosted fixture API provider',
    publicationAuthority: 'hosted-fixture-api',
  })
  const document = await registerHosted(fixture, provider.actor, options.kind)
  const hostedUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, document.id)
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry, {
    authority: 'hosted-fixture-api-rulebook',
    schemaUri: hostedUri,
    schemaContent:
      options.kind === 'sd_jwt_vc_type_metadata' ? PID_TYPE_METADATA_TEXT : HOSTED_SCHEMA_TEXT,
    ...(options.integrity === undefined ? {} : { schemaIntegrity: options.integrity }),
  })
  return {
    fixture,
    app: createHostedApp(fixture, {
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.withPublicBaseUrl === undefined
        ? {}
        : { withPublicBaseUrl: options.withPublicBaseUrl }),
    }),
    document,
    hostedUri,
    rulebookId: seeded.rulebookId,
    version: seeded.version,
    attestationName: seeded.attestationName,
  }
}

function body(setupFixture: Setup, extra: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    rulebookId: setupFixture.rulebookId,
    rulebookVersion: setupFixture.version,
    attestationType: setupFixture.attestationName,
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

describe('POST /api/v1/issuers/fixtures with hosted schemas', () => {
  test('generates a fixture from the hosted store without schemaDocuments', async () => {
    const setupFixture = await setup()
    const response = await post(setupFixture.app, body(setupFixture))

    expect(response.status).toBe(200)
    const parsed = (await response.json()) as {
      data: {
        signed: boolean
        issued: boolean
        schemaReferences: Record<string, unknown>[]
        payload: Record<string, unknown>
        payloadValidation: { status: string }
      }
    }
    assertSchema('IssuerFixtureResponse', parsed)
    expect(parsed.data.signed).toBe(false)
    expect(parsed.data.issued).toBe(false)
    expect(parsed.data.schemaReferences).toHaveLength(1)
    expect(parsed.data.schemaReferences[0]).toMatchObject({
      uri: setupFixture.hostedUri,
      source: 'hosted',
      kind: 'json_schema',
      applied: true,
      integrityVerified: true,
    })
    expect(parsed.data.payloadValidation.status).toBe('PASS')
    expect(typeof parsed.data.payload['family_name']).toBe('string')
  })

  test('answers 400 with an explicit diagnostic when the hosted document is missing', async () => {
    const setupFixture = await setup()
    const missingUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, MISSING_DOCUMENT_ID)
    const missing = seedPublishedRulebook(
      setupFixture.fixture.database,
      setupFixture.fixture.registry,
      {
        authority: 'hosted-fixture-api-missing',
        schemaUri: missingUri,
        schemaContent: HOSTED_SCHEMA_TEXT,
      },
    )
    const response = await post(
      setupFixture.app,
      body(setupFixture, {
        rulebookId: missing.rulebookId,
        rulebookVersion: missing.version,
        attestationType: missing.attestationName,
      }),
    )

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string; message: string } }
    assertSchema('ErrorEnvelope', parsed)
    expect(parsed.error.code).toBe('invalid_request')
    expect(parsed.error.message).toContain('not present in the local schema store')
  })

  test('answers 400 when the stored bytes no longer match their recorded digest', async () => {
    const tampered: { document?: CredentialSchemaDocument } = {}
    const setupFixture = await setup({
      store: {
        getCredentialSchemaDocumentContent: () => ({
          document: tampered.document as CredentialSchemaDocument,
          bytes: new TextEncoder().encode('{"type":"object"}'),
        }),
      },
    })
    tampered.document = setupFixture.document
    const response = await post(setupFixture.app, body(setupFixture))

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string; message: string } }
    assertSchema('ErrorEnvelope', parsed)
    expect(parsed.error.code).toBe('invalid_request')
    expect(parsed.error.message).toContain('recorded SHA-256 digest')
  })

  test('answers 400 when the hosted reference SRI does not match', async () => {
    const setupFixture = await setup({ integrity: sriForDigest('0'.repeat(64)) })
    const response = await post(setupFixture.app, body(setupFixture))

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('invalid_request')
    expect(parsed.error.message).toContain('pinned rulebook sha256 integrity value')
  })

  test('answers 400 when a hosted reference is only non-synthesizable Type Metadata', async () => {
    const setupFixture = await setup({ kind: 'sd_jwt_vc_type_metadata' })
    const response = await post(setupFixture.app, body(setupFixture))

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string; message: string } }
    assertSchema('ErrorEnvelope', parsed)
    expect(parsed.error.code).toBe('invalid_request')
    expect(parsed.error.message).toContain('Type Metadata')
  })

  test('keeps caller documents for external references in a mixed version', async () => {
    const setupFixture = await setup()
    const provider = provisionProvider(setupFixture.fixture.database, {
      name: 'Mixed hosted API provider',
      publicationAuthority: 'mixed-hosted-api',
    })
    const externalDocument = await setupFixture.fixture.registry.registerCredentialSchemaDocument(
      provider.actor,
      {
        kind: 'json_schema_2020_12',
        bytes: new TextEncoder().encode(EXTERNAL_SCHEMA_TEXT),
        provenance: { source: 'hosted-fixture-api-test' },
      },
    )
    expect(externalDocument.kind).toBe('json_schema_2020_12')
    const rulebook = setupFixture.fixture.registry.createRulebook(provider.actor, {
      name: 'Mixed hosted API rulebook',
      description: 'One hosted and one external reference',
      applicableSpec: 'ts11@1.0.1',
      attestations: [
        {
          name: 'PID',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
        },
      ],
    })
    const attestation = setupFixture.fixture.registry
      .listAttestations(rulebook.id)
      .find((candidate) => candidate.name === 'PID')
    if (attestation === undefined) {
      throw new Error('test setup failed to create the attestation type')
    }
    setupFixture.fixture.registry.addSchemaReference(provider.actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: setupFixture.hostedUri,
      integrity: sha256Sri(HOSTED_SCHEMA_TEXT),
      attestationId: attestation.id,
    })
    setupFixture.fixture.registry.addSchemaReference(provider.actor, rulebook.id, {
      formatIdentifier: 'mso_mdoc',
      uri: EXTERNAL_SCHEMA_URI,
      integrity: sha256Sri(EXTERNAL_SCHEMA_TEXT),
      attestationId: attestation.id,
    })
    const version = setupFixture.fixture.registry.createRulebookVersion(
      provider.actor,
      rulebook.id,
      {
        version: '1.0',
      },
    )
    setupFixture.fixture.registry.publishRulebookVersion(provider.actor, rulebook.id, '1.0')
    const mixedBody = {
      rulebookId: rulebook.id,
      rulebookVersion: version.version,
      attestationType: 'PID',
    }

    const withoutExternal = await post(setupFixture.app, mixedBody)
    expect(withoutExternal.status).toBe(200)
    const withoutParsed = (await withoutExternal.json()) as {
      data: {
        schemaReferences: Record<string, unknown>[]
        diagnostics: { code: string }[]
      }
    }
    expect(withoutParsed.data.schemaReferences).toHaveLength(2)
    expect(withoutParsed.data.schemaReferences[0]).toMatchObject({
      uri: setupFixture.hostedUri,
      source: 'hosted',
      applied: true,
    })
    expect(withoutParsed.data.schemaReferences[1]).toMatchObject({
      uri: EXTERNAL_SCHEMA_URI,
      source: null,
      applied: false,
    })
    expect(withoutParsed.data.diagnostics.map((entry) => entry.code)).toContain(
      'schema_document_not_supplied',
    )

    const mixedResponse = await post(setupFixture.app, {
      ...mixedBody,
      schemaDocuments: [{ uri: EXTERNAL_SCHEMA_URI, content: EXTERNAL_SCHEMA_TEXT }],
    })
    expect(mixedResponse.status).toBe(200)
    const mixedParsed = (await mixedResponse.json()) as {
      data: { schemaReferences: Record<string, unknown>[]; payload: Record<string, unknown> }
    }
    expect(mixedParsed.data.schemaReferences).toHaveLength(2)
    expect(mixedParsed.data.schemaReferences[0]).toMatchObject({
      uri: setupFixture.hostedUri,
      source: 'hosted',
      applied: true,
    })
    expect(mixedParsed.data.schemaReferences[1]).toMatchObject({
      uri: EXTERNAL_SCHEMA_URI,
      source: 'caller',
      applied: true,
    })
    expect(typeof mixedParsed.data.payload['nickname']).toBe('string')
  })

  test('treats a hosted URL as external when the app has no public origin', async () => {
    const setupFixture = await setup({ withPublicBaseUrl: false })
    const response = await post(setupFixture.app, body(setupFixture))

    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('invalid_request')
    expect(parsed.error.message).toContain('No document was supplied')
  })
})
