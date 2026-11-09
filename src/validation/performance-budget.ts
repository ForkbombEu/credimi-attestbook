// Performance budgets for the repeated structural-validation path (issue #53).
//
// The representative fixture is a published rulebook at the registry's
// structural bounds: 64 attestation types, 16 schema references each and
// near-maximum reference URIs, producing a snapshot just under 2 MiB. The
// budgets are deliberately generous ceilings for shared CI runners; the
// measured baseline on the reference environment is far lower (see
// docs/validation-performance.md). The warm-to-cold ratio is the real
// regression check: removing the immutable-snapshot cache makes both paths
// perform the same work, so the ratio approaches 1 and the check fails.

import {
  DEFAULT_SNAPSHOT_CACHE_MAX_BYTES,
  DEFAULT_SNAPSHOT_CACHE_MAX_ENTRIES,
} from './snapshot-cache'

export const VALIDATION_PERFORMANCE_BUDGETS = {
  /** Median wall-clock time for a cache miss at the representative snapshot size. */
  coldMedianMs: 250,
  /** Median wall-clock time for a cache hit at the representative snapshot size. */
  warmMedianMs: 150,
  /** 95th percentile wall-clock time for a cache hit. */
  warmP95Ms: 250,
  /**
   * A cache hit must stay clearly faster than a miss. Without the cache this
   * ratio is ~1; the documented baseline is ~0.6.
   */
  warmToColdMedianRatio: 0.85,
  /** Measured runs per mode in one round. */
  runsPerRound: 20,
  /** Measurement rounds; the best round median is used to reject noise. */
  rounds: 3,
  /** Documented bounds of the default immutable-snapshot cache. */
  cacheMaxEntries: DEFAULT_SNAPSHOT_CACHE_MAX_ENTRIES,
  cacheMaxBytes: DEFAULT_SNAPSHOT_CACHE_MAX_BYTES,
} as const

/** Median of a non-empty sample set. */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('median requires at least one sample')
  }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number)
}

/** Nearest-rank percentile of a non-empty sample set. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    throw new Error('percentile requires at least one sample')
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] as number
}
