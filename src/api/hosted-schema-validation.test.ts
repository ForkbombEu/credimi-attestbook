// HTTP contract for credential validation with AttestBook-hosted schemas
// (#101): a client omitting `schemaDocuments` still gets an executed schema
// dimension from the local store, while an external-only reference stays
// NOT_TESTED until the caller supplies the exact bytes.

import { afterEach, describe, expect, test } from 'bun:test'

import { createApp, type ErrorEnvelope } from '../app'
import { credentialSchemaDocumentUrl, sha256Sri as sriForDigest } from '../public-urls'
import { provisionProvider } from '../registry/bootstrap'
import type { CredentialSchemaDocument } from '../registry/types'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { CredentialValidator, type CredentialValidationResult } from '../validation'
import {
  issueTestCredential,
  PID_JSON_SCHEMA_TEXT,
  seedPublishedRulebook,
  sha256Sri,
  type SeededRulebook,
} from '../validation/test-support'

const PUBLIC_BASE_URL = 'https://schemas.example'
const EXTERNAL_SCHEMA_URI = 'https://example.org/schemas/pid.json'
const HOSTED_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['family_name'],
  properties: { family_name: { type: 'string' } },
})

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

interface HostedApp {
  readonly app: ReturnType<typeof createApp>
  readonly document: CredentialSchemaDocument
  readonly seeded: SeededRulebook
}

async function setupHosted(): Promise<HostedApp> {
  fixture = createRegistryFixture()
  const provider = provisionProvider(fixture.database, {
    name: 'Hosted HTTP provider',
    publicationAuthority: 'hosted-http',
  })
  const document = await fixture.registry.registerCredentialSchemaDocument(provider.actor, {
    kind: 'json_schema_2020_12',
    bytes: new TextEncoder().encode(HOSTED_SCHEMA_TEXT),
    provenance: { source: 'hosted-http-test' },
  })
  const hostedUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, document.id)
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry, {
    authority: 'hosted-http-rulebook',
    schemaUri: hostedUri,
    schemaIntegrity: sriForDigest(document.contentDigest),
  })
  const validation = new CredentialValidator({
    source: fixture.registry,
    hostedSchemas: { publicBaseUrl: PUBLIC_BASE_URL, store: fixture.registry },
    now: () => '2026-01-01T00:00:00.000Z',
    generateId: () => 'hosted-http-validation-id',
  })
  return {
    app: createApp({ registry: fixture.registry, validation, publicBaseUrl: PUBLIC_BASE_URL }),
    document,
    seeded,
  }
}

function body(
  seeded: SeededRulebook,
  credential: string,
  schemaDocuments?: readonly { uri: string; content: string }[],
): string {
  return JSON.stringify({
    rulebookId: seeded.rulebookId,
    rulebookVersion: seeded.version,
    attestationType: seeded.attestationName,
    credential,
    ...(schemaDocuments === undefined ? {} : { schemaDocuments }),
  })
}

async function postValidate(app: ReturnType<typeof createApp>, bodyText: string) {
  return app.request('/api/v1/credentials/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  })
}

async function resultBody(response: Response): Promise<CredentialValidationResult> {
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { readonly data: CredentialValidationResult }
  return payload.data
}

describe('POST /api/v1/credentials/validate with hosted schemas', () => {
  test('applies a pinned hosted schema when the caller omits schemaDocuments', async () => {
    const { app, document, seeded } = await setupHosted()
    const result = await resultBody(
      await postValidate(app, body(seeded, await issueTestCredential())),
    )

    const schema = result.dimensions.find((entry) => entry.id === 'schema_validation')
    expect(schema?.status).toBe('PASS')
    expect(schema?.executed).toBe(true)
    expect(schema?.evidence.details).toMatchObject({
      documents_supplied: 0,
      applied_documents: 1,
      hosted_references: 1,
      hosted_documents_applied: 1,
    })
    expect(result.schemaReferences[0]).toMatchObject({
      uri: credentialSchemaDocumentUrl(PUBLIC_BASE_URL, document.id),
      applied: true,
      source: 'hosted',
    })
    expect(result.overallStatus).not.toBe('PASS')
  })

  test('caller schemaDocuments cannot override the stored hosted document', async () => {
    const { app, document, seeded } = await setupHosted()
    const claims = await issueTestCredential()
    const response = await postValidate(
      app,
      body(seeded, claims, [
        {
          uri: credentialSchemaDocumentUrl(PUBLIC_BASE_URL, document.id),
          content: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}',
        },
      ]),
    )
    const result = await resultBody(response)
    expect(result.dimensions.find((entry) => entry.id === 'schema_validation')?.status).toBe('PASS')
    expect(result.schemaReferences[0]?.source).toBe('hosted')
  })

  test('an unknown hosted document answers NOT_TESTED, never a false PASS', async () => {
    const { app, seeded } = await setupHosted()
    const missingUri = credentialSchemaDocumentUrl(
      PUBLIC_BASE_URL,
      '33333333-3333-4333-8333-333333333333',
    )
    const external = seedPublishedRulebook(fixture!.database, fixture!.registry, {
      authority: 'missing-hosted-http',
      schemaUri: missingUri,
      schemaIntegrity: sha256Sri(HOSTED_SCHEMA_TEXT),
    })
    const result = await resultBody(
      await postValidate(app, body(external, await issueTestCredential())),
    )

    const schema = result.dimensions.find((entry) => entry.id === 'schema_validation')
    expect(schema?.status).toBe('NOT_TESTED')
    expect(schema?.executed).toBe(false)
    expect(result.schemaReferences[0]).toMatchObject({ source: 'hosted', applied: false })
    expect(result.overallStatus).not.toBe('PASS')
    expect(seeded.rulebookId).not.toBe(external.rulebookId)
  })

  test('an overlong hosted-looking id answers 200 with NOT_TESTED, not a request error', async () => {
    const { app } = await setupHosted()
    const overlongUri = `${PUBLIC_BASE_URL}/api/v1/schema-documents/${'a'.repeat(129)}/content`
    const external = seedPublishedRulebook(fixture!.database, fixture!.registry, {
      authority: 'overlong-hosted-http',
      schemaUri: overlongUri,
      schemaIntegrity: sha256Sri(HOSTED_SCHEMA_TEXT),
    })
    const response = await postValidate(app, body(external, await issueTestCredential()))
    expect(response.status).toBe(200)
    const result = await resultBody(response)

    const schema = result.dimensions.find((entry) => entry.id === 'schema_validation')
    expect(schema?.status).toBe('NOT_TESTED')
    expect(schema?.executed).toBe(false)
    expect(result.schemaReferences[0]).toMatchObject({ source: null, applied: false })
    expect(result.overallStatus).not.toBe('PASS')
  })

  test('an external-only version keeps the caller-supplied schemaDocuments flow', async () => {
    const { app } = await setupHosted()
    const external = seedPublishedRulebook(fixture!.database, fixture!.registry, {
      authority: 'external-only-http',
      schemaUri: EXTERNAL_SCHEMA_URI,
      schemaContent: PID_JSON_SCHEMA_TEXT,
    })

    const withoutDocuments = await resultBody(
      await postValidate(app, body(external, await issueTestCredential())),
    )
    expect(
      withoutDocuments.dimensions.find((entry) => entry.id === 'schema_validation')?.status,
    ).toBe('NOT_TESTED')
    expect(withoutDocuments.schemaReferences[0]).toMatchObject({ source: null, applied: false })

    const withDocuments = await resultBody(
      await postValidate(
        app,
        body(external, await issueTestCredential(), [
          { uri: EXTERNAL_SCHEMA_URI, content: PID_JSON_SCHEMA_TEXT },
        ]),
      ),
    )
    expect(withDocuments.dimensions.find((entry) => entry.id === 'schema_validation')?.status).toBe(
      'PASS',
    )
    expect(withDocuments.schemaReferences[0]).toMatchObject({ source: 'caller', applied: true })
  })

  test('a malformed request still maps to the documented error envelope', async () => {
    const { app } = await setupHosted()
    const response = await postValidate(app, JSON.stringify({ rulebookId: 'nope' }))
    expect(response.status).toBe(400)
    const error = (await response.json()) as ErrorEnvelope
    expect(error.error.code).toBe('invalid_request')
  })
})
