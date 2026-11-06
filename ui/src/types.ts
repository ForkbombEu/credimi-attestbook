// Wire types of the public product API that the catalog consumes (issue #36).
//
// These mirror the stable response fields of src/api/schemas.ts. The UI only
// reads the public projection: provider, rulebook, attestation, schema
// reference and version metadata. It never receives registry-internal
// provenance, metadata or tokens.

export type PublicationStatus = 'draft' | 'published' | 'historical'

export interface Provider {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

export interface Rulebook {
  readonly id: string
  readonly providerId: string
  readonly name: string
  readonly description: string
  readonly sourceUrl: string | null
  readonly applicableSpec: string
  readonly publicationStatus: PublicationStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SchemaReference {
  readonly id: string
  readonly rulebookId: string
  /** Attestation type this reference belongs to; `null` for rulebook-level. */
  readonly attestationId: string | null
  readonly formatIdentifier: string
  readonly uri: string
  /** W3C SRI value such as `sha256-...`, when the source carries one. */
  readonly integrity: string | null
  readonly createdAt: string
}

export interface Attestation {
  readonly id: string
  readonly rulebookId: string
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly schemaReferences: readonly SchemaReference[]
  readonly createdAt: string
}

export interface RulebookVersion {
  readonly id: string
  readonly rulebookId: string
  readonly version: string
  readonly status: PublicationStatus
  readonly contentDigest: string
  readonly specVersion: string
  readonly createdAt: string
  readonly publishedAt: string | null
}

export interface Pagination {
  readonly limit: number
  readonly offset: number
  readonly total: number
}

export interface RulebookPage {
  readonly data: readonly Rulebook[]
  readonly pagination: Pagination
}

// -------------------------------------------------- credential validation
//
// Wire types of the public `POST /api/v1/credentials/validate` response
// (issues #32/#33). They mirror `src/api/schemas.ts`: the result carries
// non-sensitive credential facts, the eight FR-010 dimensions with their
// applicability/execution flags, flattened violations and explicit
// limitations. Claim values and the raw credential artifact are never part of
// this response.

export type ValidationStatus = 'PASS' | 'FAIL' | 'NOT_TESTED' | 'NOT_APPLICABLE' | 'INCONCLUSIVE'

export type ValidationDimensionId =
  | 'credential_parsing'
  | 'format_recognition'
  | 'cryptographic_verification'
  | 'schema_validation'
  | 'attestation_constraints'
  | 'issuer_trust'
  | 'protocol_conformance'
  | 'interoperability'

export type ValidationSeverity = 'error' | 'warning' | 'info'

export interface ValidationFinding {
  readonly code: string
  readonly message: string
  readonly severity: ValidationSeverity
  readonly dimension: ValidationDimensionId
  /** JSON Pointer into the credential claims, when the finding has a location. */
  readonly path?: string
  /** Expected constraint, never a raw claim value. */
  readonly expected?: string
}

export type ValidationEvidenceValue = string | number | boolean | null

export interface ValidationDimensionEvidence {
  readonly scope: string
  readonly reason: string
  readonly details: Readonly<Record<string, ValidationEvidenceValue>>
}

export interface ValidationDimension {
  readonly id: ValidationDimensionId
  readonly status: ValidationStatus
  readonly applicable: boolean
  readonly executed: boolean
  readonly findings: readonly ValidationFinding[]
  readonly evidence: ValidationDimensionEvidence
}

export interface ValidationLimitation {
  readonly code: string
  readonly dimension: ValidationDimensionId
  readonly status: ValidationStatus
  readonly message: string
}

export interface CredentialValidationResult {
  readonly validationId: string
  readonly validatedAt: string
  readonly rulebook: {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly digest: string
    readonly digestVerified: true
    readonly specVersion: string
    readonly status: PublicationStatus
  }
  readonly attestation: {
    readonly name: string
    readonly attestationLoS: string
    readonly bindingType: string
    readonly supportedFormats: readonly string[]
  }
  readonly credential: {
    readonly format: string | null
    readonly vct: string | null
    readonly disclosureCount: number
    readonly keyBindingPresent: boolean
  }
  readonly schemaReferences: readonly {
    readonly formatIdentifier: string
    readonly uri: string
    readonly integrity: string | null
    readonly kind: 'type_metadata' | 'json_schema' | null
    readonly applied: boolean
  }[]
  readonly dimensions: readonly ValidationDimension[]
  readonly violations: readonly ValidationFinding[]
  readonly limitations: readonly ValidationLimitation[]
  readonly overallStatus: ValidationStatus
}

/** Credential formats a caller can hint explicitly; the API auto-detects by default. */
export type CredentialFormatHint =
  'dc+sd-jwt' | 'mso_mdoc' | 'jwt_vc_json' | 'jwt_vc_json-ld' | 'ldp_vc'

/** Typed request for `POST /api/v1/credentials/validate`. */
export interface ValidateCredentialRequest {
  readonly rulebookId: string
  readonly rulebookVersion: string
  readonly attestationType: string
  readonly credential: string | { readonly format: CredentialFormatHint; readonly value: string }
}
