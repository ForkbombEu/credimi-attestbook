// Per-subscription management-token primitives (issue #117).
//
// The raw token is minted once, returned exactly once by the registration
// response and only ever stored as its SHA-256 hash. A management request is
// authenticated by hashing the presented token and comparing it in constant
// time with the stored hash, so the database alone never yields a usable
// management credential.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Prefix of every subscription management token (`attestbook subscription`). */
export const SUBSCRIPTION_MANAGEMENT_TOKEN_PREFIX = 'ats_'

/** 256 random bits encoded with base64url plus the prefix. */
export const SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH = 47

/** Hard bound on a presented token, checked before it is hashed. */
export const MAX_SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH = 128

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

/** Mints a fresh opaque management token. */
export function generateSubscriptionManagementToken(): string {
  return `${SUBSCRIPTION_MANAGEMENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** SHA-256 of a management token, as stored. */
export function hashSubscriptionManagementToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** True when the value has the shape of a stored token hash. */
export function isSubscriptionManagementTokenHash(value: string): boolean {
  return TOKEN_HASH_PATTERN.test(value)
}

/** Constant-time comparison of a presented token against a stored hash. */
export function subscriptionManagementTokenMatches(presented: string, storedHash: string): boolean {
  const normalized = presented.trim()
  if (
    normalized === '' ||
    normalized.length > MAX_SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH ||
    !isSubscriptionManagementTokenHash(storedHash)
  ) {
    return false
  }
  const presentedHash = Buffer.from(hashSubscriptionManagementToken(normalized), 'hex')
  const expectedHash = Buffer.from(storedHash, 'hex')
  return (
    presentedHash.length === expectedHash.length && timingSafeEqual(presentedHash, expectedHash)
  )
}
