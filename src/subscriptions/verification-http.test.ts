// End-to-end local callback verification test (issue #118).
//
// Unlike the offline service tests, this exercises the production bounded
// HTTP transport against a disposable server bound to literal loopback, which
// is exactly the explicitly configured test-loopback path the local UAT
// environment enables. It proves the real handshake, the redirect refusal and
// the response cap over an actual socket; no external host is contacted.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import type { Database } from 'bun:sqlite'

import { openMigratedDatabase } from '../registry/test-support'
import { Registry } from '../registry/registry'
import { seedPublishedRulebook, type SeededRulebook } from '../validation/test-support'

import { isSubscriptionError, type SubscriptionError } from './errors'
import { SubscriptionService } from './service'
import { SUBSCRIPTION_VERIFICATION_TYPE } from './verification'
import type { SubscriptionLimits, SubscriptionServiceOptions } from './types'

const servers: Server<unknown>[] = []
const databases: Database[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    void server.stop(true)
  }
  for (const database of databases.splice(0)) {
    database.close()
  }
})

interface RunningFixture {
  readonly database: Database
  readonly seeded: SeededRulebook
  readonly service: SubscriptionService
  readonly registered: ReturnType<SubscriptionService['register']>
  readonly callbackUrl: string
}

function startCallbackServer(handler: (request: Request) => Response | Promise<Response>): {
  readonly server: Server<unknown>
  readonly callbackUrl: string
} {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler,
  })
  servers.push(server)
  return { server, callbackUrl: `http://127.0.0.1:${String(server.port)}/callback` }
}

function createFixture(
  callbackUrl: string,
  overrides: Partial<SubscriptionServiceOptions> = {},
): RunningFixture {
  const database = openMigratedDatabase(':memory:')
  databases.push(database)
  const registry = new Registry({ database })
  const seeded = seedPublishedRulebook(database, registry)
  const service = new SubscriptionService({
    database,
    source: registry,
    allowLoopbackHttp: true,
    ...overrides,
  })
  const registered = service.register({
    rulebookId: seeded.rulebookId,
    callbackUrl,
    clientKey: '203.0.113.10',
  })
  return { database, seeded, service, registered, callbackUrl }
}

interface ReceivedRequest {
  readonly method: string
  readonly contentType: string | null
  readonly body: unknown
}

function captureChallenge(requests: ReceivedRequest[]): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = (await request.json()) as Record<string, unknown>
    requests.push({
      method: request.method,
      contentType: request.headers.get('content-type'),
      body,
    })
    return Response.json({ challenge: body['challenge'] })
  }
}

async function expectFailure(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise
  } catch (error) {
    if (isSubscriptionError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the verification to fail')
}

function row(database: Database, id: string): Record<string, unknown> | null {
  return (
    database
      .query<Record<string, unknown>, [string]>('SELECT * FROM subscriptions WHERE id = ?')
      .get(id) ?? null
  )
}

describe('local mock HTTP callback', () => {
  test('activates after the endpoint echoes the exact challenge over the real socket', async () => {
    const requests: ReceivedRequest[] = []
    const { callbackUrl } = startCallbackServer(captureChallenge(requests))
    const fixture = createFixture(callbackUrl)

    const activated = await fixture.service.verify(
      fixture.registered.id,
      fixture.registered.managementToken,
    )

    expect(activated.state).toBe('active')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.contentType).toBe('application/json')
    const body = requests[0]?.body as Record<string, unknown>
    expect(body['type']).toBe(SUBSCRIPTION_VERIFICATION_TYPE)
    expect(typeof body['challenge']).toBe('string')
    expect(typeof body['expiresAt']).toBe('string')
    const stored = row(fixture.database, fixture.registered.id)
    expect(stored?.['state']).toBe('active')
    expect(stored?.['verified_at']).not.toBeNull()
    expect(stored?.['verification_challenge_hash']).toBeNull()
    expect(JSON.stringify(stored)).not.toContain(body['challenge'])
  })

  test('keeps the subscription pending when the endpoint answers a wrong challenge', async () => {
    const { callbackUrl } = startCallbackServer(() =>
      Response.json({ challenge: 'atv_wrong_challenge' }),
    )
    const fixture = createFixture(callbackUrl)

    const error = await expectFailure(
      fixture.service.verify(fixture.registered.id, fixture.registered.managementToken),
    )
    expect(error.code).toBe('verification_failed')
    expect(error.reason).toBe('challenge_mismatch')
    expect(row(fixture.database, fixture.registered.id)?.['state']).toBe('pending')
  })

  test('does not follow a redirect from the callback', async () => {
    const requests: ReceivedRequest[] = []
    const { callbackUrl } = startCallbackServer((request) => {
      requests.push({ method: request.method, contentType: null, body: null })
      return new Response(null, {
        status: 302,
        // A private redirect target: it must never be fetched.
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    })
    const fixture = createFixture(callbackUrl)

    const error = await expectFailure(
      fixture.service.verify(fixture.registered.id, fixture.registered.managementToken),
    )
    expect(error.reason).toBe('redirect_not_followed')
    // The transport returned the redirect instead of following it, so the
    // callback saw exactly one request.
    expect(requests).toHaveLength(1)
    expect(row(fixture.database, fixture.registered.id)?.['state']).toBe('pending')
  })

  test('bounds a callback that does not answer in time', async () => {
    const { callbackUrl } = startCallbackServer(async () => {
      await Bun.sleep(1_000)
      return Response.json({ challenge: 'too late' })
    })
    const fixture = createFixture(callbackUrl, {
      limits: { verificationTimeoutMs: 100 } satisfies Partial<SubscriptionLimits>,
    })

    const error = await expectFailure(
      fixture.service.verify(fixture.registered.id, fixture.registered.managementToken),
    )
    expect(error.code).toBe('callback_unreachable')
    expect(error.reason).toBe('timeout')
    expect(row(fixture.database, fixture.registered.id)?.['state']).toBe('pending')
  })

  test('caps an oversized callback response', async () => {
    const { callbackUrl } = startCallbackServer(
      () =>
        new Response(JSON.stringify({ challenge: 'x', padding: 'a'.repeat(16 * 1_024) }), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    const fixture = createFixture(callbackUrl, {
      limits: { maxVerificationResponseBytes: 1_024 },
    })

    const error = await expectFailure(
      fixture.service.verify(fixture.registered.id, fixture.registered.managementToken),
    )
    expect(error.code).toBe('verification_failed')
    expect(error.reason).toBe('response_too_large')
    expect(row(fixture.database, fixture.registered.id)?.['state']).toBe('pending')
  })
})
