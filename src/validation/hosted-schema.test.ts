// Strict canonical-URL recognition and local-store resolution for hosted
// credential schemas (issue #101). These unit tests never touch the network:
// the store is an in-memory fake and the resolver only reads it.

import { describe, expect, test } from 'bun:test'

import { sha256Hex } from '../registry/digest'
import { invalidInput } from '../registry/errors'
import type { CredentialSchemaDocument, CredentialSchemaDocumentContent } from '../registry/types'
import { MAX_ID_LENGTH } from '../registry/validation'

import { hostedSchemaDocumentId, resolveHostedSchemaDocuments } from './hosted-schema'
import type { SnapshotSchemaReference } from './types'

const PUBLIC_BASE_URL = 'https://schemas.example'
const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111'
const DOCUMENT_TEXT = '{"type":"object","required":["family_name"]}'
const DOCUMENT_URI = `${PUBLIC_BASE_URL}/api/v1/schema-documents/${DOCUMENT_ID}/content`

function storedDocument(
  text: string,
  overrides: Partial<CredentialSchemaDocument> = {},
): CredentialSchemaDocument {
  const bytes = new TextEncoder().encode(text)
  return {
    id: DOCUMENT_ID,
    providerId: 'provider-1',
    kind: 'json_schema_2020_12',
    mediaType: 'application/schema+json',
    contentDigest: sha256Hex(bytes),
    provenance: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function contentFor(text: string): CredentialSchemaDocumentContent {
  return {
    document: storedDocument(text),
    bytes: new TextEncoder().encode(text),
  }
}

function storeWith(
  content: CredentialSchemaDocumentContent | null,
): (id: string) => CredentialSchemaDocumentContent | null {
  return (id: string) => (id === DOCUMENT_ID ? content : null)
}

function reference(uri: string): SnapshotSchemaReference {
  return {
    formatIdentifier: 'dc+sd-jwt',
    uri,
    integrity: `sha256-${Buffer.from(sha256Hex(new TextEncoder().encode(DOCUMENT_TEXT)), 'hex').toString('base64')}`,
  }
}

describe('hostedSchemaDocumentId', () => {
  test('accepts exactly the canonical content URL of the configured origin', () => {
    expect(hostedSchemaDocumentId(DOCUMENT_URI, PUBLIC_BASE_URL)).toBe(DOCUMENT_ID)
    expect(hostedSchemaDocumentId(DOCUMENT_URI, `${PUBLIC_BASE_URL}/`)).toBe(DOCUMENT_ID)
  })

  test('rejects a URI that only starts with the hosted path or a look-alike origin', () => {
    const rejected = [
      // Prefix alone never classifies a URI, even with the right path shape.
      `${PUBLIC_BASE_URL}.evil.example/api/v1/schema-documents/${DOCUMENT_ID}/content`,
      `https://evil.example/api/v1/schema-documents/${DOCUMENT_ID}/content`,
      `${PUBLIC_BASE_URL}/api/v1/schema-documents/${DOCUMENT_ID}/content/extra`,
      `${PUBLIC_BASE_URL}/api/v1/schema-documents/${DOCUMENT_ID}/content?x=1`,
      `${PUBLIC_BASE_URL}/api/v1/schema-documents/${DOCUMENT_ID}/content#fragment`,
      `${PUBLIC_BASE_URL}/api/v1/schema-documents/../${DOCUMENT_ID}/content`,
      `${PUBLIC_BASE_URL}/api/v1/schema-documents//content`,
      `${PUBLIC_BASE_URL}/api/v1/schema-documents/${DOCUMENT_ID}/metadata`,
      `http://schemas.example/api/v1/schema-documents/${DOCUMENT_ID}/content`,
      `https://user:pass@schemas.example/api/v1/schema-documents/${DOCUMENT_ID}/content`,
      `https://schemas.example:8443/api/v1/schema-documents/${DOCUMENT_ID}/content`,
      'not a url',
      `urn:attestbook:${DOCUMENT_ID}`,
    ]
    for (const uri of rejected) {
      expect(hostedSchemaDocumentId(uri, PUBLIC_BASE_URL)).toBeNull()
    }
  })

  test('rejects a document id longer than the registry identifier bound', () => {
    const longest = 'a'.repeat(MAX_ID_LENGTH)
    expect(
      hostedSchemaDocumentId(
        `${PUBLIC_BASE_URL}/api/v1/schema-documents/${longest}/content`,
        PUBLIC_BASE_URL,
      ),
    ).toBe(longest)
    // An overlong id is not a canonical hosted URL: it must stay external
    // instead of reaching a registry read that would reject it.
    expect(
      hostedSchemaDocumentId(
        `${PUBLIC_BASE_URL}/api/v1/schema-documents/${'a'.repeat(MAX_ID_LENGTH + 1)}/content`,
        PUBLIC_BASE_URL,
      ),
    ).toBeNull()
  })
})

describe('resolveHostedSchemaDocuments', () => {
  test('resolves exact stored bytes and their recorded digest', () => {
    const resolutions = resolveHostedSchemaDocuments({
      references: [reference(DOCUMENT_URI)],
      publicBaseUrl: PUBLIC_BASE_URL,
      store: {
        getCredentialSchemaDocumentContent: storeWith(contentFor(DOCUMENT_TEXT)),
      },
    })
    expect(resolutions.get(0)).toEqual({
      kind: 'resolved',
      documentId: DOCUMENT_ID,
      contentDigest: sha256Hex(new TextEncoder().encode(DOCUMENT_TEXT)),
      content: DOCUMENT_TEXT,
    })
  })

  test('leaves an external URI to the caller-supplied flow', () => {
    const resolutions = resolveHostedSchemaDocuments({
      references: [reference('https://example.org/schemas/pid.json')],
      publicBaseUrl: PUBLIC_BASE_URL,
      store: {
        getCredentialSchemaDocumentContent: storeWith(contentFor(DOCUMENT_TEXT)),
      },
    })
    expect(resolutions.size).toBe(0)
  })

  test('reports a canonical URI whose document is absent from the store', () => {
    const resolutions = resolveHostedSchemaDocuments({
      references: [reference(DOCUMENT_URI)],
      publicBaseUrl: PUBLIC_BASE_URL,
      store: { getCredentialSchemaDocumentContent: storeWith(null) },
    })
    expect(resolutions.get(0)).toEqual({ kind: 'missing', documentId: DOCUMENT_ID })
  })

  test('reports stored bytes that no longer hash to the recorded digest', () => {
    const resolutions = resolveHostedSchemaDocuments({
      references: [reference(DOCUMENT_URI)],
      publicBaseUrl: PUBLIC_BASE_URL,
      store: {
        getCredentialSchemaDocumentContent: storeWith({
          // Valid JSON, but not the bytes the recorded digest pins.
          document: storedDocument(DOCUMENT_TEXT),
          bytes: new TextEncoder().encode('{"type":"object"}'),
        }),
      },
    })
    expect(resolutions.get(0)).toEqual({ kind: 'corrupt', documentId: DOCUMENT_ID })
  })

  test('reports stored bytes that are not valid UTF-8', () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0xfd])
    const resolutions = resolveHostedSchemaDocuments({
      references: [reference(DOCUMENT_URI)],
      publicBaseUrl: PUBLIC_BASE_URL,
      store: {
        getCredentialSchemaDocumentContent: storeWith({
          document: storedDocument(DOCUMENT_TEXT, { contentDigest: sha256Hex(bytes) }),
          bytes,
        }),
      },
    })
    expect(resolutions.get(0)).toEqual({ kind: 'corrupt', documentId: DOCUMENT_ID })
  })

  test('treats a store input-validation failure as a missing document', () => {
    const resolutions = resolveHostedSchemaDocuments({
      references: [reference(DOCUMENT_URI)],
      publicBaseUrl: PUBLIC_BASE_URL,
      store: {
        getCredentialSchemaDocumentContent: () => {
          throw invalidInput('documentId must be at most 128 characters')
        },
      },
    })
    expect(resolutions.get(0)).toEqual({ kind: 'missing', documentId: DOCUMENT_ID })
  })

  test('rethrows a store failure that is not an input-validation error', () => {
    const failure = new Error('database unavailable')
    expect(() =>
      resolveHostedSchemaDocuments({
        references: [reference(DOCUMENT_URI)],
        publicBaseUrl: PUBLIC_BASE_URL,
        store: {
          getCredentialSchemaDocumentContent: () => {
            throw failure
          },
        },
      }),
    ).toThrow(failure)
  })
})
