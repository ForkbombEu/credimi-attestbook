// Typed failures for untrusted capture artifact import (issue #46).
//
// Rejections are safe by construction: the message names the envelope field or
// rule that failed and never echoes artifact bytes, claim values, tokens,
// identifiers or URLs. A caller can branch on the stable `code` without
// inspecting the message.

/** Stable machine-readable capture import failure codes. */
export type CaptureErrorCode =
  | 'invalid_json'
  | 'json_limit'
  | 'response_too_large'
  | 'invalid_capture'
  | 'unsupported_envelope_version'
  | 'unsupported_source_component'
  | 'unsupported_interaction_type'
  | 'unsupported_protocol'
  | 'unsupported_credential_format'
  | 'unsupported_artifact_type'
  | 'invalid_timestamp'
  | 'missing_artifact'
  | 'ambiguous_artifact_source'
  | 'invalid_reference'
  | 'blocked_reference'
  | 'unsupported_encoding'
  | 'invalid_artifact_encoding'
  | 'artifact_too_large'
  | 'artifact_size_mismatch'
  | 'integrity_mismatch'
  | 'unsupported_integrity_algorithm'
  | 'invalid_redaction'
  | 'redaction_inconsistent'
  | 'redaction_limit'
  | 'redaction_unavailable'
  | 'metadata_limit'

/** A safe capture import failure. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode
  /** Dotted location of the offending member, when it is safe to report. */
  readonly path: string | undefined

  constructor(code: CaptureErrorCode, message: string, path?: string) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
    this.path = path
  }
}

export function captureError(code: CaptureErrorCode, message: string, path?: string): CaptureError {
  return new CaptureError(code, message, path)
}

export function isCaptureError(value: unknown): value is CaptureError {
  return value instanceof CaptureError
}
