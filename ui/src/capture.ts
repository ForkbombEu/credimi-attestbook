// Capture explorer display rules (UI-006, issue #48).
//
// Pure presentation logic for the mock-backed explorer: labels, the explicit
// validation eligibility rule and a safe rendering of the redacted projection.
// The raw artifact never reaches the browser, so nothing here can expose it.

import type {
  CaptureArtifactType,
  CaptureEvidenceGapCode,
  CaptureInteractionType,
  CaptureRedactionStatus,
  CaptureSourceComponent,
  CaptureValidationSummary,
} from './types'

export type CaptureValidationStatus = CaptureValidationSummary['overallStatus']

export const CAPTURE_SOURCE_COMPONENT_LABELS: Readonly<Record<CaptureSourceComponent, string>> = {
  'capture-issuer': 'Capture issuer',
  'capture-verifier': 'Capture verifier',
}

export const CAPTURE_INTERACTION_LABELS: Readonly<Record<CaptureInteractionType, string>> = {
  issuance: 'Issuance',
  presentation: 'Presentation',
  error: 'Error',
}

export const CAPTURE_ARTIFACT_TYPE_LABELS: Readonly<Record<CaptureArtifactType, string>> = {
  'issuer-metadata': 'Issuer metadata',
  'credential-offer': 'Credential offer',
  'issued-credential': 'Issued credential',
  'presentation-request': 'Presentation request',
  'presentation-submission': 'Presentation submission',
  'verification-outcome': 'Verification outcome',
  'error-response': 'Error response',
}

export const CAPTURE_REDACTION_LABELS: Readonly<Record<CaptureRedactionStatus, string>> = {
  none: 'Not redacted',
  partial: 'Partially redacted',
  full: 'Fully redacted',
}

export const CAPTURE_EVIDENCE_GAP_LABELS: Readonly<Record<CaptureEvidenceGapCode, string>> = {
  external_artifact_not_fetched: 'External artifact not fetched',
  artifact_redacted_by_source: 'Redacted by source',
  no_test_execution_reference: 'No test execution reference',
  no_rulebook_binding: 'No rulebook binding',
  validation_not_run: 'Validation not run',
  validation_not_applicable: 'Validation not applicable',
}

export interface CaptureValidationEligibility {
  readonly allowed: boolean
  readonly reason: string | null
}

/**
 * Mirrors the server's refusal rules: only an inline, not-source-redacted
 * captured issued credential can be validated. Showing the reason instead of a
 * disabled control keeps missing evidence explicit.
 */
export function captureValidationEligibility(capture: {
  readonly artifact: { readonly availability: 'inline' | 'external' }
  readonly declaredRedaction: { readonly status: CaptureRedactionStatus }
  readonly artifactType: CaptureArtifactType
}): CaptureValidationEligibility {
  if (capture.artifact.availability === 'external') {
    return {
      allowed: false,
      reason:
        'The artifact is stored behind an external reference and AttestBook has not fetched it, so there is no content to validate.',
    }
  }
  if (capture.declaredRedaction.status !== 'none') {
    return {
      allowed: false,
      reason: `The source declared this artifact ${CAPTURE_REDACTION_LABELS[
        capture.declaredRedaction.status
      ].toLowerCase()}. Redacted evidence is not the original credential and is not validated.`,
    }
  }
  if (capture.artifactType !== 'issued-credential') {
    return {
      allowed: false,
      reason:
        'Credential validation applies to a captured issued credential; this artifact type carries no credential the structural engine can inspect.',
    }
  }
  return { allowed: true, reason: null }
}

/** A redacted JSON document as display text; `null` means an opaque artifact. */
export function captureProjectionText(document: unknown): string {
  if (document === null || document === undefined) {
    return ''
  }
  try {
    return JSON.stringify(document, null, 2) ?? ''
  } catch {
    return 'The redacted document could not be rendered.'
  }
}

/** Short binding label used in the list, or an explicit unbound label. */
export function captureBindingLabel(capture: {
  readonly rulebook: { readonly rulebookName: string; readonly version: string } | null
}): string {
  return capture.rulebook === null
    ? 'Not bound'
    : `${capture.rulebook.rulebookName} ${capture.rulebook.version}`
}
