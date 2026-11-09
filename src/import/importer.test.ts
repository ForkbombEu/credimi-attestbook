import { afterEach, describe, expect, test } from 'bun:test'

import { sha256Hex } from '../registry/digest'
import { RegistryError } from '../registry/errors'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { RulebookImporter } from './importer'
import { ImportError } from './errors'
import { DEFAULT_IMPORT_LIMITS } from './limits'
import {
  createFakeTransport,
  IMPORT_URL,
  invalidTs11Document,
  jsonBytes,
  owfDocument,
  publicResolver,
  ts11Document,
  ts11WithSchemaReferences,
  validTs11Document,
  type FakeTransport,
} from './test/fixtures'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

const limits = { ...DEFAULT_IMPORT_LIMITS, maxSourceBytes: 200_000 }
const encoder = new TextEncoder()
const importedAt = '2026-11-05T10:05:00.000Z'

function setup(transport: FakeTransport['transport']) {
  fixture = createRegistryFixture()
  const { provider, token } = provisionProvider(fixture.database, {
    name: 'Import Provider',
    publicationAuthority: 'account-import',
  })
  const importer = new RulebookImporter({
    registry: fixture.registry,
    transport,
    resolveHostname: publicResolver,
    limits,
    now: () => importedAt,
  })
  return { fixture, provider, token, importer }
}

describe('authenticated rulebook import', () => {
  test('persists a URL-imported TS11 rulebook with source URL, digest and schema references', async () => {
    const document = jsonBytes(validTs11Document)
    const fake = createFakeTransport({
      [IMPORT_URL]: { body: document },
    })
    const { fixture, provider, token, importer } = setup(fake.transport)

    const result = await importer.import(token.secret, { kind: 'url', url: IMPORT_URL })

    expect(result.rulebooks).toHaveLength(1)
    const rulebook = result.rulebooks[0]
    if (rulebook === undefined) {
      throw new Error('expected a rulebook')
    }

    expect(rulebook.name).toBe('Imported rulebook 0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(rulebook.sourceUrl).toBe(IMPORT_URL)
    expect(rulebook.applicableSpec).toBe('ts11@1.0.1')
    expect(rulebook.provenance).toMatchObject({
      adapter: 'url',
      sourceUrl: IMPORT_URL,
      retrievedAt: importedAt,
      contentType: 'application/json',
      contentDigest: sha256Hex(encoder.encode(document)),
      profile: 'ts11@1.0.1',
      conformance: 'conformant_subset',
      importedAt,
    })

    const attestations = fixture.registry.listAttestations(rulebook.id)
    expect(attestations).toHaveLength(1)
    expect(attestations[0]).toMatchObject({
      name: rulebook.name,
      attestationLoS: 'iso_18045_basic',
      bindingType: 'key',
      supportedFormats: ['dc+sd-jwt'],
    })

    const references = fixture.registry.listSchemaReferences(rulebook.id)
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({
      attestationId: attestations[0]?.id,
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.com/schemas/gym-membership.json',
    })
    expect(references[0]?.integrity).toMatch(/^sha256-/)

    // The written rulebook is a draft owned by the authenticated provider.
    expect(rulebook.providerId).toBe(provider.id)
    expect(fixture.registry.listRulebooks({ providerId: rulebook.providerId })).toHaveLength(1)
  })

  test('persists a JSON-imported OWF rulebook with its meta and no source URL', async () => {
    const { fixture, token, importer } = setup(createFakeTransport({}).transport)

    const result = await importer.import(token.secret, {
      kind: 'json',
      content: jsonBytes(owfDocument),
      name: 'owf-schema.json',
      sourceUrl: 'https://catalog.example.test/owf.json',
    })

    const rulebook = result.rulebooks[0]
    if (rulebook === undefined) {
      throw new Error('expected a rulebook')
    }

    expect(rulebook.sourceUrl).toBe('https://catalog.example.test/owf.json')
    expect(rulebook.provenance).toMatchObject({
      adapter: 'json',
      sourceName: 'owf-schema.json',
      sourceUrl: 'https://catalog.example.test/owf.json',
      profile: 'owf@0.5.4',
      conformance: 'partial',
    })

    const references = fixture.registry.listSchemaReferences(rulebook.id)
    expect(references[0]?.metadata).toEqual({ meta: { vct: 'eu.example.gym.1' } })
  })

  test('imports every entry of a catalog envelope', async () => {
    const fake = createFakeTransport({
      [IMPORT_URL]: {
        body: jsonBytes({ data: [validTs11Document, owfDocument] }),
      },
    })
    const { fixture, token, importer } = setup(fake.transport)

    const result = await importer.import(token.secret, { kind: 'url', url: IMPORT_URL })

    expect(result.rulebooks).toHaveLength(2)
    expect(fixture.registry.listRulebooks()).toHaveLength(2)
    expect(result.preview.source.envelope).toMatchObject({ kind: 'catalog', member: 'data' })
  })

  test('refuses the whole catalog when one entry is structurally invalid', async () => {
    const fake = createFakeTransport({
      [IMPORT_URL]: {
        body: jsonBytes({ data: [validTs11Document, invalidTs11Document] }),
      },
    })
    const { fixture, token, importer } = setup(fake.transport)

    let caught: unknown
    try {
      await importer.import(token.secret, { kind: 'url', url: IMPORT_URL })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ImportError)
    expect((caught as ImportError).code).toBe('import_rejected')
    expect(fixture.registry.listRulebooks()).toHaveLength(0)
  })

  test('refuses a catalog with an entry the registry would reject, writing nothing', async () => {
    const duplicateReferences = ts11WithSchemaReferences([
      { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.com/a.json' },
      { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.com/b.json' },
    ])
    const fake = createFakeTransport({
      [IMPORT_URL]: {
        body: jsonBytes({ data: [validTs11Document, duplicateReferences] }),
      },
    })
    const { fixture, token, importer } = setup(fake.transport)

    let caught: unknown
    try {
      await importer.import(token.secret, { kind: 'url', url: IMPORT_URL })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ImportError)
    expect((caught as ImportError).code).toBe('import_rejected')
    expect(fixture.registry.listRulebooks()).toHaveLength(0)
  })

  test('authenticates before any network request', async () => {
    const fake = createFakeTransport({
      [IMPORT_URL]: { body: jsonBytes(validTs11Document) },
    })
    const { fixture, importer } = setup(fake.transport)

    let caught: unknown
    try {
      await importer.import('not-a-token', { kind: 'url', url: IMPORT_URL })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RegistryError)
    expect(fake.requests).toHaveLength(0)
    expect(fixture.registry.listRulebooks()).toHaveLength(0)
  })

  test('audits every created draft with the provider and never the source bytes', async () => {
    const marker = 'source-marker-5f2b9c'
    const source = ts11Document({ description: marker })
    const fake = createFakeTransport({
      [IMPORT_URL]: { body: jsonBytes({ data: [source, owfDocument] }) },
    })
    const { fixture, provider, token, importer } = setup(fake.transport)

    const result = await importer.import(token.secret, { kind: 'url', url: IMPORT_URL })
    expect(result.rulebooks).toHaveLength(2)

    const rows = fixture.database
      .query<{
        action: string
        actor_provider_id: string | null
        detail_json: string
      }>('SELECT action, actor_provider_id, detail_json FROM audit_log ORDER BY id')
      .all()

    const creates = rows.filter((row) => row.action === 'rulebook.create')
    expect(creates).toHaveLength(2)
    expect(creates.map((row) => row.actor_provider_id)).toEqual([provider.id, provider.id])
    const actions = rows.map((row) => row.action)
    expect(actions).toContain('rulebook.create')
    expect(actions).toContain('attestation.create')
    expect(actions).toContain('schema_ref.create')
    // The source description is content, not audit evidence: no audit detail
    // may copy source bytes or document members into the trail.
    expect(rows.map((row) => row.detail_json).join('\n')).not.toContain(marker)
  })
})
