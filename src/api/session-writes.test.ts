// HTTP-level tests for browser-session authorization of the existing provider
// write APIs (issue #89).
//
// These exercise the dual transport through the real Hono application and a
// real temporary SQLite registry: one protected route table accepts either a
// provider bearer token or the administrator session cookie, both resolve to
// the same provider actor, ownership and audit attribution are unchanged, and
// every cookie-authenticated state change needs the session CSRF token.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import {
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  AdminAuth,
  type AdminLoginConfig,
  LoginRateLimiter,
} from '../auth'
import { createMockCaptureExplorer } from '../capture'
import { validTs11Document } from '../import/test/fixtures'
import { sha256Hex } from '../registry/digest'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import type { AuthenticatedActor } from '../registry/types'
import { CredentialValidator } from '../validation'
import {
  issueTestCredential,
  seedPublishedRulebook,
  type SeededRulebook,
} from '../validation/test-support'

import { API_ROUTES, type ApiRouteSpec } from './routes'

const SESSION_CAPTURE_ID = 'session-capture'

/** A real issued credential in the mock capture envelope, as captures.test uses. */
function credentialCaptureEnvelope(credential: string): Record<string, unknown> {
  const bytes = new TextEncoder().encode(credential)
  return {
    kind: 'attestbook.capture-artifact@1',
    envelopeVersion: 1,
    captureId: SESSION_CAPTURE_ID,
    correlationId: 'session-correlation-1',
    sourceComponent: 'capture-issuer',
    sourceVersion: '0.0.0-mock',
    capturedAt: FIXED_NOW,
    interactionType: 'issuance',
    protocol: 'openid4vci',
    credentialFormat: 'dc+sd-jwt',
    artifactType: 'issued-credential',
    artifact: {
      mediaType: 'application/vc+sd-jwt',
      encoding: 'utf8',
      content: credential,
      byteLength: bytes.byteLength,
    },
    integrity: { algorithm: 'sha256', digest: sha256Hex(bytes) },
    party: { role: 'issuer', identifier: 'https://issuer.example.test', name: 'Example Issuer' },
    testExecutionRef: 'session-execution-1',
    metadata: { environment: 'mock', synthetic: true },
  }
}

const PASSWORD = 'uat-session-write-password'
const PASSWORD_HASH = await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' })
const FIXED_NOW = '2026-01-01T00:00:00.000Z'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

interface SessionCredential {
  readonly providerId: string
  readonly cookie: string
  readonly csrfToken: string
}

interface Harness {
  readonly app: Hono
  readonly fixture: RegistryFixture
  /** Advances the injected session clock, to test expiry deterministically. */
  advance(milliseconds: number): void
  readonly admin: SessionCredential
  /** Bearer token of the administrator's provider. */
  readonly adminToken: string
  /** A second provider with its own token. */
  readonly otherToken: string
  readonly otherActor: AuthenticatedActor
  readonly otherProviderId: string
  /** A published rulebook for operations that need a pinned version. */
  readonly seeded: SeededRulebook
  /** The correlated capture id, present only when a credential capture is wired. */
  readonly captureId: string | null
}

function clock(): { iso: string; advance(milliseconds: number): void } {
  return {
    iso: FIXED_NOW,
    advance(milliseconds: number): void {
      this.iso = new Date(Date.parse(this.iso) + milliseconds).toISOString()
    },
  }
}

async function login(app: Hono): Promise<SessionCredential> {
  const response = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'uat-admin', password: PASSWORD }),
  })
  expect(response.status).toBe(200)
  const setCookie = response.headers.get('set-cookie') ?? ''
  const match = new RegExp(`(?:^|,\\s*)${ADMIN_SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie)
  const value = match?.[1]
  if (value === undefined) {
    throw new Error('login did not set the administrator session cookie')
  }
  const body = (await response.json()) as {
    data: { provider: { id: string }; csrfToken: string }
  }
  return {
    providerId: body.data.provider.id,
    cookie: `${ADMIN_SESSION_COOKIE_NAME}=${value}`,
    csrfToken: body.data.csrfToken,
  }
}

async function setup(
  options: { readonly ttlMs?: number; readonly withCredentialCapture?: boolean } = {},
): Promise<Harness> {
  fixture = createRegistryFixture()
  const admin = provisionProvider(fixture.database, {
    name: 'Session Administrator',
    publicationAuthority: 'session-admin',
  })
  const other = provisionProvider(fixture.database, {
    name: 'Other Session Provider',
    publicationAuthority: 'session-other',
  })
  const now = clock()
  const config: AdminLoginConfig = {
    status: 'configured',
    username: 'uat-admin',
    passwordHash: PASSWORD_HASH,
    providerId: admin.provider.id,
  }
  const adminAuth = new AdminAuth({
    database: fixture.database,
    registry: fixture.registry,
    config,
    now: () => now.iso,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    accountRateLimiter: new LoginRateLimiter({ maxFailures: 10, now: () => Date.parse(now.iso) }),
    clientRateLimiter: new LoginRateLimiter({ maxFailures: 100, now: () => Date.parse(now.iso) }),
  })
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry)
  const validation = new CredentialValidator({ source: fixture.registry })
  const captureId = options.withCredentialCapture === true ? SESSION_CAPTURE_ID : null
  const captures =
    captureId === null
      ? undefined
      : createMockCaptureExplorer({
          validation,
          additionalIssuerEnvelopes: [credentialCaptureEnvelope(await issueTestCredential())],
          now: () => new Date(FIXED_NOW),
        })
  const app = createApp({
    registry: fixture.registry,
    adminAuth,
    validation,
    ...(captures === undefined ? {} : { captures }),
  })
  return {
    app,
    fixture,
    advance(milliseconds: number): void {
      now.advance(milliseconds)
    },
    admin: await login(app),
    adminToken: admin.token.secret,
    otherToken: other.token.secret,
    otherActor: other.actor,
    otherProviderId: other.provider.id,
    seeded,
    captureId,
  }
}

interface RulebookBody {
  readonly name: string
  readonly applicableSpec: string
}

function rulebookBody(name: string): RulebookBody {
  return { name, applicableSpec: 'ts11@1.0.1' }
}

/** A cookie-authenticated write, with or without its CSRF evidence. */
function sessionWrite(
  harness: Harness,
  path: string,
  options: {
    readonly method?: string
    readonly body?: unknown
    readonly csrfToken?: string | null
    readonly origin?: string
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    cookie: harness.admin.cookie,
  }
  if (options.csrfToken !== null) {
    headers[ADMIN_CSRF_HEADER_NAME] = options.csrfToken ?? harness.admin.csrfToken
  }
  if (options.origin !== undefined) {
    headers['origin'] = options.origin
    headers['sec-fetch-site'] = 'cross-site'
  }
  return Promise.resolve(
    harness.app.request(path, {
      method: options.method ?? 'POST',
      headers,
      body: JSON.stringify(options.body ?? {}),
    }),
  )
}

async function bearerWrite(
  harness: Harness,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return harness.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function errorCode(response: Response): Promise<string> {
  return (await json<ErrorEnvelope>(response)).error.code
}

function rulebookCount(harness: Harness): number {
  return harness.fixture.registry.listRulebooks().length
}

function concretePath(route: ApiRouteSpec): string {
  return route.path
    .replace(':rulebookId', '00000000-0000-4000-8000-000000000000')
    .replace(':version', '1.0')
    .replace(':captureId', 'mock-capture-capture-issuer-1')
}

describe('session-authenticated provider writes', () => {
  test('creates a rulebook owned by the administrator provider', async () => {
    const harness = await setup()

    const created = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Session Created Rulebook'),
    })
    expect(created.status).toBe(201)
    const body = await json<{ data: { id: string; providerId: string } }>(created)
    expect(body.data.providerId).toBe(harness.admin.providerId)

    // The public read sees the same owner and needs no credential.
    const publicRead = await harness.app.request(`/api/v1/rulebooks/${body.data.id}`)
    expect(publicRead.status).toBe(200)
    expect((await json<{ data: { providerId: string } }>(publicRead)).data.providerId).toBe(
      harness.admin.providerId,
    )
  })

  test('edits, versions and publishes a rulebook through the session', async () => {
    const harness = await setup()
    const created = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Session Lifecycle Rulebook'),
    })
    const rulebookId = (await json<{ data: { id: string } }>(created)).data.id

    const replaced = await sessionWrite(harness, `/api/v1/rulebooks/${rulebookId}/draft`, {
      method: 'PUT',
      body: rulebookBody('Session Lifecycle Rulebook, edited'),
    })
    expect(replaced.status).toBe(200)

    const version = await sessionWrite(harness, `/api/v1/rulebooks/${rulebookId}/versions`, {
      body: { version: '1.0' },
    })
    expect(version.status).toBe(201)

    const published = await sessionWrite(
      harness,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publish`,
      { body: {} },
    )
    expect(published.status).toBe(200)
    expect(harness.fixture.registry.getRulebookVersion(rulebookId, '1.0')?.status).toBe('published')

    // The audit trail attributes every write to the bound provider, exactly as
    // a bearer-token write would.
    interface AuditRow {
      readonly action: string
      readonly actor_provider_id: string | null
    }
    const rows = harness.fixture.database
      .query<AuditRow, []>('SELECT action, actor_provider_id FROM audit_log ORDER BY id')
      .all()
    for (const action of [
      'rulebook.create',
      'rulebook.update',
      'version.create',
      'version.publish',
    ]) {
      const row = rows.find(
        (candidate) =>
          candidate.action === action && candidate.actor_provider_id === harness.admin.providerId,
      )
      expect(row?.actor_provider_id, `missing ${action} attribution`).toBe(harness.admin.providerId)
    }
  })

  test('imports as the session provider without a synthetic bearer token', async () => {
    const harness = await setup()
    const document = JSON.stringify(validTs11Document)

    const imported = await sessionWrite(harness, '/api/v1/imports', {
      body: { source: { kind: 'json', content: document, name: 'session-import.json' } },
    })
    expect(imported.status).toBe(200)
    const body = await json<{ data: { rulebooks: { providerId: string }[] } }>(imported)
    expect(body.data.rulebooks).toHaveLength(1)
    expect(body.data.rulebooks[0]?.providerId).toBe(harness.admin.providerId)
  })
})

describe('session-authorized capture correlation', () => {
  test('records a pinned-rulebook correlation through the session', async () => {
    const harness = await setup({ withCredentialCapture: true })
    const captureId = harness.captureId
    if (captureId === null) {
      throw new Error('the credential capture was not wired')
    }

    const response = await sessionWrite(harness, `/api/v1/captures/${captureId}/validate`, {
      body: {
        rulebookId: harness.seeded.rulebookId,
        rulebookVersion: harness.seeded.version,
        attestationType: harness.seeded.attestationName,
      },
    })
    expect(response.status).toBe(200)
    const body = await json<{ data: { rulebook: { version: string } } }>(response)
    expect(body.data.rulebook.version).toBe(harness.seeded.version)

    // The correlation is visible to a public reader, exactly as with a bearer
    // token: the route requires authentication but not ownership.
    const detail = await harness.app.request(`/api/v1/captures/${captureId}`)
    expect(detail.status).toBe(200)
  })
})

describe('CSRF protection for cookie-authenticated state changes', () => {
  test('rejects a cookie write without the session CSRF token and writes nothing', async () => {
    const harness = await setup()
    const before = rulebookCount(harness)

    const rejected = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Missing CSRF Rulebook'),
      csrfToken: null,
    })
    expect(rejected.status).toBe(403)
    expect(await errorCode(rejected)).toBe('csrf_failed')
    expect(rulebookCount(harness)).toBe(before)
  })

  test('rejects a wrong or foreign CSRF token', async () => {
    const harness = await setup()
    const before = rulebookCount(harness)

    const wrong = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Wrong CSRF Rulebook'),
      csrfToken: 'not-the-session-token',
    })
    expect(wrong.status).toBe(403)
    expect(await errorCode(wrong)).toBe('csrf_failed')

    // A token minted for another session is not valid for this cookie.
    const second = await login(harness.app)
    expect(second.csrfToken).not.toBe(harness.admin.csrfToken)
    const foreign = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Foreign CSRF Rulebook'),
      csrfToken: second.csrfToken,
    })
    expect(foreign.status).toBe(403)
    expect(await errorCode(foreign)).toBe('csrf_failed')
    expect(rulebookCount(harness)).toBe(before)
  })

  test('rejects a cross-origin cookie write even with a CSRF token', async () => {
    const harness = await setup()
    const before = rulebookCount(harness)

    const rejected = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Cross Origin Rulebook'),
      origin: 'https://evil.example',
    })
    expect(rejected.status).toBe(403)
    expect(await errorCode(rejected)).toBe('csrf_failed')
    expect(rulebookCount(harness)).toBe(before)
  })

  test('every protected state-changing route rejects a cookie request without CSRF', async () => {
    const harness = await setup()
    const stateChanging = API_ROUTES.filter((route) => route.security && route.method !== 'get')
    expect(stateChanging.length).toBeGreaterThan(0)

    for (const route of stateChanging) {
      const response = await harness.app.request(concretePath(route), {
        method: route.method.toUpperCase(),
        headers: {
          'content-type': 'application/json',
          cookie: harness.admin.cookie,
        },
        body: '{not-json',
      })
      expect(response.status, `${route.operationId} must require CSRF`).toBe(403)
      expect(await errorCode(response), `${route.operationId} csrf code`).toBe('csrf_failed')
    }
  })
})

describe('bearer compatibility and credential precedence', () => {
  test('keeps the legacy bearer contract without a session cookie', async () => {
    const harness = await setup()
    const response = await bearerWrite(
      harness,
      '/api/v1/rulebooks',
      harness.otherToken,
      rulebookBody('Legacy Bearer Rulebook'),
    )
    expect(response.status).toBe(201)
    const body = await json<{ data: { providerId: string } }>(response)
    expect(body.data.providerId).toBe(harness.otherProviderId)
  })

  test('an explicit invalid bearer never falls back to the cookie session', async () => {
    const harness = await setup()
    const before = rulebookCount(harness)

    const response = await harness.app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer att_unknown_session_fallback',
        cookie: harness.admin.cookie,
        [ADMIN_CSRF_HEADER_NAME]: harness.admin.csrfToken,
      },
      body: JSON.stringify(rulebookBody('Fallback Rulebook')),
    })
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('unauthorized')
    expect(rulebookCount(harness)).toBe(before)
  })

  test('an explicit bearer takes precedence over a valid cookie session', async () => {
    const harness = await setup()
    const response = await harness.app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${harness.otherToken}`,
        cookie: harness.admin.cookie,
      },
      body: JSON.stringify(rulebookBody('Bearer Precedence Rulebook')),
    })
    expect(response.status).toBe(201)
    expect((await json<{ data: { providerId: string } }>(response)).data.providerId).toBe(
      harness.otherProviderId,
    )
  })
})

describe('expired and revoked sessions', () => {
  test('an expired cookie cannot authorize a write', async () => {
    const harness = await setup({ ttlMs: 1_000 })
    // The session clock is injected; advancing it past the TTL expires the
    // cookie without waiting in wall-clock time.
    harness.advance(2_000)
    const before = rulebookCount(harness)

    const response = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Expired Session Rulebook'),
    })
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('unauthorized')
    expect(rulebookCount(harness)).toBe(before)
  })

  test('a revoked cookie cannot authorize a write', async () => {
    const harness = await setup()
    const logout = await harness.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie: harness.admin.cookie, [ADMIN_CSRF_HEADER_NAME]: harness.admin.csrfToken },
    })
    expect(logout.status).toBe(204)

    const response = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Revoked Session Rulebook'),
    })
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('unauthorized')
  })
})

describe('ownership semantics are unchanged', () => {
  test('an administrator session cannot mutate another provider’s rulebook', async () => {
    const harness = await setup()
    const foreign = await bearerWrite(
      harness,
      '/api/v1/rulebooks',
      harness.otherToken,
      rulebookBody('Foreign Provider Rulebook'),
    )
    const foreignId = (await json<{ data: { id: string } }>(foreign)).data.id

    const before = harness.fixture.registry.getRulebook(foreignId)
    const rejected = await sessionWrite(harness, `/api/v1/rulebooks/${foreignId}/draft`, {
      method: 'PUT',
      body: rulebookBody('Hijacked'),
    })
    expect(rejected.status).toBe(403)
    expect(await errorCode(rejected)).toBe('forbidden')
    expect(harness.fixture.registry.getRulebook(foreignId)).toEqual(before)
  })

  test('a session cannot forge its provider through the request body', async () => {
    const harness = await setup()
    const created = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: {
        ...rulebookBody('Forged Provider Rulebook'),
        providerId: harness.otherProviderId,
        metadata: { injected: true },
        provenance: { injected: true },
      },
    })
    expect(created.status).toBe(201)
    const body = await json<{ data: { id: string; providerId: string } }>(created)
    expect(body.data.providerId).toBe(harness.admin.providerId)
    const stored = harness.fixture.registry.getRulebook(body.data.id)
    expect(stored?.providerId).toBe(harness.admin.providerId)
    expect(stored?.metadata).toEqual({})
    expect(stored?.provenance).toEqual({})
  })

  test('public catalog reads stay anonymous', async () => {
    const harness = await setup()
    const created = await sessionWrite(harness, '/api/v1/rulebooks', {
      body: rulebookBody('Publicly Readable Rulebook'),
    })
    const rulebookId = (await json<{ data: { id: string } }>(created)).data.id

    // The anonymous catalogue and detail reads are unchanged by the new write
    // credential: they never require a bearer token or a session cookie.
    for (const path of [
      '/api/v1/rulebooks',
      `/api/v1/rulebooks/${rulebookId}`,
      `/api/v1/rulebooks/${rulebookId}/draft`,
      `/api/v1/rulebooks/${rulebookId}/versions`,
    ]) {
      const response = await harness.app.request(path)
      expect(response.status, path).toBe(200)
    }
  })
})
