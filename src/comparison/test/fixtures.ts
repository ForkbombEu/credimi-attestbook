// Deterministic fixtures for the headless-wallet comparison tests
// (FR-021, issue #50). They build a valid structural validation result through
// the same `createDimension` constructor the engine uses, so a fixture cannot
// encode a status that contradicts its applicability or execution.

import { sha256Hex } from '../../registry/digest'
import { aggregateStatus, createDimension, limitationsFromDimensions } from '../../validation'
import type {
  CredentialValidationResult,
  ValidationDimension,
  ValidationDimensionId,
  ValidationFinding,
  ValidationStatus,
} from '../../validation'
import type {
  ComparisonEvidenceSource,
  ExternalDimensionObservation,
  ExternalWalletObservation,
} from '../types'

export const TEST_CAPTURE_ID = 'capture-headless-1'
export const TEST_CORRELATION_ID = 'correlation-headless-1'
export const TEST_EXECUTION_REF = 'credimi-execution-headless-1'
export const TEST_RULEBOOK_ID = 'rulebook-headless-1'
export const TEST_RULEBOOK_NAME = 'Headless comparison rulebook'
export const TEST_RULEBOOK_VERSION = '1.0'
export const TEST_RULEBOOK_DIGEST = sha256Hex(
  new TextEncoder().encode('headless comparison rulebook snapshot'),
)
export const TEST_ATTESTATION_TYPE = 'PID'
export const TEST_SPEC_VERSION = 'ts11@1.0.1'
export const TEST_BOUND_AT = '2026-01-02T03:04:00Z'
export const TEST_VALIDATED_AT = '2026-01-02T03:04:01.000Z'
export const TEST_COMPARED_AT = new Date('2026-01-02T03:05:00.000Z')
export const TEST_WALLET_ID = 'wallet-a'

const DEFAULT_STATUSES: Readonly<Record<ValidationDimensionId, ValidationStatus>> = {
  credential_parsing: 'PASS',
  format_recognition: 'PASS',
  cryptographic_verification: 'NOT_TESTED',
  schema_validation: 'PASS',
  attestation_constraints: 'PASS',
  issuer_trust: 'NOT_TESTED',
  protocol_conformance: 'NOT_APPLICABLE',
  interoperability: 'NOT_APPLICABLE',
}

function findingsFor(
  dimension: ValidationDimensionId,
  status: ValidationStatus,
): readonly ValidationFinding[] {
  if (status === 'PASS') {
    return []
  }
  const severity = status === 'FAIL' ? 'error' : status === 'INCONCLUSIVE' ? 'warning' : 'info'
  return [
    {
      code: `${dimension}_${status.toLowerCase()}`,
      message: `The ${dimension} dimension is ${status}.`,
      severity,
      dimension,
    },
  ]
}

function buildDimension(
  dimension: ValidationDimensionId,
  status: ValidationStatus,
): ValidationDimension {
  const executed = status === 'PASS' || status === 'FAIL' || status === 'INCONCLUSIVE'
  return createDimension({
    id: dimension,
    status,
    applicable: status !== 'NOT_APPLICABLE',
    executed,
    findings: findingsFor(dimension, status),
    evidence: {
      scope: `Fixture scope for ${dimension}.`,
      reason: `Fixture reason for ${dimension}.`,
      details: {},
    },
  })
}

/** Builds a structurally valid validation result with overridable statuses. */
export function comparisonValidationResult(
  overrides: Partial<Record<ValidationDimensionId, ValidationStatus>> = {},
): CredentialValidationResult {
  const dimensions = Object.entries(DEFAULT_STATUSES).map(([dimension, status]) =>
    buildDimension(
      dimension as ValidationDimensionId,
      overrides[dimension as ValidationDimensionId] ?? status,
    ),
  )
  return {
    validationId: 'validation-headless-1',
    validatedAt: TEST_VALIDATED_AT,
    rulebook: {
      id: TEST_RULEBOOK_ID,
      name: TEST_RULEBOOK_NAME,
      version: TEST_RULEBOOK_VERSION,
      digest: TEST_RULEBOOK_DIGEST,
      digestVerified: true,
      specVersion: TEST_SPEC_VERSION,
      status: 'published',
    },
    attestation: {
      name: TEST_ATTESTATION_TYPE,
      attestationLoS: 'iso_18045_high',
      bindingType: 'cryptographic',
      supportedFormats: ['dc+sd-jwt'],
    },
    credential: {
      format: 'dc+sd-jwt',
      vct: 'https://example.org/vct/pid',
      disclosureCount: 3,
      keyBindingPresent: true,
    },
    schemaReferences: [
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://example.org/vct/pid',
        integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
        kind: 'type_metadata',
        applied: true,
      },
    ],
    dimensions,
    violations: dimensions.flatMap((dimension) =>
      dimension.findings.filter(
        (finding) => finding.severity === 'error' || finding.severity === 'warning',
      ),
    ),
    limitations: limitationsFromDimensions(dimensions),
    overallStatus: aggregateStatus(dimensions),
  }
}

/** Builds a recorded capture correlation source for the pure comparison tests. */
export function comparisonSource(
  overrides: {
    readonly validation?: CredentialValidationResult
    readonly testExecutionRef?: string | null
  } = {},
): ComparisonEvidenceSource {
  return {
    captureId: TEST_CAPTURE_ID,
    correlationId: TEST_CORRELATION_ID,
    testExecutionRef:
      overrides.testExecutionRef === undefined ? TEST_EXECUTION_REF : overrides.testExecutionRef,
    sourceComponent: 'capture-issuer',
    protocol: 'openid4vci',
    credentialFormat: 'dc+sd-jwt',
    rulebook: {
      rulebookId: TEST_RULEBOOK_ID,
      rulebookName: TEST_RULEBOOK_NAME,
      version: TEST_RULEBOOK_VERSION,
      contentDigest: TEST_RULEBOOK_DIGEST,
      digestVerified: true,
      specVersion: TEST_SPEC_VERSION,
      rulebookStatus: 'published',
      attestationType: TEST_ATTESTATION_TYPE,
      boundAt: TEST_BOUND_AT,
    },
    validation: overrides.validation ?? comparisonValidationResult(),
  }
}

/** Builds a caller-supplied external wallet observation. */
export function externalWalletObservation(
  observations: readonly ExternalDimensionObservation[] = [
    {
      dimension: 'cryptographic_verification',
      status: 'PASS',
      code: 'signature-valid',
      detail: 'The external wallet verified the issuer signature.',
    },
    {
      dimension: 'issuer_trust',
      status: 'NOT_TESTED',
      code: null,
      detail: null,
    },
    {
      dimension: 'protocol_conformance',
      status: 'PASS',
      code: 'issuance-flow-complete',
      detail: 'The external wallet completed the issuance flow.',
    },
    {
      dimension: 'interoperability',
      status: 'FAIL',
      code: 'claim-not-presented',
      detail: 'The external wallet did not present the family_name claim.',
    },
  ],
): ExternalWalletObservation {
  return {
    walletId: TEST_WALLET_ID,
    observedAt: '2026-01-02T03:04:30Z',
    interaction: 'issuance',
    observations,
  }
}
