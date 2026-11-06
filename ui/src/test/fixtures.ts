// Shared fixtures for the catalog and detail unit and component tests.

import { CatalogApiError, type CatalogApi } from '../api'
import type { Attestation, Provider, Rulebook, RulebookVersion, SchemaReference } from '../types'

export const PROVIDERS: readonly Provider[] = [
  { id: 'provider-issuer', name: 'Example Issuer', createdAt: '2026-01-02T10:00:00.000Z' },
  { id: 'provider-lab', name: 'Wallet Lab', createdAt: '2026-01-03T10:00:00.000Z' },
]

export const PID_SCHEMA_REFERENCE: SchemaReference = {
  id: 'reference-pid',
  rulebookId: 'rulebook-pid',
  attestationId: 'attestation-pid',
  formatIdentifier: 'dc+sd-jwt',
  uri: 'https://issuer.example.org/schemas/pid',
  integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
  createdAt: '2026-02-01T10:00:00.000Z',
}

export const RULEBOOK_SCHEMA_REFERENCE: SchemaReference = {
  id: 'reference-rulebook',
  rulebookId: 'rulebook-pid',
  attestationId: null,
  formatIdentifier: 'mso_mdoc',
  uri: 'https://issuer.example.org/schemas/common',
  integrity: null,
  createdAt: '2026-02-01T10:00:00.000Z',
}

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
    schemaReferences: [],
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
  readonly schemaReferences: Readonly<Record<string, readonly SchemaReference[]>>
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
    'rulebook-pid': [makeAttestation({ schemaReferences: [PID_SCHEMA_REFERENCE] })],
    'rulebook-age': [
      makeAttestation({
        id: 'attestation-age',
        rulebookId: 'rulebook-age',
        name: 'Proof of Age',
        supportedFormats: ['dc+sd-jwt'],
      }),
    ],
  },
  schemaReferences: {
    'rulebook-pid': [PID_SCHEMA_REFERENCE, RULEBOOK_SCHEMA_REFERENCE],
    'rulebook-age': [],
  },
  versions: {
    'rulebook-pid': [
      makeVersion(),
      makeVersion({
        id: 'version-1-1',
        version: '1.1',
        status: 'draft',
        contentDigest: 'b'.repeat(64),
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
    getRulebook: (rulebookId) => {
      const rulebook = dataset.rulebooks.find((candidate) => candidate.id === rulebookId)
      return rulebook === undefined
        ? Promise.reject(new CatalogApiError('No route matches the request path.', 404))
        : Promise.resolve(rulebook)
    },
    listAttestations: (rulebookId) => Promise.resolve(dataset.attestations[rulebookId] ?? []),
    listSchemaReferences: (rulebookId) =>
      Promise.resolve(dataset.schemaReferences[rulebookId] ?? []),
    listVersions: (rulebookId) => Promise.resolve(dataset.versions[rulebookId] ?? []),
  }
}
