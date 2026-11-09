// Public contracts for rulebook-driven verifier constraints (FR-014, issue #45).
//
// A verifier reads the attribute and format constraints of one pinned rulebook
// version and gets the verifier-policy interfaces AttestBook can map them to.
// The result is a *constraint and mapping description*: it is not an
// OpenID4VP authorization request, it carries no proof or protocol result, and
// every mapping this slice cannot express is reported instead of guessed.

import type { Rulebook, RulebookVersion, RulebookVersionContent } from '../registry/types'
import type { SchemaDocumentInput } from '../validation/types'

/** Format marker carried by every verifier-constraint result. */
export const VERIFIER_CONSTRAINTS_KIND = 'attestbook.verifier-constraints@1'

/** Versioned product-API path for verifier constraint resolution. */
export const VERIFIER_CONSTRAINTS_PATH = '/api/v1/verifiers/constraints'

/** Verifier-policy interfaces AttestBook knows about in this slice. */
export const VERIFIER_POLICY_INTERFACES = [
  'attestbook.attribute-constraints@1',
  'openid4vp.dcql@1',
  'openid4vp.presentation-exchange@1',
] as const

export type VerifierPolicyInterfaceId = (typeof VERIFIER_POLICY_INTERFACES)[number]

/** Whether AttestBook can map rulebook constraints to one interface. */
export const VERIFIER_POLICY_INTERFACE_STATUSES = ['supported', 'partial', 'unsupported'] as const
export type VerifierPolicyInterfaceStatus = (typeof VERIFIER_POLICY_INTERFACE_STATUSES)[number]

/** How much of a format's attribute grounding was verified. */
export const VERIFIER_GROUNDING_STATUSES = [
  'verified',
  'partially_verified',
  'not_supplied',
  'not_grounded',
] as const
export type VerifierGroundingStatus = (typeof VERIFIER_GROUNDING_STATUSES)[number]

/** Where an explicitly unsupported mapping applies. */
export const VERIFIER_MAPPING_SCOPES = [
  'format',
  'type_identifier',
  'claim',
  'constraint',
  'trust',
  'proof',
  'protocol',
  'interface',
] as const
export type VerifierMappingScope = (typeof VERIFIER_MAPPING_SCOPES)[number]

/** The pinned rulebook version the constraints were read from. */
export interface VerifierRulebookEvidence {
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
export interface VerifierAttestationEvidence {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
}

/** One rulebook schema reference and whether it grounded constraints. */
export interface VerifierSchemaReferenceEvidence {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity: string | null
  /** Whether the supplied bytes matched the reference's sha256 SRI value. */
  readonly integrityVerified: boolean
  readonly kind: 'json_schema' | 'type_metadata' | null
  /** Whether the document's attribute constraints were inspected. */
  readonly inspected: boolean
  readonly diagnostic?: string
}

/** A JSON Schema keyword this slice does not resolve into typed constraints. */
export interface VerifierUnsupportedConstraint {
  readonly keyword: string
  readonly reason: string
}

/** One typed attribute constraint of the selected attestation type. */
export interface VerifierAttributeConstraint {
  /** JSON Pointer into the schema; array elements use the `*` wildcard. */
  readonly pointer: string
  readonly name: string
  readonly required: boolean
  readonly types: readonly string[]
  /** Extracted JSON Schema keyword values, for example `maxLength` or `enum`. */
  readonly constraints: Readonly<Record<string, unknown>>
  /** Constraint keywords present but not resolved into typed constraints. */
  readonly unsupportedConstraints: readonly VerifierUnsupportedConstraint[]
  /** Rulebook schema-reference URIs that declare this attribute. */
  readonly sources: readonly string[]
  /**
   * The DCQL claim path this attribute maps to, when it is derivable. Array
   * elements use `null`, as OpenID4VP DCQL does; the path is not a JSON Pointer.
   */
  readonly claimPath: readonly (string | number | null)[]
  /** Whether `claimPath` can be used as a DCQL claim path. */
  readonly claimPathSupported: boolean
}

/** A mapping this slice cannot express for one interface. */
export interface VerifierUnsupportedMapping {
  readonly code: string
  readonly scope: VerifierMappingScope
  /** Affected attribute or object JSON Pointer, when one applies. */
  readonly path?: string
  /** The JSON Schema keyword, when the limitation concerns one. */
  readonly keyword?: string
  readonly reason: string
}

/** A safe, machine-readable finding about constraint resolution. */
export interface VerifierPolicyDiagnostic {
  readonly code: string
  readonly message: string
  /** Affected attribute or object JSON Pointer, when one applies. */
  readonly path?: string
}

/** The partial OpenID4VP DCQL mapping of one credential format. */
export interface VerifierDcqlMapping {
  readonly interfaceId: 'openid4vp.dcql@1'
  /**
   * Always `false`: a DCQL credential query emitted here is a mapping fragment,
   * never a complete OpenID4VP authorization request.
   */
  readonly complete: false
  /** The request fragment, or `null` when the format is not DCQL-mappable. */
  readonly credentialQuery: Readonly<Record<string, unknown>> | null
  /** Features that were actually mapped. */
  readonly mapped: readonly string[]
  /** Mapping gaps that a verifier must fill in itself. */
  readonly unsupported: readonly VerifierUnsupportedMapping[]
  readonly notes: readonly string[]
}

/** Constraint resolution for one credential format of the attestation type. */
export interface VerifierFormatPolicy {
  readonly format: string
  readonly grounding: VerifierGroundingStatus
  readonly schemaReferences: readonly VerifierSchemaReferenceEvidence[]
  readonly attributes: readonly VerifierAttributeConstraint[]
  readonly dcql: VerifierDcqlMapping
  readonly diagnostics: readonly VerifierPolicyDiagnostic[]
}

/** One verifier-policy interface and what AttestBook can map to it. */
export interface VerifierPolicyInterface {
  readonly id: VerifierPolicyInterfaceId
  readonly status: VerifierPolicyInterfaceStatus
  readonly description: string
  /** Constraint or protocol features this interface receives. */
  readonly supportedFeatures: readonly string[]
  /** Explicit gaps of the mapping, never silently omitted. */
  readonly unsupported: readonly VerifierUnsupportedMapping[]
}

/** Explicit non-claims of every result. */
export interface VerifierNonClaims {
  /** `false`: no presentation request is produced. */
  readonly presentationRequest: false
  /** `false`: no holder proof, signature or key binding is produced. */
  readonly proof: false
  readonly cryptographicVerification: 'NOT_TESTED'
  readonly protocolConformance: 'NOT_TESTED'
  readonly interoperability: 'NOT_TESTED'
}

/** The complete verifier constraint and policy-mapping document. */
export interface VerifierConstraintsResult {
  readonly kind: typeof VERIFIER_CONSTRAINTS_KIND
  readonly rulebook: VerifierRulebookEvidence
  readonly attestation: VerifierAttestationEvidence
  readonly formats: readonly VerifierFormatPolicy[]
  readonly policyInterfaces: readonly VerifierPolicyInterface[]
  readonly diagnostics: readonly VerifierPolicyDiagnostic[]
  readonly nonClaims: VerifierNonClaims
  readonly limitations: readonly string[]
}

/** Typed request for `POST /api/v1/verifiers/constraints`. */
export interface ResolveVerifierConstraintsInput {
  readonly rulebookId: string
  readonly rulebookVersion: string
  readonly attestationType: string
  /** Restricts resolution to one format; otherwise every supported format runs. */
  readonly format?: string
  /** Exact schema document bytes, as in credential validation and fixtures. */
  readonly schemaDocuments?: readonly SchemaDocumentInput[]
}

/** The pinned-rulebook reads the resolver needs; `Registry` satisfies it. */
export interface VerifierPolicySource {
  getRulebook(id: string): Rulebook | null
  getRulebookVersion(rulebookId: string, version: string): RulebookVersion | null
  getRulebookVersionContent(rulebookId: string, version: string): RulebookVersionContent | null
}

/** Transport seam for the HTTP application. */
export interface VerifierPolicyService {
  resolve(input: unknown): VerifierConstraintsResult
}
