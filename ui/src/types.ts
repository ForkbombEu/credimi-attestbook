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
  /**
   * The stored AttestBook document this exact URI names (#103). `null` or
   * absent means the reference is external; the public API derives this from
   * the immutable store and never from a URL prefix.
   */
  readonly hostedSchema?: HostedSchema | null
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

/**
 * One reference frozen in an exact rulebook version snapshot (#103). The
 * persisted members are unchanged; `hostedSchema` is the public, derived
 * association with a stored immutable AttestBook document.
 */
export interface VersionSchemaReference {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity: string | null
  readonly hostedSchema?: HostedSchema | null
}

/** Public inspection of one exact version's frozen schema references (#103). */
export interface VersionSchemaReferences {
  readonly version: string
  readonly contentDigest: string
  readonly status: PublicationStatus
  readonly publishedAt: string | null
  readonly attestations: readonly {
    readonly name: string
    readonly schemaReferences: readonly VersionSchemaReference[]
  }[]
  readonly schemaReferences: readonly VersionSchemaReference[]
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

// ---------------------------------- version comparison and publication readiness
//
// Wire types of the version lifecycle endpoints (issue #41). They mirror the
// public projections in `src/api/schemas.ts`; both reads are public and carry
// no registry-internal metadata.

/** A JSON value inside a version snapshot. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export type VersionDiffChangeKind = 'added' | 'removed' | 'changed'

export interface VersionDiffChange {
  /** JSON Pointer into the comparable content of a snapshot. */
  readonly path: string
  readonly kind: VersionDiffChangeKind
  readonly before?: JsonValue
  readonly after?: JsonValue
}

export interface VersionDiff {
  readonly from: RulebookVersion
  readonly to: RulebookVersion
  readonly identical: boolean
  readonly changes: readonly VersionDiffChange[]
  readonly summary: {
    readonly added: number
    readonly removed: number
    readonly changed: number
  }
}

export type PublicationReadinessCheckStatus = 'pass' | 'fail' | 'warn' | 'not_applicable'

export type PublicationReadinessCheckId =
  | 'draft_version'
  | 'rulebook_status'
  | 'snapshot_integrity'
  | 'snapshot_current'
  | 'content_valid'
  | 'standards_profile'
  | 'attestation_types'

export interface PublicationReadinessCheck {
  readonly id: PublicationReadinessCheckId
  readonly status: PublicationReadinessCheckStatus
  readonly message: string
}

export interface PublicationReadiness {
  readonly version: RulebookVersion
  readonly ready: boolean
  readonly checks: readonly PublicationReadinessCheck[]
  readonly limitations: readonly string[]
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

// ------------------------------------------------------ rulebook draft editor
//
// Wire types of the draft editor API (issue #40). They mirror the public
// projections in `src/api/schemas.ts`: the draft document carries the working
// copy only, never registry-internal provenance, metadata or tokens.

export interface DraftSchemaReference {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity: string | null
  /** Stored-document association of this exact URI, when the API resolved one. */
  readonly hostedSchema?: HostedSchema | null
}

export interface DraftAttestation {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly schemaReferences: readonly DraftSchemaReference[]
}

export interface DraftRulebook {
  readonly id: string
  readonly providerId: string
  readonly name: string
  readonly description: string
  readonly sourceUrl: string | null
  readonly applicableSpec: string
  readonly publicationStatus: PublicationStatus
  readonly attestations: readonly DraftAttestation[]
  readonly schemaReferences: readonly DraftSchemaReference[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** The part of the draft edited as JSON: attestation types and references. */
export interface DraftContentDocument {
  readonly attestations: readonly DraftAttestation[]
  readonly schemaReferences: readonly DraftSchemaReference[]
}

export interface DraftSchemaReferenceInput {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity?: string
}

export interface DraftAttestationInput {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats?: readonly string[]
  readonly schemaReferences?: readonly DraftSchemaReferenceInput[]
}

/** Full draft document submitted to create, replace or validate. */
export interface SaveDraftRequest {
  readonly name: string
  readonly description?: string
  readonly sourceUrl?: string | null
  readonly applicableSpec: string
  readonly attestations?: readonly DraftAttestationInput[]
  readonly schemaReferences?: readonly DraftSchemaReferenceInput[]
}

/** Profiles the schema registration API accepts (`?kind=`). */
export type CredentialSchemaKind = 'json_schema_2020_12' | 'sd_jwt_vc_type_metadata'

/**
 * Public metadata of one immutable AttestBook-hosted credential schema
 * document, as returned by `POST /api/v1/schema-documents` (issues #99/#100).
 * `url` and `integrity` are ordinary `schemaReferences[].uri` and `integrity`
 * values; no proprietary field is added to the draft representation.
 */
export interface CredentialSchemaDocument {
  readonly id: string
  readonly kind: CredentialSchemaKind
  readonly mediaType: 'application/schema+json' | 'application/json'
  readonly contentDigest: string
  /** W3C SRI pin such as `sha256-<base64>`. */
  readonly integrity: string
  /** Canonical permanent AttestBook URL of the exact bytes. */
  readonly url: string
  readonly createdAt: string
}

/**
 * Public provenance of a stored document attached to a schema reference
 * (#103). It has the same public shape as the registration response; provider
 * ownership and registration provenance are never included.
 */
export type HostedSchema = CredentialSchemaDocument

export type DraftDiagnosticSeverity = 'error' | 'warning'

export interface DraftDiagnostic {
  readonly severity: DraftDiagnosticSeverity
  readonly code: string
  readonly message: string
  readonly path?: string
}

export interface DraftValidationReport {
  readonly valid: boolean
  /** Whether structural rules allow a save; standards warnings/errors do not block it. */
  readonly saveable: boolean
  readonly profile: 'ts11@1.0.1' | 'owf@0.5.4' | null
  readonly diagnostics: readonly DraftDiagnostic[]
  readonly limitations: readonly string[]
}

// ------------------------------------------------- capture explorer (#48)
//
// Wire types of the mock-backed capture explorer API. They mirror the public
// projections in `src/api/schemas.ts`: a capture is normalized evidence with
// its correlation identifiers, the declared redaction, the exact pinned
// rulebook version a validation ran against and explicit evidence gaps. An
// inline artifact is represented only by the redacted default-policy
// projection; the raw artifact never reaches the browser.

export type CaptureSourceComponent = 'capture-issuer' | 'capture-verifier'

export type CaptureProtocol = 'openid4vci' | 'openid4vp'

export type CaptureCredentialFormat =
  'dc+sd-jwt' | 'mso_mdoc' | 'jwt_vc_json' | 'jwt_vc_json-ld' | 'ldp_vc'

export type CaptureInteractionType = 'issuance' | 'presentation' | 'error'

export type CaptureArtifactType =
  | 'issuer-metadata'
  | 'credential-offer'
  | 'issued-credential'
  | 'presentation-request'
  | 'presentation-submission'
  | 'verification-outcome'
  | 'error-response'

export type CaptureRedactionStatus = 'none' | 'partial' | 'full'

export type CaptureEvidenceGapCode =
  | 'external_artifact_not_fetched'
  | 'artifact_redacted_by_source'
  | 'no_test_execution_reference'
  | 'no_rulebook_binding'
  | 'validation_not_run'
  | 'validation_not_applicable'

export type CaptureTimelineEventKind = 'captured' | 'received' | 'bound' | 'validated'

export interface CaptureSourceSummary {
  readonly sourceId: string
  readonly component: CaptureSourceComponent
  readonly transport: 'mock'
  readonly description: string
}

export interface CaptureProvenanceSummary {
  readonly sourceComponent: CaptureSourceComponent
  readonly sourceVersion: string | null
  readonly capturedAt: string
  readonly capturedAtMs: number
  readonly receivedAt: string
  readonly receivedAtMs: number
}

export interface CaptureParty {
  readonly role: 'issuer' | 'verifier'
  readonly identifier: string
  readonly name: string | null
}

export interface CaptureIntegrity {
  readonly algorithm: 'sha256'
  readonly digest: string
  readonly verified: boolean
}

export interface CaptureRedaction {
  readonly status: CaptureRedactionStatus
  readonly policyRef: string | null
  readonly redactedPaths: readonly string[]
  readonly redactedDigest: string | null
}

export interface CaptureArtifactSummary {
  readonly availability: 'inline' | 'external'
  readonly mediaType: string
  readonly byteLength: number | null
  readonly uri: string | null
}

export interface CaptureRulebookBinding {
  readonly rulebookId: string
  readonly rulebookName: string
  readonly version: string
  readonly contentDigest: string
  readonly digestVerified: true
  readonly specVersion: string
  readonly rulebookStatus: PublicationStatus
  readonly attestationType: string
  readonly boundAt: string
}

export interface CaptureValidationDimensionSummary {
  readonly id: ValidationDimensionId
  readonly status: ValidationStatus
  readonly applicable: boolean
  readonly executed: boolean
}

export interface CaptureValidationSummary {
  readonly validationId: string
  readonly validatedAt: string
  readonly overallStatus: ValidationStatus
  readonly violations: number
  readonly limitations: number
  readonly dimensions: readonly CaptureValidationDimensionSummary[]
}

export interface CaptureEvidenceGap {
  readonly code: CaptureEvidenceGapCode
  readonly message: string
}

export interface CaptureExplorerSummary {
  readonly captureId: string
  readonly correlationId: string
  readonly kind: 'attestbook.capture-artifact@1'
  readonly envelopeVersion: 1
  readonly source: CaptureSourceSummary
  readonly provenance: CaptureProvenanceSummary
  readonly interactionType: CaptureInteractionType
  readonly protocol: CaptureProtocol
  readonly credentialFormat: CaptureCredentialFormat
  readonly artifactType: CaptureArtifactType
  readonly party: CaptureParty | null
  readonly testExecutionRef: string | null
  readonly integrity: CaptureIntegrity
  readonly declaredRedaction: CaptureRedaction
  readonly artifact: CaptureArtifactSummary
  readonly rulebook: CaptureRulebookBinding | null
  readonly validation: CaptureValidationSummary | null
  readonly evidenceGaps: readonly CaptureEvidenceGap[]
  readonly evidenceComplete: boolean
}

export interface CaptureArtifactProjection {
  readonly mediaType: string
  readonly encoding: 'utf8' | 'base64'
  readonly byteLength: number
  readonly digest: string
  readonly redaction: CaptureRedaction
  /** Parsed redacted JSON document, or `null` for an opaque artifact. */
  readonly document: unknown
  readonly diagnostics: readonly {
    readonly code: string
    readonly message: string
    readonly path?: string
  }[]
}

export interface CaptureTimelineEvent {
  readonly kind: CaptureTimelineEventKind
  readonly at: string
  readonly label: string
  readonly detail: string
}

export interface CaptureExplorerDetail extends CaptureExplorerSummary {
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>
  readonly artifactProjection: CaptureArtifactProjection | null
  readonly validationResult: CredentialValidationResult | null
  readonly timeline: readonly CaptureTimelineEvent[]
  readonly limitations: readonly string[]
}

export interface CaptureExplorerPage {
  readonly data: readonly CaptureExplorerSummary[]
  readonly pagination: Pagination
}

export interface CorrelateCaptureRequest {
  readonly rulebookId: string
  readonly rulebookVersion: string
  readonly attestationType: string
}

export interface CaptureCorrelationResult {
  readonly captureId: string
  readonly correlationId: string
  readonly testExecutionRef: string | null
  readonly rulebook: CaptureRulebookBinding
  readonly validation: CredentialValidationResult
}
