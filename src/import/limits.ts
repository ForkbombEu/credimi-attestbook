// Resource limits for untrusted rulebook import (specification §15, issue #30).
//
// Every limit is a product safety control, not a TS11 constraint. Remote
// documents are untrusted: the importer bounds the transfer size, wall-clock
// time, redirect chain, parsed JSON shape and schema-reference fan-out before
// the document reaches the standards adapter or the registry.

import { MAX_RULEBOOKS_PER_BATCH } from '../registry/validation'

/** Complete set of limits applied to one import. */
export interface ImportLimits {
  /** Maximum accepted document size in bytes, before JSON parsing. */
  readonly maxSourceBytes: number
  /** Per-request network timeout in milliseconds. */
  readonly requestTimeoutMs: number
  /** Total wall-clock budget for all redirects of one fetch, in milliseconds. */
  readonly totalTimeoutMs: number
  /** Maximum redirects followed for one URL import. */
  readonly maxRedirects: number
  /** Maximum nesting depth of the parsed JSON document. */
  readonly maxJsonDepth: number
  /** Maximum total JSON values (objects, arrays and scalars). */
  readonly maxJsonNodes: number
  /** Maximum length of one JSON string value or member name. */
  readonly maxJsonStringLength: number
  /** Maximum entries accepted from one catalog envelope. */
  readonly maxCatalogEntries: number
  /** Maximum schema references accepted per imported attestation entry. */
  readonly maxSchemaReferencesPerEntry: number
  /** Maximum length of one schema reference URI. */
  readonly maxSchemaReferenceLength: number
  /** Maximum length of the requested import URL. */
  readonly maxUrlLength: number
}

/**
 * Default Phase 1 limits. `maxSourceBytes` accommodates the largest surveyed
 * catalog (FIDES `aggregated.json`, ~1.4 MB) with a small margin while keeping
 * one import bounded. The JSON limits are far above any valid SchemaMeta or
 * catalog envelope and are sized to reject pathological documents early.
 */
export const DEFAULT_IMPORT_LIMITS: ImportLimits = Object.freeze({
  maxSourceBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 10_000,
  totalTimeoutMs: 15_000,
  maxRedirects: 3,
  maxJsonDepth: 48,
  maxJsonNodes: 20_000,
  maxJsonStringLength: 256 * 1024,
  maxCatalogEntries: 100,
  maxSchemaReferencesPerEntry: 16,
  maxSchemaReferenceLength: 2_048,
  maxUrlLength: 2_048,
})

export type ImportLimitOverrides = Partial<ImportLimits>

const POSITIVE_INTEGER_LIMITS: readonly (keyof ImportLimits)[] = [
  'maxSourceBytes',
  'requestTimeoutMs',
  'totalTimeoutMs',
  'maxRedirects',
  'maxJsonDepth',
  'maxJsonNodes',
  'maxJsonStringLength',
  'maxCatalogEntries',
  'maxSchemaReferencesPerEntry',
  'maxSchemaReferenceLength',
  'maxUrlLength',
]

/**
 * Applies overrides (used by tests to exercise limits cheaply) after checking
 * every limit is a positive safe integer. `maxRedirects` may be zero.
 */
export function resolveImportLimits(overrides: ImportLimitOverrides = {}): ImportLimits {
  const limits: ImportLimits = { ...DEFAULT_IMPORT_LIMITS, ...overrides }

  for (const name of POSITIVE_INTEGER_LIMITS) {
    const value = limits[name]
    const minimum = name === 'maxRedirects' ? 0 : 1
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`import limit ${name} must be an integer >= ${minimum}`)
    }
  }
  if (limits.requestTimeoutMs > limits.totalTimeoutMs) {
    throw new RangeError('import limit requestTimeoutMs must not exceed totalTimeoutMs')
  }

  // The registry's atomic batch is the ceiling for one import; clamping here
  // keeps the preview's compatibility report consistent with the commit.
  return {
    ...limits,
    maxCatalogEntries: Math.min(limits.maxCatalogEntries, MAX_RULEBOOKS_PER_BATCH),
  }
}
