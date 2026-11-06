// Conservative status aggregation (decision D-8).
//
// The overall result must never be more optimistic than the weakest executed
// dimension: a FAIL wins, then INCONCLUSIVE, then NOT_TESTED, and PASS is
// possible only when every applicable dimension PASSed. NOT_APPLICABLE
// dimensions do not weaken a PASS because they were not required.

import type { ValidationDimension, ValidationStatus } from './types'

/**
 * Aggregates per-dimension statuses using D-8. An empty dimension list has no
 * applicable dimension and is therefore NOT_APPLICABLE.
 */
export function aggregateStatus(
  dimensions: readonly Pick<ValidationDimension, 'status'>[],
): ValidationStatus {
  if (dimensions.length === 0) {
    return 'NOT_APPLICABLE'
  }
  const statuses = dimensions.map((dimension) => dimension.status)
  if (statuses.includes('FAIL')) {
    return 'FAIL'
  }
  if (statuses.includes('INCONCLUSIVE')) {
    return 'INCONCLUSIVE'
  }
  if (statuses.includes('NOT_TESTED')) {
    return 'NOT_TESTED'
  }
  if (statuses.includes('PASS')) {
    return 'PASS'
  }
  return 'NOT_APPLICABLE'
}
