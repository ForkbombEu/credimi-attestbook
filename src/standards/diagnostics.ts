// Structured diagnostics for the standards adapter.
//
// The adapter must never collapse "the input is wrong" and "AttestBook cannot
// perform this operation" into one message: the registry and validation
// dimensions act on them differently. Every diagnostic therefore carries a
// `kind` that separates invalid caller input, an unsupported capability, a
// capability that ran without checking trust, and forward-compatible data that
// was preserved instead of silently dropped.

/** Why a diagnostic is reported. */
export type DiagnosticKind = 'invalid_input' | 'unsupported_operation' | 'not_tested' | 'preserved'

/** Stable machine-readable diagnostic codes. */
export type DiagnosticCode =
  | 'invalid_schema_meta'
  | 'unknown_profile'
  | 'ambiguous_profile'
  | 'preserved_unknown_member'
  | 'preserved_unknown_value'
  | 'signing_time_stamped'
  | 'missing_required_member'
  | 'invalid_member_value'
  | 'invalid_ts11_id'
  | 'unsupported_profile'
  | 'unsupported_format'
  | 'unsupported_trust_authority'
  | 'unsupported_sri_algorithm'
  | 'unsupported_schema_meta_member'
  | 'unsupported_jose_algorithm'
  | 'invalid_signing_certificate'
  | 'signing_failed'
  | 'invalid_jose_header'
  | 'synthetic_iat'
  | 'invalid_signature'
  | 'invalid_reference'
  | 'integrity_mismatch'
  | 'integrity_not_verified'
  | 'trust_not_tested'

/** A single adapter finding. */
export interface AdapterDiagnostic {
  readonly kind: DiagnosticKind
  readonly code: DiagnosticCode
  readonly message: string
  /** Dotted path to the offending member, when one is known. */
  readonly path?: string
}

/** Successful adapter output with any non-fatal findings. */
export interface AdapterSuccess<T> {
  readonly ok: true
  readonly value: T
  readonly diagnostics: readonly AdapterDiagnostic[]
}

/** Failed adapter output; at least one diagnostic explains why. */
export interface AdapterFailure {
  readonly ok: false
  readonly diagnostics: readonly AdapterDiagnostic[]
}

export type AdapterResult<T> = AdapterSuccess<T> | AdapterFailure

function pathProperty(path?: string): { path?: string } {
  return path === undefined ? {} : { path }
}

export function diagnostic(
  kind: DiagnosticKind,
  code: DiagnosticCode,
  message: string,
  path?: string,
): AdapterDiagnostic {
  return { kind, code, message, ...pathProperty(path) }
}

export function invalidInput(
  code: DiagnosticCode,
  message: string,
  path?: string,
): AdapterDiagnostic {
  return diagnostic('invalid_input', code, message, path)
}

export function unsupportedOperation(
  code: DiagnosticCode,
  message: string,
  path?: string,
): AdapterDiagnostic {
  return diagnostic('unsupported_operation', code, message, path)
}

export function notTested(code: DiagnosticCode, message: string, path?: string): AdapterDiagnostic {
  return diagnostic('not_tested', code, message, path)
}

export function preserved(code: DiagnosticCode, message: string, path?: string): AdapterDiagnostic {
  return diagnostic('preserved', code, message, path)
}

export function ok<T>(value: T, diagnostics: readonly AdapterDiagnostic[] = []): AdapterSuccess<T> {
  return { ok: true, value, diagnostics }
}

export function fail(diagnostics: readonly AdapterDiagnostic[]): AdapterFailure {
  return { ok: false, diagnostics }
}

export function hasInvalidInput(diagnostics: readonly AdapterDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.kind === 'invalid_input')
}

/** Human-readable rendering that names the diagnostic kind for every line. */
export function formatDiagnostics(diagnostics: readonly AdapterDiagnostic[]): string {
  return diagnostics
    .map((entry) => {
      const label =
        entry.kind === 'invalid_input'
          ? 'invalid input'
          : entry.kind === 'unsupported_operation'
            ? 'unsupported operation'
            : entry.kind === 'not_tested'
              ? 'not tested'
              : 'preserved'
      const location = entry.path === undefined ? '' : ` at ${entry.path}`
      return `${label}: ${entry.message}${location} [${entry.code}]`
    })
    .join('\n')
}

export function hasBlockingDiagnostic(diagnostics: readonly AdapterDiagnostic[]): boolean {
  return diagnostics.some(
    (entry) => entry.kind === 'invalid_input' || entry.kind === 'unsupported_operation',
  )
}
