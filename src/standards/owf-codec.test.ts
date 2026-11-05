import { describe, expect, test } from 'bun:test'

import { validateSchemaMeta } from '@owf/eudi-attestation-schema'

import { parseSchemaMetaDocument, validateSchemaMetaDocument } from './codec'
import { OWF_PROFILE, type AdapterResult, type CanonicalSchemaMeta } from './index'
import {
  buildOwfSchemaMeta,
  isOwfRepresentable,
  isOwfSchemaMetaDocument,
  parseOwfSchemaMeta,
  serializeOwfSchemaMeta,
} from './owf'
import { parseTs11SchemaMeta } from './ts11'
import {
  buildOwfWire,
  buildTs11Document,
  SCHEMA_URI,
  sha256Sri,
  TEST_SCHEMA_DOCUMENT,
} from './test/fixtures'

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

const readOwf = (): CanonicalSchemaMeta => successValue(parseOwfSchemaMeta(buildOwfWire()))

function owfDocumentWithSchemaUriMember(): Record<string, unknown> {
  const document = buildOwfWire() as unknown as Record<string, unknown>
  const references = document.schemaURIs as Record<string, unknown>[]
  const first = references[0] ?? {}
  references[0] = { ...first, extraMember: 'kept' }
  return document
}

describe('OWF 0.5.4 parsing through the real package', () => {
  test('parses a builder-produced OWF document into the canonical model', () => {
    const parsed = readOwf()

    expect(parsed.id).toBe('https://example.com/attestations/gym-membership-card')
    expect(parsed.version).toBe('1.0.0')
    expect(parsed.rulebookIntegrity).toBe(sha256Sri('rulebook-document'))
    expect(parsed.supportedFormats).toEqual(['dc+sd-jwt'])
    expect(parsed.schemaURIs[0]).toEqual({
      formatIdentifier: 'dc+sd-jwt',
      uri: SCHEMA_URI,
      integrity: sha256Sri(TEST_SCHEMA_DOCUMENT),
      meta: { vct: 'eu.example.gym.1' },
    })
    expect(parsed.trustedAuthorities[0]).toMatchObject({
      frameworkType: 'etsi_tl',
      value: 'https://example.com/trust-lists/gym-members.jws',
      verificationMethod: { type: 'X509Certificate' },
    })
  })

  test('auto-detects the OWF profile', () => {
    const parsed = successValue(parseSchemaMetaDocument(buildOwfWire()))
    expect(parsed.version).toBe('1.0.0')
  })

  test('its validity verdict agrees with the real OWF validator', () => {
    const valid = buildOwfWire()
    expect(validateSchemaMeta(valid).valid).toBe(true)
    expect(parseOwfSchemaMeta(valid).ok).toBe(true)

    const invalid = { ...buildOwfWire(), version: 'not-semver' }
    expect(validateSchemaMeta(invalid).valid).toBe(false)
    const diagnostics = failureDiagnostics(parseOwfSchemaMeta(invalid))
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics.every((entry) => entry.kind === 'invalid_input')).toBe(true)
  })

  test('surfaces real-package validation errors for negative inputs', () => {
    const cases: Record<string, Record<string, unknown>> = {
      'missing rulebookIntegrity': { ...buildOwfWire(), rulebookIntegrity: undefined },
      'invalid iat': { ...buildOwfWire(), iat: -1 },
      'duplicate format identifiers': {
        ...buildOwfWire(),
        schemaURIs: [...buildOwfWire().schemaURIs, ...buildOwfWire().schemaURIs],
      },
    }

    for (const [name, document] of Object.entries(cases)) {
      expect({ name, valid: validateSchemaMeta(document).valid }).toEqual({
        name,
        valid: false,
      })
      expect({ name, ok: parseOwfSchemaMeta(document).ok }).toEqual({
        name,
        ok: false,
      })
    }
  })

  test('preserves unknown top-level members that OWF accepts and strips', () => {
    const document = { ...buildOwfWire(), futureMember: { revision: 2 } }
    expect(validateSchemaMeta(document).valid).toBe(true)

    const result = parseOwfSchemaMeta(document)
    const parsed = successValue(result)

    expect(parsed.unknownMembers).toEqual({ futureMember: { revision: 2 } })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        kind: 'preserved',
        code: 'preserved_unknown_member',
        path: 'futureMember',
      }),
    ])

    const serialized = successValue(serializeOwfSchemaMeta(parsed))
    expect(serialized.futureMember).toEqual({ revision: 2 })
  })
})

describe('OWF 0.5.4 serialization through the real package', () => {
  test('round-trips an OWF document through the canonical model', () => {
    const serialized = successValue(serializeOwfSchemaMeta(readOwf()))
    expect(serialized).toEqual(buildOwfWire() as unknown as Record<string, unknown>)
  })

  test('buildOwfSchemaMeta returns a document the real validator accepts', () => {
    const built = successValue(buildOwfSchemaMeta(readOwf()))
    expect(validateSchemaMeta(built)).toEqual({ valid: true, errors: [] })
    expect(isOwfRepresentable(readOwf())).toBe(true)
    expect(isOwfSchemaMetaDocument(built)).toBe(true)
    expect(isOwfSchemaMetaDocument({})).toBe(false)
  })

  test('reports a TS11-only format as an unsupported operation', () => {
    const document = buildTs11Document()
    document.supportedFormats = ['jwt_vc_json']
    document.schemaURIs = [
      { formatIdentifier: 'jwt_vc_json', uri: 'https://example.com/schema.json' },
    ]
    const canonical = successValue(parseTs11SchemaMeta(document))

    const diagnostics = failureDiagnostics(serializeOwfSchemaMeta(canonical))
    expect(
      diagnostics.some(
        (entry) =>
          entry.kind === 'unsupported_operation' &&
          entry.code === 'unsupported_format' &&
          entry.path === 'supportedFormats.0',
      ),
    ).toBe(true)
    expect(
      diagnostics.some(
        (entry) =>
          entry.kind === 'unsupported_operation' &&
          entry.code === 'unsupported_format' &&
          entry.path === 'schemaURIs.0.formatIdentifier',
      ),
    ).toBe(true)
  })

  test('reports a TS11 etsi_tl without verificationMethod as unsupported', () => {
    const canonical = successValue(parseTs11SchemaMeta(buildTs11Document()))
    const diagnostics = failureDiagnostics(serializeOwfSchemaMeta(canonical))

    expect(diagnostics.map((entry) => entry.code)).toContain('unsupported_trust_authority')
    expect(diagnostics.map((entry) => entry.code)).toContain('unsupported_schema_meta_member')
  })

  test('reports missing OWF-only members as unsupported translations', () => {
    const withoutIntegrity = buildTs11Document()
    withoutIntegrity.rulebookURI = 'https://example.com/rulebook.md'
    const canonical = successValue(parseTs11SchemaMeta(withoutIntegrity))

    const diagnostics = failureDiagnostics(serializeOwfSchemaMeta(canonical))
    expect(
      diagnostics.some(
        (entry) =>
          entry.kind === 'unsupported_operation' &&
          entry.code === 'unsupported_schema_meta_member' &&
          entry.path === 'rulebookIntegrity',
      ),
    ).toBe(true)
    expect(
      diagnostics.some(
        (entry) =>
          entry.kind === 'unsupported_operation' &&
          entry.code === 'unsupported_schema_meta_member' &&
          entry.path === 'schemaURIs.0.meta',
      ),
    ).toBe(true)
  })

  test('reports a non-sha256 SRI as an unsupported operation', () => {
    const document = buildTs11Document()
    document.schemaURIs = [
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: `${SCHEMA_URI}#integrity=sha384-${sha256Sri('x').slice('sha256-'.length)}`,
      },
    ]
    const canonical = successValue(parseTs11SchemaMeta(document))

    expect(
      failureDiagnostics(serializeOwfSchemaMeta(canonical)).map((entry) => entry.code),
    ).toContain('unsupported_sri_algorithm')
  })

  test('reports a missing or non-URL id as an unsupported translation', () => {
    const canonical = readOwf()
    const { id, ...withoutId } = canonical
    expect(id).toBeDefined()

    expect(failureDiagnostics(serializeOwfSchemaMeta(withoutId))).toEqual([
      expect.objectContaining({
        kind: 'unsupported_operation',
        code: 'unsupported_schema_meta_member',
        path: 'id',
      }),
    ])

    const ts11Canonical = successValue(parseTs11SchemaMeta(buildTs11Document()))
    expect(
      failureDiagnostics(serializeOwfSchemaMeta(ts11Canonical)).some(
        (entry) =>
          entry.kind === 'unsupported_operation' &&
          entry.code === 'unsupported_schema_meta_member' &&
          entry.path === 'id',
      ),
    ).toBe(true)
  })

  test('reports malformed canonical input as invalid input, not unsupported', () => {
    const canonical = readOwf()
    const emptyId = failureDiagnostics(serializeOwfSchemaMeta({ ...canonical, id: '' }))
    expect(emptyId).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'invalid_member_value',
        path: 'id',
      }),
    ])

    const inconsistentFormats = failureDiagnostics(
      serializeOwfSchemaMeta({ ...canonical, supportedFormats: ['mso_mdoc'] }),
    )
    expect(
      inconsistentFormats.some(
        (entry) =>
          entry.kind === 'invalid_input' &&
          entry.code === 'invalid_member_value' &&
          entry.path === 'schemaURIs.0.formatIdentifier',
      ),
    ).toBe(true)
  })

  test('strict validation rejects unknown OWF top-level members', () => {
    const document = { ...buildOwfWire(), futureMember: true }
    expect(parseOwfSchemaMeta(document).ok).toBe(true)

    const strict = validateSchemaMetaDocument(document)
    expect(failureDiagnostics(strict)).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'invalid_member_value',
        path: 'futureMember',
      }),
    ])
  })

  test('rejects a "__proto__" top-level member instead of dropping it', () => {
    const document: Record<string, unknown> = { ...buildOwfWire() }
    Object.defineProperty(document, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    })

    expect(failureDiagnostics(parseOwfSchemaMeta(document))).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'invalid_member_value',
        path: '__proto__',
      }),
    ])
  })

  test('rejects preserved members that collide with OWF members', () => {
    const canonical = {
      ...readOwf(),
      unknownMembers: { version: '9.9.9' },
    }

    expect(failureDiagnostics(serializeOwfSchemaMeta(canonical))).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'invalid_member_value',
        path: 'version',
      }),
    ])
  })

  test('preserves unknown members inside OWF schemaURIs entries', () => {
    const document = owfDocumentWithSchemaUriMember()
    expect(validateSchemaMeta(document).valid).toBe(true)

    const result = parseOwfSchemaMeta(document)
    const parsed = successValue(result)
    expect(parsed.schemaURIs[0]?.unknownMembers).toEqual({ extraMember: 'kept' })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        kind: 'preserved',
        code: 'preserved_unknown_member',
        path: 'schemaURIs.0.extraMember',
      }),
    ])

    const serialized = successValue(serializeOwfSchemaMeta(parsed))
    expect(validateSchemaMeta(serialized).valid).toBe(true)
    const serializedReferences = serialized.schemaURIs as Record<string, unknown>[]
    expect(serializedReferences[0]?.extraMember).toBe('kept')

    expect(failureDiagnostics(validateSchemaMetaDocument(document))).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'invalid_member_value',
        path: 'schemaURIs.0.extraMember',
      }),
    ])
  })

  test('reports the OWF profile through the shared serializer', () => {
    const wire = successValue(parseSchemaMetaDocument(buildOwfWire(), { profile: OWF_PROFILE }))
    expect(wire.supportedFormats).toEqual(['dc+sd-jwt'])
  })
})
