import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { applyMigrations } from '../db/migrations'
import { openDatabase } from '../db/database'
import { Registry } from '../registry/registry'
import type { AuthenticatedActor, Rulebook } from '../registry/types'
import { openMigratedDatabase } from '../registry/test-support'
import { provisionProvider } from '../registry/bootstrap'
import { seedPublishedRulebook, type SeededRulebook } from '../validation/test-support'

import { isSubscriptionError, type SubscriptionErrorCode } from './errors'
import { SubscriptionService } from './service'
import { hashSubscriptionManagementToken, SUBSCRIPTION_MANAGEMENT_TOKEN_PREFIX } from './token'
import type {
  RegisterSubscriptionInput,
  RegisteredSubscription,
  SubscriptionServiceOptions,
} from './types'

interface SubscriptionFixture {
  readonly directory: string
  readonly databasePath: string
  database: Database
  registry: Registry
  service: SubscriptionService
  readonly seeded: SeededRulebook
  readonly options: SubscriptionServiceOptions
  reopen(): void
  cleanup(): void
}

function createSubscriptionFixture(
  overrides: Partial<SubscriptionServiceOptions> = {},
): SubscriptionFixture {
  const directory = mkdtempSync(join(tmpdir(), 'attestbook-subscriptions-'))
  const databasePath = join(directory, 'attestbook.sqlite')
  let database = openMigratedDatabase(databasePath)
  let registry = new Registry({ database })
  const seeded = seedPublishedRulebook(database, registry)
  let counter = 0
  const options: SubscriptionServiceOptions = {
    database,
    source: registry,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, counter++)).toISOString(),
    generateId: () => `subscription-${String(++counter)}`,
    ...overrides,
  }
  let service = new SubscriptionService(options)

  const fixture: SubscriptionFixture = {
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
    reopen() {
      database.close()
      database = openMigratedDatabase(databasePath)
      registry = new Registry({ database })
      service = new SubscriptionService({ ...options, database, source: registry })
    },
    cleanup() {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
  return fixture
}

let fixture: SubscriptionFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function requireFixture(): SubscriptionFixture {
  if (fixture === undefined) {
    throw new Error('subscription fixture is not initialized')
  }
  return fixture
}

function registration(
  overrides: Partial<RegisterSubscriptionInput> = {},
): RegisterSubscriptionInput {
  return {
    rulebookId: requireFixture().seeded.rulebookId,
    callbackUrl: 'https://subscriber.example.test/webhook',
    clientKey: '203.0.113.10',
    ...overrides,
  }
}

function expectError(callback: () => unknown): SubscriptionErrorCode {
  try {
    callback()
  } catch (error) {
    if (isSubscriptionError(error)) {
      return error.code
    }
    throw error
  }
  throw new Error('expected a subscription failure')
}

function subscriptionRows(database: Database): readonly Record<string, unknown>[] {
  return database
    .query<Record<string, unknown>, []>('SELECT * FROM subscriptions ORDER BY rowid')
    .all()
}

function createDraftRulebook(database: Database, registry: Registry): Rulebook {
  const provider = provisionProvider(database, {
    name: 'Subscription Draft Provider',
    publicationAuthority: 'subscription-draft-authority',
  })
  return registry.createRulebook(provider.actor, {
    name: 'Unpublished Rulebook',
    applicableSpec: 'ts11@1.0.1',
  })
}

function publishAnotherVersion(
  registry: Registry,
  actor: AuthenticatedActor,
  rulebookId: string,
  label: string,
): void {
  registry.createRulebookVersion(actor, rulebookId, { version: label })
  registry.publishRulebookVersion(actor, rulebookId, label)
}

describe('anonymous subscription registration', () => {
  test('stores a pending subscription and returns a one-time management token', () => {
    fixture = createSubscriptionFixture()
    const registered: RegisteredSubscription = fixture.service.register(registration())

    expect(registered.state).toBe('pending')
    expect(registered.rulebookId).toBe(fixture.seeded.rulebookId)
    expect(registered.callbackUrl).toBe('https://subscriber.example.test/webhook')
    expect(registered.managementToken.startsWith(SUBSCRIPTION_MANAGEMENT_TOKEN_PREFIX)).toBe(true)
    expect(registered.managementToken.length).toBeGreaterThan(32)

    const rows = subscriptionRows(fixture.database)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.['management_token_hash']).toBe(
      hashSubscriptionManagementToken(registered.managementToken),
    )
    expect(row?.['management_token_hash']).not.toBe(registered.managementToken)
    // The plaintext token is never stored, in any column.
    expect(JSON.stringify(rows)).not.toContain(registered.managementToken)
    expect(row?.['state']).toBe('pending')
  })

  test('requires no provider account and never contacts the callback host', () => {
    fixture = createSubscriptionFixture()
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      return Promise.reject(new Error('registration must not perform network I/O'))
    }) as unknown as typeof fetch
    try {
      const registered = fixture.service.register(registration())
      expect(registered.state).toBe('pending')
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('accepts a rulebook whose working copy is a new draft but was published before', () => {
    fixture = createSubscriptionFixture()
    publishAnotherVersion(fixture.registry, fixture.seeded.actor, fixture.seeded.rulebookId, '1.1')
    expect(fixture.registry.getRulebook(fixture.seeded.rulebookId)?.publicationStatus).toBe(
      'published',
    )
    // Creating the next draft reopens the working copy; the rulebook still has
    // a published version and remains a valid subscription target.
    fixture.registry.createRulebookVersion(fixture.seeded.actor, fixture.seeded.rulebookId, {
      version: '1.2',
    })
    expect(fixture.registry.getRulebook(fixture.seeded.rulebookId)?.publicationStatus).toBe('draft')

    const registered = fixture.service.register(registration())
    expect(registered.state).toBe('pending')
  })

  test('rejects an unknown rulebook, an unpublished rulebook and an unsafe URL without storing a row', () => {
    fixture = createSubscriptionFixture()
    expect(
      expectError(() => fixture?.service.register(registration({ rulebookId: 'missing' }))),
    ).toBe('not_found')

    const draft = createDraftRulebook(fixture.database, fixture.registry)
    expect(
      expectError(() => fixture?.service.register(registration({ rulebookId: draft.id }))),
    ).toBe('conflict')

    for (const callbackUrl of [
      'http://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/hook',
      'https://subscriber.example.test/hook#fragment',
      'https://user:secret@subscriber.example.test/hook',
    ]) {
      expect(expectError(() => fixture?.service.register(registration({ callbackUrl })))).toBe(
        'invalid_input',
      )
    }
    expect(subscriptionRows(fixture.database)).toHaveLength(0)
  })

  test('bounds the number of live subscriptions per rulebook', () => {
    fixture = createSubscriptionFixture({
      limits: { maxSubscriptionsPerRulebook: 1, registrationsPerClient: 100 },
    })
    const first = fixture.service.register(registration())
    expect(expectError(() => fixture?.service.register(registration()))).toBe('conflict')
    expect(subscriptionRows(fixture.database)).toHaveLength(1)

    // Revoking the only live subscription frees the bound.
    fixture.service.delete(first.id, first.managementToken)
    expect(fixture.service.register(registration()).state).toBe('pending')
  })

  test('bounds successful registrations per client without storing the client address', () => {
    fixture = createSubscriptionFixture({
      limits: { registrationsPerClient: 2, registrationWindowMs: 60_000 },
    })
    fixture.service.register(registration())
    fixture.service.register(registration())

    let retryAfter: number | undefined
    try {
      fixture.service.register(registration())
    } catch (error) {
      if (isSubscriptionError(error) && error.code === 'rate_limited') {
        retryAfter = error.retryAfterSeconds
      } else {
        throw error
      }
    }
    expect(retryAfter).toBeGreaterThanOrEqual(1)

    // A different client address has its own quota.
    expect(fixture.service.register(registration({ clientKey: '203.0.113.11' })).state).toBe(
      'pending',
    )
    expect(subscriptionRows(fixture.database)).toHaveLength(3)
    expect(JSON.stringify(subscriptionRows(fixture.database))).not.toContain('203.0.113.10')
  })

  test('an invalid registration does not spend the client quota', () => {
    fixture = createSubscriptionFixture({
      limits: { registrationsPerClient: 2, registrationWindowMs: 60_000 },
    })
    expect(
      expectError(() =>
        fixture?.service.register(registration({ callbackUrl: 'http://169.254.169.254/' })),
      ),
    ).toBe('invalid_input')
    expect(fixture.service.register(registration()).state).toBe('pending')
    expect(fixture.service.register(registration()).state).toBe('pending')
  })

  test('aggregates an IPv6 client quota to its /64 prefix', () => {
    fixture = createSubscriptionFixture({
      limits: { registrationsPerClient: 1, registrationWindowMs: 60_000 },
    })
    expect(fixture.service.register(registration({ clientKey: '2001:db8:1:2::1' })).state).toBe(
      'pending',
    )
    expect(
      expectError(() => fixture?.service.register(registration({ clientKey: '2001:db8:1:2::2' }))),
    ).toBe('rate_limited')
    expect(fixture.service.register(registration({ clientKey: '2001:db8:1:3::1' })).state).toBe(
      'pending',
    )
    expect(subscriptionRows(fixture.database)).toHaveLength(2)
  })
})

describe('subscription management', () => {
  test('reads only with the subscription-specific management token', () => {
    fixture = createSubscriptionFixture()
    const registered = fixture.service.register(registration())
    const read = fixture.service.get(registered.id, registered.managementToken)
    expect(read).toEqual({
      id: registered.id,
      rulebookId: registered.rulebookId,
      callbackUrl: registered.callbackUrl,
      state: 'pending',
      createdAt: registered.createdAt,
      updatedAt: registered.updatedAt,
    })
    expect(read).not.toHaveProperty('managementToken')
    expect(read).not.toHaveProperty('managementTokenHash')

    // Missing, wrong, provider and unknown credentials are indistinguishable.
    for (const token of [undefined, '', 'ats_wrong', fixture.seeded.token]) {
      expect(expectError(() => fixture?.service.get(registered.id, token))).toBe('unauthorized')
    }
    expect(expectError(() => fixture?.service.get('missing', registered.managementToken))).toBe(
      'unauthorized',
    )
    expect(
      expectError(() => fixture?.service.get('x'.repeat(1_000), registered.managementToken)),
    ).toBe('unauthorized')
  })

  test('a subscriber cannot read or delete another subscriber record', () => {
    fixture = createSubscriptionFixture()
    const first = fixture.service.register(
      registration({ callbackUrl: 'https://a.example.test/hook' }),
    )
    const second = fixture.service.register(
      registration({ callbackUrl: 'https://b.example.test/hook', clientKey: '203.0.113.11' }),
    )

    expect(expectError(() => fixture?.service.get(second.id, first.managementToken))).toBe(
      'unauthorized',
    )
    expect(expectError(() => fixture?.service.delete(second.id, first.managementToken))).toBe(
      'unauthorized',
    )
    expect(fixture.service.get(second.id, second.managementToken).state).toBe('pending')
  })

  test('deletes idempotently, revokes immediately and keeps the token binding', () => {
    fixture = createSubscriptionFixture()
    const registered = fixture.service.register(registration())

    expect(() => fixture?.service.delete(registered.id, registered.managementToken)).not.toThrow()
    expect(subscriptionRows(fixture.database)[0]?.['state']).toBe('revoked')
    expect(subscriptionRows(fixture.database)[0]?.['revoked_at']).not.toBeNull()
    expect(fixture.registry.getRulebook(registered.rulebookId)).not.toBeNull()

    // The revoked subscription is no longer readable, but the same token keeps
    // authorizing a repeated delete, which is a no-op success.
    expect(expectError(() => fixture?.service.get(registered.id, registered.managementToken))).toBe(
      'not_found',
    )
    expect(() => fixture?.service.delete(registered.id, registered.managementToken)).not.toThrow()
    const revokedAt = subscriptionRows(fixture.database)[0]?.['revoked_at']
    expect(() => fixture?.service.delete(registered.id, registered.managementToken)).not.toThrow()
    expect(subscriptionRows(fixture.database)[0]?.['revoked_at']).toBe(revokedAt)
  })

  test('keeps the subscription and its token valid across a database reopen', () => {
    fixture = createSubscriptionFixture()
    const registered = fixture.service.register(registration())
    const before = subscriptionRows(fixture.database)

    fixture.reopen()

    expect(subscriptionRows(fixture.database)).toEqual(before)
    expect(fixture.service.get(registered.id, registered.managementToken).callbackUrl).toBe(
      'https://subscriber.example.test/webhook',
    )
    fixture.service.delete(registered.id, registered.managementToken)
    fixture.reopen()
    expect(subscriptionRows(fixture.database)[0]?.['state']).toBe('revoked')
    expect(expectError(() => fixture?.service.get(registered.id, registered.managementToken))).toBe(
      'not_found',
    )
  })

  test('rejects an invalid service configuration at construction', () => {
    const database = openDatabase(':memory:')
    try {
      applyMigrations(database)
      expect(
        () =>
          new SubscriptionService({
            database,
            source: {
              getRulebook: () => null,
              listRulebookVersions: () => [],
            },
            limits: { registrationsPerClient: 0 },
          }),
      ).toThrow('subscription limit registrationsPerClient must be a positive integer')
    } finally {
      database.close()
    }
  })
})
