// Typed failures of the Credimi integration adapter (FR-020, issue #49).
//
// Every failure is one of a small, stable set of codes so a Credimi adapter can
// classify and report it without inspecting an HTTP status or a message. The
// messages never contain credential material, a bearer token or a response
// body: they name the operation and the field at fault only.

/** Stable error codes returned by every adapter operation. */
export const CREDIMI_ADAPTER_ERROR_CODES = [
  'invalid_configuration',
  'invalid_request',
  'authorization_required',
  'network_error',
  'timeout',
  'response_too_large',
  'invalid_response',
  'pin_mismatch',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_input',
  'payload_too_large',
  'unavailable',
  'internal_error',
  'http_error',
] as const

export type CredimiAdapterErrorCode = (typeof CREDIMI_ADAPTER_ERROR_CODES)[number]

export interface CredimiAdapterErrorOptions {
  /** HTTP status when a response was received. */
  readonly status?: number | null
  /** The error code carried by AttestBook's JSON error envelope, when present. */
  readonly serverCode?: string | null
  /** Whether retrying the same operation may succeed. */
  readonly retryable?: boolean
  readonly cause?: unknown
}

/**
 * One adapter failure. `code` is the stable contract; `status` and `serverCode`
 * are secondary diagnostics and may be absent for transport failures.
 */
export class CredimiAdapterError extends Error {
  readonly code: CredimiAdapterErrorCode
  readonly status: number | null
  readonly serverCode: string | null
  readonly retryable: boolean

  constructor(
    code: CredimiAdapterErrorCode,
    message: string,
    options: CredimiAdapterErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CredimiAdapterError'
    this.code = code
    this.status = options.status ?? null
    this.serverCode = options.serverCode ?? null
    this.retryable = options.retryable ?? false
  }
}

/** Narrows an unknown catch value to an adapter failure. */
export function isCredimiAdapterError(error: unknown): error is CredimiAdapterError {
  return error instanceof CredimiAdapterError
}
