// AttestBook registry service (issue #28).
//
// This service is the authenticated write path into the registry database.
// Operator-only provider provisioning lives in `bootstrap.ts`. The service
// combines:
//   * bearer-token authentication bound to a provider account (D-10);
//   * service-level ownership enforcement for every mutation;
//   * draft-only mutation, so published/historical state is not silently
//     changed before the versioning issue (#29) adds the lifecycle;
//   * transactional writes with an audit trail.
//
// Public reads need no token. The HTTP API that exposes these operations is
// added by issue #34/#35; this module is intentionally transport-independent.

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

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
  CreateSchemaReferenceInput,
  IssuedToken,
  Provider,
  Rulebook,
  RulebookFilter,
  SchemaReference,
  UpdateAttestationInput,
  UpdateProviderInput,
  UpdateRulebookInput,
  UpdateSchemaReferenceInput,
} from './types'
import {
  assertArray,
  assertObject,
  MAX_ATTESTATIONS_PER_RULEBOOK,
  MAX_NAME_LENGTH,
  MAX_SPEC_LENGTH,
  requireAbsoluteHttpUrl,
  requireDescription,
  requireIdentifier,
  requireIntegrity,
  requireJsonObject,
  requireLabel,
  requireStringArray,
  requireText,
} from './validation'

export interface RegistryOptions {
  readonly database: Database
  /** Clock used for record timestamps; injectable for deterministic tests. */
  readonly now?: () => string
  /** Identifier generator; injectable for deterministic tests. */
  readonly generateId?: () => string
}

const MAX_BEARER_TOKEN_LENGTH = 256

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
    const actor = this.authenticate(accessToken)
    assertObject(input, 'rulebook')

    const name = requireText(input.name, 'name', MAX_NAME_LENGTH)
    const description =
      input.description === undefined ? '' : requireDescription(input.description, 'description')
    const sourceUrl =
      input.sourceUrl === undefined ? null : requireAbsoluteHttpUrl(input.sourceUrl, 'sourceUrl')
    const provenance =
      input.provenance === undefined ? {} : requireJsonObject(input.provenance, 'provenance')
    const applicableSpec = requireText(input.applicableSpec, 'applicableSpec', MAX_SPEC_LENGTH)
    const metadata =
      input.metadata === undefined ? {} : requireJsonObject(input.metadata, 'metadata')

    const createdAt = this.now()
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

    const rulebook: Rulebook = {
      id: rulebookId,
      providerId: actor.providerId,
      name,
      description,
      sourceUrl,
      provenance,
      applicableSpec,
      publicationStatus: 'draft',
      metadata,
      createdAt,
      updatedAt: createdAt,
    }

    this.transaction(() => {
      this.store.insertRulebook(rulebook)
      this.store.insertAudit({
        at: createdAt,
        actorProviderId: actor.providerId,
        action: 'rulebook.create',
        entityType: 'rulebook',
        entityId: rulebookId,
        detail: { name, applicableSpec },
      })
      for (const attestation of attestations) {
        this.store.insertAttestation(attestation)
        this.store.insertAudit({
          at: createdAt,
          actorProviderId: actor.providerId,
          action: 'attestation.create',
          entityType: 'attestation',
          entityId: attestation.id,
          detail: { rulebookId, name: attestation.name },
        })
      }
    })()

    return rulebook
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

  // ------------------------------------------------------------------ helpers

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

  private requireOwnedDraft(actor: AuthenticatedActor, id: string): Rulebook {
    const rulebook = this.requireRulebook(id)
    if (rulebook.providerId !== actor.providerId) {
      throw forbidden()
    }
    if (rulebook.publicationStatus !== 'draft') {
      throw immutable(
        `The rulebook is ${rulebook.publicationStatus}; only draft rulebooks can be changed.`,
      )
    }
    return rulebook
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
}
