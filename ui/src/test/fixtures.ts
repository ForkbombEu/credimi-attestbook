// Shared fixtures for the catalog, detail and playground unit and component
// tests.

import { CatalogApiError, type CatalogApi, type ValidationApi } from '../api'
import type {
  Attestation,
  CredentialValidationResult,
  Provider,
  Rulebook,
  RulebookVersion,
  SchemaReference,
  ValidationDimension,
  ValidationDimensionId,
  ValidationSeverity,
  ValidationStatus,
} from '../types'

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

// ------------------------------------------------ credential validation fixtures

function dimension(
  id: ValidationDimensionId,
  status: ValidationStatus,
  applicable: boolean,
  executed: boolean,
  finding?: {
    readonly code: string
    readonly message: string
    readonly severity: ValidationSeverity
  },
): ValidationDimension {
  return {
    id,
    status,
    applicable,
    executed,
    findings:
      finding === undefined
        ? []
        : [
            {
              code: finding.code,
              message: finding.message,
              severity: finding.severity,
              dimension: id,
            },
          ],
    evidence: {
      scope: `What a real ${id} execution evaluates.`,
      reason:
        status === 'PASS'
          ? 'The check executed and passed.'
          : status === 'FAIL'
            ? 'The check executed and found a violation.'
            : status === 'INCONCLUSIVE'
              ? 'The check executed but did not reach a conclusion.'
              : status === 'NOT_TESTED'
                ? 'The check did not execute.'
                : 'The check does not apply to a standalone credential.',
      details: { executed, applicable },
    },
  }
}

export function makeValidationResult(
  overrides: Partial<CredentialValidationResult> = {},
): CredentialValidationResult {
  return {
    validationId: 'validation-0001',
    validatedAt: '2026-05-05T12:00:00.000Z',
    rulebook: {
      id: 'rulebook-pid',
      name: 'PID Rulebook',
      version: '1.0',
      digest: 'a'.repeat(64),
      digestVerified: true,
      specVersion: 'ts11@1.0.1',
      status: 'published',
    },
    attestation: {
      name: 'Person Identification Data',
      attestationLoS: 'iso_18045_high',
      bindingType: 'cryptographic',
      supportedFormats: ['dc+sd-jwt'],
    },
    credential: {
      format: 'dc+sd-jwt',
      vct: 'https://example.org/vct/pid',
      disclosureCount: 3,
      keyBindingPresent: true,
    },
    schemaReferences: [
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://issuer.example.org/schemas/pid',
        integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
        kind: 'type_metadata',
        applied: false,
      },
    ],
    dimensions: [
      dimension('credential_parsing', 'PASS', true, true),
      dimension('format_recognition', 'PASS', true, true),
      dimension('cryptographic_verification', 'NOT_TESTED', true, false, {
        code: 'cryptographic_verification_not_implemented',
        message: 'Issuer signatures, KB-JWT proofs and status lists are not verified.',
        severity: 'warning',
      }),
      dimension('schema_validation', 'NOT_TESTED', true, false, {
        code: 'schema_document_not_supplied',
        message: 'No schema document was supplied for the pinned reference.',
        severity: 'warning',
      }),
      dimension('attestation_constraints', 'PASS', true, true),
      dimension('issuer_trust', 'NOT_TESTED', true, false, {
        code: 'issuer_trust_not_implemented',
        message: 'No trust anchors were applied.',
        severity: 'warning',
      }),
      dimension('protocol_conformance', 'NOT_APPLICABLE', false, false, {
        code: 'protocol_conformance_not_applicable',
        message: 'A single credential artifact contains no protocol exchange.',
        severity: 'info',
      }),
      dimension('interoperability', 'NOT_APPLICABLE', false, false, {
        code: 'interoperability_not_applicable',
        message: 'No external wallet or verifier execution exists.',
        severity: 'info',
      }),
    ],
    violations: [],
    limitations: [
      {
        code: 'cryptographic_verification_not_implemented',
        dimension: 'cryptographic_verification',
        status: 'NOT_TESTED',
        message: 'Issuer signatures, KB-JWT proofs and status lists are not verified.',
      },
      {
        code: 'schema_document_not_supplied',
        dimension: 'schema_validation',
        status: 'NOT_TESTED',
        message: 'No schema document was supplied for the pinned reference.',
      },
      {
        code: 'issuer_trust_not_implemented',
        dimension: 'issuer_trust',
        status: 'NOT_TESTED',
        message: 'No trust anchors were applied.',
      },
      {
        code: 'protocol_conformance_not_applicable',
        dimension: 'protocol_conformance',
        status: 'NOT_APPLICABLE',
        message: 'A single credential artifact contains no protocol exchange.',
      },
      {
        code: 'interoperability_not_applicable',
        dimension: 'interoperability',
        status: 'NOT_APPLICABLE',
        message: 'No external wallet or verifier execution exists.',
      },
    ],
    overallStatus: 'NOT_TESTED',
    ...overrides,
  }
}

/** A 200 response whose attestation-constraint dimension failed. */
export function makeFailedValidationResult(): CredentialValidationResult {
  const base = makeValidationResult()
  const failingFinding = {
    code: 'format_not_supported_by_rulebook',
    message: 'The selected attestation type does not support the "dc+sd-jwt" credential format.',
    severity: 'error' as const,
    dimension: 'attestation_constraints' as const,
    path: '/credential',
    expected: 'format is one of mso_mdoc',
  }
  return {
    ...base,
    dimensions: base.dimensions.map((entry) =>
      entry.id === 'attestation_constraints'
        ? {
            ...entry,
            status: 'FAIL',
            findings: [failingFinding],
            evidence: {
              ...entry.evidence,
              reason:
                'At least one attestation-specific constraint is violated by the credential or rulebook version.',
            },
          }
        : entry,
    ),
    violations: [failingFinding],
    overallStatus: 'FAIL',
  }
}

export function createFakeValidator(
  result: CredentialValidationResult = makeValidationResult(),
): ValidationApi {
  return {
    validateCredential: () => Promise.resolve(result),
  }
}
