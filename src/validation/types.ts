// Public contracts for credential structural validation (issue #32).
//
// The engine in this module validates a real SD-JWT VC artifact against one
// pinned rulebook version and returns machine-readable evidence. It separates
// the dimensions of FR-010: only structural and attestation-constraint checks
// are executed here, and everything else is reported explicitly as NOT_TESTED
// or NOT_APPLICABLE. A structural PASS never implies cryptographic, trust,
// protocol or interoperability success (FR-012, D-8, D-17).

import type { Rulebook, RulebookVersion, RulebookVersionContent } from '../registry/types'
import type { RulebookVersionSchemaReference } from '../registry/versioning'

/** FR-012 validation status. */
export const VALIDATION_STATUSES = [
  'PASS',
  'FAIL',
  'NOT_TESTED',
  'NOT_APPLICABLE',
  'INCONCLUSIVE',
] as const

export type ValidationStatus = (typeof VALIDATION_STATUSES)[number]

/** FR-010 validation dimensions, in normative order. */
export const VALIDATION_DIMENSIONS = [
  'credential_parsing',
  'format_recognition',
  'cryptographic_verification',
  'schema_validation',
  'attestation_constraints',
  'issuer_trust',
  'protocol_conformance',
  'interoperability',
] as const

export type ValidationDimensionId = (typeof VALIDATION_DIMENSIONS)[number]

export const VALIDATION_SEVERITIES = ['error', 'warning', 'info'] as const
export type ValidationSeverity = (typeof VALIDATION_SEVERITIES)[number]

/**
 * One machine-readable finding. `path` is a JSON Pointer into the credential
 * claims; type-metadata array elements use `*` as the wildcard segment because
 * JSON Pointer has no array wildcard. Messages and expected constraints never
 * contain raw claim values.
 */
export interface ValidationFinding {
  readonly code: string
  readonly message: string
  readonly severity: ValidationSeverity
  readonly dimension: ValidationDimensionId
  readonly path?: string
  readonly expected?: string
}

/** One FR-010 dimension with its own status and findings. */
export interface ValidationDimension {
  readonly id: ValidationDimensionId
  readonly status: ValidationStatus
  readonly findings: readonly ValidationFinding[]
}

/** The rulebook version the run was pinned to. */
export interface RulebookEvidence {
  readonly id: string
  readonly name: string
  readonly version: string
  /** Lowercase hex SHA-256 recomputed over the stored snapshot bytes. */
  readonly digest: string
  /** Always `true` in a returned result; a mismatch aborts the run. */
  readonly digestVerified: true
  readonly specVersion: string
  readonly status: RulebookVersion['status']
}

/** The selected attestation type from the pinned snapshot. */
export interface AttestationEvidence {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
}

/** Non-sensitive credential facts. Claim values and raw artifacts are never returned. */
export interface CredentialEvidence {
  readonly format: string | null
  readonly vct: string | null
  readonly disclosureCount: number
  readonly keyBindingPresent: boolean
}

/** One schema reference from the pinned snapshot and whether it was applied. */
export interface SchemaReferenceEvidence {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity: string | null
  readonly kind: 'type_metadata' | 'json_schema' | null
  readonly applied: boolean
}

/** The complete typed validation result. */
export interface CredentialValidationResult {
  readonly validationId: string
  readonly validatedAt: string
  readonly rulebook: RulebookEvidence
  readonly attestation: AttestationEvidence
  readonly credential: CredentialEvidence
  readonly schemaReferences: readonly SchemaReferenceEvidence[]
  readonly dimensions: readonly ValidationDimension[]
  /** Findings with an `error` or `warning` severity, flattened for clients. */
  readonly violations: readonly ValidationFinding[]
  readonly overallStatus: ValidationStatus
}

/** A credential artifact as a bare string or with an explicit format hint. */
export type CredentialArtifactInput =
  | string
  | {
      readonly format?: string
      readonly value: string
    }

/**
 * A schema document supplied by the caller for a reference in the pinned
 * rulebook version. `content` is the exact UTF-8 text so an `#integrity` value
 * from the rulebook can be verified over the transferred bytes.
 */
export interface SchemaDocumentInput {
  readonly uri: string
  readonly content: string
}

/** Typed request for `POST /api/credentials/validate`. */
export interface ValidateCredentialInput {
  readonly rulebookId: string
  readonly rulebookVersion: string
  readonly attestationType: string
  readonly credential: CredentialArtifactInput
  readonly schemaDocuments?: readonly SchemaDocumentInput[]
}

/**
 * The pinned rulebook reads the validator needs. `Registry` satisfies this
 * interface structurally; tests may provide a read-only fake.
 */
export interface RulebookValidationSource {
  getRulebook(id: string): Rulebook | null
  getRulebookVersion(rulebookId: string, version: string): RulebookVersion | null
  getRulebookVersionContent(rulebookId: string, version: string): RulebookVersionContent | null
}

/** A schema reference as carried by the pinned snapshot. */
export type SnapshotSchemaReference = RulebookVersionSchemaReference
