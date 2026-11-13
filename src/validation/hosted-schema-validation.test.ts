// Credential validation against AttestBook-hosted schema documents (#101).
//
// The engine resolves a canonical hosted URL from the immutable local store,
// verifies the URI-to-digest binding and the pinned SRI, and then applies the
// stored bytes through the existing bounded sandbox. Caller-supplied bytes never
// override a hosted reference, a missing or changed stored document is never a
// false PASS, and the unchanged cryptographic/trust dimensions stay NOT_TESTED.

import { afterEach, describe, expect, test } from 'bun:test'

import { credentialSchemaDocumentUrl, sha256Sri as sriForDigest } from '../public-urls'
import { provisionProvider } from '../registry/bootstrap'
import type { AuthenticatedActor, CredentialSchemaDocument } from '../registry/types'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { CredentialValidator } from './engine'
import type { HostedSchemaDocumentStore } from './hosted-schema'
import type { SchemaSandboxLimits } from './schema-sandbox'
import {
  defaultCredentialClaims,
  issueTestCredential,
  PID_JSON_SCHEMA_TEXT,
  seedPublishedRulebook,
  sha256Sri,
  type SeededRulebook,
} from './test-support'
import type { ValidateCredentialInput } from './types'

const PUBLIC_BASE_URL = 'https://schemas.example'
const MISSING_DOCUMENT_ID = '22222222-2222-4222-8222-222222222222'
const EXTERNAL_SCHEMA_URI = 'https://example.org/schemas/external.json'
const CALLER_PERMISSIVE_SCHEMA =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}'
const HOSTED_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['family_name'],
  properties: { family_name: { type: 'string' } },
})

interface HostedFixture {
  readonly fixture: RegistryFixture
  readonly document: CredentialSchemaDocument
  readonly seeded: SeededRulebook
  readonly validator: CredentialValidator
  readonly hostedUri: string
}

let active: RegistryFixture | undefined

afterEach(() => {
  active?.cleanup()
  active = undefined
})

function request(
  seeded: SeededRulebook,
  credential: string,
  schemaDocuments?: ValidateCredentialInput['schemaDocuments'],
): ValidateCredentialInput {
  return {
    rulebookId: seeded.rulebookId,
    rulebookVersion: seeded.version,
    attestationType: seeded.attestationName,
    credential,
    ...(schemaDocuments === undefined ? {} : { schemaDocuments }),
  }
}

async function registerHosted(
  fixture: RegistryFixture,
  actor: AuthenticatedActor,
): Promise<CredentialSchemaDocument> {
  return fixture.registry.registerCredentialSchemaDocument(actor, {
    kind: 'json_schema_2020_12',
    bytes: new TextEncoder().encode(HOSTED_SCHEMA_TEXT),
    provenance: { source: 'hosted-validation-test' },
  })
}

async function seedHosted(options: {
  readonly integrity?: string | null
  readonly store?: HostedSchemaDocumentStore
  readonly sandbox?: SchemaSandboxLimits
}): Promise<HostedFixture> {
  const fixture = createRegistryFixture()
  active = fixture
  const provider = provisionProvider(fixture.database, {
    name: 'Hosted validation provider',
    publicationAuthority: 'hosted-validation',
  })
  const document = await registerHosted(fixture, provider.actor)
  const hostedUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, document.id)
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry, {
    authority: 'hosted-validation-rulebook',
    schemaUri: hostedUri,
    schemaIntegrity:
      options.integrity === undefined ? sriForDigest(document.contentDigest) : options.integrity,
  })
  const validator = new CredentialValidator({
    source: fixture.registry,
    hostedSchemas: {
      publicBaseUrl: PUBLIC_BASE_URL,
      store: options.store ?? fixture.registry,
    },
    now: () => '2026-01-01T00:00:00.000Z',
    generateId: () => 'hosted-validation-test-id',
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  })
  return { fixture, document, seeded, validator, hostedUri }
}

async function credentialWithoutFamilyName(): Promise<string> {
  const claims = defaultCredentialClaims()
  delete claims.family_name
  return issueTestCredential({ claims, selectiveClaims: ['given_name', 'birthdate'] })
}

function dimension(result: Awaited<ReturnType<CredentialValidator['validate']>>, id: string) {
  return result.dimensions.find((entry) => entry.id === id)
}

describe('hosted schema resolution in credential validation', () => {
  test('applies the stored schema without schemaDocuments and reports provenance', async () => {
    const { seeded, validator } = await seedHosted({})
    const result = await validator.validate(request(seeded, await issueTestCredential()))

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('PASS')
    expect(schema?.executed).toBe(true)
    expect(schema?.evidence.details).toMatchObject({
      references: 1,
      documents_supplied: 0,
      applied_documents: 1,
      hosted_references: 1,
      hosted_documents_applied: 1,
    })
    expect(result.schemaReferences).toEqual([
      expect.objectContaining({
        uri: seeded.schemaUri,
        integrity: seeded.integrity,
        kind: 'json_schema',
        applied: true,
        source: 'hosted',
      }),
    ])
    // The hosted application changes only the schema dimension.
    expect(dimension(result, 'cryptographic_verification')?.status).toBe('NOT_TESTED')
    expect(dimension(result, 'issuer_trust')?.status).toBe('NOT_TESTED')
    expect(dimension(result, 'protocol_conformance')?.status).toBe('NOT_APPLICABLE')
    expect(dimension(result, 'interoperability')?.status).toBe('NOT_APPLICABLE')
    expect(result.overallStatus).not.toBe('PASS')
  })

  test('produces real schema findings for a violation of the hosted document', async () => {
    const { seeded, validator } = await seedHosted({})
    const result = await validator.validate(request(seeded, await credentialWithoutFamilyName()))

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('FAIL')
    expect(schema?.executed).toBe(true)
    expect(schema?.evidence.details).toMatchObject({ applied_documents: 1 })
    const violation = result.violations.find((entry) => entry.code === 'schema_violation')
    expect(violation?.expected).toBe('required')
  })

  test('caller content cannot override a trusted pinned hosted schema', async () => {
    const { seeded, validator, hostedUri } = await seedHosted({})
    // The permissive caller document would pass the credential, but the stored
    // document requires family_name, so applying the caller bytes would be a
    // false PASS.
    const result = await validator.validate(
      request(seeded, await credentialWithoutFamilyName(), [
        { uri: hostedUri, content: CALLER_PERMISSIVE_SCHEMA },
      ]),
    )

    expect(dimension(result, 'schema_validation')?.status).toBe('FAIL')
    expect(result.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: true })
    expect(result.violations.some((entry) => entry.code === 'schema_violation')).toBe(true)
  })

  test('a hosted URI/SRI mismatch is an explicit failure and is not applied', async () => {
    const { seeded, validator } = await seedHosted({
      integrity: sha256Sri('{"different":"document"}'),
    })
    const result = await validator.validate(request(seeded, await issueTestCredential()))

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('FAIL')
    expect(result.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: false })
    expect(schema?.findings.map((entry) => entry.code)).toContain(
      'hosted_schema_integrity_mismatch',
    )
  })

  test('an unpinned hosted reference is NOT_TESTED and caller bytes do not rescue it', async () => {
    const { seeded, validator, hostedUri } = await seedHosted({ integrity: null })
    const result = await validator.validate(
      request(seeded, await issueTestCredential(), [
        { uri: hostedUri, content: HOSTED_SCHEMA_TEXT },
      ]),
    )

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('NOT_TESTED')
    expect(schema?.executed).toBe(false)
    expect(schema?.evidence.details).toMatchObject({
      applied_documents: 0,
      hosted_references: 1,
      hosted_documents_applied: 0,
    })
    expect(result.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: false })
    expect(result.limitations.map((entry) => entry.code)).toContain(
      'hosted_schema_reference_unpinned',
    )
  })

  test('a canonical hosted URL whose document is missing is NOT_TESTED', async () => {
    const { seeded, validator, fixture } = await seedHosted({})
    const missingUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, MISSING_DOCUMENT_ID)
    const missing = seedPublishedRulebook(fixture.database, fixture.registry, {
      authority: 'missing-hosted-schema',
      schemaUri: missingUri,
      schemaIntegrity: sha256Sri('{"type":"object"}'),
    })
    const result = await validator.validate(
      request(missing, await issueTestCredential(), [
        { uri: missingUri, content: HOSTED_SCHEMA_TEXT },
      ]),
    )

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('NOT_TESTED')
    expect(schema?.executed).toBe(false)
    expect(result.limitations.map((entry) => entry.code)).toContain(
      'hosted_schema_document_missing',
    )
    expect(result.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: false })
    expect(seeded.schemaUri).not.toBe(missingUri)
  })

  test('stored bytes that no longer match their recorded digest fail closed', async () => {
    const { seeded, validator, document } = await seedHosted({
      store: {
        getCredentialSchemaDocumentContent: () => ({
          document,
          bytes: new TextEncoder().encode('{"type":"object"}'),
        }),
      },
    })
    const result = await validator.validate(request(seeded, await issueTestCredential()))

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('FAIL')
    expect(schema?.executed).toBe(true)
    expect(result.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: false })
    expect(schema?.findings.map((entry) => entry.code)).toContain('hosted_schema_document_corrupt')
  })

  test('a sandbox resource limit reports NOT_TESTED instead of a false result', async () => {
    const { seeded, validator } = await seedHosted({ sandbox: { maxConcurrent: 0 } })
    const result = await validator.validate(request(seeded, await issueTestCredential()))

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('NOT_TESTED')
    expect(schema?.executed).toBe(false)
    expect(result.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: false })
    expect(result.limitations.map((entry) => entry.code)).toContain('schema_sandbox_busy')
  })

  test('a look-alike origin stays an external reference and is never resolved locally', async () => {
    const { seeded, fixture } = await seedHosted({})
    const lookAlike = `https://evil.example/api/v1/schema-documents/${
      fixture.registry.listCredentialSchemaDocuments()[0]?.id ?? 'missing'
    }/content`
    const external = seedPublishedRulebook(fixture.database, fixture.registry, {
      authority: 'look-alike-external',
      schemaUri: lookAlike,
      schemaIntegrity: sha256Sri(HOSTED_SCHEMA_TEXT),
    })
    const validator = new CredentialValidator({
      source: fixture.registry,
      hostedSchemas: { publicBaseUrl: PUBLIC_BASE_URL, store: fixture.registry },
      now: () => '2026-01-01T00:00:00.000Z',
      generateId: () => 'look-alike-test-id',
    })
    const result = await validator.validate(request(external, await issueTestCredential()))

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('NOT_TESTED')
    expect(result.schemaReferences[0]).toMatchObject({ source: null, applied: false })
    expect(result.limitations.map((entry) => entry.code)).toContain('schema_document_not_supplied')
    expect(seeded.schemaUri).not.toBe(lookAlike)
  })

  test('an overlong hosted-looking id stays external instead of failing the run', async () => {
    const { fixture, validator } = await seedHosted({})
    const overlongUri = `${PUBLIC_BASE_URL}/api/v1/schema-documents/${'a'.repeat(129)}/content`
    const external = seedPublishedRulebook(fixture.database, fixture.registry, {
      authority: 'overlong-id-external',
      schemaUri: overlongUri,
      schemaIntegrity: sha256Sri(HOSTED_SCHEMA_TEXT),
    })
    // The registry rejects an overlong identifier; the resolver must never let
    // that become a request failure.
    const result = await validator.validate(request(external, await issueTestCredential()))

    const schema = dimension(result, 'schema_validation')
    expect(schema?.status).toBe('NOT_TESTED')
    expect(schema?.executed).toBe(false)
    expect(result.schemaReferences[0]).toMatchObject({ source: null, applied: false })
    expect(result.limitations.map((entry) => entry.code)).toContain('schema_document_not_supplied')
    expect(dimension(result, 'cryptographic_verification')?.status).toBe('NOT_TESTED')
    expect(dimension(result, 'issuer_trust')?.status).toBe('NOT_TESTED')
  })

  test('mixed hosted and external references select their source deterministically', async () => {
    const { fixture, hostedUri } = await seedHosted({})
    const provider = provisionProvider(fixture.database, {
      name: 'Mixed hosted/external provider',
      publicationAuthority: 'mixed-hosted-external',
    })
    const hostedIntegrity = sha256Sri(HOSTED_SCHEMA_TEXT)
    const rulebook = fixture.registry.createRulebook(provider.actor, {
      name: 'Mixed rulebook',
      description: 'Hosted and external references in one version',
      applicableSpec: 'ts11@1.0.1',
      attestations: [
        {
          name: 'Hosted',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [
            { formatIdentifier: 'dc+sd-jwt', uri: hostedUri, integrity: hostedIntegrity },
          ],
        },
        {
          name: 'External',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [
            {
              formatIdentifier: 'dc+sd-jwt',
              uri: EXTERNAL_SCHEMA_URI,
              integrity: sha256Sri(PID_JSON_SCHEMA_TEXT),
            },
          ],
        },
      ],
    })
    const version = fixture.registry.createRulebookVersion(provider.actor, rulebook.id, {
      version: '1.0',
    })
    fixture.registry.publishRulebookVersion(provider.actor, rulebook.id, '1.0')
    const validator = new CredentialValidator({
      source: fixture.registry,
      hostedSchemas: { publicBaseUrl: PUBLIC_BASE_URL, store: fixture.registry },
      now: () => '2026-01-01T00:00:00.000Z',
      generateId: () => 'mixed-sources-test-id',
    })

    const hosted = await validator.validate({
      rulebookId: rulebook.id,
      rulebookVersion: version.version,
      attestationType: 'Hosted',
      credential: await issueTestCredential(),
    })
    expect(dimension(hosted, 'schema_validation')?.status).toBe('PASS')
    expect(hosted.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: true })

    const externalWithoutDocument = await validator.validate({
      rulebookId: rulebook.id,
      rulebookVersion: version.version,
      attestationType: 'External',
      credential: await issueTestCredential(),
    })
    expect(dimension(externalWithoutDocument, 'schema_validation')?.status).toBe('NOT_TESTED')

    const externalWithDocument = await validator.validate({
      rulebookId: rulebook.id,
      rulebookVersion: version.version,
      attestationType: 'External',
      credential: await issueTestCredential(),
      schemaDocuments: [{ uri: EXTERNAL_SCHEMA_URI, content: PID_JSON_SCHEMA_TEXT }],
    })
    expect(dimension(externalWithDocument, 'schema_validation')?.status).toBe('PASS')
    expect(externalWithDocument.schemaReferences[0]).toMatchObject({
      source: 'caller',
      applied: true,
    })
  })
})
