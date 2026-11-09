// Standalone Credimi integration adapter (FR-020, AC-15, issue #49).
//
// This is an HTTP client for AttestBook's public `/api/v1` API. Credimi uses it
// to list rulebooks, select an attestation type, pin a rulebook version,
// request credential validation, retrieve evidence and correlate capture
// artifacts with a test execution. It reads JSON over HTTP and nothing else:
// it never touches AttestBook's SQLite database and has no dependency on
// Credimi's Temporal, StepCI or PocketBase runtime (or any other Credimi
// package). The transport is the runtime's `fetch`.
//
// Every response is parsed with the API's own Zod contract before it is
// returned, and every pinned request is checked against the evidence the
// server returns, so a contract drift or a changed snapshot becomes a typed
// `invalid_response`/`pin_mismatch` instead of a silently wrong result.

import type { ZodType } from 'zod'

import {
  attestationListResponseSchema,
  captureCorrelationResponseSchema,
  captureExplorerDetailResponseSchema,
  captureExplorerPageSchema,
  compareCaptureRequestSchema,
  correlateCaptureRequestSchema,
  credentialValidationResponseSchema,
  headlessWalletComparisonResponseSchema,
  rulebookPageSchema,
  rulebookResponseSchema,
  rulebookVersionListResponseSchema,
  rulebookVersionResponseSchema,
  validateCredentialRequestSchema,
} from '../../api/schemas'

import {
  assertPinnedComparison,
  assertPinnedCorrelation,
  assertPinnedValidation,
  credimiRulebookPinSchema,
  RULEBOOK_PIN_KIND,
  type CredimiAttestation,
  type CredimiCaptureDetail,
  type CredimiCapturePage,
  type CredimiCaptureQuery,
  type CredimiComparisonInput,
  type CredimiCorrelationInput,
  type CredimiEvidenceCorrelation,
  type CredimiHeadlessWalletComparison,
  type CredimiRulebook,
  type CredimiRulebookPage,
  type CredimiRulebookPin,
  type CredimiRulebookQuery,
  type CredimiRulebookVersion,
  type CredimiValidationEvidence,
  type CredimiValidationInput,
  type PinRulebookInput,
} from './contracts'
import { CredimiAdapterError, isCredimiAdapterError, type CredimiAdapterErrorCode } from './errors'

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000
/** Smallest accepted per-request timeout. */
export const MIN_TIMEOUT_MS = 1
/** Largest accepted per-request timeout. */
export const MAX_TIMEOUT_MS = 120_000
/** Default number of automatic retries of a failed idempotent read. */
export const DEFAULT_RETRIES = 1
/** Largest accepted retry count. */
export const MAX_RETRIES = 3
/** Default delay before retrying an idempotent read. */
export const DEFAULT_RETRY_DELAY_MS = 150
/** Largest accepted retry delay. */
export const MAX_RETRY_DELAY_MS = 10_000
/** Default bound on one parsed JSON response body. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** Largest accepted bound on one parsed JSON response body. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
/** Default page size used by the rulebook and capture reads. */
export const DEFAULT_PAGE_LIMIT = 50
/** Largest page size the API accepts. */
export const MAX_PAGE_LIMIT = 100

const API_PREFIX = '/api/v1'

export interface CredimiAdapterOptions {
  /** Absolute `http`/`https` base URL of the AttestBook deployment. */
  readonly baseUrl: string
  /** Provider bearer token used by authenticated operations. */
  readonly token?: string
  /** Per-attempt timeout in milliseconds (default 10 000). */
  readonly timeoutMs?: number
  /** Automatic retries of a failed idempotent read (default 1, maximum 3). */
  readonly retries?: number
  /** Delay before a retry in milliseconds (default 150). */
  readonly retryDelayMs?: number
  /** Bound on one parsed JSON response body (default 8 MiB). */
  readonly maxResponseBytes?: number
  /** Fetch implementation, injectable for embedding and tests. */
  readonly fetch?: typeof fetch
}

interface RequestOptions<T> {
  readonly operation: string
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly schema: ZodType<T>
  readonly body?: unknown
  readonly token?: string
  /** Only idempotent reads are retried; mutations are always single-shot. */
  readonly retryable: boolean
}

function invalidConfiguration(message: string): CredimiAdapterError {
  return new CredimiAdapterError('invalid_configuration', message)
}

function invalidRequest(message: string): CredimiAdapterError {
  return new CredimiAdapterError('invalid_request', message)
}

function invalidResponse(operation: string, message: string): CredimiAdapterError {
  return new CredimiAdapterError(
    'invalid_response',
    `The AttestBook ${operation} response did not match the documented contract: ${message}.`,
  )
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function requireIntegerInRange(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw invalidConfiguration(`${field} must be an integer between ${min} and ${max}.`)
  }
  return resolved
}

function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest(`${field} must be a non-empty string.`)
  }
  return value
}

function pageParameter(
  value: number | undefined,
  field: string,
  min: number,
  max: number | null,
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value < min || (max !== null && value > max)) {
    const upper = max === null ? 'or greater' : `and at most ${max}`
    throw invalidRequest(`${field} must be an integer of at least ${min} ${upper}.`)
  }
  return String(value)
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidConfiguration('baseUrl must be a non-empty absolute URL.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidConfiguration('baseUrl must be an absolute http or https URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidConfiguration('baseUrl must use the http or https scheme.')
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidConfiguration('baseUrl must not embed credentials; pass the token separately.')
  }
  if (url.search !== '' || url.hash !== '') {
    throw invalidConfiguration('baseUrl must not contain a query string or a fragment.')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

function parseRequest<T>(schema: ZodType<T>, value: unknown, operation: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => (issue.path.length === 0 ? 'body' : issue.path.join('.')))
      .join(', ')
    throw invalidRequest(`The ${operation} request is invalid at: ${fields}.`)
  }
  return parsed.data
}

function timeoutError(operation: string, timeoutMs: number): CredimiAdapterError {
  return new CredimiAdapterError(
    'timeout',
    `The AttestBook ${operation} request timed out after ${timeoutMs} ms.`,
    { retryable: true },
  )
}

function networkError(operation: string, cause: unknown): CredimiAdapterError {
  const detail =
    cause instanceof Error && cause.message.trim() !== '' ? `: ${truncate(cause.message, 300)}` : ''
  return new CredimiAdapterError(
    'network_error',
    `The AttestBook ${operation} request failed before a response was received${detail}.`,
    { retryable: true, cause },
  )
}

function errorCodeForStatus(status: number): CredimiAdapterErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'invalid_input'
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 413:
      return 'payload_too_large'
    case 429:
      return 'unavailable'
    case 500:
      return 'internal_error'
    case 502:
    case 503:
    case 504:
      return 'unavailable'
    default:
      return 'http_error'
  }
}

/** Reads only the documented error envelope; never echoes an unknown body. */
function parseServerError(text: string): {
  readonly code: string | null
  readonly message: string | null
} {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { code: null, message: null }
    }
    const error = (parsed as { readonly error?: unknown }).error
    if (typeof error !== 'object' || error === null) {
      return { code: null, message: null }
    }
    const record = error as { readonly code?: unknown; readonly message?: unknown }
    return {
      code: typeof record.code === 'string' ? record.code : null,
      message: typeof record.message === 'string' ? record.message : null,
    }
  } catch {
    return { code: null, message: null }
  }
}

/**
 * Reads the body with a hard byte bound. The limit is enforced while the stream
 * is consumed, so an oversized or hostile response cannot be buffered first.
 */
async function readBoundedText(
  response: Response,
  maxBytes: number,
  operation: string,
): Promise<string> {
  const body = response.body
  if (body === null) {
    return ''
  }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let total = 0
  try {
    for (;;) {
      // Bun's stream reader is generic over `any`; narrow the one value this
      // function consumes instead of relying on the reader's element type.
      const chunk = (await reader.read()) as {
        readonly done: boolean
        readonly value?: Uint8Array
      }
      if (chunk.done || chunk.value === undefined) {
        break
      }
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new CredimiAdapterError(
          'response_too_large',
          `The AttestBook ${operation} response exceeded the configured ${maxBytes} byte bound.`,
        )
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function responseError(status: number, text: string): CredimiAdapterError {
  const server = parseServerError(text)
  const detail =
    server.message === null
      ? `AttestBook answered HTTP ${status}.`
      : `AttestBook answered HTTP ${status}: ${truncate(server.message, 500)}`
  return new CredimiAdapterError(errorCodeForStatus(status), detail, {
    status,
    serverCode: server.code,
    retryable: status === 429 || status === 502 || status === 503 || status === 504,
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * HTTP client for the AttestBook `/api/v1` API used by Credimi. All reads and
 * writes go through the public API; no AttestBook service or database handle is
 * required. See `docs/credimi-integration.md` for the wire contract.
 */
export class CredimiAdapter {
  private readonly baseUrl: string
  private readonly token: string | undefined
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly retryDelayMs: number
  private readonly maxResponseBytes: number
  private readonly fetchFn: typeof fetch

  constructor(options: CredimiAdapterOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    if (options.token !== undefined && options.token.trim() === '') {
      throw invalidConfiguration('token must be a non-empty string when configured.')
    }
    this.token = options.token
    this.timeoutMs = requireIntegerInRange(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      'timeoutMs',
    )
    this.retries = requireIntegerInRange(
      options.retries,
      DEFAULT_RETRIES,
      0,
      MAX_RETRIES,
      'retries',
    )
    this.retryDelayMs = requireIntegerInRange(
      options.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS,
      0,
      MAX_RETRY_DELAY_MS,
      'retryDelayMs',
    )
    this.maxResponseBytes = requireIntegerInRange(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    )
    const fetchFn = options.fetch ?? fetch
    if (typeof fetchFn !== 'function') {
      throw invalidConfiguration('fetch must be a function.')
    }
    this.fetchFn = fetchFn
  }

  /** Lists the public catalogue, optionally filtered and paginated. */
  async listRulebooks(query: CredimiRulebookQuery = {}): Promise<CredimiRulebookPage> {
    const params = new URLSearchParams()
    if (query.providerId !== undefined) {
      params.set('providerId', requireNonEmptyString(query.providerId, 'providerId'))
    }
    if (query.status !== undefined) {
      params.set('status', query.status)
    }
    const limit = pageParameter(query.limit, 'limit', 1, MAX_PAGE_LIMIT)
    if (limit !== undefined) {
      params.set('limit', limit)
    }
    const offset = pageParameter(query.offset, 'offset', 0, null)
    if (offset !== undefined) {
      params.set('offset', offset)
    }
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`
    return this.requestJson({
      operation: 'rulebook catalogue',
      method: 'GET',
      path: `${API_PREFIX}/rulebooks${suffix}`,
      schema: rulebookPageSchema,
      retryable: true,
    })
  }

  /** Reads one rulebook's public product metadata. */
  async getRulebook(rulebookId: string): Promise<CredimiRulebook> {
    const response = await this.requestJson({
      operation: 'rulebook read',
      method: 'GET',
      path: this.rulebookPath(rulebookId),
      schema: rulebookResponseSchema,
      retryable: true,
    })
    return response.data
  }

  /** Lists the attestation types a rulebook exposes, for selection. */
  async listRulebookAttestations(rulebookId: string): Promise<readonly CredimiAttestation[]> {
    const response = await this.requestJson({
      operation: 'attestation read',
      method: 'GET',
      path: `${this.rulebookPath(rulebookId)}/attestations`,
      schema: attestationListResponseSchema,
      retryable: true,
    })
    return response.data
  }

  /** Lists every version of a rulebook in creation order. */
  async listRulebookVersions(rulebookId: string): Promise<readonly CredimiRulebookVersion[]> {
    const response = await this.requestJson({
      operation: 'rulebook version read',
      method: 'GET',
      path: `${this.rulebookPath(rulebookId)}/versions`,
      schema: rulebookVersionListResponseSchema,
      retryable: true,
    })
    return response.data
  }

  /** Reads one exact version record and its snapshot digest. */
  async getRulebookVersion(rulebookId: string, version: string): Promise<CredimiRulebookVersion> {
    const response = await this.requestJson({
      operation: 'rulebook version read',
      method: 'GET',
      path: `${this.rulebookPath(rulebookId)}/versions/${encodeURIComponent(
        requireNonEmptyString(version, 'version'),
      )}`,
      schema: rulebookVersionResponseSchema,
      retryable: true,
    })
    return response.data
  }

  /**
   * Resolves the authoritative version record into a pin. The returned value is
   * an immutable selection: later requests name the same version and digest,
   * never "the latest version".
   */
  async pinRulebook(input: PinRulebookInput): Promise<CredimiRulebookPin> {
    const rulebookId = requireNonEmptyString(input.rulebookId, 'rulebookId')
    const version = requireNonEmptyString(input.version, 'version')
    const attestationType = requireNonEmptyString(input.attestationType, 'attestationType')
    const record = await this.getRulebookVersion(rulebookId, version)
    const parsed = credimiRulebookPinSchema.safeParse({
      kind: RULEBOOK_PIN_KIND,
      rulebookId: record.rulebookId,
      version: record.version,
      contentDigest: record.contentDigest,
      specVersion: record.specVersion,
      attestationType,
    })
    if (!parsed.success) {
      throw invalidResponse(
        'rulebook version',
        'the version identity or content digest cannot form an attestbook.rulebook-pin@1 value',
      )
    }
    return parsed.data
  }

  /**
   * Validates one credential against the pinned rulebook version. The returned
   * evidence is rejected with `pin_mismatch` unless it names exactly the pinned
   * rulebook, version, digest and attestation type.
   */
  async validateCredential(input: CredimiValidationInput): Promise<CredimiValidationEvidence> {
    const pin = this.requirePin(input.pin)
    const credential =
      typeof input.credential === 'string' ? input.credential : input.credential.value
    if (typeof credential !== 'string' || credential.trim() === '') {
      throw invalidRequest('credential must not be empty.')
    }
    const body = parseRequest(
      validateCredentialRequestSchema,
      {
        rulebookId: pin.rulebookId,
        rulebookVersion: pin.version,
        attestationType: pin.attestationType,
        credential: input.credential,
        ...(input.schemaDocuments === undefined
          ? {}
          : { schemaDocuments: [...input.schemaDocuments] }),
      },
      'credential validation',
    )
    const response = await this.requestJson({
      operation: 'credential validation',
      method: 'POST',
      path: `${API_PREFIX}/credentials/validate`,
      body,
      schema: credentialValidationResponseSchema,
      retryable: false,
    })
    assertPinnedValidation(pin, response.data)
    return response.data
  }

  /** Lists capture evidence, newest first, with explicit evidence gaps. */
  async listCaptures(query: CredimiCaptureQuery = {}): Promise<CredimiCapturePage> {
    const params = new URLSearchParams()
    const limit = pageParameter(query.limit, 'limit', 1, MAX_PAGE_LIMIT)
    if (limit !== undefined) {
      params.set('limit', limit)
    }
    const offset = pageParameter(query.offset, 'offset', 0, null)
    if (offset !== undefined) {
      params.set('offset', offset)
    }
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`
    return this.requestJson({
      operation: 'capture list',
      method: 'GET',
      path: `${API_PREFIX}/captures${suffix}`,
      schema: captureExplorerPageSchema,
      retryable: true,
    })
  }

  /** Reads one capture with its redacted evidence and its correlations. */
  async getCapture(captureId: string): Promise<CredimiCaptureDetail> {
    const response = await this.requestJson({
      operation: 'capture read',
      method: 'GET',
      path: `${API_PREFIX}/captures/${encodeURIComponent(
        requireNonEmptyString(captureId, 'captureId'),
      )}`,
      schema: captureExplorerDetailResponseSchema,
      retryable: true,
    })
    return response.data
  }

  /**
   * Binds one captured artifact to the pinned rulebook version and records the
   * structural validation result. Requires a provider bearer token; the pin is
   * verified against the recorded correlation before it is returned.
   */
  async correlateCapture(input: CredimiCorrelationInput): Promise<CredimiEvidenceCorrelation> {
    const pin = this.requirePin(input.pin)
    const captureId = requireNonEmptyString(input.captureId, 'captureId')
    const token = input.token ?? this.token
    if (token === undefined || token.trim() === '') {
      throw new CredimiAdapterError(
        'authorization_required',
        'Recording a capture correlation requires a provider bearer token.',
      )
    }
    const body = parseRequest(
      correlateCaptureRequestSchema,
      {
        rulebookId: pin.rulebookId,
        rulebookVersion: pin.version,
        attestationType: pin.attestationType,
        rulebookDigest: pin.contentDigest,
      },
      'capture correlation',
    )
    const response = await this.requestJson({
      operation: 'capture correlation',
      method: 'POST',
      path: `${API_PREFIX}/captures/${encodeURIComponent(captureId)}/validate`,
      body,
      token,
      schema: captureCorrelationResponseSchema,
      retryable: false,
    })
    assertPinnedCorrelation(pin, response.data)
    return response.data
  }

  /**
   * Builds the headless-wallet comparison evidence for one correlated capture.
   * The caller supplies the external wallet observation, if any; AttestBook
   * provides the structural/schema side from the recorded correlation. The
   * returned report is rejected with `pin_mismatch` unless it names exactly the
   * pinned rulebook, version, digest and attestation type.
   *
   * The operation is read-only but is a `POST` because it carries the external
   * observation. It starts no wallet and contacts no Credimi endpoint.
   */
  async compareCapture(input: CredimiComparisonInput): Promise<CredimiHeadlessWalletComparison> {
    const pin = this.requirePin(input.pin)
    const captureId = requireNonEmptyString(input.captureId, 'captureId')
    const body = parseRequest(
      compareCaptureRequestSchema,
      input.externalWallet === undefined ? {} : { externalWallet: input.externalWallet },
      'headless-wallet comparison',
    )
    const response = await this.requestJson({
      operation: 'headless-wallet comparison',
      method: 'POST',
      path: `${API_PREFIX}/captures/${encodeURIComponent(captureId)}/compare`,
      body,
      schema: headlessWalletComparisonResponseSchema,
      retryable: false,
    })
    if (response.data.capture.captureId !== captureId) {
      throw invalidResponse(
        'headless-wallet comparison',
        'the report names a different capture identifier',
      )
    }
    assertPinnedComparison(pin, response.data)
    return response.data
  }

  private rulebookPath(rulebookId: string): string {
    return `${API_PREFIX}/rulebooks/${encodeURIComponent(
      requireNonEmptyString(rulebookId, 'rulebookId'),
    )}`
  }

  private requirePin(value: CredimiRulebookPin): CredimiRulebookPin {
    const parsed = credimiRulebookPinSchema.safeParse(value)
    if (!parsed.success) {
      throw invalidRequest(
        'The pinned rulebook selection must be a valid attestbook.rulebook-pin@1 value.',
      )
    }
    return parsed.data
  }

  private async requestJson<T>(options: RequestOptions<T>): Promise<T> {
    const attempts = options.retryable ? this.retries + 1 : 1
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.requestOnce(options)
      } catch (error) {
        if (attempt >= attempts || !isCredimiAdapterError(error) || !error.retryable) {
          throw error
        }
        if (this.retryDelayMs > 0) {
          await delay(this.retryDelayMs)
        }
      }
    }
  }

  private async requestOnce<T>(options: RequestOptions<T>): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`
    }
    let encodedBody: string | undefined
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      encodedBody = JSON.stringify(options.body)
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      let response: Response
      try {
        response = await this.fetchFn(`${this.baseUrl}${options.path}`, {
          method: options.method,
          headers,
          redirect: 'error',
          signal: controller.signal,
          ...(encodedBody === undefined ? {} : { body: encodedBody }),
        })
      } catch (error) {
        throw timedOut
          ? timeoutError(options.operation, this.timeoutMs)
          : networkError(options.operation, error)
      }

      let text: string
      try {
        text = await readBoundedText(response, this.maxResponseBytes, options.operation)
      } catch (error) {
        if (isCredimiAdapterError(error)) {
          throw error
        }
        throw timedOut
          ? timeoutError(options.operation, this.timeoutMs)
          : networkError(options.operation, error)
      }

      if (!response.ok) {
        throw responseError(response.status, text)
      }

      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw invalidResponse(options.operation, 'the body is not valid JSON')
      }
      const parsed = options.schema.safeParse(payload)
      if (!parsed.success) {
        const fields = parsed.error.issues
          .map((issue) => (issue.path.length === 0 ? 'body' : issue.path.join('.')))
          .join(', ')
        throw invalidResponse(options.operation, `unexpected or missing fields at: ${fields}`)
      }
      return parsed.data
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Builds one adapter instance; equivalent to `new CredimiAdapter(options)`. */
export function createCredimiAdapter(options: CredimiAdapterOptions): CredimiAdapter {
  return new CredimiAdapter(options)
}
