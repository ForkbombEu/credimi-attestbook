// Bounded cache of parsed, digest-verified immutable rulebook snapshots
// (issue #53, specification §17).
//
// Validation reads one pinned rulebook version per request. A published or
// historical version is immutable (the registry rejects content updates and
// SQLite triggers protect the rows), so its digest identifies the exact
// snapshot forever. Caching the parsed value avoids repeating the SQLite BLOB
// read and JSON parse for every validation, while the engine still recomputes
// the SHA-256 digest over the cached bytes and rechecks the snapshot identity
// on every run. A cache hit therefore cannot change the validation result or
// skip an integrity check.
//
// Draft versions are deliberately never cached: `refreshDraftRulebookVersion`
// replaces their content in place under the same label. They are cheap to
// re-read and excluding them keeps the cache policy a simple, auditable
// "immutable snapshots only".
//
// Eviction is deterministic least-recently-used and bounded by both an entry
// count and the total stored snapshot bytes, so a registry with many versions
// cannot grow the process without bound.

import type { PublicationStatus } from '../registry/types'

import type { ParsedRulebookSnapshot } from './snapshot'

/** Default maximum number of cached snapshots. */
export const DEFAULT_SNAPSHOT_CACHE_MAX_ENTRIES = 64

/** Default maximum total size of the cached snapshot bytes (16 MiB). */
export const DEFAULT_SNAPSHOT_CACHE_MAX_BYTES = 16 * 2 ** 20

export interface SnapshotCacheLimits {
  readonly maxEntries?: number
  readonly maxBytes?: number
}

/** One cached snapshot. The bytes are an owned copy, not a database view. */
export interface CachedRulebookSnapshot {
  readonly digest: string
  readonly bytes: Uint8Array
  readonly snapshot: ParsedRulebookSnapshot
}

/** Observable cache state, used by tests and the performance benchmark. */
export interface RulebookSnapshotCacheStats {
  readonly entries: number
  readonly bytes: number
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly skippedOversized: number
}

/** Whether a version status is immutable and therefore cacheable. */
export function isImmutableRulebookVersion(status: PublicationStatus): boolean {
  return status === 'published' || status === 'historical'
}

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, got ${String(value)}`)
  }
  return value
}

/**
 * A bounded, digest-keyed cache of parsed immutable rulebook snapshots.
 * Operations are synchronous and the instance is not shared between processes.
 */
export class RulebookSnapshotCache {
  private readonly maxEntries: number
  private readonly maxBytes: number
  /** Insertion order is LRU order: the first entry is the least recent. */
  private readonly entries = new Map<string, CachedRulebookSnapshot>()
  private currentBytes = 0
  private hits = 0
  private misses = 0
  private evictions = 0
  private skippedOversized = 0

  constructor(limits: SnapshotCacheLimits = {}) {
    this.maxEntries = positiveInteger(
      limits.maxEntries,
      'maxEntries',
      DEFAULT_SNAPSHOT_CACHE_MAX_ENTRIES,
    )
    this.maxBytes = positiveInteger(limits.maxBytes, 'maxBytes', DEFAULT_SNAPSHOT_CACHE_MAX_BYTES)
  }

  /** Looks up one digest and marks it as the most recently used entry. */
  get(digest: string): CachedRulebookSnapshot | undefined {
    const cached = this.entries.get(digest)
    if (cached === undefined) {
      this.misses += 1
      return undefined
    }
    this.entries.delete(digest)
    this.entries.set(digest, cached)
    this.hits += 1
    return cached
  }

  /**
   * Stores a parsed snapshot under its content digest. A snapshot larger than
   * the whole byte budget is skipped rather than evicting everything else.
   */
  set(digest: string, bytes: Uint8Array, snapshot: ParsedRulebookSnapshot): void {
    const size = bytes.byteLength
    if (size > this.maxBytes) {
      this.skippedOversized += 1
      return
    }

    const existing = this.entries.get(digest)
    if (existing !== undefined) {
      this.entries.delete(digest)
      this.currentBytes -= existing.bytes.byteLength
    }

    // Own the bytes: the caller's buffer may be reused by the database layer
    // and must not mutate an entry after it was verified.
    this.entries.set(digest, { digest, bytes: Uint8Array.from(bytes), snapshot })
    this.currentBytes += size

    while (
      this.entries.size > 0 &&
      (this.entries.size > this.maxEntries || this.currentBytes > this.maxBytes)
    ) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      const evicted = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (evicted !== undefined) {
        this.currentBytes -= evicted.bytes.byteLength
      }
      this.evictions += 1
    }
  }

  /** Drops every entry and resets the counters. */
  clear(): void {
    this.entries.clear()
    this.currentBytes = 0
    this.hits = 0
    this.misses = 0
    this.evictions = 0
    this.skippedOversized = 0
  }

  stats(): RulebookSnapshotCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.currentBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      skippedOversized: this.skippedOversized,
    }
  }
}
