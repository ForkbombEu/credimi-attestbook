// Deterministic mock capture source (FR-018, issue #47).
//
// The mock source implements both adapter contracts over the local synthetic
// fixtures in `fixtures.ts`. It is the only adapter that ships: it contacts no
// network endpoint, expects no real capture component and is labelled `mock`
// on every result, so an integration test can never mistake it for a live
// `capture-issuer`/`capture-verifier` integration.
//
// It still enforces the boundary a real adapter will: bearer authorization,
// a JSON media type, bounded envelope normalization, a component match,
// idempotency by `captureId`, and opaque cursors. Fault injection in
// `faults`/`simulateFault` exists only to exercise transport-error handling
// deterministically.

import { sha256Hex } from '../../registry/digest'
import { resolveCaptureLimits, type CaptureLimitOverrides, type CaptureLimits } from '../limits'
import { CaptureNormalizer } from '../normalize'
import type { CaptureSourceComponent } from '../types'
import {
  hashCaptureCredential,
  isCaptureCredentialHash,
  MAX_CAPTURE_CREDENTIAL_LENGTH,
  verifyCaptureCredential,
  verifyCaptureCredentialHash,
} from './credentials'
import { captureAdapterError, type CaptureAdapterErrorCode } from './errors'
import { mockCaptureEnvelopes } from './fixtures'
import type {
  CapturePullAdapter,
  CapturePullRequest,
  CapturePullResult,
  CapturePushAdapter,
  CapturePushSubmission,
  CapturePushResult,
  CaptureSource,
} from './types'

/** Default page size when a pull request does not name one. */
export const DEFAULT_MOCK_BATCH_SIZE = 10

/** Default bound on the in-memory idempotency store of one mock source. */
export const DEFAULT_MAX_ACCEPTED_CAPTURES = 1_024

/**
 * Disturbances the mock transport can simulate. They exist so transport-error
 * behaviour can be tested without a network or a flaky remote source.
 */
export const CAPTURE_MOCK_FAULTS = [
  'unavailable',
  'timeout',
  'invalid-response',
  'oversized-response',
] as const
export type CaptureMockFault = (typeof CAPTURE_MOCK_FAULTS)[number]

const FAULT_CODES: Readonly<Record<CaptureMockFault, CaptureAdapterErrorCode>> = {
  unavailable: 'source_unavailable',
  timeout: 'source_timeout',
  'invalid-response': 'invalid_source_response',
  'oversized-response': 'response_too_large',
}

const FAULT_MESSAGES: Readonly<Record<CaptureMockFault, string>> = {
  unavailable: 'the capture source is unavailable',
  timeout: 'the capture source did not answer before the transport deadline',
  'invalid-response': 'the capture source returned a response this adapter cannot interpret',
  'oversized-response': 'the capture source returned more data than the response limit allows',
}

/** Options for one mock source. All are optional except the component. */
export interface MockCaptureSourceOptions {
  readonly component: CaptureSourceComponent
  /** Stable source identifier; defaults to `mock-<component>`. */
  readonly sourceId?: string
  /**
   * SHA-256 hashes of the bearer credentials this source accepts, for both an
   * inbound push and the outbound pull credential. Fails closed when empty.
   */
  readonly acceptedCredentialHashes?: readonly string[]
  /**
   * Credential AttestBook presents when pulling. Only its hash is retained; it
   * is compared to `acceptedCredentialHashes`.
   */
  readonly pullCredential?: string | null
  /** Envelopes to serve; defaults to the synthetic fixtures for the component. */
  readonly envelopes?: readonly unknown[]
  /** Maximum page size a pull may request; defaults to 10. */
  readonly maxBatchSize?: number
  /** Bound on the in-memory idempotency store; defaults to 1024 entries. */
  readonly maxAcceptedCaptures?: number
  readonly limits?: CaptureLimitOverrides
  /** Clock for `receivedAt` and normalization provenance; injectable for tests. */
  readonly now?: () => Date
  /** Faults consumed one per call, in order; for deterministic transport tests. */
  readonly faults?: readonly CaptureMockFault[]
}

interface MockCursorPayload {
  readonly version: 1
  readonly sourceId: string
  readonly offset: number
}

function encodeCursor(sourceId: string, offset: number): string {
  const payload: MockCursorPayload = { version: 1, sourceId, offset }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function isMockCursorPayload(
  value: unknown,
  sourceId: string,
  total: number,
): value is MockCursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    record.version === 1 &&
    record.sourceId === sourceId &&
    typeof record.offset === 'number' &&
    Number.isSafeInteger(record.offset) &&
    record.offset >= 0 &&
    record.offset <= total
  )
}

function decodeCursor(cursor: string | null | undefined, sourceId: string, total: number): number {
  if (cursor === null || cursor === undefined) {
    return 0
  }
  if (typeof cursor !== 'string' || cursor === '') {
    throw captureAdapterError('cursor_expired', 'the pull cursor is not one this source issued')
  }
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
  } catch {
    throw captureAdapterError('cursor_expired', 'the pull cursor is not one this source issued')
  }
  if (!isMockCursorPayload(payload, sourceId, total)) {
    throw captureAdapterError('cursor_expired', 'the pull cursor is not one this source issued')
  }
  return payload.offset
}

function isJsonMediaType(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return (
    mediaType === 'application/json' || mediaType === 'text/json' || mediaType.endsWith('+json')
  )
}

/**
 * A deterministic, offline capture source. It implements both the pull and the
 * push contract; use it as either one through the corresponding interface.
 */
export class MockCaptureSource implements CapturePullAdapter, CapturePushAdapter {
  readonly source: CaptureSource

  private readonly normalizer: CaptureNormalizer
  private readonly now: () => Date
  private readonly envelopes: readonly unknown[]
  private readonly acceptedCredentialHashes: readonly string[]
  private readonly pullCredentialHash: string | null
  private readonly maxBatchSize: number
  private readonly maxAcceptedCaptures: number
  private readonly faults: CaptureMockFault[]
  /** Idempotency state: capture id to the SHA-256 of the accepted submission bytes. */
  private readonly acceptedCaptures = new Map<string, string>()
  private faultIndex = 0

  constructor(options: MockCaptureSourceOptions) {
    const acceptedCredentialHashes = options.acceptedCredentialHashes ?? []
    for (const hash of acceptedCredentialHashes) {
      if (!isCaptureCredentialHash(hash)) {
        throw new RangeError('an accepted capture credential hash must be a lowercase SHA-256 hex')
      }
    }
    const maxBatchSize = options.maxBatchSize ?? DEFAULT_MOCK_BATCH_SIZE
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new RangeError('the mock batch size must be an integer >= 1')
    }
    const maxAcceptedCaptures = options.maxAcceptedCaptures ?? DEFAULT_MAX_ACCEPTED_CAPTURES
    if (!Number.isSafeInteger(maxAcceptedCaptures) || maxAcceptedCaptures < 1) {
      throw new RangeError('the mock accepted-capture limit must be an integer >= 1')
    }
    const limits: CaptureLimits = resolveCaptureLimits(options.limits)
    this.now = options.now ?? (() => new Date())
    this.normalizer = new CaptureNormalizer({ limits, now: this.now })
    // Clone the caller's fixtures so a later mutation cannot invalidate the
    // construction-time check or change what this source serves.
    this.envelopes = structuredClone(options.envelopes ?? mockCaptureEnvelopes(options.component))
    // Fail fast when a configured fixture does not normalize: the mock must
    // never serve evidence the real pipeline would reject.
    for (const envelope of this.envelopes) {
      this.normalizer.normalize(envelope)
    }
    this.acceptedCredentialHashes = [...acceptedCredentialHashes]
    if (
      options.pullCredential !== undefined &&
      options.pullCredential !== null &&
      options.pullCredential.length > MAX_CAPTURE_CREDENTIAL_LENGTH
    ) {
      throw new RangeError('the pull credential is longer than the supported maximum')
    }
    this.pullCredentialHash =
      options.pullCredential === undefined ||
      options.pullCredential === null ||
      options.pullCredential === ''
        ? null
        : hashCaptureCredential(options.pullCredential)
    this.maxBatchSize = maxBatchSize
    this.maxAcceptedCaptures = maxAcceptedCaptures
    const faults = options.faults ?? []
    for (const fault of faults) {
      if (!CAPTURE_MOCK_FAULTS.includes(fault)) {
        throw new RangeError(`unknown mock capture fault: ${String(fault)}`)
      }
    }
    this.faults = [...faults]
    this.source = {
      sourceId: options.sourceId ?? `mock-${options.component}`,
      component: options.component,
      transport: 'mock',
      description: `Deterministic local mock fixtures for ${options.component}; no live capture endpoint is contacted`,
    }
  }

  /** Queues one simulated transport fault for the next pull or push call. */
  simulateFault(fault: CaptureMockFault): void {
    this.faults.push(fault)
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the contract is asynchronous for a future network transport; this mock resolves locally
  async pull(request: CapturePullRequest = {}): Promise<CapturePullResult> {
    this.applyFault()
    if (!verifyCaptureCredentialHash(this.pullCredentialHash, this.acceptedCredentialHashes)) {
      throw captureAdapterError('unauthorized', 'the capture source rejected the pull credential')
    }
    const start = decodeCursor(request.cursor, this.source.sourceId, this.envelopes.length)
    const requested = request.maxArtifacts
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
      throw captureAdapterError('invalid_request', 'maxArtifacts must be an integer >= 1')
    }
    const limit = Math.min(requested ?? this.maxBatchSize, this.maxBatchSize)
    const page = this.envelopes.slice(start, start + limit)
    const artifacts = page.map((envelope) => this.normalizer.normalize(envelope))
    const end = start + artifacts.length
    return {
      source: this.source,
      artifacts,
      nextCursor: end < this.envelopes.length ? encodeCursor(this.source.sourceId, end) : null,
      receivedAt: this.receivedAt(),
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the contract is asynchronous for a future network transport; this mock resolves locally
  async push(submission: CapturePushSubmission): Promise<CapturePushResult> {
    this.applyFault()
    if (!verifyCaptureCredential(submission.authorization, this.acceptedCredentialHashes)) {
      throw captureAdapterError(
        'unauthorized',
        'the capture push did not present a valid credential',
      )
    }
    if (!isJsonMediaType(submission.mediaType)) {
      throw captureAdapterError(
        'unsupported_media_type',
        'a capture push must carry a JSON envelope media type',
      )
    }
    const normalized = this.normalizer.normalizeBytes(submission.bytes)
    if (normalized.envelope.provenance.sourceComponent !== this.source.component) {
      throw captureAdapterError(
        'forbidden',
        'the pushing credential is not authorized for the artifact capture component',
      )
    }
    const captureId = normalized.envelope.captureId
    // Idempotency is over the exact submitted bytes, not just the artifact
    // digest: a changed correlation field or reference is a different capture
    // submission under the same identifier and must conflict.
    const fingerprint = sha256Hex(submission.bytes)
    const previous = this.acceptedCaptures.get(captureId)
    if (previous !== undefined && previous !== fingerprint) {
      throw captureAdapterError(
        'duplicate_conflict',
        'the capture identifier was already accepted with different submission bytes',
      )
    }
    const duplicate = previous !== undefined
    if (!duplicate) {
      if (this.acceptedCaptures.size >= this.maxAcceptedCaptures) {
        throw captureAdapterError(
          'capture_store_full',
          'the capture source accepted-capture store is full',
        )
      }
      // Only the idempotency key and the submission hash are retained; raw
      // submission and artifact bytes are not.
      this.acceptedCaptures.set(captureId, fingerprint)
    }
    return {
      source: this.source,
      normalized,
      duplicate,
      receivedAt: this.receivedAt(),
    }
  }

  private receivedAt(): string {
    const now = this.now()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error('the mock capture clock returned an invalid date')
    }
    return now.toISOString()
  }

  private applyFault(): void {
    const fault = this.faults[this.faultIndex]
    if (fault === undefined) {
      return
    }
    this.faultIndex += 1
    throw captureAdapterError(FAULT_CODES[fault], FAULT_MESSAGES[fault])
  }
}
