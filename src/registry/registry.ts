// AttestBook registry service (issues #28 and #29).
//
// This service is the authenticated write path into the registry database.
// Operator-only provider provisioning lives in `bootstrap.ts`. The service
// combines:
//   * bearer-token authentication bound to a provider account (D-10);
//   * service-level ownership enforcement for every mutation;
//   * draft rulebook mutation, with an immutable draft→published→historical
//     version lifecycle and content-addressed, digest-verified snapshots (#29);
//   * transactional writes with an audit trail.
//
// Public reads need no token. The HTTP API that exposes these operations is
// added by issue #34/#35; this module is intentionally transport-independent.

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { sha256Hex } from './digest'
import {
  conflict,
  forbidden,
  immutable,
  invalidInput,
  isUniqueConstraintError,
  notFound,
  unauthorized,
} from './errors'
import { RegistryStore } from './store'
import { generateBearerToken, hashBearerToken } from './tokens'
import type {
  AttestationType,
  AuthenticatedActor,
  AuthTokenRecord,
  CreateAttestationInput,
  CreateRulebookInput,
  CreateRulebookVersionInput,
  CreateSchemaReferenceInput,
  CreateAttestationSchemaReferenceInput,
  IssuedToken,
  Provider,
  Rulebook,
  RulebookFilter,
  RulebookVersion,
  RulebookVersionContent,
  SchemaReference,
  UpdateAttestationInput,
  UpdateProviderInput,
  UpdateRulebookInput,
  UpdateSchemaReferenceInput,
  VersionDigestVerification,
} from './types'
import {
  assertArray,
  assertObject,
  MAX_ATTESTATIONS_PER_RULEBOOK,
  MAX_SCHEMA_REFERENCES_PER_ATTESTATION,
  MAX_RULEBOOKS_PER_BATCH,
  MAX_NAME_LENGTH,
  MAX_SPEC_LENGTH,
  requireAbsoluteHttpUrl,
  requireDescription,
  requireIdentifier,
  requireIntegrity,
  requireJsonObject,
  requireLabel,
  requireSemanticVersion,
  requireSha256Digest,
  requireStringArray,
  requireText,
} from './validation'
import {
  buildRulebookVersionDocument,
  RULEBOOK_VERSION_MEDIA_TYPE,
  serializeRulebookVersion,
} from './versioning'

export interface RegistryOptions {
  readonly database: Database
  /** Clock used for record timestamps; injectable for deterministic tests. */
  readonly now?: () => string
  /** Identifier generator; injectable for deterministic tests. */
  readonly generateId?: () => string
}

const MAX_BEARER_TOKEN_LENGTH = 256

interface PreparedRulebook {
  readonly rulebook: Rulebook
  readonly attestations: readonly AttestationType[]
  readonly schemaReferences: readonly SchemaReference[]
}

/** Immutable list of changed domain fields, used only in audit detail. */
function changedFields(previous: object, next: object): readonly string[] {
  const previousRecord = previous as Record<string, unknown>
  const nextRecord = next as Record<string, unknown>
  return Object.keys(nextRecord).filter(
    (key) => JSON.stringify(previousRecord[key]) !== JSON.stringify(nextRecord[key]),
  )
}

export class Registry {
  private readonly database: Database
  private readonly store: RegistryStore
  private readonly now: () => string
  private readonly generateId: () => string

  constructor(options: RegistryOptions) {
    this.database = options.database
    this.store = new RegistryStore(options.database)
    this.now = options.now ?? (() => new Date().toISOString())
    this.generateId = options.generateId ?? (() => randomUUID())
  }

  // ---------------------------------------------------------------- providers

  /** Resolves a bearer token to an actor; unknown and revoked tokens are equal. */
  authenticate(rawToken: string): AuthenticatedActor {
    if (
      typeof rawToken !== 'string' ||
      rawToken === '' ||
      rawToken.length > MAX_BEARER_TOKEN_LENGTH
    ) {
      throw unauthorized()
    }
    const row = this.store.findTokenByHash(hashBearerToken(rawToken))
    if (row === null || row.revoked_at !== null) {
      throw unauthorized()
    }
    return { providerId: row.provider_id, tokenId: row.id }
  }

  getProvider(id: string): Provider | null {
    return this.store.getProvider(requireIdentifier(id, 'providerId'))
  }

  listProviders(): readonly Provider[] {
    return this.store.listProviders()
  }

  updateProvider(accessToken: string, input: UpdateProviderInput): Provider {
    const actor = this.authenticate(accessToken)
    assertObject(input, 'provider')
    const existing = this.store.getProvider(actor.providerId)
    if (existing === null) {
      throw notFound('The provider account no longer exists.')
    }

    const updated: Provider = {
      ...existing,
      name:
        input.name === undefined ? existing.name : requireText(input.name, 'name', MAX_NAME_LENGTH),
      metadata:
        input.metadata === undefined
          ? existing.metadata
          : requireJsonObject(input.metadata, 'metadata'),
    }

    const changed = changedFields(existing, updated)
    if (changed.length === 0) {
      return existing
    }

    this.transaction(() => {
      this.store.updateProvider(updated)
      this.store.insertAudit({
        at: this.now(),
        actorProviderId: actor.providerId,
        action: 'provider.update',
        entityType: 'provider',
        entityId: updated.id,
        detail: { fields: changed },
      })
    })()

    return updated
  }

  deleteProvider(accessToken: string): void {
    const actor = this.authenticate(accessToken)
    if (this.store.getProvider(actor.providerId) === null) {
      throw notFound('The provider account no longer exists.')
    }
    if (this.store.countRulebooks(actor.providerId) > 0) {
      throw conflict('The provider still owns rulebooks; delete them first.')
    }

    const at = this.now()
    this.transaction(() => {
      this.store.deleteProvider(actor.providerId)
      this.store.insertAudit({
        at,
        actorProviderId: actor.providerId,
        action: 'provider.delete',
        entityType: 'provider',
        entityId: actor.providerId,
        detail: null,
      })
    })()
  }

  // ------------------------------------------------------------------- tokens

  issueToken(accessToken: string, label?: string): IssuedToken {
    const actor = this.authenticate(accessToken)
    const tokenLabel = requireLabel(label, 'label')
    const tokenId = this.generateId()
    const createdAt = this.now()
    const secret = generateBearerToken()

    const token: IssuedToken = {
      id: tokenId,
      providerId: actor.providerId,
      label: tokenLabel,
      createdAt,
      revokedAt: null,
      secret,
    }

    this.transaction(() => {
      this.store.insertToken(
        tokenId,
        actor.providerId,
        hashBearerToken(secret),
        tokenLabel,
        createdAt,
      )
      this.store.insertAudit({
        at: createdAt,
        actorProviderId: actor.providerId,
        action: 'token.issue',
        entityType: 'auth_token',
        entityId: tokenId,
        detail: tokenLabel === null ? null : { label: tokenLabel },
      })
    })()

    return token
  }

  /** Revocation is idempotent; only tokens of the authenticated provider exist for it. */
  revokeToken(accessToken: string, tokenId: string): void {
    const actor = this.authenticate(accessToken)
    const targetId = requireIdentifier(tokenId, 'tokenId')
    const token = this.store.findTokenById(targetId)
    if (token === null || token.provider_id !== actor.providerId) {
      throw notFound('The token does not exist for the authenticated provider.')
    }
    if (token.revoked_at !== null) {
      return
    }

    const at = this.now()
    this.transaction(() => {
      this.store.revokeToken(targetId, at)
      this.store.insertAudit({
        at,
        actorProviderId: actor.providerId,
        action: 'token.revoke',
        entityType: 'auth_token',
        entityId: targetId,
        detail: null,
      })
    })()
  }

  listTokens(accessToken: string): readonly AuthTokenRecord[] {
    const actor = this.authenticate(accessToken)
    return this.store.listTokens(actor.providerId)
  }

  // ---------------------------------------------------------------- rulebooks

  listRulebooks(filter: RulebookFilter = {}): readonly Rulebook[] {
    assertObject(filter, 'filter')
    const providerId =
      filter.providerId === undefined
        ? undefined
        : requireIdentifier(filter.providerId, 'providerId')
    return this.store.listRulebooks(providerId)
  }

  getRulebook(id: string): Rulebook | null {
    return this.store.getRulebook(requireIdentifier(id, 'rulebookId'))
  }

  /**
   * Looks up the rulebook created from one external import entry identity
   * (#31). Scoped to the authenticated provider, so one provider cannot
   * discover another provider's import identities. Import-internal; the public
   * read API remains `getRulebook`/`listRulebooks`.
   */
  findImportedRulebook(accessToken: string, importKey: string): Rulebook | null {
    const actor = this.authenticate(accessToken)
    return this.store.findRulebookByImportKey(
      actor.providerId,
      requireSha256Digest(importKey, 'importKey'),
    )
  }

  listAttestations(rulebookId: string): readonly AttestationType[] {
    const id = requireIdentifier(rulebookId, 'rulebookId')
    this.requireRulebook(id)
    return this.store.listAttestations(id)
  }

  listSchemaReferences(rulebookId: string): readonly SchemaReference[] {
    const id = requireIdentifier(rulebookId, 'rulebookId')
    this.requireRulebook(id)
    return this.store.listSchemaReferences(id)
  }

  createRulebook(accessToken: string, input: CreateRulebookInput): Rulebook {
    const rulebooks = this.createRulebooks(accessToken, [input])
    const rulebook = rulebooks[0]
    if (rulebook === undefined) {
      throw new Error('createRulebooks returned no rulebook')
    }
    return rulebook
  }

  /**
   * Creates several rulebooks in one transaction, so a catalog import either
   * writes every entry or none (#30). Validation and identifier generation run
   * before the transaction; any failure there leaves the database untouched.
   */
  createRulebooks(
    accessToken: string,
    inputs: readonly CreateRulebookInput[],
  ): readonly Rulebook[] {
    const actor = this.authenticate(accessToken)
    assertArray(inputs, 'rulebooks', MAX_RULEBOOKS_PER_BATCH)
    const createdAt = this.now()
    const prepared = inputs.map((input) => this.prepareRulebook(actor, input, createdAt))

    this.transaction(() => {
      for (const item of prepared) {
        this.insertPreparedRulebook(actor, item)
      }
    })()

    return prepared.map((item) => item.rulebook)
  }

  updateRulebook(accessToken: string, rulebookId: string, input: UpdateRulebookInput): Rulebook {
    const actor = this.authenticate(accessToken)
    assertObject(input, 'rulebook')
    const existing = this.requireOwnedDraft(actor, rulebookId)

    const sourceUrl =
      input.sourceUrl === undefined
        ? existing.sourceUrl
        : input.sourceUrl === null
          ? null
          : requireAbsoluteHttpUrl(input.sourceUrl, 'sourceUrl')

    const candidate: Rulebook = {
      ...existing,
      name:
        input.name === undefined ? existing.name : requireText(input.name, 'name', MAX_NAME_LENGTH),
      description:
        input.description === undefined
          ? existing.description
          : requireDescription(input.description, 'description'),
      sourceUrl,
      provenance:
        input.provenance === undefined
          ? existing.provenance
          : requireJsonObject(input.provenance, 'provenance'),
      applicableSpec:
        input.applicableSpec === undefined
          ? existing.applicableSpec
          : requireText(input.applicableSpec, 'applicableSpec', MAX_SPEC_LENGTH),
      metadata:
        input.metadata === undefined
          ? existing.metadata
          : requireJsonObject(input.metadata, 'metadata'),
    }

    const changed = changedFields(existing, candidate)
    if (changed.length === 0) {
      return existing
    }

    const updated: Rulebook = { ...candidate, updatedAt: this.now() }

    this.transaction(() => {
      this.store.updateRulebook(updated)
      this.store.insertAudit({
        at: updated.updatedAt,
        actorProviderId: actor.providerId,
        action: 'rulebook.update',
        entityType: 'rulebook',
        entityId: updated.id,
        detail: { fields: changed },
      })
    })()

    return updated
  }

  deleteRulebook(accessToken: string, rulebookId: string): void {
    const actor = this.authenticate(accessToken)
    const existing = this.requireOwnedDraft(actor, rulebookId)
    // A rulebook reopened for a next draft can still have published versions.
    // Deleting the rulebook would delete those immutable rows, so refuse it.
    if (this.store.countNonDraftRulebookVersions(existing.id) > 0) {
      throw immutable('The rulebook has published or historical versions and cannot be deleted.')
    }
    const attestations = this.store.listAttestations(existing.id)
    const references = this.store.listSchemaReferences(existing.id)

    this.transaction(() => {
      const at = this.now()
      for (const reference of references) {
        this.deleteSchemaReferenceWithAudit(actor, reference, at, 'rulebook.delete')
      }
      for (const attestation of attestations) {
        this.store.deleteAttestation(attestation.id)
        this.store.insertAudit({
          at,
          actorProviderId: actor.providerId,
          action: 'attestation.delete',
          entityType: 'attestation',
          entityId: attestation.id,
          detail: { rulebookId: existing.id, name: attestation.name, reason: 'rulebook.delete' },
        })
      }
      this.store.deleteRulebook(existing.id)
      this.store.insertAudit({
        at,
        actorProviderId: actor.providerId,
        action: 'rulebook.delete',
        entityType: 'rulebook',
        entityId: existing.id,
        detail: { name: existing.name },
      })
    })()
  }

  // -------------------------------------------------------------- attestations

  addAttestation(
    accessToken: string,
    rulebookId: string,
    input: CreateAttestationInput,
  ): AttestationType {
    const actor = this.authenticate(accessToken)
    assertObject(input, 'attestation')
    const rulebook = this.requireOwnedDraft(actor, rulebookId)
    const attestation = this.buildAttestation(rulebook.id, input, 0, this.now())

    if (this.store.findAttestationByName(rulebook.id, attestation.name) !== null) {
      throw conflict(`An attestation type named "${attestation.name}" already exists.`)
    }

    this.transaction(() => {
      this.store.insertAttestation(attestation)
      this.store.insertAudit({
        at: attestation.createdAt,
        actorProviderId: actor.providerId,
        action: 'attestation.create',
        entityType: 'attestation',
        entityId: attestation.id,
        detail: { rulebookId: rulebook.id, name: attestation.name },
      })
      this.store.touchRulebook(rulebook.id, attestation.createdAt)
    })()

    return attestation
  }

  updateAttestation(
    accessToken: string,
    rulebookId: string,
    attestationId: string,
    input: UpdateAttestationInput,
  ): AttestationType {
    const actor = this.authenticate(accessToken)
    assertObject(input, 'attestation')
    const rulebook = this.requireOwnedDraft(actor, rulebookId)
    const existing = this.requireAttestation(rulebook.id, attestationId)

    const name =
      input.name === undefined ? existing.name : requireText(input.name, 'name', MAX_NAME_LENGTH)
    const updated: AttestationType = {
      ...existing,
      name,
      attestationLoS:
        input.attestationLoS === undefined
          ? existing.attestationLoS
          : requireText(input.attestationLoS, 'attestationLoS', MAX_NAME_LENGTH),
      bindingType:
        input.bindingType === undefined
          ? existing.bindingType
          : requireText(input.bindingType, 'bindingType', MAX_NAME_LENGTH),
      supportedFormats:
        input.supportedFormats === undefined
          ? existing.supportedFormats
          : requireStringArray(input.supportedFormats, 'supportedFormats'),
      metadata:
        input.metadata === undefined
          ? existing.metadata
          : requireJsonObject(input.metadata, 'metadata'),
    }

    if (name !== existing.name) {
      const collision = this.store.findAttestationByName(rulebook.id, name)
      if (collision !== null && collision.id !== existing.id) {
        throw conflict(`An attestation type named "${name}" already exists.`)
      }
    }

    const changed = changedFields(existing, updated)
    if (changed.length === 0) {
      return existing
    }

    const at = this.now()
    this.transaction(() => {
      this.store.updateAttestation(updated)
      this.store.insertAudit({
        at,
        actorProviderId: actor.providerId,
        action: 'attestation.update',
        entityType: 'attestation',
        entityId: updated.id,
        detail: { fields: changed },
      })
      this.store.touchRulebook(rulebook.id, at)
    })()

    return updated
  }

  removeAttestation(accessToken: string, rulebookId: string, attestationId: string): void {
    const actor = this.authenticate(accessToken)
    const rulebook = this.requireOwnedDraft(actor, rulebookId)
    const existing = this.requireAttestation(rulebook.id, attestationId)
    const attachedReferences = this.store
      .listSchemaReferences(rulebook.id)
      .filter((reference) => reference.attestationId === existing.id)

    this.transaction(() => {
      const at = this.now()
      for (const reference of attachedReferences) {
        this.deleteSchemaReferenceWithAudit(actor, reference, at, 'attestation.delete')
      }
      this.store.deleteAttestation(existing.id)
      this.store.insertAudit({
        at,
        actorProviderId: actor.providerId,
        action: 'attestation.delete',
        entityType: 'attestation',
        entityId: existing.id,
        detail: { rulebookId: rulebook.id, name: existing.name },
      })
      this.store.touchRulebook(rulebook.id, at)
    })()
  }

  // ----------------------------------------------------------- schema refs

  addSchemaReference(
    accessToken: string,
    rulebookId: string,
    input: CreateSchemaReferenceInput,
  ): SchemaReference {
    const actor = this.authenticate(accessToken)
    assertObject(input, 'schemaReference')
    const rulebook = this.requireOwnedDraft(actor, rulebookId)
    const reference = this.buildSchemaReference(rulebook.id, input, this.now())

    if (
      this.store.findSchemaReferenceByFormat(
        rulebook.id,
        reference.attestationId,
        reference.formatIdentifier,
      ) !== null
    ) {
      throw conflict(
        `A schema reference with formatIdentifier "${reference.formatIdentifier}" already exists in this scope.`,
      )
    }

    this.transaction(() => {
      this.store.insertSchemaReference(reference)
      this.store.insertAudit({
        at: reference.createdAt,
        actorProviderId: actor.providerId,
        action: 'schema_ref.create',
        entityType: 'schema_ref',
        entityId: reference.id,
        detail: { rulebookId: rulebook.id, formatIdentifier: reference.formatIdentifier },
      })
      this.store.touchRulebook(rulebook.id, reference.createdAt)
    })()

    return reference
  }

  updateSchemaReference(
    accessToken: string,
    rulebookId: string,
    schemaReferenceId: string,
    input: UpdateSchemaReferenceInput,
  ): SchemaReference {
    const actor = this.authenticate(accessToken)
    assertObject(input, 'schemaReference')
    const rulebook = this.requireOwnedDraft(actor, rulebookId)
    const existing = this.requireSchemaReference(rulebook.id, schemaReferenceId)

    const attestationId =
      input.attestationId === undefined
        ? existing.attestationId
        : input.attestationId === null
          ? null
          : this.requireAttestation(rulebook.id, input.attestationId).id

    const integrity =
      input.integrity === undefined
        ? existing.integrity
        : input.integrity === null
          ? null
          : requireIntegrity(input.integrity, 'integrity')

    const updated: SchemaReference = {
      ...existing,
      attestationId,
      formatIdentifier:
        input.formatIdentifier === undefined
          ? existing.formatIdentifier
          : requireText(input.formatIdentifier, 'formatIdentifier', MAX_NAME_LENGTH),
      uri: input.uri === undefined ? existing.uri : requireAbsoluteHttpUrl(input.uri, 'uri'),
      integrity,
      metadata:
        input.metadata === undefined
          ? existing.metadata
          : requireJsonObject(input.metadata, 'metadata'),
    }

    const collision = this.store.findSchemaReferenceByFormat(
      rulebook.id,
      updated.attestationId,
      updated.formatIdentifier,
    )
    if (collision !== null && collision.id !== existing.id) {
      throw conflict(
        `A schema reference with formatIdentifier "${updated.formatIdentifier}" already exists in this scope.`,
      )
    }

    const changed = changedFields(existing, updated)
    if (changed.length === 0) {
      return existing
    }

    const at = this.now()
    this.transaction(() => {
      this.store.updateSchemaReference(updated)
      this.store.insertAudit({
        at,
        actorProviderId: actor.providerId,
        action: 'schema_ref.update',
        entityType: 'schema_ref',
        entityId: updated.id,
        detail: { fields: changed },
      })
      this.store.touchRulebook(rulebook.id, at)
    })()

    return updated
  }

  removeSchemaReference(accessToken: string, rulebookId: string, schemaReferenceId: string): void {
    const actor = this.authenticate(accessToken)
    const rulebook = this.requireOwnedDraft(actor, rulebookId)
    const existing = this.requireSchemaReference(rulebook.id, schemaReferenceId)

    this.transaction(() => {
      const at = this.now()
      this.deleteSchemaReferenceWithAudit(actor, existing, at, 'explicit')
      this.store.touchRulebook(rulebook.id, at)
    })()
  }

  // ---------------------------------------------------- versions and artifacts

  /** Public catalogue read of a rulebook's versions in creation order. */
  listRulebookVersions(rulebookId: string): readonly RulebookVersion[] {
    const id = requireIdentifier(rulebookId, 'rulebookId')
    this.requireRulebook(id)
    return this.store.listRulebookVersions(id)
  }

  getRulebookVersion(rulebookId: string, version: string): RulebookVersion | null {
    const id = requireIdentifier(rulebookId, 'rulebookId')
    return this.store.getRulebookVersion(id, requireSemanticVersion(version, 'version'))
  }

  /** Retrieval by content digest, e.g. to look up the exact bytes a run used. */
  findRulebookVersionsByDigest(digest: string): readonly RulebookVersion[] {
    return this.store.findRulebookVersionsByDigest(requireSha256Digest(digest, 'digest'))
  }

  /** A version's exact stored snapshot bytes; `null` when it does not exist. */
  getRulebookVersionContent(rulebookId: string, version: string): RulebookVersionContent | null {
    const record = this.getRulebookVersion(rulebookId, version)
    if (record === null) {
      return null
    }
    const artifact = this.store.getArtifact(record.contentDigest)
    if (artifact === null) {
      // The foreign key makes this unreachable; treat it as a server fault
      // rather than a caller-visible not-found.
      throw new Error('rulebook version references a missing artifact')
    }
    return { version: record, mediaType: artifact.mediaType, bytes: artifact.bytes }
  }

  /**
   * Recomputes the digest over the stored bytes and compares it with the
   * version's recorded digest (FR-002, D-6). `null` when the version does not
   * exist.
   */
  verifyRulebookVersionDigest(
    rulebookId: string,
    version: string,
  ): VersionDigestVerification | null {
    const content = this.getRulebookVersionContent(rulebookId, version)
    if (content === null) {
      return null
    }
    const actualDigest = sha256Hex(content.bytes)
    return {
      version: content.version,
      expectedDigest: content.version.contentDigest,
      actualDigest,
      verified: actualDigest === content.version.contentDigest,
    }
  }

  /**
   * Freezes the rulebook's current draft content as a new draft version. When
   * the rulebook was published, this reopens the working copy for the next
   * version; every already-published version stays immutable.
   */
  createRulebookVersion(
    accessToken: string,
    rulebookId: string,
    input: CreateRulebookVersionInput,
  ): RulebookVersion {
    const actor = this.authenticate(accessToken)
    assertObject(input, 'version')
    const rulebook = this.requireOwnedRulebook(actor, rulebookId)
    if (rulebook.publicationStatus === 'historical') {
      throw immutable('The rulebook is historical; a new version cannot be created for it.')
    }

    const version = requireSemanticVersion(input.version, 'version')
    if (this.store.getRulebookVersion(rulebook.id, version) !== null) {
      throw conflict(`Version "${version}" already exists for this rulebook.`)
    }

    const specVersion = rulebook.applicableSpec
    const bytes = this.buildVersionBytes(rulebook, version, specVersion)
    const contentDigest = sha256Hex(bytes)
    const createdAt = this.now()
    const record: RulebookVersion = {
      id: this.generateId(),
      rulebookId: rulebook.id,
      version,
      status: 'draft',
      contentDigest,
      specVersion,
      provenance:
        input.provenance === undefined
          ? rulebook.provenance
          : requireJsonObject(input.provenance, 'provenance'),
      createdAt,
      publishedAt: null,
    }

    this.transaction(() => {
      this.store.insertArtifactIfAbsent({
        digest: contentDigest,
        mediaType: RULEBOOK_VERSION_MEDIA_TYPE,
        bytes,
        createdAt,
      })
      this.store.insertRulebookVersion(record)
      if (rulebook.publicationStatus === 'published') {
        this.store.setRulebookPublicationStatus(rulebook.id, 'draft', createdAt)
      }
      this.store.insertAudit({
        at: createdAt,
        actorProviderId: actor.providerId,
        action: 'version.create',
        entityType: 'rulebook_version',
        entityId: record.id,
        detail: { rulebookId: rulebook.id, version, contentDigest, specVersion },
      })
    })()

    return record
  }

  /**
   * Re-snapshots the rulebook's current content into an existing draft version.
   * Published and historical versions are immutable and cannot be refreshed.
   */
  refreshDraftRulebookVersion(
    accessToken: string,
    rulebookId: string,
    version: string,
  ): RulebookVersion {
    const actor = this.authenticate(accessToken)
    const rulebook = this.requireOwnedRulebook(actor, rulebookId)
    const label = requireSemanticVersion(version, 'version')
    const existing = this.store.getRulebookVersion(rulebook.id, label)
    if (existing === null) {
      throw notFound('The rulebook version does not exist.')
    }
    if (existing.status !== 'draft') {
      throw immutable(`The version is ${existing.status}; only a draft version can be refreshed.`)
    }

    const specVersion = rulebook.applicableSpec
    const bytes = this.buildVersionBytes(rulebook, label, specVersion)
    const contentDigest = sha256Hex(bytes)
    if (contentDigest === existing.contentDigest && specVersion === existing.specVersion) {
      return existing
    }

    const at = this.now()
    const updated: RulebookVersion = { ...existing, contentDigest, specVersion }
    this.transaction(() => {
      this.store.insertArtifactIfAbsent({
        digest: contentDigest,
        mediaType: RULEBOOK_VERSION_MEDIA_TYPE,
        bytes,
        createdAt: at,
      })
      this.store.updateDraftRulebookVersionContent(existing.id, contentDigest, specVersion)
      this.store.insertAudit({
        at,
        actorProviderId: actor.providerId,
        action: 'version.refresh',
        entityType: 'rulebook_version',
        entityId: existing.id,
        detail: {
          rulebookId: rulebook.id,
          version: label,
          previousDigest: existing.contentDigest,
          contentDigest,
        },
      })
    })()

    return updated
  }

  /**
   * Publishes a draft version after proving its stored snapshot still matches
   * the rulebook's current content. Any previously published version of the
   * same rulebook becomes historical.
   */
  publishRulebookVersion(
    accessToken: string,
    rulebookId: string,
    version: string,
  ): RulebookVersion {
    const actor = this.authenticate(accessToken)
    const rulebook = this.requireOwnedRulebook(actor, rulebookId)
    if (rulebook.publicationStatus === 'historical') {
      throw immutable('The rulebook is historical; its versions cannot be published.')
    }

    const label = requireSemanticVersion(version, 'version')
    const existing = this.store.getRulebookVersion(rulebook.id, label)
    if (existing === null) {
      throw notFound('The rulebook version does not exist.')
    }
    if (existing.status !== 'draft') {
      throw immutable(`The version is ${existing.status}; only a draft version can be published.`)
    }

    // Publishing must not silently freeze content that changed after the draft
    // snapshot was taken; the provider refreshes the draft explicitly.
    const currentBytes = this.buildVersionBytes(rulebook, existing.version, rulebook.applicableSpec)
    if (sha256Hex(currentBytes) !== existing.contentDigest) {
      throw conflict('The draft version content is stale; refresh it before publishing.')
    }

    const supersededVersions = this.store
      .listRulebookVersions(rulebook.id)
      .filter((candidate) => candidate.status === 'published' && candidate.id !== existing.id)
      .map((candidate) => candidate.version)
    const publishedAt = this.now()

    this.transaction(() => {
      this.store.demotePublishedRulebookVersions(rulebook.id)
      this.store.publishRulebookVersion(existing.id, publishedAt)
      this.store.setRulebookPublicationStatus(rulebook.id, 'published', publishedAt)
      this.store.insertAudit({
        at: publishedAt,
        actorProviderId: actor.providerId,
        action: 'version.publish',
        entityType: 'rulebook_version',
        entityId: existing.id,
        detail: {
          rulebookId: rulebook.id,
          version: existing.version,
          contentDigest: existing.contentDigest,
          specVersion: existing.specVersion,
          supersededVersions,
        },
      })
    })()

    return { ...existing, status: 'published', publishedAt }
  }

  // ------------------------------------------------------------------ helpers

  /** Validates and builds one rulebook and its children without writing. */
  private prepareRulebook(
    actor: AuthenticatedActor,
    input: CreateRulebookInput,
    createdAt: string,
  ): PreparedRulebook {
    assertObject(input, 'rulebook')

    const name = requireText(input.name, 'name', MAX_NAME_LENGTH)
    const description =
      input.description === undefined ? '' : requireDescription(input.description, 'description')
    const sourceUrl =
      input.sourceUrl === undefined ? null : requireAbsoluteHttpUrl(input.sourceUrl, 'sourceUrl')
    const provenance =
      input.provenance === undefined ? {} : requireJsonObject(input.provenance, 'provenance')
    const applicableSpec = requireText(input.applicableSpec, 'applicableSpec', MAX_SPEC_LENGTH)
    const importKey =
      input.importKey === undefined ? null : requireSha256Digest(input.importKey, 'importKey')
    const metadata =
      input.metadata === undefined ? {} : requireJsonObject(input.metadata, 'metadata')

    const rulebookId = this.generateId()
    const attestationInputs = input.attestations ?? []
    assertArray(attestationInputs, 'attestations', MAX_ATTESTATIONS_PER_RULEBOOK)
    const attestations = attestationInputs.map((attestation, index) =>
      this.buildAttestation(rulebookId, attestation, index, createdAt),
    )

    const names = new Set<string>()
    for (const attestation of attestations) {
      if (names.has(attestation.name)) {
        throw invalidInput(`attestations must not repeat the name "${attestation.name}"`)
      }
      names.add(attestation.name)
    }

    // Imported rulebooks arrive with their schema references attached to one
    // attestation type (#30). Build and validate them before any write so the
    // whole create is refused without a partial rulebook.
    const schemaReferences: SchemaReference[] = []
    attestationInputs.forEach((attestationInput, index) => {
      const attestation = attestations[index]
      if (attestation === undefined) {
        return
      }
      const referenceInputs = attestationInput.schemaReferences ?? []
      assertArray(
        referenceInputs,
        `attestations[${index}].schemaReferences`,
        MAX_SCHEMA_REFERENCES_PER_ATTESTATION,
      )
      const formats = new Set<string>()
      referenceInputs.forEach((referenceInput, referenceIndex) => {
        const reference = this.buildAttestationSchemaReference(
          attestation,
          referenceInput,
          createdAt,
          `attestations[${index}].schemaReferences[${referenceIndex}]`,
        )
        if (formats.has(reference.formatIdentifier)) {
          throw invalidInput(
            `attestations[${index}].schemaReferences must not repeat the formatIdentifier "${reference.formatIdentifier}"`,
          )
        }
        formats.add(reference.formatIdentifier)
        schemaReferences.push(reference)
      })
    })

    const rulebook: Rulebook = {
      id: rulebookId,
      providerId: actor.providerId,
      name,
      description,
      sourceUrl,
      importKey,
      provenance,
      applicableSpec,
      publicationStatus: 'draft',
      metadata,
      createdAt,
      updatedAt: createdAt,
    }

    return { rulebook, attestations, schemaReferences }
  }

  /** Inserts one prepared rulebook and its children; caller owns the transaction. */
  private insertPreparedRulebook(actor: AuthenticatedActor, prepared: PreparedRulebook): void {
    const { rulebook, attestations, schemaReferences } = prepared
    this.store.insertRulebook(rulebook)
    this.store.insertAudit({
      at: rulebook.createdAt,
      actorProviderId: actor.providerId,
      action: 'rulebook.create',
      entityType: 'rulebook',
      entityId: rulebook.id,
      detail: { name: rulebook.name, applicableSpec: rulebook.applicableSpec },
    })
    for (const attestation of attestations) {
      this.store.insertAttestation(attestation)
      this.store.insertAudit({
        at: attestation.createdAt,
        actorProviderId: actor.providerId,
        action: 'attestation.create',
        entityType: 'attestation',
        entityId: attestation.id,
        detail: { rulebookId: rulebook.id, name: attestation.name },
      })
    }
    for (const reference of schemaReferences) {
      this.store.insertSchemaReference(reference)
      this.store.insertAudit({
        at: reference.createdAt,
        actorProviderId: actor.providerId,
        action: 'schema_ref.create',
        entityType: 'schema_ref',
        entityId: reference.id,
        detail: {
          rulebookId: rulebook.id,
          attestationId: reference.attestationId,
          formatIdentifier: reference.formatIdentifier,
        },
      })
    }
  }

  private deleteSchemaReferenceWithAudit(
    actor: AuthenticatedActor,
    reference: SchemaReference,
    at: string,
    reason: 'explicit' | 'attestation.delete' | 'rulebook.delete',
  ): void {
    this.store.deleteSchemaReference(reference.id)
    this.store.insertAudit({
      at,
      actorProviderId: actor.providerId,
      action: 'schema_ref.delete',
      entityType: 'schema_ref',
      entityId: reference.id,
      detail: {
        rulebookId: reference.rulebookId,
        formatIdentifier: reference.formatIdentifier,
        reason,
      },
    })
  }

  /**
   * Runs a write transaction and keeps the typed error contract if a
   * uniqueness pre-check races with another connection.
   */
  private transaction(action: () => void): () => void {
    return () => {
      try {
        this.database.transaction(action)()
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw conflict('A registry value must be unique and already exists.')
        }
        throw error
      }
    }
  }

  private requireRulebook(id: string): Rulebook {
    const rulebook = this.store.getRulebook(requireIdentifier(id, 'rulebookId'))
    if (rulebook === null) {
      throw notFound('The rulebook does not exist.')
    }
    return rulebook
  }

  private requireOwnedRulebook(actor: AuthenticatedActor, id: string): Rulebook {
    const rulebook = this.requireRulebook(id)
    if (rulebook.providerId !== actor.providerId) {
      throw forbidden()
    }
    return rulebook
  }

  private requireOwnedDraft(actor: AuthenticatedActor, id: string): Rulebook {
    const rulebook = this.requireOwnedRulebook(actor, id)
    if (rulebook.publicationStatus !== 'draft') {
      throw immutable(
        `The rulebook is ${rulebook.publicationStatus}; only draft rulebooks can be changed.`,
      )
    }
    return rulebook
  }

  /** Builds the deterministic snapshot bytes for a rulebook at one version. */
  private buildVersionBytes(rulebook: Rulebook, version: string, specVersion: string): Uint8Array {
    const document = buildRulebookVersionDocument({
      rulebook,
      version,
      specVersion,
      attestations: this.store.listAttestations(rulebook.id),
      schemaReferences: this.store.listSchemaReferences(rulebook.id),
    })
    return serializeRulebookVersion(document)
  }

  private requireAttestation(rulebookId: string, attestationId: string): AttestationType {
    const id = requireIdentifier(attestationId, 'attestationId')
    const attestation = this.store.getAttestation(id)
    if (attestation === null || attestation.rulebookId !== rulebookId) {
      throw notFound('The attestation type does not exist in this rulebook.')
    }
    return attestation
  }

  private requireSchemaReference(rulebookId: string, referenceId: string): SchemaReference {
    const id = requireIdentifier(referenceId, 'schemaReferenceId')
    const reference = this.store.getSchemaReference(id)
    if (reference === null || reference.rulebookId !== rulebookId) {
      throw notFound('The schema reference does not exist in this rulebook.')
    }
    return reference
  }

  private buildAttestation(
    rulebookId: string,
    input: CreateAttestationInput | undefined,
    index: number,
    createdAt: string,
  ): AttestationType {
    assertObject(input, `attestations[${index}]`)
    return {
      id: this.generateId(),
      rulebookId,
      name: requireText(input.name, `attestations[${index}].name`, MAX_NAME_LENGTH),
      attestationLoS: requireText(
        input.attestationLoS,
        `attestations[${index}].attestationLoS`,
        MAX_NAME_LENGTH,
      ),
      bindingType: requireText(
        input.bindingType,
        `attestations[${index}].bindingType`,
        MAX_NAME_LENGTH,
      ),
      supportedFormats:
        input.supportedFormats === undefined
          ? []
          : requireStringArray(input.supportedFormats, `attestations[${index}].supportedFormats`),
      metadata:
        input.metadata === undefined
          ? {}
          : requireJsonObject(input.metadata, `attestations[${index}].metadata`),
      createdAt,
    }
  }

  private buildSchemaReference(
    rulebookId: string,
    input: CreateSchemaReferenceInput,
    createdAt: string,
  ): SchemaReference {
    assertObject(input, 'schemaReference')
    const attestationId =
      input.attestationId === undefined
        ? null
        : this.requireAttestation(rulebookId, input.attestationId).id

    return {
      id: this.generateId(),
      rulebookId,
      attestationId,
      formatIdentifier: requireText(input.formatIdentifier, 'formatIdentifier', MAX_NAME_LENGTH),
      uri: requireAbsoluteHttpUrl(input.uri, 'uri'),
      integrity:
        input.integrity === undefined ? null : requireIntegrity(input.integrity, 'integrity'),
      metadata: input.metadata === undefined ? {} : requireJsonObject(input.metadata, 'metadata'),
      createdAt,
    }
  }

  /** Builds a schema reference for an attestation created in the same call. */
  private buildAttestationSchemaReference(
    attestation: AttestationType,
    input: CreateAttestationSchemaReferenceInput,
    createdAt: string,
    path: string,
  ): SchemaReference {
    assertObject(input, path)
    return {
      id: this.generateId(),
      rulebookId: attestation.rulebookId,
      attestationId: attestation.id,
      formatIdentifier: requireText(
        input.formatIdentifier,
        `${path}.formatIdentifier`,
        MAX_NAME_LENGTH,
      ),
      uri: requireAbsoluteHttpUrl(input.uri, `${path}.uri`),
      integrity:
        input.integrity === undefined
          ? null
          : requireIntegrity(input.integrity, `${path}.integrity`),
      metadata:
        input.metadata === undefined ? {} : requireJsonObject(input.metadata, `${path}.metadata`),
      createdAt,
    }
  }
}
