// Redaction of sensitive capture evidence (FR-015, issue #46).
//
// Normalization already keeps a raw inline artifact out of the metadata-only
// envelope. This module adds the second half of the control: a caller that
// needs to log, export or index evidence redacts it with an explicit policy.
// Partial redaction replaces values under sensitive member names with a
// placeholder and records the JSON Pointer of every replacement, so findings
// can still reference an attribute path without exposing its value. Full
// redaction preserves the document shape (member names and array positions)
// and replaces every scalar. Opaque, non-JSON artifacts can only be fully
// redacted, because no safe key-level inspection is possible.

import { sha256Hex } from '../registry/digest'

import { captureError } from './errors'
import { assertBoundedJsonValue, encodeCaptureText } from './json'
import { DEFAULT_CAPTURE_LIMITS, type CaptureLimits } from './limits'
import type {
  CaptureArtifact,
  CaptureDiagnostic,
  CaptureRawArtifact,
  NormalizedCaptureArtifact,
  RedactedCaptureArtifact,
} from './types'

/** Stable identifier of the default capture redaction policy. */
export const DEFAULT_CAPTURE_REDACTION_POLICY_REF = 'attestbook.default-capture-redaction@1'

/** Placeholder that replaces a redacted value. */
export const CAPTURE_REDACTION_PLACEHOLDER = '[redacted]'

/**
 * Member names whose values are redacted by default. Names are compared after
 * lowercasing and removing `_`, `-` and `.`, so `access_token`, `accessToken`
 * and `access-token` match the same entry. Names are chosen for capture
 * evidence: tokens, secrets, keys, credential artifacts, disclosures and
 * personal claims are never safe to keep in a logged projection.
 */
export const DEFAULT_SENSITIVE_CAPTURE_KEYS: readonly string[] = Object.freeze([
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'authorization',
  'api_key',
  'client_secret',
  'password',
  'secret',
  'private_key',
  'credential',
  'credentials',
  'compact_credential',
  'disclosures',
  'disclosure',
  'claims',
  'claim',
  'given_name',
  'family_name',
  'birthdate',
  'birth_date',
  'age',
  'address',
  'email',
  'phone_number',
  'nationalities',
  'picture',
  'personal_administrative_number',
  'subject',
  'sub',
])

/** Key-name suffixes that are always sensitive (`vp_token`, `api_secret`, ...). */
const SENSITIVE_KEY_SUFFIXES = ['token', 'secret', 'password', 'privatekey', 'apikey'] as const

/** Redaction mode: selective by member name, or every scalar. */
export type CaptureRedactionMode = 'partial' | 'full'

/** Policy applied by `redactCaptureDocument`. */
export interface CaptureRedactionPolicy {
  readonly mode: CaptureRedactionMode
  /** Stable policy identifier recorded on the redacted envelope. */
  readonly policyRef?: string
  readonly placeholder?: string
  /** Additional member names to redact, on top of the defaults. */
  readonly sensitiveKeys?: readonly string[]
}

/** A redacted JSON document and the evidence of what was replaced. */
export interface CaptureRedactedDocument {
  readonly value: unknown
  readonly mode: CaptureRedactionMode
  readonly policyRef: string
  readonly placeholder: string
  readonly redactedPaths: readonly string[]
  readonly redactedValues: number
  readonly pathsTruncated: boolean
}

function requirePolicyText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    throw captureError('invalid_redaction', `${field} must be a non-empty trimmed string`, field)
  }
  if (value.length > maxLength) {
    throw captureError(
      'invalid_redaction',
      `${field} must be at most ${maxLength} characters`,
      field,
    )
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code === 127) {
      throw captureError('invalid_redaction', `${field} must not contain control characters`, field)
    }
  }
  return value
}

function normalizeKeyName(key: string): string {
  return key.toLowerCase().replace(/[-_.]/g, '')
}

/** Escapes one JSON Pointer reference token (RFC 6901). */
export function captureJsonPointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function resolvePolicy(
  policy: CaptureRedactionPolicy,
  limits: CaptureLimits,
): {
  readonly mode: CaptureRedactionMode
  readonly policyRef: string
  readonly placeholder: string
  readonly sensitiveKeys: ReadonlySet<string>
} {
  if (policy.mode !== 'partial' && policy.mode !== 'full') {
    throw captureError('invalid_redaction', 'the redaction mode must be "partial" or "full"')
  }
  const policyRef = requirePolicyText(
    policy.policyRef ?? DEFAULT_CAPTURE_REDACTION_POLICY_REF,
    'redaction policyRef',
    limits.maxPolicyRefLength,
  )
  const placeholder = requirePolicyText(
    policy.placeholder ?? CAPTURE_REDACTION_PLACEHOLDER,
    'redaction placeholder',
    64,
  )
  const keys = new Set(DEFAULT_SENSITIVE_CAPTURE_KEYS.map(normalizeKeyName))
  if (policy.sensitiveKeys !== undefined) {
    if (!Array.isArray(policy.sensitiveKeys) || policy.sensitiveKeys.length > 64) {
      throw captureError(
        'invalid_redaction',
        'redaction sensitiveKeys must be an array of <= 64 names',
      )
    }
    for (const key of policy.sensitiveKeys) {
      if (typeof key !== 'string' || key === '' || key.length > 64) {
        throw captureError(
          'invalid_redaction',
          'each redaction sensitive key must be a non-empty string',
        )
      }
      keys.add(normalizeKeyName(key))
    }
  }
  return { mode: policy.mode, policyRef, placeholder, sensitiveKeys: keys }
}

function isSensitiveKey(key: string, sensitiveKeys: ReadonlySet<string>): boolean {
  const normalized = normalizeKeyName(key)
  if (sensitiveKeys.has(normalized)) {
    return true
  }
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

interface RedactionState {
  readonly paths: string[]
  redactedValues: number
  pathsTruncated: boolean
}

function recordPath(state: RedactionState, pointer: string, limits: CaptureLimits): void {
  state.redactedValues += 1
  if (pointer.length > limits.maxRedactedPathLength) {
    state.pathsTruncated = true
    return
  }
  if (state.paths.length >= limits.maxRedactedPaths) {
    state.pathsTruncated = true
    return
  }
  state.paths.push(pointer)
}

function redactPartial(
  value: unknown,
  pointer: string,
  policy: ReturnType<typeof resolvePolicy>,
  state: RedactionState,
  limits: CaptureLimits,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactPartial(item, `${pointer}/${index}`, policy, state, limits),
    )
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const childPointer = `${pointer}/${captureJsonPointerSegment(key)}`
      if (isSensitiveKey(key, policy.sensitiveKeys)) {
        recordPath(state, childPointer, limits)
        result[key] = policy.placeholder
        continue
      }
      result[key] = redactPartial(item, childPointer, policy, state, limits)
    }
    return result
  }
  return value
}

function redactFull(
  value: unknown,
  pointer: string,
  placeholder: string,
  state: RedactionState,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactFull(item, `${pointer}/${index}`, placeholder, state))
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactFull(
        item,
        `${pointer}/${captureJsonPointerSegment(key)}`,
        placeholder,
        state,
      )
    }
    return result
  }
  state.redactedValues += 1
  return placeholder
}

/**
 * Redacts one JSON-compatible value. The input is bounded with the same depth,
 * node and string limits as the envelope, and a `__proto__` member is rejected
 * instead of being copied into the result.
 */
export function redactCaptureDocument(
  value: unknown,
  policy: CaptureRedactionPolicy,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): CaptureRedactedDocument {
  const resolved = resolvePolicy(policy, limits)
  assertBoundedJsonValue(value, limits)

  const state: RedactionState = { paths: [], redactedValues: 0, pathsTruncated: false }
  const redacted =
    resolved.mode === 'full'
      ? redactFull(value, '', resolved.placeholder, state)
      : redactPartial(value, '', resolved, state, limits)

  return {
    value: redacted,
    mode: resolved.mode,
    policyRef: resolved.policyRef,
    placeholder: resolved.placeholder,
    redactedPaths: resolved.mode === 'full' ? [] : state.paths,
    redactedValues: state.redactedValues,
    pathsTruncated: state.pathsTruncated,
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function isJsonMediaType(mediaType: string): boolean {
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

/**
 * Redacts the segregated inline artifact of one normalized capture. The
 * envelope's `integrity` block still describes the *unredacted* original
 * digest (so the original can be verified without retaining it), while
 * `redaction.redactedDigest` describes the redacted bytes returned here.
 *
 * A JSON artifact is redacted structurally. An opaque artifact, or a JSON
 * artifact whose content cannot be parsed, is fully redacted: a caller that
 * asked for partial redaction receives `full` and a diagnostic instead of raw
 * bytes.
 */
export function redactNormalizedCaptureArtifact(
  normalized: NormalizedCaptureArtifact,
  policy: CaptureRedactionPolicy,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): RedactedCaptureArtifact {
  if (normalized.sensitive === null) {
    throw captureError(
      'redaction_unavailable',
      'the capture envelope has no inline artifact to redact; redact the external artifact at its source',
    )
  }
  const raw = normalized.sensitive
  const resolved = resolvePolicy(policy, limits)
  const diagnostics: CaptureDiagnostic[] = []

  let redactedBytes: Uint8Array
  let mediaType = raw.mediaType
  let encoding: 'utf8' | 'base64' = 'utf8'
  let status: CaptureArtifact['redaction']['status']
  let redactedPaths: readonly string[] = []
  let redactedValues = 0
  let truncated = false

  if (isJsonMediaType(raw.mediaType)) {
    let document: unknown
    try {
      document = JSON.parse(utf8Decoder.decode(raw.bytes))
    } catch {
      document = undefined
    }
    if (document === undefined) {
      diagnostics.push({
        code: 'redaction_full_fallback',
        message:
          'the JSON artifact could not be parsed; every value was redacted and the original structure was not preserved',
        path: 'artifact',
      })
      redactedBytes = encodeCaptureText(JSON.stringify(resolved.placeholder), limits)
      mediaType = 'text/plain'
      encoding = 'utf8'
      status = 'full'
    } else {
      const redacted = redactCaptureDocument(document, policy, limits)
      redactedBytes = encodeCaptureText(JSON.stringify(redacted.value), limits)
      redactedPaths = redacted.redactedPaths
      redactedValues = redacted.redactedValues
      truncated = redacted.pathsTruncated
      status = redacted.mode === 'full' ? 'full' : redactedValues > 0 ? 'partial' : 'none'
    }
  } else {
    diagnostics.push({
      code: 'redaction_full_fallback',
      message:
        'the artifact media type is not JSON; only full redaction is available and the original structure was not preserved',
      path: 'artifact',
    })
    redactedBytes = encodeCaptureText(resolved.placeholder, limits)
    mediaType = 'text/plain'
    encoding = 'utf8'
    status = 'full'
  }

  if (truncated) {
    diagnostics.push({
      code: 'redaction_paths_truncated',
      message: 'the redacted path evidence exceeds the configured limit and was truncated',
      path: 'redaction.redactedPaths',
    })
  }

  const redactedSensitive: CaptureRawArtifact = {
    mediaType,
    encoding,
    byteLength: redactedBytes.byteLength,
    digest: sha256Hex(redactedBytes),
    bytes: redactedBytes,
  }

  const redaction =
    status === 'none'
      ? { status, policyRef: null, redactedPaths: [], redactedDigest: null }
      : {
          status,
          policyRef: resolved.policyRef,
          redactedPaths,
          redactedDigest: redactedSensitive.digest,
        }

  return {
    envelope: { ...normalized.envelope, redaction },
    sensitive: redactedSensitive,
    diagnostics,
  }
}
