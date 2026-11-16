// Durable publication-event feed tests (issue #116).
//
// These tests exercise the real SQLite database: a new publication appends
// exactly one event inside its transaction, drafts/refreshes/failed or replayed
// publications append nothing, history survives supersession and a reopen, and
// the feed pages in stable ascending cursor order. Direct SQL checks prove the
// append-only triggers, not only the service path.

import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'

import { provisionProvider } from './bootstrap'
import { isRegistryError, RegistryError, type RegistryErrorCode } from './errors'
import { decodePublicationEventCursor, encodePublicationEventCursor } from './events'
import { Registry } from './registry'
import {
  createClock,
  createRegistryFixture,
  openMigratedDatabase,
  type RegistryFixture,
} from './test-support'
import type { AuthenticatedActor, Rulebook, RulebookVersion } from './types'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup(): RegistryFixture {
  fixture = createRegistryFixture()
  return fixture
}

function expectRegistryError(action: () => unknown, code: RegistryErrorCode): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RegistryError)
  expect(isRegistryError(caught) ? caught.code : undefined).toBe(code)
}

function provision(suffix: string): ReturnType<typeof provisionProvider> {
  if (fixture === undefined) {
    throw new Error('test fixture is not initialized')
  }
  return provisionProvider(fixture.database, {
    name: `Provider ${suffix}`,
    publicationAuthority: `account-${suffix}`,
  })
}

function rulebookContent(name = 'Publication Events Rulebook') {
  return {
    name,
    description: 'A rulebook used to test the durable publication-event feed.',
    sourceUrl: 'https://issuer.example.org/rulebooks/events',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Person Identification Data',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
      },
    ],
  }
}

function createRulebook(registry: Registry, actor: AuthenticatedActor): Rulebook {
  return registry.createRulebook(actor, rulebookContent())
}

function publishNewVersion(
  registry: Registry,
  actor: AuthenticatedActor,
  rulebook: Rulebook,
  version: string,
): RulebookVersion {
  registry.createRulebookVersion(actor, rulebook.id, { version })
  return registry.publishRulebookVersion(actor, rulebook.id, version)
}

function eventRowsCount(registryFixture: RegistryFixture): number {
  return (
    registryFixture.database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM publication_events')
      .get()?.count ?? 0
  )
}

describe('publication event recording', () => {
  test('records exactly one event for a new publication and none for draft creation', () => {
    const { registry } = setup()
    const { actor } = provision('create')
    const rulebook = createRulebook(registry, actor)

    registry.createRulebookVersion(actor, rulebook.id, { version: '1.0' })
    expect(registry.listRulebookPublicationEvents(rulebook.id).events).toEqual([])

    const published = registry.publishRulebookVersion(actor, rulebook.id, '1.0')
    const page = registry.listRulebookPublicationEvents(rulebook.id)

    expect(page.events).toHaveLength(1)
    expect(page.events[0]).toEqual({
      id: expect.any(String) as string,
      format: 'attestbook.rulebook-publication-event@1',
      type: 'rulebook.published',
      rulebookId: rulebook.id,
      version: '1.0',
      contentDigest: published.contentDigest,
      publishedAt: published.publishedAt as string,
    })
    expect(published.publishedAt).not.toBeNull()

    // A direct replay is refused and still appends nothing.
    expectRegistryError(
      () => registry.publishRulebookVersion(actor, rulebook.id, '1.0'),
      'immutable',
    )
    expect(registry.listRulebookPublicationEvents(rulebook.id).events).toHaveLength(1)
  })

  test('does not emit an event for a refreshed draft or a failed publication', () => {
    const { registry } = setup()
    const { actor } = provision('draft')
    const rulebook = createRulebook(registry, actor)
    registry.createRulebookVersion(actor, rulebook.id, { version: '1.0' })
    registry.refreshDraftRulebookVersion(actor, rulebook.id, '1.0')
    expect(registry.listRulebookPublicationEvents(rulebook.id).events).toEqual([])

    // Changing the working copy after the snapshot makes the draft stale, so
    // publication fails before any event could be written.
    registry.replaceDraftContent(actor, rulebook.id, rulebookContent('Changed Rulebook'))
    expectRegistryError(
      () => registry.publishRulebookVersion(actor, rulebook.id, '1.0'),
      'conflict',
    )
    expect(registry.listRulebookPublicationEvents(rulebook.id).events).toEqual([])
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('draft')
  })

  test('rolls the publication back when the event cannot be written', () => {
    const current = setup()
    const { actor } = provision('rollback')
    const rulebook = createRulebook(current.registry, actor)
    current.registry.createRulebookVersion(actor, rulebook.id, { version: '1.0' })

    // Make the append fail once, as a concurrent constraint fault would.
    current.database.exec(`
      CREATE TRIGGER test_reject_publication_event
      BEFORE INSERT ON publication_events
      BEGIN
        SELECT RAISE(ABORT, 'injected publication-event failure');
      END
    `)
    expect(() => current.registry.publishRulebookVersion(actor, rulebook.id, '1.0')).toThrow(
      'injected publication-event failure',
    )
    current.database.exec('DROP TRIGGER test_reject_publication_event')

    expect(current.registry.getRulebookVersion(rulebook.id, '1.0')?.status).toBe('draft')
    expect(current.registry.getRulebook(rulebook.id)?.publicationStatus).toBe('draft')
    expect(eventRowsCount(current)).toBe(0)
    expect(
      current.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'version.publish'",
        )
        .get()?.count,
    ).toBe(0)
  })

  test('keeps one event per published version after supersession and a SQLite reopen', () => {
    const current = setup()
    const { actor } = provision('reopen')
    const rulebook = createRulebook(current.registry, actor)
    publishNewVersion(current.registry, actor, rulebook, '1.0')
    publishNewVersion(current.registry, actor, rulebook, '1.1')
    // Reopen the working copy for the next version without publishing it.
    current.registry.createRulebookVersion(actor, rulebook.id, { version: '1.2' })

    const before = current.registry.listRulebookPublicationEvents(rulebook.id)
    expect(before.events.map((event) => event.version)).toEqual(['1.0', '1.1'])
    expect(current.registry.getRulebookVersion(rulebook.id, '1.0')?.status).toBe('historical')
    expect(current.registry.getRulebookVersion(rulebook.id, '1.2')?.status).toBe('draft')
    expect(eventRowsCount(current)).toBe(2)

    const { databasePath, directory } = current
    current.database.close()
    fixture = undefined

    const reopened = openMigratedDatabase(databasePath)
    try {
      const recovered = new Registry({ database: reopened, now: createClock() })
      expect(recovered.listRulebookPublicationEvents(rulebook.id)).toEqual(before)
      expect(recovered.getRulebookVersion(rulebook.id, '1.0')?.status).toBe('historical')
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('publication event feed pagination', () => {
  test('returns events in stable ascending order with opaque cursors', () => {
    const { registry } = setup()
    const { actor } = provision('page')
    const rulebook = createRulebook(registry, actor)
    publishNewVersion(registry, actor, rulebook, '1.0')
    publishNewVersion(registry, actor, rulebook, '1.1')
    publishNewVersion(registry, actor, rulebook, '1.2')

    const all = registry.listRulebookPublicationEvents(rulebook.id)
    expect(all.events.map((event) => event.version)).toEqual(['1.0', '1.1', '1.2'])
    expect(all.hasMore).toBe(false)
    expect(all.nextCursor).toBeNull()

    const first = registry.listRulebookPublicationEvents(rulebook.id, { limit: 1 })
    expect(first.events.map((event) => event.version)).toEqual(['1.0'])
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).not.toBeNull()

    const second = registry.listRulebookPublicationEvents(rulebook.id, {
      limit: 1,
      cursor: first.nextCursor as string,
    })
    expect(second.events.map((event) => event.version)).toEqual(['1.1'])
    expect(second.hasMore).toBe(true)

    // A publication appended between pages appears after the issued cursor
    // instead of shifting, duplicating or skipping earlier events.
    publishNewVersion(registry, actor, rulebook, '1.3')
    const third = registry.listRulebookPublicationEvents(rulebook.id, {
      limit: 1,
      cursor: second.nextCursor as string,
    })
    expect(third.events.map((event) => event.version)).toEqual(['1.2'])
    expect(third.hasMore).toBe(true)

    const fourth = registry.listRulebookPublicationEvents(rulebook.id, {
      limit: 1,
      cursor: third.nextCursor as string,
    })
    expect(fourth.events.map((event) => event.version)).toEqual(['1.3'])
    expect(fourth.hasMore).toBe(false)
    expect(fourth.nextCursor).toBeNull()
  })

  test('round-trips cursors and rejects an invalid limit or cursor', () => {
    expect(decodePublicationEventCursor(encodePublicationEventCursor(0))).toBe(0)
    expect(decodePublicationEventCursor(encodePublicationEventCursor(42))).toBe(42)

    const { registry } = setup()
    const { actor } = provision('invalid')
    const rulebook = createRulebook(registry, actor)

    expectRegistryError(
      () => registry.listRulebookPublicationEvents(rulebook.id, { limit: 0 }),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.listRulebookPublicationEvents(rulebook.id, { limit: 101 }),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.listRulebookPublicationEvents(rulebook.id, { cursor: 'not-a-cursor' }),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.listRulebookPublicationEvents('missing-rulebook'),
      'not_found',
    )
  })
})

describe('publication event database guards', () => {
  test('events are append-only and must pin a published version', () => {
    const current = setup()
    const { actor } = provision('guards')
    const rulebook = createRulebook(current.registry, actor)
    const published = publishNewVersion(current.registry, actor, rulebook, '1.0')

    expect(() =>
      current.database.query("UPDATE publication_events SET version = '9.9'").run(),
    ).toThrow('publication events are immutable')
    expect(() => current.database.query('DELETE FROM publication_events').run()).toThrow(
      'publication events are immutable',
    )

    // INSERT OR REPLACE resolves the unique version conflict by deleting the
    // old row without firing DELETE triggers, so the identity trigger must
    // reject the statement before conflict resolution.
    expect(() =>
      current.database
        .query(
          `INSERT OR REPLACE INTO publication_events
             (id, format, event_type, rulebook_id, version_id, version, content_digest, published_at)
           VALUES ('replacement-event', 'attestbook.rulebook-publication-event@1',
             'rulebook.published', ?, ?, '1.0', ?, ?)`,
        )
        .run(rulebook.id, published.id, published.contentDigest, published.publishedAt),
    ).toThrow('publication event identity already exists')

    // A draft version is not a publication artifact.
    const draft = current.registry.createRulebookVersion(actor, rulebook.id, { version: '1.1' })
    expect(() =>
      current.database
        .query(
          `INSERT INTO publication_events
             (id, format, event_type, rulebook_id, version_id, version, content_digest, published_at)
           VALUES ('draft-event', 'attestbook.rulebook-publication-event@1',
             'rulebook.published', ?, ?, '1.1', ?, ?)`,
        )
        .run(rulebook.id, draft.id, draft.contentDigest, draft.createdAt),
    ).toThrow('publication event must reference a published version')

    expect(eventRowsCount(current)).toBe(1)
  })
})
