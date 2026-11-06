// HTTP-level security tests for the versioned write API (issue #35).
//
// These tests exercise the declared contract through the real Hono
// application and a real temporary SQLite registry, so a regression in the
// route table, the central bearer middleware, the registry's ownership checks
// or the error/audit surfaces fails here. They complement the service-level
// ownership tests in src/registry/authorization.test.ts.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import { provisionProvider } from '../registry/bootstrap'
import type { Registry } from '../registry/registry'
import { hashBearerToken } from '../registry/tokens'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { CredentialValidator } from '../validation'
import {
  issueTestCredential,
  seedPublishedRulebook,
  type SeededRulebook,
} from '../validation/test-support'

import { BEARER_CHALLENGE } from './errors'
import { API_ROUTES, type ApiRouteSpec } from './routes'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

interface Setup {
  readonly app: Hono
  readonly registry: Registry
  readonly seeded: SeededRulebook
}

function setup(): Setup {
  fixture = createRegistryFixture()
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry)
  const validation = new CredentialValidator({
    source: fixture.registry,
    now: () => '2026-01-01T00:00:00.000Z',
    generateId: () => 'http-security-validation-id',
  })
  return {
    app: createApp({ registry: fixture.registry, validation }),
    registry: fixture.registry,
    seeded,
  }
}

function requireFixture(): RegistryFixture {
  if (fixture === undefined) {
    throw new Error('test fixture is not initialized')
  }
  return fixture
}

async function errorJson(response: Response): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope
}

function concretePath(route: ApiRouteSpec, rulebookId: string): string {
  return route.path.replace(':rulebookId', rulebookId).replace(':version', '1.0')
}

function bearer(secret: string): string {
  return `Bearer ${secret}`
}

async function protectedRequest(
  app: Hono,
  route: ApiRouteSpec,
  rulebookId: string,
  authorization: string | undefined,
): Promise<Response> {
  return app.request(concretePath(route, rulebookId), {
    method: route.method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    // The body is deliberately malformed: authentication must reject the
    // request before any handler reads or parses it.
    body: '{not-json',
  })
}

function auditCount(registryFixture: RegistryFixture): number {
  return (
    registryFixture.database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM audit_log')
      .get()?.count ?? 0
  )
}

describe('write operation security surface', () => {
  test('the protected operation set is exactly the write surface', () => {
    const protectedOperations = API_ROUTES.filter((route) => route.security)
      .map((route) => route.operationId)
      .sort()
    expect(protectedOperations).toEqual([
      'createRulebook',
      'createRulebookVersion',
      'importRulebooks',
      'previewImport',
      'publishRulebookVersion',
      'replaceRulebookDraft',
    ])

    // Credential validation is a read-only POST and stays public.
    const publicPosts = API_ROUTES.filter(
      (route) => route.method === 'post' && !route.security,
    ).map((route) => route.operationId)
    expect(publicPosts).toEqual(['validateRulebookDraft', 'validateCredential'])
  })

  test('every protected route rejects missing, malformed, unknown and revoked credentials', async () => {
    const { app, registry, seeded } = setup()
    const registryFixture = requireFixture()

    const revokedProvider = provisionProvider(registryFixture.database, {
      name: 'Revoked Provider',
      publicationAuthority: 'authority-revoked',
    })
    registry.revokeToken(revokedProvider.token.secret, revokedProvider.token.id)

    const credentials: readonly (string | undefined)[] = [
      undefined,
      'Basic dXNlcjpwYXNz',
      'Bearer',
      bearer('att_unknown_token_value'),
      bearer(revokedProvider.token.secret),
    ]

    const before = {
      rulebooks: JSON.stringify(registry.listRulebooks()),
      versions: JSON.stringify(registry.listRulebookVersions(seeded.rulebookId)),
      audit: auditCount(registryFixture),
    }

    const protectedRoutes = API_ROUTES.filter((route) => route.security)
    for (const route of protectedRoutes) {
      for (const authorization of credentials) {
        const response = await protectedRequest(app, route, seeded.rulebookId, authorization)
        const label = `${route.operationId} with ${String(authorization)}`

        expect(response.status, label).toBe(401)
        expect(response.headers.get('www-authenticate'), label).toBe(BEARER_CHALLENGE)
        const body = await errorJson(response)
        expect(body.error.code, label).toBe('unauthorized')
        const text = JSON.stringify(body)
        for (const secret of [
          'dXNlcjpwYXNz',
          'att_unknown_token_value',
          revokedProvider.token.secret,
        ]) {
          expect(text, label).not.toContain(secret)
        }
      }
    }

    // Rejected requests caused no write and no audit event.
    expect(JSON.stringify(registry.listRulebooks())).toBe(before.rulebooks)
    expect(JSON.stringify(registry.listRulebookVersions(seeded.rulebookId))).toBe(before.versions)
    expect(auditCount(registryFixture)).toBe(before.audit)
  })
})

describe('provider ownership on write endpoints', () => {
  test('a foreign provider cannot create or publish versions and state is unchanged', async () => {
    const { app, registry, seeded } = setup()
    const registryFixture = requireFixture()
    const owner = registry.getRulebook(seeded.rulebookId)
    if (owner === null) {
      throw new Error('expected the seeded rulebook')
    }
    const other = provisionProvider(registryFixture.database, {
      name: 'Other Provider',
      publicationAuthority: 'authority-other',
    })

    const before = {
      rulebook: registry.getRulebook(seeded.rulebookId),
      versions: JSON.stringify(registry.listRulebookVersions(seeded.rulebookId)),
      audit: auditCount(registryFixture),
    }

    const createVersion = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer(other.token.secret) },
      body: JSON.stringify({ version: '2.0' }),
    })
    expect(createVersion.status).toBe(403)
    expect((await errorJson(createVersion)).error.code).toBe('forbidden')

    // Ownership is checked before the idempotent replay path, so a foreign
    // provider cannot get a write-shaped success by targeting a published
    // version, and a missing version cannot be probed either.
    for (const version of ['1.0', '9.9']) {
      const publish = await app.request(
        `/api/v1/rulebooks/${seeded.rulebookId}/versions/${version}/publish`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: bearer(other.token.secret),
          },
          body: '{}',
        },
      )
      expect(publish.status, `foreign publish of ${version}`).toBe(403)
      expect((await errorJson(publish)).error.code).toBe('forbidden')
    }

    expect(registry.getRulebook(seeded.rulebookId)).toEqual(before.rulebook)
    expect(JSON.stringify(registry.listRulebookVersions(seeded.rulebookId))).toBe(before.versions)
    expect(auditCount(registryFixture)).toBe(before.audit)

    // A caller can create only its own resource: ownership is never taken from
    // the request body, internal fields stay registry-internal.
    const created = await app.request('/api/v1/rulebooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer(other.token.secret) },
      body: JSON.stringify({
        name: 'Other Provider Draft',
        applicableSpec: 'ts11@1.0.1',
        providerId: owner.providerId,
        metadata: { injected: true },
        provenance: { injected: true },
        importKey: 'f'.repeat(64),
      }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { data: { id: string } }
    const stored = registry.getRulebook(createdBody.data.id)
    expect(stored?.providerId).toBe(other.provider.id)
    expect(stored?.metadata).toEqual({})
    expect(stored?.provenance).toEqual({})
    expect(stored?.importKey).toBeNull()
  })
})

describe('public read behavior is preserved', () => {
  test('public GET routes stay readable without a token', async () => {
    const { app, seeded } = setup()

    for (const route of API_ROUTES.filter(
      (candidate) => candidate.method === 'get' && !candidate.security,
    )) {
      const response = await app.request(concretePath(route, seeded.rulebookId))
      expect(response.status, `${route.operationId} must be publicly readable`).toBe(200)
    }

    // A provider's working draft is public catalogue data by design (TS11
    // public read); write protection does not turn reads into owner-only.
    if (fixture === undefined) {
      throw new Error('test fixture is not initialized')
    }
    const owner = provisionProvider(fixture.database, {
      name: 'Draft Owner',
      publicationAuthority: 'authority-draft-owner',
    })
    const draft = fixture.registry.createRulebook(owner.token.secret, {
      name: 'Public Draft',
      applicableSpec: 'ts11@1.0.1',
    })
    const anonymous = await app.request(`/api/v1/rulebooks/${draft.id}`)
    expect(anonymous.status).toBe(200)
  })

  test('credential validation stays public and read-only', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()

    const response = await app.request('/api/v1/credentials/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
        credential,
        schemaDocuments: [{ uri: seeded.schemaUri, content: seeded.schemaContent }],
      }),
    })
    expect(response.status).toBe(200)
  })
})

describe('secret redaction', () => {
  test('401 bodies and unhandled-error logs never contain the presented credential', async () => {
    const { app } = setup()
    const secret = 'att_secret_that_must_never_leak_0123456789'
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }

    try {
      const unauthorized = await app.request('/api/v1/rulebooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearer(secret) },
        body: '{}',
      })
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.text()).not.toContain(secret)

      // Hono's router is built on first request, so the synthetic failure
      // route gets its own application assembled from the same pipeline.
      const errorApp = createApp()
      errorApp.get('/api/v1/__security_test_error', () => {
        throw new Error(`internal failure carrying ${secret}`)
      })
      const failed = await errorApp.request('/api/v1/__security_test_error', {
        headers: { authorization: bearer(secret) },
      })
      expect(failed.status).toBe(500)
      expect(await failed.text()).not.toContain(secret)

      // The unhandled-error log records only method, path and error class.
      expect(logged).toHaveLength(1)
      expect(JSON.stringify(logged)).not.toContain(secret)
    } finally {
      console.error = originalError
    }
  })

  test('write audit entries record the acting provider and never a token or hash', async () => {
    const { app, registry, seeded } = setup()
    const registryFixture = requireFixture()
    const owner = registry.getRulebook(seeded.rulebookId)
    if (owner === null) {
      throw new Error('expected the seeded rulebook')
    }

    const createVersion = await app.request(`/api/v1/rulebooks/${seeded.rulebookId}/versions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: bearer(seeded.token),
      },
      body: JSON.stringify({ version: '2.0' }),
    })
    expect(createVersion.status).toBe(201)

    const publish = await app.request(
      `/api/v1/rulebooks/${seeded.rulebookId}/versions/2.0/publish`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearer(seeded.token),
        },
        body: '{}',
      },
    )
    expect(publish.status).toBe(200)

    interface AuditRow {
      readonly action: string
      readonly actor_provider_id: string | null
      readonly detail_json: string | null
    }
    const rows = registryFixture.database
      .query<AuditRow, []>(
        'SELECT action, actor_provider_id, detail_json FROM audit_log ORDER BY id',
      )
      .all()

    const ownedActions = new Set(rows.map((row) => row.action))
    for (const action of ['rulebook.create', 'version.create', 'version.publish']) {
      expect(ownedActions.has(action), `missing ${action} audit row`).toBe(true)
    }

    const publication = rows
      .filter((row) => row.action === 'version.publish' && row.detail_json !== null)
      .map((row) => ({
        actor: row.actor_provider_id,
        detail: JSON.parse(row.detail_json ?? '{}') as Record<string, unknown>,
      }))
      .find((row) => row.detail['version'] === '2.0')
    expect(publication?.actor).toBe(owner.providerId)
    const detail = publication?.detail ?? {}
    expect(detail['version']).toBe('2.0')
    expect(detail['contentDigest']).toMatch(/^[0-9a-f]{64}$/)
    expect(detail['supersededVersions']).toContain('1.0')

    const auditText = JSON.stringify(rows)
    expect(auditText).not.toContain(seeded.token)
    expect(auditText).not.toContain(hashBearerToken(seeded.token))
    expect(auditText).not.toMatch(/\batt_[A-Za-z0-9_-]{20,}\b/)
  })
})
