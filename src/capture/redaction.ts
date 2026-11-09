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

import { captureError, isCaptureError } from './errors'
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

/**
 * Member names whose scalar values partial redaction keeps by default. These
 * are non-personal protocol and structural members (issuer/endpoints, format
 * and type selectors, algorithm identifiers, request/response shape and error
 * codes). Every scalar under any other member is redacted: an allow-list means
 * an unknown credential claim or token is removed by default instead of being
 * kept because its name was not predicted.
 */
export const DEFAULT_PRESERVED_CAPTURE_KEYS: readonly string[] = Object.freeze([
  'issuer',
  'credential_issuer',
  'credential_configuration_ids',
  'credential_configuration_id',
  'authorization_servers',
  'credential_endpoint',
  'nonce_endpoint',
  'deferred_credential_endpoint',
  'notification_endpoint',
  'format',
  'credential_format',
  'vct',
  'doctype',
  'scope',
  'alg',
  'typ',
  'kid',
  'cryptographic_binding_methods_supported',
  'credential_signing_alg_values_supported',
  'proof_types_supported',
  'client_id',
  'response_type',
  'response_mode',
  'id',
  'path',
  'intent_to_retain',
  'error',
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
  /** Additional member names whose scalar values partial redaction keeps. */
  readonly preservedKeys?: readonly string[]
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
  readonly preservedKeys: ReadonlySet<string>
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
  const preserved = new Set(DEFAULT_PRESERVED_CAPTURE_KEYS.map(normalizeKeyName))
  if (policy.preservedKeys !== undefined) {
    if (!Array.isArray(policy.preservedKeys) || policy.preservedKeys.length > 64) {
      throw captureError(
        'invalid_redaction',
        'redaction preservedKeys must be an array of <= 64 names',
      )
    }
    for (const key of policy.preservedKeys) {
      if (typeof key !== 'string' || key === '' || key.length > 64) {
        throw captureError(
          'invalid_redaction',
          'each redaction preserved key must be a non-empty string',
        )
      }
      preserved.add(normalizeKeyName(key))
    }
  }
  return {
    mode: policy.mode,
    policyRef,
    placeholder,
    sensitiveKeys: keys,
    preservedKeys: preserved,
  }
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
  parentKey: string | null,
  policy: ReturnType<typeof resolvePolicy>,
  state: RedactionState,
  limits: CaptureLimits,
): unknown {
  if (Array.isArray(value)) {
    // Array items inherit the member name of the array: a credential
    // configuration id list keeps its strings, a grant list does not.
    return value.map((item, index) =>
      redactPartial(item, `${pointer}/${index}`, parentKey, policy, state, limits),
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
      result[key] = redactPartial(item, childPointer, key, policy, state, limits)
    }
    return result
  }
  if (value === null) {
    return null
  }
  if (parentKey !== null && policy.preservedKeys.has(normalizeKeyName(parentKey))) {
    return value
  }
  recordPath(state, pointer, limits)
  return policy.placeholder
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
      : redactPartial(value, '', null, resolved, state, limits)

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

  let redactedBytes: Uint8Array = raw.bytes
  let mediaType = raw.mediaType
  let encoding: 'utf8' | 'base64' = 'utf8'
  let status: CaptureArtifact['redaction']['status'] = 'none'
  let redactedPaths: readonly string[] = []
  let truncated = false

  const fullFallback = (message: string): void => {
    diagnostics.push({ code: 'redaction_full_fallback', message, path: 'artifact' })
    redactedBytes = encodeCaptureText(resolved.placeholder, limits)
    mediaType = 'text/plain'
    encoding = 'utf8'
    status = 'full'
    redactedPaths = []
  }

  if (isJsonMediaType(raw.mediaType)) {
    let document: unknown
    try {
      document = JSON.parse(utf8Decoder.decode(raw.bytes))
    } catch {
      document = undefined
    }
    if (document === undefined) {
      fullFallback(
        'the JSON artifact could not be parsed; every value was redacted and the original structure was not preserved',
      )
    } else {
      try {
        const redacted = redactCaptureDocument(document, policy, limits)
        redactedPaths = redacted.redactedPaths
        truncated = redacted.pathsTruncated
        if (redacted.mode === 'full') {
          redactedBytes = encodeCaptureText(JSON.stringify(redacted.value), limits)
          status = 'full'
        } else if (redacted.redactedValues === 0) {
          // Nothing matched: keep the exact original bytes instead of
          // re-serialising them and claiming a different digest.
          redactedBytes = raw.bytes
          mediaType = raw.mediaType
          encoding = raw.encoding
          status = 'none'
        } else {
          redactedBytes = encodeCaptureText(JSON.stringify(redacted.value), limits)
          status = 'partial'
        }
      } catch (error) {
        if (isCaptureError(error) && error.code === 'json_limit') {
          fullFallback(
            'the JSON artifact exceeds the redaction bounds; every value was redacted and the original structure was not preserved',
          )
        } else {
          throw error
        }
      }
    }
  } else {
    fullFallback(
      'the artifact media type is not JSON; only full redaction is available and the original structure was not preserved',
    )
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
