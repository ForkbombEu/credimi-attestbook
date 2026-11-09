// Headless-wallet comparison evidence contracts (FR-021, issue #50).
//
// AttestBook provides the structural/schema side of a headless-wallet
// comparison: the exact rulebook version and digest a captured credential was
// validated against, the non-sensitive credential facts, and the structural
// dimension statuses. The protocol and interoperability side is supplied by
// the caller (Credimi) as an external wallet observation and is recorded as
// bounded input, labelled as external and never folded into an AttestBook
// result.
//
// The contract deliberately has no "overall comparison verdict": the two
// sources measure different things and a structural PASS is not a protocol,
// interoperability, cryptographic or trust conclusion (FR-010, FR-012,
// FR-021). Dimensions AttestBook cannot execute are listed as unsupported
// instead of being silently omitted.

import type {
  CaptureCredentialFormat,
  CaptureProtocol,
  CaptureRulebookBinding,
  CaptureSourceComponent,
} from '../capture'
import type {
  CredentialEvidence,
  CredentialValidationResult,
  SchemaReferenceEvidence,
  ValidationDimensionId,
  ValidationFinding,
  ValidationLimitation,
  ValidationStatus,
} from '../validation'

/** Format marker carried by every comparison report. */
export const HEADLESS_WALLET_COMPARISON_KIND = 'attestbook.headless-wallet-comparison@1'

/** Version of the comparison contract this module produces. */
export const HEADLESS_WALLET_COMPARISON_VERSION = 1

/** Interaction the external wallet was observed in. */
export const EXTERNAL_WALLET_INTERACTIONS = ['issuance', 'presentation', 'both'] as const
export type ExternalWalletInteraction = (typeof EXTERNAL_WALLET_INTERACTIONS)[number]

/**
 * How one dimension's two evidence sources relate:
 *
 * - `agreement` / `divergence`: AttestBook executed the dimension and the
 *   caller supplied an observation for it, and both use a `PASS`/`FAIL`
 *   outcome;
 * - `attestbook_only`: only AttestBook produced comparable evidence;
 * - `external_only`: only the caller's external observation exists;
 * - `not_provided`: neither source supplied evidence;
 * - `not_comparable`: both supplied a value, but at least one is a
 *   non-conclusive status (`NOT_TESTED`, `NOT_APPLICABLE`, `INCONCLUSIVE`) or
 *   AttestBook did not execute the dimension.
 */
export const COMPARISON_RESULTS = [
  'agreement',
  'divergence',
  'attestbook_only',
  'external_only',
  'not_provided',
  'not_comparable',
] as const
export type ComparisonResult = (typeof COMPARISON_RESULTS)[number]

/** Stable reasons a dimension could not be compared. */
export const UNSUPPORTED_COMPARISON_CODES = [
  'attestbook_does_not_execute',
  'no_evidence_supplied',
  'not_comparable',
] as const
export type UnsupportedComparisonCode = (typeof UNSUPPORTED_COMPARISON_CODES)[number]

/** One dimension observed on the external wallet side. */
export interface ExternalDimensionObservation {
  readonly dimension: ValidationDimensionId
  readonly status: ValidationStatus
  /** Stable caller-defined code, when the observation carries one. */
  readonly code: string | null
  /** Caller-supplied non-sensitive detail, when the observation carries one. */
  readonly detail: string | null
}

/**
 * The caller-supplied external wallet behaviour. It is untrusted input:
 * AttestBook records it as external evidence, never verifies it and never
 * treats it as its own validation result.
 */
export interface ExternalWalletObservation {
  /** Opaque caller-owned wallet identifier, trimmed and bounded. */
  readonly walletId: string
  /** Caller-asserted RFC 3339 observation timestamp, trimmed and bounded. */
  readonly observedAt: string
  readonly interaction: ExternalWalletInteraction
  readonly observations: readonly ExternalDimensionObservation[]
}

/** The AttestBook-side evidence a comparison is built from. */
export interface ComparisonEvidenceSource {
  readonly captureId: string
  readonly correlationId: string
  /** Opaque Credimi test-execution reference, preserved verbatim. */
  readonly testExecutionRef: string | null
  readonly sourceComponent: CaptureSourceComponent
  readonly protocol: CaptureProtocol
  readonly credentialFormat: CaptureCredentialFormat
  /** The exact pinned rulebook version and digest the capture was bound to. */
  readonly rulebook: CaptureRulebookBinding
  /** The structural validation result recorded for the capture. */
  readonly validation: CredentialValidationResult
}

/** One dimension entry of a comparison group. */
export interface ComparisonDimensionEntry {
  readonly dimension: ValidationDimensionId
  /** AttestBook evidence, present only for dimensions it actually executes. */
  readonly attestbook: {
    readonly status: ValidationStatus
    readonly applicable: boolean
    readonly executed: boolean
  } | null
  /** External observation, recorded as bounded input and never verified here. */
  readonly external: {
    readonly status: ValidationStatus
    readonly code: string | null
    readonly detail: string | null
  } | null
  readonly result: ComparisonResult
}

/** One dimension whose comparison is not supported by this build. */
export interface UnsupportedComparison {
  readonly dimension: ValidationDimensionId
  readonly code: UnsupportedComparisonCode
  /** The AttestBook validation status for the dimension, when one exists. */
  readonly attestbookStatus: ValidationStatus | null
  readonly reason: string
}

/**
 * The complete, versioned comparison report. It carries no raw credential,
 * disclosure, claim value or key material.
 */
export interface HeadlessWalletComparisonReport {
  readonly kind: typeof HEADLESS_WALLET_COMPARISON_KIND
  readonly contractVersion: typeof HEADLESS_WALLET_COMPARISON_VERSION
  /** AttestBook timestamp of the comparison, RFC 3339 UTC. */
  readonly comparedAt: string
  /** The exact pinned rulebook version and digest the capture was bound to. */
  readonly rulebook: CaptureRulebookBinding
  readonly capture: {
    readonly captureId: string
    readonly correlationId: string
    readonly testExecutionRef: string | null
    readonly sourceComponent: CaptureSourceComponent
    readonly protocol: CaptureProtocol
    readonly credentialFormat: CaptureCredentialFormat
  }
  /** AttestBook structural/schema evidence for the captured credential. */
  readonly attestbook: {
    readonly validationId: string
    readonly validatedAt: string
    readonly overallStatus: ValidationStatus
    readonly credential: CredentialEvidence
    readonly schemaReferences: readonly SchemaReferenceEvidence[]
    readonly violations: readonly ValidationFinding[]
    readonly limitations: readonly ValidationLimitation[]
  }
  /** The external wallet observation, or `null` when none was supplied. */
  readonly externalWallet: ExternalWalletObservation | null
  readonly comparison: {
    /** The four AttestBook-executable structural/schema dimensions. */
    readonly schema: readonly ComparisonDimensionEntry[]
    /** Protocol conformance, which only the external observation can report. */
    readonly protocol: readonly ComparisonDimensionEntry[]
    /** End-to-end interoperability, which only the external observation can report. */
    readonly interoperability: readonly ComparisonDimensionEntry[]
    /** Cryptography and issuer trust, which AttestBook does not execute. */
    readonly trust: readonly ComparisonDimensionEntry[]
    /** Every dimension the comparison cannot establish, with its reason. */
    readonly unsupported: readonly UnsupportedComparison[]
  }
  /** Explicit non-claims of the report. */
  readonly nonClaims: {
    readonly externalObservationVerified: false
    readonly cryptographicVerification: false
    readonly issuerTrust: false
    readonly protocolConformance: false
    readonly interoperability: false
  }
  readonly limitations: readonly string[]
}
