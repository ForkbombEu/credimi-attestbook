// Shared fixtures for the catalog unit and component tests.

import type { CatalogApi } from '../api'
import type { Attestation, Provider, Rulebook, RulebookVersion } from '../types'

export const PROVIDERS: readonly Provider[] = [
  { id: 'provider-issuer', name: 'Example Issuer', createdAt: '2026-01-02T10:00:00.000Z' },
  { id: 'provider-lab', name: 'Wallet Lab', createdAt: '2026-01-03T10:00:00.000Z' },
]

export function makeRulebook(overrides: Partial<Rulebook> = {}): Rulebook {
  return {
    id: 'rulebook-pid',
    providerId: 'provider-issuer',
    name: 'PID Rulebook',
    description: 'Person identification data rulebook used by the example issuer.',
    sourceUrl: 'https://issuer.example.org/rulebooks/pid',
    applicableSpec: 'ts11@1.0.1',
    publicationStatus: 'published',
    createdAt: '2026-02-01T10:00:00.000Z',
    updatedAt: '2026-03-04T10:00:00.000Z',
    ...overrides,
  }
}

export function makeAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'attestation-pid',
    rulebookId: 'rulebook-pid',
    name: 'Person Identification Data',
    attestationLoS: 'iso_18045_high',
    bindingType: 'cryptographic',
    supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
    createdAt: '2026-02-01T10:00:00.000Z',
    ...overrides,
  }
}

export function makeVersion(overrides: Partial<RulebookVersion> = {}): RulebookVersion {
  return {
    id: 'version-1-0',
    rulebookId: 'rulebook-pid',
    version: '1.0',
    status: 'published',
    contentDigest: 'a'.repeat(64),
    specVersion: 'ts11@1.0.1',
    createdAt: '2026-02-02T10:00:00.000Z',
    publishedAt: '2026-02-03T10:00:00.000Z',
    ...overrides,
  }
}

export interface CatalogDataset {
  readonly providers: readonly Provider[]
  readonly rulebooks: readonly Rulebook[]
  readonly attestations: Readonly<Record<string, readonly Attestation[]>>
  readonly versions: Readonly<Record<string, readonly RulebookVersion[]>>
}

export const SAMPLE_DATASET: CatalogDataset = {
  providers: PROVIDERS,
  rulebooks: [
    makeRulebook(),
    makeRulebook({
      id: 'rulebook-age',
      providerId: 'provider-lab',
      name: 'Age Verification Rulebook',
      description: 'Proof-of-age rulebook maintained by Wallet Lab.',
      sourceUrl: null,
      publicationStatus: 'draft',
      updatedAt: '2026-04-05T10:00:00.000Z',
    }),
  ],
  attestations: {
    'rulebook-pid': [makeAttestation()],
    'rulebook-age': [
      makeAttestation({
        id: 'attestation-age',
        rulebookId: 'rulebook-age',
        name: 'Proof of Age',
        supportedFormats: ['dc+sd-jwt'],
      }),
    ],
  },
  versions: {
    'rulebook-pid': [
      makeVersion(),
      makeVersion({
        id: 'version-1-1',
        version: '1.1',
        status: 'draft',
        createdAt: '2026-03-04T10:00:00.000Z',
        publishedAt: null,
      }),
    ],
    'rulebook-age': [],
  },
}

function page(dataset: CatalogDataset) {
  return {
    data: dataset.rulebooks,
    pagination: { limit: 100, offset: 0, total: dataset.rulebooks.length },
  }
}

export function createFakeApi(dataset: CatalogDataset = SAMPLE_DATASET): CatalogApi {
  return {
    listProviders: () => Promise.resolve(dataset.providers),
    listRulebooks: () => Promise.resolve(page(dataset)),
    listAttestations: (rulebookId) => Promise.resolve(dataset.attestations[rulebookId] ?? []),
    listVersions: (rulebookId) => Promise.resolve(dataset.versions[rulebookId] ?? []),
  }
}
