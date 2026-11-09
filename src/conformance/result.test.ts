// Pure tests for the reproducible conformance result builder (FR-022, #51).
//
// These tests prove the properties the API depends on: the same pinned inputs
// and evidence produce the same digest/reference even across validation
// identifiers, timestamps and lifecycle metadata; a changed input or a changed
// evidence set produces a different reference; and failures are classified with
// stable codes.

import { describe, expect, test } from 'bun:test'

import {
  buildConformanceResult,
  conformanceOutcome,
  CONFORMANCE_RESULT_LIMITATIONS,
} from './result'
import {
  conformanceRequest,
  conformanceResult,
  conformanceValidationResult,
  TEST_CREDENTIAL,
  TEST_RULEBOOK_DIGEST,
  TEST_SCHEMA_URI,
  TEST_SCHEMA_CONTENT,
} from './test/fixtures'

describe('reproducible conformance result', () => {
  test('repeating the same pinned inputs produces an identical result', () => {
    const first = conformanceResult()
    const second = conformanceResult()

    expect(second).toEqual(first)
    expect(first.resultReference).toMatch(/^[0-9a-f]{64}$/)
    expect(first.input.inputDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.deterministic).toBe(true)
  })

  test('excludes validation identifiers, timestamps and mutable lifecycle metadata', () => {
    const first = conformanceResult()
    const second = conformanceResult({
      validationId: 'a-different-validation-id',
      validatedAt: '2030-12-31T23:59:59.000Z',
      rulebookName: 'A renamed rulebook',
      rulebookStatus: 'historical',
    })

    expect(second.input.inputDigest).toBe(first.input.inputDigest)
    expect(second.resultReference).toBe(first.resultReference)
    expect(JSON.stringify(second.evidence)).not.toContain('A renamed rulebook')
    expect(JSON.stringify(second.evidence)).not.toContain('historical')
  })

  test('changes the reference when the credential changes', () => {
    const base = conformanceResult()
    const changed = conformanceResult({ credential: `${TEST_CREDENTIAL}x` })

    expect(changed.input.credentialDigest).not.toBe(base.input.credentialDigest)
    expect(changed.resultReference).not.toBe(base.resultReference)
  })

  test('changes the reference when a supplied schema document changes', () => {
    const base = conformanceResult()
    const changed = conformanceResult({
      schemaDocuments: [{ uri: TEST_SCHEMA_URI, content: '{"type":"object"}' }],
    })

    expect(changed.input.schemaDocuments[0]?.contentDigest).not.toBe(
      base.input.schemaDocuments[0]?.contentDigest,
    )
    expect(changed.resultReference).not.toBe(base.resultReference)
  })

  test('changes the reference when the same input produces different evidence', () => {
    const base = conformanceResult()
    const failed = conformanceResult({ statuses: { schema_validation: 'FAIL' } })

    expect(failed.input.inputDigest).toBe(base.input.inputDigest)
    expect(failed.resultReference).not.toBe(base.resultReference)
  })

  test('includes an explicit format hint in the input identity', () => {
    const withoutHint = conformanceResult()
    const withHint = conformanceResult({ credentialFormatHint: 'dc+sd-jwt' })

    expect(withHint.input.credentialDigest).toBe(withoutHint.input.credentialDigest)
    expect(withHint.input.credentialFormatHint).toBe('dc+sd-jwt')
    expect(withoutHint.input.credentialFormatHint).toBeNull()
    expect(withHint.input.inputDigest).not.toBe(withoutHint.input.inputDigest)
  })

  test('maps every FR-012 aggregate status to a structural outcome', () => {
    expect(conformanceOutcome('PASS')).toBe('structural_pass')
    expect(conformanceOutcome('FAIL')).toBe('structural_fail')
    expect(conformanceOutcome('INCONCLUSIVE')).toBe('inconclusive')
    expect(conformanceOutcome('NOT_TESTED')).toBe('evidence_incomplete')
    expect(conformanceOutcome('NOT_APPLICABLE')).toBe('not_applicable')
  })

  test('classifies failed dimensions with stable codes and their finding codes', () => {
    const result = conformanceResult({
      statuses: {
        credential_parsing: 'FAIL',
        schema_validation: 'FAIL',
        attestation_constraints: 'FAIL',
      },
    })

    expect(result.outcome).toBe('structural_fail')
    expect(result.failureClasses).toEqual([
      {
        code: 'credential_unparseable',
        dimension: 'credential_parsing',
        findingCodes: ['sd_jwt_malformed'],
      },
      {
        code: 'schema_violation',
        dimension: 'schema_validation',
        findingCodes: ['schema_violation'],
      },
      {
        code: 'attestation_constraint_violation',
        dimension: 'attestation_constraints',
        findingCodes: ['missing_key_binding'],
      },
    ])
  })

  test('classifies only failed dimensions and keeps the incomplete evidence explicit', () => {
    const result = conformanceResult()

    expect(result.outcome).toBe('evidence_incomplete')
    expect(result.failureClasses).toEqual([])
    expect(result.evidence.limitations.length).toBeGreaterThan(0)
    expect(result.evidence.overallStatus).toBe('NOT_TESTED')
  })

  test('carries the exact pin, explicit references and non-claims without credential material', () => {
    const result = conformanceResult()
    const serialized = JSON.stringify(result)

    expect(result.pin).toEqual({
      rulebookId: 'rulebook-conformance-1',
      version: '2.1',
      contentDigest: TEST_RULEBOOK_DIGEST,
      specVersion: 'ts11@1.0.1',
      attestationType: 'PID',
      digestVerified: true,
    })
    expect(result.references).toEqual({
      canonicalization: 'attestbook.stable-json@1',
      digestAlgorithm: 'sha256',
      referenceScope: 'pin+input+evidence+failure-classification',
      statusTaxonomy: 'FR-012',
    })
    expect(result.nonClaims).toEqual({
      cryptographicVerification: false,
      issuerTrust: false,
      protocolConformance: false,
      interoperability: false,
      standardsConformance: false,
      recurringExecutionScheduled: false,
    })
    expect(result.limitations).toEqual([...CONFORMANCE_RESULT_LIMITATIONS])
    expect(result.input.schemaDocuments[0]?.uri).toBe(TEST_SCHEMA_URI)
    expect(result.input.schemaDocuments[0]?.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(serialized).not.toContain(TEST_CREDENTIAL)
    expect(serialized).not.toContain(TEST_SCHEMA_CONTENT)
    expect(serialized).not.toContain('Ada')
  })

  test('refuses evidence that does not name the requested pin', () => {
    const validation = conformanceValidationResult({ rulebookId: 'a-different-rulebook' })

    expect(() => buildConformanceResult({ validation, request: conformanceRequest() })).toThrow(
      'the validation evidence does not name the requested pinned selection',
    )
  })
})
