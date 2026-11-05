import { describe, expect, test } from 'bun:test'

import { sha256Hex } from '../registry/digest'
import { ImportError, type ImportErrorCode } from './errors'
import { DEFAULT_IMPORT_LIMITS } from './limits'
import { previewImport } from './preview'
import {
  createFakeTransport,
  IMPORT_URL,
  invalidTs11Document,
  jsonBytes,
  owfDocument,
  publicResolver,
  ts11Document,
  ts11WithSchemaReferences,
  validTs11Document,
} from './test/fixtures'

const encoder = new TextEncoder()
const limits = { ...DEFAULT_IMPORT_LIMITS, maxSourceBytes: 200_000 }

async function previewUrl(document: unknown) {
  const fake = createFakeTransport({
    [IMPORT_URL]: { body: jsonBytes(document) },
  })
  const preview = await previewImport(
    { kind: 'url', url: IMPORT_URL },
    {
      limits,
      transport: fake.transport,
      resolveHostname: publicResolver,
      now: () => '2026-11-05T10:00:00.000Z',
    },
  )
  return { preview, fake }
}

async function expectPreviewError(
  source: Parameters<typeof previewImport>[0],
  code: ImportErrorCode,
): Promise<ImportError> {
  let caught: unknown
  try {
    await previewImport(source, {
      limits,
      transport: createFakeTransport({}).transport,
      resolveHostname: publicResolver,
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ImportError)
  expect((caught as ImportError).code).toBe(code)
  return caught as ImportError
}

describe('import preview of a single rulebook', () => {
  test('validates a TS11 document, classifies it and records provenance', async () => {
    const { preview } = await previewUrl(validTs11Document)

    expect(preview.source.adapter).toBe('url')
    expect(preview.source.url).toBe(IMPORT_URL)
    expect(preview.source.requestedUrl).toBe(IMPORT_URL)
    expect(preview.source.retrievedAt).toBe('2026-11-05T10:00:00.000Z')
    expect(preview.source.contentDigest).toBe(
      sha256Hex(encoder.encode(jsonBytes(validTs11Document))),
    )
    expect(preview.source.envelope).toEqual({ kind: 'single', member: null, metadata: {} })

    expect(preview.entries).toHaveLength(1)
    const entry = preview.entries[0]
    expect(entry?.structuralStatus).toBe('valid')
    expect(entry?.profile).toBe('ts11@1.0.1')
    expect(entry?.conformance).toBe('conformant_subset')
    expect(entry?.compatible).toBe(true)
    expect(entry?.schemaReferences).toHaveLength(1)
    expect(entry?.diagnostics).toEqual([])
    expect(preview.compatibility).toMatchObject({
      compatible: true,
      totalEntries: 1,
      validEntries: 1,
      invalidEntries: 0,
      conformantSubset: 1,
    })
    expect(preview.diagnostics[0]?.code).toBe('schema_references_not_resolved')
  })

  test('classifies an OWF document as partial against the TS11 baseline', async () => {
    const { preview } = await previewUrl(owfDocument)

    const entry = preview.entries[0]
    expect(entry?.structuralStatus).toBe('valid')
    expect(entry?.profile).toBe('owf@0.5.4')
    expect(entry?.conformance).toBe('partial')
    expect(entry?.compatible).toBe(true)
    expect(preview.compatibility.partial).toBe(1)
    expect(preview.compatibility.limitations.join(' ')).toContain('OWF 0.5.4')
  })

  test('reports a structural error for an invalid rulebook and refuses compatibility', async () => {
    const { preview } = await previewUrl(invalidTs11Document)

    const entry = preview.entries[0]
    expect(entry?.structuralStatus).toBe('invalid')
    expect(entry?.conformance).toBe('not_verified')
    expect(entry?.compatible).toBe(false)
    expect(entry?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'missing_required_member',
    )
    expect(preview.compatibility.compatible).toBe(false)
    expect(preview.compatibility.invalidEntries).toBe(1)
  })
})

describe('import preview of catalog envelopes', () => {
  test('previews a SIROS-style data catalog and reports each broken entry', async () => {
    const catalog = { data: [validTs11Document, invalidTs11Document] }
    const { preview } = await previewUrl(catalog)

    expect(preview.source.envelope.kind).toBe('catalog')
    expect(preview.source.envelope.member).toBe('data')
    expect(preview.entries).toHaveLength(2)
    expect(preview.compatibility).toMatchObject({
      compatible: false,
      totalEntries: 2,
      validEntries: 1,
      invalidEntries: 1,
      conformantSubset: 1,
      notVerified: 1,
    })
    expect(preview.compatibility.limitations).toContain(
      '1 entry has unverified conformance and will not be treated as TS11-conformant',
    )
  })

  test('retains a source self-reported partial conformance signal separately', async () => {
    const entry = {
      ...ts11Document(),
      conformance: { level: 'partial', missing: ['attestationLoS', 'bindingType'] },
    }
    const { preview } = await previewUrl({ content: [entry] })

    const previewEntry = preview.entries[0]
    expect(previewEntry?.sourceConformance).toEqual({
      level: 'partial',
      missing: ['attestationLoS', 'bindingType'],
    })
    expect(previewEntry?.conformance).toBe('partial')
  })

  test('a source "none" claim downgrades an otherwise valid entry to not_verified', async () => {
    const entry = { ...ts11Document(), conformance: { level: 'none' } }
    const { preview } = await previewUrl({ data: [entry] })

    expect(preview.entries[0]?.conformance).toBe('not_verified')
  })

  test('accepts a bare array of entries', async () => {
    const { preview } = await previewUrl([validTs11Document])

    expect(preview.source.envelope.kind).toBe('array')
    expect(preview.source.envelope.member).toBeNull()
    expect(preview.compatibility.compatible).toBe(true)
  })

  test('records non-structural envelope metadata as provenance', async () => {
    const { preview } = await previewUrl({
      schemaVersion: '2.0.0',
      catalogType: 'credential',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      data: [validTs11Document],
    })

    expect(preview.source.envelope.metadata).toEqual({
      schemaVersion: '2.0.0',
      catalogType: 'credential',
      lastUpdated: '2026-01-01T00:00:00.000Z',
    })
  })
})

describe('schema-reference controls', () => {
  test('rejects an entry with more references than the configured limit', async () => {
    const document = ts11WithSchemaReferences([
      { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.com/a.json' },
      { formatIdentifier: 'mso_mdoc', uri: 'https://example.com/b.json' },
      { formatIdentifier: 'jwt_vc_json', uri: 'https://example.com/c.json' },
    ])
    const fake = createFakeTransport({ [IMPORT_URL]: { body: jsonBytes(document) } })
    const preview = await previewImport(
      { kind: 'url', url: IMPORT_URL },
      {
        limits: { ...limits, maxSchemaReferencesPerEntry: 2 },
        transport: fake.transport,
        resolveHostname: publicResolver,
      },
    )

    const entry = preview.entries[0]
    expect(entry?.compatible).toBe(false)
    expect(
      entry?.diagnostics.find((diagnostic) => diagnostic.code === 'schema_reference_limit'),
    ).toMatchObject({
      kind: 'limit',
      code: 'schema_reference_limit',
      path: 'schemaURIs',
    })
    expect(preview.compatibility.compatible).toBe(false)
  })

  test('rejects a non-https schema reference', async () => {
    const document = ts11WithSchemaReferences([
      { formatIdentifier: 'dc+sd-jwt', uri: 'http://example.com/schema.json' },
    ])
    const { preview } = await previewUrl(document)

    expect(preview.entries[0]?.compatible).toBe(false)
    expect(
      preview.entries[0]?.diagnostics.find(
        (diagnostic) => diagnostic.code === 'schema_reference_invalid',
      ),
    ).toMatchObject({
      kind: 'unsupported_operation',
      code: 'schema_reference_invalid',
      path: 'schemaURIs.0.uri',
    })
  })

  test('rejects a schema-reference URI over the length limit', async () => {
    const document = ts11WithSchemaReferences([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: `https://example.com/${'a'.repeat(100)}.json`,
      },
    ])
    const fake = createFakeTransport({ [IMPORT_URL]: { body: jsonBytes(document) } })
    const preview = await previewImport(
      { kind: 'url', url: IMPORT_URL },
      {
        limits: { ...limits, maxSchemaReferenceLength: 40 },
        transport: fake.transport,
        resolveHostname: publicResolver,
      },
    )

    expect(preview.entries[0]?.compatible).toBe(false)
    expect(preview.entries[0]?.diagnostics[0]?.code).toBe('schema_reference_limit')
  })
})

describe('import source and document limits', () => {
  test('rejects an unsupported catalog envelope', async () => {
    await expectPreviewError(
      { kind: 'json', content: jsonBytes({ data: 'not-an-array' }) },
      'invalid_catalog',
    )
    await expectPreviewError({ kind: 'json', content: jsonBytes({ data: [] }) }, 'invalid_catalog')
    await expectPreviewError(
      { kind: 'json', content: jsonBytes({ unknown: [] }) },
      'invalid_catalog',
    )
  })

  test('rejects a JWS compact catalogue response', async () => {
    await expectPreviewError(
      { kind: 'json', content: jsonBytes('eyJhbGciOiJFUzI1NiJ9.payload.signature') },
      'invalid_catalog',
    )
  })

  test('rejects a catalog with more entries than the configured limit', async () => {
    const fake = createFakeTransport({
      [IMPORT_URL]: { body: jsonBytes({ data: [validTs11Document, validTs11Document] }) },
    })
    let caught: unknown
    try {
      await previewImport(
        { kind: 'url', url: IMPORT_URL },
        {
          limits: { ...limits, maxCatalogEntries: 1 },
          transport: fake.transport,
          resolveHostname: publicResolver,
        },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ImportError)
    expect((caught as ImportError).code).toBe('entry_limit')
  })

  test('rejects a deeply nested or oversized JSON source', async () => {
    await expectPreviewError(
      { kind: 'json', content: `${'['.repeat(60)}1${']'.repeat(60)}` },
      'json_limit',
    )
    await expectPreviewError(
      { kind: 'json', content: jsonBytes({ data: ['x'.repeat(200_001)] }) },
      'response_too_large',
    )
  })

  test('retains a JSON source name and URL as provenance without fetching', async () => {
    const preview = await previewImport(
      {
        kind: 'json',
        content: jsonBytes(validTs11Document),
        name: 'local-schemas.json',
        sourceUrl: 'https://catalog.example.test/original.json',
      },
      { limits, now: () => '2026-11-05T10:00:00.000Z' },
    )

    expect(preview.source).toMatchObject({
      adapter: 'json',
      url: 'https://catalog.example.test/original.json',
      requestedUrl: null,
      name: 'local-schemas.json',
      status: null,
      contentType: 'application/json',
      retrievedAt: '2026-11-05T10:00:00.000Z',
    })
    expect(preview.compatibility.compatible).toBe(true)
  })

  test('rejects an unsafe JSON source URL', async () => {
    await expectPreviewError(
      {
        kind: 'json',
        content: jsonBytes(validTs11Document),
        sourceUrl: 'http://127.0.0.1/x',
      },
      'invalid_url',
    )
  })
})
