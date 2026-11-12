// HTTP contract and integration tests for publication export (issue #42).
//
// These tests exercise the real registry through `app.request`: authorized
// publication, the exact immutable bytes, the reproducible export manifest, the
// draft-version refusal and the publication audit trail.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import { provisionProvider } from '../registry/bootstrap'
import { sha256Hex } from '../registry/digest'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'
import type { PublicationExportManifestResource, RulebookVersionResource } from './schemas'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function content(name = 'Publication Rulebook') {
  return {
    name,
    description: 'Content for publication export tests.',
    sourceUrl: 'https://issuer.example.org/rulebooks/publication',
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
  readonly otherToken: string
  readonly providerId: string
  readonly rulebookId: string
}

function setup(): Setup {
  fixture = createRegistryFixture()
  const owner = provisionProvider(fixture.database, {
    name: 'Publication Provider',
    publicationAuthority: 'publication-provider',
  })
  const other = provisionProvider(fixture.database, {
    name: 'Other Provider',
    publicationAuthority: 'other-publication-provider',
  })
  const rulebook = fixture.registry.createRulebook(owner.actor, content())
  fixture.registry.createRulebookVersion(owner.actor, rulebook.id, { version: '1.0' })
  return {
    app: createApp({ registry: fixture.registry }),
    database: fixture.database,
    registry: fixture.registry,
    token: owner.token.secret,
    otherToken: other.token.secret,
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

async function errorJson(response: Response): Promise<ErrorEnvelope> {
  return json<ErrorEnvelope>(response)
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

async function publish(
  app: Hono,
  rulebookId: string,
  version: string,
  token: string | undefined,
): Promise<Response> {
  return post(app, `/api/v1/rulebooks/${rulebookId}/versions/${version}/publish`, token)
}

function exportPath(rulebookId: string, version: string): string {
  return `/api/v1/rulebooks/${rulebookId}/versions/${version}/export`
}

function manifestPath(rulebookId: string, version: string): string {
  return `${exportPath(rulebookId, version)}/manifest`
}

async function readManifest(
  app: Hono,
  rulebookId: string,
  version: string,
): Promise<PublicationExportManifestResource> {
  const response = await app.request(manifestPath(rulebookId, version))
  expect(response.status).toBe(200)
  const body = await json<{ data: PublicationExportManifestResource }>(response)
  assertSchema('PublicationExportManifestResponse', body)
  return body.data
}

async function readExport(app: Hono, rulebookId: string, version: string): Promise<Uint8Array> {
  const response = await app.request(exportPath(rulebookId, version))
  expect(response.status).toBe(200)
  return new Uint8Array(await response.arrayBuffer())
}

function auditCount(database: Database): number {
  return (
    database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM audit_log').get()?.count ??
    0
  )
}

interface AuditRow {
  readonly action: string
  readonly actor_provider_id: string | null
  readonly entity_id: string
  readonly detail_json: string
}

function publishAuditRows(database: Database): readonly AuditRow[] {
  return database
    .query<AuditRow, []>(
      "SELECT action, actor_provider_id, entity_id, detail_json FROM audit_log WHERE action = 'version.publish' ORDER BY id",
    )
    .all()
}

describe('publication export API', () => {
  test('exports the exact published bytes with integrity and download headers', async () => {
    const { app, token, rulebookId } = setup()
    const published = await publish(app, rulebookId, '1.0', token)
    expect(published.status).toBe(200)
    const version = (await json<{ data: RulebookVersionResource }>(published)).data

    const response = await app.request(exportPath(rulebookId, '1.0'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.attestbook.rulebook-version+json',
    )
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(sha256Hex(bytes)).toBe(version.contentDigest)

    const structuredDigest = `sha-256=:${Buffer.from(version.contentDigest, 'hex').toString('base64')}:`
    expect(response.headers.get('content-digest')).toBe(structuredDigest)
    expect(response.headers.get('etag')).toBe(`"${version.contentDigest}"`)
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="attestbook-publication-rulebook-1.0.json"',
    )

    // The export is the stored artifact byte-for-byte, not a re-serialization.
    const content = await app.request(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes)

    const manifest = await readManifest(app, rulebookId, '1.0')
    expect(manifest).toMatchObject({
      format: 'attestbook.publication-export@1',
      rulebookId,
      version: '1.0',
      status: 'published',
      name: 'Publication Rulebook',
      sourceUrl: 'https://issuer.example.org/rulebooks/publication',
      specVersion: 'ts11@1.0.1',
      mediaType: 'application/vnd.attestbook.rulebook-version+json',
      contentDigest: version.contentDigest,
      byteLength: bytes.byteLength,
      createdAt: version.createdAt,
      publishedAt: version.publishedAt,
      provenance: {},
      integrity: { algorithm: 'sha256', verified: true },
    })
    expect(manifest.signature.status).toBe('unsupported')
    expect(manifest.signature.reason).toContain('OWF')
    expect(manifest.limitations.length).toBeGreaterThan(0)
  })

  test('exports only a bounded provenance projection of an imported rulebook', async () => {
    const { app, token, registry } = setup()
    // The importer stores source-internal and untrusted fields in provenance;
    // the public manifest must expose only the stable projection.
    const imported = registry.createRulebook(registry.authenticateBearer(token), {
      ...content('Imported Rulebook'),
      provenance: {
        adapter: 'ts11',
        sourceUrl: 'https://catalog.example.org/entry',
        contentDigest: 'a'.repeat(64),
        retrievedAt: '2026-01-01T00:00:00.000Z',
        profile: 'ts11@1.0.1',
        conformance: 'partial',
        importedAt: '2026-01-01T00:00:01.000Z',
        sourceName: 'Private source label',
        requestedUrl: 'https://private.example.org/redirect-target',
        redirects: ['https://private.example.org/redirect-target'],
        envelope: { metadata: { private: 'value' } },
        entryIndex: 2,
      },
    })
    registry.createRulebookVersion(registry.authenticateBearer(token), imported.id, {
      version: '1.0',
    })
    expect((await publish(app, imported.id, '1.0', token)).status).toBe(200)

    const manifest = await readManifest(app, imported.id, '1.0')
    expect(manifest.provenance).toEqual({
      adapter: 'ts11',
      sourceUrl: 'https://catalog.example.org/entry',
      contentDigest: 'a'.repeat(64),
      retrievedAt: '2026-01-01T00:00:00.000Z',
      profile: 'ts11@1.0.1',
      conformance: 'partial',
      importedAt: '2026-01-01T00:00:01.000Z',
    })
    const serialized = JSON.stringify(manifest)
    for (const excluded of [
      'Private source label',
      'private.example.org',
      '"envelope"',
      '"requestedUrl"',
      '"redirects"',
      '"entryIndex"',
    ]) {
      expect(serialized).not.toContain(excluded)
    }
  })

  test('repeats the same export and manifest, and later draft edits do not change them', async () => {
    const { app, token, rulebookId } = setup()
    expect((await publish(app, rulebookId, '1.0', token)).status).toBe(200)

    const firstManifest = await readManifest(app, rulebookId, '1.0')
    const firstBytes = await readExport(app, rulebookId, '1.0')

    // Repeating the read is byte-for-byte and field-for-field identical.
    expect(await readManifest(app, rulebookId, '1.0')).toEqual(firstManifest)
    expect(await readExport(app, rulebookId, '1.0')).toEqual(firstBytes)

    // Creating the next version reopens the working copy; renaming it must not
    // change what the already-published 1.0 artifact exports as.
    const created = await post(app, `/api/v1/rulebooks/${rulebookId}/versions`, token, {
      version: '2.0',
    })
    expect(created.status).toBe(201)
    const updated = await app.request(`/api/v1/rulebooks/${rulebookId}/draft`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify(content('Renamed Working Copy')),
    })
    expect(updated.status).toBe(200)

    const laterManifest = await readManifest(app, rulebookId, '1.0')
    expect(laterManifest).toEqual(firstManifest)
    expect(laterManifest.name).toBe('Publication Rulebook')
    expect(await readExport(app, rulebookId, '1.0')).toEqual(firstBytes)
  })

  test('refuses to export draft versions', async () => {
    const { app, token, rulebookId } = setup()

    for (const path of [exportPath(rulebookId, '1.0'), manifestPath(rulebookId, '1.0')]) {
      const response = await app.request(path)
      expect(response.status).toBe(409)
      const body = await errorJson(response)
      expect(body.error.code).toBe('conflict')
      expect(body.error.message).toContain('draft')
    }

    // The same rule holds for a draft left after the rulebook was published.
    expect((await publish(app, rulebookId, '1.0', token)).status).toBe(200)
    const created = await post(app, `/api/v1/rulebooks/${rulebookId}/versions`, token, {
      version: '2.0',
    })
    expect(created.status).toBe(201)
    expect((await app.request(exportPath(rulebookId, '2.0'))).status).toBe(409)
    expect((await app.request(manifestPath(rulebookId, '2.0'))).status).toBe(409)

    // The published 1.0 artifact remains exportable.
    expect((await app.request(exportPath(rulebookId, '1.0'))).status).toBe(200)
  })

  test('answers not found for a missing version or rulebook', async () => {
    const { app, rulebookId } = setup()
    const missingVersion = await app.request(exportPath(rulebookId, '9.9'))
    expect(missingVersion.status).toBe(404)
    expect((await errorJson(missingVersion)).error.code).toBe('not_found')

    const missingRulebook = await app.request(exportPath('unknown-rulebook', '1.0'))
    expect(missingRulebook.status).toBe(404)

    const missingManifest = await app.request(manifestPath(rulebookId, '9.9'))
    expect(missingManifest.status).toBe(404)
    expect((await errorJson(missingManifest)).error.code).toBe('not_found')
  })
})

describe('publication authorization and audit', () => {
  test('only the owning provider publishes, and the publication is audited', async () => {
    const { app, token, otherToken, rulebookId, providerId, database } = setup()
    const before = auditCount(database)

    const anonymous = await publish(app, rulebookId, '1.0', undefined)
    expect(anonymous.status).toBe(401)
    const foreign = await publish(app, rulebookId, '1.0', otherToken)
    expect(foreign.status).toBe(403)
    expect((await errorJson(foreign)).error.code).toBe('forbidden')
    expect(auditCount(database)).toBe(before)

    const published = await publish(app, rulebookId, '1.0', token)
    expect(published.status).toBe(200)
    const version = (await json<{ data: RulebookVersionResource }>(published)).data

    const rows = publishAuditRows(database)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor_provider_id).toBe(providerId)
    expect(rows[0]?.entity_id).toBe(version.id)
    expect(JSON.parse(rows[0]?.detail_json ?? '{}')).toMatchObject({
      rulebookId,
      version: '1.0',
      contentDigest: version.contentDigest,
      specVersion: 'ts11@1.0.1',
      supersededVersions: [],
    })
  })

  test('superseding a publication keeps the historical artifact exportable and unchanged', async () => {
    const { app, token, rulebookId, database } = setup()
    expect((await publish(app, rulebookId, '1.0', token)).status).toBe(200)
    const firstManifest = await readManifest(app, rulebookId, '1.0')
    const firstBytes = await readExport(app, rulebookId, '1.0')

    const created = await post(app, `/api/v1/rulebooks/${rulebookId}/versions`, token, {
      version: '2.0',
    })
    expect(created.status).toBe(201)
    expect((await publish(app, rulebookId, '2.0', token)).status).toBe(200)

    // The superseded artifact is still retrievable, unchanged, and is now
    // reported as historical rather than published.
    const historicalManifest = await readManifest(app, rulebookId, '1.0')
    expect(historicalManifest.status).toBe('historical')
    expect(historicalManifest.publishedAt).toBe(firstManifest.publishedAt)
    expect(historicalManifest.contentDigest).toBe(firstManifest.contentDigest)
    expect(await readExport(app, rulebookId, '1.0')).toEqual(firstBytes)

    const currentManifest = await readManifest(app, rulebookId, '2.0')
    expect(currentManifest.status).toBe('published')

    const rows = publishAuditRows(database)
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[1]?.detail_json ?? '{}')).toMatchObject({
      version: '2.0',
      supersededVersions: ['1.0'],
    })
  })
})
