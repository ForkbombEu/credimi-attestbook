// HTTP-level tests for the administrator browser login and sessions (issue #88).

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  AdminAuth,
  type AdminLoginConfig,
  LoginRateLimiter,
  hashAdminSessionId,
} from '../auth'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { adminSessionResponseSchema } from './schemas'

const PASSWORD = 'uat-test-password'
const PASSWORD_HASH = await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' })

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

interface Clock {
  iso: string
  advance(milliseconds: number): void
}

interface Harness {
  readonly app: Hono
  readonly fixture: RegistryFixture
  readonly adminAuth: AdminAuth | undefined
  readonly adminProviderId: string
  readonly bearerToken: string
  readonly clock: Clock
}

function setup(
  options: {
    readonly config?: AdminLoginConfig
    readonly maxFailures?: number
    readonly ttlMs?: number
    readonly withAuth?: boolean
  } = {},
): Harness {
  fixture = createRegistryFixture()
  const provisioned = provisionProvider(fixture.database, {
    name: 'UAT Administrator Provider',
    publicationAuthority: 'uat-administrator',
  })
  const clock: Clock = {
    iso: '2026-01-01T00:00:00.000Z',
    advance(milliseconds: number): void {
      this.iso = new Date(Date.parse(this.iso) + milliseconds).toISOString()
    },
  }
  const config: AdminLoginConfig = options.config ?? {
    status: 'configured',
    username: 'uat-admin',
    passwordHash: PASSWORD_HASH,
    providerId: provisioned.provider.id,
  }
  const adminAuth =
    options.withAuth === false
      ? undefined
      : new AdminAuth({
          database: fixture.database,
          registry: fixture.registry,
          config,
          now: () => clock.iso,
          ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
          accountRateLimiter: new LoginRateLimiter({
            maxFailures: options.maxFailures ?? 5,
            now: () => Date.parse(clock.iso),
          }),
          clientRateLimiter: new LoginRateLimiter({
            maxFailures: 100,
            now: () => Date.parse(clock.iso),
          }),
        })

  return {
    app: createApp({
      registry: fixture.registry,
      ...(adminAuth === undefined ? {} : { adminAuth }),
    }),
    fixture,
    adminAuth,
    adminProviderId: provisioned.provider.id,
    bearerToken: provisioned.token.secret,
    clock,
  }
}

function postLogin(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )
}

function loginHeaders(response: Response): string {
  return response.headers.get('set-cookie') ?? ''
}

function sessionCookie(response: Response): string {
  const match = /(?:^|,\s*)attestbook_admin_session=([^;]+)/.exec(loginHeaders(response))
  const value = match?.[1]
  if (value === undefined) {
    throw new Error('the response did not set an administrator session cookie')
  }
  return `${ADMIN_SESSION_COOKIE_NAME}=${value}`
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function errorJson(response: Response): Promise<ErrorEnvelope> {
  return json<ErrorEnvelope>(response)
}

function sessionCount(harness: Harness): number {
  return (
    harness.fixture.database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM admin_sessions')
      .get()?.count ?? 0
  )
}

function tokenCount(harness: Harness): number {
  return (
    harness.fixture.database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM auth_tokens')
      .get()?.count ?? 0
  )
}

async function successfulLogin(
  harness: Harness,
): Promise<{ response: Response; cookie: string; csrfToken: string }> {
  const response = await postLogin(harness.app, {
    username: 'uat-admin',
    password: PASSWORD,
  })
  expect(response.status).toBe(200)
  const body = await json<{ data: { csrfToken: string } }>(response)
  return { response, cookie: sessionCookie(response), csrfToken: body.data.csrfToken }
}

describe('administrator login', () => {
  test('logs in with an existing provider and sets a hardened session cookie', async () => {
    const harness = setup()
    const beforeTokens = tokenCount(harness)

    const response = await postLogin(harness.app, {
      username: 'uat-admin',
      password: PASSWORD,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')

    const cookie = loginHeaders(response)
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE_NAME}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${String(ADMIN_SESSION_TTL_MS / 1_000)}`)
    expect(cookie).not.toContain('Secure')
    expect(cookie).not.toContain(PASSWORD)

    const body = await json<unknown>(response)
    const parsed = adminSessionResponseSchema.parse(body)
    expect(parsed.data.provider.id).toBe(harness.adminProviderId)
    expect(parsed.data.provider).not.toHaveProperty('publicationAuthority')
    expect(parsed.data.provider).not.toHaveProperty('metadata')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('att_')
    expect(serialized).not.toContain(PASSWORD)
    expect(serialized).not.toContain(PASSWORD_HASH)

    // Login never creates a provider bearer token or stores one in the session.
    expect(tokenCount(harness)).toBe(beforeTokens)
    expect(sessionCount(harness)).toBe(1)

    const me = await harness.app.request('/api/v1/auth/me', {
      headers: { cookie: sessionCookie(response) },
    })
    expect(me.status).toBe(200)
    const meBody = await json<unknown>(me)
    expect(adminSessionResponseSchema.parse(meBody).data.provider.id).toBe(harness.adminProviderId)
    expect(JSON.stringify(meBody)).not.toContain('att_')
  })

  test('answers wrong passwords and unknown usernames with the same generic 401', async () => {
    const harness = setup()

    const wrongPassword = await postLogin(harness.app, {
      username: 'uat-admin',
      password: 'wrong-password',
    })
    const unknownUser = await postLogin(harness.app, {
      username: 'not-the-admin',
      password: PASSWORD,
    })

    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    expect(loginHeaders(wrongPassword)).toBe('')
    expect(loginHeaders(unknownUser)).toBe('')
    expect(wrongPassword.headers.get('www-authenticate')).toBeNull()
    const wrongBody = await errorJson(wrongPassword)
    const unknownBody = await errorJson(unknownUser)
    expect(wrongBody).toEqual(unknownBody)
    expect(wrongBody.error.code).toBe('unauthorized')
    expect(JSON.stringify(wrongBody)).not.toContain('att_')
    expect(sessionCount(harness)).toBe(0)
  })

  test('rejects a non-JSON login body before verifying credentials', async () => {
    const harness = setup()
    const response = await harness.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ username: 'uat-admin', password: PASSWORD }),
    })
    expect(response.status).toBe(400)
    expect((await errorJson(response)).error.code).toBe('invalid_request')
    expect(sessionCount(harness)).toBe(0)
  })

  test('sets Secure when the request is served over HTTPS', async () => {
    const harness = setup()
    const response = await postLogin(
      harness.app,
      { username: 'uat-admin', password: PASSWORD },
      { origin: 'https://localhost', 'x-forwarded-proto': 'https' },
    )
    expect(response.status).toBe(200)
    expect(loginHeaders(response)).toContain('Secure')
  })

  test('rejects a cross-origin login attempt', async () => {
    const harness = setup()
    const response = await postLogin(
      harness.app,
      { username: 'uat-admin', password: PASSWORD },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    )
    expect(response.status).toBe(403)
    expect((await errorJson(response)).error.code).toBe('forbidden')
    expect(loginHeaders(response)).toBe('')
    expect(sessionCount(harness)).toBe(0)
  })

  test('rotates the session presented at login instead of adopting it', async () => {
    const harness = setup()
    const first = await successfulLogin(harness)
    const firstValue = first.cookie.split('=')[1] ?? ''

    const second = await postLogin(
      harness.app,
      { username: 'uat-admin', password: PASSWORD },
      { cookie: first.cookie },
    )
    expect(second.status).toBe(200)
    const secondCookie = sessionCookie(second)
    expect(secondCookie).not.toBe(first.cookie)
    expect(secondCookie.split('=')[1]).not.toBe(firstValue)

    const oldSession = await harness.app.request('/api/v1/auth/me', {
      headers: { cookie: first.cookie },
    })
    expect(oldSession.status).toBe(401)
    const newSession = await harness.app.request('/api/v1/auth/me', {
      headers: { cookie: secondCookie },
    })
    expect(newSession.status).toBe(200)
  })
})

describe('administrator session reads and logout', () => {
  test('answers 401 without a bearer challenge when the session is missing', async () => {
    const harness = setup()
    const response = await harness.app.request('/api/v1/auth/me')
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect((await errorJson(response)).error.code).toBe('unauthorized')
  })

  test('logout revokes the server-side session and expires the cookie', async () => {
    const harness = setup()
    const { cookie, csrfToken } = await successfulLogin(harness)
    const headers = { cookie, 'x-csrf-token': csrfToken }

    const logout = await harness.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers,
    })
    expect(logout.status).toBe(204)
    expect(await logout.text()).toBe('')
    expect(loginHeaders(logout)).toContain(`${ADMIN_SESSION_COOKIE_NAME}=`)
    expect(loginHeaders(logout)).toContain('Max-Age=0')

    const afterLogout = await harness.app.request('/api/v1/auth/me', { headers: { cookie } })
    expect(afterLogout.status).toBe(401)

    const row = harness.fixture.database
      .query<{ revoked_at: string | null }, []>('SELECT revoked_at FROM admin_sessions')
      .get()
    expect(row?.revoked_at).not.toBeNull()

    // Repeated logout is idempotent and still succeeds.
    const again = await harness.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers,
    })
    expect(again.status).toBe(204)
  })

  test('refuses logout of a live session without its CSRF token', async () => {
    const harness = setup()
    const { cookie } = await successfulLogin(harness)

    const response = await harness.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie },
    })
    expect(response.status).toBe(403)
    expect((await errorJson(response)).error.code).toBe('csrf_failed')
    // A refused logout must not expire the cookie or revoke the session.
    expect(loginHeaders(response)).not.toContain('Max-Age=0')

    const stillAuthenticated = await harness.app.request('/api/v1/auth/me', {
      headers: { cookie },
    })
    expect(stillAuthenticated.status).toBe(200)

    const sessionValue = cookie.split('=')[1] ?? ''
    const row = harness.fixture.database
      .query<{ revoked_at: string | null }, [string]>(
        'SELECT revoked_at FROM admin_sessions WHERE session_hash = ?',
      )
      .get(hashAdminSessionId(sessionValue))
    expect(row?.revoked_at).toBeNull()
  })

  test('refuses logout with a wrong or foreign CSRF token', async () => {
    const harness = setup()
    const first = await successfulLogin(harness)
    // Logging in again without sending the first cookie creates a second live
    // session instead of rotating the first one, so the second token is a
    // valid token for a different session.
    const second = await successfulLogin(harness)

    for (const token of ['not-the-session-token', second.csrfToken]) {
      const response = await harness.app.request('/api/v1/auth/logout', {
        method: 'POST',
        headers: { cookie: first.cookie, 'x-csrf-token': token },
      })
      expect(response.status, `logout with ${token}`).toBe(403)
      expect((await errorJson(response)).error.code).toBe('csrf_failed')
      expect(loginHeaders(response)).not.toContain('Max-Age=0')
    }

    const stillAuthenticated = await harness.app.request('/api/v1/auth/me', {
      headers: { cookie: first.cookie },
    })
    expect(stillAuthenticated.status).toBe(200)
  })

  test('logout without a live session needs no CSRF token', async () => {
    const harness = setup()

    const anonymous = await harness.app.request('/api/v1/auth/logout', { method: 'POST' })
    expect(anonymous.status).toBe(204)

    const unknown = await harness.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=unknown-session-id` },
    })
    expect(unknown.status).toBe(204)
  })

  test('rejects a cross-origin logout without revoking the session', async () => {
    const harness = setup()
    const { cookie, csrfToken } = await successfulLogin(harness)

    const response = await harness.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    })
    expect(response.status).toBe(403)
    expect((await errorJson(response)).error.code).toBe('forbidden')

    const stillAuthenticated = await harness.app.request('/api/v1/auth/me', {
      headers: { cookie },
    })
    expect(stillAuthenticated.status).toBe(200)
  })

  test('expires the session after its bounded lifetime', async () => {
    const harness = setup()
    const { cookie } = await successfulLogin(harness)

    harness.clock.advance(ADMIN_SESSION_TTL_MS)
    const response = await harness.app.request('/api/v1/auth/me', { headers: { cookie } })
    expect(response.status).toBe(401)
  })
})

describe('administrator login availability and limits', () => {
  test('answers 503 when the configuration is absent, while public reads and bearer writes work', async () => {
    const harness = setup({ withAuth: false })

    const login = await postLogin(harness.app, { username: 'uat-admin', password: PASSWORD })
    expect(login.status).toBe(503)
    expect((await errorJson(login)).error.code).toBe('auth_unavailable')

    const publicRead = await harness.app.request('/api/v1/rulebooks')
    expect(publicRead.status).toBe(200)

    const created = await harness.app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${harness.bearerToken}`,
      },
      body: JSON.stringify({ name: 'Bearer Still Works', applicableSpec: 'ts11@1.0.1' }),
    })
    expect(created.status).toBe(201)
  })

  test('answers 503 for a disabled or invalid configuration', async () => {
    const disabled = setup({
      config: { status: 'disabled', reason: 'administrator login is not configured' },
    })
    const disabledLogin = await postLogin(disabled.app, {
      username: 'uat-admin',
      password: PASSWORD,
    })
    expect(disabledLogin.status).toBe(503)
    expect((await errorJson(disabledLogin)).error.code).toBe('auth_unavailable')
    expect((await disabled.app.request('/api/v1/rulebooks')).status).toBe(200)

    const invalid = setup({ config: { status: 'invalid', reason: 'bad configuration' } })
    const invalidLogin = await postLogin(invalid.app, {
      username: 'uat-admin',
      password: PASSWORD,
    })
    expect(invalidLogin.status).toBe(503)
    expect((await errorJson(invalidLogin)).error.code).toBe('auth_unavailable')
  })

  test('answers 503 when the configured provider does not exist', async () => {
    const harness = setup({
      config: {
        status: 'configured',
        username: 'uat-admin',
        passwordHash: PASSWORD_HASH,
        providerId: '00000000-0000-4000-8000-000000000000',
      },
    })
    const response = await postLogin(harness.app, { username: 'uat-admin', password: PASSWORD })
    expect(response.status).toBe(503)
    expect((await errorJson(response)).error.code).toBe('auth_unavailable')
    expect(sessionCount(harness)).toBe(0)
    expect((await harness.app.request('/api/v1/rulebooks')).status).toBe(200)
  })

  test('rate limits repeated failures with a typed 429 and Retry-After', async () => {
    const harness = setup({ maxFailures: 2 })

    expect(
      (await postLogin(harness.app, { username: 'uat-admin', password: 'wrong-1' })).status,
    ).toBe(401)
    expect(
      (await postLogin(harness.app, { username: 'uat-admin', password: 'wrong-2' })).status,
    ).toBe(401)

    const limited = await postLogin(harness.app, { username: 'uat-admin', password: PASSWORD })
    expect(limited.status).toBe(429)
    const retryAfter = Number(limited.headers.get('retry-after'))
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThan(0)
    expect((await errorJson(limited)).error.code).toBe('rate_limited')
    expect(sessionCount(harness)).toBe(0)

    // Public reads are unaffected by the login bound.
    expect((await harness.app.request('/api/v1/rulebooks')).status).toBe(200)
  })

  test('bounds parallel login attempts instead of only sequential ones', async () => {
    const harness = setup()

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        postLogin(harness.app, {
          username: 'uat-admin',
          password: `wrong-${String(index)}`,
        }),
      ),
    )

    const unauthorized = responses.filter((response) => response.status === 401)
    const limited = responses.filter((response) => response.status === 429)
    expect(unauthorized.length).toBeLessThanOrEqual(5)
    expect(limited.length).toBeGreaterThanOrEqual(5)
    expect(unauthorized.length + limited.length).toBe(responses.length)

    for (const response of limited) {
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
      expect((await errorJson(response)).error.code).toBe('rate_limited')
    }
    expect(sessionCount(harness)).toBe(0)
  })
})
