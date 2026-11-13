import { describe, expect, test } from 'vitest'

import {
  MAX_HOSTED_SCHEMA_BYTES,
  insertSchemaReference,
  previewHostedSchema,
  referenceForFormat,
  removeSchemaReference,
  schemaControlAttestations,
  validateExternalSchema,
} from './schema-reference'
import type { DraftContentDocument } from './types'

const VALID_SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Payment account schema',
  type: 'object',
  required: ['iban'],
  properties: { iban: { type: 'string' } },
})

const DOCUMENT: DraftContentDocument = {
  attestations: [
    {
      name: 'Payment Account',
      attestationLoS: 'iso_18045_high',
      bindingType: 'cryptographic',
      supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      schemaReferences: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://issuer.example.org/schemas/payment',
          integrity: 'sha256-AAAA',
        },
      ],
    },
    {
      name: 'Account Details',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
      supportedFormats: ['dc+sd-jwt'],
      schemaReferences: [],
    },
  ],
  schemaReferences: [],
}

describe('previewHostedSchema', () => {
  test('reports the exact bytes, title and dialect of a valid 2020-12 schema', () => {
    const preview = previewHostedSchema(VALID_SCHEMA)
    expect(preview.ok).toBe(true)
    if (!preview.ok) {
      throw new Error(preview.message)
    }
    expect(preview.byteLength).toBe(new TextEncoder().encode(VALID_SCHEMA).byteLength)
    expect(preview.title).toBe('Payment account schema')
    expect(preview.dialect).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(preview.keywordCount).toBeGreaterThan(3)
  })

  test('accepts a boolean schema and a schema without $schema', () => {
    expect(previewHostedSchema('true').ok).toBe(true)
    expect(previewHostedSchema('{"type":"object"}').ok).toBe(true)
  })

  test('rejects an empty, invalid, non-schema or foreign-dialect document', () => {
    expect(previewHostedSchema('   ')).toEqual({
      ok: false,
      message: 'Paste a JSON Schema or choose a .json file.',
    })
    expect(previewHostedSchema('{nope')).toEqual({ ok: false, message: 'This is not valid JSON.' })
    expect(previewHostedSchema('[]')).toMatchObject({ ok: false })
    expect(previewHostedSchema('"text"')).toMatchObject({ ok: false })
    expect(previewHostedSchema('{"$schema":"https://json-schema.org/draft-07/schema#"}')).toEqual({
      ok: false,
      message: 'Declare the JSON Schema 2020-12 dialect in $schema, or omit $schema.',
    })
  })

  test('bounds the exact UTF-8 bytes before parsing', () => {
    const preview = previewHostedSchema('x'.repeat(MAX_HOSTED_SCHEMA_BYTES + 1))
    expect(preview.ok).toBe(false)
    if (!preview.ok) {
      expect(preview.message).toContain('262144')
    }
  })
})

describe('validateExternalSchema', () => {
  test('normalizes an https URL and keeps an optional SRI pin', () => {
    const result = validateExternalSchema(
      '  https://Issuer.Example.org/schemas/pid  ',
      'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    )
    expect(result.errors).toEqual({})
    expect(result.reference).toEqual({
      formatIdentifier: '',
      uri: 'https://issuer.example.org/schemas/pid',
      integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    })
  })

  test('omits an empty integrity pin', () => {
    const result = validateExternalSchema('https://issuer.example.org/schemas/pid', '  ')
    expect(result.errors).toEqual({})
    expect(result.reference).toEqual({
      formatIdentifier: '',
      uri: 'https://issuer.example.org/schemas/pid',
    })
  })

  test('rejects a missing, non-https or credential-bearing URL', () => {
    expect(validateExternalSchema('', '').errors.uri).toBe('A schema URL is required.')
    expect(validateExternalSchema('http://example.org/schema', '').errors.uri).toBe(
      'Use an absolute https:// schema URL.',
    )
    expect(validateExternalSchema('not a url', '').errors.uri).toBe(
      'Use an absolute https:// schema URL.',
    )
    expect(validateExternalSchema('https://user:secret@example.org/schema', '').errors.uri).toBe(
      'The schema URL must not embed credentials.',
    )
  })

  test('rejects a malformed SRI pin', () => {
    const result = validateExternalSchema('https://example.org/schema.json', 'sha256-nope!!')
    expect(result.errors.integrity).toContain('W3C SRI')
    expect(result.reference).toBeNull()
  })
})

describe('schemaControlAttestations', () => {
  test('keeps attestations and formats unambiguous and ordered', () => {
    const attestations = schemaControlAttestations(DOCUMENT)
    expect(attestations).toHaveLength(2)
    expect(attestations[0]).toMatchObject({
      index: 0,
      name: 'Payment Account',
      formats: ['dc+sd-jwt', 'mso_mdoc'],
    })
    expect(attestations[1]).toMatchObject({
      index: 1,
      name: 'Account Details',
      formats: ['dc+sd-jwt'],
      references: [],
    })
    expect(referenceForFormat(attestations[0]!, 'dc+sd-jwt')?.uri).toBe(
      'https://issuer.example.org/schemas/payment',
    )
    expect(referenceForFormat(attestations[0]!, 'mso_mdoc')).toBeNull()
  })

  test('adds formats that exist only on an existing reference and tolerates malformed members', () => {
    const document = {
      attestations: [
        {
          name: '  ',
          supportedFormats: ['dc+sd-jwt', 42],
          schemaReferences: [
            { formatIdentifier: 'mso_mdoc', uri: 'https://example.org/mdoc', integrity: null },
            { formatIdentifier: 'broken' },
          ],
        },
        'not-an-object',
      ],
      schemaReferences: [],
    } as unknown as DraftContentDocument
    const attestations = schemaControlAttestations(document)
    expect(attestations[0]).toEqual({
      index: 0,
      name: 'Attestation 1',
      formats: ['dc+sd-jwt', 'mso_mdoc'],
      references: [
        { formatIdentifier: 'mso_mdoc', uri: 'https://example.org/mdoc', integrity: null },
      ],
    })
    expect(attestations[1]).toMatchObject({ name: 'Attestation 2', formats: [], references: [] })
  })
})

describe('insertSchemaReference', () => {
  test('adds a reference to one attestation and preserves unrelated JSON', () => {
    const text = JSON.stringify({
      id: 'kept-top-level',
      attestations: [
        {
          name: 'Payment Account',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [],
          extension: { kept: true },
        },
        {
          name: 'Account Details',
          supportedFormats: ['mso_mdoc'],
          schemaReferences: [],
        },
      ],
      schemaReferences: [{ formatIdentifier: 'rb', uri: 'https://example.org/rb' }],
    })
    const result = insertSchemaReference(text, 1, {
      formatIdentifier: 'mso_mdoc',
      uri: 'https://issuer.example.org/schemas/account',
      integrity: 'sha256-AAAA',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.message)
    }
    const edited = JSON.parse(result.text) as {
      id: string
      attestations: readonly {
        schemaReferences: readonly unknown[]
        extension?: unknown
      }[]
      schemaReferences: readonly unknown[]
    }
    expect(edited.id).toBe('kept-top-level')
    expect(edited.attestations[0]?.schemaReferences).toEqual([])
    expect(edited.attestations[0]?.extension).toEqual({ kept: true })
    expect(edited.attestations[1]?.schemaReferences).toEqual([
      {
        formatIdentifier: 'mso_mdoc',
        uri: 'https://issuer.example.org/schemas/account',
        integrity: 'sha256-AAAA',
      },
    ])
    expect(edited.schemaReferences).toEqual([
      { formatIdentifier: 'rb', uri: 'https://example.org/rb' },
    ])
  })

  test('replaces the reference for the same format instead of duplicating it', () => {
    const text = JSON.stringify({
      attestations: [
        {
          name: 'Payment Account',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [
            {
              formatIdentifier: 'dc+sd-jwt',
              uri: 'https://issuer.example.org/schemas/old',
              integrity: 'sha256-OLD',
            },
          ],
        },
      ],
      schemaReferences: [],
    })
    const result = insertSchemaReference(text, 0, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://issuer.example.org/schemas/new',
      integrity: 'sha256-NEW',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.message)
    }
    expect(
      (JSON.parse(result.text) as { attestations: { schemaReferences: unknown[] }[] })
        .attestations[0]?.schemaReferences,
    ).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://issuer.example.org/schemas/new',
        integrity: 'sha256-NEW',
      },
    ])
  })

  test('refuses to guess when the document or the attestation is malformed', () => {
    expect(insertSchemaReference('{nope', 0, { formatIdentifier: 'a', uri: 'https://x' })).toEqual({
      ok: false,
      message: 'Fix the Draft JSON before adding a schema reference.',
    })
    expect(
      insertSchemaReference(JSON.stringify({ attestations: [] }), 3, {
        formatIdentifier: 'a',
        uri: 'https://x',
      }),
    ).toEqual({ ok: false, message: 'That attestation is no longer in the Draft JSON.' })
    expect(
      insertSchemaReference(JSON.stringify({ attestations: [{ schemaReferences: 'nope' }] }), 0, {
        formatIdentifier: 'a',
        uri: 'https://x',
      }),
    ).toEqual({
      ok: false,
      message: 'Fix the attestation schemaReferences array before adding a reference.',
    })
  })
})

describe('removeSchemaReference', () => {
  test('removes only the matching format', () => {
    const text = JSON.stringify({
      attestations: [
        {
          name: 'Payment Account',
          schemaReferences: [
            { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/a' },
            { formatIdentifier: 'mso_mdoc', uri: 'https://example.org/b' },
          ],
        },
      ],
    })
    const result = removeSchemaReference(text, 0, 'dc+sd-jwt')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.message)
    }
    expect(
      (JSON.parse(result.text) as { attestations: { schemaReferences: unknown[] }[] })
        .attestations[0]?.schemaReferences,
    ).toEqual([{ formatIdentifier: 'mso_mdoc', uri: 'https://example.org/b' }])
  })

  test('reports a reference that is no longer present', () => {
    expect(
      removeSchemaReference(JSON.stringify({ attestations: [{ schemaReferences: [] }] }), 0, 'x'),
    ).toEqual({ ok: false, message: 'That schema reference is no longer in the Draft JSON.' })
  })
})
