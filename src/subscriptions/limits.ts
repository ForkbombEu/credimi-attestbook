// Product safety bounds for anonymous webhook subscription registration
// (issue #117, specification §15).
//
// These are AttestBook abuse controls, not standards constraints. They bound the
// size of a stored callback URL, the number of live subscriptions one rulebook
// may accumulate and the number of registrations one client address may create
// in a sliding window. The registration quota is in-process; the per-rulebook
// bound is enforced against the persistent store.

import type { SubscriptionLimits, SubscriptionLimitOverrides } from './types'

/** Maximum accepted callback URL length in characters. */
export const DEFAULT_MAX_CALLBACK_URL_LENGTH = 2_048

/** Maximum live subscriptions (pending or active) one rulebook may hold. */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_RULEBOOK = 1_000

/** Successful registrations one client address may create per window. */
export const DEFAULT_REGISTRATIONS_PER_CLIENT = 10

/** Sliding window of the per-client registration quota: ten minutes. */
export const DEFAULT_REGISTRATION_WINDOW_MS = 10 * 60 * 1000

/** Maximum number of client keys tracked by the in-process quota. */
export const DEFAULT_MAX_RATE_LIMIT_KEYS = 10_000

/** Time a callback-verification challenge stays valid: five minutes. */
export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000

/** Bound on the DNS lookup plus the callback request: five seconds. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5_000

/** Maximum challenge-acknowledgement body read from a callback: 8 KiB. */
export const DEFAULT_MAX_VERIFICATION_RESPONSE_BYTES = 8 * 1_024

/** Verification initiations one subscription may trigger per window. */
export const DEFAULT_VERIFICATIONS_PER_SUBSCRIPTION = 5

/** Sliding window of the per-subscription verification attempts: ten minutes. */
export const DEFAULT_VERIFICATION_WINDOW_MS = 10 * 60 * 1000

export const DEFAULT_SUBSCRIPTION_LIMITS: SubscriptionLimits = Object.freeze({
  maxCallbackUrlLength: DEFAULT_MAX_CALLBACK_URL_LENGTH,
  maxSubscriptionsPerRulebook: DEFAULT_MAX_SUBSCRIPTIONS_PER_RULEBOOK,
  registrationsPerClient: DEFAULT_REGISTRATIONS_PER_CLIENT,
  registrationWindowMs: DEFAULT_REGISTRATION_WINDOW_MS,
  maxRateLimitKeys: DEFAULT_MAX_RATE_LIMIT_KEYS,
  challengeTtlMs: DEFAULT_CHALLENGE_TTL_MS,
  verificationTimeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
  maxVerificationResponseBytes: DEFAULT_MAX_VERIFICATION_RESPONSE_BYTES,
  verificationsPerSubscription: DEFAULT_VERIFICATIONS_PER_SUBSCRIPTION,
  verificationWindowMs: DEFAULT_VERIFICATION_WINDOW_MS,
})

const LIMIT_NAMES: readonly (keyof SubscriptionLimits)[] = [
  'maxCallbackUrlLength',
  'maxSubscriptionsPerRulebook',
  'registrationsPerClient',
  'registrationWindowMs',
  'maxRateLimitKeys',
  'challengeTtlMs',
  'verificationTimeoutMs',
  'maxVerificationResponseBytes',
  'verificationsPerSubscription',
  'verificationWindowMs',
]

/**
 * Applies test or deployment overrides after checking every bound is a
 * positive safe integer, so a misconfigured service fails at construction.
 */
export function resolveSubscriptionLimits(
  overrides: SubscriptionLimitOverrides = {},
): SubscriptionLimits {
  const limits: SubscriptionLimits = { ...DEFAULT_SUBSCRIPTION_LIMITS, ...overrides }
  for (const name of LIMIT_NAMES) {
    const value = limits[name]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`subscription limit ${name} must be a positive integer`)
    }
  }
  return limits
}
