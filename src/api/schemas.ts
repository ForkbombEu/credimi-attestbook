// Typed request/response schemas for the versioned product API (issue #34).
//
// These Zod schemas are the single source of truth for the OpenAPI components
// (generated with `z.toJSONSchema` in ./openapi.ts) and are also used to
// validate what the handlers actually return in the contract tests. The
// internal registry metadata that the registry service stores (provenance,
// metadata and the import identity) is deliberately absent: representations in
// this module are the public projection of those services.

import { z } from 'zod'

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
  ValidateCredentialRequest: validateCredentialRequestSchema,
  CredentialValidationResult: credentialValidationResultSchema,
  CredentialValidationResponse: credentialValidationResponseSchema,
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
  'ValidateCredentialRequest',
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
export type DraftRulebookResource = z.infer<typeof draftRulebookSchema>
export type DraftDiagnosticResource = z.infer<typeof draftDiagnosticSchema>
export type DraftValidationResource = z.infer<typeof draftValidationSchema>
export type SaveDraftRequestResource = z.infer<typeof saveDraftRequestSchema>
export type RulebookPageResource = z.infer<typeof rulebookPageSchema>
export type ImportPreviewResource = z.infer<typeof importPreviewSchema>
export type ImportResultResource = z.infer<typeof importResultSchema>
export type CredentialValidationResource = z.infer<typeof credentialValidationResultSchema>
