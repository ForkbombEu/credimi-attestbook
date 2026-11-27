import { describe, expect, test } from 'vitest'

import {
  MAX_HOSTED_SCHEMA_BYTES,
  addAttestation,
  cborKeywordWarnings,
  credentialTypeKeyword,
  declaredCredentialType,
  insertSchemaReference,
  mdocNamespaces,
  mergeCredentialType,
  previewHostedSchema,
  referenceForFormat,
  removeAttestation,
  removeSchemaReference,
  replaceAttestation,
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
      attestationLoS: null,
      bindingType: null,
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

  test('refuses an insert when the expected attestation name no longer matches', () => {
    const text = JSON.stringify({
      attestations: [
        {
          name: 'Payment Account',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [],
        },
      ],
      schemaReferences: [],
    })
    const reference = { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/new' }

    expect(insertSchemaReference(text, 0, reference, 'Account Details')).toEqual({
      ok: false,
      message:
        'The attestation changed while the schema was being registered; insert the reference again.',
    })
    expect(insertSchemaReference(text, 0, reference, 'Payment Account').ok).toBe(true)
    expect(
      insertSchemaReference(
        JSON.stringify({ attestations: [{ schemaReferences: [] }] }),
        0,
        reference,
        'Attestation 1',
      ).ok,
    ).toBe(true)
  })

  test('preserves members of references on other formats', () => {
    const text = JSON.stringify({
      attestations: [
        {
          name: 'Payment Account',
          supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
          schemaReferences: [
            {
              formatIdentifier: 'mso_mdoc',
              uri: 'https://example.org/mdoc',
              metadata: { source: 'imported' },
            },
          ],
        },
      ],
      schemaReferences: [],
    })
    const result = insertSchemaReference(text, 0, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/sd-jwt',
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
        formatIdentifier: 'mso_mdoc',
        uri: 'https://example.org/mdoc',
        metadata: { source: 'imported' },
      },
      { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/sd-jwt' },
    ])
  })

  test('refuses to guess when the document or the attestation is malformed', () => {
    expect(insertSchemaReference('{nope', 0, { formatIdentifier: 'a', uri: 'https://x' })).toEqual({
      ok: false,
      message: 'The draft document could not be read; add the schema reference again.',
    })
    expect(
      insertSchemaReference(JSON.stringify({ attestations: [] }), 3, {
        formatIdentifier: 'a',
        uri: 'https://x',
      }),
    ).toEqual({ ok: false, message: 'That attestation is no longer in the draft.' })
    expect(
      insertSchemaReference(JSON.stringify({ attestations: [{ schemaReferences: 'nope' }] }), 0, {
        formatIdentifier: 'a',
        uri: 'https://x',
      }),
    ).toEqual({
      ok: false,
      message: 'Fix the attestation schemaReferences array in the draft before adding a reference.',
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
    ).toEqual({ ok: false, message: 'That schema reference is no longer in the draft.' })
  })
})

const ATTESTATION_DOCUMENT = JSON.stringify({
  id: 'kept-top-level',
  attestations: [
    {
      name: 'Payment Account',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
      supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      schemaReferences: [
        { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/sd-jwt' },
        { formatIdentifier: 'mso_mdoc', uri: 'https://example.org/mdoc' },
      ],
      extension: { kept: true },
    },
    {
      name: 'Account Details',
      attestationLoS: 'iso_18045_moderate',
      bindingType: 'claim',
      supportedFormats: ['dc+sd-jwt'],
      schemaReferences: [],
    },
  ],
  schemaReferences: [{ formatIdentifier: 'rb', uri: 'https://example.org/rulebook-level' }],
})

type EditedAttestation = {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly schemaReferences: readonly { readonly formatIdentifier: string }[]
  readonly extension?: unknown
}

type EditedDocument = {
  readonly id?: string
  readonly attestations: readonly EditedAttestation[]
  readonly schemaReferences: readonly unknown[]
}

function editedDocument(result: { readonly ok: boolean; readonly text?: string }): EditedDocument {
  if (!result.ok || result.text === undefined) {
    throw new Error('the edit must succeed')
  }
  return JSON.parse(result.text) as EditedDocument
}

describe('addAttestation', () => {
  test('appends an attestation with no references and keeps everything else', () => {
    const document = editedDocument(
      addAttestation(ATTESTATION_DOCUMENT, {
        name: 'Loyalty Card',
        attestationLoS: 'iso_18045_basic',
        bindingType: 'key',
        supportedFormats: ['mso_mdoc'],
      }),
    )
    expect(document.id).toBe('kept-top-level')
    expect(document.schemaReferences).toEqual([
      { formatIdentifier: 'rb', uri: 'https://example.org/rulebook-level' },
    ])
    expect(document.attestations).toHaveLength(3)
    expect(document.attestations[2]).toEqual({
      name: 'Loyalty Card',
      attestationLoS: 'iso_18045_basic',
      bindingType: 'key',
      supportedFormats: ['mso_mdoc'],
      schemaReferences: [],
    })
    expect(document.attestations[0]?.extension).toEqual({ kept: true })
  })

  test('refuses a document that cannot be read', () => {
    expect(
      addAttestation('{nope', {
        name: 'Loyalty Card',
        attestationLoS: 'iso_18045_basic',
        bindingType: 'key',
        supportedFormats: ['mso_mdoc'],
      }),
    ).toEqual({ ok: false, message: 'The draft document could not be read.' })
  })
})

describe('replaceAttestation', () => {
  test('updates the four fields and preserves unmodelled members', () => {
    const document = editedDocument(
      replaceAttestation(ATTESTATION_DOCUMENT, 0, {
        name: 'Renamed Account',
        attestationLoS: 'iso_18045_enhanced-basic',
        bindingType: 'biometric',
        supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      }),
    )
    expect(document.attestations[0]).toMatchObject({
      name: 'Renamed Account',
      attestationLoS: 'iso_18045_enhanced-basic',
      bindingType: 'biometric',
      supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      extension: { kept: true },
    })
    expect(document.attestations[0]?.schemaReferences).toEqual([
      { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/sd-jwt' },
      { formatIdentifier: 'mso_mdoc', uri: 'https://example.org/mdoc' },
    ])
    expect(document.attestations[1]?.name).toBe('Account Details')
  })

  test('drops the schema reference of a format the attestation no longer supports', () => {
    const document = editedDocument(
      replaceAttestation(ATTESTATION_DOCUMENT, 0, {
        name: 'Payment Account',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
      }),
    )
    expect(document.attestations[0]?.supportedFormats).toEqual(['dc+sd-jwt'])
    expect(document.attestations[0]?.schemaReferences).toEqual([
      { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/sd-jwt' },
    ])
  })

  test('refuses a missing attestation or malformed references', () => {
    expect(
      replaceAttestation(ATTESTATION_DOCUMENT, 5, {
        name: 'Missing',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
      }),
    ).toEqual({ ok: false, message: 'That attestation is no longer in the draft.' })
    expect(
      replaceAttestation(
        JSON.stringify({ attestations: [{ name: 'A', schemaReferences: 'nope' }] }),
        0,
        {
          name: 'A',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
        },
      ),
    ).toEqual({
      ok: false,
      message: 'Fix the attestation schemaReferences array in the draft before editing it.',
    })
  })
})

describe('removeAttestation', () => {
  test('removes one attestation and keeps the rulebook-level references', () => {
    const document = editedDocument(removeAttestation(ATTESTATION_DOCUMENT, 0))
    expect(document.attestations).toHaveLength(1)
    expect(document.attestations[0]?.name).toBe('Account Details')
    expect(document.schemaReferences).toEqual([
      { formatIdentifier: 'rb', uri: 'https://example.org/rulebook-level' },
    ])
  })

  test('refuses a missing attestation', () => {
    expect(removeAttestation(ATTESTATION_DOCUMENT, 2)).toEqual({
      ok: false,
      message: 'That attestation is no longer in the draft.',
    })
  })
})

describe('credential types', () => {
  test('maps each contract format to its schema keyword', () => {
    expect(credentialTypeKeyword('dc+sd-jwt')).toBe('vct')
    expect(credentialTypeKeyword('mso_mdoc')).toBe('docType')
    expect(credentialTypeKeyword('jwt_vc_json')).toBeNull()
  })

  test('reads a value the schema already declares', () => {
    const declared = JSON.stringify({
      properties: { vct: { const: 'urn:eudi:pid:1' }, docType: { const: '' } },
    })
    expect(declaredCredentialType(declared, 'vct')).toBe('urn:eudi:pid:1')
    expect(declaredCredentialType(declared, 'docType')).toBeNull()
    expect(declaredCredentialType('true', 'vct')).toBeNull()
    expect(declaredCredentialType('{not-json', 'vct')).toBeNull()
  })

  test('merges the value into properties.<keyword>.const and required', () => {
    const schema = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['family_name'],
      properties: { family_name: { type: 'string' } },
      additionalProperties: false,
    })
    const merged = mergeCredentialType(schema, 'vct', ' urn:eudi:pid:1 ')
    expect(merged.ok).toBe(true)
    if (!merged.ok) {
      throw new Error(merged.message)
    }
    expect(JSON.parse(merged.text)).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['family_name', 'vct'],
      properties: {
        family_name: { type: 'string' },
        vct: { const: 'urn:eudi:pid:1' },
      },
      additionalProperties: false,
    })
  })

  test('does not duplicate a keyword already listed in required', () => {
    const schema = JSON.stringify({
      required: ['docType'],
      properties: { docType: { type: 'string' } },
    })
    const merged = mergeCredentialType(schema, 'docType', 'eu.europa.ec.eudi.pid.1')
    expect(merged.ok).toBe(true)
    if (!merged.ok) {
      throw new Error(merged.message)
    }
    const parsed = JSON.parse(merged.text) as {
      required: readonly string[]
      properties: Record<string, Record<string, unknown>>
    }
    expect(parsed.required).toEqual(['docType'])
    expect(parsed.properties.docType).toEqual({
      type: 'string',
      const: 'eu.europa.ec.eudi.pid.1',
    })
  })

  test('accepts an enum that already contains the value', () => {
    const schema = JSON.stringify({ properties: { vct: { enum: ['urn:a', 'urn:b'] } } })
    const merged = mergeCredentialType(schema, 'vct', 'urn:b')
    expect(merged.ok).toBe(true)
    if (!merged.ok) {
      throw new Error(merged.message)
    }
    expect(JSON.parse(merged.text)).toEqual({
      properties: { vct: { enum: ['urn:a', 'urn:b'], const: 'urn:b' } },
      required: ['vct'],
    })
  })

  test('refuses a mismatching const or enum and merges nothing', () => {
    expect(
      mergeCredentialType(
        JSON.stringify({ properties: { vct: { const: 'urn:other' } } }),
        'vct',
        'urn:pid',
      ),
    ).toEqual({
      ok: false,
      message: 'The schema declares vct const "urn:other", which does not match "urn:pid".',
    })
    expect(
      mergeCredentialType(
        JSON.stringify({ properties: { docType: { enum: ['a', 'b'] } } }),
        'docType',
        'c',
      ),
    ).toEqual({
      ok: false,
      message: 'The schema\'s docType enum does not include "c".',
    })
    expect(
      mergeCredentialType(JSON.stringify({ properties: { vct: { const: 42 } } }), 'vct', 'urn:pid'),
    ).toMatchObject({ ok: false })
  })

  test('refuses a schema that cannot carry the credential type', () => {
    expect(mergeCredentialType('true', 'vct', 'urn:pid')).toEqual({
      ok: false,
      message: 'A schema that is not a JSON object cannot declare vct; use an object schema.',
    })
    expect(mergeCredentialType('[]', 'vct', 'urn:pid')).toMatchObject({ ok: false })
    expect(mergeCredentialType(JSON.stringify({ properties: 'nope' }), 'vct', 'urn:pid')).toEqual({
      ok: false,
      message: 'The schema "properties" member must be an object.',
    })
    expect(
      mergeCredentialType(JSON.stringify({ properties: { vct: 'nope' } }), 'vct', 'urn:pid'),
    ).toEqual({ ok: false, message: 'The schema property "vct" must be an object.' })
    expect(mergeCredentialType(JSON.stringify({ required: {} }), 'vct', 'urn:pid')).toEqual({
      ok: false,
      message: 'The schema "required" member must be an array.',
    })
  })

  test('keeps the exact text when no value is entered', () => {
    const schema = '{"type":"object", "properties":{}}'
    expect(mergeCredentialType(schema, 'vct', '  ')).toEqual({ ok: true, text: schema })
  })
})

describe('mdocNamespaces', () => {
  test('detects object-schema properties other than docType', () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        docType: { type: 'string' },
        'eu.europa.ec.eudi.pid.1': {
          type: 'object',
          properties: { given_name: { type: 'string' } },
        },
        'org.example.extra': { properties: { x: { type: 'string' } } },
        age_over_18: { type: 'boolean' },
        nothing: {},
      },
    })
    expect(mdocNamespaces(schema)).toEqual(['eu.europa.ec.eudi.pid.1', 'org.example.extra'])
  })

  test('reports no namespace for a root without object-schema members', () => {
    expect(mdocNamespaces('{"properties":{"docType":{"const":"x"}}}')).toEqual([])
    expect(mdocNamespaces('{"properties":{"scalar":{"type":"string"}}}')).toEqual([])
    expect(mdocNamespaces('true')).toEqual([])
    expect(mdocNamespaces('{not-json')).toEqual([])
  })
})

describe('cborKeywordWarnings', () => {
  test('reports unsupported format and contentEncoding values with their path', () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        birth_date: { type: 'string', format: 'date' },
        issued_at: { type: 'string', format: 'date-time' },
        photo: { type: 'string', contentEncoding: 'base64' },
        age: { type: 'integer', format: 'int32' },
        raw: { type: 'string', contentEncoding: 'base64url' },
        visited: { type: 'array', prefixItems: [{ format: 'duration' }] },
      },
    })
    expect(cborKeywordWarnings(schema)).toEqual([
      { kind: 'format', path: 'properties.age.format', value: 'int32' },
      { kind: 'contentEncoding', path: 'properties.raw.contentEncoding', value: 'base64url' },
      { kind: 'format', path: 'properties.visited.prefixItems.0.format', value: 'duration' },
    ])
  })

  test('returns no findings for supported values or unreadable documents', () => {
    expect(
      cborKeywordWarnings(
        '{"properties":{"born":{"format":"date"},"seen":{"format":"date-time"},"b":{"contentEncoding":"base64"}}}',
      ),
    ).toEqual([])
    expect(cborKeywordWarnings('true')).toEqual([])
    expect(cborKeywordWarnings('{not-json')).toEqual([])
  })
})
