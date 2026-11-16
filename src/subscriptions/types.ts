// Domain types for anonymous webhook subscriptions (issue #117).
//
// These are AttestBook product types, not TS11 or OWF wire types. A
// subscription belongs to one publicly readable rulebook, is registered
// anonymously and is managed by a per-subscription token. This slice stores the
// subscription only: it performs no outbound request and no event delivery.

import type { Database } from 'bun:sqlite'

import type { Http1Transport } from '../net/http1'

import type { SubscriptionRegistrationLimiter } from './rate-limit'
import type { CallbackHostResolver } from './verification'

/** Lifecycle states a subscription can be stored in. */
export const SUBSCRIPTION_STATES = ['pending', 'active', 'revoked'] as const
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number]

/** Public projection of one subscription. It never contains the token or hash. */
export interface Subscription {
  /** Opaque, server-generated subscription identifier. */
  readonly id: string
  readonly rulebookId: string
  /** Normalized callback URL; only the holder of the management token may read it. */
  readonly callbackUrl: string
  readonly state: SubscriptionState
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Registration result: the plaintext management token is returned exactly
 * once. When the deployment configured a webhook signing key, the derived
 * webhook verification secret is returned exactly once as well; it is never
 * part of a readable subscription projection.
 */
export interface RegisteredSubscription extends Subscription {
  readonly managementToken: string
  readonly webhookSecret?: string
}

/** Stored subscription, including the secret material the service needs. */
export interface SubscriptionRecord extends Subscription {
  /** SHA-256 hash of the management token; the plaintext is never stored. */
  readonly managementTokenHash: string
  readonly revokedAt: string | null
  /** SHA-256 of the single in-flight verification challenge, or `null`. */
  readonly verificationChallengeHash: string | null
  readonly verificationChallengeExpiresAt: string | null
  /** Start of the current verification-attempt window, or `null`. */
  readonly verificationWindowStartedAt: string | null
  /** Callback verification initiations charged in the current window. */
  readonly verificationAttempts: number
  /** Instant the callback proved control, or `null` while unverified. */
  readonly verifiedAt: string | null
  /**
   * Non-secret fingerprint of the deployment key this subscription was
   * registered under (#119), or `null` when delivery was disabled at
   * registration. A row is delivery-eligible only while this matches the
   * current deployment key; the derived secret itself is never stored.
   */
  readonly webhookKeyId: string | null
}

/** The bounded rulebook facts the subscription service needs. */
export interface SubscriptionRulebook {
  readonly id: string
  readonly publicationStatus: string
}

/** The bounded version fact the subscription service needs. */
export interface SubscriptionVersion {
  readonly status: string
}

/**
 * Read-only source of rulebook state. `Registry` satisfies this interface; the
 * service never writes registry data and never needs the provider identity.
 */
export interface SubscriptionRulebookSource {
  getRulebook(rulebookId: string): SubscriptionRulebook | null
  listRulebookVersions(rulebookId: string): readonly SubscriptionVersion[]
}

/** Product safety bounds and abuse controls for anonymous registration. */
export interface SubscriptionLimits {
  /** Maximum accepted callback URL length, before and after normalization. */
  readonly maxCallbackUrlLength: number
  /** Maximum live (pending or active) subscriptions one rulebook may hold. */
  readonly maxSubscriptionsPerRulebook: number
  /** Successful registrations one client address may create per window. */
  readonly registrationsPerClient: number
  /** Sliding window of the per-client registration quota, in milliseconds. */
  readonly registrationWindowMs: number
  /** Maximum number of client keys the in-process quota tracks. */
  readonly maxRateLimitKeys: number
  /** Time a verification challenge remains valid, in milliseconds. */
  readonly challengeTtlMs: number
  /** Bound on the DNS lookup plus the callback request, in milliseconds. */
  readonly verificationTimeoutMs: number
  /** Maximum callback response body inspected for the challenge acknowledgement. */
  readonly maxVerificationResponseBytes: number
  /** Verification initiations one subscription may trigger per window. */
  readonly verificationsPerSubscription: number
  /** Sliding window of the per-subscription verification attempts, in milliseconds. */
  readonly verificationWindowMs: number
}

export type SubscriptionLimitOverrides = Partial<SubscriptionLimits>

/** Input of one anonymous registration; `callbackUrl` is still unvalidated. */
export interface RegisterSubscriptionInput {
  readonly rulebookId: string
  readonly callbackUrl: unknown
  /** Socket-derived client key used only for the in-process quota. */
  readonly clientKey: string
}

export interface SubscriptionServiceOptions {
  readonly database: Database
  readonly source: SubscriptionRulebookSource
  /** Clock used for record timestamps; injectable for deterministic tests. */
  readonly now?: () => string
  /** Identifier generator; injectable for deterministic tests. */
  readonly generateId?: () => string
  /** Management-token generator; injectable for deterministic tests. */
  readonly generateManagementToken?: () => string
  /** Verification-challenge generator; injectable for deterministic tests. */
  readonly generateChallenge?: () => string
  /**
   * Test-only opt-in for plain `http` callback URLs on a literal loopback
   * address. It is off by default and is never enabled by the production
   * server wiring; the local UAT start script enables it explicitly.
   */
  readonly allowLoopbackHttp?: boolean
  /**
   * Deployment key used to derive the subscriber's webhook verification secret
   * (#119). When absent, registration issues no webhook secret and delivery is
   * disabled; the service never invents a fallback key.
   */
  readonly webhookSigningKey?: Buffer | null
  /** Injectable DNS resolver for callback verification; tests use a fake. */
  readonly resolveCallbackHostname?: CallbackHostResolver
  /** Injectable callback transport; tests use an offline fake. */
  readonly verificationTransport?: Http1Transport
  readonly limits?: SubscriptionLimitOverrides
  readonly rateLimiter?: SubscriptionRegistrationLimiter
}
