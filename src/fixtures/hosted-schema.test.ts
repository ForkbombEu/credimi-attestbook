// Hosted-schema grounding for rulebook-driven issuer fixtures (#102).
//
// A canonical AttestBook hosted-schema reference is resolved from the immutable
// local store, never over HTTP: its stored bytes must hash to the recorded
// digest, the pinned rulebook SRI must match that digest, and only then do the
// bytes reach the same bounded JSON Schema synthesis pipeline. External
// references keep the caller-supplied document flow, and SD-JWT VC Type
// Metadata is never treated as a JSON Schema.

import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'

import { credentialSchemaDocumentUrl, sha256Sri as sriForDigest } from '../public-urls'
import { provisionProvider } from '../registry/bootstrap'
import type { AuthenticatedActor, CredentialSchemaDocument } from '../registry/types'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import type { HostedSchemaDocumentStore } from '../validation/hosted-schema'
import type { SchemaSandboxLimits } from '../validation/schema-sandbox'
import {
  PID_TYPE_METADATA_TEXT,
  seedPublishedRulebook,
  sha256Sri,
} from '../validation/test-support'

import { IssuerFixtureGenerator } from './generate'

const PUBLIC_BASE_URL = 'https://schemas.example'
const MISSING_DOCUMENT_ID = '33333333-3333-4333-8333-333333333333'
const EXTERNAL_SCHEMA_URI = 'https://example.org/schemas/external.json'

const HOSTED_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['family_name', 'age'],
  properties: {
    family_name: { type: 'string', minLength: 1, maxLength: 40 },
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
    family_name: { type: 'string', minLength: 1, maxLength: 40 },
    age: { type: 'integer', minimum: 18, maximum: 120 },
    nickname: { type: 'string', minLength: 1, maxLength: 20 },
  },
})

interface FixtureRulebook {
  readonly rulebookId: string
  readonly version: string
  readonly attestationName: string
}

interface HostedFixture {
  readonly fixture: RegistryFixture
  readonly document: CredentialSchemaDocument
  readonly rulebook: FixtureRulebook
  readonly generator: IssuerFixtureGenerator
  readonly hostedUri: string
}

let active: RegistryFixture | undefined

afterEach(() => {
  active?.cleanup()
  active = undefined
})

async function registerHosted(
  fixture: RegistryFixture,
  actor: AuthenticatedActor,
  options: {
    readonly kind?: 'json_schema_2020_12' | 'sd_jwt_vc_type_metadata'
    readonly content?: string
  } = {},
): Promise<CredentialSchemaDocument> {
  const kind = options.kind ?? 'json_schema_2020_12'
  return fixture.registry.registerCredentialSchemaDocument(actor, {
    kind,
    bytes: new TextEncoder().encode(
      options.content ??
        (kind === 'json_schema_2020_12' ? HOSTED_SCHEMA_TEXT : PID_TYPE_METADATA_TEXT),
    ),
    provenance: { source: 'hosted-fixture-test' },
  })
}

function fixtureGenerator(
  fixture: RegistryFixture,
  options: {
    readonly publicBaseUrl?: string
    readonly store?: HostedSchemaDocumentStore
    readonly sandbox?: SchemaSandboxLimits
  } = {},
): IssuerFixtureGenerator {
  return new IssuerFixtureGenerator({
    source: fixture.registry,
    ...(options.publicBaseUrl === undefined
      ? {}
      : {
          hostedSchemas: {
            publicBaseUrl: options.publicBaseUrl,
            store: options.store ?? fixture.registry,
          },
        }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  })
}

async function seedHosted(
  options: {
    readonly integrity?: string | null
    readonly store?: HostedSchemaDocumentStore
    readonly sandbox?: SchemaSandboxLimits
    readonly kind?: 'json_schema_2020_12' | 'sd_jwt_vc_type_metadata'
  } = {},
): Promise<HostedFixture> {
  const fixture = createRegistryFixture()
  active = fixture
  const provider = provisionProvider(fixture.database, {
    name: 'Hosted fixture provider',
    publicationAuthority: 'hosted-fixture',
  })
  const document = await registerHosted(fixture, provider.actor, {
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  })
  const hostedUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, document.id)
  const schemaContent =
    options.kind === 'sd_jwt_vc_type_metadata' ? PID_TYPE_METADATA_TEXT : HOSTED_SCHEMA_TEXT
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry, {
    authority: 'hosted-fixture-rulebook',
    schemaUri: hostedUri,
    schemaContent,
    ...(options.integrity === undefined ? {} : { schemaIntegrity: options.integrity }),
  })
  return {
    fixture,
    document,
    rulebook: seeded,
    generator: fixtureGenerator(fixture, {
      publicBaseUrl: PUBLIC_BASE_URL,
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    }),
    hostedUri,
  }
}

function request(
  rulebook: FixtureRulebook,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    rulebookId: rulebook.rulebookId,
    rulebookVersion: rulebook.version,
    attestationType: rulebook.attestationName,
    ...extra,
  }
}

async function expectInvalidInput(run: () => Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await run()
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe('invalid_input')
    expect((error as Error).message).toMatch(message)
    return
  }
  throw new Error('expected an invalid_input failure')
}

const ajv = new Ajv2020({ strict: false, validateFormats: false })

describe('hosted schema grounding for issuer fixtures', () => {
  test('generates an unsigned fixture without caller documents and records the hosted reference', async () => {
    const { generator, rulebook, hostedUri } = await seedHosted()
    const result = await generator.generate(request(rulebook))

    expect(result.signed).toBe(false)
    expect(result.issued).toBe(false)
    expect(result.formats).toEqual(['dc+sd-jwt'])
    expect(result.schemaReferences).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: hostedUri,
        integrity: sha256Sri(HOSTED_SCHEMA_TEXT),
        integrityVerified: true,
        source: 'hosted',
        kind: 'json_schema',
        applied: true,
      },
    ])
    expect(result.payloadValidation).toEqual({ status: 'PASS', findings: [] })

    const validate = ajv.compile(JSON.parse(HOSTED_SCHEMA_TEXT) as object)
    expect(validate(result.payload), JSON.stringify(validate.errors)).toBe(true)
    expect(typeof result.payload['family_name']).toBe('string')
    expect(result.payload['age']).toBeGreaterThanOrEqual(18)
    expect(result.payload['age']).toBeLessThanOrEqual(120)
    expect(result.negativeCases.length).toBeGreaterThan(0)
  })

  test('caller bytes for a hosted URI cannot override the stored schema', async () => {
    const { generator, rulebook, hostedUri } = await seedHosted()
    const permissive = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}'
    const result = await generator.generate(
      request(rulebook, { schemaDocuments: [{ uri: hostedUri, content: permissive }] }),
    )

    const validate = ajv.compile(JSON.parse(HOSTED_SCHEMA_TEXT) as object)
    expect(validate(result.payload), JSON.stringify(validate.errors)).toBe(true)
    expect(result.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: true })
  })

  test('rejects a canonical hosted URL whose document is missing', async () => {
    const fixture = createRegistryFixture()
    active = fixture
    const missingUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, MISSING_DOCUMENT_ID)
    const rulebook = seedPublishedRulebook(fixture.database, fixture.registry, {
      authority: 'missing-hosted-fixture',
      schemaUri: missingUri,
      schemaContent: HOSTED_SCHEMA_TEXT,
    })

    await expectInvalidInput(
      () =>
        fixtureGenerator(fixture, { publicBaseUrl: PUBLIC_BASE_URL }).generate(request(rulebook)),
      /is not present in the local schema store/,
    )
  })

  test('rejects a hosted reference whose stored bytes no longer match their digest', async () => {
    const tampered: { document?: CredentialSchemaDocument } = {}
    const hosted = await seedHosted({
      store: {
        getCredentialSchemaDocumentContent: () => ({
          document: tampered.document as CredentialSchemaDocument,
          bytes: new TextEncoder().encode('{"type":"object"}'),
        }),
      },
    })
    tampered.document = hosted.document

    await expectInvalidInput(
      () => hosted.generator.generate(request(hosted.rulebook)),
      /do not match their recorded SHA-256 digest/,
    )
  })

  test('rejects a hosted reference whose pinned SRI does not match the stored digest', async () => {
    const hosted = await seedHosted({ integrity: sriForDigest('0'.repeat(64)) })

    await expectInvalidInput(
      () => hosted.generator.generate(request(hosted.rulebook)),
      /does not match the pinned rulebook sha256 integrity value/,
    )
  })

  test('rejects an unpinned hosted reference', async () => {
    const hosted = await seedHosted({ integrity: null })

    await expectInvalidInput(
      () => hosted.generator.generate(request(hosted.rulebook)),
      /has no sha256 integrity value/,
    )
  })

  test('rejects a hosted reference pinned with an unsupported algorithm', async () => {
    const hosted = await seedHosted({
      integrity: 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })

    await expectInvalidInput(
      () => hosted.generator.generate(request(hosted.rulebook)),
      /verifies sha256 SRI only/,
    )
  })

  test('rejects a hosted reference that is only non-synthesizable Type Metadata', async () => {
    const hosted = await seedHosted({ kind: 'sd_jwt_vc_type_metadata' })

    await expectInvalidInput(
      () => hosted.generator.generate(request(hosted.rulebook)),
      /Type Metadata.*cannot ground a generated payload/,
    )
  })

  test('keeps Type Metadata distinct from a hosted JSON Schema in the same attestation', async () => {
    const fixture = createRegistryFixture()
    active = fixture
    const provider = provisionProvider(fixture.database, {
      name: 'Mixed metadata provider',
      publicationAuthority: 'mixed-metadata',
    })
    const schemaDocument = await registerHosted(fixture, provider.actor)
    const metadataDocument = await registerHosted(fixture, provider.actor, {
      kind: 'sd_jwt_vc_type_metadata',
    })
    const rulebook = seedRulebookWithReferences(fixture, provider.actor, [
      {
        format: 'dc+sd-jwt',
        uri: credentialSchemaDocumentUrl(PUBLIC_BASE_URL, metadataDocument.id),
        integrity: sriForDigest(metadataDocument.contentDigest),
      },
      {
        format: 'mso_mdoc',
        uri: credentialSchemaDocumentUrl(PUBLIC_BASE_URL, schemaDocument.id),
        integrity: sriForDigest(schemaDocument.contentDigest),
      },
    ])

    const result = await fixtureGenerator(fixture, { publicBaseUrl: PUBLIC_BASE_URL }).generate(
      request(rulebook),
    )

    expect(result.formats).toEqual(['mso_mdoc'])
    expect(typeof result.payload['family_name']).toBe('string')
    expect(typeof result.payload['age']).toBe('number')
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      'type_metadata_not_synthesizable',
    )
    const metadata = result.schemaReferences.find(
      (reference) =>
        reference.uri === credentialSchemaDocumentUrl(PUBLIC_BASE_URL, metadataDocument.id),
    )
    expect(metadata).toMatchObject({ source: 'hosted', kind: 'type_metadata', applied: false })
  })

  test('mixes hosted and external references, keeping explicit missing-reference behavior', async () => {
    const fixture = createRegistryFixture()
    active = fixture
    const provider = provisionProvider(fixture.database, {
      name: 'Mixed source provider',
      publicationAuthority: 'mixed-sources',
    })
    const hostedDocument = await registerHosted(fixture, provider.actor)
    const hostedUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, hostedDocument.id)
    const rulebook = seedRulebookWithReferences(fixture, provider.actor, [
      {
        format: 'dc+sd-jwt',
        uri: hostedUri,
        integrity: sriForDigest(hostedDocument.contentDigest),
      },
      { format: 'mso_mdoc', uri: EXTERNAL_SCHEMA_URI, integrity: sha256Sri(EXTERNAL_SCHEMA_TEXT) },
    ])
    const generator = fixtureGenerator(fixture, { publicBaseUrl: PUBLIC_BASE_URL })

    const hostedOnly = await generator.generate(request(rulebook))
    expect(hostedOnly.schemaReferences).toHaveLength(2)
    expect(hostedOnly.schemaReferences[0]).toMatchObject({
      uri: hostedUri,
      source: 'hosted',
      applied: true,
    })
    expect(hostedOnly.schemaReferences[1]).toMatchObject({
      uri: EXTERNAL_SCHEMA_URI,
      source: null,
      applied: false,
    })
    expect(hostedOnly.diagnostics.map((entry) => entry.code)).toContain(
      'schema_document_not_supplied',
    )

    const mixed = await generator.generate(
      request(rulebook, {
        schemaDocuments: [{ uri: EXTERNAL_SCHEMA_URI, content: EXTERNAL_SCHEMA_TEXT }],
      }),
    )
    expect(mixed.schemaReferences).toHaveLength(2)
    expect(mixed.schemaReferences[0]).toMatchObject({
      uri: hostedUri,
      source: 'hosted',
      applied: true,
    })
    expect(mixed.schemaReferences[1]).toMatchObject({
      uri: EXTERNAL_SCHEMA_URI,
      source: 'caller',
      applied: true,
    })
    expect(mixed.payloadValidation).toEqual({ status: 'PASS', findings: [] })
    expect(typeof mixed.payload['nickname']).toBe('string')
  })

  test('an external-only reference still needs the caller document', async () => {
    const fixture = createRegistryFixture()
    active = fixture
    const provider = provisionProvider(fixture.database, {
      name: 'External-only provider',
      publicationAuthority: 'external-only',
    })
    const rulebook = seedRulebookWithReferences(fixture, provider.actor, [
      { format: 'dc+sd-jwt', uri: EXTERNAL_SCHEMA_URI, integrity: sha256Sri(EXTERNAL_SCHEMA_TEXT) },
    ])

    await expectInvalidInput(
      () =>
        fixtureGenerator(fixture, { publicBaseUrl: PUBLIC_BASE_URL }).generate(request(rulebook)),
      /No document was supplied/,
    )

    const result = await fixtureGenerator(fixture, { publicBaseUrl: PUBLIC_BASE_URL }).generate(
      request(rulebook, {
        schemaDocuments: [{ uri: EXTERNAL_SCHEMA_URI, content: EXTERNAL_SCHEMA_TEXT }],
      }),
    )
    expect(result.schemaReferences[0]).toMatchObject({ source: 'caller', applied: true })
  })

  test('a hosted URL stays external when the deployment configures no public origin', async () => {
    const hosted = await seedHosted()
    // The same rulebook, generated without hosted resolution: the canonical URL
    // is then just an external reference and needs caller bytes.
    await expectInvalidInput(
      () => fixtureGenerator(hosted.fixture).generate(request(hosted.rulebook)),
      /No document was supplied/,
    )
  })
})

/** Creates one rulebook with several schema references and a published version. */
function seedRulebookWithReferences(
  fixture: RegistryFixture,
  actor: AuthenticatedActor,
  references: readonly {
    readonly format: string
    readonly uri: string
    readonly integrity: string
  }[],
): FixtureRulebook {
  const rulebook = fixture.registry.createRulebook(actor, {
    name: 'Hosted fixture rulebook',
    description: 'Hosted and external schema references in one version',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'PID',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: [...new Set(references.map((reference) => reference.format))],
      },
    ],
  })
  const attestation = fixture.registry
    .listAttestations(rulebook.id)
    .find((candidate) => candidate.name === 'PID')
  if (attestation === undefined) {
    throw new Error('fixture setup failed to create the attestation type')
  }
  for (const reference of references) {
    fixture.registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: reference.format,
      uri: reference.uri,
      integrity: reference.integrity,
      attestationId: attestation.id,
    })
  }
  const version = fixture.registry.createRulebookVersion(actor, rulebook.id, { version: '1.0' })
  fixture.registry.publishRulebookVersion(actor, rulebook.id, '1.0')
  return { rulebookId: rulebook.id, version: version.version, attestationName: 'PID' }
}
