import { describe, expect, test } from 'bun:test'

import { normalizeSubscriptionClientKey } from './rate-limit'

describe('subscription client key normalization', () => {
  test('aggregates IPv6 addresses to their /64 prefix', () => {
    expect(normalizeSubscriptionClientKey('2001:db8:1:2::1')).toBe('ipv6:2001:db8:1:2::/64')
    expect(normalizeSubscriptionClientKey('2001:DB8:1:2:ffff::9')).toBe('ipv6:2001:db8:1:2::/64')
    expect(normalizeSubscriptionClientKey('[2001:db8:1:2::1]')).toBe('ipv6:2001:db8:1:2::/64')
    expect(normalizeSubscriptionClientKey('2001:db8:1:3::1')).toBe('ipv6:2001:db8:1:3::/64')
    expect(normalizeSubscriptionClientKey('2001:db8:1:2::1')).not.toBe(
      normalizeSubscriptionClientKey('2001:db8:1:3::1'),
    )
  })

  test('treats an IPv4-mapped IPv6 address as its IPv4 client', () => {
    expect(normalizeSubscriptionClientKey('203.0.113.7')).toBe('ipv4:203.0.113.7')
    expect(normalizeSubscriptionClientKey('::ffff:203.0.113.7')).toBe('ipv4:203.0.113.7')
    expect(normalizeSubscriptionClientKey('[::ffff:203.0.113.7]')).toBe('ipv4:203.0.113.7')
    // Mapped addresses must not all collapse into one shared /64 bucket.
    expect(normalizeSubscriptionClientKey('::ffff:203.0.113.8')).toBe('ipv4:203.0.113.8')
    expect(normalizeSubscriptionClientKey('::ffff:203.0.113.7')).not.toBe(
      normalizeSubscriptionClientKey('::ffff:203.0.113.8'),
    )
  })

  test('keeps non-address values bounded and maps empty or unknown keys', () => {
    expect(normalizeSubscriptionClientKey('')).toBe('unknown')
    expect(normalizeSubscriptionClientKey('   ')).toBe('unknown')
    expect(normalizeSubscriptionClientKey('unknown')).toBe('unknown')
    expect(normalizeSubscriptionClientKey('x'.repeat(500))).toHaveLength(128)
  })
})
