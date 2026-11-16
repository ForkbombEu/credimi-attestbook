// Anonymous webhook subscription registration and management (issue #117).
//
// This service stores subscriptions for rulebooks that have been published. It
// never contacts a callback host and never delivers an event: a registration is
// pending and inert, and deletion revokes its future delivery eligibility
// immediately. Publishing and editing rulebooks remain authenticated in the
// registry; this module only reads the public rulebook facts it needs, so it
// cannot weaken provider ownership or the existing write authorization.
//
// Management is by a per-subscription token, never by a provider credential.
// Only the token's SHA-256 hash is stored, an unknown subscription and a wrong
// token are indistinguishable, and no callback URL is returned to a caller
// without that token.

import { randomUUID } from 'node:crypto'

import {
  subscriptionConflict,
  subscriptionNotFound,
  subscriptionRateLimited,
  subscriptionUnauthorized,
} from './errors'
import { resolveSubscriptionLimits } from './limits'
import {
  SubscriptionRegistrationLimiter,
  normalizeSubscriptionClientKey,
  type RegistrationReservation,
} from './rate-limit'
import { SubscriptionStore } from './store'
import {
  generateSubscriptionManagementToken,
  hashSubscriptionManagementToken,
  subscriptionManagementTokenMatches,
} from './token'
import type {
  RegisterSubscriptionInput,
  RegisteredSubscription,
  Subscription,
  SubscriptionLimits,
  SubscriptionRecord,
  SubscriptionServiceOptions,
} from './types'
import { parseSubscriptionCallbackUrl } from './url'

/** Upper bound on a path-supplied subscription identifier. */
export const MAX_SUBSCRIPTION_ID_LENGTH = 128

function publicProjection(record: SubscriptionRecord): Subscription {
  return {
    id: record.id,
    rulebookId: record.rulebookId,
    callbackUrl: record.callbackUrl,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function isPublicRulebook(versions: readonly { readonly status: string }[]): boolean {
  // A rulebook is publicly published once any version is published or was
  // published before supersession. Its working copy may already be a draft for
  // the next version, which must not make the already-public rulebook
  // unsubscribable.
  return versions.some(
    (version) => version.status === 'published' || version.status === 'historical',
  )
}

/**
 * Keeps an unknown-id check from returning before the hash comparison, so the
 * response latency does not disclose whether a subscription id exists.
 */
function equalizeUnknownSubscriptionCheck(presented: string): void {
  // The comparison result is intentionally discarded; hashing and the
  // constant-time comparison are the side effect that matters.
  subscriptionManagementTokenMatches(presented, '0'.repeat(64))
}

export class SubscriptionService {
  private readonly source: SubscriptionServiceOptions['source']
  private readonly store: SubscriptionStore
  private readonly now: () => string
  private readonly generateId: () => string
  private readonly generateManagementToken: () => string
  private readonly allowLoopbackHttp: boolean
  private readonly limits: SubscriptionLimits
  private readonly limiter: SubscriptionRegistrationLimiter

  constructor(options: SubscriptionServiceOptions) {
    this.source = options.source
    this.store = new SubscriptionStore(options.database)
    this.now = options.now ?? (() => new Date().toISOString())
    this.generateId = options.generateId ?? (() => randomUUID())
    this.generateManagementToken =
      options.generateManagementToken ?? generateSubscriptionManagementToken
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? false
    this.limits = resolveSubscriptionLimits(options.limits)
    this.limiter = options.rateLimiter ?? SubscriptionRegistrationLimiter.fromLimits(this.limits)
  }

  /**
   * Registers a pending subscription for an existing, publicly published
   * rulebook. No credential is needed. The plaintext management token is
   * returned exactly once and is never persisted.
   */
  register(input: RegisterSubscriptionInput): RegisteredSubscription {
    const rulebook = this.source.getRulebook(input.rulebookId)
    if (rulebook === null) {
      throw subscriptionNotFound('The requested rulebook does not exist.')
    }

    const callbackUrl = parseSubscriptionCallbackUrl(input.callbackUrl, {
      maxLength: this.limits.maxCallbackUrlLength,
      allowLoopbackHttp: this.allowLoopbackHttp,
    })

    if (!isPublicRulebook(this.source.listRulebookVersions(rulebook.id))) {
      throw subscriptionConflict(
        'The rulebook has no published version, so a subscription cannot follow it yet.',
      )
    }

    if (this.store.countLiveByRulebook(rulebook.id) >= this.limits.maxSubscriptionsPerRulebook) {
      throw subscriptionConflict('This rulebook already has the maximum number of subscriptions.')
    }

    const clientKey = normalizeSubscriptionClientKey(input.clientKey)
    const reservation: RegistrationReservation = this.limiter.tryReserve(clientKey)
    if ('retryAfterSeconds' in reservation) {
      throw subscriptionRateLimited(reservation.retryAfterSeconds)
    }

    try {
      const createdAt = this.now()
      const managementToken = this.generateManagementToken()
      const record: SubscriptionRecord = {
        id: this.generateId(),
        rulebookId: rulebook.id,
        callbackUrl,
        managementTokenHash: hashSubscriptionManagementToken(managementToken),
        state: 'pending',
        createdAt,
        updatedAt: createdAt,
        revokedAt: null,
      }
      this.store.insert(record)
      return { ...publicProjection(record), managementToken }
    } catch (error) {
      // The registration was not stored, so its quota slot must not be spent.
      this.limiter.release(clientKey, reservation.token)
      throw error
    }
  }

  /**
   * Reads one subscription with its management token. A missing, malformed,
   * unknown or foreign token is the same `unauthorized` failure; a revoked
   * subscription is not readable any more.
   */
  get(id: string, managementToken: string | undefined): Subscription {
    const record = this.authenticate(id, managementToken)
    if (record.state === 'revoked') {
      throw subscriptionNotFound()
    }
    return publicProjection(record)
  }

  /**
   * Revokes a subscription with its management token. The first call marks it
   * revoked and every repeat call is a no-op success, so deletion is
   * idempotent while the token binding is retained. Delivery eligibility ends
   * with the state change.
   */
  delete(id: string, managementToken: string | undefined): void {
    const record = this.authenticate(id, managementToken)
    if (record.state === 'revoked') {
      return
    }
    this.store.revoke(record.id, this.now())
  }

  private authenticate(id: string, managementToken: string | undefined): SubscriptionRecord {
    const presented = managementToken ?? ''
    if (id === '' || id.length > MAX_SUBSCRIPTION_ID_LENGTH) {
      equalizeUnknownSubscriptionCheck(presented)
      throw subscriptionUnauthorized()
    }
    const record = this.store.get(id)
    if (record === null) {
      equalizeUnknownSubscriptionCheck(presented)
      throw subscriptionUnauthorized()
    }
    if (!subscriptionManagementTokenMatches(presented, record.managementTokenHash)) {
      throw subscriptionUnauthorized()
    }
    return record
  }
}
