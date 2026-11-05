import { describe, expect, test } from 'bun:test'

import { parseSchemaMetaDocument } from './codec'
import { detectProfile, OWF_PROFILE, TS11_PROFILE, type AdapterResult } from './index'
import { buildOwfWire, buildTs11Document } from './test-fixtures'

function failureDiagnostics(result: AdapterResult<unknown>) {
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected the adapter call to fail')
  }
  return result.diagnostics
}

describe('wire-profile detection', () => {
  test('detects TS11 and OWF documents', () => {
    expect(detectProfile(buildTs11Document())).toEqual({
      ok: true,
      value: TS11_PROFILE,
      diagnostics: [],
    })
    expect(detectProfile(buildOwfWire())).toEqual({
      ok: true,
      value: OWF_PROFILE,
      diagnostics: [],
    })
  })

  test('routes an incomplete TS11-shaped document to TS11 validation', () => {
    const detected = detectProfile({ version: '1.0.0' })
    expect(detected.ok).toBe(true)
    if (detected.ok) {
      expect(detected.value).toBe(TS11_PROFILE)
    }
  })

  test('rejects a document with both discriminators', () => {
    const diagnostics = failureDiagnostics(
      detectProfile({ ...buildTs11Document(), rulebookIntegrity: 'sha256-abc' }),
    )
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'ambiguous_profile',
      }),
    ])
  })

  test('rejects a value that is not a SchemaMeta document', () => {
    expect(failureDiagnostics(detectProfile(null))[0]?.code).toBe('invalid_schema_meta')
    expect(failureDiagnostics(detectProfile({}))[0]?.code).toBe('unknown_profile')
    expect(failureDiagnostics(detectProfile([]))[0]?.code).toBe('invalid_schema_meta')
  })

  test('reports an explicitly requested, unimplemented profile as unsupported', () => {
    const diagnostics = failureDiagnostics(
      parseSchemaMetaDocument(buildTs11Document(), {
        profile: 'etsi@0.0.6' as unknown as typeof TS11_PROFILE,
      }),
    )
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'unsupported_operation',
        code: 'unsupported_profile',
      }),
    ])
  })

  test('an explicit profile does not bypass that profile validation', () => {
    expect(parseSchemaMetaDocument(buildTs11Document(), { profile: OWF_PROFILE }).ok).toBe(false)
    expect(parseSchemaMetaDocument(buildOwfWire(), { profile: TS11_PROFILE }).ok).toBe(false)
  })
})
