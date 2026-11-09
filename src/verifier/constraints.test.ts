// Unit tests for rulebook-driven verifier constraints (FR-014, issue #45).
//
// The tests use a real migrated SQLite registry, a real published version
// snapshot and the real in-process JSON Schema inspector. No network request,
// credential, key or personal data is involved.

import { afterEach, describe, expect, test } from 'bun:test'

import { sha256Hex } from '../registry/digest'
import { provisionProvider } from '../registry/bootstrap'
import { invalidInput } from '../registry/errors'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import type { Rulebook } from '../registry/types'
import {
  RULEBOOK_VERSION_FORMAT,
  RULEBOOK_VERSION_MEDIA_TYPE,
  serializeRulebookVersion,
  type RulebookVersionDocument,
} from '../registry/versioning'
import { sha256Sri } from '../validation/test-support'

import { classifySchemaDocument, inspectJsonSchema } from './inspect'
import { VerifierPolicyResolver } from './resolve'
import { VERIFIER_CONSTRAINTS_KIND, type VerifierPolicySource } from './types'

const SCHEMA_URI = 'https://schemas.example.test/verifier-pid.json'
const OTHER_SCHEMA_URI = 'https://schemas.example.test/verifier-other.json'
const TYPE_METADATA_URI = 'https://schemas.example.test/verifier-pid-type-metadata.json'

const CLAIMS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['given_name', 'age', 'nationalities', 'address'],
  properties: {
    given_name: { type: 'string', minLength: 1, maxLength: 64 },
    family_name: { type: 'string', minLength: 1, maxLength: 64 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    email: { type: 'string', pattern: '^[^@]+@[^@]+$', format: 'email' },
    newsletter: { type: 'boolean' },
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
  },
}
const CLAIMS_SCHEMA_TEXT = JSON.stringify(CLAIMS_SCHEMA)

const TYPE_METADATA = {
  vct: 'urn:example:verifier:pid:1',
  claims: [{ path: ['given_name'] }, { path: ['age'] }],
}
const TYPE_METADATA_TEXT = JSON.stringify(TYPE_METADATA)

interface SchemaDocumentFixture {
  readonly format: string
  readonly uri: string
  readonly content: string
  readonly integrity?: string
}

interface Setup {
  readonly fixture: RegistryFixture
  readonly resolver: VerifierPolicyResolver
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
    name: 'Verifier Provider',
    publicationAuthority: 'verifier-authority',
  })
  const token = provider.token.secret
  const attestationName = 'PID'
  const documents = options.documents ?? [
    { format: 'dc+sd-jwt', uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT },
  ]
  const rulebook = fixture.registry.createRulebook(token, {
    name: 'PID Rulebook',
    description: 'Verifier constraint rulebook',
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
      integrity:
        document.integrity === undefined ? sha256Sri(document.content) : document.integrity,
      attestationId: attestation.id,
    })
  }
  const version = fixture.registry.createRulebookVersion(token, rulebook.id, { version: '1.0' })
  fixture.registry.publishRulebookVersion(token, rulebook.id, '1.0')

  return {
    fixture,
    resolver: new VerifierPolicyResolver({ source: fixture.registry }),
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

function findAttribute(
  result: ReturnType<VerifierPolicyResolver['resolve']>,
  pointer: string,
): Record<string, unknown> | undefined {
  for (const format of result.formats) {
    const attribute = format.attributes.find((candidate) => candidate.pointer === pointer)
    if (attribute !== undefined) {
      return attribute as unknown as Record<string, unknown>
    }
  }
  return undefined
}

function attributesAt(
  result: ReturnType<VerifierPolicyResolver['resolve']>,
  pointer: string,
): Record<string, unknown>[] {
  return result.formats.flatMap((policy) =>
    policy.attributes.filter((attribute) => attribute.pointer === pointer),
  ) as unknown as Record<string, unknown>[]
}

function formatPolicy(result: ReturnType<VerifierPolicyResolver['resolve']>, format: string) {
  const policy = result.formats.find((candidate) => candidate.format === format)
  if (policy === undefined) {
    throw new Error(`missing format policy ${format}`)
  }
  return policy
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

function expectNotFound(run: () => unknown): void {
  try {
    run()
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe('not_found')
    return
  }
  throw new Error('expected a not_found failure')
}

/**
 * A source whose stored snapshot has an unpinned reference. The registry
 * refuses to create one, so this reproduces a rulebook imported from a source
 * that declared a URI without a sha256 SRI value.
 */
function unpinnedSource(rulebook: Rulebook, version: string): VerifierPolicySource {
  const document: RulebookVersionDocument = {
    format: RULEBOOK_VERSION_FORMAT,
    rulebookId: rulebook.id,
    version,
    specVersion: 'ts11@1.0.1',
    name: rulebook.name,
    description: rulebook.description,
    sourceUrl: rulebook.sourceUrl,
    attestations: [
      {
        name: 'PID',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
        schemaReferences: [{ formatIdentifier: 'dc+sd-jwt', uri: SCHEMA_URI, integrity: null }],
      },
    ],
    schemaReferences: [],
  }
  const bytes = serializeRulebookVersion(document)
  const digest = sha256Hex(bytes)
  const versionRecord = {
    id: 'unpinned-version',
    rulebookId: rulebook.id,
    version,
    status: 'published' as const,
    contentDigest: digest,
    specVersion: 'ts11@1.0.1',
    provenance: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    publishedAt: '2026-01-01T00:00:00.000Z',
  }
  return {
    getRulebook: () => rulebook,
    getRulebookVersion: () => versionRecord,
    getRulebookVersionContent: () => ({
      version: versionRecord,
      mediaType: RULEBOOK_VERSION_MEDIA_TYPE,
      bytes,
    }),
  }
}

describe('VerifierPolicyResolver', () => {
  test('returns typed attribute constraints grounded in the pinned schema', () => {
    const setupFixture = setup()
    const result = setupFixture.resolver.resolve(setupFixture.request())

    expect(result.kind).toBe(VERIFIER_CONSTRAINTS_KIND)
    expect(result.rulebook).toMatchObject({
      id: setupFixture.rulebookId,
      version: '1.0',
      digestVerified: true,
      specVersion: 'ts11@1.0.1',
      status: 'published',
    })
    expect(result.attestation).toEqual({
      name: 'PID',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
      supportedFormats: ['dc+sd-jwt'],
    })

    const policy = formatPolicy(result, 'dc+sd-jwt')
    expect(policy.grounding).toBe('verified')
    expect(policy.schemaReferences).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: SCHEMA_URI,
        integrity: sha256Sri(CLAIMS_SCHEMA_TEXT),
        integrityVerified: true,
        kind: 'json_schema',
        inspected: true,
      },
    ])

    const givenName = findAttribute(result, '/given_name')
    expect(givenName).toMatchObject({
      pointer: '/given_name',
      name: 'given_name',
      required: true,
      types: ['string'],
      constraints: { type: 'string', minLength: 1, maxLength: 64 },
      sources: [SCHEMA_URI],
      claimPath: ['given_name'],
      claimPathSupported: true,
    })
    expect(findAttribute(result, '/family_name')).toMatchObject({
      required: false,
      claimPath: ['family_name'],
    })
    expect(findAttribute(result, '/age')).toMatchObject({
      required: true,
      types: ['integer'],
      constraints: { type: 'integer', minimum: 0, maximum: 150 },
    })
    expect(findAttribute(result, '/newsletter')).toMatchObject({
      required: false,
      types: ['boolean'],
    })
  })

  test('types nested object and array-item attributes with claim paths', () => {
    const setupFixture = setup()
    const result = setupFixture.resolver.resolve(setupFixture.request())

    expect(findAttribute(result, '/address')).toMatchObject({
      required: true,
      types: ['object'],
      claimPath: ['address'],
    })
    expect(findAttribute(result, '/address/locality')).toMatchObject({
      required: true,
      types: ['string'],
      constraints: { type: 'string', minLength: 1 },
      claimPath: ['address', 'locality'],
    })
    expect(findAttribute(result, '/address/postal_code')).toMatchObject({
      required: false,
      claimPath: ['address', 'postal_code'],
    })
    expect(findAttribute(result, '/nationalities')).toMatchObject({
      required: true,
      types: ['array'],
      constraints: { type: 'array', minItems: 1, maxItems: 3 },
      claimPath: ['nationalities'],
    })
    expect(findAttribute(result, '/nationalities/*')).toMatchObject({
      required: false,
      types: ['string'],
      constraints: { type: 'string', enum: ['IT', 'DE'] },
      claimPath: ['nationalities', null],
    })
  })

  test('reports unsupported JSON Schema keywords instead of guessing them', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        referenced: { $ref: '#/$defs/value' },
      },
      $defs: { value: { type: 'string' } },
    }
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: JSON.stringify(schema) }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())

    const identifier = findAttribute(result, '/identifier')
    expect(identifier).toMatchObject({ types: [] })
    expect(identifier?.['unsupportedConstraints']).toEqual([
      {
        keyword: 'oneOf',
        reason: 'Alternative schemas are not merged into one effective constraint set.',
      },
    ])
    expect(findAttribute(result, '/referenced')?.['unsupportedConstraints']).toEqual([
      {
        keyword: '$ref',
        reason: 'References are not resolved because AttestBook does not fetch referenced schemas.',
      },
    ])

    const dcql = formatPolicy(result, 'dc+sd-jwt').dcql
    expect(dcql.unsupported.map((entry) => entry.code)).toContain('constraint_not_resolved')
    expect(dcql.unsupported.map((entry) => entry.keyword)).toContain('oneOf')
  })

  test('reports pattern and format constraints as data without executing them', () => {
    const setupFixture = setup()
    const result = setupFixture.resolver.resolve(setupFixture.request())

    const email = findAttribute(result, '/email')
    expect(email).toMatchObject({
      constraints: { type: 'string', pattern: '^[^@]+@[^@]+$', format: 'email' },
    })
    const dcql = formatPolicy(result, 'dc+sd-jwt').dcql
    const keywords = dcql.unsupported
      .filter((entry) => entry.code === 'value_constraint_not_expressible')
      .map((entry) => entry.keyword)
    expect(keywords).toContain('pattern')
    expect(keywords).toContain('format')
  })

  test('merges allOf constraints and reports incompatible branches', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { allOf: [{ type: 'string' }, { minLength: 2 }, { maxLength: 8 }] },
        conflicting: { allOf: [{ type: 'string' }, { type: 'integer' }] },
      },
    }
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: JSON.stringify(schema) }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())

    expect(findAttribute(result, '/code')).toMatchObject({
      types: ['string'],
      constraints: { type: 'string', minLength: 2, maxLength: 8 },
      unsupportedConstraints: [],
    })
    const conflicting = findAttribute(result, '/conflicting')
    expect(conflicting?.['types']).toEqual(['string'])
    expect(conflicting?.['unsupportedConstraints']).toEqual([
      {
        keyword: 'type',
        reason:
          'The "allOf" branches declare different "type" values; only the first value is reported.',
      },
    ])
  })

  test('returns a partial DCQL fragment and never a complete request', () => {
    const setupFixture = setup()
    const result = setupFixture.resolver.resolve(setupFixture.request())
    const dcql = formatPolicy(result, 'dc+sd-jwt').dcql

    expect(dcql.interfaceId).toBe('openid4vp.dcql@1')
    expect(dcql.complete).toBe(false)
    expect(dcql.credentialQuery).toEqual({
      id: 'credential-1',
      format: 'dc+sd-jwt',
      claims: [
        { path: ['address'] },
        { path: ['address', 'locality'] },
        { path: ['address', 'postal_code'] },
        { path: ['age'] },
        { path: ['email'] },
        { path: ['family_name'] },
        { path: ['given_name'] },
        { path: ['nationalities'] },
        { path: ['newsletter'] },
      ],
    })
    // The pinned snapshot carries no vct/doctype, so meta must not be invented.
    expect(dcql.credentialQuery?.['meta']).toBeUndefined()

    const codes = dcql.unsupported.map((entry) => entry.code)
    expect(codes).toContain('type_identifier_unavailable')
    expect(codes).toContain('required_not_expressible')
    expect(codes).toContain('trusted_authorities_unavailable')
    expect(codes).toContain('proof_and_protocol_not_built')
    expect(codes).toContain('object_constraint_not_expressible')
  })

  test('declares what it does not claim', () => {
    const setupFixture = setup()
    const result = setupFixture.resolver.resolve(setupFixture.request())

    expect(result.nonClaims).toEqual({
      presentationRequest: false,
      proof: false,
      cryptographicVerification: 'NOT_TESTED',
      protocolConformance: 'NOT_TESTED',
      interoperability: 'NOT_TESTED',
    })
    expect(result.limitations.length).toBeGreaterThan(0)
    expect(result.limitations.join(' ')).toContain('not an OpenID4VP authorization request')

    const keys = new Set<string>()
    const stack: unknown[] = [result]
    while (stack.length > 0) {
      const current = stack.pop()
      if (Array.isArray(current)) {
        for (const entry of current as unknown[]) {
          stack.push(entry)
        }
      } else if (typeof current === 'object' && current !== null) {
        for (const [key, value] of Object.entries(current)) {
          keys.add(key)
          stack.push(value)
        }
      }
    }
    for (const forbidden of [
      'nonce',
      'client_id',
      'response_uri',
      'response_mode',
      'presentation_submission',
      'signature',
    ]) {
      expect(keys.has(forbidden)).toBe(false)
    }
  })

  test('enumerates supported verifier-policy interfaces and their gaps', () => {
    const setupFixture = setup()
    const result = setupFixture.resolver.resolve(setupFixture.request())

    expect(result.policyInterfaces.map((entry) => [entry.id, entry.status])).toEqual([
      ['attestbook.attribute-constraints@1', 'supported'],
      ['openid4vp.dcql@1', 'partial'],
      ['openid4vp.presentation-exchange@1', 'unsupported'],
    ])
    const presentationExchange = result.policyInterfaces.find(
      (entry) => entry.id === 'openid4vp.presentation-exchange@1',
    )
    expect(presentationExchange?.unsupported[0]?.code).toBe('interface_not_implemented')
  })

  test('reports every format of the attestation type unless one is selected', () => {
    const setupFixture = setup({
      supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      documents: [
        { format: 'dc+sd-jwt', uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT },
        {
          format: 'mso_mdoc',
          uri: OTHER_SCHEMA_URI,
          content: JSON.stringify({ type: 'object', properties: { name: { type: 'string' } } }),
        },
      ],
    })

    const all = setupFixture.resolver.resolve(setupFixture.request())
    expect(all.formats.map((policy) => policy.format)).toEqual(['dc+sd-jwt', 'mso_mdoc'])
    const mdoc = formatPolicy(all, 'mso_mdoc')
    expect(mdoc.dcql.credentialQuery).toEqual({ id: 'credential-2', format: 'mso_mdoc' })
    expect(mdoc.dcql.mapped).toEqual(['credential format'])
    expect(
      mdoc.dcql.unsupported.some(
        (entry) => entry.code === 'claim_path_not_expressible' && entry.path === '/name',
      ),
    ).toBe(true)
    expect(mdoc.attributes.find((attribute) => attribute.pointer === '/name')).toMatchObject({
      claimPathSupported: false,
    })
    expect(mdoc.dcql.unsupported.map((entry) => entry.code)).toContain(
      'type_identifier_unavailable',
    )

    const selected = setupFixture.resolver.resolve({
      ...setupFixture.request(),
      format: 'mso_mdoc',
      schemaDocuments: [
        {
          uri: OTHER_SCHEMA_URI,
          content: JSON.stringify({ type: 'object', properties: { name: { type: 'string' } } }),
        },
      ],
    })
    expect(selected.formats.map((policy) => policy.format)).toEqual(['mso_mdoc'])
  })

  test('reports a format that DCQL cannot map without a query fragment', () => {
    const setupFixture = setup({
      supportedFormats: ['ldp_vc'],
      documents: [{ format: 'ldp_vc', uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    const dcql = formatPolicy(result, 'ldp_vc').dcql
    expect(dcql.credentialQuery).toBeNull()
    expect(dcql.unsupported.map((entry) => entry.code)).toContain('format_not_expressible')
  })

  test('reports a format without a schema reference as not grounded', () => {
    const setupFixture = setup({
      supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    const mdoc = formatPolicy(result, 'mso_mdoc')
    expect(mdoc.grounding).toBe('not_grounded')
    expect(mdoc.attributes).toEqual([])
    expect(mdoc.diagnostics.map((entry) => entry.code)).toContain('no_schema_reference_for_format')
  })

  test('reports missing, unpinned and Type Metadata documents instead of grounding them', () => {
    const missing = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT }],
    })
    const noDocuments = missing.resolver.resolve({ ...missing.request(), schemaDocuments: [] })
    expect(formatPolicy(noDocuments, 'dc+sd-jwt').grounding).toBe('not_supplied')
    expect(formatPolicy(noDocuments, 'dc+sd-jwt').attributes).toEqual([])
    expect(formatPolicy(noDocuments, 'dc+sd-jwt').diagnostics.map((entry) => entry.code)).toContain(
      'schema_document_not_supplied',
    )

    const unpinned = setup()
    const rulebook = unpinned.fixture.registry.getRulebook(unpinned.rulebookId)
    if (rulebook === null) {
      throw new Error('test setup failed to read the rulebook')
    }
    const unpinnedResolver = new VerifierPolicyResolver({
      source: unpinnedSource(rulebook, unpinned.version),
    })
    const unpinnedResult = unpinnedResolver.resolve({
      rulebookId: unpinned.rulebookId,
      rulebookVersion: unpinned.version,
      attestationType: unpinned.attestationName,
      schemaDocuments: [{ uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT }],
    })
    expect(formatPolicy(unpinnedResult, 'dc+sd-jwt').grounding).toBe('not_grounded')
    expect(
      formatPolicy(unpinnedResult, 'dc+sd-jwt').diagnostics.map((entry) => entry.code),
    ).toContain('schema_reference_unpinned')

    const typeMetadata = setup({
      documents: [
        {
          format: 'dc+sd-jwt',
          uri: TYPE_METADATA_URI,
          content: TYPE_METADATA_TEXT,
        },
      ],
    })
    const typeMetadataResult = typeMetadata.resolver.resolve(typeMetadata.request())
    const policy = formatPolicy(typeMetadataResult, 'dc+sd-jwt')
    expect(policy.grounding).toBe('not_grounded')
    expect(policy.schemaReferences[0]).toMatchObject({
      kind: 'type_metadata',
      inspected: false,
      integrityVerified: true,
    })
    expect(policy.diagnostics.map((entry) => entry.code)).toContain('type_metadata_not_inspected')
  })

  test('reports a non-2020-12 JSON Schema dialect instead of inspecting it', () => {
    const schemaText = JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { name: { type: 'string' } },
    })
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: schemaText }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    const policy = formatPolicy(result, 'dc+sd-jwt')
    expect(policy.grounding).toBe('not_grounded')
    expect(policy.attributes).toEqual([])
    expect(policy.schemaReferences[0]).toMatchObject({
      kind: 'json_schema',
      inspected: false,
    })
    expect(policy.diagnostics.map((entry) => entry.code)).toContain('unsupported_schema_dialect')
  })

  test('reports a property named __proto__ as an ordinary attribute', () => {
    const schemaText =
      '{"type":"object","properties":{"__proto__":{"type":"string","maxLength":5}}}'
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: schemaText }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())

    expect(findAttribute(result, '/__proto__')).toMatchObject({
      name: '__proto__',
      types: ['string'],
      constraints: { type: 'string', maxLength: 5 },
      claimPath: ['__proto__'],
    })
    expect(formatPolicy(result, 'dc+sd-jwt').dcql.credentialQuery).toMatchObject({
      claims: [{ path: ['__proto__'] }],
    })
  })

  test('ignores schema members that shadow Object.prototype names', () => {
    const schemaText = JSON.stringify({
      type: 'object',
      properties: {
        identifier: { type: 'string', toString: 1, constructor: {} },
      },
    })
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: schemaText }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    expect(findAttribute(result, '/identifier')).toMatchObject({
      types: ['string'],
      unsupportedConstraints: [],
    })
  })

  test('merges required and properties from sibling allOf branches', () => {
    const schema = {
      type: 'object',
      allOf: [
        {
          properties: {
            address: { type: 'object', properties: { street: { type: 'string' } } },
          },
        },
        { properties: { address: { required: ['street'] } } },
      ],
    }
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: JSON.stringify(schema) }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    const streets = attributesAt(result, '/address/street')
    expect(streets).toHaveLength(1)
    expect(streets[0]).toMatchObject({ required: true, types: ['string'] })
  })

  test('merges constraints from sibling allOf property branches', () => {
    const schema = {
      type: 'object',
      allOf: [
        {
          properties: {
            address: {
              type: 'object',
              properties: { street: { type: 'string' } },
            },
          },
        },
        {
          properties: {
            address: { properties: { street: { maxLength: 5 } } },
          },
        },
      ],
    }
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: JSON.stringify(schema) }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    const streets = attributesAt(result, '/address/street')
    expect(streets).toHaveLength(1)
    expect(streets[0]?.['constraints']).toEqual({ type: 'string', maxLength: 5 })
  })

  test('descends into items of items', () => {
    const schema = {
      type: 'object',
      properties: {
        m: {
          type: 'array',
          items: { type: 'array', items: { type: 'string', maxLength: 3 } },
        },
      },
    }
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: JSON.stringify(schema) }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    expect(findAttribute(result, '/m/*')).toMatchObject({ types: ['array'] })
    expect(findAttribute(result, '/m/*/*')).toMatchObject({
      constraints: { type: 'string', maxLength: 3 },
      claimPath: ['m', null, null],
    })
  })

  test('reports additionalProperties on an object without declared properties', () => {
    const schema = {
      type: 'object',
      properties: { address: { type: 'object', additionalProperties: false } },
    }
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: JSON.stringify(schema) }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    expect(
      formatPolicy(result, 'dc+sd-jwt').dcql.unsupported.some(
        (entry) =>
          entry.code === 'object_constraint_not_expressible' &&
          entry.path === '/address' &&
          entry.keyword === 'additionalProperties',
      ),
    ).toBe(true)
  })

  test('merges array item schemas split across allOf branches', () => {
    const schema = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: {
            allOf: [{ properties: { a: { type: 'string' } } }, { required: ['a'] }],
          },
        },
      },
    }
    const setupFixture = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: JSON.stringify(schema) }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    const entries = attributesAt(result, '/list/*/a')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ required: true, types: ['string'] })
  })

  test('emits mso_mdoc claim paths only for namespace and element pairs', () => {
    const schema = {
      type: 'object',
      properties: {
        'org.iso.18013.5.1': {
          type: 'object',
          properties: { given_name: { type: 'string' } },
        },
      },
    }
    const setupFixture = setup({
      supportedFormats: ['mso_mdoc'],
      documents: [{ format: 'mso_mdoc', uri: SCHEMA_URI, content: JSON.stringify(schema) }],
    })
    const result = setupFixture.resolver.resolve(setupFixture.request())
    const mdoc = formatPolicy(result, 'mso_mdoc')
    expect(mdoc.dcql.credentialQuery).toEqual({
      id: 'credential-1',
      format: 'mso_mdoc',
      claims: [{ path: ['org.iso.18013.5.1', 'given_name'] }],
    })
    expect(mdoc.dcql.mapped).toEqual(['credential format', 'claim paths'])
    expect(
      mdoc.attributes.find((attribute) => attribute.pointer === '/org.iso.18013.5.1'),
    ).toMatchObject({ claimPathSupported: false })
  })

  test('rejects a document that does not belong to the selected attestation type', () => {
    const setupFixture = setup()
    expectInvalidInput(() =>
      setupFixture.resolver.resolve({
        ...setupFixture.request(),
        schemaDocuments: [{ uri: 'https://schemas.example.test/unknown.json', content: '{}' }],
      }),
    )
  })

  test('rejects an integrity mismatch, invalid JSON and an oversized document', () => {
    const setupFixture = setup()
    expectInvalidInput(() =>
      setupFixture.resolver.resolve({
        ...setupFixture.request(),
        schemaDocuments: [{ uri: SCHEMA_URI, content: '{"type":"object"}' }],
      }),
    )
    expectInvalidInput(() =>
      setupFixture.resolver.resolve({
        ...setupFixture.request(),
        schemaDocuments: [{ uri: SCHEMA_URI, content: '{not json' }],
      }),
    )

    const deep = '{"type":"object","properties":' + '{"x":'.repeat(70) + '{}' + '}'.repeat(70) + '}'
    const deepSetup = setup({
      documents: [{ format: 'dc+sd-jwt', uri: SCHEMA_URI, content: deep }],
    })
    expectInvalidInput(() => deepSetup.resolver.resolve(deepSetup.request()))
  })

  test('rejects an unknown format, rulebook, version and attestation type', () => {
    const setupFixture = setup()
    expectInvalidInput(() =>
      setupFixture.resolver.resolve(setupFixture.request({ format: 'mso_mdoc' })),
    )
    expectNotFound(() =>
      setupFixture.resolver.resolve({ ...setupFixture.request(), rulebookId: 'missing' }),
    )
    expectNotFound(() =>
      setupFixture.resolver.resolve({ ...setupFixture.request(), rulebookVersion: '9.9' }),
    )
    expectNotFound(() =>
      setupFixture.resolver.resolve({ ...setupFixture.request(), attestationType: 'NOPE' }),
    )
  })

  test('rejects malformed request bodies with invalid_input', () => {
    const setupFixture = setup()
    expectInvalidInput(() => setupFixture.resolver.resolve('not an object'))
    expectInvalidInput(() =>
      setupFixture.resolver.resolve({ ...setupFixture.request(), format: 1 }),
    )
    expectInvalidInput(() =>
      setupFixture.resolver.resolve({
        ...setupFixture.request(),
        schemaDocuments: [{ uri: SCHEMA_URI }],
      }),
    )
    expectInvalidInput(() =>
      setupFixture.resolver.resolve({
        ...setupFixture.request(),
        schemaDocuments: [
          { uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT },
          { uri: SCHEMA_URI, content: CLAIMS_SCHEMA_TEXT },
        ],
      }),
    )
  })
})

describe('inspectJsonSchema', () => {
  test('classifies JSON Schema and Type Metadata documents', () => {
    expect(classifySchemaDocument(CLAIMS_SCHEMA)).toBe('json_schema')
    expect(classifySchemaDocument(TYPE_METADATA)).toBe('type_metadata')
    expect(classifySchemaDocument({})).toBe('json_schema')
    expect(classifySchemaDocument([])).toBe('unsupported')
    expect(classifySchemaDocument({ vct: 'urn:example', type: 'object' })).toBe('json_schema')
  })

  test('reports root-level conditional and structural limitations', () => {
    const inspection = inspectJsonSchema(
      {
        type: 'object',
        oneOf: [{ properties: { a: { type: 'string' } } }],
        propertyNames: { pattern: '^[a-z]+$' },
        properties: { b: { type: 'string' } },
      },
      SCHEMA_URI,
    )
    expect(inspection.objectLimitations.map((entry) => entry.keyword).sort()).toEqual([
      'oneOf',
      'propertyNames',
    ])
    expect(inspection.attributes.map((entry) => entry.pointer)).toEqual(['/b'])
  })
})
