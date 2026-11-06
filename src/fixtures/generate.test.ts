// Unit tests for rulebook-driven issuer fixtures (FR-013, issue #44).
//
// The tests use a real migrated SQLite registry, a real published version
// snapshot and the real schema preparation/Ajv evaluation. The schema is a
// plain, local JSON Schema 2020-12 document; nothing is fetched and no real
// credential, key or personal data is involved.

import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'

import { provisionProvider } from '../registry/bootstrap'
import { invalidInput } from '../registry/errors'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { PID_TYPE_METADATA_TEXT, sha256Sri, TEST_VCT } from '../validation/test-support'

import { IssuerFixtureGenerator } from './generate'
import { ISSUER_FIXTURE_KIND } from './types'

const SCHEMA_URI = 'https://schemas.example.test/pid-claims.json'
const OTHER_SCHEMA_URI = 'https://schemas.example.test/other-claims.json'

const CLAIMS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['given_name', 'family_name', 'age', 'nationalities'],
  properties: {
    given_name: { type: 'string', minLength: 1, maxLength: 64 },
    family_name: { type: 'string', minLength: 1, maxLength: 64 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    email: { type: 'string', maxLength: 100 },
    nationalities: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string', enum: ['IT', 'DE'] },
    },
    address: {
      type: 'object',
      additionalProperties: false,
      required: ['locality'],
      properties: {
        locality: { type: 'string', minLength: 1 },
        postal_code: { type: 'string', maxLength: 10 },
      },
    },
    newsletter: { type: 'boolean' },
  },
}

const CLAIMS_SCHEMA_TEXT = JSON.stringify(CLAIMS_SCHEMA)

interface SchemaDocumentFixture {
  readonly format: string
  readonly uri: string
  readonly content: string
  readonly integrity?: string
}

interface Setup {
  readonly fixture: RegistryFixture
  readonly generator: IssuerFixtureGenerator
  readonly rulebookId: string
  readonly version: string
  readonly attestationName: string
  readonly documents: readonly SchemaDocumentFixture[]
  request(extra?: Readonly<Record<string, unknown>>): Record<string, unknown>
}

const fixtures: RegistryFixture[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup()
  }
})

function setup(
  options: {
    readonly documents?: readonly SchemaDocumentFixture[]
    readonly supportedFormats?: readonly string[]
  } = {},
): Setup {
  const fixture = createRegistryFixture()
  fixtures.push(fixture)
  const provider = provisionProvider(fixture.database, {
    name: 'Fixture Provider',
    publicationAuthority: 'fixture-authority',
  })
  const token = provider.token.secret
  const attestationName = 'PID'
  const documents = options.documents ?? [
    { format: 'dc+sd-jwt', uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT },
  ]
  const rulebook = fixture.registry.createRulebook(token, {
    name: 'PID Rulebook',
    description: 'Fixture rulebook for issuer fixture tests',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: attestationName,
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: options.supportedFormats ?? ['dc+sd-jwt'],
      },
    ],
  })
  const attestation = fixture.registry
    .listAttestations(rulebook.id)
    .find((candidate) => candidate.name === attestationName)
  if (attestation === undefined) {
    throw new Error('test setup failed to create the attestation type')
  }
  for (const document of documents) {
    fixture.registry.addSchemaReference(token, rulebook.id, {
      formatIdentifier: document.format,
      uri: document.uri,
      integrity: document.integrity ?? sha256Sri(document.content),
      attestationId: attestation.id,
    })
  }
  const version = fixture.registry.createRulebookVersion(token, rulebook.id, { version: '1.0' })
  fixture.registry.publishRulebookVersion(token, rulebook.id, '1.0')

  const generator = new IssuerFixtureGenerator({ source: fixture.registry })
  return {
    fixture,
    generator,
    rulebookId: rulebook.id,
    version: version.version,
    attestationName,
    documents,
    request(extra = {}) {
      return {
        rulebookId: rulebook.id,
        rulebookVersion: version.version,
        attestationType: attestationName,
        schemaDocuments: documents.map((document) => ({
          uri: document.uri,
          content: document.content,
        })),
        ...extra,
      }
    },
  }
}

function expectInvalidInput(run: () => unknown): void {
  try {
    run()
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe(invalidInput('x').code)
    return
  }
  throw new Error('expected an invalid_input failure')
}

const ajv = new Ajv2020({ strict: false, validateFormats: false })

describe('IssuerFixtureGenerator', () => {
  test('generates an unsigned payload grounded in the rulebook schema constraints', () => {
    const setupFixture = setup()
    const result = setupFixture.generator.generate(setupFixture.request())

    expect(result.kind).toBe(ISSUER_FIXTURE_KIND)
    expect(result.signed).toBe(false)
    expect(result.issued).toBe(false)
    expect(result.rulebook).toMatchObject({
      id: setupFixture.rulebookId,
      version: '1.0',
      digestVerified: true,
      specVersion: 'ts11@1.0.1',
      status: 'published',
    })
    expect(result.formats).toEqual(['dc+sd-jwt'])
    expect(result.schemaReferences).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: SCHEMA_URI,
        integrity: sha256Sri(CLAIMS_SCHEMA_TEXT),
        integrityVerified: true,
        kind: 'json_schema',
        applied: true,
      },
    ])
    expect(result.payloadValidation).toEqual({ status: 'PASS', findings: [] })

    const validate = ajv.compile(CLAIMS_SCHEMA)
    expect(validate(result.payload), JSON.stringify(validate.errors)).toBe(true)

    const givenName = result.attributes.find((attribute) => attribute.pointer === '/given_name')
    expect(givenName).toMatchObject({
      name: 'given_name',
      required: true,
      generated: true,
      types: ['string'],
    })
    expect(givenName?.constraints).toMatchObject({ minLength: 1, maxLength: 64 })

    const age = result.payload.age
    expect(typeof age).toBe('number')
    expect(Number.isInteger(age)).toBe(true)
    expect(age).toBeGreaterThanOrEqual(0)
    expect(age).toBeLessThanOrEqual(150)

    const nationalities = result.payload.nationalities
    expect(Array.isArray(nationalities)).toBe(true)
    expect((nationalities as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect((nationalities as unknown[]).length).toBeLessThanOrEqual(3)

    const address = result.payload.address as Record<string, unknown>
    expect(typeof address['locality']).toBe('string')
  })

  test('is deterministic for the same pinned version and schema documents', () => {
    const setupFixture = setup()
    const first = setupFixture.generator.generate(setupFixture.request())
    const second = setupFixture.generator.generate(setupFixture.request())
    expect(second).toEqual(first)
  })

  test('applies selected attribute overrides without losing the unsigned marker', () => {
    const setupFixture = setup()
    const result = setupFixture.generator.generate(
      setupFixture.request({
        overrides: [
          { path: '/given_name', value: 'Ada' },
          { path: '/age', value: 42 },
          { path: '/address/locality', value: 'Rome' },
        ],
      }),
    )

    expect(result.payload).toMatchObject({
      given_name: 'Ada',
      age: 42,
      address: { locality: 'Rome' },
    })
    expect(result.overrides).toEqual([
      { path: '/given_name', value: 'Ada', applied: true },
      { path: '/age', value: 42, applied: true },
      { path: '/address/locality', value: 'Rome', applied: true },
    ])
    expect(result.payloadValidation.status).toBe('PASS')
    expect(result.signed).toBe(false)
    expect(result.issued).toBe(false)
  })

  test('reports overrides that violate a constraint without pretending the payload is valid', () => {
    const setupFixture = setup()
    const result = setupFixture.generator.generate(
      setupFixture.request({ overrides: [{ path: '/age', value: 'not-a-number' }] }),
    )

    expect(result.payloadValidation.status).toBe('FAIL')
    expect(result.payloadValidation.findings.length).toBeGreaterThan(0)
    expect(result.payloadValidation.findings[0]).toMatchObject({
      path: '/age',
      keyword: 'type',
    })
    expect(result.payload.age).toBe('not-a-number')
  })

  test('rejects an override path that does not exist in the generated payload', () => {
    const setupFixture = setup()
    expectInvalidInput(() =>
      setupFixture.generator.generate(
        setupFixture.request({ overrides: [{ path: '/not_generated', value: true }] }),
      ),
    )
  })

  test('derives labelled negative cases that reproducibly fail the supplied schema', () => {
    const setupFixture = setup()
    const result = setupFixture.generator.generate(setupFixture.request())

    expect(result.negativeCases.length).toBeGreaterThanOrEqual(6)
    const ids = new Set<string>()
    const validate = ajv.compile(CLAIMS_SCHEMA)
    for (const negativeCase of result.negativeCases) {
      expect(negativeCase.expected).toBe('FAIL')
      expect(negativeCase.label.length).toBeGreaterThan(0)
      expect(negativeCase.id).toBe(`${negativeCase.category}:${negativeCase.path}`)
      expect(ids.has(negativeCase.id)).toBe(false)
      ids.add(negativeCase.id)
      expect(validate(negativeCase.payload), negativeCase.label).toBe(false)
    }
    const categories = new Set(result.negativeCases.map((entry) => entry.category))
    expect(categories.has('missing_required')).toBe(true)
    expect(categories.has('type')).toBe(true)
    expect(categories.has('enum')).toBe(true)
    expect(categories.has('max_length')).toBe(true)
    expect(categories.has('additional_properties')).toBe(true)

    const repeated = setupFixture.generator.generate(setupFixture.request())
    expect(repeated.negativeCases).toEqual(result.negativeCases)
  })

  test('omits optional attributes whose constraints cannot be synthesized', () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        nickname: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    })
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: OTHER_SCHEMA_URI, content: schema }],
    })
    const result = setupFixture.generator.generate(setupFixture.request())

    expect(result.payload).toEqual({ name: expect.any(String) })
    const nickname = result.attributes.find((attribute) => attribute.pointer === '/nickname')
    expect(nickname).toMatchObject({ generated: false, required: false })
    expect(nickname?.reason).toContain('oneOf')
    expect(result.payloadValidation.status).toBe('PASS')
  })

  test('synthesizes enum and const attributes that omit the type keyword', () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['country', 'version'],
      properties: {
        country: { enum: ['IT', 'DE'] },
        version: { const: 1 },
        marketing_consent: { enum: [true, false] },
      },
    })
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: OTHER_SCHEMA_URI, content: schema }],
    })
    const result = setupFixture.generator.generate(setupFixture.request())

    expect(result.payload).toEqual({
      country: 'IT',
      version: 1,
      marketing_consent: true,
    })
    expect(result.payloadValidation.status).toBe('PASS')
  })

  test('does not leak attribute definitions from an omitted unsupported object', () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        address: {
          type: 'object',
          required: ['locality'],
          properties: {
            locality: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
      },
    })
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: OTHER_SCHEMA_URI, content: schema }],
    })
    const result = setupFixture.generator.generate(setupFixture.request())

    expect(Object.keys(result.payload)).toEqual(['name'])
    expect(typeof result.payload.name).toBe('string')
    expect(result.attributes.some((attribute) => attribute.pointer.startsWith('/address/'))).toBe(
      false,
    )
    const address = result.attributes.find((attribute) => attribute.pointer === '/address')
    expect(address).toMatchObject({ generated: false, required: false })
  })

  test('rejects a required attribute whose constraints cannot be synthesized', () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: {
        name: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    })
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: OTHER_SCHEMA_URI, content: schema }],
    })
    expectInvalidInput(() => setupFixture.generator.generate(setupFixture.request()))
  })

  test('rejects a rulebook that only references SD-JWT VC Type Metadata', () => {
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: TEST_VCT, content: PID_TYPE_METADATA_TEXT }],
    })
    expectInvalidInput(() => setupFixture.generator.generate(setupFixture.request()))
  })

  test('selects only the schema references of the requested format', () => {
    const mdocSchema = JSON.stringify({
      type: 'object',
      required: ['age_over_18'],
      properties: { age_over_18: { type: 'boolean' } },
    })
    const setupFixture = setup({
      supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      documents: [
        { format: 'dc+sd-jwt', uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT },
        { format: 'mso_mdoc', uri: OTHER_SCHEMA_URI, content: mdocSchema },
      ],
    })
    const result = setupFixture.generator.generate(
      setupFixture.request({
        format: 'mso_mdoc',
        schemaDocuments: [{ uri: OTHER_SCHEMA_URI, content: mdocSchema }],
      }),
    )

    expect(result.formats).toEqual(['mso_mdoc'])
    expect(result.payload).toEqual({ age_over_18: false })
    expect(result.schemaReferences).toHaveLength(1)
    expect(result.schemaReferences[0]).toMatchObject({
      formatIdentifier: 'mso_mdoc',
      applied: true,
    })
  })

  test('rejects a mismatched schema integrity value', () => {
    const setupFixture = setup({
      documents: [
        {
          format: 'dc+sd-jwt',
          uri: SCHEMA_URI,
          content: CLAIMS_SCHEMA_TEXT,
          integrity: `sha256-${Buffer.from('wrong bytes').toString('base64')}`,
        },
      ],
    })
    expectInvalidInput(() => setupFixture.generator.generate(setupFixture.request()))
  })

  test('rejects a schema URI the selected attestation type does not reference', () => {
    const setupFixture = setup()
    expectInvalidInput(() =>
      setupFixture.generator.generate(
        setupFixture.request({
          schemaDocuments: [{ uri: OTHER_SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT }],
        }),
      ),
    )
  })

  test('rejects an unknown rulebook, version or attestation type', () => {
    const setupFixture = setup()
    expect(() =>
      setupFixture.generator.generate(setupFixture.request({ rulebookId: 'missing' })),
    ).toThrow()
    expect(() =>
      setupFixture.generator.generate(setupFixture.request({ rulebookVersion: '9.9' })),
    ).toThrow()
    expect(() =>
      setupFixture.generator.generate(setupFixture.request({ attestationType: 'missing' })),
    ).toThrow()
  })

  test('requires at least one schema document', () => {
    const setupFixture = setup()
    expectInvalidInput(() =>
      setupFixture.generator.generate(setupFixture.request({ schemaDocuments: [] })),
    )
  })
})
