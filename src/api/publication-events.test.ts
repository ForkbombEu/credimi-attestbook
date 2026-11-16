// HTTP contract tests for the public publication-event feed (issue #116).
//
// The feed must be readable without any credential, append exactly one event
// per new publication, preserve earlier events after supersession, page with
// an opaque cursor and never expose provider, working-copy or audit data.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'
import type { PublicationEventPageResource, RulebookVersionResource } from './schemas'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function content(name = 'Events Rulebook') {
  return {
    name,
    description: 'Content for publication-event feed tests.',
    sourceUrl: 'https://issuer.example.org/rulebooks/events',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Person Identification Data',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
        schemaReferences: [
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://issuer.example.org/schemas/pid',
          },
        ],
      },
    ],
    schemaReferences: [],
  }
}

interface Setup {
  readonly app: Hono
  readonly database: Database
  readonly registry: RegistryFixture['registry']
  readonly token: string
  readonly providerId: string
  readonly rulebookId: string
}

function setup(): Setup {
  fixture = createRegistryFixture()
  const owner = provisionProvider(fixture.database, {
    name: 'Events Provider',
    publicationAuthority: 'events-provider',
  })
  const rulebook = fixture.registry.createRulebook(owner.actor, content())
  return {
    app: createApp({ registry: fixture.registry }),
    database: fixture.database,
    registry: fixture.registry,
    token: owner.token.secret,
    providerId: owner.provider.id,
    rulebookId: rulebook.id,
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const validators = new Map<string, ValidateFunction>()

function assertSchema(name: OpenApiComponentName, value: unknown): void {
  let validate = validators.get(name)
  if (validate === undefined) {
    validate = ajv.compile(componentJsonSchema(name))
    validators.set(name, validate)
  }
  expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true)
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function headers(token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

async function post(
  app: Hono,
  path: string,
  token: string | undefined,
  body: unknown = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  })
}

function eventsPath(rulebookId: string, query = ''): string {
  return `/api/v1/rulebooks/${rulebookId}/events${query}`
}

/** Anonymous read: no Authorization header and no cookie. */
async function readEvents(
  app: Hono,
  rulebookId: string,
  query = '',
): Promise<PublicationEventPageResource> {
  const response = await app.request(eventsPath(rulebookId, query))
  expect(response.status).toBe(200)
  const body = await json<PublicationEventPageResource>(response)
  assertSchema('PublicationEventPageResponse', body)
  return body
}

async function publishVersion(
  app: Hono,
  token: string,
  rulebookId: string,
  version: string,
): Promise<RulebookVersionResource> {
  const created = await post(app, `/api/v1/rulebooks/${rulebookId}/versions`, token, { version })
  expect(created.status).toBe(201)
  const published = await post(
    app,
    `/api/v1/rulebooks/${rulebookId}/versions/${version}/publish`,
    token,
  )
  expect(published.status).toBe(200)
  return (await json<{ data: RulebookVersionResource }>(published)).data
}

describe('publication event feed API', () => {
  test('serves events anonymously and records one for a new publication only', async () => {
    const { app, token, providerId, rulebookId } = setup()

    // Freezing a draft version is not a publication and emits no event.
    const created = await post(app, `/api/v1/rulebooks/${rulebookId}/versions`, token, {
      version: '1.0',
    })
    expect(created.status).toBe(201)
    const empty = await readEvents(app, rulebookId)
    expect(empty.data).toEqual([])
    expect(empty.pagination).toEqual({ limit: 50, nextCursor: null, hasMore: false })

    const published = await post(app, `/api/v1/rulebooks/${rulebookId}/versions/1.0/publish`, token)
    expect(published.status).toBe(200)
    const version = await json<{ data: RulebookVersionResource }>(published)
    const page = await readEvents(app, rulebookId)

    expect(page.data).toHaveLength(1)
    expect(page.data[0]).toMatchObject({
      format: 'attestbook.rulebook-publication-event@1',
      type: 'rulebook.published',
      rulebookId,
      version: '1.0',
      contentDigest: version.data.contentDigest,
      publishedAt: version.data.publishedAt,
    })
    expect(page.data[0]?.id).toEqual(expect.any(String) as string)
    expect(page.pagination).toEqual({ limit: 50, nextCursor: null, hasMore: false })

    // An idempotent publication replay returns the same version and appends
    // nothing to the feed.
    const replay = await post(app, `/api/v1/rulebooks/${rulebookId}/versions/1.0/publish`, token)
    expect(replay.status).toBe(200)
    const replayed = await readEvents(app, rulebookId)
    expect(replayed.data).toEqual(page.data)

    // The public projection never carries provider identity, working-copy
    // content or audit metadata.
    const response = await app.request(eventsPath(rulebookId))
    const text = await response.text()
    expect(text).not.toContain(token)
    expect(text).not.toContain(providerId)
    expect(text).not.toContain('Events Rulebook')
    expect(text).not.toContain('Content for publication-event feed tests.')
    expect(text).not.toContain('audit')
    expect(text).not.toContain('provenance')
  })

  test('preserves every publication event after a new version supersedes the old one', async () => {
    const { app, token, rulebookId } = setup()
    const first = await publishVersion(app, token, rulebookId, '1.0')
    const second = await publishVersion(app, token, rulebookId, '1.1')

    const page = await readEvents(app, rulebookId)
    expect(page.data.map((event) => event.version)).toEqual(['1.0', '1.1'])
    expect(page.data[0]?.id).not.toBe(page.data[1]?.id)
    expect(page.data[0]?.contentDigest).toBe(first.contentDigest)
    expect(page.data[1]?.contentDigest).toBe(second.contentDigest)

    const versions = await app.request(`/api/v1/rulebooks/${rulebookId}/versions`)
    const listed = await json<{ data: RulebookVersionResource[] }>(versions)
    expect(listed.data.map((version) => [version.version, version.status])).toEqual([
      ['1.0', 'historical'],
      ['1.1', 'published'],
    ])
  })

  test('pages with the returned cursor and rejects an invalid limit or cursor', async () => {
    const { app, token, rulebookId } = setup()
    await publishVersion(app, token, rulebookId, '1.0')
    await publishVersion(app, token, rulebookId, '1.1')
    await publishVersion(app, token, rulebookId, '1.2')

    const first = await readEvents(app, rulebookId, '?limit=1')
    expect(first.data.map((event) => event.version)).toEqual(['1.0'])
    expect(first.pagination.hasMore).toBe(true)
    expect(first.pagination.nextCursor).not.toBeNull()

    const second = await readEvents(
      app,
      rulebookId,
      `?limit=1&cursor=${encodeURIComponent(first.pagination.nextCursor as string)}`,
    )
    expect(second.data.map((event) => event.version)).toEqual(['1.1'])

    const last = await readEvents(
      app,
      rulebookId,
      `?cursor=${encodeURIComponent(second.pagination.nextCursor as string)}`,
    )
    expect(last.data.map((event) => event.version)).toEqual(['1.2'])
    expect(last.pagination).toEqual({ limit: 50, nextCursor: null, hasMore: false })

    for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?cursor=bogus']) {
      const response = await app.request(eventsPath(rulebookId, query))
      expect(response.status, query).toBe(400)
      const body = await json<ErrorEnvelope>(response)
      expect(body.error.code).toBe('invalid_request')
    }
  })

  test('returns a documented not-found error for an unknown rulebook', async () => {
    const { app } = setup()
    const response = await app.request(eventsPath('missing-rulebook'))
    expect(response.status).toBe(404)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('not_found')
  })

  test('answers 503 when the registry is not wired', async () => {
    const app = createApp()
    const response = await app.request(eventsPath('any-rulebook'))
    expect(response.status).toBe(503)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('registry_unavailable')
  })
})
