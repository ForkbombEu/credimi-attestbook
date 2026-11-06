// FR-010 dimension catalogue and status-semantics invariants (issue #33).
//
// The catalogue states, for every dimension, who is authoritative for its
// result, whether this build executes it and whether a standalone credential
// validation request requires it. `createDimension` refuses combinations of
// status, applicability and execution that would overstate the result, so an
// unexecuted dimension can never be reported as PASS by construction.

import {
  VALIDATION_DIMENSIONS,
  type ValidationDimension,
  type ValidationDimensionEvidence,
  type ValidationDimensionId,
  type ValidationFinding,
  type ValidationLimitation,
  type ValidationStatus,
} from './types'

/** How this build obtains a result for a dimension. */
export type DimensionOwner = 'attestbook' | 'external'

/**
 * Whether a standalone credential validation request requires the dimension.
 * `conditional` means required only when the request and rulebook provide the
 * inputs the dimension needs (for example a schema reference and a supplied
 * schema document).
 */
export type DimensionApplicability = 'required' | 'conditional' | 'not_applicable'

/** One row of the FR-010 dimension applicability table. */
export interface DimensionDefinition {
  readonly id: ValidationDimensionId
  /** 1-based position in the normative FR-010 order. */
  readonly position: number
  readonly title: string
  /** Who is authoritative for the dimension's evidence. */
  readonly owner: DimensionOwner
  /** Whether this build implements and executes the dimension. */
  readonly implemented: boolean
  /** Applicability to a standalone `POST /api/credentials/validate` request. */
  readonly applicability: DimensionApplicability
  /** What a real execution of the dimension would evaluate. */
  readonly scope: string
}

/**
 * The exhaustive applicability table for the eight FR-010 dimensions. When a
 * required dimension is not implemented, it is reported `NOT_TESTED` (never
 * `NOT_APPLICABLE` and never `PASS`). Protocol conformance and interoperability
 * are request-scoped `NOT_APPLICABLE`: a single credential artifact contains no
 * issuer/verifier protocol interaction to execute (D-8, D-17).
 */
export const DIMENSION_DEFINITIONS: readonly DimensionDefinition[] = [
  {
    id: 'credential_parsing',
    position: 1,
    title: 'Credential parsing',
    owner: 'attestbook',
    implemented: true,
    applicability: 'conditional',
    scope:
      'Parse the credential with the format parser and verify the disclosure structure when a parser exists for the recognised format.',
  },
  {
    id: 'format_recognition',
    position: 2,
    title: 'Credential format recognition',
    owner: 'attestbook',
    implemented: true,
    applicability: 'required',
    scope: 'Recognise the credential format from the artifact or an explicit caller hint.',
  },
  {
    id: 'cryptographic_verification',
    position: 3,
    title: 'Cryptographic verification',
    owner: 'external',
    implemented: false,
    applicability: 'required',
    scope:
      'Verify issuer JWS signatures, key-binding (KB-JWT) proofs and status-list tokens with a real cryptographic library and issuer keys.',
  },
  {
    id: 'schema_validation',
    position: 4,
    title: 'Schema validation',
    owner: 'attestbook',
    implemented: true,
    applicability: 'conditional',
    scope:
      'Apply the pinned rulebook schema documents (SD-JWT VC Type Metadata or JSON Schema 2020-12) to the parsed claims.',
  },
  {
    id: 'attestation_constraints',
    position: 5,
    title: 'Attestation-specific constraints',
    owner: 'attestbook',
    implemented: true,
    applicability: 'required',
    scope:
      'Check format support, TS11 vocabulary and issuer-signed key-binding claims against the pinned rulebook version.',
  },
  {
    id: 'issuer_trust',
    position: 6,
    title: 'Issuer and trust-policy validation',
    owner: 'external',
    implemented: false,
    applicability: 'required',
    scope:
      'Resolve the credential issuer against configured trust anchors and evaluate the applicable trust and revocation policy.',
  },
  {
    id: 'protocol_conformance',
    position: 7,
    title: 'Protocol conformance',
    owner: 'external',
    implemented: false,
    applicability: 'not_applicable',
    scope:
      'Execute an OpenID4VCI or OpenID4VP protocol interaction against a real issuer or verifier endpoint.',
  },
  {
    id: 'interoperability',
    position: 8,
    title: 'End-to-end interoperability',
    owner: 'external',
    implemented: false,
    applicability: 'not_applicable',
    scope:
      'Execute the credential with external wallets and verifiers and compare the observed behaviour.',
  },
]

const DEFINITIONS_BY_ID = new Map<ValidationDimensionId, DimensionDefinition>(
  DIMENSION_DEFINITIONS.map((definition) => [definition.id, definition]),
)

export function dimensionDefinition(id: ValidationDimensionId): DimensionDefinition {
  const definition = DEFINITIONS_BY_ID.get(id)
  if (definition === undefined) {
    throw new Error(`no FR-010 definition for validation dimension "${id}"`)
  }
  return definition
}

/** Raised when a dimension's status contradicts its applicability or execution. */
export class DimensionConsistencyError extends Error {
  constructor(dimension: ValidationDimensionId, reason: string) {
    super(`inconsistent dimension outcome for "${dimension}": ${reason}`)
    this.name = 'DimensionConsistencyError'
  }
}

/**
 * Rejects every combination that would overstate a result:
 *
 * - `PASS` requires an applicable, executed dimension with no error or warning;
 * - `FAIL` requires an applicable, executed dimension with an error;
 * - `NOT_TESTED` requires an applicable dimension that did not execute;
 * - `INCONCLUSIVE` requires an applicable, executed dimension with a warning
 *   and no error;
 * - `NOT_APPLICABLE` requires a non-applicable, unexecuted dimension with
 *   informational findings only.
 *
 * Every non-`PASS`/`FAIL` dimension must also carry at least one finding so
 * `limitations` always explains itself.
 */
export function assertDimensionConsistency(dimension: ValidationDimension): void {
  const { id, status, applicable, executed, findings, evidence } = dimension
  const errors = findings.filter((finding) => finding.severity === 'error')
  const warnings = findings.filter((finding) => finding.severity === 'warning')
  const fail = (reason: string): never => {
    throw new DimensionConsistencyError(id, reason)
  }

  if (evidence.scope.trim() === '' || evidence.reason.trim() === '') {
    fail('evidence scope and reason must be non-empty')
  }
  if (findings.some((finding) => finding.dimension !== id)) {
    fail('a finding belongs to a different dimension')
  }

  switch (status) {
    case 'PASS':
      if (!applicable || !executed) {
        fail('PASS requires an applicable dimension that actually executed')
      }
      if (errors.length > 0 || warnings.length > 0) {
        fail('PASS requires findings with neither error nor warning severity')
      }
      break
    case 'FAIL':
      if (!applicable || !executed) {
        fail('FAIL requires an applicable dimension that actually executed')
      }
      if (errors.length === 0) {
        fail('FAIL requires at least one error finding')
      }
      break
    case 'NOT_TESTED':
      if (!applicable) {
        fail('NOT_TESTED requires an applicable dimension')
      }
      if (executed) {
        fail('NOT_TESTED requires an unexecuted dimension')
      }
      if (errors.length > 0) {
        fail('NOT_TESTED cannot carry an error finding')
      }
      if (findings.length === 0) {
        fail('NOT_TESTED requires at least one finding explaining what was not tested')
      }
      break
    case 'INCONCLUSIVE':
      if (!applicable || !executed) {
        fail('INCONCLUSIVE requires an applicable dimension that actually executed')
      }
      if (errors.length > 0) {
        fail('INCONCLUSIVE cannot carry an error finding; use FAIL')
      }
      if (warnings.length === 0) {
        fail('INCONCLUSIVE requires at least one warning finding')
      }
      break
    case 'NOT_APPLICABLE':
      if (applicable) {
        fail('NOT_APPLICABLE requires a non-applicable dimension')
      }
      if (executed) {
        fail('NOT_APPLICABLE requires an unexecuted dimension')
      }
      if (errors.length > 0 || warnings.length > 0) {
        fail('NOT_APPLICABLE cannot carry an error or warning finding')
      }
      if (findings.length === 0) {
        fail('NOT_APPLICABLE requires at least one finding explaining why it does not apply')
      }
      break
    default: {
      const exhaustive: never = status
      throw new Error(`unhandled validation status ${String(exhaustive)}`)
    }
  }
}

export interface DimensionInput {
  readonly id: ValidationDimensionId
  readonly status: ValidationStatus
  readonly applicable: boolean
  readonly executed: boolean
  readonly findings?: readonly ValidationFinding[]
  readonly evidence: ValidationDimensionEvidence
}

/**
 * Builds a dimension and enforces the status-semantics invariants. The engine
 * uses this for every reported dimension, so an invalid outcome fails closed
 * instead of being returned to a caller.
 */
export function createDimension(input: DimensionInput): ValidationDimension {
  const dimension: ValidationDimension = {
    id: input.id,
    status: input.status,
    applicable: input.applicable,
    executed: input.executed,
    findings: input.findings ?? [],
    evidence: input.evidence,
  }
  assertDimensionConsistency(dimension)
  return dimension
}

/**
 * Derives the explicit limitation list from every dimension that did not
 * execute to a conclusion. `PASS` and `FAIL` dimensions are conclusions; the
 * findings of `NOT_TESTED`, `INCONCLUSIVE` and `NOT_APPLICABLE` dimensions are
 * exactly the unverified claims a caller must see.
 */
export function limitationsFromDimensions(
  dimensions: readonly ValidationDimension[],
): readonly ValidationLimitation[] {
  return dimensions
    .filter((dimension) => dimension.status !== 'PASS' && dimension.status !== 'FAIL')
    .flatMap((dimension) =>
      dimension.findings.map((finding) => ({
        code: finding.code,
        dimension: dimension.id,
        status: dimension.status,
        message: finding.message,
      })),
    )
}

/**
 * Fails closed when the catalogue stops matching the normative FR-010 order or
 * has a duplicate/missing definition.
 */
export function assertDimensionCatalogue(
  definitions: readonly DimensionDefinition[] = DIMENSION_DEFINITIONS,
): void {
  if (definitions.length !== VALIDATION_DIMENSIONS.length) {
    throw new Error(
      `the FR-010 catalogue has ${definitions.length} definitions for ${VALIDATION_DIMENSIONS.length} dimensions`,
    )
  }
  definitions.forEach((definition, index) => {
    const expected = VALIDATION_DIMENSIONS[index]
    if (definition.id !== expected) {
      throw new Error(
        `the FR-010 catalogue is out of order at position ${index + 1}: expected "${expected ?? 'none'}", found "${definition.id}"`,
      )
    }
    if (definition.position !== index + 1) {
      throw new Error(`dimension "${definition.id}" has a non-normative position`)
    }
  })
}

assertDimensionCatalogue()
