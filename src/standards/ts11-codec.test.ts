import { describe, expect, test } from 'bun:test'

import { parseSchemaMetaDocument, validateSchemaMetaDocument } from './codec'
import {
  createAttestBookSchemaMeta,
  productMetadataLeaks,
  TS11_PROFILE,
  type AdapterResult,
  type CanonicalSchemaMeta,
  type DiagnosticCode,
} from './index'
import { parseOwfSchemaMeta } from './owf'
import {
  isTs11Representable,
  parseTs11SchemaMeta,
  serializeAttestBookTs11,
  serializeTs11SchemaMeta,
} from './ts11'
import {
  buildOwfWire,
  buildTs11Document,
  RULEBOOK_URI,
  SCHEMA_URI,
  sha256Sri,
  TEST_SCHEMA_DOCUMENT,
} from './test-fixtures'

function failureDiagnostics(result: AdapterResult<unknown>) {
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected the adapter call to fail')
  }
  return result.diagnostics
}

function successValue<T>(result: AdapterResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(`expected success, got: ${JSON.stringify(result.diagnostics)}`)
  }
  return result.value
}

function codes(result: AdapterResult<unknown>): string[] {
  return failureDiagnostics(result).map((entry) => entry.code)
}

const readTs11 = (): CanonicalSchemaMeta => successValue(parseTs11SchemaMeta(buildTs11Document()))

describe('TS11 v1.0.1 parsing', () => {
  test('parses the TS11 wire shape into the canonical model', () => {
    const parsed = successValue(parseTs11SchemaMeta(buildTs11Document()))

    expect(parsed.version).toBe('1.0.0')
    expect(parsed.id).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(parsed.rulebookURI).toBe(RULEBOOK_URI)
    expect(parsed.rulebookIntegrity).toBe(sha256Sri('rulebook-document'))
    expect(parsed.supportedFormats).toEqual(['dc+sd-jwt'])
    expect(parsed.schemaURIs).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: SCHEMA_URI,
        integrity: sha256Sri(TEST_SCHEMA_DOCUMENT),
      },
    ])
    expect(parsed.trustedAuthorities).toEqual([
      {
        frameworkType: 'etsi_tl',
        value: 'https://example.com/trust-lists/gym-members.jws',
        isLOTE: true,
      },
    ])
    expect(parsed.unknownMembers).toEqual({})
  })

  test('auto-detects the TS11 profile and reports no error', () => {
    const parsed = successValue(parseSchemaMetaDocument(buildTs11Document()))
    expect(parsed.id).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
  })

  test('round-trips through the canonical model without losing TS11 members', () => {
    const roundTripped = successValue(serializeTs11SchemaMeta(readTs11()))
    expect(roundTripped).toEqual(buildTs11Document())
  })

  test('preserves unknown top-level and nested members while parsing', () => {
    const document = buildTs11Document()
    const schemaURIs = document.schemaURIs as Record<string, unknown>[]
    schemaURIs[0] = { ...schemaURIs[0], futureRefMember: 'keep-me' }

    const parsed = successValue(
      parseTs11SchemaMeta({ ...document, futureTopLevel: { revision: 2 } }),
    )
    expect(parsed.unknownMembers).toEqual({ futureTopLevel: { revision: 2 } })
    expect(parsed.schemaURIs[0]?.unknownMembers).toEqual({ futureRefMember: 'keep-me' })

    const roundTripped = successValue(serializeTs11SchemaMeta(parsed))
    expect(roundTripped.futureTopLevel).toEqual({ revision: 2 })
    const reSerializedRefs = roundTripped.schemaURIs as Record<string, unknown>[]
    expect(reSerializedRefs[0]?.futureRefMember).toBe('keep-me')
  })

  test('preserves a value outside the pinned baseline and reports it', () => {
    const result = parseTs11SchemaMeta({
      ...buildTs11Document(),
      attestationLoS: 'iso_18045_quantum',
    })
    const parsed = successValue(result)

    expect(parsed.attestationLoS).toBe('iso_18045_quantum')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        kind: 'preserved',
        code: 'preserved_unknown_value',
        path: 'attestationLoS',
      }),
    ])
  })

  test('strict validation rejects members and values outside the pinned baseline', () => {
    const withUnknownMember = validateSchemaMetaDocument({
      ...buildTs11Document(),
      futureTopLevel: true,
    })
    expect(codes(withUnknownMember)).toContain('invalid_member_value')
    expect(
      failureDiagnostics(withUnknownMember).some(
        (entry) => entry.kind === 'invalid_input' && entry.path === 'futureTopLevel',
      ),
    ).toBe(true)

    const withUnknownValue = validateSchemaMetaDocument({
      ...buildTs11Document(),
      bindingType: 'quantum',
    })
    expect(
      failureDiagnostics(withUnknownValue).some(
        (entry) => entry.kind === 'invalid_input' && entry.path === 'bindingType',
      ),
    ).toBe(true)
  })
})

describe('TS11 v1.0.1 negative inputs', () => {
  const cases: {
    readonly name: string
    readonly mutate: (document: Record<string, unknown>) => void
    readonly code: DiagnosticCode
    readonly path?: string
  }[] = [
    {
      name: 'rejects a non-UUID id',
      mutate: (document) => {
        document.id = 'https://example.com/id'
      },
      code: 'invalid_ts11_id',
      path: 'id',
    },
    {
      name: 'rejects a missing version',
      mutate: (document) => {
        delete document.version
      },
      code: 'missing_required_member',
      path: 'version',
    },
    {
      name: 'rejects a non-SemVer version',
      mutate: (document) => {
        document.version = '1.0'
      },
      code: 'invalid_member_value',
      path: 'version',
    },
    {
      name: 'rejects a relative rulebook URI',
      mutate: (document) => {
        document.rulebookURI = 'rulebook.md'
      },
      code: 'invalid_member_value',
      path: 'rulebookURI',
    },
    {
      name: 'rejects a malformed #integrity fragment',
      mutate: (document) => {
        document.rulebookURI = `${RULEBOOK_URI}#integrity=`
      },
      code: 'invalid_member_value',
      path: 'rulebookURI',
    },
    {
      name: 'rejects a non-SRI rulebook integrity value',
      mutate: (document) => {
        document.rulebookURI = `${RULEBOOK_URI}#integrity=md5-abc`
      },
      code: 'invalid_member_value',
      path: 'rulebookURI',
    },
    {
      name: 'rejects an empty supportedFormats array',
      mutate: (document) => {
        document.supportedFormats = []
      },
      code: 'invalid_member_value',
      path: 'supportedFormats',
    },
    {
      name: 'rejects duplicate supported formats',
      mutate: (document) => {
        document.supportedFormats = ['dc+sd-jwt', 'dc+sd-jwt']
      },
      code: 'invalid_member_value',
      path: 'supportedFormats.1',
    },
    {
      name: 'rejects a missing schemaURIs member',
      mutate: (document) => {
        delete document.schemaURIs
      },
      code: 'missing_required_member',
      path: 'schemaURIs',
    },
    {
      name: 'rejects an empty schemaURIs array',
      mutate: (document) => {
        document.schemaURIs = []
      },
      code: 'invalid_member_value',
      path: 'schemaURIs',
    },
    {
      name: 'rejects a schema format absent from supportedFormats',
      mutate: (document) => {
        const refs = document.schemaURIs as Record<string, unknown>[]
        refs[0] = { ...refs[0], formatIdentifier: 'mso_mdoc' }
      },
      code: 'invalid_member_value',
      path: 'schemaURIs.0.formatIdentifier',
    },
    {
      name: 'rejects a supported format without a schema URI',
      mutate: (document) => {
        document.supportedFormats = ['dc+sd-jwt', 'mso_mdoc']
      },
      code: 'invalid_member_value',
      path: 'supportedFormats',
    },
    {
      name: 'rejects isLOTE on a non-etsi_tl framework',
      mutate: (document) => {
        document.trustedAuthorities = [{ frameworkType: 'aki', value: 'abc', isLOTE: true }]
      },
      code: 'invalid_member_value',
      path: 'trustedAuthorities.0.isLOTE',
    },
    {
      name: 'rejects a non-array trustedAuthorities member',
      mutate: (document) => {
        document.trustedAuthorities = 'not-an-array'
      },
      code: 'invalid_member_value',
      path: 'trustedAuthorities',
    },
  ]

  for (const testCase of cases) {
    test(testCase.name, () => {
      const document = buildTs11Document()
      testCase.mutate(document)
      const diagnostics = failureDiagnostics(parseTs11SchemaMeta(document))

      expect(diagnostics.map((entry) => entry.code)).toContain(testCase.code)
      if (testCase.path !== undefined) {
        expect(
          diagnostics.some(
            (entry) => entry.kind === 'invalid_input' && entry.path === testCase.path,
          ),
        ).toBe(true)
      }
    })
  }
})

describe('TS11 v1.0.1 serialization limits', () => {
  test('an OWF-profile canonical document cannot be exported to TS11', () => {
    const owfCanonical = successValue(parseOwfSchemaMeta(buildOwfWire()))
    const diagnostics = failureDiagnostics(serializeTs11SchemaMeta(owfCanonical))

    expect(isTs11Representable(owfCanonical)).toBe(false)
    expect(diagnostics.some((entry) => entry.kind === 'unsupported_operation')).toBe(true)
    expect(diagnostics.map((entry) => entry.code)).toContain('unsupported_schema_meta_member')
    expect(diagnostics.some((entry) => entry.code === 'invalid_ts11_id')).toBe(true)
  })

  test('owf-only members are reported as unsupported operations', () => {
    const canonical = readTs11()
    const withOwfMembers: CanonicalSchemaMeta = {
      ...canonical,
      iat: 1_700_000_000,
      issuanceProfile: { batchIssuanceAllowed: true },
    }
    const diagnostics = failureDiagnostics(serializeTs11SchemaMeta(withOwfMembers))

    expect(
      diagnostics.some(
        (entry) =>
          entry.kind === 'unsupported_operation' &&
          entry.code === 'unsupported_schema_meta_member' &&
          entry.path === 'iat',
      ),
    ).toBe(true)
    expect(
      diagnostics.some(
        (entry) =>
          entry.kind === 'unsupported_operation' &&
          entry.code === 'unsupported_schema_meta_member' &&
          entry.path === 'issuanceProfile',
      ),
    ).toBe(true)
  })

  test('the OWF x509 direct anchor cannot be exported to TS11', () => {
    const canonical: CanonicalSchemaMeta = {
      ...readTs11(),
      trustedAuthorities: [{ frameworkType: 'x509', value: 'base64-der' }],
    }
    expect(codes(serializeTs11SchemaMeta(canonical))).toContain('unsupported_trust_authority')
  })

  test('an OWF verificationMethod cannot be exported to TS11', () => {
    const canonical: CanonicalSchemaMeta = {
      ...readTs11(),
      trustedAuthorities: [
        {
          frameworkType: 'etsi_tl',
          value: 'https://example.com/trust-list.jws',
          verificationMethod: {
            type: 'X509Certificate',
            x509Certificate: 'base64-der',
          },
        },
      ],
    }
    expect(codes(serializeTs11SchemaMeta(canonical))).toContain('unsupported_trust_authority')
  })

  test('OWF format-specific meta cannot be exported to TS11', () => {
    const canonical: CanonicalSchemaMeta = {
      ...readTs11(),
      schemaURIs: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: SCHEMA_URI,
          integrity: sha256Sri(TEST_SCHEMA_DOCUMENT),
          meta: { vct: 'eu.example.gym.1' },
        },
      ],
    }
    expect(codes(serializeTs11SchemaMeta(canonical))).toContain('unsupported_schema_meta_member')
  })

  test('serializes the standards document without product metadata', () => {
    const document = createAttestBookSchemaMeta(readTs11(), {
      rulebookId: 'rulebook-1',
      providerId: 'provider-1',
      publicationStatus: 'draft',
      sourceUrl: 'https://example.com/internal-source.json',
    })

    const wire = successValue(serializeAttestBookTs11(document))
    const serialized = JSON.stringify(wire)

    expect(serialized).not.toContain('rulebook-1')
    expect(serialized).not.toContain('provider-1')
    expect(serialized).not.toContain('internal-source')
    expect(productMetadataLeaks(readTs11())).toEqual([])
    const leaked = { ...readTs11(), rulebookId: 'leaked' }
    expect(productMetadataLeaks(leaked)).toEqual(['rulebookId'])
  })

  test('reports the TS11 profile to the shared serializer', () => {
    const wire = successValue(
      parseSchemaMetaDocument(buildTs11Document(), { profile: TS11_PROFILE }),
    )
    expect(wire.supportedFormats).toEqual(['dc+sd-jwt'])
  })
})
