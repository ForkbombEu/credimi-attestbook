import { describe, expect, test } from 'vitest'

import {
  CAPTURE_EVIDENCE_GAP_LABELS,
  captureBindingLabel,
  captureProjectionText,
  captureValidationEligibility,
} from './capture'
import { makeCaptureSummary } from './test/captures'

describe('capture validation eligibility', () => {
  test('allows an inline, not-source-redacted issued credential', () => {
    expect(captureValidationEligibility(makeCaptureSummary())).toEqual({
      allowed: true,
      reason: null,
    })
  })

  test('refuses an external artifact because it was not fetched', () => {
    const eligibility = captureValidationEligibility(
      makeCaptureSummary({
        artifact: {
          availability: 'external',
          mediaType: 'application/json',
          byteLength: 1,
          uri: 'https://example.test/a.json',
        },
      }),
    )
    expect(eligibility.allowed).toBe(false)
    expect(eligibility.reason).toContain('external reference')
  })

  test('refuses source-redacted evidence', () => {
    const eligibility = captureValidationEligibility(
      makeCaptureSummary({
        declaredRedaction: {
          status: 'partial',
          policyRef: 'source-policy',
          redactedPaths: ['/claims'],
          redactedDigest: null,
        },
      }),
    )
    expect(eligibility.allowed).toBe(false)
    expect(eligibility.reason).toContain('partially redacted')
  })

  test('refuses an artifact type that carries no credential', () => {
    const eligibility = captureValidationEligibility(
      makeCaptureSummary({ artifactType: 'presentation-request' }),
    )
    expect(eligibility.allowed).toBe(false)
    expect(eligibility.reason).toContain('no credential')
  })
})

describe('capture display helpers', () => {
  test('renders a redacted document as stable JSON', () => {
    expect(captureProjectionText({ claims: '[redacted]', count: 1 })).toBe(
      '{\n  "claims": "[redacted]",\n  "count": 1\n}',
    )
  })

  test('returns an empty string for a null document', () => {
    expect(captureProjectionText(null)).toBe('')
  })

  test('labels an unbound capture and a bound capture', () => {
    expect(captureBindingLabel(makeCaptureSummary())).toBe('Not bound')
    expect(
      captureBindingLabel(
        makeCaptureSummary({
          rulebook: {
            rulebookId: 'rulebook-pid',
            rulebookName: 'PID Rulebook',
            version: '1.0',
            contentDigest: 'a'.repeat(64),
            digestVerified: true,
            specVersion: 'ts11@1.0.1',
            rulebookStatus: 'published',
            attestationType: 'PID',
            boundAt: '2026-11-09T10:00:00.000Z',
          },
        }),
      ),
    ).toBe('PID Rulebook 1.0')
  })

  test('labels every explicit evidence gap', () => {
    const codes = [
      'external_artifact_not_fetched',
      'artifact_redacted_by_source',
      'no_test_execution_reference',
      'no_rulebook_binding',
      'validation_not_run',
      'validation_not_applicable',
    ] as const
    for (const code of codes) {
      expect(CAPTURE_EVIDENCE_GAP_LABELS[code]).not.toBe('')
    }
  })
})
