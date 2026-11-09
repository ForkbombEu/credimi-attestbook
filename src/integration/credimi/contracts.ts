// Stable contracts of the Credimi integration adapter (FR-020, issue #49).
//
// AttestBook exposes rulebook selection, credential validation and capture
// evidence correlation through its public `/api/v1` API. This module fixes the
// client-side contract Credimi consumes: the response projections are derived
// from the API's own Zod schemas, so a client and the server cannot drift
// silently, and a rulebook pin is a small value object Credimi may persist and
// pass back without depending on any AttestBook or Credimi internal.
//
// Nothing here adds a second orchestration platform. The adapter is an HTTP
// client: it never reads AttestBook's database, never queries Credimi and never
// imports Temporal, StepCI or PocketBase.

import { z } from 'zod'

import type {
  attestationDetailSchema,
  captureCorrelationResultSchema,
  captureExplorerDetailSchema,
  captureExplorerPageSchema,
  captureExplorerSummarySchema,
  compareCaptureRequestSchema,
  conformanceResultSchema,
  credentialValidationResultSchema,
  headlessWalletComparisonSchema,
  rulebookPageSchema,
  rulebookSchema,
  rulebookVersionSchema,
  validateCredentialRequestSchema,
} from '../../api/schemas'

import { CredimiAdapterError } from './errors'

/**
 * Version of the adapter's client-side contract. It changes only for a
 * breaking change to the pin, request or error shapes; additive response
 * fields remain covered by the `/api/v1` additive policy.
 */
export const CREDIMI_ADAPTER_CONTRACT_VERSION = 1

/** Format marker of a pinned rulebook selection. */
export const RULEBOOK_PIN_KIND = 'attestbook.rulebook-pin@1'

/** A rulebook as the public catalogue returns it. */
export type CredimiRulebook = z.infer<typeof rulebookSchema>

/** One page of the public catalogue. */
export type CredimiRulebookPage = z.infer<typeof rulebookPageSchema>

/** One rulebook version record with its exact snapshot digest. */
export type CredimiRulebookVersion = z.infer<typeof rulebookVersionSchema>

/** One attestation type of a rulebook with its schema references. */
export type CredimiAttestation = z.infer<typeof attestationDetailSchema>

/** The complete pinned-version structural validation evidence. */
export type CredimiValidationEvidence = z.infer<typeof credentialValidationResultSchema>

/** The reproducible continuous-conformance result (FR-022). */
export type CredimiConformanceResult = z.infer<typeof conformanceResultSchema>

/** The list projection of one capture artifact. */
export type CredimiCaptureSummary = z.infer<typeof captureExplorerSummarySchema>

/** One capture with its redacted artifact projection and timeline. */
export type CredimiCaptureDetail = z.infer<typeof captureExplorerDetailSchema>

/** One page of capture evidence. */
export type CredimiCapturePage = z.infer<typeof captureExplorerPageSchema>

/** A capture bound to a pinned rulebook version, with its validation result. */
export type CredimiEvidenceCorrelation = z.infer<typeof captureCorrelationResultSchema>

/** The headless-wallet comparison report (FR-021). */
export type CredimiHeadlessWalletComparison = z.infer<typeof headlessWalletComparisonSchema>

/** The caller-supplied external wallet observation of a comparison request. */
export type CredimiExternalWalletObservation = NonNullable<
  z.infer<typeof compareCaptureRequestSchema>['externalWallet']
>

/** One capture to compare, pinned to the exact rulebook version. */
export interface CredimiComparisonInput {
  readonly captureId: string
  readonly pin: CredimiRulebookPin
  /**
   * External wallet behaviour to record as bounded input. Omitted when only
   * the AttestBook structural evidence is needed; the report then lists the
   * protocol and interoperability dimensions as gaps.
   */
  readonly externalWallet?: CredimiExternalWalletObservation
}

/** A credential artifact as the validation API accepts it. */
export type CredimiCredentialInput = z.infer<typeof validateCredentialRequestSchema>['credential']

/** One caller-supplied schema document for a pinned reference URI. */
export type CredimiSchemaDocumentInput = NonNullable<
  z.infer<typeof validateCredentialRequestSchema>['schemaDocuments']
>[number]

/**
 * The exact rulebook version a request is pinned to. `contentDigest` is the
 * lowercase hex SHA-256 of the immutable snapshot bytes reported by the
 * version read; AttestBook recomputes it before a validation run.
 *
 * A pin is not a new AttestBook resource. Credimi stores it next to its own
 * test execution and passes it back on every request, so a later validation
 * can never silently use "the latest version".
 */
export const credimiRulebookPinSchema = z.object({
  kind: z.literal(RULEBOOK_PIN_KIND),
  rulebookId: z.string().min(1),
  version: z.string().min(1),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  specVersion: z.string().min(1),
  attestationType: z.string().min(1),
})

export type CredimiRulebookPin = z.infer<typeof credimiRulebookPinSchema>

/** What the adapter needs to resolve a pin from the authoritative version read. */
export interface PinRulebookInput {
  readonly rulebookId: string
  readonly version: string
  readonly attestationType: string
}

/** One version-pinned credential validation request. */
export interface CredimiValidationInput {
  readonly pin: CredimiRulebookPin
  readonly credential: CredimiCredentialInput
  readonly schemaDocuments?: readonly CredimiSchemaDocumentInput[]
}

/** One version-pinned reproducible conformance run (FR-022). */
export type CredimiConformanceInput = CredimiValidationInput

/** One capture-correlation request; the pin supplies the rulebook and version. */
export interface CredimiCorrelationInput {
  readonly captureId: string
  readonly pin: CredimiRulebookPin
  /**
   * Provider bearer token that owns the recorded correlation. Overrides the
   * client-level token; correlation is a write and always requires one.
   */
  readonly token?: string
}

/** Filters of the rulebook catalogue read. */
export interface CredimiRulebookQuery {
  readonly providerId?: string
  readonly status?: CredimiRulebook['publicationStatus']
  readonly limit?: number
  readonly offset?: number
}

/** Bounds of a capture-evidence page. */
export interface CredimiCaptureQuery {
  readonly limit?: number
  readonly offset?: number
}

interface PinIdentity {
  readonly rulebookId: string
  readonly version: string
  readonly contentDigest: string
}

function pinMismatch(operation: string, field: string, expected: string, actual: string): never {
  throw new CredimiAdapterError(
    'pin_mismatch',
    `The ${operation} used ${field} "${actual}", which does not match the pinned value "${expected}".`,
  )
}

function assertPinIdentity(
  operation: string,
  pin: CredimiRulebookPin,
  evidence: PinIdentity,
): void {
  if (evidence.rulebookId !== pin.rulebookId) {
    pinMismatch(operation, 'rulebook identifier', pin.rulebookId, evidence.rulebookId)
  }
  if (evidence.version !== pin.version) {
    pinMismatch(operation, 'rulebook version', pin.version, evidence.version)
  }
  if (evidence.contentDigest !== pin.contentDigest) {
    pinMismatch(operation, 'snapshot digest', pin.contentDigest, evidence.contentDigest)
  }
}

function assertAttestationType(
  operation: string,
  pin: CredimiRulebookPin,
  attestationType: string,
): void {
  if (attestationType !== pin.attestationType) {
    pinMismatch(operation, 'attestation type', pin.attestationType, attestationType)
  }
}

/**
 * Throws `pin_mismatch` unless the returned validation evidence names exactly
 * the pinned rulebook, version, snapshot digest and attestation type. A
 * refreshed draft version changes its digest, so a stale pin is reported
 * instead of silently validating against different bytes.
 */
export function assertPinnedValidation(
  pin: CredimiRulebookPin,
  evidence: CredimiValidationEvidence,
): void {
  assertPinIdentity('validation', pin, {
    rulebookId: evidence.rulebook.id,
    version: evidence.rulebook.version,
    contentDigest: evidence.rulebook.digest,
  })
  assertAttestationType('validation', pin, evidence.attestation.name)
}

/**
 * Throws `pin_mismatch` unless a reproducible conformance result names exactly
 * the pinned rulebook, version, snapshot digest, specification version and
 * attestation type. The result reference is content-addressed by AttestBook and
 * must be verified by the caller against the evidence it stores.
 */
export function assertPinnedConformance(
  pin: CredimiRulebookPin,
  result: CredimiConformanceResult,
): void {
  assertPinIdentity('conformance run', pin, {
    rulebookId: result.pin.rulebookId,
    version: result.pin.version,
    contentDigest: result.pin.contentDigest,
  })
  if (result.pin.specVersion !== pin.specVersion) {
    pinMismatch('conformance run', 'specification version', pin.specVersion, result.pin.specVersion)
  }
  assertAttestationType('conformance run', pin, result.pin.attestationType)
}

/**
 * Throws `pin_mismatch` unless a capture correlation binds exactly the pinned
 * rulebook version and its validation result carries the same evidence.
 */
export function assertPinnedCorrelation(
  pin: CredimiRulebookPin,
  correlation: CredimiEvidenceCorrelation,
): void {
  assertPinIdentity('capture correlation', pin, {
    rulebookId: correlation.rulebook.rulebookId,
    version: correlation.rulebook.version,
    contentDigest: correlation.rulebook.contentDigest,
  })
  assertAttestationType('capture correlation', pin, correlation.rulebook.attestationType)
  assertPinnedValidation(pin, correlation.validation)
}

/**
 * Throws `pin_mismatch` unless a headless-wallet comparison report names
 * exactly the pinned rulebook, version, snapshot digest and attestation type.
 * The report never carries "the latest version": a stale pin is reported
 * instead of being silently compared against different bytes.
 */
export function assertPinnedComparison(
  pin: CredimiRulebookPin,
  comparison: CredimiHeadlessWalletComparison,
): void {
  assertPinIdentity('headless-wallet comparison', pin, {
    rulebookId: comparison.rulebook.rulebookId,
    version: comparison.rulebook.version,
    contentDigest: comparison.rulebook.contentDigest,
  })
  assertAttestationType('headless-wallet comparison', pin, comparison.rulebook.attestationType)
}
