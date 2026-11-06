import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AcceptanceError, runAcceptance } from './workflow'

/** A throwaway directory removed after the test that created it. */
function temporaryUiDirectory(content?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'attestbook-acceptance-ui-'))
  if (content !== undefined) {
    writeFileSync(join(directory, 'index.html'), content, 'utf8')
  }
  return directory
}

const MINIMAL_UI_ENTRY =
  '<!doctype html><html><head><title>Rulebook catalog · AttestBook</title></head><body></body></html>'

/**
 * Issue #39 acceptance coverage. The workflow is real end to end: temporary
 * SQLite database, checked-in migrations, the real registry, import pipeline,
 * credential validator and in-process HTTP application. The browser UI is
 * exercised separately by the Playwright suite in the `ui` CI job; this test
 * uses a minimal built entry document so the static-serving check is covered
 * without a Vite build.
 */
describe('Phase 1 end-to-end acceptance workflow', () => {
  test('imports TS11 metadata, inspects versions, validates a credential and exports evidence', async () => {
    const { evidence, checks } = await runAcceptance({
      uiRoot: false,
      now: () => '2026-01-01T00:00:00.000Z',
    })

    expect(checks.every((check) => check.passed)).toBe(true)
    expect(checks.length).toBeGreaterThan(60)
    expect(checks.some((check) => check.id === 'ui.built')).toBe(false)

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

    expect(evidence.negativeTypeViolation.overallStatus).toBe('FAIL')
    expect(evidence.negativeUnsupportedFormat.overallStatus).toBe('FAIL')
    expect(evidence.negativeNoSchemaDocument.overallStatus).toBe('NOT_TESTED')

    expect(evidence.nonConflation.structuralPassIsNotOverallPass).toBe(true)
    expect(evidence.nonConflation.cryptographicVerificationNotTested).toBe(true)
    expect(evidence.nonConflation.issuerTrustNotTested).toBe(true)
    expect(evidence.nonConflation.credentialNotInExportedEvidence).toBe(true)

    expect(evidence.ui.checked).toBe(false)
  }, 60_000)

  test('requires the built UI when the caller does not opt out', async () => {
    const directory = temporaryUiDirectory()
    try {
      let error: unknown
      try {
        await runAcceptance({ uiRoot: directory, now: () => '2026-01-01T00:00:00.000Z' })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(AcceptanceError)
      if (!(error instanceof AcceptanceError)) {
        throw error
      }
      expect(error.checks.some((check) => check.id === 'ui.built' && !check.passed)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)

  test('checks the served UI routes when a built entry document exists', async () => {
    const directory = temporaryUiDirectory(MINIMAL_UI_ENTRY)
    try {
      const { evidence, checks } = await runAcceptance({
        uiRoot: directory,
        now: () => '2026-01-01T00:00:00.000Z',
      })

      expect(checks.every((check) => check.passed)).toBe(true)
      expect(checks.some((check) => check.id === 'ui.built' && check.passed)).toBe(true)
      expect(evidence.ui.checked).toBe(true)
      expect(evidence.ui.servedRoutes).toEqual(['/', '/rulebooks/example', '/playground'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
