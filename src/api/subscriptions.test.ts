// HTTP contract tests for anonymous webhook subscriptions (issue #117).
//
// These exercise the real Hono application, a real migrated SQLite database and
// the real subscription service. They cover the UAT scenarios (anonymous
// registration and management, rejection of an unsafe callback), the uniform
// management-token refusal, idempotent deletion, restart persistence and the
// two abuse bounds. No test performs a network request.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../app'
import { openMigratedDatabase } from '../registry/test-support'
import { Registry } from '../registry/registry'
import { provisionProvider } from '../registry/bootstrap'
import { seedPublishedRulebook, type SeededRulebook } from '../validation/test-support'

import type { SubscriptionServiceOptions } from '../subscriptions'
import { SubscriptionService } from '../subscriptions'

import { registeredSubscriptionResponseSchema, subscriptionResponseSchema } from './schemas'

interface Fixture {
  readonly directory: string
  readonly databasePath: string
  database: Database
  registry: Registry
  service: SubscriptionService
  readonly seeded: SeededRulebook
  readonly options: Partial<SubscriptionServiceOptions>
  app(): Hono
  register(rulebookId?: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
  reopen(): void
  cleanup(): void
}

function createFixture(overrides: Partial<SubscriptionServiceOptions> = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'attestbook-subscription-api-'))
  const databasePath = join(directory, 'attestbook.sqlite')
  let database = openMigratedDatabase(databasePath)
  let registry = new Registry({ database })
  const seeded = seedPublishedRulebook(database, registry)
  const options: Partial<SubscriptionServiceOptions> = overrides
  let service = new SubscriptionService({ database, source: registry, ...options })

  const fixture: Fixture = {
    directory,
    databasePath,
    get database() {
      return database
    },
    get registry() {
      return registry
    },
    get service() {
      return service
    },
    seeded,
    options,
    app() {
      return createApp({ registry, subscriptions: service })
    },
    async register(
      rulebookId = seeded.rulebookId,
      body = { callbackUrl: 'https://subscriber.example.test/webhook' },
      headers = {},
    ) {
      return this.app().request(`/api/v1/rulebooks/${rulebookId}/subscriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    },
    reopen() {
      database.close()
      database = openMigratedDatabase(databasePath)
      registry = new Registry({ database })
      service = new SubscriptionService({ database, source: registry, ...options })
    },
    cleanup() {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
  return fixture
}

let fixture: Fixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function jsonBody<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

async function register(fixture: Fixture): Promise<{
  readonly id: string
  readonly token: string
  readonly callbackUrl: string
}> {
  const response = await fixture.register()
  expect(response.status).toBe(201)
  const body = registeredSubscriptionResponseSchema.parse(await response.json())
  return {
    id: body.data.id,
    token: body.data.managementToken,
    callbackUrl: body.data.callbackUrl,
  }
}

function managementPath(id: string): string {
  return `/api/v1/subscriptions/${id}`
}

function bearer(token: string): string {
  return `Bearer ${token}`
}

function rows(database: Database): readonly Record<string, unknown>[] {
  return database
    .query<Record<string, unknown>, []>('SELECT * FROM subscriptions ORDER BY rowid')
    .all()
}

describe('anonymous subscription registration over HTTP', () => {
  test('UAT-1: register anonymously, then read only with the one-time management token', async () => {
    fixture = createFixture()

    const response = await fixture.register()
    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toMatch(/^\/api\/v1\/subscriptions\//)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = registeredSubscriptionResponseSchema.parse(await response.json())
    expect(body.data.state).toBe('pending')
    expect(body.data.rulebookId).toBe(fixture.seeded.rulebookId)
    expect(body.data.managementToken.startsWith('ats_')).toBe(true)
    expect(JSON.stringify(body.data)).not.toContain('managementTokenHash')

    const stored = rows(fixture.database)
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(body.data.managementToken)

    // Without the management token the callback URL is not readable.
    const anonymous = await fixture.app().request(managementPath(body.data.id))
    expect(anonymous.status).toBe(401)
    expect((await jsonBody<{ error: { code: string } }>(anonymous)).error.code).toBe('unauthorized')

    // The provider bearer token is not a subscription credential.
    const provider = await fixture.app().request(managementPath(body.data.id), {
      headers: { authorization: bearer(fixture.seeded.token) },
    })
    expect(provider.status).toBe(401)

    // With the correct token the subscriber sees its own record and no secret.
    const readable = await fixture.app().request(managementPath(body.data.id), {
      headers: { authorization: bearer(body.data.managementToken) },
    })
    expect(readable.status).toBe(200)
    expect(readable.headers.get('cache-control')).toBe('no-store')
    const projection = subscriptionResponseSchema.parse(await readable.json())
    expect(projection.data.callbackUrl).toBe('https://subscriber.example.test/webhook')
    expect(projection.data.state).toBe('pending')
    expect(projection.data).not.toHaveProperty('managementToken')
    expect(projection.data).not.toHaveProperty('managementTokenHash')
  })

  test('UAT-2: reject an unsafe callback without storing a subscription', async () => {
    fixture = createFixture()
    const response = await fixture.register(fixture.seeded.rulebookId, {
      callbackUrl: 'http://169.254.169.254/latest/meta-data/',
    })
    expect(response.status).toBe(400)
    expect((await jsonBody<{ error: { code: string } }>(response)).error.code).toBe(
      'invalid_request',
    )
    expect(rows(fixture.database)).toHaveLength(0)
  })

  test('rejects unknown and unpublished rulebooks and malformed payloads', async () => {
    fixture = createFixture()
    const unknown = await fixture.register('missing-rulebook')
    expect(unknown.status).toBe(404)

    const provider = provisionProvider(fixture.database, {
      name: 'Unpublished Provider',
      publicationAuthority: 'unpublished-authority',
    })
    const draft = fixture.registry.createRulebook(provider.actor, {
      name: 'Draft Only',
      applicableSpec: 'ts11@1.0.1',
    })
    const unpublished = await fixture.register(draft.id)
    expect(unpublished.status).toBe(409)
    expect((await jsonBody<{ error: { code: string } }>(unpublished)).error.code).toBe('conflict')

    for (const payload of [
      '{"callbackUrl":',
      {},
      { callbackUrl: '' },
      { callbackUrl: 42 },
      { callbackUrl: 'https://subscriber.example.test/hook#fragment' },
      { callbackUrl: 'https://127.0.0.1/hook' },
      { callbackUrl: `https://subscriber.example.test/${'a'.repeat(3_000)}` },
    ]) {
      const invalid = await fixture.register(undefined, payload)
      expect(invalid.status).toBe(400)
      expect((await jsonBody<{ error: { code: string } }>(invalid)).error.code).toBe(
        'invalid_request',
      )
    }
    expect(rows(fixture.database)).toHaveLength(0)
  })

  test('normalizes the stored callback URL before returning it', async () => {
    fixture = createFixture()
    const response = await fixture.register(undefined, {
      callbackUrl: 'https://Subscriber.Example.Test:443/webhook',
    })
    expect(response.status).toBe(201)
    const body = registeredSubscriptionResponseSchema.parse(await response.json())
    expect(body.data.callbackUrl).toBe('https://subscriber.example.test/webhook')
    expect(rows(fixture.database)[0]?.['callback_url']).toBe(
      'https://subscriber.example.test/webhook',
    )
  })

  test('registration performs no outbound request', async () => {
    fixture = createFixture()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (() => {
      calls += 1
      return Promise.reject(new Error('registration must not perform network I/O'))
    }) as unknown as typeof fetch
    try {
      const response = await fixture.register()
      expect(response.status).toBe(201)
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('subscription management over HTTP', () => {
  test('cannot read another subscriber record and refuses unknown ids uniformly', async () => {
    fixture = createFixture()
    const first = await register(fixture)
    const second = await register(fixture)

    const foreign = await fixture.app().request(managementPath(second.id), {
      headers: { authorization: bearer(first.token) },
    })
    expect(foreign.status).toBe(401)

    const missing = await fixture.app().request(managementPath('missing-subscription'), {
      headers: { authorization: bearer(first.token) },
    })
    expect(missing.status).toBe(401)

    const wrong = await fixture.app().request(managementPath(first.id), {
      headers: { authorization: bearer('ats_wrong') },
    })
    expect(wrong.status).toBe(401)

    const malformed = await fixture.app().request(managementPath(first.id), {
      headers: { authorization: 'Basic abc' },
    })
    expect(malformed.status).toBe(401)
  })

  test('deletes idempotently, revokes immediately and answers 404 afterwards', async () => {
    fixture = createFixture()
    const subscription = await register(fixture)

    const first = await fixture.app().request(managementPath(subscription.id), {
      method: 'DELETE',
      headers: { authorization: bearer(subscription.token) },
    })
    expect(first.status).toBe(204)
    expect(await first.text()).toBe('')
    expect(rows(fixture.database)[0]?.['state']).toBe('revoked')

    const second = await fixture.app().request(managementPath(subscription.id), {
      method: 'DELETE',
      headers: { authorization: bearer(subscription.token) },
    })
    expect(second.status).toBe(204)

    const read = await fixture.app().request(managementPath(subscription.id), {
      headers: { authorization: bearer(subscription.token) },
    })
    expect(read.status).toBe(404)
  })

  test('requires a valid management token to delete', async () => {
    fixture = createFixture()
    const subscription = await register(fixture)
    const missing = await fixture.app().request(managementPath(subscription.id), {
      method: 'DELETE',
    })
    expect(missing.status).toBe(401)
    const provider = await fixture.app().request(managementPath(subscription.id), {
      method: 'DELETE',
      headers: { authorization: bearer(fixture.seeded.token) },
    })
    expect(provider.status).toBe(401)
    expect(rows(fixture.database)[0]?.['state']).toBe('pending')
  })

  test('persists the subscription and its token across a restart', async () => {
    fixture = createFixture()
    const subscription = await register(fixture)
    fixture.reopen()

    const readable = await fixture.app().request(managementPath(subscription.id), {
      headers: { authorization: bearer(subscription.token) },
    })
    expect(readable.status).toBe(200)
    const body = subscriptionResponseSchema.parse(await readable.json())
    expect(body.data.id).toBe(subscription.id)
  })
})

describe('subscription abuse bounds over HTTP', () => {
  test('answers 429 with Retry-After when the per-client quota is spent', async () => {
    fixture = createFixture({ limits: { registrationsPerClient: 1, registrationWindowMs: 60_000 } })
    expect((await fixture.register()).status).toBe(201)

    const limited = await fixture.register()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
    const body = await jsonBody<{
      error: { code: string; details?: { retryAfterSeconds?: number } }
    }>(limited)
    expect(body.error.code).toBe('rate_limited')
    expect(body.error.details?.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(rows(fixture.database)).toHaveLength(1)
  })

  test('answers 409 when a rulebook reaches its subscription bound', async () => {
    fixture = createFixture({
      limits: { maxSubscriptionsPerRulebook: 1, registrationsPerClient: 100 },
    })
    expect((await fixture.register()).status).toBe(201)
    const bounded = await fixture.register()
    expect(bounded.status).toBe(409)
    expect((await jsonBody<{ error: { code: string } }>(bounded)).error.code).toBe('conflict')
    expect(rows(fixture.database)).toHaveLength(1)
  })
})

describe('subscription route wiring', () => {
  test('answers 503 when the subscription service is not configured', async () => {
    const app = createApp()
    for (const [method, path] of [
      ['POST', '/api/v1/rulebooks/rulebook-id/subscriptions'],
      ['GET', '/api/v1/subscriptions/subscription-id'],
      ['DELETE', '/api/v1/subscriptions/subscription-id'],
    ] as const) {
      const response = await app.request(path, {
        method,
        ...(method === 'GET' || method === 'DELETE'
          ? { headers: { authorization: bearer('ats_any') } }
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ callbackUrl: 'https://subscriber.example.test/hook' }),
            }),
      })
      expect(response.status, `${method} ${path}`).toBe(503)
      expect((await jsonBody<{ error: { code: string } }>(response)).error.code).toBe(
        'subscription_unavailable',
      )
    }
  })
})
