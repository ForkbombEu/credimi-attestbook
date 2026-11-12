// Same-origin checks and cookie transport decisions for login and logout
// (issue #88).
//
// Cookie-authenticated state changes must not be driveable from another site.
// `SameSite=Lax` already withholds the cookie from cross-site POSTs, and the
// explicit checks below add the modern `Origin`/`Sec-Fetch-Site` signals.
// Non-browser clients may omit those headers; a present and mismatching value
// is always refused.
//
// The forwarded headers are used so a TLS-terminating reverse proxy can keep
// the `Secure` cookie flag and origin checks correct. A direct client could
// claim them, but that only affects its own request: a browser always sends the
// real `Host` and `Origin`, which they cannot override.

export interface RequestOriginContext {
  /** Absolute request URL as reconstructed by the server (scheme and host). */
  readonly url: string
  readonly origin?: string | undefined
  readonly secFetchSite?: string | undefined
  readonly forwardedProto?: string | undefined
  readonly forwardedHost?: string | undefined
}

function firstForwardedValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const first = value.split(',')[0]?.trim()
  return first === undefined || first === '' ? undefined : first
}

/** Effective request protocol, honouring a TLS-terminating reverse proxy. */
export function requestProtocol(context: RequestOriginContext): 'http:' | 'https:' {
  const forwarded = firstForwardedValue(context.forwardedProto)?.toLowerCase()
  if (forwarded === 'https') {
    return 'https:'
  }
  if (forwarded === 'http') {
    return 'http:'
  }
  try {
    return new URL(context.url).protocol === 'https:' ? 'https:' : 'http:'
  } catch {
    return 'http:'
  }
}

/** True when the browser connection is (or terminates as) HTTPS. */
export function requestUsesHttps(context: RequestOriginContext): boolean {
  return requestProtocol(context) === 'https:'
}

/** Effective request origin, including the forwarded host behind a proxy. */
export function requestOrigin(context: RequestOriginContext): string | null {
  const forwardedHost = firstForwardedValue(context.forwardedHost)
  let host = forwardedHost
  if (host === undefined) {
    try {
      host = new URL(context.url).host
    } catch {
      return null
    }
  }
  if (host === '') {
    return null
  }
  return `${requestProtocol(context)}//${host}`
}

/**
 * Whether a state-changing cookie request may proceed. A present `Origin` must
 * match the request origin exactly; `Origin: null` is refused. A present
 * `Sec-Fetch-Site` must be `same-origin` or `none` (a direct navigation).
 * Missing headers are accepted for non-browser clients, which cannot be
 * tricked into sending a victim's cookie by a third-party page.
 */
export function isSameOriginRequest(context: RequestOriginContext): boolean {
  const fetchSite = context.secFetchSite?.toLowerCase()
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false
  }

  if (context.origin === undefined) {
    return true
  }

  const expected = requestOrigin(context)
  if (expected === null || context.origin === 'null' || context.origin.trim() === '') {
    return false
  }

  try {
    return new URL(context.origin).origin === new URL(expected).origin
  } catch {
    return false
  }
}
