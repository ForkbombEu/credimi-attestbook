// HTTP contract tests for the draft lifecycle and version comparison (#41).
//
// These tests exercise the real registry through `app.request`: a deterministic
// public comparison, a public publication-readiness assessment, the authorized
// draft-snapshot refresh, and the immutability of published artifacts across
// every transition attempt.

import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import { provisionProvider } from '../registry/bootstrap'
import { sha256Hex } from '../registry/digest'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'
import type {
  PublicationReadinessResource,
  RulebookResource,
  RulebookVersionResource,
  VersionDiffResource,
} from './schemas'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function content(name = 'Lifecycle Rulebook') {
  return {
    name,
    description: 'Draft content for lifecycle tests.',
    sourceUrl: 'https://issuer.example.org/rulebooks/lifecycle',
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
  readonly registry: RegistryFixture['registry']
  readonly database: RegistryFixture['database']
  readonly token: string
  readonly otherToken: string
  readonly rulebookId: string
}

function setup(): Setup {
  fixture = createRegistryFixture()
  const owner = provisionProvider(fixture.database, {
    name: 'Lifecycle Provider',
    publicationAuthority: 'lifecycle-provider',
  })
  const other = provisionProvider(fixture.database, {
    name: 'Other Provider',
    publicationAuthority: 'other-provider',
  })
  const rulebook = fixture.registry.createRulebook(owner.token.secret, content())
  fixture.registry.createRulebookVersion(owner.token.secret, rulebook.id, { version: '1.0' })

  return {
    app: createApp({ registry: fixture.registry }),
    registry: fixture.registry,
    database: fixture.database,
    token: owner.token.secret,
    otherToken: other.token.secret,
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

async function errorJson(response: Response): Promise<ErrorEnvelope> {
  return json<ErrorEnvelope>(response)
}

function headers(token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

async function putDraft(
  app: Hono,
  rulebookId: string,
  token: string,
  body: ReturnType<typeof content>,
): Promise<Response> {
  return app.request(`/api/v1/rulebooks/${rulebookId}/draft`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify(body),
  })
}

async function postEmpty(app: Hono, path: string, token?: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: headers(token),
    body: '{}',
  })
}

describe('version comparison API', () => {
  test('compares two versions deterministically and excludes snapshot identity', async () => {
    const { app, registry, token, rulebookId } = setup()

    const changed = await putDraft(app, rulebookId, token, {
      ...content('Renamed Rulebook'),
      description: 'Changed after the first snapshot.',
    })
    expect(changed.status).toBe(200)

    const created = await app.request(`/api/v1/rulebooks/${rulebookId}/versions`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ version: '1.1' }),
    })
    expect(created.status).toBe(201)

    // A third label with the same content as 1.1 must compare as identical.
    const same = await app.request(`/api/v1/rulebooks/${rulebookId}/versions`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ version: '1.2' }),
    })
    expect(same.status).toBe(201)

    const first = await app.request(`/api/v1/rulebooks/${rulebookId}/versions/1.0/compare?to=1.1`)
    expect(first.status).toBe(200)
    const diff = await json<{ data: VersionDiffResource }>(first)
    assertSchema('VersionDiffResponse', diff)
    expect(diff.data.from.version).toBe('1.0')
    expect(diff.data.to.version).toBe('1.1')
    expect(diff.data.identical).toBe(false)
    const paths = diff.data.changes.map((change) => change.path)
    expect(paths).toEqual([...paths].sort())
    expect(diff.data.changes).toContainEqual({
      path: '/name',
      kind: 'changed',
      before: 'Lifecycle Rulebook',
      after: 'Renamed Rulebook',
    })
    expect(diff.data.summary.changed).toBeGreaterThan(0)

    // Repeating the same comparison returns exactly the same document.
    const again = await app.request(`/api/v1/rulebooks/${rulebookId}/versions/1.0/compare?to=1.1`)
    expect(await json<unknown>(again)).toEqual(diff)

    const identical = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.1/compare?to=1.2`,
    )
    const identicalBody = await json<{ data: VersionDiffResource }>(identical)
    expect(identicalBody.data.identical).toBe(true)
    expect(identicalBody.data.changes).toEqual([])

    // The stored digests are still distinct per label.
    const versions = registry.listRulebookVersions(rulebookId)
    expect(versions.map((version) => version.version)).toEqual(['1.0', '1.1', '1.2'])
  })

  test('rejects a missing or unknown comparison target', async () => {
    const { app, rulebookId } = setup()

    const missing = await app.request(`/api/v1/rulebooks/${rulebookId}/versions/1.0/compare`)
    expect(missing.status).toBe(400)
    expect((await errorJson(missing)).error.code).toBe('invalid_request')

    const unknown = await app.request(`/api/v1/rulebooks/${rulebookId}/versions/1.0/compare?to=9.9`)
    expect(unknown.status).toBe(404)
    expect((await errorJson(unknown)).error.code).toBe('not_found')

    const unknownRulebook = await app.request(
      `/api/v1/rulebooks/00000000-0000-4000-8000-000000000000/versions/1.0/compare?to=1.1`,
    )
    expect(unknownRulebook.status).toBe(404)
  })
})

describe('publication readiness API', () => {
  test('a fresh draft is ready, a stale one is not, and refresh fixes it', async () => {
    const { app, registry, token, otherToken, rulebookId } = setup()

    const readiness = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publication-readiness`,
    )
    expect(readiness.status).toBe(200)
    const ready = await json<{ data: PublicationReadinessResource }>(readiness)
    assertSchema('PublicationReadinessResponse', ready)
    expect(ready.data.ready).toBe(true)
    expect(ready.data.checks.map((check) => check.id)).toEqual([
      'draft_version',
      'rulebook_status',
      'snapshot_integrity',
      'snapshot_current',
      'content_valid',
      'standards_profile',
      'attestation_types',
    ])
    expect(ready.data.checks.every((check) => check.status === 'pass')).toBe(true)
    expect(ready.data.limitations.length).toBeGreaterThan(0)

    const beforeDigest = registry.getRulebookVersion(rulebookId, '1.0')?.contentDigest
    const changed = await putDraft(app, rulebookId, token, content('Changed after snapshot'))
    expect(changed.status).toBe(200)

    const stale = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publication-readiness`,
    )
    const staleBody = await json<{ data: PublicationReadinessResource }>(stale)
    expect(staleBody.data.ready).toBe(false)
    expect(staleBody.data.checks.find((check) => check.id === 'snapshot_current')?.status).toBe(
      'fail',
    )

    const foreignRefresh = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/refresh`,
      otherToken,
    )
    expect(foreignRefresh.status).toBe(403)

    const unauthenticated = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/refresh`,
    )
    expect(unauthenticated.status).toBe(401)

    const refreshed = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/refresh`,
      token,
    )
    expect(refreshed.status).toBe(200)
    const refreshedBody = await json<{ data: RulebookVersionResource }>(refreshed)
    assertSchema('RulebookVersionResponse', refreshedBody)
    expect(refreshedBody.data.status).toBe('draft')
    expect(refreshedBody.data.contentDigest).not.toBe(beforeDigest)

    const afterRefresh = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publication-readiness`,
    )
    expect((await json<{ data: PublicationReadinessResource }>(afterRefresh)).data.ready).toBe(true)

    const missingVersion = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/9.9/refresh`,
      token,
    )
    expect(missingVersion.status).toBe(404)
  })
})

describe('readiness matches the publish transition', () => {
  test('a leftover draft on a published rulebook is not ready and cannot be published', async () => {
    const { app, registry, rulebookId, token } = setup()

    const create = (version: string) =>
      app.request(`/api/v1/rulebooks/${rulebookId}/versions`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ version }),
      })

    expect((await create('1.1')).status).toBe(201)
    const firstPublish = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.1/publish`,
      token,
    )
    expect(firstPublish.status).toBe(200)
    expect(registry.getRulebook(rulebookId)?.publicationStatus).toBe('published')

    const readiness = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publication-readiness`,
    )
    expect(readiness.status).toBe(200)
    const body = await json<{ data: PublicationReadinessResource }>(readiness)
    assertSchema('PublicationReadinessResponse', body)
    expect(body.data.ready).toBe(false)
    const rulebookStatus = body.data.checks.find((check) => check.id === 'rulebook_status')
    expect(rulebookStatus?.status).toBe('fail')
    expect(
      body.data.checks
        .filter((check) => check.id !== 'rulebook_status')
        .every((check) => check.status === 'pass'),
    ).toBe(true)

    const rejected = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publish`,
      token,
    )
    expect(rejected.status).toBe(409)
    expect((await errorJson(rejected)).error.code).toBe('immutable')
    expect(registry.getRulebookVersion(rulebookId, '1.1')?.status).toBe('published')

    // Creating the next version reopens the working copy; the leftover draft is
    // then publishable again under the same transition policy.
    expect((await create('1.2')).status).toBe(201)
    const reopened = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publication-readiness`,
    )
    expect((await json<{ data: PublicationReadinessResource }>(reopened)).data.ready).toBe(true)
    const published = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publish`,
      token,
    )
    expect(published.status).toBe(200)
    expect(registry.getRulebookVersion(rulebookId, '1.1')?.status).toBe('historical')
  })
})

describe('published artifacts stay immutable', () => {
  test('publishing, superseding and failed transitions never change frozen bytes', async () => {
    const { app, registry, token, rulebookId } = setup()

    const published = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publish`,
      token,
    )
    expect(published.status).toBe(200)
    const frozen = await app.request(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    expect(frozen.status).toBe(200)
    const frozenBytes = new Uint8Array(await frozen.arrayBuffer())
    const frozenDigest = registry.getRulebookVersion(rulebookId, '1.0')?.contentDigest
    expect(frozenDigest).toBeDefined()
    if (frozenDigest === undefined) {
      throw new Error('the published version must have a digest')
    }
    expect(sha256Hex(frozenBytes)).toBe(frozenDigest)

    // A published version cannot be refreshed or transitioned again.
    const refreshPublished = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/refresh`,
      token,
    )
    expect(refreshPublished.status).toBe(409)
    expect((await errorJson(refreshPublished)).error.code).toBe('immutable')

    const rePublish = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publish`,
      token,
    )
    expect(rePublish.status).toBe(200)

    // The published working copy is read-only until a new draft version exists.
    const editPublished = await putDraft(app, rulebookId, token, content('Mutated'))
    expect(editPublished.status).toBe(409)
    expect((await errorJson(editPublished)).error.code).toBe('immutable')

    // Creating the next version reopens the working copy without touching 1.0.
    const next = await app.request(`/api/v1/rulebooks/${rulebookId}/versions`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ version: '2.0' }),
    })
    expect(next.status).toBe(201)
    const edited = await putDraft(app, rulebookId, token, content('Next generation'))
    expect(edited.status).toBe(200)
    const refreshNext = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/2.0/refresh`,
      token,
    )
    expect(refreshNext.status).toBe(200)
    const publishNext = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/2.0/publish`,
      token,
    )
    expect(publishNext.status).toBe(200)
    expect(registry.getRulebookVersion(rulebookId, '1.0')?.status).toBe('historical')

    // The superseded artifact bytes and digest are unchanged.
    const frozenAgain = await app.request(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    expect(frozenAgain.status).toBe(200)
    expect(new Uint8Array(await frozenAgain.arrayBuffer())).toEqual(frozenBytes)
    expect(registry.getRulebookVersion(rulebookId, '1.0')?.contentDigest).toBe(frozenDigest)

    const historicalReadiness = await app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publication-readiness`,
    )
    const historicalBody = await json<{ data: PublicationReadinessResource }>(historicalReadiness)
    expect(historicalBody.data.ready).toBe(false)
    expect(historicalBody.data.checks.find((check) => check.id === 'draft_version')?.status).toBe(
      'fail',
    )

    const republishHistorical = await postEmpty(
      app,
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/publish`,
      token,
    )
    expect(republishHistorical.status).toBe(409)
    expect((await errorJson(republishHistorical)).error.code).toBe('immutable')
  })
})

describe('lifecycle API projections', () => {
  test('version responses never expose registry-internal provenance', async () => {
    const { app, rulebookId } = setup()
    const response = await app.request(`/api/v1/rulebooks/${rulebookId}/versions/1.0`)
    const body = await json<{ data: RulebookVersionResource }>(response)
    expect(body.data).not.toHaveProperty('provenance')
    expect(body.data).not.toHaveProperty('artifact')
  })

  test('creating a rulebook through the API can enter the lifecycle', async () => {
    const { app, registry, token } = setup()
    const created = await app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(content('API lifecycle rulebook')),
    })
    expect(created.status).toBe(201)
    const rulebook = await json<{ data: RulebookResource }>(created)
    expect(rulebook.data.publicationStatus).toBe('draft')

    const versions = registry.listRulebookVersions(rulebook.data.id)
    expect(versions).toEqual([])

    const version = await app.request(`/api/v1/rulebooks/${rulebook.data.id}/versions`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ version: '1.0' }),
    })
    expect(version.status).toBe(201)
  })
})
