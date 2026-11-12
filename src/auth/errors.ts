// Typed failures of the administrator browser-session credential path
// (issue #89).
//
// The API layer maps these once, so a session-authenticated request keeps the
// established `401` (unauthenticated) and `403` (CSRF refused) semantics
// without leaking whether a cookie existed or why it was refused.

/** Why a cookie-session request was refused. */
export type SessionAuthErrorCode = 'unauthorized' | 'csrf_failed'

export class SessionAuthError extends Error {
  readonly code: SessionAuthErrorCode

  constructor(code: SessionAuthErrorCode, message: string) {
    super(message)
    this.name = 'SessionAuthError'
    this.code = code
  }
}

/** No live session: missing, unknown, expired, revoked or rotated away. */
export function unauthorizedSession(message = 'Authentication is required.'): SessionAuthError {
  return new SessionAuthError('unauthorized', message)
}

/** The request is missing the session's CSRF token or presented a wrong one. */
export function csrfRejected(
  message = 'The request is missing or carries an invalid CSRF token; sign in again.',
): SessionAuthError {
  return new SessionAuthError('csrf_failed', message)
}

export function isSessionAuthError(error: unknown): error is SessionAuthError {
  return error instanceof SessionAuthError
}
