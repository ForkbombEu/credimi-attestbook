// Public contracts for rulebook-driven issuer fixtures (FR-013, issue #44).
//
// A fixture is an unsigned claim payload synthesized from the attribute
// constraints that a pinned rulebook version references. It is deliberately not
// a credential: AttestBook does not sign, issue or present it, and the result
// carries explicit `signed`/`issued` flags plus the limitations of applying a
// caller-supplied schema document. Negative cases are labelled, deterministic
// mutations of the same payload, each verified to fail the supplied schemas.

import type { Rulebook, RulebookVersion, RulebookVersionContent } from '../registry/types'
import type { SchemaDocumentInput } from '../validation/types'

/** Format marker carried by every generated fixture document. */
export const ISSUER_FIXTURE_KIND = 'attestbook.unsigned-issuer-fixture@1'

/** Versioned product-API path for fixture generation. */
export const ISSUER_FIXTURE_PATH = '/api/v1/issuers/fixtures'

/** How a negative case was derived from the effective constraints. */
export const ISSUER_FIXTURE_NEGATIVE_CATEGORIES = [
  'missing_required',
  'type',
  'enum',
  'const',
  'max_length',
  'min_length',
  'maximum',
  'minimum',
  'multiple_of',
  'max_items',
  'min_items',
  'additional_properties',
] as const

export type IssuerFixtureNegativeCategory = (typeof ISSUER_FIXTURE_NEGATIVE_CATEGORIES)[number]

/** The pinned rulebook version a fixture was generated from. */
export interface IssuerFixtureRulebookEvidence {
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
export interface IssuerFixtureAttestationEvidence {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
}

/** One rulebook schema reference and whether it grounded the fixture. */
export interface IssuerFixtureSchemaReferenceEvidence {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity: string | null
  /** Whether the supplied bytes matched the reference's sha256 SRI value. */
  readonly integrityVerified: boolean
  readonly kind: 'json_schema' | 'type_metadata' | null
  /** Whether the document participated in synthesis and payload validation. */
  readonly applied: boolean
  readonly diagnostic?: string
}

/** One attribute the pinned schema documents constrain. */
export interface IssuerFixtureAttribute {
  /**
   * JSON Pointer into the schema; array elements use the `*` wildcard because
   * JSON Pointer has no array wildcard (the same convention as validation).
   */
  readonly pointer: string
  readonly name: string
  readonly required: boolean
  readonly types: readonly string[]
  /** Effective supported constraints, for example `maxLength` or `enum`. */
  readonly constraints: Readonly<Record<string, unknown>>
  /** Rulebook schema-reference URIs that declare this attribute. */
  readonly sources: readonly string[]
  readonly generated: boolean
  /** Why an attribute was not generated; omitted when it was generated. */
  readonly reason?: string
}

/** One non-sensitive finding about the generated payload. */
export interface IssuerFixtureFinding {
  readonly code: string
  readonly message: string
  readonly path?: string
  /** The violated JSON Schema keyword, when one applies. */
  readonly keyword?: string
}

/** Result of evaluating the generated payload against the supplied documents. */
export interface IssuerFixturePayloadValidation {
  readonly status: 'PASS' | 'FAIL'
  readonly findings: readonly IssuerFixtureFinding[]
}

/** One caller-supplied attribute override applied to the payload. */
export interface IssuerFixtureOverride {
  /** JSON Pointer into the generated payload. */
  readonly path: string
  readonly value: unknown
  readonly applied: true
}

/** One labelled, reproducible negative fixture case. */
export interface IssuerFixtureNegativeCase {
  /** Stable identifier derived from the derived category and instance path. */
  readonly id: string
  readonly label: string
  readonly category: IssuerFixtureNegativeCategory
  /** The JSON Schema keyword Ajv reported for this case. */
  readonly keyword: string
  /** JSON Pointer to the violating instance location. */
  readonly path: string
  /** A negative case is only included when it really fails the schemas. */
  readonly expected: 'FAIL'
  readonly reason: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** A safe, machine-readable fixture-generation finding. */
export interface IssuerFixtureDiagnostic {
  readonly code: string
  readonly message: string
  readonly path?: string
}

/** The complete generated fixture document. */
export interface IssuerFixtureResult {
  readonly kind: typeof ISSUER_FIXTURE_KIND
  /** `false` is a contract, not a default: AttestBook never signs fixtures. */
  readonly signed: false
  /** `false` is a contract: a payload is not an issued credential. */
  readonly issued: false
  readonly rulebook: IssuerFixtureRulebookEvidence
  readonly attestation: IssuerFixtureAttestationEvidence
  /** Distinct credential formats whose schema references grounded the fixture. */
  readonly formats: readonly string[]
  readonly schemaReferences: readonly IssuerFixtureSchemaReferenceEvidence[]
  readonly attributes: readonly IssuerFixtureAttribute[]
  /** The unsigned claim payload. */
  readonly payload: Readonly<Record<string, unknown>>
  readonly payloadValidation: IssuerFixturePayloadValidation
  readonly overrides: readonly IssuerFixtureOverride[]
  readonly negativeCases: readonly IssuerFixtureNegativeCase[]
  readonly diagnostics: readonly IssuerFixtureDiagnostic[]
  readonly limitations: readonly string[]
}

/** One caller-supplied attribute override before it is applied. */
export interface IssuerFixtureOverrideInput {
  readonly path: string
  readonly value: unknown
}

/** Typed request for `POST /api/v1/issuers/fixtures`. */
export interface GenerateIssuerFixtureInput {
  readonly rulebookId: string
  readonly rulebookVersion: string
  readonly attestationType: string
  /** Restricts eligible schema references to this credential format. */
  readonly format?: string
  /** Exact schema document bytes, as in credential validation. */
  readonly schemaDocuments?: readonly SchemaDocumentInput[]
  readonly overrides?: readonly IssuerFixtureOverrideInput[]
}

/** The pinned-rulebook reads the generator needs; `Registry` satisfies it. */
export interface IssuerFixtureSource {
  getRulebook(id: string): Rulebook | null
  getRulebookVersion(rulebookId: string, version: string): RulebookVersion | null
  getRulebookVersionContent(rulebookId: string, version: string): RulebookVersionContent | null
}

/** Transport seam for the HTTP application. */
export interface IssuerFixtureService {
  generate(input: unknown): Promise<IssuerFixtureResult>
}
