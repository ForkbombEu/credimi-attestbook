// Headless-wallet comparison evidence builder (FR-021, issue #50).
//
// AttestBook validates a headless-wallet credential capture against one pinned
// rulebook version (FR-019/FR-020). This module turns that exact evidence and
// an optional caller-supplied external wallet observation into one versioned,
// machine-readable report. It separates the AttestBook structural/schema
// results from the external protocol and interoperability observations,
// records every dimension AttestBook cannot execute as unsupported, and never
// derives a PASS from another dimension's success (FR-010, FR-012).
//
// The module performs no I/O, starts no wallet and contacts no Credimi or
// capture endpoint. It is a pure projection over the correlation AttestBook
// already recorded.

import { DIMENSION_DEFINITIONS, type ValidationDimensionId } from '../validation'

import {
  HEADLESS_WALLET_COMPARISON_KIND,
  HEADLESS_WALLET_COMPARISON_VERSION,
  type ComparisonDimensionEntry,
  type ComparisonEvidenceSource,
  type ComparisonResult,
  type ExternalDimensionObservation,
  type ExternalWalletObservation,
  type HeadlessWalletComparisonReport,
  type UnsupportedComparison,
} from './types'

/** The dimensions AttestBook itself executes for a captured credential. */
export const ATTESTBOOK_STRUCTURAL_DIMENSIONS = [
  'credential_parsing',
  'format_recognition',
  'schema_validation',
  'attestation_constraints',
] as const

/** The dimensions only an external observation can report. */
export const EXTERNAL_COMPARISON_DIMENSIONS = [
  'cryptographic_verification',
  'issuer_trust',
  'protocol_conformance',
  'interoperability',
] as const

/** Comparison group of one external dimension. */
export const EXTERNAL_DIMENSION_GROUPS: Readonly<
  Record<(typeof EXTERNAL_COMPARISON_DIMENSIONS)[number], 'trust' | 'protocol' | 'interoperability'>
> = {
  cryptographic_verification: 'trust',
  issuer_trust: 'trust',
  protocol_conformance: 'protocol',
  interoperability: 'interoperability',
}

/** Static limitations every comparison carries. */
export const HEADLESS_WALLET_COMPARISON_LIMITATIONS: readonly string[] = Object.freeze([
  'AttestBook does not start, observe or orchestrate a wallet or a Credimi test execution. The external wallet observation is caller-supplied, recorded verbatim and not verified by AttestBook.',
  'The AttestBook side is structural and schema validation only. A structural PASS is not a cryptographic, issuer-trust, protocol or interoperability conclusion.',
  'The report places the two evidence sources side by side; it is not an interoperability verdict and never upgrades an unexecuted dimension.',
  'An external observation is labelled as external and never changes an AttestBook validation status.',
  'The correlated capture evidence is mock-backed in this build and held in memory for the lifetime of the server process; the comparison is computed on demand and is not persisted.',
])

export interface BuildHeadlessWalletComparisonInput {
  /** The recorded capture correlation and its structural validation result. */
  readonly source: ComparisonEvidenceSource
  /** The caller-supplied external wallet behaviour, when one was supplied. */
  readonly externalWallet: ExternalWalletObservation | null
  /** Clock for the comparison timestamp; injectable for deterministic tests. */
  readonly now?: () => Date
}

function isConclusive(status: string): boolean {
  return status === 'PASS' || status === 'FAIL'
}

function structuralResult(
  attestbook: ComparisonDimensionEntry['attestbook'],
  external: ComparisonDimensionEntry['external'],
): ComparisonResult {
  if (external === null) {
    return attestbook?.executed === true ? 'attestbook_only' : 'not_provided'
  }
  if (attestbook === null || !attestbook.executed) {
    return 'not_comparable'
  }
  if (!isConclusive(attestbook.status) || !isConclusive(external.status)) {
    return 'not_comparable'
  }
  return attestbook.status === external.status ? 'agreement' : 'divergence'
}

function externalResult(external: ComparisonDimensionEntry['external']): ComparisonResult {
  return external === null ? 'not_provided' : 'external_only'
}

function dimensionTitle(dimension: ValidationDimensionId): string {
  return DIMENSION_DEFINITIONS.find((definition) => definition.id === dimension)?.title ?? dimension
}

function unsupportedReason(dimension: ValidationDimensionId, externallyObserved: boolean): string {
  const title = dimensionTitle(dimension)
  return externallyObserved
    ? `AttestBook does not execute the "${title}" dimension. Only the caller-supplied external observation is recorded, and AttestBook does not verify it.`
    : `AttestBook does not execute the "${title}" dimension and no external observation was supplied. The comparison cannot establish it.`
}

/**
 * Builds the comparison report from a recorded capture correlation and an
 * optional external wallet observation. The caller must pass a source with a
 * recorded rulebook binding and validation result; the route refuses an
 * uncorrelated capture before reaching this function.
 */
export function buildHeadlessWalletComparison(
  input: BuildHeadlessWalletComparisonInput,
): HeadlessWalletComparisonReport {
  const { source, externalWallet } = input
  const { rulebook, validation } = source
  const clock = input.now ?? (() => new Date())
  const comparedAt = clock()
  if (Number.isNaN(comparedAt.getTime())) {
    throw new Error('the comparison clock returned an invalid date')
  }

  const validationDimensions = new Map(
    validation.dimensions.map((dimension) => [dimension.id, dimension]),
  )
  const externalDimensions = new Map<ValidationDimensionId, ExternalDimensionObservation>(
    (externalWallet?.observations ?? []).map((observation) => [observation.dimension, observation]),
  )

  const schema: ComparisonDimensionEntry[] = []
  const trust: ComparisonDimensionEntry[] = []
  const protocol: ComparisonDimensionEntry[] = []
  const interoperability: ComparisonDimensionEntry[] = []
  const unsupported: UnsupportedComparison[] = []

  for (const dimension of ATTESTBOOK_STRUCTURAL_DIMENSIONS) {
    const definition = validationDimensions.get(dimension)
    if (definition === undefined) {
      throw new Error(`the validation result is missing the dimension "${dimension}"`)
    }
    const attestbook = {
      status: definition.status,
      applicable: definition.applicable,
      executed: definition.executed,
    }
    const observation = externalDimensions.get(dimension)
    const external =
      observation === undefined
        ? null
        : { status: observation.status, code: observation.code, detail: observation.detail }
    const result = structuralResult(attestbook, external)
    schema.push({ dimension, attestbook, external, result })
    if (result === 'not_provided') {
      unsupported.push({
        dimension,
        code: 'no_evidence_supplied',
        attestbookStatus: definition.status,
        reason: `Neither the AttestBook validation nor an external observation supplied evidence for the "${dimensionTitle(dimension)}" dimension.`,
      })
    } else if (result === 'not_comparable') {
      unsupported.push({
        dimension,
        code: 'not_comparable',
        attestbookStatus: definition.status,
        reason: `The AttestBook and external values for the "${dimensionTitle(dimension)}" dimension are not both conclusive, so they are not compared.`,
      })
    }
  }

  for (const dimension of EXTERNAL_COMPARISON_DIMENSIONS) {
    const observation = externalDimensions.get(dimension)
    const external =
      observation === undefined
        ? null
        : { status: observation.status, code: observation.code, detail: observation.detail }
    const result = externalResult(external)
    const entry: ComparisonDimensionEntry = {
      dimension,
      attestbook: null,
      external,
      result,
    }
    const group = EXTERNAL_DIMENSION_GROUPS[dimension]
    if (group === 'trust') {
      trust.push(entry)
    } else if (group === 'protocol') {
      protocol.push(entry)
    } else {
      interoperability.push(entry)
    }
    unsupported.push({
      dimension,
      code: 'attestbook_does_not_execute',
      attestbookStatus: validationDimensions.get(dimension)?.status ?? null,
      reason: unsupportedReason(dimension, external !== null),
    })
  }

  const limitations = [...HEADLESS_WALLET_COMPARISON_LIMITATIONS]
  if (externalWallet === null) {
    limitations.push(
      'No external wallet observation was supplied, so the protocol and interoperability groups carry explicit gaps instead of results.',
    )
  }

  return {
    kind: HEADLESS_WALLET_COMPARISON_KIND,
    contractVersion: HEADLESS_WALLET_COMPARISON_VERSION,
    comparedAt: comparedAt.toISOString(),
    rulebook,
    capture: {
      captureId: source.captureId,
      correlationId: source.correlationId,
      testExecutionRef: source.testExecutionRef,
      sourceComponent: source.sourceComponent,
      protocol: source.protocol,
      credentialFormat: source.credentialFormat,
    },
    attestbook: {
      validationId: validation.validationId,
      validatedAt: validation.validatedAt,
      overallStatus: validation.overallStatus,
      credential: validation.credential,
      schemaReferences: validation.schemaReferences,
      violations: validation.violations,
      limitations: validation.limitations,
    },
    externalWallet,
    comparison: { schema, protocol, interoperability, trust, unsupported },
    nonClaims: {
      externalObservationVerified: false,
      cryptographicVerification: false,
      issuerTrust: false,
      protocolConformance: false,
      interoperability: false,
    },
    limitations,
  }
}
