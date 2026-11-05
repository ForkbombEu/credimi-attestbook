// Typed failures for the untrusted-input import pipeline (issue #30).
//
// Import errors are deliberately separate from registry errors: fetching and
// validating a remote document fails before any registry write, and callers
// need to distinguish "the source is unsafe or unreadable" from "the registry
// refused a write". Messages never echo document bytes, headers or URLs with
// credentials.

/** Stable machine-readable import failure codes. */
export type ImportErrorCode =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns_failure'
  | 'fetch_failed'
  | 'timeout'
  | 'response_too_large'
  | 'unsupported_content_type'
  | 'redirect_limit'
  | 'unsupported_status'
  | 'invalid_json'
  | 'json_limit'
  | 'invalid_catalog'
  | 'entry_limit'
  | 'schema_reference_invalid'
  | 'schema_reference_limit'
  | 'invalid_source'
  | 'import_rejected'

/** A safe import failure. */
export class ImportError extends Error {
  readonly code: ImportErrorCode
  /** Dotted location of the offending member, when one is known. */
  readonly path: string | undefined

  constructor(code: ImportErrorCode, message: string, path?: string) {
    super(message)
    this.name = 'ImportError'
    this.code = code
    this.path = path
  }
}

export function importError(code: ImportErrorCode, message: string, path?: string): ImportError {
  return new ImportError(code, message, path)
}

export function isImportError(value: unknown): value is ImportError {
  return value instanceof ImportError
}
