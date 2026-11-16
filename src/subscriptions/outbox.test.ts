// Deterministic tests for the durable publication-delivery outbox (#120).
//
// Everything is driven by an injected wall clock, a fake resolver and an
// offline transport, so a retry becomes due only when the test advances the
// clock and no test contacts a real host. The fixture uses a real migrated
// SQLite file and the real registry, subscription service and one-attempt
// deliverer; only time, DNS and HTTP are injected.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Http1TransportError,
  type Http1Request,
  type Http1Response,
  type Http1Transport,
} from '../net/http1'
import { Registry } from '../registry/registry'
import { openMigratedDatabase } from '../registry/test-support'
import type { PublicationEvent } from '../registry/types'
import { seedPublishedRulebook, type SeededRulebook } from '../validation/test-support'

import { WebhookOutboxDispatcher } from './dispatcher'
import {
  deriveSubscriptionWebhookSecret,
  verifyWebhookSignature,
  webhookSigningKeyId,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from './delivery'
import {
  DEFAULT_WEBHOOK_OUTBOX_MAX_AGE_MS,
  DEFAULT_WEBHOOK_OUTBOX_MAX_ATTEMPTS,
  resolveWebhookOutboxLimits,
  WebhookOutboxStore,
} from './outbox'
import { SubscriptionService } from './service'
import type { CallbackHostResolver } from './verification'

const SIGNING_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')
const START = Date.parse('2026-01-01T00:00:00.000Z')

const PUBLIC_RESOLVER: CallbackHostResolver = () =>
  Promise.resolve([{ address: '8.8.8.8', family: 4 }])

const databases: Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

interface Fixture {
  readonly directory: string
  readonly databasePath: string
  readonly registry: Registry
  readonly seeded: SeededRulebook
  service: SubscriptionService
  database: Database
  now(): string
  advance(ms: number): void
  reopen(): void
  publish(version: string): PublicationEvent
  cleanup(): void
}

function createFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'attestbook-outbox-'))
  directories.push(directory)
  const databasePath = join(directory, 'attestbook.sqlite')
  let database = openMigratedDatabase(databasePath)
  // One injected clock for the registry, the subscription service and the
  // dispatcher, so a retry becomes due only when a test advances time.
  const state = { clockMs: START }
  const clock = () => new Date(state.clockMs).toISOString()
  let registry = new Registry({ database, now: clock })
  const seeded = seedPublishedRulebook(database, registry)
  // The seeded publication happened before any subscription existed; move the
  // clock forward so a later reconciliation scan cannot treat those
  // subscriptions as eligible for the old event.
  state.clockMs = START + 1_000

  const fixture: Fixture = {
    directory,
    databasePath,
    get registry() {
      return registry
    },
    seeded,
    get database() {
      return database
    },
    get service() {
      return service
    },
    now: clock,
    advance(ms: number) {
      state.clockMs += ms
    },
    reopen() {
      database.close()
      database = openMigratedDatabase(databasePath)
      registry = new Registry({ database, now: clock })
      service = new SubscriptionService({
        database,
        source: registry,
        resolveCallbackHostname: PUBLIC_RESOLVER,
        verificationTransport: echoChallengeTransport(),
        webhookSigningKey: SIGNING_KEY,
        now: clock,
      })
    },
    publish(version: string) {
      registry.createRulebookVersion(seeded.actor, seeded.rulebookId, { version })
      registry.publishRulebookVersion(seeded.actor, seeded.rulebookId, version)
      const event = registry.getPublicationEvent(seeded.rulebookId, version)
      if (event === null) {
        throw new Error('the published event is missing')
      }
      return event
    },
    cleanup() {
      // Shared afterEach closes the current handle and removes the directory.
    },
  }

  let service = new SubscriptionService({
    database,
    source: registry,
    resolveCallbackHostname: PUBLIC_RESOLVER,
    verificationTransport: echoChallengeTransport(),
    webhookSigningKey: SIGNING_KEY,
    now: clock,
  })
  return fixture
}

function echoChallengeTransport(): Http1Transport {
  return (request) => {
    const payload = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as {
      challenge?: unknown
    }
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ challenge: payload.challenge })),
      url: request.url,
    })
  }
}

interface Recorded {
  readonly request: Http1Request
}

function recordingTransport(
  respond: (request: Http1Request, call: number) => Http1Response | Promise<Http1Response>,
): { transport: Http1Transport; requests: Recorded[] } {
  const requests: Recorded[] = []
  return {
    requests,
    transport: async (request) => {
      requests.push({ request })
      return respond(request, requests.length)
    },
  }
}

function response(status: number, request: Http1Request): Http1Response {
  return { status, headers: {}, body: new Uint8Array(), url: request.url }
}

async function activeSubscription(
  fixture: Fixture,
  callbackUrl = 'https://subscriber.example.test/webhook',
  clientKey = '203.0.113.20',
) {
  const registered = fixture.service.register({
    rulebookId: fixture.seeded.rulebookId,
    callbackUrl,
    clientKey,
  })
  const active = await fixture.service.verify(registered.id, registered.managementToken)
  expect(active.state).toBe('active')
  return registered
}

function limits(overrides: Parameters<typeof resolveWebhookOutboxLimits>[0] = {}) {
  return resolveWebhookOutboxLimits({
    baseBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    maxAttempts: 7,
    maxAgeMs: 60_000,
    leaseTtlMs: 5_000,
    retentionMs: 24 * 60 * 60 * 1_000,
    pollIntervalMs: 60_000,
    batchSize: 10,
    dispatchConcurrency: 2,
    maxPendingEntries: 100,
    ...overrides,
  })
}

function dispatcher(
  fixture: Fixture,
  transport: Http1Transport,
  overrides: Parameters<typeof resolveWebhookOutboxLimits>[0] = {},
): WebhookOutboxDispatcher {
  return new WebhookOutboxDispatcher({
    database: fixture.database,
    signingKey: SIGNING_KEY,
    now: () => fixture.now(),
    random: () => 0,
    resolveCallbackHostname: PUBLIC_RESOLVER,
    transport,
    limits: limits(overrides),
  })
}

function defaultDispatcher(fixture: Fixture, transport: Http1Transport): WebhookOutboxDispatcher {
  return new WebhookOutboxDispatcher({
    database: fixture.database,
    signingKey: SIGNING_KEY,
    now: () => fixture.now(),
    random: () => 0,
    resolveCallbackHostname: PUBLIC_RESOLVER,
    transport,
  })
}

function store(fixture: Fixture): WebhookOutboxStore {
  return new WebhookOutboxStore(fixture.database)
}

function outboxRows(fixture: Fixture): readonly {
  readonly subscription_id: string
  readonly status: string
  readonly attempts: number
  readonly lease_owner: string | null
  readonly last_attempt_at: string | null
}[] {
  return fixture.database
    .query<
      {
        subscription_id: string
        status: string
        attempts: number
        lease_owner: string | null
        last_attempt_at: string | null
      },
      []
    >(
      `SELECT subscription_id, status, attempts, lease_owner, last_attempt_at
       FROM webhook_delivery_outbox ORDER BY sequence`,
    )
    .all()
}

describe('durable webhook outbox', () => {
  test('retries a transient 503 after the backoff and then retains the same event and subscriber', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const secret = deriveSubscriptionWebhookSecret(SIGNING_KEY, registered.id)
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request, call) =>
      call === 1 ? response(503, request) : response(204, request),
    )
    const outbox = dispatcher(fixture, recording.transport)

    outbox.enqueuePublicationEvent(event)
    await outbox.whenIdle()
    expect(recording.requests).toHaveLength(1)

    // The first failure is durable and scheduled, not lost.
    let status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries).toHaveLength(1)
    expect(status.entries[0]).toMatchObject({
      eventId: event.id,
      status: 'pending',
      attempts: 1,
      lastErrorCategory: 'unexpected_status',
    })
    expect(status.entries[0]?.nextAttemptAt).not.toBeNull()

    fixture.advance(500)
    await outbox.tick()
    expect(recording.requests).toHaveLength(2)

    const first = recording.requests[0]?.request
    const second = recording.requests[1]?.request
    if (first === undefined || second === undefined) {
      throw new Error('the retry requests were not recorded')
    }
    expect(second.headers?.[WEBHOOK_EVENT_ID_HEADER]).toBe(first.headers?.[WEBHOOK_EVENT_ID_HEADER])
    expect(second.headers?.[WEBHOOK_EVENT_ID_HEADER]).toBe(event.id)
    expect(Buffer.from(second.body ?? [])).toEqual(Buffer.from(first.body ?? []))
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: second.headers?.[WEBHOOK_TIMESTAMP_HEADER] ?? '',
        eventId: event.id,
        body: new Uint8Array(second.body ?? []),
        signature: second.headers?.[WEBHOOK_SIGNATURE_HEADER] ?? '',
      }),
    ).toBe(true)

    status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]).toMatchObject({
      eventId: event.id,
      status: 'delivered',
      attempts: 2,
      lastErrorCategory: null,
      terminalReason: null,
    })
  })

  test('retries a transport timeout and then succeeds', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request, call) => {
      if (call === 1) {
        throw new Http1TransportError('timeout', 'delivery timed out')
      }
      return response(204, request)
    })
    const outbox = dispatcher(fixture, recording.transport)

    outbox.enqueuePublicationEvent(event)
    await outbox.whenIdle()
    fixture.advance(500)
    await outbox.tick()

    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]).toMatchObject({
      status: 'delivered',
      attempts: 2,
      lastErrorCategory: null,
    })
  })

  test('retries a transient 500 answer and then succeeds', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request, call) =>
      call === 1 ? response(500, request) : response(204, request),
    )
    const outbox = dispatcher(fixture, recording.transport)

    outbox.enqueuePublicationEvent(event)
    await outbox.whenIdle()
    fixture.advance(500)
    await outbox.tick()

    expect(recording.requests).toHaveLength(2)
    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]).toMatchObject({ status: 'delivered', attempts: 2 })
  })

  test('does not retry a terminal 4xx answer', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request) => response(400, request))
    const outbox = dispatcher(fixture, recording.transport)

    outbox.enqueuePublicationEvent(event)
    await outbox.whenIdle()
    expect(recording.requests).toHaveLength(1)
    const firstAttemptAt = fixture.now()

    fixture.advance(60_000)
    await outbox.tick()
    expect(recording.requests).toHaveLength(1)

    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorCategory: 'unexpected_status',
      terminalReason: 'non_retryable',
    })
    expect(status.entries[0]?.nextAttemptAt).toBeNull()
    expect(status.entries[0]?.failedAt).toBe(firstAttemptAt)
  })

  test('enqueues a duplicate event idempotently and delivers it once', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request) => response(204, request))
    const outbox = dispatcher(fixture, recording.transport)

    const first = outbox.enqueuePublicationEvent(event)
    const second = outbox.enqueuePublicationEvent(event)
    expect(first.inserted).toBe(1)
    expect(second.inserted).toBe(0)
    await outbox.whenIdle()

    expect(recording.requests).toHaveLength(1)
    const rows = fixture.database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM webhook_delivery_outbox WHERE subscription_id = ?',
      )
      .get(registered.id)
    expect(rows?.count).toBe(1)
  })

  test('recovers an expired lease left by a crashed attempt without a duplicate record', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const outboxStore = store(fixture)
    outboxStore.enqueueForEvent(event, webhookSigningKeyId(SIGNING_KEY), fixture.now(), limits())
    const crashed = outboxStore.claimDue(fixture.now(), limits(), 'crashed-process')
    expect(crashed).toHaveLength(1)

    const recording = recordingTransport((request) => response(204, request))
    const outbox = dispatcher(fixture, recording.transport)
    // The lease is still live: a restart must not double-deliver it yet.
    await outbox.tick()
    expect(recording.requests).toHaveLength(0)

    fixture.advance(5_001)
    await outbox.tick()
    expect(recording.requests).toHaveLength(1)

    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries).toHaveLength(1)
    expect(status.entries[0]).toMatchObject({ status: 'delivered', attempts: 2 })
  })

  test('two concurrent dispatchers claim one job exactly once', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    store(fixture).enqueueForEvent(event, webhookSigningKeyId(SIGNING_KEY), fixture.now(), limits())

    const recording = recordingTransport(async (request) => {
      await Bun.sleep(5)
      return response(204, request)
    })
    const first = dispatcher(fixture, recording.transport)
    const second = dispatcher(fixture, recording.transport)

    await Promise.all([first.tick(), second.tick()])

    expect(recording.requests).toHaveLength(1)
    const status = first.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries).toHaveLength(1)
    expect(status.entries[0]).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  test('never enqueues a pending subscription and never delivers a queued revoked one', async () => {
    const fixture = createFixture()
    const pending = fixture.service.register({
      rulebookId: fixture.seeded.rulebookId,
      callbackUrl: 'https://pending.example.test/webhook',
      clientKey: '203.0.113.21',
    })
    const active = await activeSubscription(
      fixture,
      'https://active.example.test/webhook',
      '203.0.113.22',
    )
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request) => response(204, request))
    const outbox = dispatcher(fixture, recording.transport)

    // A pending subscription is never eligible, while the active one is queued.
    store(fixture).enqueueForEvent(event, webhookSigningKeyId(SIGNING_KEY), fixture.now(), limits())
    expect(outbox.listDeliveryStatus(pending.id, 10, 0).total).toBe(0)
    expect(outbox.listDeliveryStatus(active.id, 10, 0).total).toBe(1)

    // Revoke after the job exists but before it is attempted: no socket opens.
    fixture.service.delete(active.id, active.managementToken)
    await outbox.tick()

    expect(recording.requests).toHaveLength(0)
    const status = outbox.listDeliveryStatus(active.id, 10, 0)
    expect(status.entries[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorCategory: 'subscription_not_eligible',
      terminalReason: 'subscription_ineligible',
    })
  })

  test('stops retrying at the attempt cap and never loops', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request) => response(500, request))
    const outbox = dispatcher(fixture, recording.transport, {
      maxAttempts: 3,
      maxAgeMs: 5_000,
    })

    outbox.enqueuePublicationEvent(event)
    await outbox.whenIdle()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      fixture.advance(500)
      await outbox.tick()
    }

    expect(recording.requests).toHaveLength(3)
    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      terminalReason: 'max_attempts',
    })
  })

  test('default limits retry a subscriber that is down for twenty minutes', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    let down = true
    const recording = recordingTransport((request) => response(down ? 503 : 204, request))
    const outbox = defaultDispatcher(fixture, recording.transport)
    const outageEndsAt = Date.parse(fixture.now()) + 20 * 60 * 1_000
    const deadline = Date.parse(fixture.now()) + 2 * 60 * 60 * 1_000

    outbox.enqueuePublicationEvent(event)
    await outbox.whenIdle()
    while (
      outbox.listDeliveryStatus(registered.id, 1, 0).entries[0]?.status === 'pending' &&
      Date.parse(fixture.now()) < deadline
    ) {
      fixture.advance(30_000)
      down = Date.parse(fixture.now()) < outageEndsAt
      await outbox.tick()
    }

    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]).toMatchObject({ status: 'delivered' })
    expect(status.entries[0]?.attempts).toBeGreaterThan(1)
    expect(status.entries[0]?.attempts).toBeLessThanOrEqual(DEFAULT_WEBHOOK_OUTBOX_MAX_ATTEMPTS)
    const eventIds = new Set(
      recording.requests.map((entry) => entry.request.headers?.[WEBHOOK_EVENT_ID_HEADER]),
    )
    expect(eventIds).toEqual(new Set([event.id]))
  })

  test('the default retry schedule is bounded by the attempt and age caps', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request) => response(503, request))
    const outbox = defaultDispatcher(fixture, recording.transport)
    const finishBy = Date.parse(fixture.now()) + DEFAULT_WEBHOOK_OUTBOX_MAX_AGE_MS + 15 * 60 * 1_000

    outbox.enqueuePublicationEvent(event)
    await outbox.whenIdle()
    while (
      outbox.listDeliveryStatus(registered.id, 1, 0).entries[0]?.status === 'pending' &&
      Date.parse(fixture.now()) < finishBy
    ) {
      fixture.advance(60_000)
      await outbox.tick()
    }

    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]?.status).toBe('failed')
    expect(['max_attempts', 'max_age']).toContain(status.entries[0]?.terminalReason ?? '')
    expect(Date.parse(fixture.now())).toBeLessThan(finishBy)
    const requestsAtTerminal = recording.requests.length
    for (let tick = 0; tick < 10; tick += 1) {
      fixture.advance(60_000)
      await outbox.tick()
    }
    expect(recording.requests).toHaveLength(requestsAtTerminal)
  })

  test('rejects a retry schedule that cannot reach the configured age cap', () => {
    expect(() =>
      resolveWebhookOutboxLimits({
        maxAttempts: 2,
        baseBackoffMs: 1,
        maxBackoffMs: 1,
        maxAgeMs: 60 * 60 * 1_000,
      }),
    ).toThrow(RangeError)
  })

  test('fails a job whose crashed claims already used every attempt', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const outboxStore = store(fixture)
    outboxStore.enqueueForEvent(
      event,
      webhookSigningKeyId(SIGNING_KEY),
      fixture.now(),
      limits({ maxAttempts: 1 }),
    )
    const crashed = outboxStore.claimDue(
      fixture.now(),
      limits({ maxAttempts: 1 }),
      'crashed-last-attempt',
    )
    expect(crashed).toHaveLength(1)

    const recording = recordingTransport((request) => response(204, request))
    const outbox = dispatcher(fixture, recording.transport, { maxAttempts: 1 })
    fixture.advance(30_001)
    await outbox.tick()

    expect(recording.requests).toHaveLength(0)
    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      terminalReason: 'max_attempts',
    })
  })

  test('stops retrying at the age cap', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request) => response(503, request))
    const outbox = dispatcher(fixture, recording.transport, {
      maxAttempts: 10,
      maxAgeMs: 2_000,
    })

    outbox.enqueuePublicationEvent(event)
    await outbox.whenIdle()
    fixture.advance(3_000)
    await outbox.tick()

    expect(recording.requests).toHaveLength(1)
    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      terminalReason: 'max_age',
    })
  })

  test('resumes a queued delivery after a database reopen without duplicating it', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    store(fixture).enqueueForEvent(event, webhookSigningKeyId(SIGNING_KEY), fixture.now(), limits())

    // Simulate a process restart before any attempt: the durable row survives.
    fixture.reopen()
    const recording = recordingTransport((request) => response(204, request))
    const outbox = dispatcher(fixture, recording.transport)
    await outbox.tick()

    expect(recording.requests).toHaveLength(1)
    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.entries).toHaveLength(1)
    expect(status.entries[0]).toMatchObject({ status: 'delivered', attempts: 1 })
    const events = fixture.database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM publication_events')
      .get()
    expect(events?.count).toBe(2)
  })

  test('reconciles a recorded event whose enqueue was missed without duplicating jobs', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    // A crash between the publication commit and its explicit enqueue leaves
    // no outbox row; the dispatcher's cursor must recover it from the feed.
    const event = fixture.publish('1.1')
    const recording = recordingTransport((request) => response(204, request))
    const outbox = dispatcher(fixture, recording.transport)

    await outbox.tick()
    expect(recording.requests).toHaveLength(1)
    expect(recording.requests[0]?.request.headers?.[WEBHOOK_EVENT_ID_HEADER]).toBe(event.id)

    // The cursor advanced and the unique key already exists: no second send.
    await outbox.tick()
    expect(recording.requests).toHaveLength(1)
    const status = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(status.total).toBe(1)
    expect(status.entries[0]).toMatchObject({ eventId: event.id, status: 'delivered' })
  })

  test('releasing an unattempted claim returns its attempt', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const event = fixture.publish('1.1')
    const outboxStore = store(fixture)
    const oneAttempt = limits({ maxAttempts: 1 })
    outboxStore.enqueueForEvent(event, webhookSigningKeyId(SIGNING_KEY), fixture.now(), oneAttempt)

    const claimed = outboxStore.claimDue(fixture.now(), oneAttempt, 'shutdown')
    expect(claimed).toHaveLength(1)
    const job = claimed[0]
    if (job === undefined) {
      throw new Error('the shutdown claim was not recorded')
    }
    expect(job.attempts).toBe(1)
    expect(job.lastAttemptAt).toBeNull()
    expect(outboxStore.releaseLease(job, 'shutdown', fixture.now())).toBe(true)

    const pending = outboxStore.listStatusForSubscription(registered.id, 10, 0)
    expect(pending.entries[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastAttemptAt: null,
    })
    expect(pending.entries[0]?.nextAttemptAt).not.toBeNull()

    // The attempt is claimable again and a single-attempt budget still delivers.
    const recording = recordingTransport((request) => response(204, request))
    const outbox = dispatcher(fixture, recording.transport, { maxAttempts: 1 })
    await outbox.tick()
    expect(recording.requests).toHaveLength(1)
    const delivered = outbox.listDeliveryStatus(registered.id, 10, 0)
    expect(delivered.entries[0]).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  test('stop releases unstarted claims without spending attempts', async () => {
    const fixture = createFixture()
    for (let index = 0; index < 5; index += 1) {
      await activeSubscription(
        fixture,
        `https://stop-${String(index)}.example.test/hook`,
        `203.0.113.${String(40 + index)}`,
      )
    }
    fixture.publish('1.1')
    let releaseFirst = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStartedResolve = (): void => {}
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve
    })
    let calls = 0
    const gatedTransport: Http1Transport = async (request) => {
      calls += 1
      if (calls === 1) {
        firstStartedResolve()
      }
      await gate
      return response(204, request)
    }

    const outbox = dispatcher(fixture, gatedTransport, {
      batchSize: 5,
      dispatchConcurrency: 1,
      maxAttempts: 1,
    })
    const tick = outbox.tick()
    await firstStarted
    const stop = outbox.stop()
    releaseFirst()
    await stop
    await tick

    expect(calls).toBe(1)
    const blocked = outboxRows(fixture)
    expect(blocked).toHaveLength(5)
    expect(blocked.filter((row) => row.status === 'delivered')).toHaveLength(1)
    const released = blocked.filter((row) => row.status === 'pending')
    expect(released).toHaveLength(4)
    for (const row of released) {
      expect(row.attempts).toBe(0)
      expect(row.lease_owner).toBeNull()
      expect(row.last_attempt_at).toBeNull()
    }

    // A new process picks the released jobs up with their full attempt budget.
    const restarted = dispatcher(
      fixture,
      recordingTransport((request) => response(204, request)).transport,
      {
        batchSize: 5,
        dispatchConcurrency: 1,
        maxAttempts: 1,
      },
    )
    await restarted.tick()
    const finished = outboxRows(fixture)
    expect(finished.every((row) => row.status === 'delivered')).toBe(true)
    expect(finished.every((row) => row.attempts === 1)).toBe(true)
    expect(finished.some((row) => row.status === 'failed')).toBe(false)
  })

  test('bounds the outbox and exposes only sanitized delivery records', async () => {
    const fixture = createFixture()
    const first = await activeSubscription(
      fixture,
      'https://first.example.test/webhook',
      '203.0.113.30',
    )
    const second = await activeSubscription(
      fixture,
      'https://second.example.test/webhook',
      '203.0.113.31',
    )
    const event = fixture.publish('1.1')
    const bounded = store(fixture)
    const result = bounded.enqueueForEvent(
      event,
      webhookSigningKeyId(SIGNING_KEY),
      fixture.now(),
      limits({ maxPendingEntries: 1 }),
    )
    expect(result.inserted + result.dropped).toBe(2)
    expect(result.inserted).toBe(1)
    expect(result.dropped).toBe(1)

    const firstPage = bounded.listStatusForSubscription(first.id, 10, 0)
    const secondPage = bounded.listStatusForSubscription(second.id, 10, 0)
    expect(firstPage.total + secondPage.total).toBe(1)
    const visible = firstPage.total === 1 ? firstPage : secondPage
    expect(visible.entries[0]?.eventId).toBe(event.id)
    // The sanitized projection never carries the callback URL or a secret.
    const serialized = JSON.stringify(visible)
    expect(serialized).not.toContain('example.test')
    expect(serialized).not.toContain('atw_')
  })
})
