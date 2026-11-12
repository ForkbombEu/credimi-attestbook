// Service-level tests for the environment-configured administrator login and
// opaque server-side sessions (issue #88).

import { afterEach, describe, expect, test } from 'bun:test'

import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import {
  ADMIN_PASSWORD_HASH_ENV,
  ADMIN_PROVIDER_ID_ENV,
  ADMIN_SESSION_TTL_MS,
  ADMIN_USERNAME_ENV,
  AdminAuth,
  type AdminLoginConfig,
  LoginRateLimiter,
  hashAdminSessionId,
  isSameOriginRequest,
  loadAdminLoginConfig,
  requestUsesHttps,
} from './index'

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

function createClock(): Clock {
  return {
    iso: '2026-01-01T00:00:00.000Z',
    advance(milliseconds: number): void {
      this.iso = new Date(Date.parse(this.iso) + milliseconds).toISOString()
    },
  }
}

interface Harness {
  readonly fixture: RegistryFixture
  readonly providerId: string
  readonly auth: AdminAuth
  readonly clock: Clock
  readonly config: AdminLoginConfig
}

function setup(
  options: {
    readonly config?: AdminLoginConfig
    readonly maxFailures?: number
    readonly ttlMs?: number
  } = {},
): Harness {
  fixture = createRegistryFixture()
  const provisioned = provisionProvider(fixture.database, {
    name: 'UAT Administrator Provider',
    publicationAuthority: 'uat-administrator',
  })
  const clock = createClock()
  const config: AdminLoginConfig = options.config ?? {
    status: 'configured',
    username: 'uat-admin',
    passwordHash: PASSWORD_HASH,
    providerId: provisioned.provider.id,
  }
  const auth = new AdminAuth({
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
  return { fixture, providerId: provisioned.provider.id, auth, clock, config }
}

function sessionRows(harness: Harness): readonly {
  readonly session_hash: string
  readonly provider_id: string
  readonly expires_at: string
  readonly revoked_at: string | null
}[] {
  return harness.fixture.database
    .query<
      { session_hash: string; provider_id: string; expires_at: string; revoked_at: string | null },
      []
    >('SELECT session_hash, provider_id, expires_at, revoked_at FROM admin_sessions')
    .all()
}

function tokenCount(harness: Harness): number {
  return (
    harness.fixture.database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM auth_tokens')
      .get()?.count ?? 0
  )
}

async function login(
  harness: Harness,
  overrides: {
    readonly username?: string
    readonly password?: string
    readonly currentSessionId?: string
  } = {},
) {
  return harness.auth.login({
    username: overrides.username ?? 'uat-admin',
    password: overrides.password ?? PASSWORD,
    clientKey: 'test-client',
    ...(overrides.currentSessionId === undefined
      ? {}
      : { currentSessionId: overrides.currentSessionId }),
  })
}

describe('administrator login configuration', () => {
  test('is disabled when the whole group is absent', () => {
    expect(loadAdminLoginConfig({})).toEqual({
      status: 'disabled',
      reason: 'administrator login is not configured',
    })
  })

  test('is invalid when only part of the group is set and never echoes the hash', () => {
    const result = loadAdminLoginConfig({
      [ADMIN_USERNAME_ENV]: 'uat-admin',
      [ADMIN_PASSWORD_HASH_ENV]: PASSWORD_HASH,
    })
    expect(result.status).toBe('invalid')
    expect(result.status === 'invalid' ? result.reason : '').not.toContain(PASSWORD_HASH)
  })

  test('rejects a malformed, weak or non-Argon2id hash', () => {
    const providerId = 'provider-id'
    for (const passwordHash of [
      'not-a-hash',
      '$2b$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN',
      '$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHRzYWx0$cmVzdWx0cmVzdWx0cmVzdWx0cmVzdWx0cmVzdWx0',
    ]) {
      const result = loadAdminLoginConfig({
        [ADMIN_USERNAME_ENV]: 'uat-admin',
        [ADMIN_PASSWORD_HASH_ENV]: passwordHash,
        [ADMIN_PROVIDER_ID_ENV]: providerId,
      })
      expect(result.status).toBe('invalid')
    }
  })

  test('accepts a strong Argon2id hash and trims surrounding whitespace', () => {
    expect(
      loadAdminLoginConfig({
        [ADMIN_USERNAME_ENV]: '  uat-admin  ',
        [ADMIN_PASSWORD_HASH_ENV]: ` ${PASSWORD_HASH}\n`,
        [ADMIN_PROVIDER_ID_ENV]: ' provider-id ',
      }),
    ).toEqual({
      status: 'configured',
      username: 'uat-admin',
      passwordHash: PASSWORD_HASH,
      providerId: 'provider-id',
    })
  })
})

describe('admin session login', () => {
  test('issues an opaque session bound to the existing provider', async () => {
    const harness = setup()
    const beforeTokens = tokenCount(harness)

    const outcome = await login(harness)
    expect(outcome.kind).toBe('authenticated')
    if (outcome.kind !== 'authenticated') {
      throw new Error('expected an authenticated login')
    }

    expect(outcome.provider.id).toBe(harness.providerId)
    expect(outcome.provider.name).toBe('UAT Administrator Provider')
    expect(outcome.sessionId.length).toBeGreaterThanOrEqual(43)
    expect(outcome.maxAgeSeconds).toBe(ADMIN_SESSION_TTL_MS / 1_000)

    const rows = sessionRows(harness)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.session_hash).toBe(hashAdminSessionId(outcome.sessionId))
    expect(rows[0]?.session_hash).not.toBe(outcome.sessionId)
    expect(rows[0]?.provider_id).toBe(harness.providerId)
    expect(rows[0]?.revoked_at).toBeNull()
    expect(Date.parse(rows[0]?.expires_at ?? '') - Date.parse(harness.clock.iso)).toBe(
      ADMIN_SESSION_TTL_MS,
    )

    const resolved = harness.auth.resolveSession(outcome.sessionId)
    expect(resolved?.provider.id).toBe(harness.providerId)
    expect(resolved?.expiresAt).toBe(outcome.expiresAt)

    // Login must not mint, expose or persist a provider bearer token.
    expect(tokenCount(harness)).toBe(beforeTokens)
    expect(JSON.stringify(rows)).not.toContain('att_')
    expect(JSON.stringify(outcome)).not.toContain('att_')
  })

  test('answers the same generic outcome for a wrong password and an unknown username', async () => {
    const harness = setup()

    const wrongPassword = await login(harness, { password: 'wrong-password' })
    const unknownUser = await login(harness, { username: 'not-the-admin' })
    expect(wrongPassword).toEqual({ kind: 'invalid_credentials' })
    expect(unknownUser).toEqual({ kind: 'invalid_credentials' })
    expect(sessionRows(harness)).toHaveLength(0)
  })

  test('is unavailable when the configured provider does not exist', async () => {
    const harness = setup({
      config: {
        status: 'configured',
        username: 'uat-admin',
        passwordHash: PASSWORD_HASH,
        providerId: '00000000-0000-4000-8000-000000000000',
      },
    })

    expect(await login(harness)).toEqual({ kind: 'unavailable' })
    expect(sessionRows(harness)).toHaveLength(0)
  })

  test('is unavailable when the configuration is absent or invalid', async () => {
    const disabled = setup({
      config: { status: 'disabled', reason: 'administrator login is not configured' },
    })
    expect(await login(disabled)).toEqual({ kind: 'unavailable' })
    expect(disabled.auth.unavailableReason).toBe('administrator login is not configured')

    const invalid = setup({ config: { status: 'invalid', reason: 'bad configuration' } })
    expect(await login(invalid)).toEqual({ kind: 'unavailable' })
    expect(invalid.auth.isConfigured).toBe(false)
  })

  test('rate limits repeated failures for the account', async () => {
    const harness = setup({ maxFailures: 2 })

    expect((await login(harness, { password: 'wrong-1' })).kind).toBe('invalid_credentials')
    expect((await login(harness, { password: 'wrong-2' })).kind).toBe('invalid_credentials')

    const limited = await login(harness)
    expect(limited.kind).toBe('rate_limited')
    if (limited.kind === 'rate_limited') {
      expect(limited.scope).toBe('account')
      expect(limited.retryAfterSeconds).toBeGreaterThan(0)
    }

    // The bound is time-bounded, not a permanent lockout.
    harness.clock.advance(16 * 60 * 1_000)
    expect((await login(harness)).kind).toBe('authenticated')
  })

  test('a successful login clears the failure budget', async () => {
    const harness = setup({ maxFailures: 2 })

    expect((await login(harness, { password: 'wrong' })).kind).toBe('invalid_credentials')
    expect((await login(harness)).kind).toBe('authenticated')
    expect((await login(harness, { password: 'wrong' })).kind).toBe('invalid_credentials')
    expect((await login(harness, { password: 'wrong' })).kind).toBe('invalid_credentials')
    expect((await login(harness)).kind).toBe('rate_limited')
  })

  test('expires sessions at the absolute lifetime bound', async () => {
    const harness = setup()
    const outcome = await login(harness)
    if (outcome.kind !== 'authenticated') {
      throw new Error('expected an authenticated login')
    }

    harness.clock.advance(ADMIN_SESSION_TTL_MS - 1)
    expect(harness.auth.resolveSession(outcome.sessionId)).not.toBeNull()

    harness.clock.advance(1)
    expect(harness.auth.resolveSession(outcome.sessionId)).toBeNull()
  })

  test('logout revokes the session and is idempotent', async () => {
    const harness = setup()
    const outcome = await login(harness)
    if (outcome.kind !== 'authenticated') {
      throw new Error('expected an authenticated login')
    }

    harness.auth.logout(outcome.sessionId)
    expect(harness.auth.resolveSession(outcome.sessionId)).toBeNull()
    expect(sessionRows(harness)[0]?.revoked_at).toBe(harness.clock.iso)

    harness.auth.logout(outcome.sessionId)
    expect(harness.auth.resolveSession(outcome.sessionId)).toBeNull()

    harness.auth.logout(null)
    expect(sessionRows(harness)).toHaveLength(1)
  })

  test('rotating the configured administrator invalidates outstanding sessions', async () => {
    const harness = setup()
    const outcome = await login(harness)
    if (outcome.kind !== 'authenticated') {
      throw new Error('expected an authenticated login')
    }

    const rotated = new AdminAuth({
      database: harness.fixture.database,
      registry: harness.fixture.registry,
      config: {
        status: 'configured',
        username: 'another-admin',
        passwordHash: PASSWORD_HASH,
        providerId: harness.providerId,
      },
      now: () => harness.clock.iso,
    })
    expect(rotated.resolveSession(outcome.sessionId)).toBeNull()
  })

  test('login rotates the session the browser presented', async () => {
    const harness = setup()
    const first = await login(harness)
    if (first.kind !== 'authenticated') {
      throw new Error('expected an authenticated login')
    }

    const second = await login(harness, { currentSessionId: first.sessionId })
    if (second.kind !== 'authenticated') {
      throw new Error('expected an authenticated login')
    }

    expect(second.sessionId).not.toBe(first.sessionId)
    expect(harness.auth.resolveSession(first.sessionId)).toBeNull()
    expect(harness.auth.resolveSession(second.sessionId)).not.toBeNull()
  })
})

describe('same-origin request checks', () => {
  test('accepts matching, absent and direct-navigation origins', () => {
    expect(
      isSameOriginRequest({
        url: 'https://attestbook.example/api/v1/auth/login',
        origin: 'https://attestbook.example',
        secFetchSite: 'same-origin',
      }),
    ).toBe(true)
    expect(isSameOriginRequest({ url: 'http://127.0.0.1:3000/x' })).toBe(true)
    expect(
      isSameOriginRequest({
        url: 'https://attestbook.example/x',
        origin: 'https://attestbook.example',
        secFetchSite: 'none',
      }),
    ).toBe(true)
  })

  test('rejects a foreign origin, a null origin and a cross-site fetch', () => {
    expect(
      isSameOriginRequest({
        url: 'https://attestbook.example/api/v1/auth/login',
        origin: 'https://evil.example',
      }),
    ).toBe(false)
    expect(
      isSameOriginRequest({
        url: 'https://attestbook.example/x',
        origin: 'null',
      }),
    ).toBe(false)
    expect(
      isSameOriginRequest({
        url: 'https://attestbook.example/x',
        origin: 'https://attestbook.example',
        secFetchSite: 'cross-site',
      }),
    ).toBe(false)
    expect(
      isSameOriginRequest({
        url: 'https://attestbook.example/x',
        origin: 'not a url',
      }),
    ).toBe(false)
  })

  test('honours a TLS-terminating reverse proxy for Secure cookies and origins', () => {
    expect(requestUsesHttps({ url: 'http://attestbook:3000/x', forwardedProto: 'https' })).toBe(
      true,
    )
    expect(requestUsesHttps({ url: 'https://attestbook.example/x' })).toBe(true)
    expect(
      isSameOriginRequest({
        url: 'http://internal:3000/api/v1/auth/login',
        origin: 'https://attestbook.example',
        forwardedProto: 'https',
        forwardedHost: 'attestbook.example',
      }),
    ).toBe(true)
  })
})
