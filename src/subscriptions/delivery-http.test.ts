// End-to-end publication webhook delivery test (issue #119).
//
// Unlike the offline delivery tests, this exercises the production bounded
// HTTP transport against a disposable server bound to literal loopback, which
// is exactly the explicitly configured test-loopback path the local UAT
// environment enables. It proves the real signed POST, the signature a
// subscriber would verify, the exact body and the typed non-2xx failure over an
// actual socket; no external host is contacted.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import type { Database } from 'bun:sqlite'

import { Registry } from '../registry/registry'
import { openMigratedDatabase } from '../registry/test-support'
import { seedPublishedRulebook } from '../validation/test-support'

import {
  deriveSubscriptionWebhookSecret,
  verifyWebhookSignature,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookDeliveryService,
} from './delivery'
import { SUBSCRIPTION_VERIFICATION_TYPE } from './verification'
import { SubscriptionService } from './service'

const SIGNING_KEY = Buffer.from('fedcba9876543210fedcba9876543210', 'utf8')

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

interface DeliveryObservation {
  readonly eventId: string | null
  readonly timestamp: string | null
  readonly signature: string | null
  readonly body: string
}

function startCallback(onDelivery: (observation: DeliveryObservation) => Response): {
  readonly callbackUrl: string
} {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const text = await request.text()
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed['type'] === SUBSCRIPTION_VERIFICATION_TYPE) {
        return Response.json({ challenge: parsed['challenge'] })
      }
      return onDelivery({
        eventId: request.headers.get(WEBHOOK_EVENT_ID_HEADER),
        timestamp: request.headers.get(WEBHOOK_TIMESTAMP_HEADER),
        signature: request.headers.get(WEBHOOK_SIGNATURE_HEADER),
        body: text,
      })
    },
  })
  servers.push(server)
  return { callbackUrl: `http://127.0.0.1:${String(server.port)}/callback` }
}

async function createActiveSubscription(callbackUrl: string) {
  const database = openMigratedDatabase(':memory:')
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
    allowLoopbackHttp: true,
    webhookSigningKey: SIGNING_KEY,
  })
  const registered = service.register({
    rulebookId: seeded.rulebookId,
    callbackUrl,
    clientKey: '203.0.113.20',
  })
  await service.verify(registered.id, registered.managementToken)
  return { database, registry, event, seeded, registered }
}

describe('local mock HTTP publication delivery', () => {
  test('posts the exact signed event to an active verified loopback callback', async () => {
    const observations: DeliveryObservation[] = []
    const { callbackUrl } = startCallback((observation) => {
      observations.push(observation)
      return new Response(null, { status: 204 })
    })
    const fixture = await createActiveSubscription(callbackUrl)
    const delivery = new WebhookDeliveryService({
      database: fixture.database,
      signingKey: SIGNING_KEY,
      allowLoopbackHttp: true,
    })

    const results = await delivery.deliverPublicationEvent(fixture.event)

    expect(results).toEqual([
      { subscriptionId: fixture.registered.id, delivered: true, status: 204 },
    ])
    expect(observations).toHaveLength(1)
    const observation = observations[0]
    if (observation === undefined) {
      throw new Error('the callback did not observe a delivery')
    }
    expect(observation.eventId).toBe(fixture.event.id)
    expect(observation.timestamp).not.toBeNull()
    expect(JSON.parse(observation.body)).toEqual(fixture.event)
    const secret = deriveSubscriptionWebhookSecret(SIGNING_KEY, fixture.registered.id)
    expect(
      verifyWebhookSignature({
        secret,
        timestamp: observation.timestamp ?? '',
        eventId: observation.eventId ?? '',
        body: Buffer.from(observation.body, 'utf8'),
        signature: observation.signature ?? '',
      }),
    ).toBe(true)
  })

  test('reports a non-2xx callback as a typed failure over the real socket', async () => {
    const { callbackUrl } = startCallback(() => new Response('nope', { status: 500 }))
    const fixture = await createActiveSubscription(callbackUrl)
    const delivery = new WebhookDeliveryService({
      database: fixture.database,
      signingKey: SIGNING_KEY,
      allowLoopbackHttp: true,
    })

    const results = await delivery.deliverPublicationEvent(fixture.event)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      subscriptionId: fixture.registered.id,
      delivered: false,
      reason: 'unexpected_status',
      status: 500,
    })
  })

  test('does not follow a redirect from the callback', async () => {
    const { callbackUrl } = startCallback(
      () => new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:1/' } }),
    )
    const fixture = await createActiveSubscription(callbackUrl)
    const delivery = new WebhookDeliveryService({
      database: fixture.database,
      signingKey: SIGNING_KEY,
      allowLoopbackHttp: true,
    })

    const results = await delivery.deliverPublicationEvent(fixture.event)

    expect(results[0]).toMatchObject({ delivered: false, reason: 'redirect_not_followed' })
  })
})
