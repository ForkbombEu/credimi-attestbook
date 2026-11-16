// Unit and integration tests for signed publication webhook delivery (#119).
//
// These cover the exact notification body, the fixed-vector canonical signing
// input and HMAC, secret derivation/privacy, delivery eligibility (pending,
// revoked and unrelated-rulebook subscriptions are never contacted), isolation
// between subscriptions, stale/deleted rows, unsafe callback DNS and every
// typed single-attempt outcome. The transport and DNS resolver are injected, so
// no test contacts a real host. One separate test file (`delivery-http.test.ts`)
// exercises the production socket path against literal loopback.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Http1TransportError, type Http1Request, type Http1Transport } from '../net/http1'
import { Registry } from '../registry/registry'
import { openMigratedDatabase } from '../registry/test-support'
import type { PublicationEvent } from '../registry/types'
import { seedPublishedRulebook, type SeededRulebook } from '../validation/test-support'

import {
  buildWebhookNotificationBody,
  canonicalWebhookSigningInput,
  deriveSubscriptionWebhookSecret,
  isSubscriptionWebhookSecret,
  signWebhookRequest,
  verifyWebhookSignature,
  WEBHOOK_CONTENT_TYPE,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookDeliveryService,
  type WebhookDeliveryOptions,
} from './delivery'
import { SubscriptionService } from './service'
import type { CallbackHostResolver } from './verification'

const SIGNING_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')
const FIXED_NOW = '2026-01-01T00:00:00.000Z'

const VECTOR_EVENT: PublicationEvent = {
  id: 'event-vector-1',
  format: 'attestbook.rulebook-publication-event@1',
  type: 'rulebook.published',
  rulebookId: 'rulebook-vector',
  version: '1.0.1',
  contentDigest: 'a'.repeat(64),
  publishedAt: '2026-01-01T00:00:00.000Z',
}

/** Public resolver used by the registration/verification fixture. */
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
  readonly database: Database
  readonly registry: Registry
  readonly seeded: SeededRulebook
  readonly service: SubscriptionService
  readonly event: PublicationEvent
  cleanup(): void
}

function createFixture(
  serviceOverrides: Partial<ConstructorParameters<typeof SubscriptionService>[0]> = {},
): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'attestbook-delivery-'))
  directories.push(directory)
  const database = openMigratedDatabase(join(directory, 'attestbook.sqlite'))
  databases.push(database)
  const registry = new Registry({ database })
  const seeded = seedPublishedRulebook(database, registry)
  const event = registry.getPublicationEvent(seeded.rulebookId, '1.0')
  if (event === null) {
    throw new Error('fixture publication event is missing')
  }
  const service = new SubscriptionService({
    database,
    source: registry,
    resolveCallbackHostname: PUBLIC_RESOLVER,
    verificationTransport: echoChallengeTransport(),
    ...serviceOverrides,
  })
  return {
    database,
    registry,
    seeded,
    service,
    event,
    cleanup() {
      // The shared afterEach removes the temporary directory.
    },
  }
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

interface RecordedDelivery {
  readonly request: Http1Request
}

function recordingTransport(
  response: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
  recorded: RecordedDelivery[] = [],
): Http1Transport {
  return async (request) => {
    recorded.push({ request })
    const result = await response()
    const body = new Uint8Array(await result.arrayBuffer())
    const headers: Record<string, string> = {}
    result.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    return { status: result.status, headers, body, url: request.url }
  }
}

async function activeSubscription(
  fixture: Fixture,
  rulebookId = fixture.seeded.rulebookId,
  clientKey = '203.0.113.10',
  callbackUrl = 'https://subscriber.example.test/webhook',
) {
  const registered = fixture.service.register({ rulebookId, callbackUrl, clientKey })
  const active = await fixture.service.verify(registered.id, registered.managementToken)
  expect(active.state).toBe('active')
  return registered
}

function deliveryService(
  fixture: Fixture,
  overrides: Partial<WebhookDeliveryOptions> = {},
): WebhookDeliveryService {
  return new WebhookDeliveryService({
    database: fixture.database,
    signingKey: SIGNING_KEY,
    now: () => FIXED_NOW,
    resolveCallbackHostname: PUBLIC_RESOLVER,
    transport: recordingTransport(),
    ...overrides,
  })
}

describe('publication notification payload', () => {
  test('is the exact stored event projection with no internal fields', () => {
    const body = Buffer.from(buildWebhookNotificationBody(VECTOR_EVENT)).toString('utf8')
    expect(body).toBe(
      `{"id":"event-vector-1","format":"attestbook.rulebook-publication-event@1","type":"rulebook.published","rulebookId":"rulebook-vector","version":"1.0.1","contentDigest":"${'a'.repeat(64)}","publishedAt":"2026-01-01T00:00:00.000Z"}`,
    )
    // Provider identity, draft content, credentials and audit metadata never
    // enter the body, mirroring the public event feed projection.
    expect(body).not.toContain('providerId')
    expect(body).not.toContain('draft')
  })

  test('matches the event the public feed serves', () => {
    const fixture = createFixture()
    const page = fixture.registry.listRulebookPublicationEvents(fixture.seeded.rulebookId)
    expect(page.events[0]).toEqual(fixture.event)
    expect(JSON.parse(Buffer.from(buildWebhookNotificationBody(fixture.event)).toString())).toEqual(
      fixture.event,
    )
  })
})

describe('webhook signing', () => {
  test('fixed vector has the documented canonical input and HMAC', () => {
    const body = buildWebhookNotificationBody(VECTOR_EVENT)
    const secret = deriveSubscriptionWebhookSecret(SIGNING_KEY, 'subscription-vector-1')
    // Pinned derived secret for the fixed deployment key and subscription id.
    expect(secret).toBe('atw_vIq7G8hzcwa9GKj68f2X2oYNzSGoDb1D_14l3zDjyT4')
    const canonical = canonicalWebhookSigningInput(FIXED_NOW, VECTOR_EVENT.id, body)
    expect(canonical.split('\n')).toHaveLength(4)
    expect(canonical.split('\n')[0]).toBe('attestbook.webhook-signing-input@1')
    expect(canonical.split('\n')[1]).toBe(FIXED_NOW)
    expect(canonical.split('\n')[2]).toBe(VECTOR_EVENT.id)
    const signature = signWebhookRequest(secret, FIXED_NOW, VECTOR_EVENT.id, body)
    // Pinned independent vector (HMAC-SHA-256 over the canonical input).
    expect(signature).toBe('v1=380592345e511699613ac27b3c6caf870fea8948c21e676652945021de963ed0')
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: FIXED_NOW,
        eventId: VECTOR_EVENT.id,
        body,
        signature,
      }),
    ).toBe(true)
  })

  test('rejects a tampered body, event id, timestamp and malformed header', () => {
    const body = buildWebhookNotificationBody(VECTOR_EVENT)
    const secret = deriveSubscriptionWebhookSecret(SIGNING_KEY, 'subscription-vector-1')
    const signature = signWebhookRequest(secret, FIXED_NOW, VECTOR_EVENT.id, body)
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: FIXED_NOW,
        eventId: VECTOR_EVENT.id,
        body,
        signature,
      }),
    ).toBe(true)
    const tampered = Buffer.from(body)
    tampered[tampered.length - 2] = 0x30
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: FIXED_NOW,
        eventId: VECTOR_EVENT.id,
        body: tampered,
        signature,
      }),
    ).toBe(false)
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: FIXED_NOW,
        eventId: 'another-event',
        body,
        signature,
      }),
    ).toBe(false)
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: '2026-01-01T00:00:01.000Z',
        eventId: VECTOR_EVENT.id,
        body,
        signature,
      }),
    ).toBe(false)
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: FIXED_NOW,
        eventId: VECTOR_EVENT.id,
        body,
        signature: 'v1=xyz',
      }),
    ).toBe(false)
    const otherSecret = deriveSubscriptionWebhookSecret(SIGNING_KEY, 'subscription-vector-2')
    expect(
      verifyWebhookSignature({
        secret: otherSecret,
        timestamp: FIXED_NOW,
        eventId: VECTOR_EVENT.id,
        body,
        signature,
      }),
    ).toBe(false)
  })
})

describe('webhook secret derivation', () => {
  test('is deterministic across instances, independent per subscription and never stored', () => {
    const first = deriveSubscriptionWebhookSecret(SIGNING_KEY, 'subscription-a')
    const again = deriveSubscriptionWebhookSecret(Buffer.from(SIGNING_KEY), 'subscription-a')
    const other = deriveSubscriptionWebhookSecret(SIGNING_KEY, 'subscription-b')
    expect(first).toBe(again)
    expect(first).not.toBe(other)
    expect(isSubscriptionWebhookSecret(first)).toBe(true)
    expect(isSubscriptionWebhookSecret('nope')).toBe(false)

    const fixture = createFixture({ webhookSigningKey: SIGNING_KEY })
    const registered = fixture.service.register({
      rulebookId: fixture.seeded.rulebookId,
      callbackUrl: 'https://subscriber.example.test/webhook',
      clientKey: '203.0.113.11',
    })
    expect(registered.webhookSecret).toBe(
      deriveSubscriptionWebhookSecret(SIGNING_KEY, registered.id),
    )
    // A restart with the same deployment key yields the same secret.
    const restarted = new SubscriptionService({
      database: fixture.database,
      source: fixture.registry,
      webhookSigningKey: Buffer.from(SIGNING_KEY),
    })
    expect(restarted).toBeDefined()
    const secret = registered.webhookSecret
    if (secret === undefined) {
      throw new Error('registration did not return a webhook secret')
    }
    expect(deriveSubscriptionWebhookSecret(Buffer.from(SIGNING_KEY), registered.id)).toBe(secret)

    const rows = fixture.database
      .query<Record<string, unknown>, []>('SELECT * FROM subscriptions')
      .all()
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain(secret)
    expect(stored).not.toContain(SIGNING_KEY.toString('base64url'))
    // The readable management projection never exposes the secret.
    expect(fixture.service.get(registered.id, registered.managementToken)).not.toHaveProperty(
      'webhookSecret',
    )
  })

  test('registration without a configured key returns no secret and delivery is disabled', async () => {
    const fixture = createFixture()
    const registered = fixture.service.register({
      rulebookId: fixture.seeded.rulebookId,
      callbackUrl: 'https://subscriber.example.test/webhook',
      clientKey: '203.0.113.12',
    })
    expect(registered).not.toHaveProperty('webhookSecret')
    const disabled = deliveryService(fixture, { signingKey: null })
    expect(disabled.enabled).toBe(false)
    expect(await disabled.deliverPublicationEvent(fixture.event)).toEqual([])
  })
})

describe('publication delivery', () => {
  test('delivers exactly one signed request to one active verified subscriber', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    const recorded: RecordedDelivery[] = []
    const service = deliveryService(fixture, {
      transport: recordingTransport(() => new Response(null, { status: 204 }), recorded),
    })

    const results = await service.deliverPublicationEvent(fixture.event)

    expect(results).toEqual([{ subscriptionId: registered.id, delivered: true, status: 204 }])
    expect(recorded).toHaveLength(1)
    const request = recorded[0]?.request
    if (request === undefined) {
      throw new Error('delivery request was not recorded')
    }
    expect(request.method).toBe('POST')
    expect(request.contentType).toBe(WEBHOOK_CONTENT_TYPE)
    expect(request.url.toString()).toBe('https://subscriber.example.test/webhook')
    expect(request.address).toBe('8.8.8.8')
    expect(request.hostname).toBe('subscriber.example.test')
    expect(request.headers?.[WEBHOOK_EVENT_ID_HEADER]).toBe(fixture.event.id)
    expect(request.headers?.[WEBHOOK_EVENT_TYPE_HEADER]).toBe('rulebook.published')
    expect(request.headers?.[WEBHOOK_TIMESTAMP_HEADER]).toBe(FIXED_NOW)
    const body = Buffer.from(request.body ?? [])
    expect(body.toString('utf8')).toBe(
      Buffer.from(buildWebhookNotificationBody(fixture.event)).toString('utf8'),
    )
    const secret = deriveSubscriptionWebhookSecret(SIGNING_KEY, registered.id)
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: FIXED_NOW,
        eventId: fixture.event.id,
        body,
        signature: request.headers?.[WEBHOOK_SIGNATURE_HEADER] ?? '',
      }),
    ).toBe(true)
  })

  test('keeps subscriptions isolated and never contacts pending, revoked or unrelated rows', async () => {
    const fixture = createFixture()
    const subscriberA = await activeSubscription(fixture)
    // A pending row for the same rulebook, a revoked row and an active row of
    // another rulebook must all stay untouched.
    fixture.service.register({
      rulebookId: fixture.seeded.rulebookId,
      callbackUrl: 'https://pending.example.test/webhook',
      clientKey: '203.0.113.13',
    })
    const revoked = await activeSubscription(
      fixture,
      fixture.seeded.rulebookId,
      '203.0.113.14',
      'https://revoked.example.test/webhook',
    )
    fixture.service.delete(revoked.id, revoked.managementToken)
    const otherRulebook = seedPublishedRulebook(fixture.database, fixture.registry, {
      authority: 'authority-2',
      rulebookName: 'Other Rulebook',
    })
    await activeSubscription(
      fixture,
      otherRulebook.rulebookId,
      '203.0.113.15',
      'https://other.example.test/webhook',
    )

    const recorded: RecordedDelivery[] = []
    const service = deliveryService(fixture, {
      transport: recordingTransport(() => new Response(null, { status: 204 }), recorded),
    })
    const results = await service.deliverPublicationEvent(fixture.event)

    expect(results).toEqual([{ subscriptionId: subscriberA.id, delivered: true, status: 204 }])
    expect(recorded.map((entry) => entry.request.url.toString())).toEqual([
      'https://subscriber.example.test/webhook',
    ])
  })

  test('never contacts a subscription revoked before dispatch', async () => {
    const fixture = createFixture()
    const registered = await activeSubscription(fixture)
    fixture.service.delete(registered.id, registered.managementToken)
    const recorded: RecordedDelivery[] = []
    const service = deliveryService(fixture, {
      transport: recordingTransport(() => new Response(null, { status: 204 }), recorded),
    })
    const results = await service.deliverPublicationEvent(fixture.event)
    expect(results).toEqual([])
    expect(recorded).toHaveLength(0)
  })

  test('refuses an unsafe callback DNS answer without opening a connection', async () => {
    const fixture = createFixture()
    await activeSubscription(fixture)
    const privateResolver: CallbackHostResolver = () =>
      Promise.resolve([{ address: '10.0.0.5', family: 4 }])
    const recorded: RecordedDelivery[] = []
    const service = deliveryService(fixture, {
      resolveCallbackHostname: privateResolver,
      transport: recordingTransport(() => new Response(null, { status: 204 }), recorded),
    })
    const results = await service.deliverPublicationEvent(fixture.event)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ delivered: false, reason: 'blocked_target' })
    expect(recorded).toHaveLength(0)
  })

  test.each([
    [
      '500',
      () => new Response(null, { status: 500 }),
      { delivered: false, reason: 'unexpected_status', status: 500 },
    ],
    [
      '302',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example.test/' },
        }),
      { delivered: false, reason: 'redirect_not_followed', status: 302 },
    ],
    ['201', () => new Response('accepted', { status: 201 }), { delivered: true, status: 201 }],
  ] as const)('classifies an HTTP %s answer', async (_label, response, expected) => {
    const fixture = createFixture()
    await activeSubscription(fixture)
    const service = deliveryService(fixture, { transport: recordingTransport(response) })
    const results = await service.deliverPublicationEvent(fixture.event)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject(expected)
  })

  test.each([
    ['timeout', new Http1TransportError('timeout', 'timed out'), 'timeout'],
    [
      'response_too_large',
      new Http1TransportError('response_too_large', 'too large'),
      'response_too_large',
    ],
    ['fetch_failed', new Http1TransportError('fetch_failed', 'unreachable'), 'network_failure'],
  ] as const)('classifies a %s transport failure', async (_label, error, reason) => {
    const fixture = createFixture()
    await activeSubscription(fixture)
    const service = deliveryService(fixture, {
      transport: () => Promise.reject(error),
    })
    const results = await service.deliverPublicationEvent(fixture.event)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ delivered: false, reason })
  })

  test('does not deliver a non-publication event', async () => {
    const fixture = createFixture()
    await activeSubscription(fixture)
    const recorded: RecordedDelivery[] = []
    const service = deliveryService(fixture, {
      transport: recordingTransport(() => new Response(null, { status: 204 }), recorded),
    })
    const results = await service.deliverPublicationEvent({
      ...fixture.event,
      type: 'rulebook.draft' as unknown as PublicationEvent['type'],
    })
    expect(results).toEqual([])
    expect(recorded).toHaveLength(0)
  })
})
