// HTTP contract tests for anonymous webhook subscriptions (issues #117, #118).
//
// These exercise the real Hono application, a real migrated SQLite database and
// the real subscription service. They cover the UAT scenarios (anonymous
// registration and management, rejection of an unsafe callback, callback
// verification and activation), the uniform management-token refusal,
// idempotent deletion, restart persistence and the abuse bounds. The callback
// verification tests inject a fake resolver and transport, so no test resolves
// or contacts a real host here; the local mock HTTP callback is covered by
// `src/subscriptions/verification-http.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../app'
import {
  Http1TransportError,
  type Http1Request,
  type Http1Response,
  type Http1Transport,
} from '../net/http1'
import { openMigratedDatabase } from '../registry/test-support'
import { Registry } from '../registry/registry'
import { provisionProvider } from '../registry/bootstrap'
import { seedPublishedRulebook, type SeededRulebook } from '../validation/test-support'

import {
  deriveSubscriptionWebhookSecret,
  verifyWebhookSignature,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookDeliveryService,
  type CallbackHostResolver,
  type SubscriptionServiceOptions,
} from '../subscriptions'
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
  app(webhookDelivery?: WebhookDeliveryService): Hono
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
    app(webhookDelivery?: WebhookDeliveryService) {
      return createApp({
        registry,
        subscriptions: service,
        ...(webhookDelivery === undefined ? {} : { webhookDelivery }),
      })
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

interface VerificationTransportFixture {
  readonly requests: Http1Request[]
  readonly transport: Http1Transport
}

function createVerificationTransport(
  responder: (request: Http1Request) => Http1Response | Promise<Http1Response>,
): VerificationTransportFixture {
  const requests: Http1Request[] = []
  return {
    requests,
    transport: async (request) => {
      requests.push(request)
      return responder(request)
    },
  }
}

function challengeOf(request: Http1Request): string {
  if (request.body === undefined) {
    throw new Error('the verification request carried no body')
  }
  return (JSON.parse(Buffer.from(request.body).toString('utf8')) as { challenge: string }).challenge
}

function acknowledgement(request: Http1Request): Http1Response {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ challenge: challengeOf(request) })),
    url: request.url,
  }
}

function fakeResolver(): CallbackHostResolver {
  return () => Promise.resolve([{ address: '8.8.8.8', family: 4 }])
}

function verificationPath(id: string): string {
  return `/api/v1/subscriptions/${id}/verify`
}

async function verify(fixture: Fixture, id: string, token?: string): Promise<Response> {
  return fixture.app().request(verificationPath(id), {
    method: 'POST',
    ...(token === undefined ? {} : { headers: { authorization: bearer(token) } }),
  })
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
    expect(anonymous.headers.get('www-authenticate')).toBeNull()
    expect((await jsonBody<{ error: { code: string } }>(anonymous)).error.code).toBe('unauthorized')

    // The provider bearer token is not a subscription credential.
    const provider = await fixture.app().request(managementPath(body.data.id), {
      headers: { authorization: bearer(fixture.seeded.token) },
    })
    expect(provider.status).toBe(401)
    expect(provider.headers.get('www-authenticate')).toBeNull()

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

  test('requires a JSON content type so a cross-site form cannot register', async () => {
    fixture = createFixture()
    const payload = { callbackUrl: 'https://subscriber.example.test/webhook' }

    const textPlain = await fixture.register(undefined, payload, {
      'content-type': 'text/plain',
    })
    expect(textPlain.status).toBe(400)
    expect((await jsonBody<{ error: { code: string } }>(textPlain)).error.code).toBe(
      'invalid_request',
    )
    expect(textPlain.headers.get('location')).toBeNull()
    expect(rows(fixture.database)).toHaveLength(0)

    // A body sent without a content type (an ArrayBuffer body is not given an
    // implicit one by fetch) is refused the same way.
    const noContentType = await fixture
      .app()
      .request(`/api/v1/rulebooks/${fixture.seeded.rulebookId}/subscriptions`, {
        method: 'POST',
        body: new TextEncoder().encode(JSON.stringify(payload)),
      })
    expect(noContentType.status).toBe(400)
    expect((await jsonBody<{ error: { code: string } }>(noContentType)).error.code).toBe(
      'invalid_request',
    )
    expect(rows(fixture.database)).toHaveLength(0)

    const withCharset = await fixture.register(undefined, payload, {
      'content-type': 'application/json; charset=utf-8',
    })
    expect(withCharset.status).toBe(201)
    expect(rows(fixture.database)).toHaveLength(1)
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
    expect(foreign.headers.get('www-authenticate')).toBeNull()

    const missing = await fixture.app().request(managementPath('missing-subscription'), {
      headers: { authorization: bearer(first.token) },
    })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBeNull()

    const wrong = await fixture.app().request(managementPath(first.id), {
      headers: { authorization: bearer('ats_wrong') },
    })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toBeNull()

    const malformed = await fixture.app().request(managementPath(first.id), {
      headers: { authorization: 'Basic abc' },
    })
    expect(malformed.status).toBe(401)
    expect(malformed.headers.get('www-authenticate')).toBeNull()
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

describe('callback verification over HTTP', () => {
  test('UAT: verify a callback and activate the subscription', async () => {
    const verificationTransport = createVerificationTransport(acknowledgement)
    fixture = createFixture({
      resolveCallbackHostname: fakeResolver(),
      verificationTransport: verificationTransport.transport,
    })
    const subscription = await register(fixture)

    const response = await verify(fixture, subscription.id, subscription.token)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = subscriptionResponseSchema.parse(await response.json())
    expect(body.data.state).toBe('active')
    expect(body.data.callbackUrl).toBe('https://subscriber.example.test/webhook')
    expect(body.data).not.toHaveProperty('managementToken')

    // The real service sent one POST to the pinned public address and stored
    // only the challenge hash while the handshake was in flight.
    expect(verificationTransport.requests).toHaveLength(1)
    expect(verificationTransport.requests[0]?.method).toBe('POST')
    expect(verificationTransport.requests[0]?.address).toBe('8.8.8.8')
    expect(rows(fixture.database)[0]?.['state']).toBe('active')
    expect(rows(fixture.database)[0]?.['verification_challenge_hash']).toBeNull()

    const readable = await fixture.app().request(managementPath(subscription.id), {
      headers: { authorization: bearer(subscription.token) },
    })
    expect(subscriptionResponseSchema.parse(await readable.json()).data.state).toBe('active')
  })

  test('UAT: a wrong challenge answers a typed failure and keeps the subscription pending', async () => {
    const verificationTransport = createVerificationTransport((request) => ({
      ...acknowledgement(request),
      body: Buffer.from(JSON.stringify({ challenge: 'atv_not_the_challenge' })),
    }))
    fixture = createFixture({
      resolveCallbackHostname: fakeResolver(),
      verificationTransport: verificationTransport.transport,
    })
    const subscription = await register(fixture)

    const response = await verify(fixture, subscription.id, subscription.token)
    expect(response.status).toBe(409)
    expect(response.headers.get('www-authenticate')).toBeNull()
    const body = await jsonBody<{
      error: { code: string; message: string; details?: { reason?: string } }
    }>(response)
    expect(body.error.code).toBe('verification_failed')
    expect(body.error.details?.reason).toBe('challenge_mismatch')
    expect(JSON.stringify(body)).not.toContain('atv_not_the_challenge')
    expect(rows(fixture.database)[0]?.['state']).toBe('pending')
    expect(rows(fixture.database)[0]?.['verified_at']).toBeNull()
  })

  test('requires the management token and refuses a foreign or unknown record', async () => {
    const verificationTransport = createVerificationTransport(acknowledgement)
    fixture = createFixture({
      resolveCallbackHostname: fakeResolver(),
      verificationTransport: verificationTransport.transport,
    })
    const first = await register(fixture)
    const second = await register(fixture)

    for (const token of [undefined, '', 'ats_wrong', fixture.seeded.token]) {
      const response = await verify(fixture, first.id, token)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBeNull()
    }
    const foreign = await verify(fixture, second.id, first.token)
    expect(foreign.status).toBe(401)
    const unknown = await verify(fixture, 'missing-subscription', first.token)
    expect(unknown.status).toBe(401)
    expect(verificationTransport.requests).toHaveLength(0)
    expect(rows(fixture.database).map((row) => row['state'])).toEqual(['pending', 'pending'])
  })

  test('answers 404 for a revoked subscription', async () => {
    const verificationTransport = createVerificationTransport(acknowledgement)
    fixture = createFixture({
      resolveCallbackHostname: fakeResolver(),
      verificationTransport: verificationTransport.transport,
    })
    const subscription = await register(fixture)
    await fixture.app().request(managementPath(subscription.id), {
      method: 'DELETE',
      headers: { authorization: bearer(subscription.token) },
    })

    const response = await verify(fixture, subscription.id, subscription.token)
    expect(response.status).toBe(404)
    expect(verificationTransport.requests).toHaveLength(0)
  })

  test('maps an unreachable callback to 502 and leaves the record pending', async () => {
    const verificationTransport = createVerificationTransport(() => {
      throw new Http1TransportError('fetch_failed', 'connection refused')
    })
    fixture = createFixture({
      resolveCallbackHostname: fakeResolver(),
      verificationTransport: verificationTransport.transport,
    })
    const subscription = await register(fixture)

    const response = await verify(fixture, subscription.id, subscription.token)
    expect(response.status).toBe(502)
    const body = await jsonBody<{
      error: { code: string; details?: { reason?: string } }
    }>(response)
    expect(body.error.code).toBe('callback_unreachable')
    expect(body.error.details?.reason).toBe('network_failure')
    expect(rows(fixture.database)[0]?.['state']).toBe('pending')
  })

  test('answers 429 with Retry-After when the verification attempt bound is spent', async () => {
    const verificationTransport = createVerificationTransport((request) => ({
      ...acknowledgement(request),
      body: Buffer.from(JSON.stringify({ challenge: 'wrong' })),
    }))
    fixture = createFixture({
      resolveCallbackHostname: fakeResolver(),
      verificationTransport: verificationTransport.transport,
      limits: { verificationsPerSubscription: 1, verificationWindowMs: 60_000 },
    })
    const subscription = await register(fixture)

    expect((await verify(fixture, subscription.id, subscription.token)).status).toBe(409)
    const limited = await verify(fixture, subscription.id, subscription.token)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(verificationTransport.requests).toHaveLength(1)
    expect(rows(fixture.database)[0]?.['state']).toBe('pending')
  })
})

describe('subscription route wiring', () => {
  test('answers 503 when the subscription service is not configured', async () => {
    const app = createApp()
    for (const [method, path] of [
      ['POST', '/api/v1/rulebooks/rulebook-id/subscriptions'],
      ['GET', '/api/v1/subscriptions/subscription-id'],
      ['DELETE', '/api/v1/subscriptions/subscription-id'],
      ['POST', '/api/v1/subscriptions/subscription-id/verify'],
    ] as const) {
      const registration = path.endsWith('/subscriptions')
      const response = await app.request(path, {
        method,
        ...(registration
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ callbackUrl: 'https://subscriber.example.test/hook' }),
            }
          : { headers: { authorization: bearer('ats_any') } }),
      })
      expect(response.status, `${method} ${path}`).toBe(503)
      expect((await jsonBody<{ error: { code: string } }>(response)).error.code).toBe(
        'subscription_unavailable',
      )
    }
  })
})

describe('publication webhook delivery over HTTP', () => {
  const WEBHOOK_KEY = Buffer.from('00112233445566778899aabbccddeeff', 'utf8')
  const FIXED_NOW = '2026-01-01T00:00:00.000Z'

  test('returns the derived webhook secret exactly once at registration', async () => {
    fixture = createFixture({ webhookSigningKey: WEBHOOK_KEY })

    const response = await fixture.register()
    expect(response.status).toBe(201)
    const body = registeredSubscriptionResponseSchema.parse(await response.json())
    expect(body.data.webhookSecret).toBe(deriveSubscriptionWebhookSecret(WEBHOOK_KEY, body.data.id))

    const readable = await fixture.app().request(managementPath(body.data.id), {
      headers: { authorization: bearer(body.data.managementToken) },
    })
    const projection = subscriptionResponseSchema.parse(await readable.json())
    expect(projection.data).not.toHaveProperty('webhookSecret')
    expect(JSON.stringify(rows(fixture.database))).not.toContain(body.data.webhookSecret)
    expect(JSON.stringify(rows(fixture.database))).not.toContain(WEBHOOK_KEY.toString('base64url'))
  })

  test('publishes one signed notification to a verified subscriber and not on replay', async () => {
    const verification = createVerificationTransport(acknowledgement)
    fixture = createFixture({
      webhookSigningKey: WEBHOOK_KEY,
      resolveCallbackHostname: fakeResolver(),
      verificationTransport: verification.transport,
    })

    const registration = await fixture.register()
    const registered = registeredSubscriptionResponseSchema.parse(await registration.json())
    const secret = registered.data.webhookSecret
    if (secret === undefined) {
      throw new Error('registration did not return a webhook secret')
    }
    const activated = await verify(fixture, registered.data.id, registered.data.managementToken)
    expect(activated.status).toBe(200)

    const deliveries: Http1Request[] = []
    const delivery = new WebhookDeliveryService({
      database: fixture.database,
      signingKey: WEBHOOK_KEY,
      now: () => FIXED_NOW,
      resolveCallbackHostname: fakeResolver(),
      transport: (request) => {
        deliveries.push(request)
        return Promise.resolve({
          status: 204,
          headers: {},
          body: new Uint8Array(),
          url: request.url,
        })
      },
    })
    const app = fixture.app(delivery)
    const authorization = { authorization: bearer(fixture.seeded.token) }

    const created = await app.request(`/api/v1/rulebooks/${fixture.seeded.rulebookId}/versions`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.1' }),
    })
    expect(created.status).toBe(201)
    const published = await app.request(
      `/api/v1/rulebooks/${fixture.seeded.rulebookId}/versions/1.1/publish`,
      { method: 'POST', headers: authorization },
    )
    expect(published.status).toBe(200)

    expect(deliveries).toHaveLength(1)
    const request = deliveries[0]
    if (request === undefined) {
      throw new Error('the publication did not trigger a delivery')
    }
    const feed = await app.request(`/api/v1/rulebooks/${fixture.seeded.rulebookId}/events`)
    const page = (await feed.json()) as {
      data: readonly { id: string; version: string }[]
    }
    const event = page.data.find((candidate) => candidate.version === '1.1')
    if (event === undefined) {
      throw new Error('the published event is missing from the feed')
    }
    expect(request.headers?.[WEBHOOK_EVENT_ID_HEADER]).toBe(event.id)
    const timestamp = request.headers?.[WEBHOOK_TIMESTAMP_HEADER] ?? ''
    const body = Buffer.from(request.body ?? [])
    expect(JSON.parse(body.toString('utf8'))).toEqual(event)
    expect(
      verifyWebhookSignature({
        secret,
        timestamp,
        eventId: event.id,
        body,
        signature: request.headers?.[WEBHOOK_SIGNATURE_HEADER] ?? '',
      }),
    ).toBe(true)

    // An idempotent publish replay acknowledges the version but appends no
    // event and sends no second notification.
    const replay = await app.request(
      `/api/v1/rulebooks/${fixture.seeded.rulebookId}/versions/1.1/publish`,
      { method: 'POST', headers: authorization },
    )
    expect(replay.status).toBe(200)
    expect(deliveries).toHaveLength(1)

    // A pending subscription of the same rulebook stays ineligible.
    await fixture.register()
    const next = await app.request(`/api/v1/rulebooks/${fixture.seeded.rulebookId}/versions`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.2' }),
    })
    expect(next.status).toBe(201)
    const nextPublish = await app.request(
      `/api/v1/rulebooks/${fixture.seeded.rulebookId}/versions/1.2/publish`,
      { method: 'POST', headers: authorization },
    )
    expect(nextPublish.status).toBe(200)
    expect(deliveries).toHaveLength(2)
  })
})
