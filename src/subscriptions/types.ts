// Domain types for anonymous webhook subscriptions (issue #117).
//
// These are AttestBook product types, not TS11 or OWF wire types. A
// subscription belongs to one publicly readable rulebook, is registered
// anonymously and is managed by a per-subscription token. This slice stores the
// subscription only: it performs no outbound request and no event delivery.

import type { Database } from 'bun:sqlite'

import type { SubscriptionRegistrationLimiter } from './rate-limit'

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

/** Registration result: the plaintext management token is returned exactly once. */
export interface RegisteredSubscription extends Subscription {
  readonly managementToken: string
}

/** Stored subscription, including the secret material the service needs. */
export interface SubscriptionRecord extends Subscription {
  /** SHA-256 hash of the management token; the plaintext is never stored. */
  readonly managementTokenHash: string
  readonly revokedAt: string | null
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
  /**
   * Test-only opt-in for plain `http` callback URLs on a literal loopback
   * address. It is off by default and is never enabled by the production
   * server wiring.
   */
  readonly allowLoopbackHttp?: boolean
  readonly limits?: SubscriptionLimitOverrides
  readonly rateLimiter?: SubscriptionRegistrationLimiter
}
