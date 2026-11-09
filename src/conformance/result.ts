// Deterministic conformance result builder (FR-022, issue #51).
//
// One structural validation run against one pinned rulebook snapshot is turned
// into a machine-readable result with:
//
//   inputDigest     = SHA-256(canonical pin + credential + schema identity)
//   resultReference = SHA-256(canonical pin + input + structural evidence +
//                             the stable failure classification)
//
// Validation identifiers, wall-clock timestamps and mutable rulebook lifecycle
// metadata are deliberately excluded, so repeating the same pinned run yields
// the same digest and reference. The module performs no I/O, starts no
// execution, schedules nothing and contacts no external orchestration platform.

import { stableJson } from '../import/identity'
import { sha256Hex } from '../registry/digest'
import type {
  CredentialValidationResult,
  ValidateCredentialInput,
  ValidationDimension,
  ValidationDimensionId,
} from '../validation'

import {
  CONFORMANCE_CANONICALIZATION,
  CONFORMANCE_DIGEST_ALGORITHM,
  CONFORMANCE_ENVIRONMENT_FINDING_CODES,
  CONFORMANCE_INPUT_FORMAT,
  CONFORMANCE_REFERENCE_FORMAT,
  CONFORMANCE_REFERENCE_SCOPE,
  CONFORMANCE_RESULT_KIND,
  CONFORMANCE_RESULT_VERSION,
  type ConformanceEvidence,
  type ConformanceFailure,
  type ConformanceFailureClass,
  type ConformanceInput,
  type ConformanceOutcome,
  type ConformancePin,
  type ConformanceResult,
  type ConformanceSchemaDocumentDigest,
} from './types'

/** Stable failure class of each dimension the structural engine can fail. */
export const FAILURE_CLASS_BY_DIMENSION: Readonly<
  Partial<Record<ValidationDimensionId, ConformanceFailureClass>>
> = Object.freeze({
  credential_parsing: 'credential_unparseable',
  format_recognition: 'format_unrecognized',
  schema_validation: 'schema_violation',
  attestation_constraints: 'attestation_constraint_violation',
})

/** Fallback for a failed dimension added after this contract was written. */
export const DEFAULT_FAILURE_CLASS: ConformanceFailureClass = 'dimension_failure'

/** Static limitations every conformance result carries. */
export const CONFORMANCE_RESULT_LIMITATIONS: readonly string[] = Object.freeze([
  'A conformance result is the pinned structural validation evidence of one credential artifact. It is not a standards, cryptographic, issuer-trust, protocol or interoperability verdict.',
  'The resultReference is deterministic for the same pinned snapshot, credential bytes, supplied schema documents and structural evidence. Validation identifiers, wall-clock timestamps, mutable rulebook name/status metadata, static limitation prose and non-claim constants are excluded from it.',
  'A result with deterministic false was cut short by a runtime condition such as a busy or unavailable schema sandbox. It must be retried, and its resultReference must not be compared with an earlier run as drift.',
  'AttestBook does not schedule, start or observe recurring executions. External orchestration drives recurrence, stores the stable result reference and compares later references.',
  'Cryptographic verification, issuer trust, protocol conformance and interoperability are not executed and are never inferred from a structural outcome.',
])

/** Maps an FR-012 aggregate status to a structural conformance outcome. */
export function conformanceOutcome(
  status: CredentialValidationResult['overallStatus'],
): ConformanceOutcome {
  switch (status) {
    case 'PASS':
      return 'structural_pass'
    case 'FAIL':
      return 'structural_fail'
    case 'INCONCLUSIVE':
      return 'inconclusive'
    case 'NOT_TESTED':
      return 'evidence_incomplete'
    case 'NOT_APPLICABLE':
      return 'not_applicable'
  }
}

/** Returns the exact credential text the engine inspected. */
export function conformanceCredentialText(input: ValidateCredentialInput): string {
  return typeof input.credential === 'string' ? input.credential : input.credential.value
}

/** Returns the caller's explicit format hint, if one was supplied. */
export function conformanceCredentialFormatHint(input: ValidateCredentialInput): string | null {
  return typeof input.credential === 'string' ? null : (input.credential.format ?? null)
}

/** Lowercase hex SHA-256 of exact UTF-8 text. */
export function sha256Text(text: string): string {
  return sha256Hex(new TextEncoder().encode(text))
}

function pinFromValidation(validation: CredentialValidationResult): ConformancePin {
  return {
    rulebookId: validation.rulebook.id,
    version: validation.rulebook.version,
    contentDigest: validation.rulebook.digest,
    specVersion: validation.rulebook.specVersion,
    attestationType: validation.attestation.name,
    digestVerified: true,
  }
}

/**
 * Refuses to build a result from evidence that is not exactly the requested
 * pin. The engine already resolves the pin; this is a defensive server-fault
 * check, never a caller-visible validation outcome.
 */
function assertRequestMatchesPin(
  request: ValidateCredentialInput,
  validation: CredentialValidationResult,
): void {
  if (
    validation.rulebook.id !== request.rulebookId ||
    validation.rulebook.version !== request.rulebookVersion ||
    validation.attestation.name !== request.attestationType
  ) {
    throw new Error('the validation evidence does not name the requested pinned selection')
  }
}

function sortedErrorCodes(dimension: ValidationDimension): string[] {
  const codes = new Set(
    dimension.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => finding.code),
  )
  return [...codes].sort()
}

function failureClassesFor(dimensions: readonly ValidationDimension[]): ConformanceFailure[] {
  const failures: ConformanceFailure[] = []
  for (const dimension of dimensions) {
    if (dimension.status !== 'FAIL') {
      continue
    }
    failures.push({
      code: FAILURE_CLASS_BY_DIMENSION[dimension.id] ?? DEFAULT_FAILURE_CLASS,
      dimension: dimension.id,
      findingCodes: sortedErrorCodes(dimension),
    })
  }
  return failures
}

function environmentConditionsFor(dimensions: readonly ValidationDimension[]): string[] {
  const codes = new Set<string>()
  for (const dimension of dimensions) {
    for (const finding of dimension.findings) {
      if ((CONFORMANCE_ENVIRONMENT_FINDING_CODES as readonly string[]).includes(finding.code)) {
        codes.add(finding.code)
      }
    }
  }
  return [...codes].sort()
}

function buildInput(pin: ConformancePin, request: ValidateCredentialInput): ConformanceInput {
  const schemaDocuments: ConformanceSchemaDocumentDigest[] = (request.schemaDocuments ?? [])
    // The engine matches schema documents by URI and rejects duplicates, so
    // sorting makes the input identity independent of request order.
    .map((document) => ({
      uri: document.uri,
      contentDigest: sha256Text(document.content),
    }))
    .sort((left, right) => left.uri.localeCompare(right.uri))
  const credentialDigest = sha256Text(conformanceCredentialText(request))
  const credentialFormatHint = conformanceCredentialFormatHint(request)
  const inputDigest = sha256Text(
    stableJson({
      format: CONFORMANCE_INPUT_FORMAT,
      pin: {
        rulebookId: pin.rulebookId,
        version: pin.version,
        contentDigest: pin.contentDigest,
        specVersion: pin.specVersion,
        attestationType: pin.attestationType,
      },
      credentialDigest,
      credentialFormatHint,
      schemaDocuments,
    }),
  )
  return {
    credentialDigest,
    credentialFormatHint,
    schemaDocuments,
    inputDigest,
  }
}

function buildEvidence(validation: CredentialValidationResult): ConformanceEvidence {
  return {
    overallStatus: validation.overallStatus,
    credential: validation.credential,
    attestation: validation.attestation,
    schemaReferences: validation.schemaReferences,
    dimensions: validation.dimensions,
    violations: validation.violations,
    limitations: validation.limitations,
  }
}

export interface BuildConformanceResultInput {
  /** The exact structural validation result the engine produced. */
  readonly validation: CredentialValidationResult
  /** The normalized request the engine validated. */
  readonly request: ValidateCredentialInput
}

/**
 * Builds one reproducible conformance result. The caller must pass the exact
 * evidence the engine returned for the same normalized request; a mismatch is a
 * server fault, not a typed validation outcome.
 */
export function buildConformanceResult(input: BuildConformanceResultInput): ConformanceResult {
  const { validation, request } = input
  assertRequestMatchesPin(request, validation)

  const pin = pinFromValidation(validation)
  const inputDigest = buildInput(pin, request)
  const evidence = buildEvidence(validation)
  const environmentConditions = environmentConditionsFor(validation.dimensions)
  const deterministic = environmentConditions.length === 0
  const outcome = deterministic
    ? conformanceOutcome(validation.overallStatus)
    : validation.overallStatus === 'FAIL'
      ? 'structural_fail'
      : 'inconclusive'
  const failureClasses = failureClassesFor(validation.dimensions)

  const resultReference = sha256Text(
    stableJson({
      format: CONFORMANCE_REFERENCE_FORMAT,
      contractVersion: CONFORMANCE_RESULT_VERSION,
      pin,
      input: inputDigest,
      deterministic,
      environmentConditions,
      outcome,
      evidence,
      failureClasses,
    }),
  )

  return {
    kind: CONFORMANCE_RESULT_KIND,
    contractVersion: CONFORMANCE_RESULT_VERSION,
    resultReference,
    deterministic,
    environmentConditions,
    pin,
    input: inputDigest,
    outcome,
    failureClasses,
    evidence,
    references: {
      canonicalization: CONFORMANCE_CANONICALIZATION,
      digestAlgorithm: CONFORMANCE_DIGEST_ALGORITHM,
      referenceScope: CONFORMANCE_REFERENCE_SCOPE,
      statusTaxonomy: 'FR-012',
    },
    nonClaims: {
      cryptographicVerification: false,
      issuerTrust: false,
      protocolConformance: false,
      interoperability: false,
      standardsConformance: false,
      recurringExecutionScheduled: false,
    },
    limitations: [...CONFORMANCE_RESULT_LIMITATIONS],
  }
}
