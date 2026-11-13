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
  /** The trusted actor the provisioned token resolves to. */
  readonly actor: AuthenticatedActor
}

/**
 * How a trusted write actor authenticated. `bearer` is a provider API token;
 * `session` is the administrator browser session. The transport layer resolves
 * one of them and hands the registry an already-verified actor, so the
 * registry never accepts a raw token and never mints a synthetic one for a
 * session.
 */
export type ActorAuthMethod = 'bearer' | 'session'

/**
 * A verified write actor bound to one provider. Only the transport layer
 * constructs it, from a bearer token it hashed or a session cookie it resolved;
 * it is never read from request input, so a caller cannot forge its provider id.
 */
export interface AuthenticatedActor {
  readonly providerId: string
  readonly authMethod: ActorAuthMethod
  /** Bearer token row id; `null` for a browser-session actor. */
  readonly tokenId: string | null
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
  /**
   * Deterministic identity of the external import entry this rulebook was
   * created from (SHA-256, issue #31); `null` for a locally authored rulebook.
   * Import-internal product metadata: it never enters a standards document or
   * a version snapshot.
   */
  readonly importKey: string | null
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

/**
 * Supported profiles for a provider-owned credential schema document (#97):
 * a JSON Schema 2020-12 document or an SD-JWT VC Type Metadata document.
 */
export const CREDENTIAL_SCHEMA_KINDS = ['json_schema_2020_12', 'sd_jwt_vc_type_metadata'] as const

export type CredentialSchemaKind = (typeof CREDENTIAL_SCHEMA_KINDS)[number]

/** Media type fixed for each supported credential schema profile. */
export type CredentialSchemaMediaType = 'application/schema+json' | 'application/json'

export const CREDENTIAL_SCHEMA_MEDIA_TYPES: Readonly<
  Record<CredentialSchemaKind, CredentialSchemaMediaType>
> = {
  json_schema_2020_12: 'application/schema+json',
  sd_jwt_vc_type_metadata: 'application/json',
}

/**
 * A provider-owned, content-addressed credential schema document (#97). The
 * exact bytes live once in `artifacts`, keyed by `contentDigest`; this record
 * carries the stable association identity, media type and creation provenance
 * that later HTTP endpoints expose. `provenance` is registry-internal and never
 * part of the document bytes.
 */
export interface CredentialSchemaDocument {
  /** Stable opaque identifier; later HTTP routes expose it as the document id. */
  readonly id: string
  readonly providerId: string
  readonly kind: CredentialSchemaKind
  /** Lowercase hex SHA-256 of the exact document bytes. */
  readonly contentDigest: string
  readonly mediaType: CredentialSchemaMediaType
  readonly provenance: JsonObject
  readonly createdAt: string
}

/** A schema document plus its exact immutable UTF-8 bytes. */
export interface CredentialSchemaDocumentContent {
  readonly document: CredentialSchemaDocument
  readonly bytes: Uint8Array
}

export interface RegisterCredentialSchemaDocumentInput {
  readonly kind: CredentialSchemaKind
  /**
   * Exact document bytes. The service computes the SHA-256 over these bytes
   * after taking its own copy; caller-supplied mutable buffers cannot change
   * what is stored.
   */
  readonly bytes: Uint8Array
  /**
   * Optional expected lowercase hex SHA-256. When supplied, a mismatch aborts
   * the registration before anything is written.
   */
  readonly expectedDigest?: string
  /** Creation provenance (for example how the document was registered). */
  readonly provenance?: JsonObject
}

/** Result of recomputing a schema document's digest from its stored bytes. */
export interface CredentialSchemaDocumentDigestVerification {
  readonly document: CredentialSchemaDocument
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
  /**
   * Schema references for this attestation type, created in the same
   * transaction as its rulebook. Used by the import pipeline (#30); the
   * attestation id is assigned by the registry.
   */
  readonly schemaReferences?: readonly CreateAttestationSchemaReferenceInput[]
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

/**
 * A schema reference created together with its attestation type. The
 * attestation id is assigned by `createRulebook`, so callers do not supply it.
 */
export interface CreateAttestationSchemaReferenceInput {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity?: string
  readonly metadata?: JsonObject
}

export interface UpdateSchemaReferenceInput {
  readonly formatIdentifier?: string
  readonly uri?: string
  readonly integrity?: string | null
  readonly attestationId?: string | null
  readonly metadata?: JsonObject
}

export interface CreateRulebookSchemaReferenceInput {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity?: string
  readonly metadata?: JsonObject
}

export interface CreateRulebookInput {
  readonly name: string
  readonly description?: string
  /** `null` behaves like an omitted value, matching the draft-replace contract. */
  readonly sourceUrl?: string | null
  /**
   * Server-computed identity of the external import entry (#31). Re-import uses
   * it to find the rulebook instead of creating a duplicate; local creates omit
   * it. Stored as product metadata, never in a standards document.
   */
  readonly importKey?: string
  readonly provenance?: JsonObject
  readonly applicableSpec: string
  readonly metadata?: JsonObject
  readonly attestations?: readonly CreateAttestationInput[]
  /** Rulebook-level schema references, outside any attestation type (#40). */
  readonly schemaReferences?: readonly CreateRulebookSchemaReferenceInput[]
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

/** A schema reference supplied when replacing a draft working copy (#40). */
export interface DraftSchemaReferenceInput {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity?: string
  readonly metadata?: JsonObject
}

/** An attestation type supplied when replacing a draft working copy (#40). */
export interface DraftAttestationInput {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats?: readonly string[]
  readonly schemaReferences?: readonly DraftSchemaReferenceInput[]
  readonly metadata?: JsonObject
}

/**
 * Full replacement of one rulebook's draft working copy (#40). Publication
 * state, provenance, provider ownership, import identity and internal metadata
 * are never part of the input: they stay on the existing rulebook.
 */
export interface ReplaceDraftContentInput {
  readonly name: string
  readonly description?: string
  /** `null` clears the source URL; omitted behaves like `null` for a replace. */
  readonly sourceUrl?: string | null
  readonly applicableSpec: string
  readonly attestations?: readonly DraftAttestationInput[]
  /** Rulebook-level schema references, outside any attestation type. */
  readonly schemaReferences?: readonly DraftSchemaReferenceInput[]
}

/** The draft working copy as one editable document (#40). */
export interface DraftContent {
  readonly rulebook: Rulebook
  readonly attestations: readonly AttestationType[]
  readonly schemaReferences: readonly SchemaReference[]
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
  'schema_document.create',
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
