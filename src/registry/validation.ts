// Input validation for registry writes.
//
// Every value is normalised and bounded before it reaches SQL. Limits are
// product limits (resource-exhaustion control), not TS11 constraints; the
// standards adapter remains responsible for wire-profile validation.

import { SHA256_HEX_PATTERN } from './digest'
import { invalidInput } from './errors'
import type { JsonObject } from './types'

export const MAX_NAME_LENGTH = 200
export const MAX_TEXT_LENGTH = 200
export const MAX_DESCRIPTION_LENGTH = 10_000
export const MAX_URL_LENGTH = 2_048
export const MAX_SPEC_LENGTH = 100
export const MAX_METADATA_BYTES = 65_536
export const MAX_STRING_ARRAY_ITEMS = 32
export const MAX_ATTESTATIONS_PER_RULEBOOK = 64
export const MAX_SCHEMA_REFERENCES_PER_ATTESTATION = 16
export const MAX_INTEGRITY_LENGTH = 256
export const MAX_ID_LENGTH = 128
export const MAX_LABEL_LENGTH = 100
export const MAX_VERSION_LENGTH = 40

const INTEGRITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9+/=_-]+$/
const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:\.(0|[1-9]\d{0,8}))?$/

function describe(value: unknown): string {
  return typeof value === 'string' ? 'a string' : typeof value
}

/** Runtime object guard for values that arrive from an untyped transport. */
export function assertObject(value: unknown, field: string): asserts value is object {
  if (typeof value !== 'object' || value === null) {
    throw invalidInput(`${field} must be an object`)
  }
}

/** Runtime array guard with a resource limit. */
export function assertArray(
  value: unknown,
  field: string,
  maxItems: number,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw invalidInput(`${field} must be an array`)
  }
  if (value.length > maxItems) {
    throw invalidInput(`${field} must contain at most ${maxItems} items`)
  }
}

/**
 * Detects ASCII control characters. Descriptions may keep tabs and newlines;
 * names, identifiers and URLs may not.
 */
function hasControlCharacter(value: string, allowLayoutWhitespace: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code !== 127 && code >= 32) {
      continue
    }
    if (allowLayoutWhitespace && (code === 9 || code === 10 || code === 13)) {
      continue
    }
    return true
  }
  return false
}

/** Requires a trimmed, non-empty, control-character-free string. */
export function requireText(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') {
    throw invalidInput(`${field} must be a string, got ${describe(value)}`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    throw invalidInput(`${field} must not be empty`)
  }
  if (trimmed.length > maxLength) {
    throw invalidInput(`${field} must be at most ${maxLength} characters`)
  }
  if (hasControlCharacter(trimmed, false)) {
    throw invalidInput(`${field} must not contain control characters`)
  }
  return trimmed
}

/** Requires a string of at most `maxLength` characters; empty is allowed. */
export function requireDescription(
  value: unknown,
  field: string,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string {
  if (typeof value !== 'string') {
    throw invalidInput(`${field} must be a string, got ${describe(value)}`)
  }
  if (value.length > maxLength) {
    throw invalidInput(`${field} must be at most ${maxLength} characters`)
  }
  if (hasControlCharacter(value, true)) {
    throw invalidInput(`${field} must not contain control characters`)
  }
  return value
}

export function requireIdentifier(value: unknown, field: string): string {
  return requireText(value, field, MAX_ID_LENGTH)
}

export function requireJsonObject(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidInput(`${field} must be a JSON object`)
  }

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw invalidInput(`${field} must be JSON-serializable`)
  }
  if (serialized === undefined) {
    throw invalidInput(`${field} must be JSON-serializable`)
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
    throw invalidInput(`${field} must serialize to at most ${MAX_METADATA_BYTES} bytes`)
  }

  const parsed: unknown = JSON.parse(serialized)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidInput(`${field} must serialize to a JSON object`)
  }
  // Return the serialized copy so callers cannot mutate stored metadata after
  // the write and the returned value matches exactly what the database holds.
  return parsed as JsonObject
}

/**
 * Requires an absolute `http(s)` URL without embedded credentials. Fetching
 * safety (SSRF, redirects, size limits) belongs to the import issue (#30); the
 * registry only refuses values that cannot be a remote reference at all.
 */
export function requireAbsoluteHttpUrl(value: unknown, field: string): string {
  const raw = requireText(value, field, MAX_URL_LENGTH)

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw invalidInput(`${field} must be an absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidInput(`${field} must use http or https`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidInput(`${field} must not embed credentials`)
  }
  // Store the parsed form: it lowercases the scheme/host and guarantees the
  // value matches the schema's case-sensitive http(s) check. Percent-encoding
  // can expand the value, so re-check the limit on what will be stored.
  if (parsed.href.length > MAX_URL_LENGTH) {
    throw invalidInput(`${field} must be at most ${MAX_URL_LENGTH} characters after normalisation`)
  }
  return parsed.href
}

export function requireStringArray(
  value: unknown,
  field: string,
  maxItems = MAX_STRING_ARRAY_ITEMS,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalidInput(`${field} must be an array of strings`)
  }
  if (value.length > maxItems) {
    throw invalidInput(`${field} must contain at most ${maxItems} items`)
  }
  const items = value.map((item, index) => requireText(item, `${field}[${index}]`))
  if (new Set(items).size !== items.length) {
    throw invalidInput(`${field} must not contain duplicate values`)
  }
  return items
}

export function requireIntegrity(value: unknown, field: string): string {
  const raw = requireText(value, field, MAX_INTEGRITY_LENGTH)
  if (!INTEGRITY_PATTERN.test(raw)) {
    throw invalidInput(`${field} must be a W3C SRI value such as sha256-<base64>`)
  }
  return raw
}

export function requireLabel(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null
  }
  return requireText(value, field, MAX_LABEL_LENGTH)
}

/**
 * Requires a bounded `MAJOR.MINOR` or `MAJOR.MINOR.PATCH` SemVer label
 * (architecture §9 / TS11 §4.5.1). Numeric only: a prerelease or build suffix
 * is not accepted until a slice needs it, so no version is accidentally
 * unordered.
 */
export function requireSemanticVersion(value: unknown, field: string): string {
  const raw = requireText(value, field, MAX_VERSION_LENGTH)
  if (!SEMANTIC_VERSION_PATTERN.test(raw)) {
    throw invalidInput(`${field} must be a semantic version such as 1.0 or 1.0.1`)
  }
  return raw
}

/** Requires a lowercase hexadecimal SHA-256 content digest. */
export function requireSha256Digest(value: unknown, field: string): string {
  const raw = requireText(value, field, 64)
  if (!SHA256_HEX_PATTERN.test(raw)) {
    throw invalidInput(`${field} must be a lowercase hexadecimal SHA-256 digest`)
  }
  return raw
}
