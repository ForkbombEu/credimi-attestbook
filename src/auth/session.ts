// Opaque browser-session primitives for the environment-configured
// administrator (issues #88 and #89).
//
// The browser holds a 256-bit random identifier in an HttpOnly cookie; the
// database stores only its SHA-256 hash. Every session is bound to the exact
// administrator configuration that created it through `adminAuthFingerprint`,
// so changing the username, provider or password hash invalidates outstanding
// sessions instead of silently carrying them over. Each session also carries a
// CSRF token that a state-changing cookie request must echo, so a cross-site
// request cannot drive a write with the victim's cookie.

import { createHash, randomBytes } from 'node:crypto'

/** Cookie that carries the opaque administrator session identifier. */
export const ADMIN_SESSION_COOKIE_NAME = 'attestbook_admin_session'

/** Request header a cookie-authenticated state change must present. */
export const ADMIN_CSRF_HEADER_NAME = 'x-csrf-token'

/** Absolute session lifetime; every session row carries a matching bound. */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000

/** Random bytes behind one session identifier (256 bits). */
export const ADMIN_SESSION_ID_BYTES = 32

/** Longest identifier accepted from a cookie before it is hashed and looked up. */
export const MAX_ADMIN_SESSION_ID_LENGTH = 256

/** Random bytes behind one session CSRF token (256 bits). */
export const ADMIN_CSRF_TOKEN_BYTES = 32

/** Longest CSRF token accepted before it is compared. */
export const MAX_ADMIN_CSRF_TOKEN_LENGTH = 256

/** Generates an unpredictable, URL-safe opaque session identifier. */
export function generateAdminSessionId(): string {
  return randomBytes(ADMIN_SESSION_ID_BYTES).toString('base64url')
}

/** SHA-256 of a session identifier; the raw identifier is never stored. */
export function hashAdminSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex')
}

/**
 * Generates an unpredictable CSRF token bound to one session. It is not an
 * authenticator on its own: the server accepts it only together with the
 * session cookie, which a cross-site page cannot read.
 */
export function generateAdminCsrfToken(): string {
  return randomBytes(ADMIN_CSRF_TOKEN_BYTES).toString('base64url')
}

/**
 * Binds a session to the administrator configuration that created it. Rotating
 * any configured value produces a different fingerprint and invalidates old
 * sessions. The input includes the existing password hash, and the result is
 * another one-way digest, so no secret is stored in a recoverable form.
 */
export function adminAuthFingerprint(input: {
  readonly username: string
  readonly passwordHash: string
  readonly providerId: string
}): string {
  return createHash('sha256')
    .update(input.username, 'utf8')
    .update('\0')
    .update(input.providerId, 'utf8')
    .update('\0')
    .update(input.passwordHash, 'utf8')
    .digest('hex')
}
