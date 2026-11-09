// Unit tests for the bounded immutable-snapshot cache (issue #53).
//
// These cover the deterministic policy rather than timing: only the documented
// limits bound the cache, eviction is least-recently-used, oversized entries are
// skipped, and stored bytes cannot be mutated by the caller.

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_SNAPSHOT_CACHE_MAX_BYTES,
  DEFAULT_SNAPSHOT_CACHE_MAX_ENTRIES,
  isImmutableRulebookVersion,
  RulebookSnapshotCache,
} from './snapshot-cache'
import type { ParsedRulebookSnapshot } from './snapshot'

const SNAPSHOT: ParsedRulebookSnapshot = {
  rulebookId: 'rulebook-1',
  version: '1.0',
  specVersion: 'ts11@1.0.1',
  attestations: [],
}

function cacheEntry(bytes: number): {
  readonly bytes: Uint8Array
  readonly snapshot: ParsedRulebookSnapshot
} {
  return { bytes: new Uint8Array(bytes), snapshot: SNAPSHOT }
}

describe('RulebookSnapshotCache', () => {
  test('uses the documented defaults and starts empty', () => {
    const cache = new RulebookSnapshotCache()
    expect(cache.stats()).toEqual({
      entries: 0,
      bytes: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      skippedOversized: 0,
    })
    expect(DEFAULT_SNAPSHOT_CACHE_MAX_ENTRIES).toBe(64)
    expect(DEFAULT_SNAPSHOT_CACHE_MAX_BYTES).toBe(16 * 2 ** 20)
  })

  test('stores and returns a parsed snapshot, counting hits and misses', () => {
    const cache = new RulebookSnapshotCache()
    const entry = cacheEntry(8)

    expect(cache.get('digest-1')).toBeUndefined()
    cache.set('digest-1', entry.bytes, entry.snapshot)
    const cached = cache.get('digest-1')

    expect(cached?.digest).toBe('digest-1')
    expect(cached?.snapshot).toBe(SNAPSHOT)
    expect(cached?.bytes).toEqual(entry.bytes)
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 8, hits: 1, misses: 1 })
  })

  test('owns the stored bytes so a caller mutation cannot change an entry', () => {
    const cache = new RulebookSnapshotCache()
    const bytes = new Uint8Array([1, 2, 3])

    cache.set('digest-1', bytes, SNAPSHOT)
    bytes[0] = 9

    expect(cache.get('digest-1')?.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('replacing the same digest does not grow the cache', () => {
    const cache = new RulebookSnapshotCache()
    cache.set('digest-1', new Uint8Array(4), SNAPSHOT)
    cache.set('digest-1', new Uint8Array(4), SNAPSHOT)

    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 4, evictions: 0 })
  })

  test('evicts the least recently used entry when the entry limit is reached', () => {
    const cache = new RulebookSnapshotCache({ maxEntries: 2 })
    cache.set('a', new Uint8Array(1), SNAPSHOT)
    cache.set('b', new Uint8Array(1), SNAPSHOT)

    // Accessing `a` makes `b` the least recently used entry.
    expect(cache.get('a')).toBeDefined()
    cache.set('c', new Uint8Array(1), SNAPSHOT)

    expect(cache.get('a')).toBeDefined()
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBeDefined()
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 2, evictions: 1 })
  })

  test('evicts by total byte size even when the entry limit is not reached', () => {
    const cache = new RulebookSnapshotCache({ maxEntries: 10, maxBytes: 10 })
    cache.set('a', new Uint8Array(6), SNAPSHOT)
    cache.set('b', new Uint8Array(6), SNAPSHOT)

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
    expect(cache.stats()).toMatchObject({
      entries: 1,
      bytes: 6,
      evictions: 1,
      skippedOversized: 0,
    })
  })

  test('skips a snapshot larger than the whole byte budget instead of evicting everything', () => {
    const cache = new RulebookSnapshotCache({ maxEntries: 10, maxBytes: 8 })
    cache.set('small', new Uint8Array(4), SNAPSHOT)
    cache.set('huge', new Uint8Array(9), SNAPSHOT)

    expect(cache.get('small')).toBeDefined()
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.stats()).toMatchObject({
      entries: 1,
      bytes: 4,
      evictions: 0,
      skippedOversized: 1,
    })
  })

  test('clear drops entries and resets the counters', () => {
    const cache = new RulebookSnapshotCache()
    cache.set('a', new Uint8Array(4), SNAPSHOT)
    cache.get('a')
    cache.get('missing')
    cache.clear()

    expect(cache.stats()).toEqual({
      entries: 0,
      bytes: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      skippedOversized: 0,
    })
  })

  test.each([
    [{ maxEntries: 0 }],
    [{ maxEntries: -1 }],
    [{ maxEntries: 1.5 }],
    [{ maxEntries: Number.NaN }],
    [{ maxBytes: 0 }],
    [{ maxBytes: -1 }],
    [{ maxBytes: Number.POSITIVE_INFINITY }],
  ])('rejects invalid limits %p', (limits) => {
    expect(() => new RulebookSnapshotCache(limits)).toThrow(RangeError)
  })
})

describe('isImmutableRulebookVersion', () => {
  test('only published and historical versions are immutable', () => {
    expect(isImmutableRulebookVersion('published')).toBe(true)
    expect(isImmutableRulebookVersion('historical')).toBe(true)
    expect(isImmutableRulebookVersion('draft')).toBe(false)
  })
})
