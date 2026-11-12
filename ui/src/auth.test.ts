import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  ADMIN_LOGIN_PATH,
  ADMIN_LOGOUT_PATH,
  ADMIN_SESSION_PATH,
  AuthApiError,
  createHttpAuthApi,
  intendedPath,
  loginPath,
  safeRedirectPath,
  type FetchLike,
} from './auth'

const PROVIDER = {
  id: 'provider-admin',
  name: 'E2E Administrator',
  createdAt: '2026-01-01T00:00:00.000Z',
}
const SESSION = {
  provider: PROVIDER,
  expiresAt: '2026-01-01T08:00:00.000Z',
  csrfToken: 'csrf-token-value',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('createHttpAuthApi', () => {
  test('reads the session from GET /api/v1/auth/me', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: SESSION })))
    const api = createHttpAuthApi(fetchImpl)

    expect(await api.getSession()).toEqual(SESSION)
    expect(fetchImpl).toHaveBeenCalledWith(
      ADMIN_SESSION_PATH,
      expect.objectContaining({
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }),
    )
  })

  test('treats an anonymous 401 and a missing auth route as no session', async () => {
    const anonymous = createHttpAuthApi(() =>
      Promise.resolve(jsonResponse({ error: { message: 'Authentication is required.' } }, 401)),
    )
    expect(await anonymous.getSession()).toBeNull()

    const olderServer = createHttpAuthApi(() =>
      Promise.resolve(jsonResponse({ error: { message: 'Not found.' } }, 404)),
    )
    expect(await olderServer.getSession()).toBeNull()
  })

  test('surfaces a session endpoint failure without inventing an identity', async () => {
    const api = createHttpAuthApi(() =>
      Promise.resolve(jsonResponse({ error: { message: 'Session lookup failed.' } }, 500)),
    )

    await expect(api.getSession()).rejects.toMatchObject({
      name: 'AuthApiError',
      status: 500,
      message: 'Session lookup failed.',
    })
  })

  test('posts credentials as JSON with the same-origin cookie and no token', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: SESSION })))
    const api = createHttpAuthApi(fetchImpl)

    expect(await api.login({ username: 'admin', password: 'secret' })).toEqual(SESSION)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [path, init] = fetchImpl.mock.calls[0] ?? []
    expect(path).toBe(ADMIN_LOGIN_PATH)
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
    })
    const body = init?.body
    expect(typeof body).toBe('string')
    expect(JSON.parse(body as string)).toEqual({ username: 'admin', password: 'secret' })
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBeNull()
  })

  test('returns the API safe message for rejected credentials', async () => {
    const api = createHttpAuthApi(() =>
      Promise.resolve(jsonResponse({ error: { message: 'Invalid username or password.' } }, 401)),
    )

    await expect(api.login({ username: 'admin', password: 'wrong' })).rejects.toMatchObject({
      name: 'AuthApiError',
      status: 401,
      message: 'Invalid username or password.',
    })
  })

  test('logs out with a same-origin POST carrying the session CSRF token', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 204 })))
    const api = createHttpAuthApi(fetchImpl)

    await expect(api.logout('csrf-token-value')).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      ADMIN_LOGOUT_PATH,
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
    const [, init] = fetchImpl.mock.calls[0] ?? []
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-token-value')
  })

  test('surfaces a failed logout', async () => {
    const api = createHttpAuthApi(() =>
      Promise.resolve(jsonResponse({ error: { message: 'The origin is not allowed.' } }, 403)),
    )

    await expect(api.logout('csrf-token-value')).rejects.toMatchObject({
      name: 'AuthApiError',
      status: 403,
      message: 'The origin is not allowed.',
    })
  })

  test('rejects a malformed success body', async () => {
    const api = createHttpAuthApi(() => Promise.resolve(jsonResponse({ unexpected: true })))

    await expect(api.getSession()).rejects.toBeInstanceOf(AuthApiError)
  })

  test('rejects a success body without the CSRF token', async () => {
    const api = createHttpAuthApi(() =>
      Promise.resolve(
        jsonResponse({ data: { provider: PROVIDER, expiresAt: '2026-01-01T08:00:00.000Z' } }),
      ),
    )

    await expect(api.getSession()).rejects.toBeInstanceOf(AuthApiError)
  })
})

describe('safeRedirectPath', () => {
  test('accepts same-origin paths with a query and fragment', () => {
    expect(safeRedirectPath('/')).toBe('/')
    expect(safeRedirectPath('/rulebooks/abc')).toBe('/rulebooks/abc')
    expect(safeRedirectPath('/playground?rulebook=1#result')).toBe('/playground?rulebook=1#result')
    expect(safeRedirectPath('/%2Fescaped')).toBe('/%2Fescaped')
  })

  test('rejects absolute, protocol-relative and scheme targets', () => {
    expect(safeRedirectPath('https://evil.example/')).toBeNull()
    expect(safeRedirectPath('http://evil.example')).toBeNull()
    expect(safeRedirectPath('//evil.example/')).toBeNull()
    expect(safeRedirectPath('/..//evil.example/')).toBeNull()
    expect(safeRedirectPath('javascript:alert(1)')).toBeNull()
    expect(safeRedirectPath('data:text/html,hello')).toBeNull()
  })

  test('rejects backslashes, control characters and over-long values', () => {
    expect(safeRedirectPath('/\\evil.example')).toBeNull()
    expect(safeRedirectPath('/path\nwith-newline')).toBeNull()
    expect(safeRedirectPath(`/${'a'.repeat(2049)}`)).toBeNull()
    expect(safeRedirectPath('')).toBeNull()
    expect(safeRedirectPath(null)).toBeNull()
    expect(safeRedirectPath(undefined)).toBeNull()
  })
})

describe('login destinations', () => {
  test('reads only a validated same-origin next parameter', () => {
    expect(intendedPath('?next=%2Fplayground')).toBe('/playground')
    expect(intendedPath('')).toBeNull()
    expect(intendedPath('?next=https%3A%2F%2Fevil.example')).toBeNull()
    expect(intendedPath('?other=%2Fplayground')).toBeNull()
  })

  test('builds a login path that preserves a safe destination', () => {
    expect(loginPath('/playground')).toBe('/login?next=%2Fplayground')
    expect(loginPath('/')).toBe('/login')
    expect(loginPath(null)).toBe('/login')
    expect(loginPath('https://evil.example')).toBe('/login')
  })
})
