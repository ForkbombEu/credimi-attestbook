// Typed failures for the capture transport adapters (FR-018, issue #47).
//
// Normalization failures keep their own `CaptureError` codes; this type covers
// only the transport, authorization and idempotency boundary around ingestion.
// Messages are safe to display: they name the boundary rule that failed and
// never echo a credential, cursor, URL, capture identifier or artifact byte.

/** Stable machine-readable capture adapter failure codes. */
export type CaptureAdapterErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_request'
  | 'unsupported_media_type'
  | 'source_unavailable'
  | 'source_timeout'
  | 'invalid_source_response'
  | 'response_too_large'
  | 'cursor_expired'
  | 'duplicate_conflict'
  | 'capture_store_full'

/** A safe capture transport, authorization or idempotency failure. */
export class CaptureAdapterError extends Error {
  readonly code: CaptureAdapterErrorCode

  constructor(code: CaptureAdapterErrorCode, message: string) {
    super(message)
    this.name = 'CaptureAdapterError'
    this.code = code
  }
}

export function captureAdapterError(
  code: CaptureAdapterErrorCode,
  message: string,
): CaptureAdapterError {
  return new CaptureAdapterError(code, message)
}

export function isCaptureAdapterError(value: unknown): value is CaptureAdapterError {
  return value instanceof CaptureAdapterError
}
