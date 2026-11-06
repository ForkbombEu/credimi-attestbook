import { describe, expect, test } from 'vitest'

import type { CatalogApi } from './api'
import {
  buildCatalogEntry,
  describeSource,
  EMPTY_FILTERS,
  filterEntries,
  formatDate,
  loadCatalog,
  matchesQuery,
  providerOptions,
  selectLatestVersion,
} from './catalog'
import {
  createFakeApi,
  makeAttestation,
  makeRulebook,
  makeVersion,
  PROVIDERS,
  SAMPLE_DATASET,
} from './test/fixtures'

describe('selectLatestVersion', () => {
  test('prefers the most recently created published version', () => {
    const published = makeVersion()
    const drafted = makeVersion({
      id: 'version-1-1',
      version: '1.1',
      status: 'draft',
      createdAt: '2026-04-01T10:00:00.000Z',
      publishedAt: null,
    })
    const olderPublished = makeVersion({
      id: 'version-0-9',
      version: '0.9',
      status: 'historical',
      createdAt: '2026-01-01T10:00:00.000Z',
      publishedAt: '2026-01-02T10:00:00.000Z',
    })

    expect(selectLatestVersion([published, drafted, olderPublished])?.version).toBe('1.0')
  })

  test('falls back to the newest version when nothing is published', () => {
    const draft = makeVersion({
      version: '0.2',
      status: 'draft',
      createdAt: '2026-05-01T10:00:00.000Z',
      publishedAt: null,
    })
    expect(selectLatestVersion([draft])?.version).toBe('0.2')
  })

  test('returns null when a rulebook has no versions', () => {
    expect(selectLatestVersion([])).toBeNull()
  })
})

describe('buildCatalogEntry', () => {
  test('projects the public fields the catalog displays', () => {
    const entry = buildCatalogEntry(
      makeRulebook(),
      PROVIDERS[0],
      [makeAttestation()],
      [makeVersion()],
    )

    expect(entry).toMatchObject({
      id: 'rulebook-pid',
      name: 'PID Rulebook',
      providerName: 'Example Issuer',
      providerKnown: true,
      publicationStatus: 'published',
      version: '1.0',
      versionStatus: 'published',
      versionCount: 1,
      sourceUrl: 'https://issuer.example.org/rulebooks/pid',
    })
    expect(entry.attestations).toHaveLength(1)
    expect(entry.supportedFormats).toEqual(['dc+sd-jwt', 'mso_mdoc'])
  })

  test('falls back to the provider id and deduplicates formats', () => {
    const entry = buildCatalogEntry(
      makeRulebook(),
      undefined,
      [makeAttestation(), makeAttestation({ id: 'second', supportedFormats: ['mso_mdoc'] })],
      [],
    )

    expect(entry.providerKnown).toBe(false)
    expect(entry.providerName).toBe('provider-issuer')
    expect(entry.supportedFormats).toEqual(['dc+sd-jwt', 'mso_mdoc'])
  })
})

describe('search and filters', () => {
  const entries = SAMPLE_DATASET.rulebooks.map((rulebook, index) =>
    buildCatalogEntry(
      rulebook,
      SAMPLE_DATASET.providers.find((provider) => provider.id === rulebook.providerId),
      SAMPLE_DATASET.attestations[rulebook.id] ?? [],
      SAMPLE_DATASET.versions[rulebook.id] ?? [],
      index === 99,
    ),
  )

  test('matches search terms across names, providers and attestation fields', () => {
    expect(matchesQuery(entries[0]!, 'pid')).toBe(true)
    expect(matchesQuery(entries[0]!, 'example issuer')).toBe(true)
    expect(matchesQuery(entries[0]!, 'person identification')).toBe(true)
    expect(matchesQuery(entries[0]!, 'mso_mdoc')).toBe(true)
    expect(matchesQuery(entries[0]!, 'proof of age')).toBe(false)
  })

  test('requires every search term to match', () => {
    expect(matchesQuery(entries[0]!, 'pid issuer')).toBe(true)
    expect(matchesQuery(entries[0]!, 'pid wallet')).toBe(false)
  })

  test('filters by provider and publication status', () => {
    expect(
      filterEntries(entries, { ...EMPTY_FILTERS, providerId: 'provider-lab' }).map(
        (entry) => entry.id,
      ),
    ).toEqual(['rulebook-age'])
    expect(
      filterEntries(entries, { ...EMPTY_FILTERS, status: 'published' }).map((entry) => entry.id),
    ).toEqual(['rulebook-pid'])
    expect(filterEntries(entries, { ...EMPTY_FILTERS, query: 'age' })).toHaveLength(1)
    expect(filterEntries(entries, { ...EMPTY_FILTERS, query: 'missing' })).toHaveLength(0)
  })

  test('orders provider filter options by display name', () => {
    expect(providerOptions(entries).map((provider) => provider.name)).toEqual([
      'Example Issuer',
      'Wallet Lab',
    ])
  })
})

describe('display helpers', () => {
  test('formats timestamps in UTC and labels missing sources', () => {
    expect(formatDate('2026-11-05T09:47:21.000Z')).toBe('05 Nov 2026')
    expect(formatDate('not-a-date')).toBe('not-a-date')
    expect(describeSource(null)).toEqual({ href: null, label: 'Locally authored' })
    expect(describeSource('https://issuer.example.org/rulebooks/pid')).toEqual({
      href: 'https://issuer.example.org/rulebooks/pid',
      label: 'issuer.example.org',
    })
    expect(describeSource('javascript:alert(1)')).toEqual({
      href: null,
      label: 'javascript:alert(1)',
    })
  })
})

describe('loadCatalog', () => {
  test('combines providers, rulebooks, attestations and versions', async () => {
    const snapshot = await loadCatalog(createFakeApi())

    expect(snapshot.total).toBe(2)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.entries.map((entry) => entry.providerName)).toEqual([
      'Example Issuer',
      'Wallet Lab',
    ])
    expect(snapshot.entries[0]?.version).toBe('1.0')
    expect(snapshot.entries[1]?.version).toBeNull()
  })

  test('keeps a row when its detail requests fail and marks it incomplete', async () => {
    const api = createFakeApi()
    const failing: CatalogApi = {
      ...api,
      listAttestations: () => Promise.reject(new Error('detail unavailable')),
    }

    const snapshot = await loadCatalog(failing)

    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries.every((entry) => entry.detailsUnavailable)).toBe(true)
    expect(snapshot.entries.every((entry) => entry.attestations.length === 0)).toBe(true)
  })

  test('reports a truncated catalogue when the API page is smaller than the total', async () => {
    const api = createFakeApi()
    const truncated: CatalogApi = {
      ...api,
      listRulebooks: () =>
        Promise.resolve({
          data: SAMPLE_DATASET.rulebooks.slice(0, 1),
          pagination: { limit: 100, offset: 0, total: 2 },
        }),
    }

    const snapshot = await loadCatalog(truncated)

    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.total).toBe(2)
    expect(snapshot.truncated).toBe(true)
  })
})
