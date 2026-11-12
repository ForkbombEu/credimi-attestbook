// Administrator browser-session client for the standalone UI (issue #90).
//
// The UI is a client of the same-origin auth API: `GET /api/v1/auth/me`
// restores a session after a reload, `POST /api/v1/auth/login` starts one and
// `POST /api/v1/auth/logout` revokes it. Authentication is carried only by the
// server's HttpOnly session cookie, so this module never reads or writes
// browser storage and never handles a bearer token.
//
// Login and logout are cookie-authenticated state changes. The browser sends
// `Origin` and `Sec-Fetch-Site` on a same-origin `POST`, and a live session's
// state change must also echo the session-bound CSRF token in `X-CSRF-Token`
// (issues #89/#94). `credentials: 'same-origin'` makes the cookie transport
// explicit. The CSRF token is returned by the auth responses and kept in React
// memory only.

import type { Provider } from './types'

export const ADMIN_SESSION_PATH = '/api/v1/auth/me'
export const ADMIN_LOGIN_PATH = '/api/v1/auth/login'
export const ADMIN_LOGOUT_PATH = '/api/v1/auth/logout'
/** Header the server requires on a cookie-authenticated state change. */
export const ADMIN_CSRF_HEADER = 'x-csrf-token'

/** The authenticated provider, session expiry and session-bound CSRF token. */
export interface AdminSession {
  readonly provider: Provider
  readonly expiresAt: string
  /** Echoed in `X-CSRF-Token` on logout; never a bearer token. */
  readonly csrfToken: string
}

export interface AdminCredentials {
  readonly username: string
  readonly password: string
}

export class AuthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AuthApiError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface ErrorEnvelope {
  readonly error?: {
    readonly message?: unknown
  }
}

interface DataEnvelope {
  readonly data?: unknown
}

async function readErrorMessage(response: Response, label: string): Promise<string> {
  try {
    const body = (await response.json()) as ErrorEnvelope
    if (typeof body.error?.message === 'string' && body.error.message !== '') {
      return body.error.message
    }
  } catch {
    // A non-JSON error body must not replace the request failure.
  }
  return `The ${label} request failed with HTTP ${response.status}.`
}

function sessionFromBody(body: unknown): AdminSession {
  if (typeof body !== 'object' || body === null) {
    throw new AuthApiError('The session response was not recognised.', 0)
  }
  const data = (body as DataEnvelope).data
  if (typeof data !== 'object' || data === null) {
    throw new AuthApiError('The session response was not recognised.', 0)
  }
  const record = data as Record<string, unknown>
  const provider = record.provider
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof (provider as Record<string, unknown>).id !== 'string' ||
    typeof (provider as Record<string, unknown>).name !== 'string' ||
    typeof record.expiresAt !== 'string' ||
    typeof record.csrfToken !== 'string' ||
    record.csrfToken === ''
  ) {
    throw new AuthApiError('The session response was not recognised.', 0)
  }
  return data as AdminSession
}

/** The auth operations the login page and the shared header need. */
export interface AuthApi {
  /** The live session, or `null` for an anonymous or expired browser. */
  getSession(signal?: AbortSignal): Promise<AdminSession | null>
  login(credentials: AdminCredentials, signal?: AbortSignal): Promise<AdminSession>
  /** Revokes the cookie session; a live session must present its CSRF token. */
  logout(csrfToken: string, signal?: AbortSignal): Promise<void>
}

/** Builds the same-origin auth client; `fetchImpl` is injectable for tests. */
export function createHttpAuthApi(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): AuthApi {
  return {
    async getSession(signal) {
      const response = await fetchImpl(ADMIN_SESSION_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...(signal === undefined ? {} : { signal }),
      })
      // `401` is the API's explicit anonymous answer; a `404` means this build
      // talks to a server without the auth routes, where anonymous is still
      // the safe interpretation. An expired session therefore degrades to the
      // anonymous state instead of surfacing an error.
      if (response.status === 401 || response.status === 404) {
        return null
      }
      if (!response.ok) {
        throw new AuthApiError(await readErrorMessage(response, 'session'), response.status)
      }
      return sessionFromBody(await response.json())
    },

    async login(credentials, signal) {
      const response = await fetchImpl(ADMIN_LOGIN_PATH, {
        method: 'POST',
        // Login requires this JSON content type; a cross-site HTML form cannot
        // send it without a CORS preflight.
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: credentials.username,
          password: credentials.password,
        }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) {
        throw new AuthApiError(await readErrorMessage(response, 'sign-in'), response.status)
      }
      return sessionFromBody(await response.json())
    },

    async logout(csrfToken, signal) {
      const response = await fetchImpl(ADMIN_LOGOUT_PATH, {
        method: 'POST',
        // The live session's state change must echo its CSRF token; the
        // server answers 403 csrf_failed and keeps the session otherwise.
        headers: { accept: 'application/json', [ADMIN_CSRF_HEADER]: csrfToken },
        credentials: 'same-origin',
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) {
        throw new AuthApiError(await readErrorMessage(response, 'sign-out'), response.status)
      }
    },
  }
}

/**
 * Restricts a `next` target to a same-origin path. Absolute URLs,
 * protocol-relative paths, backslashes (some browsers treat them as slashes),
 * control characters and every other origin are rejected, so a crafted login
 * link cannot redirect the browser off this application.
 */
export function safeRedirectPath(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string' || candidate === '' || candidate.length > 2048) {
    return null
  }
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return null
  }
  for (const character of candidate) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) {
      return null
    }
  }
  const base =
    typeof window === 'undefined'
      ? 'http://localhost'
      : window.location.origin || 'http://localhost'
  try {
    const url = new URL(candidate, base)
    if (url.origin !== base || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return null
    }
    // `new URL` resolves dot segments, so a crafty `/..//host` can normalise to
    // a protocol-relative path. Only a plain same-origin path may pass.
    const normalised = `${url.pathname}${url.search}${url.hash}`
    if (!normalised.startsWith('/') || normalised.startsWith('//') || normalised.includes('\\')) {
      return null
    }
    return normalised
  } catch {
    return null
  }
}

/** Reads and validates the `next` query parameter of a login URL. */
export function intendedPath(search: string): string | null {
  return safeRedirectPath(new URLSearchParams(search).get('next'))
}

/** The current browser path, including its query string. */
export function currentPath(): string {
  if (typeof window === 'undefined') {
    return '/'
  }
  return `${window.location.pathname}${window.location.search}`
}

/**
 * The login URL that returns to `next` after a successful sign-in. An invalid
 * or redundant target is dropped rather than forwarded.
 */
export function loginPath(next?: string | null): string {
  const safe = safeRedirectPath(next)
  if (safe === null || safe === '/') {
    return '/login'
  }
  return `/login?next=${encodeURIComponent(safe)}`
}
