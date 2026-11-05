// Domain types for the AttestBook registry (issue #28).
//
// These are product/domain types. They are not TS11 or OWF wire types: the
// standards adapter in `src/standards/` owns translation, and no internal field
// defined here may be serialized into a standards document. See
// docs/registry.md for the stable-identifier and metadata-boundary rules.

/** A JSON object used for registry-internal metadata, never for wire data. */
export type JsonObject = Readonly<Record<string, unknown>>

export const PUBLICATION_STATUSES = ['draft', 'published', 'historical'] as const
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number]

export interface Provider {
  /** Stable, server-generated opaque identifier (UUID v4). */
  readonly id: string
  readonly name: string
  /**
   * Opaque account binding that holds publication authority. It is never
   * inferred from a remote URL (FR-003).
   */
  readonly publicationAuthority: string
  /** AttestBook-internal metadata; never written into a standards document. */
  readonly metadata: JsonObject
  readonly createdAt: string
}

export interface AuthTokenRecord {
  readonly id: string
  readonly providerId: string
  readonly label: string | null
  readonly createdAt: string
  readonly revokedAt: string | null
}

export interface IssuedToken extends AuthTokenRecord {
  /** Raw bearer token. Returned exactly once and never stored in the database. */
  readonly secret: string
}

export interface ProvisionedProvider {
  readonly provider: Provider
  readonly token: IssuedToken
}

/** A verified write actor, resolved from a bearer token. */
export interface AuthenticatedActor {
  readonly providerId: string
  readonly tokenId: string
}

export interface AttestationType {
  readonly id: string
  readonly rulebookId: string
  readonly name: string
  /**
   * TS11/ETSI value stored as extensible text (decision D-5), not a closed
   * union, so a new standard value does not require a schema migration.
   */
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  /** AttestBook-internal metadata; never written into a standards document. */
  readonly metadata: JsonObject
  readonly createdAt: string
}

export interface SchemaReference {
  readonly id: string
  readonly rulebookId: string
  /** Attestation type this reference belongs to; `null` for rulebook-level. */
  readonly attestationId: string | null
  readonly formatIdentifier: string
  /** Reference URI without the `#integrity=` fragment. */
  readonly uri: string
  /** W3C SRI value such as `sha256-...`, when the source carries one. */
  readonly integrity: string | null
  /** AttestBook-internal metadata; never written into a standards document. */
  readonly metadata: JsonObject
  readonly createdAt: string
}

export interface Rulebook {
  /** Stable, server-generated opaque identifier (UUID v4). */
  readonly id: string
  readonly providerId: string
  readonly name: string
  readonly description: string
  readonly sourceUrl: string | null
  /** Provenance is registry-internal; it never enters a standards document. */
  readonly provenance: JsonObject
  /** Profile identifier such as `ts11@1.0.1`; extensible text. */
  readonly applicableSpec: string
  readonly publicationStatus: PublicationStatus
  /** AttestBook-internal metadata; never written into a standards document. */
  readonly metadata: JsonObject
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProvisionProviderInput {
  readonly name: string
  readonly publicationAuthority: string
  readonly metadata?: JsonObject
  /** Optional label for the first bearer token. */
  readonly tokenLabel?: string
}

/**
 * An immutable snapshot of a rulebook at one version (issue #29). The exact
 * snapshot bytes live in a content-addressed artifact; `contentDigest` is the
 * SHA-256 of those bytes (D-6). Provenance is registry-internal and never part
 * of the snapshot or a standards document.
 */
export interface RulebookVersion {
  readonly id: string
  readonly rulebookId: string
  /** Version label such as `1.0` or `1.0.1`. */
  readonly version: string
  readonly status: PublicationStatus
  /** Lowercase hex SHA-256 of the exact snapshot bytes. */
  readonly contentDigest: string
  /** Profile the snapshot was authored against, e.g. `ts11@1.0.1`. */
  readonly specVersion: string
  readonly provenance: JsonObject
  readonly createdAt: string
  /** Set exactly when the version leaves `draft`; never changed afterwards. */
  readonly publishedAt: string | null
}

/** Metadata of a content-addressed artifact; the bytes are retrieved by the store. */
export interface RulebookVersionContent {
  readonly version: RulebookVersion
  readonly mediaType: string
  readonly bytes: Uint8Array
}

/** Result of recomputing a version's digest from its stored artifact bytes. */
export interface VersionDigestVerification {
  readonly version: RulebookVersion
  readonly expectedDigest: string
  readonly actualDigest: string
  readonly verified: boolean
}

export interface CreateRulebookVersionInput {
  readonly version: string
  /**
   * Version provenance (for example how the content was imported). Defaults to
   * the rulebook's provenance and is frozen when the version is published.
   */
  readonly provenance?: JsonObject
}

export interface CreateAttestationInput {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats?: readonly string[]
  readonly metadata?: JsonObject
}

export interface UpdateAttestationInput {
  readonly name?: string
  readonly attestationLoS?: string
  readonly bindingType?: string
  readonly supportedFormats?: readonly string[]
  readonly metadata?: JsonObject
}

export interface CreateSchemaReferenceInput {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity?: string
  readonly attestationId?: string
  readonly metadata?: JsonObject
}

export interface UpdateSchemaReferenceInput {
  readonly formatIdentifier?: string
  readonly uri?: string
  readonly integrity?: string | null
  readonly attestationId?: string | null
  readonly metadata?: JsonObject
}

export interface CreateRulebookInput {
  readonly name: string
  readonly description?: string
  readonly sourceUrl?: string
  readonly provenance?: JsonObject
  readonly applicableSpec: string
  readonly metadata?: JsonObject
  readonly attestations?: readonly CreateAttestationInput[]
}

export interface UpdateRulebookInput {
  readonly name?: string
  readonly description?: string
  /** `null` clears the source URL; `undefined` leaves it unchanged. */
  readonly sourceUrl?: string | null
  readonly provenance?: JsonObject
  readonly applicableSpec?: string
  readonly metadata?: JsonObject
}

export interface UpdateProviderInput {
  readonly name?: string
  readonly metadata?: JsonObject
}

export interface RulebookFilter {
  readonly providerId?: string
}

export const AUDIT_ACTIONS = [
  'provider.provision',
  'provider.update',
  'provider.delete',
  'token.issue',
  'token.revoke',
  'rulebook.create',
  'rulebook.update',
  'rulebook.delete',
  'attestation.create',
  'attestation.update',
  'attestation.delete',
  'schema_ref.create',
  'schema_ref.update',
  'schema_ref.delete',
  'version.create',
  'version.refresh',
  'version.publish',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEntry {
  readonly id: number
  readonly at: string
  readonly actorProviderId: string | null
  readonly action: AuditAction
  readonly entityType: string
  readonly entityId: string
  readonly detail: JsonObject | null
}
