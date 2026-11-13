import { describe, expect, test } from 'vitest'

import {
  countDiagnostics,
  describeDiagnosticPath,
  documentFromDraft,
  draftRequest,
  EMPTY_METADATA,
  hostedSchemasFromDraft,
  parseDraftDocument,
  serializeDraftDocument,
  validationSummary,
  validateMetadata,
  type DraftMetadata,
} from './draft'
import type { DraftContentDocument, DraftDiagnostic, DraftRulebook } from './types'
import { HOSTED_SCHEMA } from './test/fixtures'

const DOCUMENT: DraftContentDocument = {
  attestations: [
    {
      name: 'Person Identification Data',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
      supportedFormats: ['dc+sd-jwt'],
      schemaReferences: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://issuer.example.org/schemas/pid',
          integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
        },
      ],
    },
  ],
  schemaReferences: [
    {
      formatIdentifier: 'vc+sd-jwt',
      uri: 'https://issuer.example.org/schemas/rulebook',
      integrity: null,
    },
  ],
}

function draft(overrides: Partial<DraftRulebook> = {}): DraftRulebook {
  return {
    id: 'rulebook-1',
    providerId: 'provider-1',
    name: 'PID Rulebook',
    description: 'Person identification data.',
    sourceUrl: 'https://issuer.example.org/rulebooks/pid',
    applicableSpec: 'ts11@1.0.1',
    publicationStatus: 'draft',
    attestations: DOCUMENT.attestations,
    schemaReferences: DOCUMENT.schemaReferences,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('draft JSON helpers', () => {
  test('parses a valid editor document and defaults missing arrays', () => {
    expect(parseDraftDocument(JSON.stringify({ attestations: DOCUMENT.attestations }))).toEqual({
      ok: true,
      document: { attestations: DOCUMENT.attestations, schemaReferences: [] },
    })
    expect(parseDraftDocument('{}')).toEqual({
      ok: true,
      document: { attestations: [], schemaReferences: [] },
    })
  })

  test('reports empty, malformed and non-object documents', () => {
    for (const [text, message] of [
      ['', 'empty'],
      ['{not-json', 'valid JSON'],
      ['[]', 'must be an object'],
      ['{"attestations": {}}', '"attestations" must be an array'],
      ['{"schemaReferences": "x"}', '"schemaReferences" must be an array'],
    ] as const) {
      const result = parseDraftDocument(text)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain(message)
      }
    }
  })

  test('serializes a stable, human-editable document without null integrity', () => {
    const text = serializeDraftDocument(DOCUMENT)
    expect(text).toContain('"attestations"')
    expect(text).toContain('"integrity": "sha256-')
    expect(text).not.toContain('"integrity": null')
    const roundTrip = parseDraftDocument(text)
    expect(roundTrip.ok).toBe(true)
    if (roundTrip.ok) {
      expect(roundTrip.document.attestations[0]).toEqual(DOCUMENT.attestations[0])
      expect(roundTrip.document.schemaReferences[0]).toEqual({
        formatIdentifier: 'vc+sd-jwt',
        uri: 'https://issuer.example.org/schemas/rulebook',
      })
    }
  })

  test('extracts the editable document from a loaded draft', () => {
    expect(documentFromDraft(draft())).toEqual(DOCUMENT)
  })

  test('collects the server-resolved hosted association without changing the JSON', () => {
    const loaded = draft({
      attestations: [
        {
          ...DOCUMENT.attestations[0]!,
          schemaReferences: [
            {
              ...DOCUMENT.attestations[0]!.schemaReferences[0]!,
              uri: HOSTED_SCHEMA.url,
              integrity: HOSTED_SCHEMA.integrity,
              hostedSchema: HOSTED_SCHEMA,
            },
            DOCUMENT.attestations[0]!.schemaReferences[0]!,
          ],
        },
      ],
    })

    const schemas = hostedSchemasFromDraft(loaded)
    expect(schemas.get(HOSTED_SCHEMA.url)).toEqual(HOSTED_SCHEMA)
    expect(schemas.size).toBe(1)
    expect(serializeDraftDocument(documentFromDraft(loaded))).not.toContain('hostedSchema')
  })

  test('builds one request body for create and save, omitting an empty source URL', () => {
    const request = draftRequest(EMPTY_METADATA, DOCUMENT)
    expect(request).toEqual({
      name: '',
      description: '',
      applicableSpec: 'ts11@1.0.1',
      attestations: DOCUMENT.attestations,
      schemaReferences: DOCUMENT.schemaReferences,
    })
    expect(request).not.toHaveProperty('sourceUrl')
    expect(
      draftRequest({ ...EMPTY_METADATA, name: 'X', sourceUrl: ' https://a.example/x ' }, DOCUMENT)
        .sourceUrl,
    ).toBe('https://a.example/x')
  })

  test('summarizes diagnostics and paths', () => {
    const diagnostics: readonly DraftDiagnostic[] = [
      { severity: 'error', code: 'x', message: 'bad', path: 'attestations.0.name' },
      { severity: 'warning', code: 'y', message: 'warn' },
      { severity: 'warning', code: 'z', message: 'warn' },
    ]
    expect(countDiagnostics(diagnostics)).toEqual({ errors: 1, warnings: 2 })
    expect(validationSummary([])).toBe('No validation findings.')
    expect(validationSummary(diagnostics)).toBe('1 error and 2 warnings found.')
    expect(describeDiagnosticPath(undefined)).toBe('Document')
    expect(describeDiagnosticPath('attestations.0.name')).toBe('attestations › 0 › name')
  })

  test('requires a name and an applicable specification', () => {
    const metadata: DraftMetadata = { ...EMPTY_METADATA, name: '  ', applicableSpec: '' }
    expect(validateMetadata(metadata)).toEqual({
      name: 'A rulebook name is required.',
      applicableSpec: 'An applicable specification is required.',
    })
    expect(validateMetadata({ ...EMPTY_METADATA, name: 'Draft' })).toEqual({})
  })
})
