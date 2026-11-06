import { describe, expect, test } from 'bun:test'

import type { Rulebook, RulebookVersion, RulebookVersionContent } from '../registry/types'
import {
  buildRulebookVersionDocument,
  RULEBOOK_VERSION_MEDIA_TYPE,
  serializeRulebookVersion,
} from '../registry/versioning'

import { buildRulebookMappingIndex, mapConfiguration, type RulebookVersionSource } from './mapping'
import type { DiscoveredCredentialConfiguration, RulebookVersionCandidate } from './types'
import { PID_VCT } from './test/fixtures'

const VERSION_DIGEST = 'a'.repeat(64)

function rulebook(id: string, name: string, status: Rulebook['publicationStatus']): Rulebook {
  return {
    id,
    providerId: 'provider-1',
    name,
    description: `${name} description`,
    sourceUrl: null,
    importKey: null,
    provenance: {},
    applicableSpec: 'ts11@1.0.1',
    publicationStatus: status,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

interface VersionSpec {
  readonly rulebook: Rulebook
  readonly version: string
  readonly status: RulebookVersion['status']
  readonly publishedAt: string | null
  readonly formats: readonly string[]
  readonly references: readonly { formatIdentifier: string; uri: string }[]
}

function versionRecord(spec: VersionSpec): RulebookVersion {
  return {
    id: `${spec.rulebook.id}@${spec.version}`,
    rulebookId: spec.rulebook.id,
    version: spec.version,
    status: spec.status,
    contentDigest: VERSION_DIGEST,
    specVersion: 'ts11@1.0.1',
    provenance: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    publishedAt: spec.publishedAt,
  }
}

function versionContent(spec: VersionSpec): RulebookVersionContent {
  const document = buildRulebookVersionDocument({
    rulebook: spec.rulebook,
    version: spec.version,
    specVersion: 'ts11@1.0.1',
    attestations: [
      {
        id: `${spec.rulebook.id}-attestation`,
        rulebookId: spec.rulebook.id,
        name: 'attestation',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: spec.formats,
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    schemaReferences: spec.references.map((reference, index) => ({
      id: `${spec.rulebook.id}-reference-${index}`,
      rulebookId: spec.rulebook.id,
      attestationId: `${spec.rulebook.id}-attestation`,
      formatIdentifier: reference.formatIdentifier,
      uri: reference.uri,
      integrity: null,
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
  })
  return {
    version: versionRecord(spec),
    mediaType: RULEBOOK_VERSION_MEDIA_TYPE,
    bytes: serializeRulebookVersion(document),
  }
}

interface FakeRecord {
  readonly rulebook: Rulebook
  readonly spec: VersionSpec
  readonly bytes?: Uint8Array
}

function fakeSource(records: readonly FakeRecord[]): RulebookVersionSource {
  return {
    listRulebooks: () => records.map((record) => record.rulebook),
    listRulebookVersions: (rulebookId) =>
      records
        .filter((record) => record.rulebook.id === rulebookId)
        .map((record) => versionRecord(record.spec)),
    getRulebookVersionContent: (rulebookId, version) => {
      const record = records.find(
        (candidate) => candidate.rulebook.id === rulebookId && candidate.spec.version === version,
      )
      if (record === undefined) {
        return null
      }
      if (record.bytes !== undefined) {
        return {
          version: versionRecord(record.spec),
          mediaType: RULEBOOK_VERSION_MEDIA_TYPE,
          bytes: record.bytes,
        }
      }
      return versionContent(record.spec)
    },
  }
}

function configuration(
  overrides: Partial<DiscoveredCredentialConfiguration> = {},
): DiscoveredCredentialConfiguration {
  return {
    configurationId: 'pid',
    format: 'dc+sd-jwt',
    displayName: null,
    typeIdentifiers: [{ kind: 'vct', value: PID_VCT }],
    schemaReferences: [{ formatIdentifier: 'dc+sd-jwt', uri: PID_VCT, source: 'vct' }],
    ...overrides,
  }
}

describe('rulebook mapping index', () => {
  test('builds candidates only from immutable versions with their frozen identifiers', () => {
    const pid = rulebook('rulebook-pid', 'PID', 'published')
    const draft = rulebook('rulebook-draft', 'Draft', 'draft')
    const source = fakeSource([
      {
        rulebook: pid,
        spec: {
          rulebook: pid,
          version: '1.0',
          status: 'published',
          publishedAt: '2026-01-02T00:00:00.000Z',
          formats: ['dc+sd-jwt'],
          references: [{ formatIdentifier: 'dc+sd-jwt', uri: PID_VCT }],
        },
      },
      {
        rulebook: draft,
        spec: {
          rulebook: draft,
          version: '1.0',
          status: 'draft',
          publishedAt: null,
          formats: ['dc+sd-jwt'],
          references: [{ formatIdentifier: 'dc+sd-jwt', uri: PID_VCT }],
        },
      },
    ])

    const index = buildRulebookMappingIndex(source)
    expect(index.candidates).toHaveLength(1)
    expect(index.candidates[0]).toMatchObject({
      rulebookId: 'rulebook-pid',
      rulebookName: 'PID',
      version: '1.0',
      contentDigest: VERSION_DIGEST,
      status: 'published',
      formats: ['dc+sd-jwt'],
      typeIdentifiers: [{ formatIdentifier: 'dc+sd-jwt', value: PID_VCT }],
    })
    expect(index.diagnostics).toEqual([])
  })

  test('reports and skips a corrupt stored snapshot', () => {
    const pid = rulebook('rulebook-pid', 'PID', 'published')
    const source = fakeSource([
      {
        rulebook: pid,
        spec: {
          rulebook: pid,
          version: '1.0',
          status: 'published',
          publishedAt: '2026-01-02T00:00:00.000Z',
          formats: [],
          references: [],
        },
        bytes: new TextEncoder().encode('{not json'),
      },
    ])
    const index = buildRulebookMappingIndex(source)
    expect(index.candidates).toEqual([])
    expect(index.diagnostics[0]?.code).toBe('invalid_rulebook_version')
  })
})

describe('configuration association', () => {
  function indexFor(records: readonly FakeRecord[]): RulebookVersionCandidate[] {
    return [...buildRulebookMappingIndex(fakeSource(records)).candidates]
  }

  function record(
    rulebookId: string,
    name: string,
    version: string,
    status: RulebookVersion['status'],
    publishedAt: string,
    references: readonly { formatIdentifier: string; uri: string }[],
    formats: readonly string[] = ['dc+sd-jwt'],
  ): FakeRecord {
    const book = rulebook(rulebookId, name, status)
    return {
      rulebook: book,
      spec: { rulebook: book, version, status, publishedAt, formats, references },
    }
  }

  test('returns a single pinned version for an unambiguous match', () => {
    const index = {
      candidates: indexFor([
        record('rulebook-pid', 'PID', '1.0', 'published', '2026-01-02T00:00:00.000Z', [
          { formatIdentifier: 'dc+sd-jwt', uri: PID_VCT },
        ]),
      ]),
      diagnostics: [],
    }
    const mapping = mapConfiguration(configuration(), index)
    expect(mapping.status).toBe('matched')
    expect(mapping.candidates).toEqual([
      {
        rulebookId: 'rulebook-pid',
        rulebookName: 'PID',
        version: '1.0',
        contentDigest: VERSION_DIGEST,
        specVersion: 'ts11@1.0.1',
      },
    ])
  })

  test('prefers the current published version over a historical one of the same rulebook', () => {
    const index = {
      candidates: indexFor([
        record('rulebook-pid', 'PID', '1.0', 'historical', '2026-01-01T00:00:00.000Z', [
          { formatIdentifier: 'dc+sd-jwt', uri: PID_VCT },
        ]),
        record('rulebook-pid', 'PID', '2.0', 'published', '2026-02-01T00:00:00.000Z', [
          { formatIdentifier: 'dc+sd-jwt', uri: PID_VCT },
        ]),
      ]),
      diagnostics: [],
    }
    const mapping = mapConfiguration(configuration(), index)
    expect(mapping.status).toBe('matched')
    expect(mapping.candidates.map((pin) => pin.version)).toEqual(['2.0'])
  })

  test('reports ambiguous when two rulebooks match', () => {
    const index = {
      candidates: indexFor([
        record('rulebook-pid', 'PID', '1.0', 'published', '2026-01-02T00:00:00.000Z', [
          { formatIdentifier: 'dc+sd-jwt', uri: PID_VCT },
        ]),
        record('rulebook-other', 'Other PID', '1.0', 'published', '2026-01-03T00:00:00.000Z', [
          { formatIdentifier: 'dc+sd-jwt', uri: PID_VCT },
        ]),
      ]),
      diagnostics: [],
    }
    const mapping = mapConfiguration(configuration(), index)
    expect(mapping.status).toBe('ambiguous')
    expect(mapping.candidates.map((pin) => pin.rulebookName)).toEqual(['Other PID', 'PID'])
    expect(mapping.reason).toBeNull()
  })

  test('reports unmatched with a reason when no version matches', () => {
    const index = {
      candidates: indexFor([
        record('rulebook-pid', 'PID', '1.0', 'published', '2026-01-02T00:00:00.000Z', [
          { formatIdentifier: 'dc+sd-jwt', uri: 'https://issuer.example/credentials/other' },
        ]),
      ]),
      diagnostics: [],
    }
    const mapping = mapConfiguration(configuration(), index)
    expect(mapping.status).toBe('unmatched')
    expect(mapping.candidates).toEqual([])
    expect(mapping.reason).toContain('no published or historical rulebook version')
  })

  test('never associates with a draft-only version', () => {
    const draft = rulebook('rulebook-draft', 'Draft', 'draft')
    const index = {
      candidates: indexFor([
        {
          rulebook: draft,
          spec: {
            rulebook: draft,
            version: '1.0',
            status: 'draft',
            publishedAt: null,
            formats: ['dc+sd-jwt'],
            references: [{ formatIdentifier: 'dc+sd-jwt', uri: PID_VCT }],
          },
        },
      ]),
      diagnostics: [],
    }
    expect(mapConfiguration(configuration(), index).status).toBe('unmatched')
  })

  test('matches a verbatim vct identifier against its normalized schema reference', () => {
    const index = {
      candidates: indexFor([
        record('rulebook-pid', 'PID', '1.0', 'published', '2026-01-02T00:00:00.000Z', [
          { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.com/pid' },
        ]),
      ]),
      diagnostics: [],
    }
    const mapping = mapConfiguration(
      configuration({
        typeIdentifiers: [{ kind: 'vct', value: 'https://Example.com/pid' }],
        schemaReferences: [
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://example.com/pid',
            source: 'vct',
          },
        ],
      }),
      index,
    )
    expect(mapping.status).toBe('matched')
    expect(mapping.candidates[0]?.version).toBe('1.0')
  })

  test('does not match a type identifier recorded under a different format', () => {
    const index = {
      candidates: indexFor([
        record('rulebook-pid', 'PID', '1.0', 'published', '2026-01-02T00:00:00.000Z', [
          { formatIdentifier: 'ldp_vc', uri: PID_VCT },
        ]),
      ]),
      diagnostics: [],
    }
    expect(mapConfiguration(configuration(), index).status).toBe('unmatched')
  })
})
