// Deterministic fixtures for the continuous-conformance tests (FR-022, #51).
//
// A fixture validation result is built through the same `createDimension`
// constructor the engine uses, so it cannot encode a status that contradicts
// its applicability or execution. The fixture is only for the pure builder and
// adapter-contract tests; the real engine is exercised by the API contract
// tests.

import { sha256Hex } from '../../registry/digest'
import { aggregateStatus, createDimension, limitationsFromDimensions } from '../../validation'
import type {
  CredentialValidationResult,
  ValidateCredentialInput,
  ValidationDimension,
  ValidationDimensionId,
  ValidationFinding,
  ValidationStatus,
} from '../../validation'
import { buildConformanceResult } from '../result'
import type { ConformanceResult } from '../types'

export const TEST_RULEBOOK_ID = 'rulebook-conformance-1'
export const TEST_RULEBOOK_NAME = 'Conformance rulebook'
export const TEST_RULEBOOK_VERSION = '2.1'
export const TEST_RULEBOOK_DIGEST = sha256Hex(
  new TextEncoder().encode('conformance rulebook snapshot'),
)
export const TEST_ATTESTATION_TYPE = 'PID'
export const TEST_SPEC_VERSION = 'ts11@1.0.1'
export const TEST_VALIDATION_ID = 'validation-conformance-1'
export const TEST_VALIDATED_AT = '2026-02-03T04:05:06.000Z'
export const TEST_SCHEMA_URI = 'https://example.org/schemas/pid.json'
export const TEST_SCHEMA_CONTENT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['given_name'],
  properties: { given_name: { type: 'string' } },
})

/** A compact-shaped credential string; never a real signed artifact. */
export const TEST_CREDENTIAL =
  'eyJhbGciOiJFUzI1NiJ9.eyJ2Y3QiOiJodHRwczovL2V4YW1wbGUub3JnL3ZjL3BpZCJ9.c2lnbmF0dXJl~ZGlzY2xvc3VyZQ'

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

const FINDING_CODES: Readonly<Record<ValidationDimensionId, string>> = {
  credential_parsing: 'sd_jwt_malformed',
  format_recognition: 'format_not_recognized',
  cryptographic_verification: 'signature_not_verified',
  schema_validation: 'schema_violation',
  attestation_constraints: 'missing_key_binding',
  issuer_trust: 'trust_not_evaluated',
  protocol_conformance: 'protocol_not_applicable',
  interoperability: 'interoperability_not_applicable',
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
      code: status === 'FAIL' ? FINDING_CODES[dimension] : `${dimension}_${status.toLowerCase()}`,
      message: `The ${dimension} dimension is ${status}.`,
      severity,
      dimension,
    },
  ]
}

function buildDimension(
  dimension: ValidationDimensionId,
  status: ValidationStatus,
  findings?: readonly ValidationFinding[],
): ValidationDimension {
  const executed = status === 'PASS' || status === 'FAIL' || status === 'INCONCLUSIVE'
  return createDimension({
    id: dimension,
    status,
    applicable: status !== 'NOT_APPLICABLE',
    executed,
    findings: findings ?? findingsFor(dimension, status),
    evidence: {
      scope: `Fixture scope for ${dimension}.`,
      reason: `Fixture reason for ${dimension}.`,
      details: {},
    },
  })
}

export interface ConformanceFixtureOptions {
  readonly statuses?: Partial<Record<ValidationDimensionId, ValidationStatus>>
  /** Overrides the generated findings of a dimension (for runtime conditions). */
  readonly findings?: Partial<Record<ValidationDimensionId, readonly ValidationFinding[]>>
  readonly validationId?: string
  readonly validatedAt?: string
  readonly rulebookName?: string
  readonly rulebookStatus?: 'draft' | 'published' | 'historical'
  readonly rulebookId?: string
  readonly rulebookVersion?: string
  readonly rulebookDigest?: string
  readonly attestationType?: string
  readonly specVersion?: string
  readonly credential?: string
  readonly credentialFormatHint?: string | null
  readonly schemaDocuments?: readonly { readonly uri: string; readonly content: string }[]
}

/** Builds a structurally valid validation result with overridable statuses. */
export function conformanceValidationResult(
  options: ConformanceFixtureOptions = {},
): CredentialValidationResult {
  const dimensions = Object.entries(DEFAULT_STATUSES).map(([dimension, status]) =>
    buildDimension(
      dimension as ValidationDimensionId,
      options.statuses?.[dimension as ValidationDimensionId] ?? status,
      options.findings?.[dimension as ValidationDimensionId],
    ),
  )
  return {
    validationId: options.validationId ?? TEST_VALIDATION_ID,
    validatedAt: options.validatedAt ?? TEST_VALIDATED_AT,
    rulebook: {
      id: options.rulebookId ?? TEST_RULEBOOK_ID,
      name: options.rulebookName ?? TEST_RULEBOOK_NAME,
      version: options.rulebookVersion ?? TEST_RULEBOOK_VERSION,
      digest: options.rulebookDigest ?? TEST_RULEBOOK_DIGEST,
      digestVerified: true,
      specVersion: options.specVersion ?? TEST_SPEC_VERSION,
      status: options.rulebookStatus ?? 'published',
    },
    attestation: {
      name: options.attestationType ?? TEST_ATTESTATION_TYPE,
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
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
        uri: TEST_SCHEMA_URI,
        integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
        kind: 'json_schema',
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

/** Builds the normalized validation request matching a fixture result. */
export function conformanceRequest(
  options: ConformanceFixtureOptions = {},
): ValidateCredentialInput {
  const credentialText = options.credential ?? TEST_CREDENTIAL
  const formatHint = options.credentialFormatHint ?? null
  const schemaDocuments =
    options.schemaDocuments ?? ([{ uri: TEST_SCHEMA_URI, content: TEST_SCHEMA_CONTENT }] as const)
  return {
    rulebookId: options.rulebookId ?? TEST_RULEBOOK_ID,
    rulebookVersion: options.rulebookVersion ?? TEST_RULEBOOK_VERSION,
    attestationType: options.attestationType ?? TEST_ATTESTATION_TYPE,
    credential:
      formatHint === null ? credentialText : { value: credentialText, format: formatHint },
    schemaDocuments: [...schemaDocuments],
  }
}

/** Builds a complete reproducible conformance result from the fixture. */
export function conformanceResult(options: ConformanceFixtureOptions = {}): ConformanceResult {
  return buildConformanceResult({
    validation: conformanceValidationResult(options),
    request: conformanceRequest(options),
  })
}
