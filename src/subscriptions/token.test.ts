import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  generateSubscriptionManagementToken,
  hashSubscriptionManagementToken,
  isSubscriptionManagementTokenHash,
  MAX_SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH,
  subscriptionManagementTokenMatches,
  SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH,
  SUBSCRIPTION_MANAGEMENT_TOKEN_PREFIX,
} from './token'

describe('subscription management tokens', () => {
  test('mints a prefixed 256-bit opaque token', () => {
    const token = generateSubscriptionManagementToken()
    expect(token.startsWith(SUBSCRIPTION_MANAGEMENT_TOKEN_PREFIX)).toBe(true)
    expect(token).toHaveLength(SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH)
    expect(generateSubscriptionManagementToken()).not.toBe(token)
  })

  test('stores and verifies only a SHA-256 hash', () => {
    const token = generateSubscriptionManagementToken()
    const hash = hashSubscriptionManagementToken(token)
    expect(hash).toHaveLength(64)
    expect(hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'))
    expect(isSubscriptionManagementTokenHash(hash)).toBe(true)
    expect(hash).not.toContain(token)
    expect(subscriptionManagementTokenMatches(token, hash)).toBe(true)
  })

  test('rejects wrong, empty, oversized and malformed inputs', () => {
    const token = generateSubscriptionManagementToken()
    const hash = hashSubscriptionManagementToken(token)

    expect(subscriptionManagementTokenMatches('ats_wrong', hash)).toBe(false)
    expect(subscriptionManagementTokenMatches('', hash)).toBe(false)
    expect(
      subscriptionManagementTokenMatches(
        'x'.repeat(MAX_SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH + 1),
        hash,
      ),
    ).toBe(false)
    expect(subscriptionManagementTokenMatches(token, 'not-a-hash')).toBe(false)
    expect(isSubscriptionManagementTokenHash('A'.repeat(64))).toBe(false)
  })
})
