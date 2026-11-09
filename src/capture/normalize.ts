// Validation and normalization of untrusted capture artifacts (FR-015/FR-018,
// issue #46).
//
// A submitted envelope is bounded before it is interpreted, then every field
// is validated against the versioned contract. Malformed, ambiguous and
// unsupported submissions are rejected with a stable `CaptureError` code;
// accepted input becomes a metadata-only `CaptureArtifact` plus a segregated
// `CaptureRawArtifact`. Correlation identifiers and the exact capture
// timestamp are preserved; AttestBook only adds its own receipt timestamp.

import { sha256Hex, SHA256_HEX_PATTERN } from '../registry/digest'

import { captureError, type CaptureErrorCode } from './errors'
import { assertBoundedJsonValue, parseBoundedCaptureJson } from './json'
import { resolveCaptureLimits, type CaptureLimitOverrides, type CaptureLimits } from './limits'
import { parseCaptureArtifactReference, requireMediaType } from './reference'
import {
  CAPTURE_ARTIFACT_ENCODINGS,
  CAPTURE_ARTIFACT_KIND,
  CAPTURE_ARTIFACT_TYPES,
  CAPTURE_CREDENTIAL_FORMATS,
  CAPTURE_ENVELOPE_VERSION,
  CAPTURE_INTERACTION_TYPES,
  CAPTURE_PROTOCOLS,
  CAPTURE_REDACTION_STATUSES,
  CAPTURE_SOURCE_COMPONENTS,
  type CaptureArtifact,
  type CaptureArtifactEncoding,
  type CaptureArtifactReference,
  type CaptureArtifactType,
  type CaptureCredentialFormat,
  type CaptureDiagnostic,
  type CaptureIntegrity,
  type CaptureInteractionType,
  type CaptureMetadataValue,
  type CaptureParty,
  type CaptureProtocol,
  type CaptureProvenance,
  type CaptureRawArtifact,
  type CaptureRedaction,
  type CaptureSourceComponent,
  type NormalizedCaptureArtifact,
} from './types'

/** The top-level members envelope version 1 accepts. Unknown ones are rejected. */
const ENVELOPE_MEMBERS = new Set([
  'kind',
  'envelopeVersion',
  'captureId',
  'correlationId',
  'sourceComponent',
  'sourceVersion',
  'capturedAt',
  'interactionType',
  'protocol',
  'credentialFormat',
  'artifactType',
  'artifactRef',
  'artifact',
  'party',
  'testExecutionRef',
  'redaction',
  'integrity',
  'metadata',
])

const INLINE_ARTIFACT_MEMBERS = new Set(['mediaType', 'encoding', 'content', 'byteLength'])
const PARTY_MEMBERS = new Set(['role', 'identifier', 'name'])
const REDACTION_MEMBERS = new Set(['status', 'policyRef', 'redactedPaths', 'redactedDigest'])
const INTEGRITY_MEMBERS = new Set(['algorithm', 'digest'])

const IDENTIFIER_PATTERN = /^[\x21-\x7e]+$/

/** True when a string contains only paired UTF-16 surrogates. */
function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) {
        return false
      }
      index += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}
const SOURCE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const METADATA_KEY_PATTERN = /^[a-z][A-Za-z0-9_.-]{0,63}$/
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~0|~1)*)*$/
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/

/** Options for one normalizer; limits and the clock are injectable for tests. */
export interface CaptureNormalizerOptions {
  readonly limits?: CaptureLimitOverrides
  readonly now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw captureError('invalid_capture', `${field} must be an object`, field)
  }
  return value
}

/**
 * Rejects a member the versioned contract does not define. The member name is
 * deliberately not echoed: it is attacker-controlled and could itself contain
 * sensitive data.
 */
function assertMembers(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw captureError(
        'invalid_capture',
        `${field} contains a member that envelope version ${CAPTURE_ENVELOPE_VERSION} does not define`,
        field,
      )
    }
  }
}

function requireOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    throw captureError('invalid_capture', `${field} must be a non-empty trimmed string`, field)
  }
  if (value.length > maxLength) {
    throw captureError('invalid_capture', `${field} must be at most ${maxLength} characters`, field)
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code === 127) {
      throw captureError('invalid_capture', `${field} must not contain control characters`, field)
    }
  }
  return value
}

function requireIdentifier(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw captureError(
      'invalid_capture',
      `${field} must be a non-empty printable identifier without whitespace`,
      field,
    )
  }
  if (value.length > maxLength) {
    throw captureError('invalid_capture', `${field} must be at most ${maxLength} characters`, field)
  }
  return value
}

function parseEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  code: CaptureErrorCode,
  label: string,
): T {
  if (typeof value !== 'string') {
    throw captureError('invalid_capture', `${field} must be a string`, field)
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw captureError(
      code,
      `${label} is not supported by envelope version ${CAPTURE_ENVELOPE_VERSION}`,
      field,
    )
  }
  return value as T
}

function parseTimestamp(
  value: unknown,
  field: string,
): { readonly text: string; readonly ms: number } {
  if (typeof value !== 'string') {
    throw captureError('invalid_timestamp', `${field} must be an RFC 3339 timestamp`, field)
  }
  const match = RFC3339_PATTERN.exec(value)
  if (match === null) {
    throw captureError(
      'invalid_timestamp',
      `${field} must be an RFC 3339 timestamp with an explicit offset, such as 2026-11-05T09:48:23Z`,
      field,
    )
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[7] === undefined ? 0 : Number(match[7])
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8])
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw captureError('invalid_timestamp', `${field} is not a valid calendar timestamp`, field)
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw captureError('invalid_timestamp', `${field} is not a valid timestamp`, field)
  }
  return { text: value, ms }
}

function parseIntegrity(
  value: unknown,
  field: string,
): { readonly algorithm: 'sha256'; readonly digest: string } {
  const record = requireRecord(value, field)
  assertMembers(record, INTEGRITY_MEMBERS, field)
  if (record.algorithm !== 'sha256') {
    throw captureError(
      'unsupported_integrity_algorithm',
      `${field}.algorithm must be "sha256" in envelope version ${CAPTURE_ENVELOPE_VERSION}`,
      `${field}.algorithm`,
    )
  }
  if (typeof record.digest !== 'string' || !SHA256_HEX_PATTERN.test(record.digest)) {
    throw captureError(
      'invalid_capture',
      `${field}.digest must be a lowercase hexadecimal SHA-256 value`,
      `${field}.digest`,
    )
  }
  return { algorithm: 'sha256', digest: record.digest }
}

interface ParsedInlineArtifact {
  readonly mediaType: string
  readonly encoding: CaptureArtifactEncoding
  readonly bytes: Uint8Array
}

function decodeBase64(content: string, field: string): Uint8Array {
  if (!BASE64_PATTERN.test(content)) {
    throw captureError(
      'invalid_artifact_encoding',
      `${field}.content is not canonical base64`,
      `${field}.content`,
    )
  }
  const bytes = Buffer.from(content, 'base64')
  if (bytes.byteLength === 0 || bytes.toString('base64') !== content) {
    throw captureError(
      'invalid_artifact_encoding',
      `${field}.content is not canonical base64`,
      `${field}.content`,
    )
  }
  return new Uint8Array(bytes)
}

function parseInlineArtifact(
  value: unknown,
  limits: CaptureLimits,
  field: string,
): ParsedInlineArtifact {
  const record = requireRecord(value, field)
  assertMembers(record, INLINE_ARTIFACT_MEMBERS, field)

  const mediaType = requireMediaType(record.mediaType, `${field}.mediaType`)
  const encoding = parseEnum(
    record.encoding ?? 'utf8',
    `${field}.encoding`,
    CAPTURE_ARTIFACT_ENCODINGS,
    'unsupported_encoding',
    'the artifact encoding',
  )
  if (typeof record.content !== 'string' || record.content === '') {
    throw captureError(
      'invalid_capture',
      `${field}.content must be a non-empty string`,
      `${field}.content`,
    )
  }

  let bytes: Uint8Array
  if (encoding === 'base64') {
    bytes = decodeBase64(record.content, field)
  } else {
    if (!isWellFormedString(record.content)) {
      throw captureError(
        'invalid_artifact_encoding',
        `${field}.content contains an unpaired UTF-16 surrogate`,
        `${field}.content`,
      )
    }
    bytes = new TextEncoder().encode(record.content)
  }
  if (bytes.byteLength > limits.maxInlineArtifactBytes) {
    throw captureError(
      'artifact_too_large',
      `${field} exceeds the ${limits.maxInlineArtifactBytes}-byte inline artifact limit`,
      field,
    )
  }
  if (
    record.byteLength !== undefined &&
    (typeof record.byteLength !== 'number' ||
      !Number.isSafeInteger(record.byteLength) ||
      record.byteLength < 0)
  ) {
    throw captureError(
      'invalid_capture',
      `${field}.byteLength must be a non-negative safe integer`,
      `${field}.byteLength`,
    )
  }
  if (record.byteLength !== undefined && record.byteLength !== bytes.byteLength) {
    throw captureError(
      'artifact_size_mismatch',
      `${field}.byteLength does not match the decoded artifact size`,
      `${field}.byteLength`,
    )
  }

  return { mediaType, encoding, bytes }
}

function parseParty(
  value: unknown,
  source: CaptureSourceComponent,
  limits: CaptureLimits,
): CaptureParty {
  const record = requireRecord(value, 'party')
  assertMembers(record, PARTY_MEMBERS, 'party')
  const role = parseEnum(
    record.role,
    'party.role',
    ['issuer', 'verifier'] as const,
    'invalid_capture',
    'the associated party role',
  )
  const expectedRole = source === 'capture-issuer' ? 'issuer' : 'verifier'
  if (role !== expectedRole) {
    throw captureError(
      'invalid_capture',
      `party.role must be "${expectedRole}" for a ${source} artifact`,
      'party.role',
    )
  }
  const identifier = requireOptionalText(
    record.identifier,
    'party.identifier',
    limits.maxPartyIdentifierLength,
  )
  if (identifier === null) {
    throw captureError(
      'invalid_capture',
      'party.identifier must be a non-empty string',
      'party.identifier',
    )
  }
  const name = requireOptionalText(record.name, 'party.name', limits.maxPartyNameLength)
  return { role, identifier, name }
}

function parseRedactedPaths(value: unknown, limits: CaptureLimits): readonly string[] {
  if (!Array.isArray(value)) {
    throw captureError(
      'invalid_redaction',
      'redaction.redactedPaths must be an array',
      'redaction.redactedPaths',
    )
  }
  if (value.length > limits.maxRedactedPaths) {
    throw captureError(
      'redaction_limit',
      `redaction.redactedPaths must contain at most ${limits.maxRedactedPaths} pointers`,
      'redaction.redactedPaths',
    )
  }
  const paths: string[] = []
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      entry === '' ||
      entry.length > limits.maxRedactedPathLength ||
      !JSON_POINTER_PATTERN.test(entry)
    ) {
      throw captureError(
        'invalid_redaction',
        'each redaction.redactedPaths entry must be a bounded JSON Pointer',
        'redaction.redactedPaths',
      )
    }
    paths.push(entry)
  }
  return paths
}

function parseRedaction(
  value: unknown,
  limits: CaptureLimits,
  hasInlineArtifact: boolean,
): CaptureRedaction {
  if (value === undefined || value === null) {
    return { status: 'none', policyRef: null, redactedPaths: [], redactedDigest: null }
  }
  const record = requireRecord(value, 'redaction')
  assertMembers(record, REDACTION_MEMBERS, 'redaction')
  const status = parseEnum(
    record.status,
    'redaction.status',
    CAPTURE_REDACTION_STATUSES,
    'invalid_redaction',
    'the redaction status',
  )
  // An inline artifact is raw by definition: a source cannot claim it is
  // already redacted while embedding it.
  if (hasInlineArtifact && status !== 'none') {
    throw captureError(
      'redaction_inconsistent',
      'an inline artifact cannot declare a partial or full redaction status',
      'redaction.status',
    )
  }

  const policyRef = requireOptionalText(
    record.policyRef,
    'redaction.policyRef',
    limits.maxPolicyRefLength,
  )
  if (status === 'none') {
    const emptyPaths =
      record.redactedPaths === undefined ||
      (Array.isArray(record.redactedPaths) && record.redactedPaths.length === 0)
    const emptyDigest = record.redactedDigest === undefined || record.redactedDigest === null
    if (policyRef !== null || !emptyPaths || !emptyDigest) {
      throw captureError(
        'invalid_redaction',
        'redaction status "none" must not carry a policy, paths or digest',
        'redaction',
      )
    }
    return { status, policyRef: null, redactedPaths: [], redactedDigest: null }
  }
  if (policyRef === null) {
    throw captureError(
      'invalid_redaction',
      'a partial or full redaction status requires redaction.policyRef',
      'redaction.policyRef',
    )
  }

  const redactedPaths =
    record.redactedPaths === undefined ? [] : parseRedactedPaths(record.redactedPaths, limits)
  if (status === 'full' && redactedPaths.length > 0) {
    throw captureError(
      'invalid_redaction',
      'redaction status "full" must not list redacted paths',
      'redaction.redactedPaths',
    )
  }
  let redactedDigest: string | null = null
  if (record.redactedDigest !== undefined && record.redactedDigest !== null) {
    if (
      typeof record.redactedDigest !== 'string' ||
      !SHA256_HEX_PATTERN.test(record.redactedDigest)
    ) {
      throw captureError(
        'invalid_redaction',
        'redaction.redactedDigest must be a lowercase hexadecimal SHA-256 value',
        'redaction.redactedDigest',
      )
    }
    redactedDigest = record.redactedDigest
  }

  return { status, policyRef, redactedPaths, redactedDigest }
}

function parseMetadata(
  value: unknown,
  limits: CaptureLimits,
): Readonly<Record<string, CaptureMetadataValue>> {
  if (value === undefined || value === null) {
    return Object.freeze({})
  }
  const record = requireRecord(value, 'metadata')
  const entries = Object.entries(record)
  if (entries.length > limits.maxMetadataEntries) {
    throw captureError(
      'metadata_limit',
      `metadata must contain at most ${limits.maxMetadataEntries} entries`,
      'metadata',
    )
  }
  const metadata: Record<string, CaptureMetadataValue> = {}
  for (const [key, entry] of entries) {
    if (!METADATA_KEY_PATTERN.test(key)) {
      throw captureError(
        'invalid_capture',
        'metadata member names must start with a lowercase letter and use only letters, digits, "_", "." or "-"',
        'metadata',
      )
    }
    if (entry === null || typeof entry === 'boolean') {
      metadata[key] = entry
      continue
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        throw captureError('invalid_capture', 'metadata numbers must be finite', 'metadata')
      }
      metadata[key] = entry
      continue
    }
    if (typeof entry === 'string') {
      if (entry.length > limits.maxMetadataStringLength) {
        throw captureError(
          'metadata_limit',
          `metadata string values must be at most ${limits.maxMetadataStringLength} characters`,
          'metadata',
        )
      }
      metadata[key] = entry
      continue
    }
    throw captureError(
      'invalid_capture',
      'metadata values must be strings, finite numbers, booleans or null',
      'metadata',
    )
  }
  return Object.freeze(metadata)
}

interface EnvelopeFields {
  readonly captureId: string
  readonly correlationId: string
  readonly sourceComponent: CaptureSourceComponent
  readonly sourceVersion: string | null
  readonly capturedAt: { readonly text: string; readonly ms: number }
  readonly interactionType: CaptureInteractionType
  readonly protocol: CaptureProtocol
  readonly credentialFormat: CaptureCredentialFormat
  readonly artifactType: CaptureArtifactType
}

function parseEnvelopeFields(
  record: Record<string, unknown>,
  limits: CaptureLimits,
): EnvelopeFields {
  const kind = record.kind
  if (kind !== CAPTURE_ARTIFACT_KIND) {
    throw captureError(
      'invalid_capture',
      `the capture envelope kind must be "${CAPTURE_ARTIFACT_KIND}"`,
      'kind',
    )
  }
  if (record.envelopeVersion !== CAPTURE_ENVELOPE_VERSION) {
    throw captureError(
      'unsupported_envelope_version',
      `only envelope version ${CAPTURE_ENVELOPE_VERSION} is supported`,
      'envelopeVersion',
    )
  }

  const captureId = requireIdentifier(record.captureId, 'captureId', limits.maxIdentifierLength)
  const correlationId = requireIdentifier(
    record.correlationId,
    'correlationId',
    limits.maxIdentifierLength,
  )
  const sourceComponent = parseEnum(
    record.sourceComponent,
    'sourceComponent',
    CAPTURE_SOURCE_COMPONENTS,
    'unsupported_source_component',
    'the capture source component',
  )
  const sourceVersion = requireOptionalText(
    record.sourceVersion,
    'sourceVersion',
    limits.maxSourceVersionLength,
  )
  if (sourceVersion !== null && !SOURCE_VERSION_PATTERN.test(sourceVersion)) {
    throw captureError(
      'invalid_capture',
      'sourceVersion must be a version-like string such as "1.2.3"',
      'sourceVersion',
    )
  }
  const capturedAt = parseTimestamp(record.capturedAt, 'capturedAt')
  const interactionType = parseEnum(
    record.interactionType,
    'interactionType',
    CAPTURE_INTERACTION_TYPES,
    'unsupported_interaction_type',
    'the capture interaction type',
  )
  const protocol = parseEnum(
    record.protocol,
    'protocol',
    CAPTURE_PROTOCOLS,
    'unsupported_protocol',
    'the capture protocol',
  )
  const credentialFormat = parseEnum(
    record.credentialFormat,
    'credentialFormat',
    CAPTURE_CREDENTIAL_FORMATS,
    'unsupported_credential_format',
    'the captured credential format',
  )
  const artifactType = parseEnum(
    record.artifactType,
    'artifactType',
    CAPTURE_ARTIFACT_TYPES,
    'unsupported_artifact_type',
    'the capture artifact type',
  )

  return {
    captureId,
    correlationId,
    sourceComponent,
    sourceVersion,
    capturedAt,
    interactionType,
    protocol,
    credentialFormat,
    artifactType,
  }
}

function normalizeEnvelope(
  value: Record<string, unknown>,
  limits: CaptureLimits,
  receivedAt: Date,
): NormalizedCaptureArtifact {
  assertMembers(value, ENVELOPE_MEMBERS, 'capture envelope')
  const fields = parseEnvelopeFields(value, limits)

  const hasRef = value.artifactRef !== undefined && value.artifactRef !== null
  const hasInline = value.artifact !== undefined && value.artifact !== null
  if (hasRef && hasInline) {
    throw captureError(
      'ambiguous_artifact_source',
      'a capture envelope must carry either artifactRef or an inline artifact, not both',
    )
  }
  if (!hasRef && !hasInline) {
    throw captureError(
      'missing_artifact',
      'a capture envelope must carry an artifactRef or an inline artifact',
    )
  }

  let artifactRef: CaptureArtifactReference | null = null
  let inline: ParsedInlineArtifact | null = null
  if (hasRef) {
    artifactRef = parseCaptureArtifactReference(value.artifactRef, limits, 'artifactRef')
  } else {
    inline = parseInlineArtifact(value.artifact, limits, 'artifact')
  }

  const party =
    value.party === undefined || value.party === null
      ? null
      : parseParty(value.party, fields.sourceComponent, limits)

  const integrity = parseIntegrity(value.integrity, 'integrity')
  const redaction = parseRedaction(value.redaction, limits, inline !== null)
  const metadata = parseMetadata(value.metadata, limits)
  const testExecutionRef =
    value.testExecutionRef === undefined || value.testExecutionRef === null
      ? null
      : requireIdentifier(value.testExecutionRef, 'testExecutionRef', limits.maxIdentifierLength)

  const diagnostics: CaptureDiagnostic[] = []
  let verified: boolean
  let sensitive: CaptureRawArtifact | null = null

  if (inline !== null) {
    const digest = sha256Hex(inline.bytes)
    if (digest !== integrity.digest) {
      throw captureError(
        'integrity_mismatch',
        'the inline artifact SHA-256 digest does not match the declared integrity value',
        'integrity.digest',
      )
    }
    verified = true
    sensitive = {
      mediaType: inline.mediaType,
      encoding: inline.encoding,
      byteLength: inline.bytes.byteLength,
      digest,
      bytes: inline.bytes,
    }
  } else {
    verified = false
    diagnostics.push({
      code: 'external_artifact_integrity_unverified',
      message:
        'the artifact is referenced externally; its declared SHA-256 digest was not verified by this normalizer',
      path: 'integrity',
    })
  }

  const provenance: CaptureProvenance = {
    sourceComponent: fields.sourceComponent,
    sourceVersion: fields.sourceVersion,
    capturedAt: fields.capturedAt.text,
    capturedAtMs: fields.capturedAt.ms,
    receivedAt: receivedAt.toISOString(),
    receivedAtMs: receivedAt.getTime(),
  }

  const normalizedIntegrity: CaptureIntegrity = {
    algorithm: 'sha256',
    digest: integrity.digest,
    verified,
  }

  const envelope: CaptureArtifact = {
    kind: CAPTURE_ARTIFACT_KIND,
    envelopeVersion: CAPTURE_ENVELOPE_VERSION,
    captureId: fields.captureId,
    correlationId: fields.correlationId,
    provenance,
    interactionType: fields.interactionType,
    protocol: fields.protocol,
    credentialFormat: fields.credentialFormat,
    artifactType: fields.artifactType,
    artifactRef,
    party,
    testExecutionRef,
    redaction,
    integrity: normalizedIntegrity,
    metadata,
  }

  return { envelope, sensitive, diagnostics }
}

/**
 * Bounded capture artifact normalizer used by every importer, including the
 * mock adapters added with FR-018. It writes nothing and performs no network
 * request.
 */
export class CaptureNormalizer {
  private readonly limits: CaptureLimits
  private readonly now: () => Date

  constructor(options: CaptureNormalizerOptions = {}) {
    this.limits = resolveCaptureLimits(options.limits)
    this.now = options.now ?? (() => new Date())
  }

  /** Parses and normalizes a UTF-8 JSON envelope under the configured limits. */
  normalizeBytes(bytes: Uint8Array): NormalizedCaptureArtifact {
    const parsed = parseBoundedCaptureJson(bytes, this.limits)
    return this.normalize(parsed.value)
  }

  /** Normalizes an already-parsed envelope under the configured limits. */
  normalize(value: unknown): NormalizedCaptureArtifact {
    if (!isRecord(value)) {
      throw captureError('invalid_capture', 'the capture envelope must be a JSON object')
    }
    assertBoundedJsonValue(value, this.limits)
    const receivedAt = this.now()
    if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
      throw new Error('the capture normalizer clock returned an invalid date')
    }
    return normalizeEnvelope(value, this.limits, receivedAt)
  }
}

/** Convenience wrapper for one already-parsed envelope. */
export function normalizeCaptureArtifact(
  value: unknown,
  options: CaptureNormalizerOptions = {},
): NormalizedCaptureArtifact {
  return new CaptureNormalizer(options).normalize(value)
}

/** Convenience wrapper for one UTF-8 JSON capture submission. */
export function parseCaptureArtifact(
  bytes: Uint8Array,
  options: CaptureNormalizerOptions = {},
): NormalizedCaptureArtifact {
  return new CaptureNormalizer(options).normalizeBytes(bytes)
}
