import { afterEach, describe, expect, test } from 'bun:test'

import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import type { Registry } from '../registry/registry'
import { ImportError } from './errors'
import { importContentFingerprint, storedImportContent } from './identity'
import { RulebookImporter } from './importer'
import { DEFAULT_IMPORT_LIMITS } from './limits'
import {
  createFakeTransport,
  IMPORT_URL,
  jsonBytes,
  publicResolver,
  ts11Document,
  validTs11Document,
} from './test/fixtures'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

const limits = { ...DEFAULT_IMPORT_LIMITS, maxSourceBytes: 200_000 }
const importedAt = '2026-11-05T10:05:00.000Z'

interface ImportContext {
  readonly fixture: RegistryFixture
  readonly registry: Registry
  readonly token: string
}

let tokenCounter = 0

function setup(): ImportContext {
  fixture = createRegistryFixture()
  const { token } = provisionProvider(fixture.database, {
    name: 'Re-import Provider',
    publicationAuthority: `account-reimport-${tokenCounter++}`,
  })
  return { fixture, registry: fixture.registry, token: token.secret }
}

function importerFor(context: ImportContext, body: string): RulebookImporter {
  const fake = createFakeTransport({ [IMPORT_URL]: { body } })
  return new RulebookImporter({
    registry: context.registry,
    transport: fake.transport,
    resolveHostname: publicResolver,
    limits,
    now: () => importedAt,
  })
}

async function importBody(context: ImportContext, body: string) {
  return importerFor(context, body).import(context.token, { kind: 'url', url: IMPORT_URL })
}

/** A second valid TS11 document with its own id, so entries are independent. */
const secondDocument = ts11Document({
  id: '1f8fad5b-d9cb-469f-a165-70867728950f',
  version: '2.0.0',
  rulebookURI: 'https://example.com/rulebooks/second/2.0.0.md',
})

/**
 * A TS11 document the preview accepts, but whose whitespace the registry trims
 * before storing. The fingerprint must be computed from the stored form.
 */
function paddedFormatDocument(): Record<string, unknown> {
  const references = (validTs11Document as { schemaURIs: Record<string, unknown>[] }).schemaURIs
  return {
    ...validTs11Document,
    supportedFormats: ['dc+sd-jwt '],
    schemaURIs: [{ ...(references[0] ?? {}), formatIdentifier: 'dc+sd-jwt ' }],
  }
}

/** A TS11 document whose schema URL host is upper-case in the source text. */
function upperCaseHostDocument(): Record<string, unknown> {
  const reference = (validTs11Document as { schemaURIs: Record<string, unknown>[] }).schemaURIs[0]
  const uri = typeof reference?.['uri'] === 'string' ? reference['uri'] : ''
  return {
    ...validTs11Document,
    schemaURIs: [{ ...(reference ?? {}), uri: uri.replace('example.com', 'EXAMPLE.com') }],
  }
}

describe('idempotent re-import', () => {
  test('re-importing unchanged bytes creates no duplicate and writes nothing', async () => {
    const context = setup()
    const body = jsonBytes(validTs11Document)

    const first = await importBody(context, body)
    const rulebook = first.rulebooks[0]
    expect(rulebook).toBeDefined()
    if (rulebook === undefined) {
      throw new Error('expected the first import to create a rulebook')
    }

    const second = await importBody(context, body)

    expect(second.rulebooks).toHaveLength(0)
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0]).toMatchObject({
      disposition: 'unchanged',
      rulebookId: rulebook.id,
      sourceId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      sourceVersion: '1.0.0',
    })
    expect(second.conflicts).toEqual([])
    expect(second.diagnostics).toEqual([])
    expect(context.registry.listRulebooks()).toHaveLength(1)

    const stored = context.registry.getRulebook(rulebook.id)
    expect(stored).not.toBeNull()
    // No write at all: provenance and the update timestamp are unchanged.
    expect(stored?.provenance).toEqual(rulebook.provenance)
    expect(stored?.updatedAt).toBe(rulebook.updatedAt)
  })

  test('fingerprints the registry-normalized content and re-imports it idempotently', async () => {
    const context = setup()
    const body = jsonBytes(paddedFormatDocument())

    const first = await importBody(context, body)
    const rulebook = first.rulebooks[0]
    if (rulebook === undefined) {
      throw new Error('expected the first import to create a rulebook')
    }
    const storedFingerprint = importContentFingerprint(
      storedImportContent(
        rulebook,
        context.registry.listAttestations(rulebook.id),
        context.registry.listSchemaReferences(rulebook.id),
      ),
    )
    expect(rulebook.provenance.contentFingerprint).toBe(storedFingerprint)

    const second = await importBody(context, body)
    expect(second.entries[0]).toMatchObject({
      disposition: 'unchanged',
      rulebookId: rulebook.id,
    })
    expect(second.conflicts).toEqual([])
    expect(context.registry.listRulebooks()).toHaveLength(1)
  })

  test('treats a URL the registry normalizes as unchanged', async () => {
    const context = setup()
    const body = jsonBytes(upperCaseHostDocument())

    await importBody(context, body)
    const second = await importBody(context, body)

    expect(second.entries[0]?.disposition).toBe('unchanged')
    expect(second.conflicts).toEqual([])
    expect(context.registry.listRulebooks()).toHaveLength(1)
  })

  test('reports a serialization-only source change without writing', async () => {
    const context = setup()
    await importBody(context, jsonBytes(validTs11Document))

    const pretty = JSON.stringify(validTs11Document, null, 2)
    const second = await importBody(context, pretty)

    expect(second.entries[0]?.disposition).toBe('unchanged')
    expect(second.rulebooks).toHaveLength(0)
    expect(second.conflicts).toEqual([])
    expect(second.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'serialization_only_change',
    )
    expect(context.registry.listRulebooks()).toHaveLength(1)
  })

  test('keeps the same rulebook for a JSON import with a source URL', async () => {
    const context = setup()
    const sourceUrl = 'https://catalog.example.test/json-source.json'
    const importer = importerFor(context, jsonBytes(validTs11Document))
    const source = { kind: 'json' as const, content: jsonBytes(validTs11Document), sourceUrl }

    const first = await importer.import(context.token, source)
    const second = await importer.import(context.token, source)

    expect(first.rulebooks).toHaveLength(1)
    expect(second.rulebooks).toHaveLength(0)
    expect(second.entries[0]?.rulebookId).toBe(first.rulebooks[0]?.id)
    expect(second.entries[0]?.disposition).toBe('unchanged')
    expect(context.registry.listRulebooks()).toHaveLength(1)
  })

  test('scopes import identity to the importing provider', async () => {
    const context = setup()
    const other = provisionProvider(context.fixture.database, {
      name: 'Another Provider',
      publicationAuthority: 'account-reimport-other',
    }).token.secret
    const body = jsonBytes(validTs11Document)

    const first = await importBody(context, body)
    const otherFirst = await importerFor(context, body).import(other, {
      kind: 'url',
      url: IMPORT_URL,
    })
    expect(first.rulebooks).toHaveLength(1)
    expect(otherFirst.rulebooks).toHaveLength(1)
    expect(otherFirst.rulebooks[0]?.id).not.toBe(first.rulebooks[0]?.id)
    expect(context.registry.listRulebooks()).toHaveLength(2)

    const reimport = await importBody(context, body)
    expect(reimport.entries[0]?.disposition).toBe('unchanged')
    expect(reimport.entries[0]?.rulebookId).toBe(first.rulebooks[0]?.id)
    expect(context.registry.listRulebooks()).toHaveLength(2)
  })
})

describe('duplicate import identities', () => {
  test('rejects a catalog whose entries share an import identity before writing', async () => {
    const context = setup()
    const body = jsonBytes({
      data: [validTs11Document, ts11Document({ bindingType: 'claim' })],
    })

    let caught: unknown
    try {
      await importBody(context, body)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ImportError)
    expect((caught as ImportError).code).toBe('import_rejected')
    expect((caught as ImportError).message).toContain('entries 0 and 1')
    expect(context.registry.listRulebooks()).toHaveLength(0)
  })
})

describe('re-import conflict detection', () => {
  test('reports changed source content and preserves the imported draft', async () => {
    const context = setup()
    const first = await importBody(context, jsonBytes(validTs11Document))
    const rulebook = first.rulebooks[0]
    if (rulebook === undefined) {
      throw new Error('expected the first import to create a rulebook')
    }

    const changed = ts11Document({ bindingType: 'claim' })
    const second = await importBody(context, jsonBytes(changed))

    expect(second.rulebooks).toHaveLength(0)
    expect(second.entries[0]).toMatchObject({
      disposition: 'conflict',
      rulebookId: rulebook.id,
      conflict: {
        code: 'source_changed',
        locallyModified: false,
        publishedVersions: [],
        existingSourceVersion: '1.0.0',
        incomingSourceVersion: '1.0.0',
      },
    })
    expect(second.conflicts).toHaveLength(1)
    expect(second.conflicts[0]?.existingContentFingerprint).not.toBe(
      second.conflicts[0]?.incomingContentFingerprint,
    )
    expect(context.registry.listRulebooks()).toHaveLength(1)
    // The draft still holds the originally imported content.
    expect(context.registry.listAttestations(rulebook.id)[0]?.bindingType).toBe('key')
  })

  test('never overwrites a locally edited draft', async () => {
    const context = setup()
    const first = await importBody(context, jsonBytes(validTs11Document))
    const rulebook = first.rulebooks[0]
    if (rulebook === undefined) {
      throw new Error('expected the first import to create a rulebook')
    }
    context.registry.updateRulebook(context.token, rulebook.id, { name: 'Locally edited name' })

    const second = await importBody(context, jsonBytes(ts11Document({ bindingType: 'claim' })))

    expect(second.entries[0]).toMatchObject({
      disposition: 'conflict',
      conflict: { code: 'locally_modified', locallyModified: true },
    })
    expect(context.registry.getRulebook(rulebook.id)?.name).toBe('Locally edited name')
    expect(context.registry.listAttestations(rulebook.id)[0]?.bindingType).toBe('key')
  })

  test('never overwrites a rulebook with a published version', async () => {
    const context = setup()
    const first = await importBody(context, jsonBytes(validTs11Document))
    const rulebook = first.rulebooks[0]
    if (rulebook === undefined) {
      throw new Error('expected the first import to create a rulebook')
    }
    context.registry.createRulebookVersion(context.token, rulebook.id, { version: '1.0.0' })
    context.registry.publishRulebookVersion(context.token, rulebook.id, '1.0.0')

    const second = await importBody(context, jsonBytes(ts11Document({ bindingType: 'claim' })))

    expect(second.entries[0]).toMatchObject({
      disposition: 'conflict',
      conflict: { code: 'published_content', publishedVersions: ['1.0.0'] },
    })
    expect(second.rulebooks).toHaveLength(0)
    expect(context.registry.getRulebookVersion(rulebook.id, '1.0.0')?.status).toBe('published')
    expect(context.registry.getRulebook(rulebook.id)?.publicationStatus).toBe('published')
    expect(context.registry.listAttestations(rulebook.id)[0]?.bindingType).toBe('key')
  })

  test('reports a source version change when the normalized content is identical', async () => {
    const context = setup()
    await importBody(context, jsonBytes(validTs11Document))

    const bumped = ts11Document({ version: '1.0.1' })
    const second = await importBody(context, jsonBytes(bumped))

    expect(second.entries[0]).toMatchObject({
      disposition: 'conflict',
      conflict: {
        code: 'source_version_changed',
        existingSourceVersion: '1.0.0',
        incomingSourceVersion: '1.0.1',
      },
    })
    expect(second.rulebooks).toHaveLength(0)
    expect(context.registry.listRulebooks()).toHaveLength(1)
  })

  test('creates a new entry of a grown catalog while unchanged siblings stay idempotent', async () => {
    const context = setup()
    await importBody(context, jsonBytes({ data: [validTs11Document] }))

    const second = await importBody(
      context,
      jsonBytes({ data: [validTs11Document, secondDocument] }),
    )

    expect(second.entries.map((entry) => entry.disposition)).toEqual(['unchanged', 'created'])
    expect(second.rulebooks).toHaveLength(1)
    expect(second.rulebooks[0]?.name).toBe('Imported rulebook 1f8fad5b-d9cb-469f-a165-70867728950f')
    expect(context.registry.listRulebooks()).toHaveLength(2)
  })

  test('reports a changed sibling conflict and still creates new entries', async () => {
    const context = setup()
    const first = await importBody(context, jsonBytes({ data: [validTs11Document] }))
    const existing = first.rulebooks[0]
    if (existing === undefined) {
      throw new Error('expected the first import to create a rulebook')
    }

    const second = await importBody(
      context,
      jsonBytes({
        data: [ts11Document({ bindingType: 'claim' }), secondDocument],
      }),
    )

    expect(second.entries.map((entry) => entry.disposition)).toEqual(['conflict', 'created'])
    expect(second.conflicts).toHaveLength(1)
    expect(second.conflicts[0]?.rulebookId).toBe(existing.id)
    expect(second.rulebooks).toHaveLength(1)
    expect(context.registry.listRulebooks()).toHaveLength(2)
  })
})
