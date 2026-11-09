import { describe, expect, test } from 'bun:test'

import {
  buildHeadlessWalletComparison,
  HEADLESS_WALLET_COMPARISON_KIND,
  HEADLESS_WALLET_COMPARISON_VERSION,
  type ComparisonDimensionEntry,
  type ExternalWalletObservation,
} from '../comparison'

import {
  comparisonSource,
  comparisonValidationResult,
  externalWalletObservation,
  TEST_ATTESTATION_TYPE,
  TEST_BOUND_AT,
  TEST_CAPTURE_ID,
  TEST_COMPARED_AT,
  TEST_CORRELATION_ID,
  TEST_EXECUTION_REF,
  TEST_RULEBOOK_DIGEST,
  TEST_RULEBOOK_ID,
  TEST_RULEBOOK_VERSION,
  TEST_SPEC_VERSION,
  TEST_WALLET_ID,
} from './test/fixtures'

function build(
  source = comparisonSource(),
  externalWallet: ExternalWalletObservation | null = externalWalletObservation(),
) {
  return buildHeadlessWalletComparison({
    source,
    externalWallet,
    now: () => TEST_COMPARED_AT,
  })
}

function entry(
  entries: readonly ComparisonDimensionEntry[],
  dimension: ComparisonDimensionEntry['dimension'],
): ComparisonDimensionEntry {
  const found = entries.find((candidate) => candidate.dimension === dimension)
  if (found === undefined) {
    throw new Error(`missing comparison entry for ${dimension}`)
  }
  return found
}

describe('headless-wallet comparison contract', () => {
  test('links the evidence to the exact pinned rulebook version and digest', () => {
    const report = build()
    expect(report.kind).toBe(HEADLESS_WALLET_COMPARISON_KIND)
    expect(report.contractVersion).toBe(HEADLESS_WALLET_COMPARISON_VERSION)
    expect(report.comparedAt).toBe(TEST_COMPARED_AT.toISOString())
    expect(report.rulebook).toEqual({
      rulebookId: TEST_RULEBOOK_ID,
      rulebookName: 'Headless comparison rulebook',
      version: TEST_RULEBOOK_VERSION,
      contentDigest: TEST_RULEBOOK_DIGEST,
      digestVerified: true,
      specVersion: TEST_SPEC_VERSION,
      rulebookStatus: 'published',
      attestationType: TEST_ATTESTATION_TYPE,
      boundAt: TEST_BOUND_AT,
    })
    expect(report.capture).toEqual({
      captureId: TEST_CAPTURE_ID,
      correlationId: TEST_CORRELATION_ID,
      testExecutionRef: TEST_EXECUTION_REF,
      sourceComponent: 'capture-issuer',
      protocol: 'openid4vci',
      credentialFormat: 'dc+sd-jwt',
    })
    expect(report.attestbook.validationId).toBe('validation-headless-1')
    expect(report.externalWallet?.walletId).toBe(TEST_WALLET_ID)
  })

  test('separates the schema, protocol, interoperability and trust groups', () => {
    const report = build()
    expect(report.comparison.schema.map((entry) => entry.dimension)).toEqual([
      'credential_parsing',
      'format_recognition',
      'schema_validation',
      'attestation_constraints',
    ])
    expect(report.comparison.protocol.map((entry) => entry.dimension)).toEqual([
      'protocol_conformance',
    ])
    expect(report.comparison.interoperability.map((entry) => entry.dimension)).toEqual([
      'interoperability',
    ])
    expect(report.comparison.trust.map((entry) => entry.dimension)).toEqual([
      'cryptographic_verification',
      'issuer_trust',
    ])

    for (const schemaEntry of report.comparison.schema) {
      expect(schemaEntry.attestbook?.executed).toBe(true)
      expect(schemaEntry.external).toBeNull()
      expect(schemaEntry.result).toBe('attestbook_only')
    }
    const protocol = entry(report.comparison.protocol, 'protocol_conformance')
    expect(protocol.attestbook).toBeNull()
    expect(protocol.external?.status).toBe('PASS')
    expect(protocol.result).toBe('external_only')
    const interoperability = entry(report.comparison.interoperability, 'interoperability')
    expect(interoperability.attestbook).toBeNull()
    expect(interoperability.external?.status).toBe('FAIL')
    expect(interoperability.result).toBe('external_only')
  })

  test('records every external-owned dimension as unsupported by AttestBook', () => {
    const report = build()
    const unsupported = report.comparison.unsupported.map((item) => item.dimension)
    expect(unsupported).toContain('cryptographic_verification')
    expect(unsupported).toContain('issuer_trust')
    expect(unsupported).toContain('protocol_conformance')
    expect(unsupported).toContain('interoperability')
    for (const item of report.comparison.unsupported) {
      expect(item.code).toBe('attestbook_does_not_execute')
      expect(item.attestbookStatus).not.toBeNull()
      expect(item.reason.length).toBeGreaterThan(0)
    }
    // The structural dimensions AttestBook executed are not unsupported.
    expect(unsupported).not.toContain('schema_validation')
  })

  test('reports explicit gaps and limitations when no external observation is supplied', () => {
    const report = build(comparisonSource(), null)
    expect(report.externalWallet).toBeNull()
    expect(entry(report.comparison.protocol, 'protocol_conformance').result).toBe('not_provided')
    expect(entry(report.comparison.interoperability, 'interoperability').result).toBe(
      'not_provided',
    )
    expect(entry(report.comparison.trust, 'cryptographic_verification').result).toBe('not_provided')
    expect(report.limitations.some((line) => line.includes('No external wallet observation'))).toBe(
      true,
    )
    expect(report.nonClaims).toEqual({
      externalObservationVerified: false,
      cryptographicVerification: false,
      issuerTrust: false,
      protocolConformance: false,
      interoperability: false,
    })
  })

  test('compares a schema dimension when both sources supply a conclusive result', () => {
    const agreement = build(
      comparisonSource(),
      externalWalletObservation([
        { dimension: 'schema_validation', status: 'PASS', code: null, detail: null },
      ]),
    )
    const agreementEntry = entry(agreement.comparison.schema, 'schema_validation')
    expect(agreementEntry.result).toBe('agreement')
    expect(agreementEntry.attestbook?.status).toBe('PASS')
    expect(agreementEntry.external?.status).toBe('PASS')

    const divergence = build(
      comparisonSource({
        validation: comparisonValidationResult({ attestation_constraints: 'FAIL' }),
      }),
      externalWalletObservation([
        { dimension: 'attestation_constraints', status: 'PASS', code: null, detail: null },
      ]),
    )
    const divergenceEntry = entry(divergence.comparison.schema, 'attestation_constraints')
    expect(divergenceEntry.result).toBe('divergence')
    expect(divergenceEntry.attestbook?.status).toBe('FAIL')
  })

  test('does not compare when either side is inconclusive or did not execute', () => {
    const inconclusive = build(
      comparisonSource({
        validation: comparisonValidationResult({ schema_validation: 'INCONCLUSIVE' }),
      }),
      externalWalletObservation([
        { dimension: 'schema_validation', status: 'PASS', code: null, detail: null },
      ]),
    )
    expect(entry(inconclusive.comparison.schema, 'schema_validation').result).toBe('not_comparable')
    expect(
      inconclusive.comparison.unsupported.some(
        (item) => item.dimension === 'schema_validation' && item.code === 'not_comparable',
      ),
    ).toBe(true)

    const notTested = build(
      comparisonSource({
        validation: comparisonValidationResult({ credential_parsing: 'NOT_TESTED' }),
      }),
      externalWalletObservation([
        { dimension: 'credential_parsing', status: 'PASS', code: null, detail: null },
      ]),
    )
    expect(entry(notTested.comparison.schema, 'credential_parsing').result).toBe('not_comparable')
  })

  test('reports a dimension with no evidence from either source as not provided', () => {
    const report = build(
      comparisonSource({
        validation: comparisonValidationResult({ format_recognition: 'NOT_TESTED' }),
      }),
      null,
    )
    expect(entry(report.comparison.schema, 'format_recognition').result).toBe('not_provided')
    expect(
      report.comparison.unsupported.some(
        (item) => item.dimension === 'format_recognition' && item.code === 'no_evidence_supplied',
      ),
    ).toBe(true)
  })

  test('never turns an external observation into an AttestBook status', () => {
    const report = build(
      comparisonSource(),
      externalWalletObservation([
        { dimension: 'cryptographic_verification', status: 'PASS', code: null, detail: null },
        { dimension: 'issuer_trust', status: 'PASS', code: null, detail: null },
      ]),
    )
    expect(report.attestbook.overallStatus).toBe('NOT_TESTED')
    expect(
      report.attestbook.limitations.some(
        (limitation) => limitation.dimension === 'cryptographic_verification',
      ),
    ).toBe(true)
    expect(
      report.comparison.unsupported.find((item) => item.dimension === 'cryptographic_verification')
        ?.code,
    ).toBe('attestbook_does_not_execute')
  })

  test('carries the non-sensitive structural evidence and the validation limitations', () => {
    const report = build()
    expect(report.attestbook.credential).toEqual({
      format: 'dc+sd-jwt',
      vct: 'https://example.org/vct/pid',
      disclosureCount: 3,
      keyBindingPresent: true,
    })
    expect(report.attestbook.schemaReferences).toHaveLength(1)
    expect(report.attestbook.limitations.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('synthetic-access-token')
    expect(serialized).not.toContain('given_name')
  })

  test('is deterministic for a fixed clock', () => {
    const first = build()
    const second = build()
    expect(first).toEqual(second)
  })

  test('rejects an invalid comparison clock', () => {
    expect(() =>
      buildHeadlessWalletComparison({
        source: comparisonSource(),
        externalWallet: null,
        now: () => new Date('not-a-date'),
      }),
    ).toThrow('the comparison clock returned an invalid date')
  })

  test('never compares a protocol observation with an AttestBook dimension it did not execute', () => {
    const report = build(
      comparisonSource(),
      externalWalletObservation([
        { dimension: 'protocol_conformance', status: 'PASS', code: null, detail: null },
        { dimension: 'interoperability', status: 'FAIL', code: null, detail: null },
      ]),
    )
    expect(entry(report.comparison.protocol, 'protocol_conformance').result).toBe('external_only')
    expect(entry(report.comparison.interoperability, 'interoperability').result).toBe(
      'external_only',
    )
    expect(report.attestbook.overallStatus).toBe('NOT_TESTED')
  })
})
