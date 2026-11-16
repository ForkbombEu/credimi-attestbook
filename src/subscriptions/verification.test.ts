// Offline tests for callback verification and activation (issue #118).
//
// Every test uses the real subscription service, a real migrated SQLite
// database and the real registry, but an injected DNS resolver and transport.
// No test resolves or contacts a real host here; the separate end-to-end test
// exercises the production transport against a disposable loopback server.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'

import { Http1TransportError, type Http1Request, type Http1Response } from '../net/http1'
import { openMigratedDatabase } from '../registry/test-support'
import { Registry } from '../registry/registry'
import { seedPublishedRulebook, type SeededRulebook } from '../validation/test-support'

import { isSubscriptionError, type SubscriptionError, type SubscriptionErrorCode } from './errors'
import { SubscriptionService } from './service'
import { hashSubscriptionManagementToken } from './token'
import {
  hashSubscriptionChallenge,
  SUBSCRIPTION_VERIFICATION_TYPE,
  type CallbackHostAddress,
  type CallbackHostResolver,
} from './verification'
import type { SubscriptionServiceOptions } from './types'

const PUBLIC_ADDRESS: CallbackHostAddress = { address: '8.8.8.8', family: 4 }
const TOKEN = 'ats_inserted_management_token'
const CREATED_AT = '2026-01-01T00:00:00.000Z'

interface Clock {
  now(): string
  advance(milliseconds: number): void
}

function createClock(): Clock {
  let milliseconds = Date.parse(CREATED_AT)
  return {
    now: () => new Date(milliseconds).toISOString(),
    advance: (delta) => {
      milliseconds += delta
    },
  }
}

interface VerificationFixture {
  readonly database: Database
  readonly registry: Registry
  readonly seeded: SeededRulebook
  readonly service: SubscriptionService
  readonly clock: Clock
  readonly challenges: string[]
  readonly requests: Http1Request[]
  readonly resolverCalls: string[]
  setTransport(handler: (request: Http1Request) => Http1Response | Promise<Http1Response>): void
  setResolver(handler: CallbackHostResolver): void
  register(callbackUrl?: string): ReturnType<SubscriptionService['register']>
  row(id: string): Record<string, unknown> | null
  cleanup(): void
}

function createVerificationFixture(
  overrides: Partial<SubscriptionServiceOptions> = {},
): VerificationFixture {
  const database = openMigratedDatabase(':memory:')
  const registry = new Registry({ database })
  const seeded = seedPublishedRulebook(database, registry)
  const clock = createClock()
  const challenges: string[] = []
  const requests: Http1Request[] = []
  const resolverCalls: string[] = []
  let counter = 0
  let transportHandler: (request: Http1Request) => Http1Response | Promise<Http1Response> = () => {
    throw new Error('the test did not install a transport handler')
  }
  let resolverHandler: CallbackHostResolver = () => Promise.resolve([PUBLIC_ADDRESS])

  const transport = async (request: Http1Request): Promise<Http1Response> => {
    requests.push(request)
    return await transportHandler(request)
  }
  const resolver: CallbackHostResolver = async (hostname) => {
    resolverCalls.push(hostname)
    return await resolverHandler(hostname)
  }

  const service = new SubscriptionService({
    database,
    source: registry,
    now: () => clock.now(),
    generateChallenge: () => {
      counter += 1
      const challenge = `atv_test_challenge_${String(counter)}`
      challenges.push(challenge)
      return challenge
    },
    resolveCallbackHostname: resolver,
    verificationTransport: transport,
    ...overrides,
  })

  return {
    database,
    registry,
    seeded,
    service,
    clock,
    challenges,
    requests,
    resolverCalls,
    setTransport(handler) {
      transportHandler = handler
    },
    setResolver(handler) {
      resolverHandler = handler
    },
    register(callbackUrl = 'https://subscriber.example.test/hook') {
      return service.register({
        rulebookId: seeded.rulebookId,
        callbackUrl,
        clientKey: '203.0.113.10',
      })
    },
    row(id) {
      return (
        database
          .query<Record<string, unknown>, [string]>('SELECT * FROM subscriptions WHERE id = ?')
          .get(id) ?? null
      )
    },
    cleanup() {
      database.close()
    },
  }
}

let fixture: VerificationFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function requestBody(request: Http1Request): Record<string, unknown> {
  if (request.body === undefined) {
    throw new Error('the verification request carried no body')
  }
  return JSON.parse(Buffer.from(request.body).toString('utf8')) as Record<string, unknown>
}

function challengeOf(request: Http1Request): string {
  const value = requestBody(request)['challenge']
  if (typeof value !== 'string') {
    throw new Error('the verification request carried no challenge')
  }
  return value
}

function acknowledgement(
  request: Http1Request,
  overrides: Partial<Http1Response> & { readonly challenge?: unknown } = {},
): Http1Response {
  const { challenge, ...responseOverrides } = overrides
  const answered = challenge === undefined ? challengeOf(request) : challenge
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ challenge: answered })),
    url: request.url,
    ...responseOverrides,
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

function expectCode(error: SubscriptionError, code: SubscriptionErrorCode): void {
  expect(error.code).toBe(code)
}

function insertStoredSubscription(
  database: Database,
  rulebookId: string,
  callbackUrl: string,
): string {
  const id = 'stored-subscription'
  database
    .query(
      `INSERT INTO subscriptions (
        id, rulebook_id, callback_url, management_token_hash, state,
        created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)`,
    )
    .run(
      id,
      rulebookId,
      callbackUrl,
      hashSubscriptionManagementToken(TOKEN),
      CREATED_AT,
      CREATED_AT,
    )
  return id
}

describe('callback verification handshake', () => {
  test('activates only after the callback answers the exact challenge', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    const challenge = 'atv_test_challenge_1'
    fixture.setTransport((request) => {
      expect(request.method).toBe('POST')
      expect(request.contentType).toBe('application/json')
      expect(request.accept).toBe('application/json')
      expect(requestBody(request)).toEqual({
        type: SUBSCRIPTION_VERIFICATION_TYPE,
        challenge,
        expiresAt: '2026-01-01T00:05:00.000Z',
      })
      return acknowledgement(request)
    })

    const activated = await fixture.service.verify(registered.id, registered.managementToken)

    expect(activated.state).toBe('active')
    expect(activated).toEqual({
      id: registered.id,
      rulebookId: registered.rulebookId,
      callbackUrl: registered.callbackUrl,
      state: 'active',
      createdAt: registered.createdAt,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    // The address was resolved once and the request was pinned to that answer.
    expect(fixture.resolverCalls).toEqual(['subscriber.example.test'])
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.address).toBe('8.8.8.8')
    expect(fixture.requests[0]?.hostname).toBe('subscriber.example.test')
    expect(fixture.requests[0]?.port).toBe(443)

    const row = fixture.row(registered.id)
    expect(row?.['state']).toBe('active')
    expect(row?.['verified_at']).toBe('2026-01-01T00:00:00.000Z')
    expect(row?.['verification_challenge_hash']).toBeNull()
    expect(row?.['verification_challenge_expires_at']).toBeNull()
    expect(JSON.stringify(row)).not.toContain(challenge)
  })

  test('returns an already-active subscription without contacting the callback again', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    fixture.setTransport((request) => acknowledgement(request))
    await fixture.service.verify(registered.id, registered.managementToken)
    expect(fixture.requests).toHaveLength(1)

    const retried = await fixture.service.verify(registered.id, registered.managementToken)
    expect(retried.state).toBe('active')
    expect(fixture.requests).toHaveLength(1)
    // A retry does not mint another challenge either.
    expect(fixture.challenges).toHaveLength(1)
  })

  test('refuses a wrong challenge and keeps the subscription pending', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    fixture.setTransport((request) => acknowledgement(request, { challenge: 'atv_not_the_one' }))

    const error = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )

    expectCode(error, 'verification_failed')
    expect(error.reason).toBe('challenge_mismatch')
    const row = fixture.row(registered.id)
    expect(row?.['state']).toBe('pending')
    expect(row?.['verified_at']).toBeNull()
    // The attempt is consumed and its challenge cleared; only the hash ever
    // existed in the database while the handshake was in flight.
    expect(row?.['verification_challenge_hash']).toBeNull()
    expect(JSON.stringify(row)).not.toContain(fixture.challenges[0])
    expect(JSON.stringify(row)).not.toContain(registered.managementToken)
    expect(error.message).not.toContain('atv_')
  })

  test('refuses an expired challenge even when the answer is correct', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    fixture.setTransport((request) => {
      fixture?.clock.advance(5 * 60 * 1000 + 1)
      return acknowledgement(request)
    })

    const error = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(error, 'verification_failed')
    expect(error.reason).toBe('expired_challenge')
    expect(fixture.row(registered.id)?.['state']).toBe('pending')
  })

  test('never follows a redirect and refuses a non-200 answer', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    fixture.setTransport((request) =>
      acknowledgement(request, {
        status: 302,
        // A private redirect target: it must never be fetched.
        headers: {
          'content-type': 'application/json',
          location: 'http://169.254.169.254/latest/meta-data/',
        },
      }),
    )
    const redirected = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expect(redirected.reason).toBe('redirect_not_followed')
    expect(fixture.requests).toHaveLength(1)

    fixture.setTransport((request) => acknowledgement(request, { status: 204 }))
    const status = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expect(status.reason).toBe('unexpected_status')
  })

  test('refuses a malformed, non-JSON or oversized acknowledgement', async () => {
    fixture = createVerificationFixture({
      limits: { maxVerificationResponseBytes: 64 },
    })
    const registered = fixture.register()

    for (const response of [
      (request: Http1Request): Http1Response => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('not json'),
        url: request.url,
      }),
      (request: Http1Request): Http1Response => ({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(JSON.stringify({ challenge: challengeOf(request) })),
        url: request.url,
      }),
      (request: Http1Request): Http1Response => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ challenge: 42 })),
        url: request.url,
      }),
      (request: Http1Request): Http1Response => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.alloc(65, 0x61),
        url: request.url,
      }),
    ]) {
      fixture.setTransport(response)
      const error = await expectFailure(
        fixture.service.verify(registered.id, registered.managementToken),
      )
      expectCode(error, 'verification_failed')
      expect(['invalid_response', 'response_too_large']).toContain(error.reason ?? '')
    }
    expect(fixture.row(registered.id)?.['state']).toBe('pending')
  })

  test('a transport that throws yields a typed unreachable failure', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()

    fixture.setTransport(() => {
      throw new Http1TransportError('timeout', 'timed out')
    })
    const timedOut = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(timedOut, 'callback_unreachable')
    expect(timedOut.reason).toBe('timeout')

    fixture.setTransport(() => {
      throw new Http1TransportError('fetch_failed', 'connection reset')
    })
    const failed = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(failed, 'callback_unreachable')
    expect(failed.reason).toBe('network_failure')

    fixture.setTransport(() => {
      throw new Http1TransportError('response_too_large', 'too large')
    })
    const tooLarge = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(tooLarge, 'verification_failed')
    expect(tooLarge.reason).toBe('response_too_large')
    expect(fixture.row(registered.id)?.['state']).toBe('pending')
  })

  test('refuses every non-public resolved answer without contacting it', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()

    for (const answers of [
      [{ address: '10.0.0.7', family: 4 }],
      [{ address: '::1', family: 6 }],
      [{ address: '169.254.169.254', family: 4 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
    ] satisfies readonly CallbackHostAddress[][]) {
      fixture.setResolver(() => Promise.resolve(answers))
      const error = await expectFailure(
        fixture.service.verify(registered.id, registered.managementToken),
      )
      expectCode(error, 'verification_failed')
      expect(error.reason).toBe('blocked_target')
    }
    expect(fixture.requests).toHaveLength(0)
    expect(fixture.row(registered.id)?.['state']).toBe('pending')
  })

  test('refuses a DNS failure and a lookup timeout', async () => {
    fixture = createVerificationFixture({ limits: { verificationTimeoutMs: 50 } })
    const registered = fixture.register()

    fixture.setResolver(() => Promise.reject(new Error('ENOTFOUND')))
    const unresolved = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(unresolved, 'callback_unreachable')
    expect(unresolved.reason).toBe('dns_failure')

    fixture.setResolver(() => new Promise(() => undefined))
    const timedOut = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(timedOut, 'callback_unreachable')
    expect(timedOut.reason).toBe('timeout')
    expect(fixture.requests).toHaveLength(0)
  })

  test('re-validates a stored URL that is no longer a permitted public target', async () => {
    fixture = createVerificationFixture()
    const id = insertStoredSubscription(
      fixture.database,
      fixture.seeded.rulebookId,
      'https://127.0.0.1/hook',
    )
    const error = await expectFailure(fixture.service.verify(id, TOKEN))
    expectCode(error, 'verification_failed')
    expect(error.reason).toBe('blocked_target')
    expect(fixture.requests).toHaveLength(0)
  })

  test('uses the pinned resolved address for the connection (no second lookup)', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    let lookups = 0
    fixture.setResolver(() => {
      lookups += 1
      return Promise.resolve(
        lookups === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
      )
    })
    fixture.setTransport((request) => {
      expect(request.address).toBe('8.8.8.8')
      return acknowledgement(request)
    })

    expect((await fixture.service.verify(registered.id, registered.managementToken)).state).toBe(
      'active',
    )
    expect(lookups).toBe(1)
  })
})

describe('subscription verification access and bounds', () => {
  test('requires the management token and does not disclose another subscriber', async () => {
    fixture = createVerificationFixture()
    const first = fixture.register()
    const second = fixture.register('https://other.example.test/hook')
    fixture.setTransport((request) => acknowledgement(request))

    for (const token of [undefined, '', 'ats_wrong', fixture.seeded.token]) {
      const error = await expectFailure(fixture.service.verify(first.id, token))
      expectCode(error, 'unauthorized')
    }
    const foreign = await expectFailure(fixture.service.verify(second.id, first.managementToken))
    expectCode(foreign, 'unauthorized')
    const unknown = await expectFailure(fixture.service.verify('missing', first.managementToken))
    expectCode(unknown, 'unauthorized')
    expect(fixture.requests).toHaveLength(0)
  })

  test('a revoked subscription cannot be verified', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    fixture.service.delete(registered.id, registered.managementToken)
    const error = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(error, 'not_found')
    expect(fixture.requests).toHaveLength(0)
  })

  test('bounds verification initiations in a window and allows a later window', async () => {
    fixture = createVerificationFixture({
      limits: { verificationsPerSubscription: 2, verificationWindowMs: 60_000 },
    })
    const registered = fixture.register()
    fixture.setTransport((request) => acknowledgement(request, { challenge: 'wrong' }))

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await expectFailure(
        fixture.service.verify(registered.id, registered.managementToken),
      )
      expect(error.reason).toBe('challenge_mismatch')
    }
    expect(fixture.requests).toHaveLength(2)

    const limited = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(limited, 'rate_limited')
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(fixture.requests).toHaveLength(2)

    fixture.clock.advance(60_001)
    fixture.setTransport((request) => acknowledgement(request))
    expect((await fixture.service.verify(registered.id, registered.managementToken)).state).toBe(
      'active',
    )
    expect(fixture.requests).toHaveLength(3)
  })

  test('rejects a second concurrent handshake instead of minting two challenges', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    let captured: Http1Request | undefined
    let release: ((response: Http1Response) => void) | undefined
    fixture.setTransport(
      (request) =>
        new Promise<Http1Response>((resolve) => {
          captured = request
          release = resolve
        }),
    )

    const first = fixture.service.verify(registered.id, registered.managementToken)
    // Let the first handshake reach the transport await with its challenge set.
    await Bun.sleep(0)
    const second = await expectFailure(
      fixture.service.verify(registered.id, registered.managementToken),
    )
    expectCode(second, 'conflict')
    expect(second.message).toContain('already in progress')

    expect(captured).toBeDefined()
    release?.(acknowledgement(captured as Http1Request))
    expect((await first).state).toBe('active')
    expect(fixture.requests).toHaveLength(1)
  })
})

describe('loopback HTTP test opt-in', () => {
  test('refuses a stored loopback HTTP target unless explicitly enabled', async () => {
    fixture = createVerificationFixture()
    const id = insertStoredSubscription(
      fixture.database,
      fixture.seeded.rulebookId,
      'http://127.0.0.1:4321/hook',
    )
    const error = await expectFailure(fixture.service.verify(id, TOKEN))
    expect(error.reason).toBe('blocked_target')
    expect(fixture.requests).toHaveLength(0)
  })

  test('contacts a literal loopback HTTP target when the test opt-in is on', async () => {
    fixture = createVerificationFixture({ allowLoopbackHttp: true })
    const id = insertStoredSubscription(
      fixture.database,
      fixture.seeded.rulebookId,
      'http://127.0.0.1:4321/hook',
    )
    fixture.setTransport((request) => {
      expect(request.address).toBe('127.0.0.1')
      expect(request.port).toBe(4321)
      expect(request.url.protocol).toBe('http:')
      return acknowledgement(request)
    })
    expect((await fixture.service.verify(id, TOKEN)).state).toBe('active')
    expect(fixture.requests).toHaveLength(1)
  })

  test('the opt-in never permits a DNS name that resolves to loopback', async () => {
    fixture = createVerificationFixture({ allowLoopbackHttp: true })
    fixture.setResolver(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }]))
    const unsafe = insertStoredSubscription(
      fixture.database,
      fixture.seeded.rulebookId,
      'https://rebind.example.test/hook',
    )
    const error = await expectFailure(fixture.service.verify(unsafe, TOKEN))
    expect(error.reason).toBe('blocked_target')
    expect(fixture.requests).toHaveLength(0)
  })
})

describe('verification bookkeeping', () => {
  test('stores only the challenge hash while the handshake is in flight', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    const observed: { row: Record<string, unknown> | null } = { row: null }
    fixture.setTransport((request) => {
      observed.row = fixture?.row(registered.id) ?? null
      return acknowledgement(request)
    })

    await fixture.service.verify(registered.id, registered.managementToken)
    const challenge = fixture.challenges[0] ?? ''
    expect(observed.row?.['verification_challenge_hash']).toBe(hashSubscriptionChallenge(challenge))
    expect(JSON.stringify(observed.row)).not.toContain(challenge)
    expect(observed.row?.['verified_at']).toBeNull()
  })

  test('activation is final at the schema level', async () => {
    fixture = createVerificationFixture()
    const registered = fixture.register()
    fixture.setTransport((request) => acknowledgement(request))
    await fixture.service.verify(registered.id, registered.managementToken)

    expect(() =>
      fixture?.database
        .query("UPDATE subscriptions SET state = 'pending' WHERE id = ?")
        .run(registered.id),
    ).toThrow('verified subscription can only be revoked')
    expect(() =>
      fixture?.database
        .query("UPDATE subscriptions SET state = 'active', verified_at = NULL WHERE id = ?")
        .run(registered.id),
    ).toThrow('activation requires a verified callback')

    // A direct insert cannot create an active row either.
    expect(() =>
      fixture?.database
        .query(
          `INSERT INTO subscriptions (
            id, rulebook_id, callback_url, management_token_hash, state,
            created_at, updated_at, revoked_at
          ) VALUES ('direct-active', ?, 'https://subscriber.example.test/hook', ?, 'active', ?, ?, NULL)`,
        )
        .run(
          fixture?.seeded.rulebookId ?? '',
          hashSubscriptionManagementToken('ats_direct_token'),
          CREATED_AT,
          CREATED_AT,
        ),
    ).toThrow('activation requires a verified callback')
  })
})
