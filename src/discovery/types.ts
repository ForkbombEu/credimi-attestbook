// Domain types for OpenID4VCI credential issuer metadata discovery (FR-006).
//
// Discovery is a read-only, bounded inspection of an issuer's published
// metadata. Nothing here is a rulebook: the metadata describes what an issuer
// offers, never what a conformant credential must satisfy. Mappings are
// therefore reported as candidate associations with an exact, immutable
// published/historical rulebook version and are never treated as normative.

/** Which OpenID4VCI metadata generation the document uses. */
export const ISSUER_METADATA_SHAPES = ['oid4vci_1_0', 'oid4vci_legacy'] as const
export type IssuerMetadataShape = (typeof ISSUER_METADATA_SHAPES)[number]

/** Where a schema reference was exposed in the issuer metadata. */
export const CONFIGURATION_SCHEMA_SOURCES = ['vct', 'schema'] as const
export type ConfigurationSchemaSource = (typeof CONFIGURATION_SCHEMA_SOURCES)[number]

/** The kind of credential type identifier used by an OpenID4VCI format. */
export const CONFIGURATION_TYPE_IDENTIFIER_KINDS = ['vct', 'doctype', 'type'] as const
export type ConfigurationTypeIdentifierKind = (typeof CONFIGURATION_TYPE_IDENTIFIER_KINDS)[number]

/** A type identifier an issuer configuration declares (`vct`, `doctype`, legacy type). */
export interface ConfigurationTypeIdentifier {
  readonly kind: ConfigurationTypeIdentifierKind
  readonly value: string
}

/** A schema reference the issuer metadata exposes for one configuration. */
export interface DiscoveredSchemaReference {
  readonly formatIdentifier: string
  readonly uri: string
  readonly source: ConfigurationSchemaSource
}

/** One `credential_configurations_supported` entry, normalized. */
export interface DiscoveredCredentialConfiguration {
  readonly configurationId: string
  readonly format: string
  /** Display name for humans; never used for matching. */
  readonly displayName: string | null
  readonly typeIdentifiers: readonly ConfigurationTypeIdentifier[]
  readonly schemaReferences: readonly DiscoveredSchemaReference[]
}

/** A rulebook version that a configuration may be associated with. */
export interface RulebookVersionPin {
  readonly rulebookId: string
  readonly rulebookName: string
  readonly version: string
  readonly contentDigest: string
  readonly specVersion: string
}

/** Whether a configuration's association is unambiguous. */
export const CONFIGURATION_MAPPING_STATUSES = ['matched', 'ambiguous', 'unmatched'] as const
export type ConfigurationMappingStatus = (typeof CONFIGURATION_MAPPING_STATUSES)[number]

/**
 * Candidate association result. `matched` carries exactly one pin, `ambiguous`
 * more than one and `unmatched` none; `reason` is set only when there is no
 * candidate.
 */
export interface ConfigurationMapping {
  readonly status: ConfigurationMappingStatus
  readonly candidates: readonly RulebookVersionPin[]
  readonly reason: string | null
}

/** A discovered configuration together with its candidate rulebook mapping. */
export interface IssuerCredentialConfiguration extends DiscoveredCredentialConfiguration {
  readonly mapping: ConfigurationMapping
}

/** Provenance of one metadata retrieval. */
export interface IssuerDiscoverySource {
  /** Issuer identifier used for `credential_issuer` comparison. */
  readonly issuerIdentifier: string
  /** Well-known metadata URL derived from the issuer identifier. */
  readonly metadataUrl: string
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly retrievedAt: string
  readonly contentType: string | null
  readonly status: number
  readonly byteLength: number
  /** Lowercase hex SHA-256 of the exact retrieved metadata bytes. */
  readonly contentDigest: string
  readonly redirects: readonly string[]
  readonly metadataShape: IssuerMetadataShape
}

/** Bounded projection of the metadata members discovery understood. */
export interface IssuerMetadataSummary {
  readonly credentialIssuer: string
  readonly credentialEndpoint: string | null
  readonly authorizationServers: readonly string[]
}

/** Aggregate mapping counts for one discovery run. */
export interface IssuerDiscoverySummary {
  /** Every entry the metadata declared, including invalid/unparseable ones. */
  readonly totalConfigurations: number
  /** Entries that produced a configuration (and therefore a mapping). */
  readonly validConfigurations: number
  /** Entries rejected as malformed or over a bound. */
  readonly invalidConfigurations: number
  readonly matched: number
  readonly ambiguous: number
  readonly unmatched: number
  /** Distinct rulebook versions used as unambiguous mappings. */
  readonly mappedRulebooks: number
}

/** A safe, machine-readable discovery finding. */
export interface IssuerDiscoveryDiagnostic {
  readonly code: string
  readonly message: string
  readonly path?: string
}

/** The complete result of one bounded issuer metadata discovery. */
export interface IssuerDiscoveryResult {
  readonly source: IssuerDiscoverySource
  readonly issuer: IssuerMetadataSummary
  readonly configurations: readonly IssuerCredentialConfiguration[]
  readonly summary: IssuerDiscoverySummary
  readonly diagnostics: readonly IssuerDiscoveryDiagnostic[]
  readonly limitations: readonly string[]
}

/** A candidate rulebook version in the mapping index, with its frozen identifiers. */
export interface RulebookVersionCandidate extends RulebookVersionPin {
  readonly status: 'published' | 'historical'
  /** Publication time; used to prefer the current version of a rulebook. */
  readonly publishedAt: string
  readonly formats: readonly string[]
  readonly typeIdentifiers: readonly {
    readonly formatIdentifier: string
    readonly value: string
  }[]
}

/** The bounded index of rulebook versions discovery may associate with. */
export interface RulebookMappingIndex {
  readonly candidates: readonly RulebookVersionCandidate[]
  readonly diagnostics: readonly IssuerDiscoveryDiagnostic[]
}
