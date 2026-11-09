// Typed request/response schemas for the versioned product API (issue #34).
//
// These Zod schemas are the single source of truth for the OpenAPI components
// (generated with `z.toJSONSchema` in ./openapi.ts) and are also used to
// validate what the handlers actually return in the contract tests. The
// internal registry metadata that the registry service stores (provenance,
// metadata and the import identity) is deliberately absent: representations in
// this module are the public projection of those services.

import { z } from 'zod'

import { ISSUER_FIXTURE_KIND, ISSUER_FIXTURE_NEGATIVE_CATEGORIES } from '../fixtures/types'
import {
  COMPARISON_RESULTS,
  EXTERNAL_WALLET_INTERACTIONS,
  HEADLESS_WALLET_COMPARISON_KIND,
  HEADLESS_WALLET_COMPARISON_VERSION,
  UNSUPPORTED_COMPARISON_CODES,
} from '../comparison/types'
import {
  MAX_EXTERNAL_OBSERVATION_CODE_LENGTH,
  MAX_EXTERNAL_OBSERVATION_DETAIL_LENGTH,
  MAX_EXTERNAL_OBSERVATION_TIMESTAMP_LENGTH,
  MAX_EXTERNAL_WALLET_ID_LENGTH,
  MAX_EXTERNAL_WALLET_OBSERVATIONS,
} from '../comparison/input'
import {
  VERIFIER_CONSTRAINTS_KIND,
  VERIFIER_GROUNDING_STATUSES,
  VERIFIER_MAPPING_SCOPES,
  VERIFIER_POLICY_INTERFACES,
  VERIFIER_POLICY_INTERFACE_STATUSES,
} from '../verifier/types'

export const PUBLICATION_STATUS_SCHEMA = z.enum(['draft', 'published', 'historical'])

export const VALIDATION_STATUS_SCHEMA = z.enum([
  'PASS',
  'FAIL',
  'NOT_TESTED',
  'NOT_APPLICABLE',
  'INCONCLUSIVE',
])

export const VALIDATION_DIMENSION_ID_SCHEMA = z.enum([
  'credential_parsing',
  'format_recognition',
  'cryptographic_verification',
  'schema_validation',
  'attestation_constraints',
  'issuer_trust',
  'protocol_conformance',
  'interoperability',
])

export const VALIDATION_SEVERITY_SCHEMA = z.enum(['error', 'warning', 'info'])

export const CONFORMANCE_CLASSIFICATION_SCHEMA = z.enum([
  'conformant_subset',
  'partial',
  'not_verified',
  'prose_only',
])

export const IMPORT_DIAGNOSTIC_KIND_SCHEMA = z.enum([
  'invalid_input',
  'unsupported_operation',
  'not_tested',
  'preserved',
  'limit',
  'change',
])

const timestamp = z.string()
const nullableString = z.string().nullable()

/**
 * The public provider representation used by the catalogue. Publication
 * authority, internal metadata and tokens stay inside the registry.
 */
export const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: timestamp,
})

export const providerListResponseSchema = z.object({ data: z.array(providerSchema) })

/** The public rulebook representation: no provenance, metadata or import key. */
export const rulebookSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  name: z.string(),
  description: z.string(),
  sourceUrl: nullableString,
  applicableSpec: z.string(),
  publicationStatus: PUBLICATION_STATUS_SCHEMA,
  createdAt: timestamp,
  updatedAt: timestamp,
})

export const attestationSchema = z.object({
  id: z.string(),
  rulebookId: z.string(),
  name: z.string(),
  attestationLoS: z.string(),
  bindingType: z.string(),
  supportedFormats: z.array(z.string()),
  createdAt: timestamp,
})

export const schemaReferenceSchema = z.object({
  id: z.string(),
  rulebookId: z.string(),
  attestationId: nullableString,
  formatIdentifier: z.string(),
  uri: z.string(),
  integrity: nullableString,
  createdAt: timestamp,
})

export const attestationDetailSchema = attestationSchema.extend({
  schemaReferences: z.array(schemaReferenceSchema),
})

export const rulebookVersionSchema = z.object({
  id: z.string(),
  rulebookId: z.string(),
  version: z.string(),
  status: PUBLICATION_STATUS_SCHEMA,
  contentDigest: z.string(),
  specVersion: z.string(),
  createdAt: timestamp,
  publishedAt: nullableString,
})

export const rulebookVersionSchemaReferenceSchema = z.object({
  formatIdentifier: z.string(),
  uri: z.string(),
  integrity: nullableString,
})

export const rulebookVersionDocumentSchema = z.object({
  format: z.literal('attestbook.rulebook-version@1'),
  rulebookId: z.string(),
  version: z.string(),
  specVersion: z.string(),
  name: z.string(),
  description: z.string(),
  sourceUrl: nullableString,
  attestations: z.array(
    z.object({
      name: z.string(),
      attestationLoS: z.string(),
      bindingType: z.string(),
      supportedFormats: z.array(z.string()),
      schemaReferences: z.array(rulebookVersionSchemaReferenceSchema),
    }),
  ),
  schemaReferences: z.array(rulebookVersionSchemaReferenceSchema),
})

export const paginationSchema = z.object({
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})

export const rulebookResponseSchema = z.object({ data: rulebookSchema })
export const rulebookPageSchema = z.object({
  data: z.array(rulebookSchema),
  pagination: paginationSchema,
})
export const attestationListResponseSchema = z.object({ data: z.array(attestationDetailSchema) })
export const schemaReferenceListResponseSchema = z.object({
  data: z.array(schemaReferenceSchema),
})
export const rulebookVersionResponseSchema = z.object({ data: rulebookVersionSchema })
export const rulebookVersionListResponseSchema = z.object({
  data: z.array(rulebookVersionSchema),
})

// --------------------------------------------- version comparison & readiness

export const VERSION_DIFF_CHANGE_KIND_SCHEMA = z.enum(['added', 'removed', 'changed'])

/** One structural difference between two version snapshots (#41). */
export const versionDiffChangeSchema = z.object({
  /** JSON Pointer into the comparable content of a snapshot. */
  path: z.string(),
  kind: VERSION_DIFF_CHANGE_KIND_SCHEMA,
  before: z.json().optional(),
  after: z.json().optional(),
})

export const versionDiffSchema = z.object({
  from: rulebookVersionSchema,
  to: rulebookVersionSchema,
  identical: z.boolean(),
  changes: z.array(versionDiffChangeSchema),
  summary: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
  }),
})

export const versionDiffResponseSchema = z.object({ data: versionDiffSchema })

export const PUBLICATION_READINESS_CHECK_STATUS_SCHEMA = z.enum([
  'pass',
  'fail',
  'warn',
  'not_applicable',
])

/** One publication-readiness check of a stored version (#41). */
export const publicationReadinessCheckSchema = z.object({
  id: z.enum([
    'draft_version',
    'rulebook_status',
    'snapshot_integrity',
    'snapshot_current',
    'content_valid',
    'standards_profile',
    'attestation_types',
  ]),
  status: PUBLICATION_READINESS_CHECK_STATUS_SCHEMA,
  message: z.string(),
})

export const publicationReadinessSchema = z.object({
  version: rulebookVersionSchema,
  ready: z.boolean(),
  checks: z.array(publicationReadinessCheckSchema),
  limitations: z.array(z.string()),
})

export const publicationReadinessResponseSchema = z.object({ data: publicationReadinessSchema })

// ----------------------------------------------- publication export manifest

/** The signature boundary reported by a publication export manifest (#42). */
export const publicationExportSignatureSchema = z.object({
  status: z.literal('unsupported'),
  reason: z.string(),
})

/**
 * Bounded provenance projection of a publication export. Import provenance can
 * carry untrusted envelope metadata and optional source labels, so the public
 * manifest carries only these stable fields (§15 personal-data minimisation).
 */
export const publicationExportProvenanceSchema = z.object({
  adapter: z.string().optional(),
  sourceUrl: z.string().optional(),
  contentDigest: z.string().optional(),
  retrievedAt: z.string().optional(),
  profile: z.string().optional(),
  conformance: z.string().optional(),
  importedAt: z.string().optional(),
})

/**
 * Manifest of one published or historical artifact. It is built only from
 * frozen version data, so exporting the same version always returns the same
 * manifest, independent of later working-copy edits.
 */
export const publicationExportManifestSchema = z.object({
  format: z.literal('attestbook.publication-export@1'),
  rulebookId: z.string(),
  providerId: z.string(),
  version: z.string(),
  status: z.enum(['published', 'historical']),
  name: z.string(),
  sourceUrl: nullableString,
  specVersion: z.string(),
  mediaType: z.string(),
  contentDigest: z.string(),
  byteLength: z.number().int().nonnegative(),
  createdAt: timestamp,
  publishedAt: timestamp,
  provenance: publicationExportProvenanceSchema,
  integrity: z.object({
    algorithm: z.literal('sha256'),
    verified: z.literal(true),
  }),
  signature: publicationExportSignatureSchema,
  limitations: z.array(z.string()),
})

export const publicationExportManifestResponseSchema = z.object({
  data: publicationExportManifestSchema,
})

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('attestbook'),
  version: z.string(),
})

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum([
      'invalid_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'immutable',
      'payload_too_large',
      'import_fetch_failed',
      'import_rejected',
      'registry_unavailable',
      'validation_unavailable',
      'fixture_unavailable',
      'internal_error',
    ]),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

// ---------------------------------------------------------------- requests

const schemaReferenceInputSchema = z.object({
  formatIdentifier: z.string(),
  uri: z.string(),
  integrity: z.string().optional(),
})

const attestationInputSchema = z.object({
  name: z.string(),
  attestationLoS: z.string(),
  bindingType: z.string(),
  supportedFormats: z.array(z.string()).optional(),
  schemaReferences: z.array(schemaReferenceInputSchema).optional(),
})

export const createRulebookRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  sourceUrl: z.string().nullable().optional(),
  applicableSpec: z.string(),
  attestations: z.array(attestationInputSchema).optional(),
  schemaReferences: z.array(schemaReferenceInputSchema).optional(),
})

export const createRulebookVersionRequestSchema = z.object({
  version: z.string(),
})

// ------------------------------------------------------- rulebook editor

/** A schema reference as edited in a draft document (id belongs to the registry). */
export const draftSchemaReferenceSchema = z.object({
  formatIdentifier: z.string(),
  uri: z.string(),
  integrity: nullableString,
})

/** An attestation type as edited in a draft document. */
export const draftAttestationSchema = z.object({
  name: z.string(),
  attestationLoS: z.string(),
  bindingType: z.string(),
  supportedFormats: z.array(z.string()),
  schemaReferences: z.array(draftSchemaReferenceSchema),
})

/** The draft working copy as one editable document. */
export const draftRulebookSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  name: z.string(),
  description: z.string(),
  sourceUrl: nullableString,
  applicableSpec: z.string(),
  publicationStatus: PUBLICATION_STATUS_SCHEMA,
  attestations: z.array(draftAttestationSchema),
  schemaReferences: z.array(draftSchemaReferenceSchema),
  createdAt: timestamp,
  updatedAt: timestamp,
})

export const draftRulebookResponseSchema = z.object({ data: draftRulebookSchema })

const draftSchemaReferenceInputSchema = z.object({
  formatIdentifier: z.string(),
  uri: z.string(),
  integrity: z.string().optional(),
})

const draftAttestationInputSchema = z.object({
  name: z.string(),
  attestationLoS: z.string(),
  bindingType: z.string(),
  supportedFormats: z.array(z.string()).optional(),
  schemaReferences: z.array(draftSchemaReferenceInputSchema).optional(),
})

export const saveDraftRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  sourceUrl: z.string().nullable().optional(),
  applicableSpec: z.string(),
  attestations: z.array(draftAttestationInputSchema).optional(),
  schemaReferences: z.array(draftSchemaReferenceInputSchema).optional(),
})

/** Validation uses the same document shape as a save; nothing is persisted. */
export const validateDraftRequestSchema = saveDraftRequestSchema

export const draftDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
})

export const draftValidationSchema = z.object({
  valid: z.boolean(),
  saveable: z.boolean(),
  profile: z.enum(['ts11@1.0.1', 'owf@0.5.4']).nullable(),
  diagnostics: z.array(draftDiagnosticSchema),
  limitations: z.array(z.string()),
})

export const draftValidationResponseSchema = z.object({ data: draftValidationSchema })

export const importSourceSchema = z.union([
  z.object({
    kind: z.literal('url'),
    url: z.string(),
  }),
  z.object({
    kind: z.literal('json'),
    content: z.string(),
    name: z.string().optional(),
    sourceUrl: z.string().optional(),
  }),
])

export const importRequestSchema = z.object({
  source: importSourceSchema,
})

export const credentialArtifactSchema = z.union([
  z.string(),
  z.object({
    format: z.string().optional(),
    value: z.string(),
  }),
])

export const validateCredentialRequestSchema = z.object({
  rulebookId: z.string(),
  rulebookVersion: z.string(),
  attestationType: z.string(),
  credential: credentialArtifactSchema,
  schemaDocuments: z
    .array(
      z.object({
        uri: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
})

// ---------------------------------------------------------- import results

export const importDiagnosticSchema = z.object({
  kind: IMPORT_DIAGNOSTIC_KIND_SCHEMA,
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
})

export const sourceConformanceSchema = z.object({
  level: z.string(),
  missing: z.array(z.string()).optional(),
})

export const importSourceInfoSchema = z.object({
  adapter: z.enum(['url', 'json']),
  url: nullableString,
  requestedUrl: nullableString,
  name: nullableString,
  retrievedAt: timestamp,
  contentType: nullableString,
  status: z.number().int().nullable(),
  byteLength: z.number().int().nonnegative(),
  contentDigest: z.string(),
  redirects: z.array(z.string()),
  envelope: z.object({
    kind: z.enum(['single', 'array', 'catalog']),
    member: nullableString,
    metadata: z.record(z.string(), z.unknown()),
  }),
})

export const importEntryPreviewSchema = z.object({
  index: z.number().int().nonnegative(),
  structuralStatus: z.enum(['valid', 'invalid']),
  compatible: z.boolean(),
  profile: z.enum(['ts11@1.0.1', 'owf@0.5.4']).nullable(),
  conformance: CONFORMANCE_CLASSIFICATION_SCHEMA,
  sourceConformance: sourceConformanceSchema.nullable(),
  diagnostics: z.array(importDiagnosticSchema),
  schemaReferences: z.array(
    z.object({
      formatIdentifier: z.string(),
      uri: z.string(),
      integrity: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  name: nullableString,
  description: z.string(),
  id: nullableString,
  version: nullableString,
})

export const importCompatibilitySchema = z.object({
  compatible: z.boolean(),
  totalEntries: z.number().int().nonnegative(),
  validEntries: z.number().int().nonnegative(),
  invalidEntries: z.number().int().nonnegative(),
  incompatibleEntries: z.number().int().nonnegative(),
  conformantSubset: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  notVerified: z.number().int().nonnegative(),
  proseOnly: z.number().int().nonnegative(),
  schemaReferenceCount: z.number().int().nonnegative(),
  limitations: z.array(z.string()),
})

/** A preview without the internal canonical document used by the importer. */
export const importPreviewSchema = z.object({
  source: importSourceInfoSchema,
  entries: z.array(importEntryPreviewSchema),
  compatibility: importCompatibilitySchema,
  diagnostics: z.array(importDiagnosticSchema),
})

export const importConflictSchema = z.object({
  code: z.enum([
    'published_content',
    'locally_modified',
    'source_changed',
    'source_version_changed',
  ]),
  message: z.string(),
  rulebookId: z.string(),
  publishedVersions: z.array(z.string()),
  locallyModified: z.boolean(),
  existingContentFingerprint: z.string(),
  incomingContentFingerprint: z.string(),
  existingSourceVersion: nullableString,
  incomingSourceVersion: nullableString,
})

export const importEntryResultSchema = z.object({
  index: z.number().int().nonnegative(),
  disposition: z.enum(['created', 'unchanged', 'conflict']),
  rulebookId: nullableString,
  entryKey: z.string(),
  name: nullableString,
  sourceId: nullableString,
  sourceVersion: nullableString,
  contentFingerprint: z.string(),
  conflict: importConflictSchema.nullable(),
})

export const importResultSchema = z.object({
  preview: importPreviewSchema,
  entries: z.array(importEntryResultSchema),
  rulebooks: z.array(rulebookSchema),
  conflicts: z.array(importConflictSchema),
  diagnostics: z.array(importDiagnosticSchema),
})

export const importPreviewResponseSchema = z.object({ data: importPreviewSchema })
export const importResultResponseSchema = z.object({ data: importResultSchema })

// ----------------------------------------------------- issuer discovery

export const discoverIssuerRequestSchema = z.object({
  credentialIssuer: z.string(),
})

export const issuerMetadataShapeSchema = z.enum(['oid4vci_1_0', 'oid4vci_legacy'])

export const pinnedRulebookVersionSchema = z.object({
  rulebookId: z.string(),
  rulebookName: z.string(),
  version: z.string(),
  contentDigest: z.string(),
  specVersion: z.string(),
})

export const issuerDiscoveryConfigurationSchema = z.object({
  configurationId: z.string(),
  format: z.string(),
  displayName: nullableString,
  typeIdentifiers: z.array(
    z.object({
      kind: z.enum(['vct', 'doctype', 'type']),
      value: z.string(),
    }),
  ),
  schemaReferences: z.array(
    z.object({
      formatIdentifier: z.string(),
      uri: z.string(),
      source: z.enum(['vct', 'schema']),
    }),
  ),
  mapping: z.object({
    status: z.enum(['matched', 'ambiguous', 'unmatched']),
    candidates: z.array(pinnedRulebookVersionSchema),
    reason: nullableString,
  }),
})

export const issuerDiscoverySourceSchema = z.object({
  issuerIdentifier: z.string(),
  metadataUrl: z.string(),
  requestedUrl: z.string(),
  finalUrl: z.string(),
  retrievedAt: timestamp,
  contentType: nullableString,
  status: z.number().int(),
  byteLength: z.number().int().nonnegative(),
  contentDigest: z.string(),
  redirects: z.array(z.string()),
  metadataShape: issuerMetadataShapeSchema,
})

export const issuerMetadataSummarySchema = z.object({
  credentialIssuer: z.string(),
  credentialEndpoint: nullableString,
  authorizationServers: z.array(z.string()),
})

export const issuerDiscoverySummarySchema = z.object({
  totalConfigurations: z.number().int().nonnegative(),
  validConfigurations: z.number().int().nonnegative(),
  invalidConfigurations: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  mappedRulebooks: z.number().int().nonnegative(),
})

export const issuerDiscoveryDiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
})

export const issuerDiscoveryResultSchema = z.object({
  source: issuerDiscoverySourceSchema,
  issuer: issuerMetadataSummarySchema,
  configurations: z.array(issuerDiscoveryConfigurationSchema),
  summary: issuerDiscoverySummarySchema,
  diagnostics: z.array(issuerDiscoveryDiagnosticSchema),
  limitations: z.array(z.string()),
})

export const issuerDiscoveryResponseSchema = z.object({ data: issuerDiscoveryResultSchema })

// ------------------------------------------------------ validation results

export const validationFindingSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: VALIDATION_SEVERITY_SCHEMA,
  dimension: VALIDATION_DIMENSION_ID_SCHEMA,
  path: z.string().optional(),
  expected: z.string().optional(),
})

export const validationDimensionSchema = z.object({
  id: VALIDATION_DIMENSION_ID_SCHEMA,
  status: VALIDATION_STATUS_SCHEMA,
  applicable: z.boolean(),
  executed: z.boolean(),
  findings: z.array(validationFindingSchema),
  evidence: z.object({
    scope: z.string(),
    reason: z.string(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
})

export const validationLimitationSchema = z.object({
  code: z.string(),
  dimension: VALIDATION_DIMENSION_ID_SCHEMA,
  status: VALIDATION_STATUS_SCHEMA,
  message: z.string(),
})

export const credentialValidationResultSchema = z.object({
  validationId: z.string(),
  validatedAt: timestamp,
  rulebook: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    digest: z.string(),
    digestVerified: z.literal(true),
    specVersion: z.string(),
    status: PUBLICATION_STATUS_SCHEMA,
  }),
  attestation: z.object({
    name: z.string(),
    attestationLoS: z.string(),
    bindingType: z.string(),
    supportedFormats: z.array(z.string()),
  }),
  credential: z.object({
    format: nullableString,
    vct: nullableString,
    disclosureCount: z.number().int().nonnegative(),
    keyBindingPresent: z.boolean(),
  }),
  schemaReferences: z.array(
    z.object({
      formatIdentifier: z.string(),
      uri: z.string(),
      integrity: nullableString,
      kind: z.enum(['type_metadata', 'json_schema']).nullable(),
      applied: z.boolean(),
    }),
  ),
  dimensions: z.array(validationDimensionSchema),
  violations: z.array(validationFindingSchema),
  limitations: z.array(validationLimitationSchema),
  overallStatus: VALIDATION_STATUS_SCHEMA,
})

export const credentialValidationResponseSchema = z.object({
  data: credentialValidationResultSchema,
})

// -------------------------------------------------- capture explorer (#48)

export const CAPTURE_SOURCE_COMPONENT_SCHEMA = z.enum(['capture-issuer', 'capture-verifier'])
export const CAPTURE_PROTOCOL_SCHEMA = z.enum(['openid4vci', 'openid4vp'])
export const CAPTURE_CREDENTIAL_FORMAT_SCHEMA = z.enum([
  'dc+sd-jwt',
  'mso_mdoc',
  'jwt_vc_json',
  'jwt_vc_json-ld',
  'ldp_vc',
])
export const CAPTURE_INTERACTION_TYPE_SCHEMA = z.enum(['issuance', 'presentation', 'error'])
export const CAPTURE_ARTIFACT_TYPE_SCHEMA = z.enum([
  'issuer-metadata',
  'credential-offer',
  'issued-credential',
  'presentation-request',
  'presentation-submission',
  'verification-outcome',
  'error-response',
])
export const CAPTURE_REDACTION_STATUS_SCHEMA = z.enum(['none', 'partial', 'full'])
export const CAPTURE_EVIDENCE_GAP_CODE_SCHEMA = z.enum([
  'external_artifact_not_fetched',
  'artifact_redacted_by_source',
  'no_test_execution_reference',
  'no_rulebook_binding',
  'validation_not_run',
  'validation_not_applicable',
])
export const CAPTURE_TIMELINE_EVENT_KIND_SCHEMA = z.enum([
  'captured',
  'received',
  'bound',
  'validated',
])

export const captureSourceSummarySchema = z.object({
  sourceId: z.string(),
  component: CAPTURE_SOURCE_COMPONENT_SCHEMA,
  transport: z.literal('mock'),
  description: z.string(),
})

export const captureProvenanceSummarySchema = z.object({
  sourceComponent: CAPTURE_SOURCE_COMPONENT_SCHEMA,
  sourceVersion: nullableString,
  capturedAt: z.string(),
  capturedAtMs: z.number().int(),
  receivedAt: z.string(),
  receivedAtMs: z.number().int(),
})

export const capturePartySchema = z.object({
  role: z.enum(['issuer', 'verifier']),
  identifier: z.string(),
  name: nullableString,
})

export const captureIntegritySchema = z.object({
  algorithm: z.literal('sha256'),
  digest: z.string(),
  verified: z.boolean(),
})

export const captureRedactionSchema = z.object({
  status: CAPTURE_REDACTION_STATUS_SCHEMA,
  policyRef: nullableString,
  redactedPaths: z.array(z.string()),
  redactedDigest: nullableString,
})

export const captureArtifactSummarySchema = z.object({
  availability: z.enum(['inline', 'external']),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative().nullable(),
  uri: nullableString,
})

export const captureRulebookBindingSchema = z.object({
  rulebookId: z.string(),
  rulebookName: z.string(),
  version: z.string(),
  contentDigest: z.string(),
  digestVerified: z.literal(true),
  specVersion: z.string(),
  rulebookStatus: PUBLICATION_STATUS_SCHEMA,
  attestationType: z.string(),
  boundAt: z.string(),
})

export const captureValidationDimensionSummarySchema = z.object({
  id: VALIDATION_DIMENSION_ID_SCHEMA,
  status: VALIDATION_STATUS_SCHEMA,
  applicable: z.boolean(),
  executed: z.boolean(),
})

export const captureValidationSummarySchema = z.object({
  validationId: z.string(),
  validatedAt: z.string(),
  overallStatus: VALIDATION_STATUS_SCHEMA,
  violations: z.number().int().nonnegative(),
  limitations: z.number().int().nonnegative(),
  dimensions: z.array(captureValidationDimensionSummarySchema),
})

export const captureEvidenceGapSchema = z.object({
  code: CAPTURE_EVIDENCE_GAP_CODE_SCHEMA,
  message: z.string(),
})

export const captureExplorerSummarySchema = z.object({
  captureId: z.string(),
  correlationId: z.string(),
  kind: z.literal('attestbook.capture-artifact@1'),
  envelopeVersion: z.literal(1),
  source: captureSourceSummarySchema,
  provenance: captureProvenanceSummarySchema,
  interactionType: CAPTURE_INTERACTION_TYPE_SCHEMA,
  protocol: CAPTURE_PROTOCOL_SCHEMA,
  credentialFormat: CAPTURE_CREDENTIAL_FORMAT_SCHEMA,
  artifactType: CAPTURE_ARTIFACT_TYPE_SCHEMA,
  party: capturePartySchema.nullable(),
  testExecutionRef: nullableString,
  integrity: captureIntegritySchema,
  declaredRedaction: captureRedactionSchema,
  artifact: captureArtifactSummarySchema,
  rulebook: captureRulebookBindingSchema.nullable(),
  validation: captureValidationSummarySchema.nullable(),
  evidenceGaps: z.array(captureEvidenceGapSchema),
  evidenceComplete: z.boolean(),
})

export const captureArtifactProjectionSchema = z.object({
  mediaType: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  byteLength: z.number().int().nonnegative(),
  digest: z.string(),
  redaction: captureRedactionSchema,
  document: z.unknown(),
  diagnostics: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      path: z.string().optional(),
    }),
  ),
})

export const captureTimelineEventSchema = z.object({
  kind: CAPTURE_TIMELINE_EVENT_KIND_SCHEMA,
  at: z.string(),
  label: z.string(),
  detail: z.string(),
})

export const captureExplorerDetailSchema = captureExplorerSummarySchema.extend({
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  artifactProjection: captureArtifactProjectionSchema.nullable(),
  validationResult: credentialValidationResultSchema.nullable(),
  timeline: z.array(captureTimelineEventSchema),
  limitations: z.array(z.string()),
})

export const captureExplorerPageSchema = z.object({
  data: z.array(captureExplorerSummarySchema),
  pagination: z.object({
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
})

export const captureExplorerDetailResponseSchema = z.object({
  data: captureExplorerDetailSchema,
})

export const correlateCaptureRequestSchema = z.object({
  rulebookId: z.string(),
  rulebookVersion: z.string(),
  attestationType: z.string(),
  /** Optional pinned snapshot digest; a mismatch is refused before recording. */
  rulebookDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})

export const captureCorrelationResultSchema = z.object({
  captureId: z.string(),
  correlationId: z.string(),
  testExecutionRef: nullableString,
  rulebook: captureRulebookBindingSchema,
  validation: credentialValidationResultSchema,
})

export const captureCorrelationResponseSchema = z.object({
  data: captureCorrelationResultSchema,
})

// ------------------------------------- headless-wallet comparison (#50)

export const EXTERNAL_WALLET_INTERACTION_SCHEMA = z.enum(EXTERNAL_WALLET_INTERACTIONS)
export const COMPARISON_RESULT_SCHEMA = z.enum(COMPARISON_RESULTS)
export const UNSUPPORTED_COMPARISON_CODE_SCHEMA = z.enum(UNSUPPORTED_COMPARISON_CODES)

export const externalDimensionObservationSchema = z.object({
  dimension: VALIDATION_DIMENSION_ID_SCHEMA,
  status: VALIDATION_STATUS_SCHEMA,
  code: nullableString,
  detail: nullableString,
})

export const externalWalletObservationSchema = z.object({
  walletId: z.string(),
  observedAt: z.string(),
  interaction: EXTERNAL_WALLET_INTERACTION_SCHEMA,
  observations: z.array(externalDimensionObservationSchema),
})

/**
 * Request-only observation schema. It matches what the server actually accepts:
 * `code` and `detail` are optional, and the wallet observation may be `null`.
 * The response schema above stays strict because the builder always emits
 * `null` for a missing `code` or `detail`.
 */
export const externalDimensionObservationRequestSchema = z.object({
  dimension: VALIDATION_DIMENSION_ID_SCHEMA,
  status: VALIDATION_STATUS_SCHEMA,
  code: z.string().max(MAX_EXTERNAL_OBSERVATION_CODE_LENGTH).nullable().optional(),
  detail: z.string().max(MAX_EXTERNAL_OBSERVATION_DETAIL_LENGTH).nullable().optional(),
})

export const externalWalletObservationRequestSchema = z.object({
  walletId: z
    .string()
    .min(1)
    .max(MAX_EXTERNAL_WALLET_ID_LENGTH)
    .regex(/^[\x21-\x7e]+$/),
  observedAt: z.string().min(1).max(MAX_EXTERNAL_OBSERVATION_TIMESTAMP_LENGTH),
  interaction: EXTERNAL_WALLET_INTERACTION_SCHEMA,
  observations: z
    .array(externalDimensionObservationRequestSchema)
    .min(1)
    .max(MAX_EXTERNAL_WALLET_OBSERVATIONS),
})

export const compareCaptureRequestSchema = z.object({
  /**
   * Optional caller-supplied external wallet observation. When absent or
   * `null`, the report carries the AttestBook structural evidence and explicit
   * gaps.
   */
  externalWallet: externalWalletObservationRequestSchema.nullable().optional(),
})

export const comparisonDimensionEntrySchema = z.object({
  dimension: VALIDATION_DIMENSION_ID_SCHEMA,
  attestbook: z
    .object({
      status: VALIDATION_STATUS_SCHEMA,
      applicable: z.boolean(),
      executed: z.boolean(),
    })
    .nullable(),
  external: z
    .object({
      status: VALIDATION_STATUS_SCHEMA,
      code: nullableString,
      detail: nullableString,
    })
    .nullable(),
  result: COMPARISON_RESULT_SCHEMA,
})

export const unsupportedComparisonSchema = z.object({
  dimension: VALIDATION_DIMENSION_ID_SCHEMA,
  code: UNSUPPORTED_COMPARISON_CODE_SCHEMA,
  attestbookStatus: VALIDATION_STATUS_SCHEMA.nullable(),
  reason: z.string(),
})

export const headlessWalletComparisonSchema = z.object({
  kind: z.literal(HEADLESS_WALLET_COMPARISON_KIND),
  contractVersion: z.literal(HEADLESS_WALLET_COMPARISON_VERSION),
  comparedAt: z.string(),
  rulebook: captureRulebookBindingSchema,
  capture: z.object({
    captureId: z.string(),
    correlationId: z.string(),
    testExecutionRef: nullableString,
    sourceComponent: CAPTURE_SOURCE_COMPONENT_SCHEMA,
    protocol: CAPTURE_PROTOCOL_SCHEMA,
    credentialFormat: CAPTURE_CREDENTIAL_FORMAT_SCHEMA,
  }),
  attestbook: z.object({
    validationId: z.string(),
    validatedAt: z.string(),
    overallStatus: VALIDATION_STATUS_SCHEMA,
    credential: z.object({
      format: nullableString,
      vct: nullableString,
      disclosureCount: z.number().int().nonnegative(),
      keyBindingPresent: z.boolean(),
    }),
    schemaReferences: z.array(
      z.object({
        formatIdentifier: z.string(),
        uri: z.string(),
        integrity: nullableString,
        kind: z.enum(['type_metadata', 'json_schema']).nullable(),
        applied: z.boolean(),
      }),
    ),
    violations: z.array(validationFindingSchema),
    limitations: z.array(validationLimitationSchema),
  }),
  externalWallet: externalWalletObservationSchema.nullable(),
  comparison: z.object({
    schema: z.array(comparisonDimensionEntrySchema),
    protocol: z.array(comparisonDimensionEntrySchema),
    interoperability: z.array(comparisonDimensionEntrySchema),
    trust: z.array(comparisonDimensionEntrySchema),
    unsupported: z.array(unsupportedComparisonSchema),
  }),
  nonClaims: z.object({
    externalObservationVerified: z.literal(false),
    cryptographicVerification: z.literal(false),
    issuerTrust: z.literal(false),
    protocolConformance: z.literal(false),
    interoperability: z.literal(false),
  }),
  limitations: z.array(z.string()),
})

export const headlessWalletComparisonResponseSchema = z.object({
  data: headlessWalletComparisonSchema,
})

// ---------------------------------------------------------- issuer fixtures

export const generateIssuerFixtureRequestSchema = z.object({
  rulebookId: z.string(),
  rulebookVersion: z.string(),
  attestationType: z.string(),
  format: z.string().optional(),
  schemaDocuments: z
    .array(
      z.object({
        uri: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
  overrides: z
    .array(
      z.object({
        path: z.string(),
        value: z.json(),
      }),
    )
    .optional(),
})

export const issuerFixtureAttributeSchema = z.object({
  pointer: z.string(),
  name: z.string(),
  required: z.boolean(),
  types: z.array(z.string()),
  constraints: z.record(z.string(), z.json()),
  sources: z.array(z.string()),
  generated: z.boolean(),
  reason: z.string().optional(),
})

export const issuerFixtureFindingSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  keyword: z.string().optional(),
})

export const issuerFixtureNegativeCaseSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.enum(ISSUER_FIXTURE_NEGATIVE_CATEGORIES),
  keyword: z.string(),
  path: z.string(),
  expected: z.literal('FAIL'),
  reason: z.string(),
  payload: z.record(z.string(), z.json()),
})

export const issuerFixtureSchema = z.object({
  kind: z.literal(ISSUER_FIXTURE_KIND),
  signed: z.literal(false),
  issued: z.literal(false),
  rulebook: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    digest: z.string(),
    digestVerified: z.literal(true),
    specVersion: z.string(),
    status: PUBLICATION_STATUS_SCHEMA,
  }),
  attestation: z.object({
    name: z.string(),
    attestationLoS: z.string(),
    bindingType: z.string(),
    supportedFormats: z.array(z.string()),
  }),
  formats: z.array(z.string()),
  schemaReferences: z.array(
    z.object({
      formatIdentifier: z.string(),
      uri: z.string(),
      integrity: nullableString,
      integrityVerified: z.boolean(),
      kind: z.enum(['json_schema', 'type_metadata']).nullable(),
      applied: z.boolean(),
      diagnostic: z.string().optional(),
    }),
  ),
  attributes: z.array(issuerFixtureAttributeSchema),
  payload: z.record(z.string(), z.json()),
  payloadValidation: z.object({
    status: z.enum(['PASS', 'FAIL']),
    findings: z.array(issuerFixtureFindingSchema),
  }),
  overrides: z.array(
    z.object({
      path: z.string(),
      value: z.json(),
      applied: z.literal(true),
    }),
  ),
  negativeCases: z.array(issuerFixtureNegativeCaseSchema),
  diagnostics: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      path: z.string().optional(),
    }),
  ),
  limitations: z.array(z.string()),
})

export const issuerFixtureResponseSchema = z.object({ data: issuerFixtureSchema })

// ------------------------------------------------------ verifier constraints

export const resolveVerifierConstraintsRequestSchema = z.object({
  rulebookId: z.string(),
  rulebookVersion: z.string(),
  attestationType: z.string(),
  format: z.string().optional(),
  schemaDocuments: z
    .array(
      z.object({
        uri: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
})

export const verifierUnsupportedConstraintSchema = z.object({
  keyword: z.string(),
  reason: z.string(),
})

export const verifierAttributeConstraintSchema = z.object({
  pointer: z.string(),
  name: z.string(),
  required: z.boolean(),
  types: z.array(z.string()),
  constraints: z.record(z.string(), z.json()),
  unsupportedConstraints: z.array(verifierUnsupportedConstraintSchema),
  sources: z.array(z.string()),
  claimPath: z.array(z.union([z.string(), z.number(), z.null()])),
  claimPathSupported: z.boolean(),
})

export const verifierUnsupportedMappingSchema = z.object({
  code: z.string(),
  scope: z.enum(VERIFIER_MAPPING_SCOPES),
  path: z.string().optional(),
  keyword: z.string().optional(),
  reason: z.string(),
})

export const verifierDcqlMappingSchema = z.object({
  interfaceId: z.literal('openid4vp.dcql@1'),
  complete: z.literal(false),
  credentialQuery: z.record(z.string(), z.json()).nullable(),
  mapped: z.array(z.string()),
  unsupported: z.array(verifierUnsupportedMappingSchema),
  notes: z.array(z.string()),
})

export const verifierPolicyDiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
})

export const verifierFormatPolicySchema = z.object({
  format: z.string(),
  grounding: z.enum(VERIFIER_GROUNDING_STATUSES),
  schemaReferences: z.array(
    z.object({
      formatIdentifier: z.string(),
      uri: z.string(),
      integrity: nullableString,
      integrityVerified: z.boolean(),
      kind: z.enum(['json_schema', 'type_metadata']).nullable(),
      inspected: z.boolean(),
      diagnostic: z.string().optional(),
    }),
  ),
  attributes: z.array(verifierAttributeConstraintSchema),
  dcql: verifierDcqlMappingSchema,
  diagnostics: z.array(verifierPolicyDiagnosticSchema),
})

export const verifierPolicyInterfaceSchema = z.object({
  id: z.enum(VERIFIER_POLICY_INTERFACES),
  status: z.enum(VERIFIER_POLICY_INTERFACE_STATUSES),
  description: z.string(),
  supportedFeatures: z.array(z.string()),
  unsupported: z.array(verifierUnsupportedMappingSchema),
})

export const verifierConstraintsResultSchema = z.object({
  kind: z.literal(VERIFIER_CONSTRAINTS_KIND),
  rulebook: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    digest: z.string(),
    digestVerified: z.literal(true),
    specVersion: z.string(),
    status: PUBLICATION_STATUS_SCHEMA,
  }),
  attestation: z.object({
    name: z.string(),
    attestationLoS: z.string(),
    bindingType: z.string(),
    supportedFormats: z.array(z.string()),
  }),
  formats: z.array(verifierFormatPolicySchema),
  policyInterfaces: z.array(verifierPolicyInterfaceSchema),
  diagnostics: z.array(verifierPolicyDiagnosticSchema),
  nonClaims: z.object({
    presentationRequest: z.literal(false),
    proof: z.literal(false),
    cryptographicVerification: z.literal('NOT_TESTED'),
    protocolConformance: z.literal('NOT_TESTED'),
    interoperability: z.literal('NOT_TESTED'),
  }),
  limitations: z.array(z.string()),
})

export const verifierConstraintsResponseSchema = z.object({
  data: verifierConstraintsResultSchema,
})

/** Every schema published as an OpenAPI component, keyed by component name. */

export const OPENAPI_COMPONENTS = {
  ErrorEnvelope: errorEnvelopeSchema,
  HealthResponse: healthResponseSchema,
  Provider: providerSchema,
  ProviderListResponse: providerListResponseSchema,
  Rulebook: rulebookSchema,
  RulebookResponse: rulebookResponseSchema,
  RulebookPageResponse: rulebookPageSchema,
  Attestation: attestationSchema,
  AttestationDetail: attestationDetailSchema,
  AttestationListResponse: attestationListResponseSchema,
  SchemaReference: schemaReferenceSchema,
  SchemaReferenceListResponse: schemaReferenceListResponseSchema,
  RulebookVersion: rulebookVersionSchema,
  RulebookVersionResponse: rulebookVersionResponseSchema,
  RulebookVersionListResponse: rulebookVersionListResponseSchema,
  RulebookVersionDocument: rulebookVersionDocumentSchema,
  VersionDiff: versionDiffSchema,
  VersionDiffResponse: versionDiffResponseSchema,
  PublicationReadiness: publicationReadinessSchema,
  PublicationReadinessResponse: publicationReadinessResponseSchema,
  PublicationExportManifest: publicationExportManifestSchema,
  PublicationExportManifestResponse: publicationExportManifestResponseSchema,
  CreateRulebookRequest: createRulebookRequestSchema,
  CreateRulebookVersionRequest: createRulebookVersionRequestSchema,
  DraftRulebook: draftRulebookSchema,
  DraftRulebookResponse: draftRulebookResponseSchema,
  SaveDraftRequest: saveDraftRequestSchema,
  ValidateDraftRequest: validateDraftRequestSchema,
  DraftDiagnostic: draftDiagnosticSchema,
  DraftValidation: draftValidationSchema,
  DraftValidationResponse: draftValidationResponseSchema,
  ImportRequest: importRequestSchema,
  ImportPreview: importPreviewSchema,
  ImportPreviewResponse: importPreviewResponseSchema,
  ImportResult: importResultSchema,
  ImportResultResponse: importResultResponseSchema,
  DiscoverIssuerRequest: discoverIssuerRequestSchema,
  IssuerDiscoveryResult: issuerDiscoveryResultSchema,
  IssuerDiscoveryResponse: issuerDiscoveryResponseSchema,
  ValidateCredentialRequest: validateCredentialRequestSchema,
  CredentialValidationResult: credentialValidationResultSchema,
  CredentialValidationResponse: credentialValidationResponseSchema,
  CaptureExplorerListResponse: captureExplorerPageSchema,
  CaptureExplorerDetailResponse: captureExplorerDetailResponseSchema,
  CorrelateCaptureRequest: correlateCaptureRequestSchema,
  CaptureCorrelationResponse: captureCorrelationResponseSchema,
  CompareCaptureRequest: compareCaptureRequestSchema,
  HeadlessWalletComparison: headlessWalletComparisonSchema,
  HeadlessWalletComparisonResponse: headlessWalletComparisonResponseSchema,
  GenerateIssuerFixtureRequest: generateIssuerFixtureRequestSchema,
  IssuerFixture: issuerFixtureSchema,
  IssuerFixtureResponse: issuerFixtureResponseSchema,
  ResolveVerifierConstraintsRequest: resolveVerifierConstraintsRequestSchema,
  VerifierConstraintsResult: verifierConstraintsResultSchema,
  VerifierConstraintsResponse: verifierConstraintsResponseSchema,
} as const

export type OpenApiComponentName = keyof typeof OPENAPI_COMPONENTS

/**
 * Request bodies are documented with Zod's input mode so unknown members stay
 * allowed (the handlers ignore them), matching the behaviour the API documents.
 * Response components use output mode, where an unexpected member is a bug.
 */
const REQUEST_COMPONENT_NAMES: ReadonlySet<OpenApiComponentName> = new Set([
  'CreateRulebookRequest',
  'CreateRulebookVersionRequest',
  'SaveDraftRequest',
  'ValidateDraftRequest',
  'ImportRequest',
  'DiscoverIssuerRequest',
  'ValidateCredentialRequest',
  'CorrelateCaptureRequest',
  'CompareCaptureRequest',
  'GenerateIssuerFixtureRequest',
  'ResolveVerifierConstraintsRequest',
])

/** Generated JSON Schema for one component (OpenAPI 3.1 dialect). */
export function componentJsonSchema(name: OpenApiComponentName): Record<string, unknown> {
  const schema = z.toJSONSchema(OPENAPI_COMPONENTS[name], {
    target: 'draft-2020-12',
    io: REQUEST_COMPONENT_NAMES.has(name) ? 'input' : 'output',
  })
  delete schema.$schema
  return schema
}

// Inferred public resource types. Handlers and tests use these so the wire
// shape and the schema cannot disagree.
export type HealthResource = z.infer<typeof healthResponseSchema>
export type ProviderResource = z.infer<typeof providerSchema>
export type RulebookResource = z.infer<typeof rulebookSchema>
export type AttestationResource = z.infer<typeof attestationSchema>
export type AttestationDetailResource = z.infer<typeof attestationDetailSchema>
export type SchemaReferenceResource = z.infer<typeof schemaReferenceSchema>
export type RulebookVersionResource = z.infer<typeof rulebookVersionSchema>
export type RulebookVersionDocumentResource = z.infer<typeof rulebookVersionDocumentSchema>
export type VersionDiffResource = z.infer<typeof versionDiffSchema>
export type VersionDiffChangeResource = z.infer<typeof versionDiffChangeSchema>
export type PublicationReadinessResource = z.infer<typeof publicationReadinessSchema>
export type PublicationReadinessCheckResource = z.infer<typeof publicationReadinessCheckSchema>
export type PublicationExportManifestResource = z.infer<typeof publicationExportManifestSchema>
export type DraftRulebookResource = z.infer<typeof draftRulebookSchema>
export type DraftDiagnosticResource = z.infer<typeof draftDiagnosticSchema>
export type DraftValidationResource = z.infer<typeof draftValidationSchema>
export type SaveDraftRequestResource = z.infer<typeof saveDraftRequestSchema>
export type RulebookPageResource = z.infer<typeof rulebookPageSchema>
export type ImportPreviewResource = z.infer<typeof importPreviewSchema>
export type ImportResultResource = z.infer<typeof importResultSchema>
export type IssuerDiscoveryResource = z.infer<typeof issuerDiscoveryResultSchema>
export type IssuerFixtureResource = z.infer<typeof issuerFixtureSchema>
export type GenerateIssuerFixtureRequestResource = z.infer<
  typeof generateIssuerFixtureRequestSchema
>
export type CredentialValidationResource = z.infer<typeof credentialValidationResultSchema>
export type CaptureExplorerSummaryResource = z.infer<typeof captureExplorerSummarySchema>
export type CaptureExplorerDetailResource = z.infer<typeof captureExplorerDetailSchema>
export type CaptureExplorerPageResource = z.infer<typeof captureExplorerPageSchema>
export type CaptureCorrelationResource = z.infer<typeof captureCorrelationResultSchema>
export type CompareCaptureRequestResource = z.infer<typeof compareCaptureRequestSchema>
export type HeadlessWalletComparisonResource = z.infer<typeof headlessWalletComparisonSchema>
export type ExternalWalletObservationResource = z.infer<typeof externalWalletObservationSchema>
export type VerifierConstraintsResource = z.infer<typeof verifierConstraintsResultSchema>
export type ResolveVerifierConstraintsRequestResource = z.infer<
  typeof resolveVerifierConstraintsRequestSchema
>
