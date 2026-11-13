import { describe, expect, test } from 'vitest'

import type { CatalogApi } from './api'
import { CatalogApiError } from './api'
import {
  attestationNameFor,
  describeReference,
  formatDigest,
  hostedIntegrityState,
  hostedSchemaDownloadName,
  loadRulebookDetail,
  referenceSource,
  referencesForAttestation,
  rulebookLevelReferences,
  versionsNewestFirst,
} from './detail'
import {
  createFakeApi,
  HOSTED_SCHEMA,
  makeAttestation,
  makeHostedSchema,
  makeRulebook,
  makeSchemaReference,
  makeVersion,
  PID_SCHEMA_REFERENCE,
  RULEBOOK_SCHEMA_REFERENCE,
  SAMPLE_DATASET,
} from './test/fixtures'

describe('loadRulebookDetail', () => {
  test('combines the rulebook, provider, attestations, references and versions', async () => {
    const snapshot = await loadRulebookDetail(createFakeApi(), 'rulebook-pid')

    expect(snapshot.rulebook.name).toBe('PID Rulebook')
    expect(snapshot.provider?.name).toBe('Example Issuer')
    expect(snapshot.attestations).toHaveLength(1)
    expect(snapshot.schemaReferences).toEqual([PID_SCHEMA_REFERENCE, RULEBOOK_SCHEMA_REFERENCE])
    expect(snapshot.versions.map((version) => version.version)).toEqual(['1.0', '1.1'])
    expect(snapshot.availability).toEqual({
      provider: true,
      attestations: true,
      schemaReferences: true,
      versions: true,
    })
  })

  test('propagates a missing rulebook instead of rendering an empty record', async () => {
    const api = createFakeApi()

    await expect(loadRulebookDetail(api, 'rulebook-missing')).rejects.toMatchObject({
      name: 'CatalogApiError',
      status: 404,
    })
  })

  test('keeps the rulebook when its related reads fail and marks each section', async () => {
    const api = createFakeApi()
    const failing: CatalogApi = {
      ...api,
      listProviders: () => Promise.reject(new Error('providers unavailable')),
      listAttestations: () => Promise.reject(new Error('attestations unavailable')),
      listSchemaReferences: () => Promise.reject(new Error('references unavailable')),
      listVersions: () => Promise.reject(new Error('versions unavailable')),
    }

    const snapshot = await loadRulebookDetail(failing, 'rulebook-pid')

    expect(snapshot.rulebook.id).toBe('rulebook-pid')
    expect(snapshot.provider).toBeNull()
    expect(snapshot.attestations).toEqual([])
    expect(snapshot.schemaReferences).toEqual([])
    expect(snapshot.versions).toEqual([])
    expect(snapshot.availability).toEqual({
      provider: false,
      attestations: false,
      schemaReferences: false,
      versions: false,
    })
  })

  test('keeps a provider that is absent from the provider list as unknown', async () => {
    const api = createFakeApi({
      ...SAMPLE_DATASET,
      providers: [{ id: 'provider-other', name: 'Other', createdAt: '2026-01-01T00:00:00.000Z' }],
    })

    const snapshot = await loadRulebookDetail(api, 'rulebook-pid')

    expect(snapshot.availability.provider).toBe(true)
    expect(snapshot.provider).toBeNull()
  })

  test('turns a malformed response into a detail error, not a 404', async () => {
    const api: CatalogApi = {
      ...createFakeApi(),
      getRulebook: () => Promise.reject(new CatalogApiError('The catalog returned bad JSON.', 0)),
    }

    await expect(loadRulebookDetail(api, 'rulebook-pid')).rejects.toBeInstanceOf(CatalogApiError)
  })
})

describe('detail helpers', () => {
  test('orders version history newest first without mutating the input', () => {
    const versions = [
      makeVersion({ id: 'old', createdAt: '2026-02-01T10:00:00.000Z' }),
      makeVersion({ id: 'new', createdAt: '2026-03-01T10:00:00.000Z' }),
    ]

    expect(versionsNewestFirst(versions).map((version) => version.id)).toEqual(['new', 'old'])
    expect(versions.map((version) => version.id)).toEqual(['old', 'new'])
  })

  test('selects references by attestation and rulebook level', () => {
    const references = [PID_SCHEMA_REFERENCE, RULEBOOK_SCHEMA_REFERENCE]

    expect(referencesForAttestation(references, 'attestation-pid')).toEqual([PID_SCHEMA_REFERENCE])
    expect(rulebookLevelReferences(references)).toEqual([RULEBOOK_SCHEMA_REFERENCE])
  })

  test('labels an unknown attestation type explicitly', () => {
    expect(attestationNameFor([makeAttestation()], 'attestation-pid')).toBe(
      'Person Identification Data',
    )
    expect(attestationNameFor([], null)).toBe('Rulebook-level')
    expect(attestationNameFor([], 'missing')).toBe('Unknown type')
  })

  test('links only absolute http(s) reference URIs', () => {
    expect(describeReference('https://issuer.example.org/schemas/pid')).toEqual({
      href: 'https://issuer.example.org/schemas/pid',
      label: 'https://issuer.example.org/schemas/pid',
    })
    expect(describeReference('javascript:alert(1)')).toEqual({
      href: null,
      label: 'javascript:alert(1)',
    })
    expect(describeReference('not a url')).toEqual({ href: null, label: 'not a url' })
  })

  test('shortens a digest while keeping the full value available to the caller', () => {
    expect(formatDigest('a'.repeat(64))).toBe(`${'a'.repeat(16)}…`)
    expect(formatDigest('short')).toBe('short')
  })

  test('derives reference provenance from the stored-document association', () => {
    const hosted = makeSchemaReference({ hostedSchema: HOSTED_SCHEMA })
    const external = makeSchemaReference({ hostedSchema: null })

    expect(referenceSource(hosted)).toBe('hosted')
    expect(referenceSource(external)).toBe('external')
    expect(hostedSchemaDownloadName(HOSTED_SCHEMA)).toBe('attestbook-json-schema-document-pid.json')
    expect(hostedSchemaDownloadName(makeHostedSchema({ kind: 'sd_jwt_vc_type_metadata' }))).toBe(
      'attestbook-type-metadata-document-pid.json',
    )
  })

  test('checks the persisted SRI pin against the stored document digest', () => {
    expect(
      hostedIntegrityState(
        makeSchemaReference({ integrity: HOSTED_SCHEMA.integrity, hostedSchema: HOSTED_SCHEMA }),
      ),
    ).toBe('matches')
    expect(
      hostedIntegrityState(makeSchemaReference({ integrity: null, hostedSchema: HOSTED_SCHEMA })),
    ).toBe('missing')
    expect(
      hostedIntegrityState(
        makeSchemaReference({ integrity: 'sha256-diZmVyZQ', hostedSchema: HOSTED_SCHEMA }),
      ),
    ).toBe('mismatch')
    expect(hostedIntegrityState(makeSchemaReference({ hostedSchema: null }))).toBe('not_hosted')
  })

  test('builds a detail snapshot for a rulebook with no versions', async () => {
    const snapshot = await loadRulebookDetail(createFakeApi(), 'rulebook-age')

    expect(snapshot.rulebook.publicationStatus).toBe('draft')
    expect(snapshot.versions).toEqual([])
  })

  test('accepts a locally authored rulebook with no source URL', async () => {
    const snapshot = await loadRulebookDetail(
      createFakeApi({
        ...SAMPLE_DATASET,
        rulebooks: [makeRulebook({ id: 'local', sourceUrl: null })],
        attestations: {},
        schemaReferences: {},
        versions: {},
      }),
      'local',
    )

    expect(snapshot.rulebook.sourceUrl).toBeNull()
  })
})
