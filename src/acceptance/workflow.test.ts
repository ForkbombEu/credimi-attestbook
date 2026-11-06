import { describe, expect, test } from 'bun:test'

import { runAcceptance } from './workflow'

/**
 * Issue #39 acceptance coverage. The workflow is real end to end: temporary
 * SQLite database, checked-in migrations, the real registry, import pipeline,
 * credential validator and in-process HTTP application. The browser UI is
 * exercised separately by the Playwright suite in the `ui` CI job; this test
 * skips the built-asset check because the `test` CI job does not run a build.
 */
describe('Phase 1 end-to-end acceptance workflow', () => {
  test('imports TS11 metadata, inspects versions, validates a credential and exports evidence', async () => {
    const { evidence, checks } = await runAcceptance({
      uiRoot: false,
      now: () => '2026-01-01T00:00:00.000Z',
    })

    expect(checks.every((check) => check.passed)).toBe(true)
    expect(checks.length).toBeGreaterThan(60)

    expect(evidence.owf.packageVersion).toBe('0.5.4')
    expect(evidence.owf.validDocument).toBe(true)
    expect(evidence.owf.ts11DocumentRejectedByOwf).toBe(true)

    expect(evidence.importPreview.profile).toBe('ts11@1.0.1')
    expect(evidence.importPreview.conformance).toBe('conformant_subset')
    expect(evidence.importPreview.compatible).toBe(true)

    expect(evidence.version.status).toBe('published')
    expect(evidence.version.recomputedDigest).toBe(evidence.version.contentDigest)
    expect(evidence.version.snapshotHasNormativeFields).toBe(true)

    expect(evidence.valid.overallStatus).toBe('NOT_TESTED')
    expect(evidence.valid.dimensions.map((dimension) => dimension.id)).toEqual([
      'credential_parsing',
      'format_recognition',
      'cryptographic_verification',
      'schema_validation',
      'attestation_constraints',
      'issuer_trust',
      'protocol_conformance',
      'interoperability',
    ])
    expect(
      evidence.valid.dimensions.find((entry) => entry.id === 'schema_validation')?.status,
    ).toBe('PASS')
    expect(
      evidence.valid.dimensions.find((entry) => entry.id === 'cryptographic_verification')?.status,
    ).toBe('NOT_TESTED')
    expect(evidence.valid.limitationCodes).toContain('signature_not_verified')
    expect(evidence.valid.limitationCodes).toContain('trust_not_evaluated')

    expect(evidence.negativeMissingClaim.overallStatus).toBe('FAIL')
    expect(evidence.negativeUnsupportedFormat.overallStatus).toBe('FAIL')
    expect(evidence.negativeNoSchemaDocument.overallStatus).toBe('NOT_TESTED')

    expect(evidence.nonConflation.structuralPassIsNotOverallPass).toBe(true)
    expect(evidence.nonConflation.cryptographicVerificationNotTested).toBe(true)
    expect(evidence.nonConflation.issuerTrustNotTested).toBe(true)
    expect(evidence.nonConflation.credentialNotInExportedEvidence).toBe(true)

    expect(evidence.ui.checked).toBe(false)
  }, 60_000)
})
