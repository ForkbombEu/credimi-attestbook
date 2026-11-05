// Canonical AttestBook model for an attestation SchemaMeta document.
//
// The canonical model is the union of what AttestBook needs to operate, not a
// copy of either wire profile. Registry and validation code only ever consume
// this model; the codecs in `./ts11.ts` and `./owf.ts` project it to and from
// the EC TS11 v1.0.1 and OWF 0.5.4 wire shapes.
//
// Product metadata is deliberately a separate type. No member of
// `ProductMetadata` is read by a serializer, so internal provenance and
// publication state can never leak into a standards document.

import type { SchemaMeta } from '@owf/eudi-attestation-schema'

/** The OWF package's `SchemaMeta` document, as validated by the real package. */
export type OwfSchemaMeta = SchemaMeta

/** Identifier of the EC TS11 v1.0.1 wire profile. */
export const TS11_PROFILE = 'ts11@1.0.1' as const
/** Identifier of the OWF `@owf/eudi-attestation-schema` 0.5.4 wire profile. */
export const OWF_PROFILE = 'owf@0.5.4' as const

export type SupportedProfile = typeof TS11_PROFILE | typeof OWF_PROFILE

export const SUPPORTED_PROFILES: readonly SupportedProfile[] = [TS11_PROFILE, OWF_PROFILE]

/** X.509 certificate verification method carried by the OWF profile. */
export interface CanonicalVerificationMethod {
  readonly type: 'X509Certificate'
  readonly x509Certificate: string
}

/**
 * A trust authority reference. Enumerated values are stored as plain strings so
 * future TS11/ETSI values survive an import/export round trip (decision D-5).
 */
export interface CanonicalTrustAuthority {
  readonly frameworkType: string
  readonly value: string
  readonly isLOTE?: boolean
  readonly verificationMethod?: CanonicalVerificationMethod
  /** Members preserved from a newer revision of the profile. */
  readonly unknownMembers?: Readonly<Record<string, unknown>>
}

/** A format-specific schema reference with its optional W3C SRI value. */
export interface CanonicalSchemaReference {
  readonly formatIdentifier: string
  /** Reference URI without the `#integrity=` fragment. */
  readonly uri: string
  /** W3C SRI value such as `sha256-...`, when the document carries one. */
  readonly integrity?: string
  /** OWF format-specific metadata (`vct`/`doctype_value`); absent in TS11 v1.0.1. */
  readonly meta?: Readonly<Record<string, unknown>>
  /** Members preserved from a newer revision of the profile. */
  readonly unknownMembers?: Readonly<Record<string, unknown>>
}

/** Profile-independent view of a SchemaMeta document. */
export interface CanonicalSchemaMeta {
  /** TS11 UUID id or OWF URL id; optional because TS11 marks it server-assigned. */
  readonly id?: string
  /** OWF issuance time; TS11 v1.0.1 has no SchemaMeta `iat`. */
  readonly iat?: number
  readonly version: string
  /** Rulebook URI without the `#integrity=` fragment. */
  readonly rulebookURI: string
  /** W3C SRI value split out of `rulebookURI#integrity=...`. */
  readonly rulebookIntegrity?: string
  readonly trustedAuthorities: readonly CanonicalTrustAuthority[]
  readonly attestationLoS: string
  readonly bindingType: string
  /**
   * TS11 requires this member. For the OWF profile it is derived from the
   * unique format identifiers of `schemaURIs`.
   */
  readonly supportedFormats: readonly string[]
  readonly schemaURIs: readonly CanonicalSchemaReference[]
  /** OWF-specific issuance policy; TS11 v1.0.1 has no equivalent member. */
  readonly issuanceProfile?: Readonly<Record<string, unknown>>
  /** Top-level members preserved from a newer revision of the profile. */
  readonly unknownMembers: Readonly<Record<string, unknown>>
}

/**
 * AttestBook-internal metadata. These fields belong to the registry, never to a
 * published standards document.
 */
export interface ProductMetadata {
  readonly rulebookId: string
  readonly providerId: string
  readonly publicationStatus: string
  readonly sourceUrl?: string
}

/** A canonical document plus the registry metadata kept beside it. */
export interface AttestBookSchemaMeta {
  readonly schemaMeta: CanonicalSchemaMeta
  readonly productMetadata: ProductMetadata
}

export function createAttestBookSchemaMeta(
  schemaMeta: CanonicalSchemaMeta,
  productMetadata: ProductMetadata,
): AttestBookSchemaMeta {
  return { schemaMeta, productMetadata }
}

const PRODUCT_METADATA_FIELDS: readonly (keyof ProductMetadata)[] = [
  'rulebookId',
  'providerId',
  'publicationStatus',
  'sourceUrl',
]

/**
 * Guards against a registry accidentally merging internal fields into a
 * canonical document: returns the product fields found in a canonical object.
 */
export function productMetadataLeaks(
  schemaMeta: CanonicalSchemaMeta | Readonly<Record<string, unknown>>,
): readonly string[] {
  const record = schemaMeta as unknown as Readonly<Record<string, unknown>>
  return PRODUCT_METADATA_FIELDS.filter((field) => field in record)
}
