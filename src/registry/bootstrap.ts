// Operator-only provider provisioning for the registry.
//
// A provider cannot authenticate before its first credential exists, so
// provisioning cannot itself be a bearer-authenticated operation. It is kept
// out of the `Registry` service on purpose: no HTTP route may expose this
// module (issues #34/#35). An operator runs it during deployment or account
// setup, receives the raw token once and hands it to the provider securely.

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { conflict, isUniqueConstraintError } from './errors'
import { RegistryStore } from './store'
import { generateBearerToken, hashBearerToken } from './tokens'
import type { IssuedToken, Provider, ProvisionedProvider, ProvisionProviderInput } from './types'
import {
  assertObject,
  MAX_NAME_LENGTH,
  requireJsonObject,
  requireLabel,
  requireText,
} from './validation'

export interface ProvisioningOptions {
  /** Clock used for record timestamps; injectable for deterministic tests. */
  readonly now?: () => string
  /** Identifier generator; injectable for deterministic tests. */
  readonly generateId?: () => string
}

/**
 * Creates a provider account and its first bearer token in one transaction.
 * The raw token is returned once and never persisted.
 */
export function provisionProvider(
  database: Database,
  input: ProvisionProviderInput,
  options: ProvisioningOptions = {},
): ProvisionedProvider {
  assertObject(input, 'provider')
  const name = requireText(input.name, 'name', MAX_NAME_LENGTH)
  const publicationAuthority = requireText(
    input.publicationAuthority,
    'publicationAuthority',
    MAX_NAME_LENGTH,
  )
  const metadata = input.metadata === undefined ? {} : requireJsonObject(input.metadata, 'metadata')
  const tokenLabel = requireLabel(input.tokenLabel, 'tokenLabel')

  const now = options.now ?? (() => new Date().toISOString())
  const generateId = options.generateId ?? (() => randomUUID())
  const store = new RegistryStore(database)

  if (store.findProviderByPublicationAuthority(publicationAuthority) !== null) {
    throw conflict('A provider with this publication authority already exists.')
  }

  const providerId = generateId()
  const tokenId = generateId()
  const createdAt = now()
  const secret = generateBearerToken()

  const provider: Provider = {
    id: providerId,
    name,
    publicationAuthority,
    metadata,
    createdAt,
  }
  const token: IssuedToken = {
    id: tokenId,
    providerId,
    label: tokenLabel,
    createdAt,
    revokedAt: null,
    secret,
  }

  const write = database.transaction(() => {
    store.insertProvider(provider)
    store.insertToken(tokenId, providerId, hashBearerToken(secret), tokenLabel, createdAt)
    store.insertAudit({
      at: createdAt,
      actorProviderId: null,
      action: 'provider.provision',
      entityType: 'provider',
      entityId: providerId,
      detail: { name },
    })
    store.insertAudit({
      at: createdAt,
      actorProviderId: providerId,
      action: 'token.issue',
      entityType: 'auth_token',
      entityId: tokenId,
      detail: tokenLabel === null ? null : { label: tokenLabel },
    })
  })

  try {
    write()
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('A provider with this publication authority already exists.')
    }
    throw error
  }

  return { provider, token }
}
