// SQL persistence for the AttestBook registry.
//
// This module owns SQL and row mapping only. Authorization, validation,
// transactions and audit orchestration live in `registry.ts`, so repository
// code cannot accidentally bypass an ownership check.
//
// JSON columns are parsed on read and serialized on write; the schema's
// `json_valid`/`json_type` checks reject malformed metadata even if a future
// caller bypasses the service.

import type { Database } from 'bun:sqlite'

import type {
  AttestationType,
  AuditAction,
  AuditEntry,
  AuthTokenRecord,
  JsonObject,
  Provider,
  PublicationStatus,
  Rulebook,
  RulebookVersion,
  SchemaReference,
} from './types'

interface ProviderRow {
  readonly id: string
  readonly name: string
  readonly publication_authority: string
  readonly metadata_json: string
  readonly created_at: string
}

interface TokenRow {
  readonly id: string
  readonly provider_id: string
  readonly label: string | null
  readonly created_at: string
  readonly revoked_at: string | null
}

interface RulebookRow {
  readonly id: string
  readonly provider_id: string
  readonly name: string
  readonly description: string
  readonly source_url: string | null
  readonly applicable_spec: string
  readonly publication_status: string
  readonly provenance_json: string
  readonly metadata_json: string
  readonly created_at: string
  readonly updated_at: string
}

interface AttestationRow {
  readonly id: string
  readonly rulebook_id: string
  readonly name: string
  readonly attestation_los: string
  readonly binding_type: string
  readonly supported_formats_json: string
  readonly metadata_json: string
  readonly created_at: string
}

interface SchemaReferenceRow {
  readonly id: string
  readonly rulebook_id: string
  readonly attestation_id: string | null
  readonly format_identifier: string
  readonly uri: string
  readonly integrity: string | null
  readonly metadata_json: string
  readonly created_at: string
}

interface AuditRow {
  readonly id: number
  readonly at: string
  readonly actor_provider_id: string | null
  readonly action: string
  readonly entity_type: string
  readonly entity_id: string
  readonly detail_json: string | null
}

interface ArtifactRow {
  readonly digest: string
  readonly media_type: string
  readonly bytes: Uint8Array
  readonly created_at: string
}

interface RulebookVersionRow {
  readonly id: string
  readonly rulebook_id: string
  readonly version: string
  readonly status: string
  readonly content_digest: string
  readonly spec_version: string
  readonly provenance_json: string
  readonly created_at: string
  readonly published_at: string | null
}

/** Exact bytes to register in the content-addressed artifact store. */
export interface StoredArtifact {
  readonly digest: string
  readonly mediaType: string
  readonly bytes: Uint8Array
  readonly createdAt: string
}

export interface AuditInput {
  readonly at: string
  readonly actorProviderId: string | null
  readonly action: AuditAction
  readonly entityType: string
  readonly entityId: string
  readonly detail: JsonObject | null
}

function parseJsonObject(json: string): JsonObject {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stored JSON metadata is not an object')
  }
  return parsed as JsonObject
}

function parseStringArray(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('stored string array is malformed')
  }
  return parsed as readonly string[]
}

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    publicationAuthority: row.publication_authority,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  }
}

function toToken(row: TokenRow): AuthTokenRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

function toRulebook(row: RulebookRow): Rulebook {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    description: row.description,
    sourceUrl: row.source_url,
    applicableSpec: row.applicable_spec,
    // The CHECK constraint restricts this column; the cast keeps the domain
    // type honest without reselecting the row.
    publicationStatus: row.publication_status as PublicationStatus,
    provenance: parseJsonObject(row.provenance_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAttestation(row: AttestationRow): AttestationType {
  return {
    id: row.id,
    rulebookId: row.rulebook_id,
    name: row.name,
    attestationLoS: row.attestation_los,
    bindingType: row.binding_type,
    supportedFormats: parseStringArray(row.supported_formats_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  }
}

function toSchemaReference(row: SchemaReferenceRow): SchemaReference {
  return {
    id: row.id,
    rulebookId: row.rulebook_id,
    attestationId: row.attestation_id,
    formatIdentifier: row.format_identifier,
    uri: row.uri,
    integrity: row.integrity,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  }
}

function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    actorProviderId: row.actor_provider_id,
    action: row.action as AuditAction,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detail: row.detail_json === null ? null : parseJsonObject(row.detail_json),
  }
}

function toRulebookVersion(row: RulebookVersionRow): RulebookVersion {
  return {
    id: row.id,
    rulebookId: row.rulebook_id,
    version: row.version,
    // The CHECK constraint restricts this column; the cast keeps the domain
    // type honest without reselecting the row.
    status: row.status as PublicationStatus,
    contentDigest: row.content_digest,
    specVersion: row.spec_version,
    provenance: parseJsonObject(row.provenance_json),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }
}

export class RegistryStore {
  constructor(private readonly database: Database) {}

  insertProvider(provider: Provider): void {
    this.database
      .query(
        'INSERT INTO providers (id, name, publication_authority, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        provider.id,
        provider.name,
        provider.publicationAuthority,
        JSON.stringify(provider.metadata),
        provider.createdAt,
      )
  }

  getProvider(id: string): Provider | null {
    const row = this.database
      .query<ProviderRow, [string]>('SELECT * FROM providers WHERE id = ?')
      .get(id)
    return row === null ? null : toProvider(row)
  }

  listProviders(): readonly Provider[] {
    return this.database
      .query<ProviderRow, []>('SELECT * FROM providers ORDER BY rowid')
      .all()
      .map(toProvider)
  }

  findProviderByPublicationAuthority(publicationAuthority: string): Provider | null {
    const row = this.database
      .query<ProviderRow, [string]>(
        'SELECT * FROM providers WHERE publication_authority = ? COLLATE NOCASE',
      )
      .get(publicationAuthority)
    return row === null ? null : toProvider(row)
  }

  updateProvider(provider: Provider): void {
    // publication_authority is operator-assigned and intentionally immutable
    // through the service; only the display name and internal metadata change.
    this.database
      .query('UPDATE providers SET name = ?, metadata_json = ? WHERE id = ?')
      .run(provider.name, JSON.stringify(provider.metadata), provider.id)
  }

  deleteProvider(id: string): void {
    this.database.query('DELETE FROM providers WHERE id = ?').run(id)
  }

  countRulebooks(providerId: string): number {
    const row = this.database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM rulebooks WHERE provider_id = ?',
      )
      .get(providerId)
    return row?.count ?? 0
  }

  insertToken(
    id: string,
    providerId: string,
    tokenHash: string,
    label: string | null,
    createdAt: string,
  ): void {
    this.database
      .query(
        'INSERT INTO auth_tokens (id, provider_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, providerId, tokenHash, label, createdAt)
  }

  findTokenByHash(tokenHash: string): TokenRow | null {
    return this.database
      .query<TokenRow, [string]>('SELECT * FROM auth_tokens WHERE token_hash = ?')
      .get(tokenHash)
  }

  findTokenById(id: string): TokenRow | null {
    return this.database.query<TokenRow, [string]>('SELECT * FROM auth_tokens WHERE id = ?').get(id)
  }

  listTokens(providerId: string): readonly AuthTokenRecord[] {
    return this.database
      .query<TokenRow, [string]>('SELECT * FROM auth_tokens WHERE provider_id = ? ORDER BY rowid')
      .all(providerId)
      .map(toToken)
  }

  revokeToken(id: string, revokedAt: string): void {
    this.database
      .query('UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(revokedAt, id)
  }

  insertRulebook(rulebook: Rulebook): void {
    this.database
      .query(
        `INSERT INTO rulebooks (
          id, provider_id, name, description, source_url, applicable_spec,
          publication_status, provenance_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rulebook.id,
        rulebook.providerId,
        rulebook.name,
        rulebook.description,
        rulebook.sourceUrl,
        rulebook.applicableSpec,
        rulebook.publicationStatus,
        JSON.stringify(rulebook.provenance),
        JSON.stringify(rulebook.metadata),
        rulebook.createdAt,
        rulebook.updatedAt,
      )
  }

  getRulebook(id: string): Rulebook | null {
    const row = this.database
      .query<RulebookRow, [string]>('SELECT * FROM rulebooks WHERE id = ?')
      .get(id)
    return row === null ? null : toRulebook(row)
  }

  listRulebooks(providerId?: string): readonly Rulebook[] {
    if (providerId === undefined) {
      return this.database
        .query<RulebookRow, []>('SELECT * FROM rulebooks ORDER BY rowid')
        .all()
        .map(toRulebook)
    }
    return this.database
      .query<RulebookRow, [string]>('SELECT * FROM rulebooks WHERE provider_id = ? ORDER BY rowid')
      .all(providerId)
      .map(toRulebook)
  }

  updateRulebook(rulebook: Rulebook): void {
    this.database
      .query(
        `UPDATE rulebooks SET
          name = ?, description = ?, source_url = ?, applicable_spec = ?,
          provenance_json = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        rulebook.name,
        rulebook.description,
        rulebook.sourceUrl,
        rulebook.applicableSpec,
        JSON.stringify(rulebook.provenance),
        JSON.stringify(rulebook.metadata),
        rulebook.updatedAt,
        rulebook.id,
      )
  }

  deleteRulebook(id: string): void {
    this.database.query('DELETE FROM rulebooks WHERE id = ?').run(id)
  }

  touchRulebook(id: string, updatedAt: string): void {
    this.database.query('UPDATE rulebooks SET updated_at = ? WHERE id = ?').run(updatedAt, id)
  }

  /** Changes only the rulebook's publication state, which is product metadata. */
  setRulebookPublicationStatus(id: string, status: PublicationStatus, updatedAt: string): void {
    this.database
      .query('UPDATE rulebooks SET publication_status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAt, id)
  }

  insertAttestation(attestation: AttestationType): void {
    this.database
      .query(
        `INSERT INTO attestations (
          id, rulebook_id, name, attestation_los, binding_type,
          supported_formats_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attestation.id,
        attestation.rulebookId,
        attestation.name,
        attestation.attestationLoS,
        attestation.bindingType,
        JSON.stringify(attestation.supportedFormats),
        JSON.stringify(attestation.metadata),
        attestation.createdAt,
      )
  }

  getAttestation(id: string): AttestationType | null {
    const row = this.database
      .query<AttestationRow, [string]>('SELECT * FROM attestations WHERE id = ?')
      .get(id)
    return row === null ? null : toAttestation(row)
  }

  findAttestationByName(rulebookId: string, name: string): AttestationType | null {
    const row = this.database
      .query<AttestationRow, [string, string]>(
        'SELECT * FROM attestations WHERE rulebook_id = ? AND name = ?',
      )
      .get(rulebookId, name)
    return row === null ? null : toAttestation(row)
  }

  listAttestations(rulebookId: string): readonly AttestationType[] {
    return this.database
      .query<AttestationRow, [string]>(
        'SELECT * FROM attestations WHERE rulebook_id = ? ORDER BY rowid',
      )
      .all(rulebookId)
      .map(toAttestation)
  }

  updateAttestation(attestation: AttestationType): void {
    this.database
      .query(
        `UPDATE attestations SET
          name = ?, attestation_los = ?, binding_type = ?,
          supported_formats_json = ?, metadata_json = ?
        WHERE id = ?`,
      )
      .run(
        attestation.name,
        attestation.attestationLoS,
        attestation.bindingType,
        JSON.stringify(attestation.supportedFormats),
        JSON.stringify(attestation.metadata),
        attestation.id,
      )
  }

  deleteAttestation(id: string): void {
    this.database.query('DELETE FROM attestations WHERE id = ?').run(id)
  }

  insertSchemaReference(reference: SchemaReference): void {
    this.database
      .query(
        `INSERT INTO schema_refs (
          id, rulebook_id, attestation_id, format_identifier, uri,
          integrity, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reference.id,
        reference.rulebookId,
        reference.attestationId,
        reference.formatIdentifier,
        reference.uri,
        reference.integrity,
        JSON.stringify(reference.metadata),
        reference.createdAt,
      )
  }

  getSchemaReference(id: string): SchemaReference | null {
    const row = this.database
      .query<SchemaReferenceRow, [string]>('SELECT * FROM schema_refs WHERE id = ?')
      .get(id)
    return row === null ? null : toSchemaReference(row)
  }

  findSchemaReferenceByFormat(
    rulebookId: string,
    attestationId: string | null,
    formatIdentifier: string,
  ): SchemaReference | null {
    const row =
      attestationId === null
        ? this.database
            .query<SchemaReferenceRow, [string, string]>(
              `SELECT * FROM schema_refs
               WHERE rulebook_id = ? AND attestation_id IS NULL AND format_identifier = ?`,
            )
            .get(rulebookId, formatIdentifier)
        : this.database
            .query<SchemaReferenceRow, [string, string, string]>(
              `SELECT * FROM schema_refs
               WHERE rulebook_id = ? AND attestation_id = ? AND format_identifier = ?`,
            )
            .get(rulebookId, attestationId, formatIdentifier)
    return row === null ? null : toSchemaReference(row)
  }

  listSchemaReferences(rulebookId: string): readonly SchemaReference[] {
    return this.database
      .query<SchemaReferenceRow, [string]>(
        'SELECT * FROM schema_refs WHERE rulebook_id = ? ORDER BY rowid',
      )
      .all(rulebookId)
      .map(toSchemaReference)
  }

  updateSchemaReference(reference: SchemaReference): void {
    this.database
      .query(
        `UPDATE schema_refs SET
          attestation_id = ?, format_identifier = ?, uri = ?,
          integrity = ?, metadata_json = ?
        WHERE id = ?`,
      )
      .run(
        reference.attestationId,
        reference.formatIdentifier,
        reference.uri,
        reference.integrity,
        JSON.stringify(reference.metadata),
        reference.id,
      )
  }

  deleteSchemaReference(id: string): void {
    this.database.query('DELETE FROM schema_refs WHERE id = ?').run(id)
  }

  // ---------------------------------------------------- versions and artifacts

  /**
   * Registers exact bytes in the content-addressed store. An existing digest is
   * left untouched: a BEFORE INSERT trigger rejects a second insert of the same
   * digest (so `INSERT OR REPLACE` cannot swap the bytes), and the guarded
   * `INSERT ... WHERE NOT EXISTS` keeps the normal path a no-op.
   */
  insertArtifactIfAbsent(artifact: StoredArtifact): void {
    this.database
      .query(
        `INSERT INTO artifacts (digest, media_type, bytes, created_at)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM artifacts WHERE digest = ?)`,
      )
      .run(artifact.digest, artifact.mediaType, artifact.bytes, artifact.createdAt, artifact.digest)
  }

  getArtifact(digest: string): StoredArtifact | null {
    const row = this.database
      .query<ArtifactRow, [string]>('SELECT * FROM artifacts WHERE digest = ?')
      .get(digest)
    return row === null
      ? null
      : {
          digest: row.digest,
          mediaType: row.media_type,
          bytes: row.bytes,
          createdAt: row.created_at,
        }
  }

  insertRulebookVersion(version: RulebookVersion): void {
    this.database
      .query(
        `INSERT INTO rulebook_versions (
          id, rulebook_id, version, status, content_digest, spec_version,
          provenance_json, created_at, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        version.rulebookId,
        version.version,
        version.status,
        version.contentDigest,
        version.specVersion,
        JSON.stringify(version.provenance),
        version.createdAt,
        version.publishedAt,
      )
  }

  getRulebookVersion(rulebookId: string, version: string): RulebookVersion | null {
    const row = this.database
      .query<RulebookVersionRow, [string, string]>(
        'SELECT * FROM rulebook_versions WHERE rulebook_id = ? AND version = ?',
      )
      .get(rulebookId, version)
    return row === null ? null : toRulebookVersion(row)
  }

  listRulebookVersions(rulebookId: string): readonly RulebookVersion[] {
    return this.database
      .query<RulebookVersionRow, [string]>(
        'SELECT * FROM rulebook_versions WHERE rulebook_id = ? ORDER BY rowid',
      )
      .all(rulebookId)
      .map(toRulebookVersion)
  }

  findRulebookVersionsByDigest(digest: string): readonly RulebookVersion[] {
    return this.database
      .query<RulebookVersionRow, [string]>(
        'SELECT * FROM rulebook_versions WHERE content_digest = ? ORDER BY rowid',
      )
      .all(digest)
      .map(toRulebookVersion)
  }

  /** Replaces the snapshot of a still-draft version; published rows are rejected by a trigger. */
  updateDraftRulebookVersionContent(id: string, contentDigest: string, specVersion: string): void {
    this.database
      .query(
        `UPDATE rulebook_versions SET content_digest = ?, spec_version = ?
         WHERE id = ? AND status = 'draft'`,
      )
      .run(contentDigest, specVersion, id)
  }

  publishRulebookVersion(id: string, publishedAt: string): void {
    this.database
      .query(
        `UPDATE rulebook_versions SET status = 'published', published_at = ?
         WHERE id = ? AND status = 'draft'`,
      )
      .run(publishedAt, id)
  }

  /** Demotes every currently published version of a rulebook to `historical`. */
  demotePublishedRulebookVersions(rulebookId: string): void {
    this.database
      .query(
        `UPDATE rulebook_versions SET status = 'historical'
         WHERE rulebook_id = ? AND status = 'published'`,
      )
      .run(rulebookId)
  }

  countNonDraftRulebookVersions(rulebookId: string): number {
    const row = this.database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM rulebook_versions WHERE rulebook_id = ? AND status <> 'draft'",
      )
      .get(rulebookId)
    return row?.count ?? 0
  }

  insertAudit(entry: AuditInput): void {
    this.database
      .query(
        `INSERT INTO audit_log (at, actor_provider_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.at,
        entry.actorProviderId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.detail === null ? null : JSON.stringify(entry.detail),
      )
  }

  listAuditEntries(): readonly AuditEntry[] {
    return this.database
      .query<AuditRow, []>('SELECT * FROM audit_log ORDER BY id')
      .all()
      .map(toAuditEntry)
  }
}
