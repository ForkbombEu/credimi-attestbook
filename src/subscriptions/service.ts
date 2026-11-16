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

import { isHttp1TransportError, type Http1Transport } from '../net/http1'

import {
  subscriptionCallbackUnreachable,
  subscriptionConflict,
  subscriptionNotFound,
  subscriptionRateLimited,
  subscriptionUnauthorized,
  subscriptionVerificationFailed,
  isSubscriptionError,
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
import {
  createSubscriptionVerificationTransport,
  generateSubscriptionChallenge,
  hashSubscriptionChallenge,
  resolveSubscriptionCallbackTarget,
  validateSubscriptionVerificationResponse,
  SUBSCRIPTION_VERIFICATION_TYPE,
  type CallbackHostResolver,
} from './verification'

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
  private readonly generateChallenge: () => string
  private readonly allowLoopbackHttp: boolean
  private readonly resolveCallbackHostname: CallbackHostResolver | undefined
  private readonly verificationTransport: Http1Transport
  private readonly limits: SubscriptionLimits
  private readonly limiter: SubscriptionRegistrationLimiter

  constructor(options: SubscriptionServiceOptions) {
    this.source = options.source
    this.store = new SubscriptionStore(options.database)
    this.now = options.now ?? (() => new Date().toISOString())
    this.generateId = options.generateId ?? (() => randomUUID())
    this.generateManagementToken =
      options.generateManagementToken ?? generateSubscriptionManagementToken
    this.generateChallenge = options.generateChallenge ?? generateSubscriptionChallenge
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? false
    this.resolveCallbackHostname = options.resolveCallbackHostname
    this.verificationTransport =
      options.verificationTransport ?? createSubscriptionVerificationTransport()
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
        verificationChallengeHash: null,
        verificationChallengeExpiresAt: null,
        verificationWindowStartedAt: null,
        verificationAttempts: 0,
        verifiedAt: null,
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

  /**
   * Runs one bounded callback verification with the subscription's management
   * token and activates the subscription only after the endpoint answers with
   * the exact challenge.
   *
   * A fresh single-use challenge is minted per call, stored only as its hash
   * and sent over a pinned, redirect-free HTTP request. A wrong answer, a
   * redirect, an expired challenge, a timeout, an unreachable endpoint or a
   * non-public destination leaves the row `pending` with a typed failure and
   * no delivery eligibility. An already-active subscription is returned
   * without another network request; a revoked one is not found.
   */
  async verify(id: string, managementToken: string | undefined): Promise<Subscription> {
    const record = this.authenticate(id, managementToken)
    if (record.state === 'revoked') {
      throw subscriptionNotFound()
    }
    if (record.state === 'active') {
      // Activation is already final; a retry must not contact the callback
      // again or mint another challenge.
      return publicProjection(record)
    }

    const startedAt = this.now()
    const startedAtMs = Date.parse(startedAt)
    const windowStartMs =
      record.verificationWindowStartedAt === null
        ? null
        : Date.parse(record.verificationWindowStartedAt)
    const withinWindow =
      windowStartMs !== null && startedAtMs - windowStartMs < this.limits.verificationWindowMs
    if (withinWindow && record.verificationAttempts >= this.limits.verificationsPerSubscription) {
      const retryAtMs = (windowStartMs ?? startedAtMs) + this.limits.verificationWindowMs
      throw subscriptionRateLimited(Math.max(1, Math.ceil((retryAtMs - startedAtMs) / 1_000)))
    }

    const challenge = this.generateChallenge()
    const challengeHash = hashSubscriptionChallenge(challenge)
    const expiresAt = new Date(startedAtMs + this.limits.challengeTtlMs).toISOString()
    if (!this.store.beginVerification(record.id, challengeHash, expiresAt, startedAt)) {
      throw subscriptionConflict('A verification attempt is already in progress.')
    }

    const attemptWindowStart =
      withinWindow && record.verificationWindowStartedAt !== null
        ? record.verificationWindowStartedAt
        : startedAt
    const attempts = withinWindow ? record.verificationAttempts + 1 : 1
    this.store.recordVerificationAttempt(record.id, attemptWindowStart, attempts, startedAt)

    const deadlineMs = startedAtMs + this.limits.verificationTimeoutMs
    let activated = false
    try {
      const beforeResolve = deadlineMs - Date.parse(this.now())
      if (beforeResolve <= 0) {
        throw subscriptionCallbackUnreachable(
          'timeout',
          'The callback verification request exceeded its time budget.',
        )
      }
      const target = await resolveSubscriptionCallbackTarget(record.callbackUrl, {
        maxCallbackUrlLength: this.limits.maxCallbackUrlLength,
        allowLoopbackHttp: this.allowLoopbackHttp,
        timeoutMs: beforeResolve,
        ...(this.resolveCallbackHostname === undefined
          ? {}
          : { resolver: this.resolveCallbackHostname }),
      })

      const remaining = deadlineMs - Date.parse(this.now())
      if (remaining <= 0) {
        throw subscriptionCallbackUnreachable(
          'timeout',
          'The callback verification request exceeded its time budget.',
        )
      }

      const response = await this.verificationTransport({
        url: target.url,
        hostname: target.hostname,
        address: target.address,
        family: target.family,
        port: target.port,
        timeoutMs: remaining,
        maxBytes: this.limits.maxVerificationResponseBytes,
        method: 'POST',
        body: Buffer.from(
          JSON.stringify({
            type: SUBSCRIPTION_VERIFICATION_TYPE,
            challenge,
            expiresAt,
          }),
          'utf8',
        ),
        contentType: 'application/json',
        accept: 'application/json',
      })

      if (Date.parse(this.now()) >= Date.parse(expiresAt)) {
        throw subscriptionVerificationFailed(
          'expired_challenge',
          'The verification challenge expired before the callback answered.',
        )
      }
      validateSubscriptionVerificationResponse(response, challenge, {
        maxResponseBytes: this.limits.maxVerificationResponseBytes,
      })

      const verifiedAt = this.now()
      if (!this.store.activate(record.id, challengeHash, verifiedAt)) {
        throw subscriptionConflict(
          'The subscription changed while its callback was being verified.',
        )
      }
      activated = true
      const updated = this.store.get(record.id)
      if (updated === null) {
        throw new Error('the activated subscription disappeared')
      }
      return publicProjection(updated)
    } catch (error) {
      throw this.mapVerificationFailure(error)
    } finally {
      // A failure consumes the challenge: retrying requires a fresh initiation,
      // which is charged to the attempt bound.
      if (!activated) {
        this.store.clearVerificationChallenge(record.id, challengeHash, this.now())
      }
    }
  }

  /** Maps transport failures to safe typed subscription failures. */
  private mapVerificationFailure(error: unknown): unknown {
    if (isSubscriptionError(error)) {
      return error
    }
    if (isHttp1TransportError(error)) {
      if (error.code === 'timeout') {
        return subscriptionCallbackUnreachable(
          'timeout',
          'The callback endpoint did not answer in time.',
        )
      }
      if (error.code === 'response_too_large') {
        return subscriptionVerificationFailed(
          'response_too_large',
          'The callback response exceeded the verification response limit.',
        )
      }
      return subscriptionCallbackUnreachable(
        'network_failure',
        'The callback endpoint could not be reached.',
      )
    }
    return error
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
