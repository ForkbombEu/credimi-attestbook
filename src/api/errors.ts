// Typed HTTP error contract for the versioned product API (issue #34).
//
// The service modules already throw typed errors (`RegistryError` and
// `ImportError`). This module maps them to the HTTP error envelope once, so
// every route reports the same machine-readable shape:
//
//   { "error": { "code": "<stable code>", "message": "<safe message>",
//                "details"?: { ... } } }
//
// Messages come from the services and never contain bearer tokens, raw
// payloads, credential material or remote document bytes.

import { isCaptureAdapterError } from '../capture/adapters'
import { isImportError } from '../import/errors'
import type { ImportError, ImportErrorCode } from '../import/errors'
import { isRegistryError } from '../registry/errors'
import type { JsonObject } from '../registry/types'

/**
 * RFC 6750 challenge sent with every `401` response. A missing credential and
 * an unknown or revoked one deliberately produce the same challenge and body.
 */
export const BEARER_CHALLENGE = 'Bearer realm="attestbook"'

/** Stable machine-readable error codes of the versioned product API. */
export const API_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'immutable',
  'payload_too_large',
  'import_fetch_failed',
  'import_rejected',
  'capture_fetch_failed',
  'capture_unavailable',
  'rate_limited',
  'auth_unavailable',
  'registry_unavailable',
  'validation_unavailable',
  'fixture_unavailable',
  'internal_error',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** HTTP statuses the API layer itself may return. */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503

/** The error body every failing product-API request returns. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ApiErrorCode
    readonly message: string
    readonly details?: JsonObject
  }
}

/** An HTTP failure raised by the API layer itself (mapping, limits, wiring). */
export class ApiError extends Error {
  readonly status: ApiErrorStatus
  readonly code: ApiErrorCode
  readonly details: JsonObject | undefined
  /** Send the RFC 6750 bearer challenge with a `401`; opt-in, for bearer routes. */
  readonly challenge: boolean
  /** Additional response headers, such as `Retry-After` on a `429`. */
  readonly headers: Readonly<Record<string, string>> | undefined

  constructor(
    status: ApiErrorStatus,
    code: ApiErrorCode,
    message: string,
    details?: JsonObject,
    options?: {
      readonly challenge?: boolean
      readonly headers?: Readonly<Record<string, string>>
    },
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.challenge = options?.challenge ?? false
    this.headers = options?.headers
  }
}

export function apiError(
  status: ApiErrorStatus,
  code: ApiErrorCode,
  message: string,
  details?: JsonObject,
  options?: {
    readonly challenge?: boolean
    readonly headers?: Readonly<Record<string, string>>
  },
): ApiError {
  return new ApiError(status, code, message, details, options)
}

/** Builds the error envelope without losing the typed code. */
export function errorEnvelope(
  code: ApiErrorCode,
  message: string,
  details?: JsonObject,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
}

const IMPORT_FETCH_CODES: ReadonlySet<ImportErrorCode> = new Set([
  'dns_failure',
  'fetch_failed',
  'timeout',
  'redirect_limit',
  'unsupported_status',
  'response_too_large',
])

const IMPORT_REQUEST_CODES: ReadonlySet<ImportErrorCode> = new Set([
  'invalid_source',
  'invalid_url',
])

function importErrorResponse(error: ImportError): {
  readonly status: ApiErrorStatus
  readonly body: ErrorEnvelope
} {
  const details: JsonObject = {
    reason: error.code,
    ...(error.path === undefined ? {} : { path: error.path }),
  }
  if (IMPORT_REQUEST_CODES.has(error.code)) {
    return { status: 400, body: errorEnvelope('invalid_request', error.message, details) }
  }
  if (IMPORT_FETCH_CODES.has(error.code)) {
    return { status: 502, body: errorEnvelope('import_fetch_failed', error.message, details) }
  }
  // Everything else is a source document the import pipeline refuses to
  // accept (unsafe, malformed, over a limit or not importable as-is).
  return { status: 422, body: errorEnvelope('import_rejected', error.message, details) }
}

/**
 * Maps a thrown value to its HTTP response, or `null` when it is not a typed
 * failure and must be treated as an internal error. The mapping is the single
 * definition of the API's error statuses; docs/api.md documents the same table.
 */
export function toApiError(error: unknown): {
  readonly status: ApiErrorStatus
  readonly body: ErrorEnvelope
  /** Send the bearer challenge with a `401`; only bearer-path failures do. */
  readonly challenge?: boolean
  readonly headers?: Readonly<Record<string, string>>
} | null {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: errorEnvelope(error.code, error.message, error.details),
      challenge: error.challenge,
      ...(error.headers === undefined ? {} : { headers: error.headers }),
    }
  }

  if (isCaptureAdapterError(error)) {
    // Only the transport failures are the caller's concern; a cursor,
    // authorization or idempotency failure inside an adapter is a server
    // fault and falls through to the generic internal error.
    if (
      error.code === 'source_unavailable' ||
      error.code === 'source_timeout' ||
      error.code === 'invalid_source_response' ||
      error.code === 'response_too_large'
    ) {
      return {
        status: 502,
        body: errorEnvelope('capture_fetch_failed', error.message, { reason: error.code }),
      }
    }
    return null
  }

  if (isImportError(error)) {
    return importErrorResponse(error)
  }

  if (!isRegistryError(error)) {
    return null
  }

  switch (error.code) {
    case 'invalid_input':
      return { status: 400, body: errorEnvelope('invalid_request', error.message) }
    case 'unauthorized':
      return { status: 401, body: errorEnvelope('unauthorized', error.message), challenge: true }
    case 'forbidden':
      return { status: 403, body: errorEnvelope('forbidden', error.message) }
    case 'not_found':
      return { status: 404, body: errorEnvelope('not_found', error.message) }
    case 'conflict':
      return { status: 409, body: errorEnvelope('conflict', error.message) }
    case 'immutable':
      return { status: 409, body: errorEnvelope('immutable', error.message) }
  }
}
