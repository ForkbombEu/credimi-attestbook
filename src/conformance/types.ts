// Reproducible continuous conformance result contracts (FR-022, issue #51).
//
// A conformance result is the machine-readable evidence of one structural
// validation run against one pinned rulebook snapshot. It carries a stable,
// content-addressed result reference and an input digest, so external
// orchestration can run the same pinned check again and identify whether the
// evidence reproduced or changed.
//
// The module does not schedule, start or observe recurring executions: external
// orchestration owns recurrence. It also does not turn a structural result into
// a standards, cryptographic, trust, protocol or interoperability verdict
// (FR-010, FR-012, FR-022).

import type {
  AttestationEvidence,
  CredentialEvidence,
  SchemaReferenceEvidence,
  ValidationDimension,
  ValidationDimensionId,
  ValidationFinding,
  ValidationLimitation,
  ValidationStatus,
} from '../validation'

/** Format marker carried by every conformance result. */
export const CONFORMANCE_RESULT_KIND = 'attestbook.conformance-result@1'

/** Version of the conformance result contract this module produces. */
export const CONFORMANCE_RESULT_VERSION = 1

/** Canonical JSON serialization used for the input and result digests. */
export const CONFORMANCE_CANONICALIZATION = 'attestbook.stable-json@1'

/** Digest algorithm used for the input digest and the stable result reference. */
export const CONFORMANCE_DIGEST_ALGORITHM = 'sha256'

/** Format marker carried inside the canonical input digest bytes. */
export const CONFORMANCE_INPUT_FORMAT = 'attestbook.conformance-input@1'

/** Format marker carried inside the canonical result-reference bytes. */
export const CONFORMANCE_REFERENCE_FORMAT = 'attestbook.conformance-reference@1'

/**
 * What the stable result reference covers. It is deliberately explicit so a
 * consumer can tell why two runs do or do not share a reference.
 */
export const CONFORMANCE_REFERENCE_SCOPE = 'pin+input+evidence+failure-classification'

/**
 * Structural outcome of one conformance run. The names avoid implying a
 * standards or interoperability verdict:
 *
 * - `structural_pass`: every dimension the build executes passed, and every
 *   required dimension executed;
 * - `structural_fail`: at least one executed dimension failed;
 * - `inconclusive`: at least one executed dimension did not reach a conclusion;
 * - `evidence_incomplete`: at least one required dimension did not execute;
 * - `not_applicable`: the validation reported no applicable dimension.
 */
export const CONFORMANCE_OUTCOMES = [
  'structural_pass',
  'structural_fail',
  'inconclusive',
  'evidence_incomplete',
  'not_applicable',
] as const
export type ConformanceOutcome = (typeof CONFORMANCE_OUTCOMES)[number]

/**
 * Stable failure classes. A failure class names the kind of structural failure
 * of one dimension; the underlying finding codes stay in `findingCodes` so a
 * classification is stable even when a message or a fine-grained code changes.
 */
export const CONFORMANCE_FAILURE_CLASSES = [
  'credential_unparseable',
  'format_unrecognized',
  'schema_violation',
  'attestation_constraint_violation',
  'dimension_failure',
] as const
export type ConformanceFailureClass = (typeof CONFORMANCE_FAILURE_CLASSES)[number]

/**
 * Finding codes produced when a runtime condition cut a check short instead of
 * the caller's pinned inputs producing a genuine result. A run carrying one of
 * these is not deterministic: retrying the same request may produce a different
 * structural result, so its reference must not be compared as drift.
 */
export const CONFORMANCE_ENVIRONMENT_FINDING_CODES = [
  'schema_sandbox_busy',
  'schema_sandbox_unavailable',
  'schema_evaluation_timeout',
  'schema_evaluation_memory_exceeded',
  'schema_evaluation_output_exceeded',
  'schema_evaluation_failed',
] as const
export type ConformanceEnvironmentFindingCode =
  (typeof CONFORMANCE_ENVIRONMENT_FINDING_CODES)[number]

/** The exact pinned rulebook version a conformance result was produced against. */
export interface ConformancePin {
  readonly rulebookId: string
  readonly version: string
  /** Lowercase hex SHA-256 of the immutable snapshot bytes. */
  readonly contentDigest: string
  readonly specVersion: string
  readonly attestationType: string
  /** Always `true`: the engine aborts the run on a snapshot digest mismatch. */
  readonly digestVerified: true
}

/** One caller-supplied schema document, reduced to its stable identity. */
export interface ConformanceSchemaDocumentDigest {
  readonly uri: string
  /** Lowercase hex SHA-256 of the exact supplied document text. */
  readonly contentDigest: string
}

/**
 * The exact inputs the result reproduces. The raw credential and the raw schema
 * documents are never carried, only their digests.
 */
export interface ConformanceInput {
  /** Lowercase hex SHA-256 of the exact credential artifact text. */
  readonly credentialDigest: string
  /** The caller's explicit format hint, or `null` when none was supplied. */
  readonly credentialFormatHint: string | null
  readonly schemaDocuments: readonly ConformanceSchemaDocumentDigest[]
  /** Lowercase hex SHA-256 of the canonical pin + credential + schema identity. */
  readonly inputDigest: string
}

/** One stable failure classification of a failed dimension. */
export interface ConformanceFailure {
  readonly code: ConformanceFailureClass
  readonly dimension: ValidationDimensionId
  /** Distinct `error`-severity finding codes of the dimension, sorted. */
  readonly findingCodes: readonly string[]
}

/** The deterministic structural evidence the result is built from. */
export interface ConformanceEvidence {
  readonly overallStatus: ValidationStatus
  readonly credential: CredentialEvidence
  readonly attestation: AttestationEvidence
  readonly schemaReferences: readonly SchemaReferenceEvidence[]
  readonly dimensions: readonly ValidationDimension[]
  readonly violations: readonly ValidationFinding[]
  readonly limitations: readonly ValidationLimitation[]
}

/**
 * One reproducible conformance result. Two runs with the same pinned snapshot,
 * credential bytes, supplied schema documents and structural evidence produce
 * the same `inputDigest` and `resultReference`.
 */
export interface ConformanceResult {
  readonly kind: typeof CONFORMANCE_RESULT_KIND
  readonly contractVersion: typeof CONFORMANCE_RESULT_VERSION
  /** Lowercase hex SHA-256 of the canonical reference payload. */
  readonly resultReference: string
  /**
   * `true` only when no runtime condition (`environmentConditions` is empty)
   * cut the run short. A non-deterministic result must be retried before its
   * reference is compared with an earlier run.
   */
  readonly deterministic: boolean
  /** Distinct sorted environment finding codes that cut the run short. */
  readonly environmentConditions: readonly string[]
  readonly pin: ConformancePin
  readonly input: ConformanceInput
  readonly outcome: ConformanceOutcome
  readonly failureClasses: readonly ConformanceFailure[]
  readonly evidence: ConformanceEvidence
  /** Canonicalization and digest facts, so a consumer can verify a reference. */
  readonly references: {
    readonly canonicalization: typeof CONFORMANCE_CANONICALIZATION
    readonly digestAlgorithm: typeof CONFORMANCE_DIGEST_ALGORITHM
    readonly referenceScope: typeof CONFORMANCE_REFERENCE_SCOPE
    readonly statusTaxonomy: 'FR-012'
    /** Build identities, outside the reference payload, for drift triage. */
    readonly engine: {
      readonly attestbook: string
      readonly owfSchema: string
    }
  }
  /** Explicit non-claims of the report. */
  readonly nonClaims: {
    readonly cryptographicVerification: false
    readonly issuerTrust: false
    readonly protocolConformance: false
    readonly interoperability: false
    readonly standardsConformance: false
    readonly recurringExecutionScheduled: false
  }
  readonly limitations: readonly string[]
}
