// HTTP tests for the public hosted/external schema provenance in rulebook
// details, drafts and exact version inspection (issue #103).
//
// The tests run the real registry over a temporary SQLite database and the real
// application, so the stored-document association, the public URL composition
// and the frozen snapshot projection are the ones the server exposes. They also
// assert that the projection never carries provider ownership or provenance.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'

import { createApp } from '../app'
import { credentialSchemaDocumentUrl, sha256Sri } from '../public-urls'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import type { CredentialSchemaDocument } from '../registry/types'

const PUBLIC_BASE_URL = 'https://schemas.example'

const JSON_SCHEMA_TEXT =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["family_name"],"properties":{"family_name":{"type":"string"}}}'

let fixture: RegistryFixture | undefined
let app: Hono
let providerId: string
let rulebookId: string
let versionDigest: string
let hostedDocument: CredentialSchemaDocument
let hostedUri: string
let lookalikeUri: string

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

beforeAll(async () => {
  fixture = createRegistryFixture()
  const provisioned = provisionProvider(fixture.database, {
    name: 'Provenance Provider',
    publicationAuthority: 'provenance-provider',
  })
  providerId = provisioned.provider.id
  hostedDocument = await fixture.registry.registerCredentialSchemaDocument(provisioned.actor, {
    kind: 'json_schema_2020_12',
    bytes: new TextEncoder().encode(JSON_SCHEMA_TEXT),
    provenance: { source: 'http-test' },
  })
  hostedUri = credentialSchemaDocumentUrl(PUBLIC_BASE_URL, hostedDocument.id)
  lookalikeUri = `${hostedUri}/extra`

  const rulebook = fixture.registry.createRulebook(provisioned.actor, {
    name: 'Provenance Rulebook',
    description: 'Hosted and external schema references.',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Person Identification Data',
        attestationLoS: 'iso_18045_high',
        bindingType: 'cryptographic',
        supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      },
    ],
  })
  rulebookId = rulebook.id
  const attestation = fixture.registry.listAttestations(rulebookId)[0]
  if (attestation === undefined) {
    throw new Error('test setup did not create the attestation type')
  }
  fixture.registry.addSchemaReference(provisioned.actor, rulebookId, {
    formatIdentifier: 'dc+sd-jwt',
    uri: hostedUri,
    integrity: sha256Sri(hostedDocument.contentDigest),
    attestationId: attestation.id,
  })
  fixture.registry.addSchemaReference(provisioned.actor, rulebookId, {
    formatIdentifier: 'mso_mdoc',
    uri: lookalikeUri,
    attestationId: attestation.id,
  })
  fixture.registry.addSchemaReference(provisioned.actor, rulebookId, {
    formatIdentifier: 'vc+sd-jwt',
    uri: 'https://issuer.example.org/schemas/rulebook',
  })
  const version = fixture.registry.createRulebookVersion(provisioned.actor, rulebookId, {
    version: '1.0',
  })
  fixture.registry.publishRulebookVersion(provisioned.actor, rulebookId, '1.0')
  versionDigest = version.contentDigest

  app = createApp({ registry: fixture.registry, publicBaseUrl: PUBLIC_BASE_URL })
})

afterAll(() => {
  fixture?.cleanup()
  fixture = undefined
})

describe('hosted schema provenance projections', () => {
  test('lists hosted and external references with the stored-document association', async () => {
    const response = await app.request(`/api/v1/rulebooks/${rulebookId}/schema-references`)
    expect(response.status).toBe(200)
    const body = await json<{
      data: readonly {
        uri: string
        hostedSchema: {
          id: string
          kind: string
          mediaType: string
          contentDigest: string
          integrity: string
          url: string
          createdAt: string
        } | null
      }[]
    }>(response)

    const hosted = body.data.find((reference) => reference.uri === hostedUri)
    const lookalike = body.data.find((reference) => reference.uri === lookalikeUri)
    expect(hosted?.hostedSchema).toEqual({
      id: hostedDocument.id,
      kind: 'json_schema_2020_12',
      mediaType: 'application/schema+json',
      contentDigest: hostedDocument.contentDigest,
      integrity: sha256Sri(hostedDocument.contentDigest),
      url: hostedUri,
      createdAt: hostedDocument.createdAt,
    })
    // A near-miss path is not the canonical content URL, so it stays external.
    expect(lookalike?.hostedSchema).toBeNull()
    // Ownership, provenance and tokens never leave the registry.
    const payload = JSON.stringify(body)
    expect(payload).not.toContain(providerId)
    expect(payload).not.toContain('provenance')
    expect(payload).not.toContain('http-test')
  })

  test('includes the association in attestation and draft projections', async () => {
    const attestations = await app.request(`/api/v1/rulebooks/${rulebookId}/attestations`)
    expect(attestations.status).toBe(200)
    const attestationBody = await json<{
      data: readonly { schemaReferences: readonly { uri: string; hostedSchema: unknown }[] }[]
    }>(attestations)
    expect(
      attestationBody.data[0]?.schemaReferences.find((reference) => reference.uri === hostedUri)
        ?.hostedSchema,
    ).not.toBeNull()

    const draft = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`)
    expect(draft.status).toBe(200)
    const draftBody = await json<{
      data: {
        attestations: readonly {
          schemaReferences: readonly { uri: string; hostedSchema: unknown }[]
        }[]
        schemaReferences: readonly { uri: string; hostedSchema: unknown }[]
      }
    }>(draft)
    expect(
      draftBody.data.attestations[0]?.schemaReferences.find(
        (reference) => reference.uri === hostedUri,
      )?.hostedSchema,
    ).not.toBeNull()
    expect(draftBody.data.schemaReferences[0]?.hostedSchema).toBeNull()
  })

  test('inspects the exact frozen version with its references', async () => {
    const response = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/schema-references`,
    )
    expect(response.status).toBe(200)
    const body = await json<{
      data: {
        version: string
        contentDigest: string
        status: string
        publishedAt: string | null
        attestations: readonly {
          name: string
          schemaReferences: readonly {
            formatIdentifier: string
            uri: string
            integrity: string | null
            hostedSchema: { id: string } | null
          }[]
        }[]
        schemaReferences: readonly {
          formatIdentifier: string
          uri: string
          hostedSchema: unknown
        }[]
      }
    }>(response)

    expect(body.data.version).toBe('1.0')
    expect(body.data.contentDigest).toBe(versionDigest)
    expect(body.data.status).toBe('published')
    expect(body.data.publishedAt).not.toBeNull()
    expect(body.data.attestations).toHaveLength(1)
    expect(body.data.attestations[0]?.name).toBe('Person Identification Data')

    const references = body.data.attestations[0]?.schemaReferences ?? []
    expect(references.find((reference) => reference.uri === hostedUri)?.hostedSchema?.id).toBe(
      hostedDocument.id,
    )
    expect(references.find((reference) => reference.uri === lookalikeUri)?.hostedSchema).toBeNull()
    expect(body.data.schemaReferences[0]).toMatchObject({
      formatIdentifier: 'vc+sd-jwt',
      uri: 'https://issuer.example.org/schemas/rulebook',
      hostedSchema: null,
    })
  })

  test('answers 404 for an unknown version', async () => {
    const response = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/9.9/schema-references`,
    )
    expect(response.status).toBe(404)
    const body = await json<{ error: { code: string; message: string } }>(response)
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).not.toContain('schema_document')
  })

  test('reports every reference as external when no public origin is configured', async () => {
    const withoutOrigin = createApp({ registry: fixture!.registry })
    const response = await withoutOrigin.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/schema-references`,
    )
    expect(response.status).toBe(200)
    const body = await json<{
      data: {
        attestations: readonly {
          schemaReferences: readonly { uri: string; hostedSchema: unknown }[]
        }[]
      }
    }>(response)
    expect(
      body.data.attestations[0]?.schemaReferences.find((reference) => reference.uri === hostedUri)
        ?.hostedSchema,
    ).toBeNull()
  })
})
