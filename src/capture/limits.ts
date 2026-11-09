// Resource limits for untrusted capture artifact import (issue #46).
//
// Capture submissions are untrusted input (specification §15). Every bound
// here is a product safety control, not a normative capture-format limit: the
// envelope bytes, parsed JSON shape, inline artifact size and metadata are
// bounded before any field is interpreted, so a small payload cannot force
// unbounded parsing, memory use or diagnostics.

/** Complete set of limits applied to one capture normalization. */
export interface CaptureLimits {
  /** Maximum accepted envelope size in bytes, before JSON parsing. */
  readonly maxEnvelopeBytes: number
  /** Maximum nesting depth of the parsed envelope. */
  readonly maxJsonDepth: number
  /** Maximum total JSON values (objects, arrays and scalars). */
  readonly maxJsonNodes: number
  /** Maximum length of one JSON string value or member name. */
  readonly maxJsonStringLength: number
  /** Maximum decoded size of one inline artifact in bytes. */
  readonly maxInlineArtifactBytes: number
  /** Maximum length of an external artifact reference URI. */
  readonly maxArtifactRefLength: number
  /** Maximum length of an opaque identifier (`captureId`, `correlationId`). */
  readonly maxIdentifierLength: number
  /** Maximum length of the source component version. */
  readonly maxSourceVersionLength: number
  /** Maximum length of an associated party identifier. */
  readonly maxPartyIdentifierLength: number
  /** Maximum length of an associated party display name. */
  readonly maxPartyNameLength: number
  /** Maximum number of scalar metadata entries in one envelope. */
  readonly maxMetadataEntries: number
  /** Maximum length of one metadata string value. */
  readonly maxMetadataStringLength: number
  /** Maximum number of JSON Pointers recorded for partial redaction. */
  readonly maxRedactedPaths: number
  /** Maximum length of one redacted JSON Pointer. */
  readonly maxRedactedPathLength: number
  /** Maximum length of a redaction policy reference. */
  readonly maxPolicyRefLength: number
}

/**
 * Default envelope limits. The inline artifact cap keeps a submission small;
 * the envelope cap accommodates the base64 expansion of that artifact plus the
 * metadata around it. The JSON bounds reject pathological documents early.
 */
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = Object.freeze({
  maxEnvelopeBytes: 512 * 1024,
  maxJsonDepth: 24,
  maxJsonNodes: 4_096,
  maxJsonStringLength: 384 * 1024,
  maxInlineArtifactBytes: 256 * 1024,
  maxArtifactRefLength: 2_048,
  maxIdentifierLength: 200,
  maxSourceVersionLength: 64,
  maxPartyIdentifierLength: 2_048,
  maxPartyNameLength: 200,
  maxMetadataEntries: 32,
  maxMetadataStringLength: 512,
  maxRedactedPaths: 64,
  maxRedactedPathLength: 256,
  maxPolicyRefLength: 200,
})

export type CaptureLimitOverrides = Partial<CaptureLimits>

const LIMIT_NAMES: readonly (keyof CaptureLimits)[] = [
  'maxEnvelopeBytes',
  'maxJsonDepth',
  'maxJsonNodes',
  'maxJsonStringLength',
  'maxInlineArtifactBytes',
  'maxArtifactRefLength',
  'maxIdentifierLength',
  'maxSourceVersionLength',
  'maxPartyIdentifierLength',
  'maxPartyNameLength',
  'maxMetadataEntries',
  'maxMetadataStringLength',
  'maxRedactedPaths',
  'maxRedactedPathLength',
  'maxPolicyRefLength',
]

/**
 * Applies overrides (used by tests to exercise limits cheaply) after checking
 * every limit is a positive safe integer.
 */
export function resolveCaptureLimits(overrides: CaptureLimitOverrides = {}): CaptureLimits {
  const limits: CaptureLimits = { ...DEFAULT_CAPTURE_LIMITS, ...overrides }
  for (const name of LIMIT_NAMES) {
    const value = limits[name]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`capture limit ${name} must be an integer >= 1`)
    }
  }
  return limits
}
