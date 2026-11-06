// Versioned product API routes and handlers (issue #34).
//
// One declarative route table is the source of truth for both the Hono
// registration and the generated OpenAPI document (./openapi.ts). Every handler
// calls a real service; there are no placeholder success responses. Missing
// wiring (for example a test application without a registry) answers 503
// instead of pretending the endpoint works.

import type { Context, Hono } from 'hono'

import packageJson from '../../package.json'
import { RulebookImporter } from '../import'
import type { ImportPreview, ImportResult, ImportSource } from '../import'
import type { Registry } from '../registry/registry'
import { invalidInput, unauthorized } from '../registry/errors'
import type { CreateRulebookInput, CreateRulebookVersionInput } from '../registry/types'
import { CREDENTIAL_VALIDATION_PATH, type CredentialValidationService } from '../validation'

import { apiError } from './errors'
import type { OpenApiComponentName } from './schemas'
import {
  assertVersionDocument,
  toAttestationResource,
  toCredentialValidationResource,
  toImportPreviewResource,
  toImportResultResource,
  toRulebookResource,
  toRulebookVersionResource,
  toSchemaReferenceResource,
} from './resources'

/** Maximum product-API request body. Import sources are separately bounded. */
export const MAX_API_BODY_BYTES = 4 * 1024 * 1024

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100

/** Every operation is identified by a stable id in the OpenAPI document. */
export type ApiOperationId =
  | 'getHealth'
  | 'listRulebooks'
  | 'getRulebook'
  | 'listRulebookAttestations'
  | 'listRulebookSchemaReferences'
  | 'listRulebookVersions'
  | 'getRulebookVersion'
  | 'getRulebookVersionContent'
  | 'createRulebook'
  | 'createRulebookVersion'
  | 'publishRulebookVersion'
  | 'previewImport'
  | 'importRulebooks'
  | 'validateCredential'

export interface ApiParameterSpec {
  readonly name: string
  readonly in: 'query' | 'path'
  readonly required: boolean
  readonly description: string
  readonly schema: Readonly<Record<string, unknown>>
}

export interface ApiResponseSpec {
  readonly status: number
  readonly description: string
  readonly schema?: OpenApiComponentName
  readonly mediaType?: string
  readonly headers?: readonly {
    readonly name: string
    readonly description: string
  }[]
}

export interface ApiRequestBodySpec {
  readonly schema: OpenApiComponentName
  readonly mediaType: string
  readonly required: boolean
  readonly description: string
}

export interface ApiRouteSpec {
  readonly operationId: ApiOperationId
  readonly method: 'get' | 'post'
  readonly path: string
  readonly summary: string
  readonly description: string
  readonly tag: 'service' | 'rulebooks' | 'versions' | 'imports' | 'credentials'
  /** `true` marks a bearer-authenticated write operation. */
  readonly security: boolean
  readonly request?: ApiRequestBodySpec
  readonly parameters?: readonly ApiParameterSpec[]
  readonly responses: readonly ApiResponseSpec[]
}

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Malformed or invalid request; the body is an ErrorEnvelope with a stable code.',
  401: 'Missing, unknown or revoked bearer token.',
  403: 'The authenticated provider does not own the resource.',
  404: 'The requested resource does not exist.',
  409: 'The request conflicts with the current resource state (duplicate label, stale draft snapshot, published immutability).',
  413: 'The request body exceeds the endpoint limit.',
  422: 'The import source is unsafe, malformed, unsupported or not importable.',
  500: 'Unexpected server failure; no internal details are exposed.',
  502: 'The remote import source could not be fetched.',
  503: 'The required service is not configured on this server.',
}

function errors(...statuses: readonly number[]): readonly ApiResponseSpec[] {
  return statuses.map((status) => ({
    status,
    description: ERROR_DESCRIPTIONS[status] ?? 'Error response.',
    schema: 'ErrorEnvelope',
  }))
}

const PATH_ID: ApiParameterSpec = {
  name: 'rulebookId',
  in: 'path',
  required: true,
  description: 'Stable AttestBook rulebook identifier.',
  schema: { type: 'string' },
}

const PATH_VERSION: ApiParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'Rulebook version label (`MAJOR.MINOR` or `MAJOR.MINOR.PATCH`).',
  schema: { type: 'string' },
}

function pathParameters(ids: readonly string[]): readonly ApiParameterSpec[] {
  return ids.map((id) => {
    if (id === 'rulebookId') {
      return PATH_ID
    }
    if (id === 'version') {
      return PATH_VERSION
    }
    throw new Error(`unknown path parameter ${id}`)
  })
}

/** The versioned product API contract, shared by the router and OpenAPI. */
export const API_ROUTES: readonly ApiRouteSpec[] = [
  {
    operationId: 'getHealth',
    method: 'get',
    path: '/health',
    summary: 'Liveness and build information',
    description:
      'Unversioned operational endpoint used by container health checks; it is not part of the product resource API.',
    tag: 'service',
    security: false,
    responses: [
      { status: 200, description: 'The service is running.', schema: 'HealthResponse' },
      ...errors(500),
    ],
  },
  {
    operationId: 'listRulebooks',
    method: 'get',
    path: '/api/v1/rulebooks',
    summary: 'List rulebooks',
    description:
      'Public catalogue listing with optional provider and publication-status filters. The Phase 1 registry lists the catalogue in memory; `limit` and `offset` are applied after filtering, and `total` is the filtered count.',
    tag: 'rulebooks',
    security: false,
    parameters: [
      {
        name: 'providerId',
        in: 'query',
        required: false,
        description: 'Only return rulebooks owned by this provider.',
        schema: { type: 'string' },
      },
      {
        name: 'status',
        in: 'query',
        required: false,
        description: 'Only return rulebooks in this working-copy state.',
        schema: { type: 'string', enum: ['draft', 'published', 'historical'] },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'Page size (default 50, maximum 100).',
        schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT },
      },
      {
        name: 'offset',
        in: 'query',
        required: false,
        description: 'Number of filtered rulebooks to skip (default 0).',
        schema: { type: 'integer', minimum: 0 },
      },
    ],
    responses: [
      { status: 200, description: 'A page of rulebooks.', schema: 'RulebookPageResponse' },
      ...errors(400, 500, 503),
    ],
  },
  {
    operationId: 'getRulebook',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId',
    summary: 'Get one rulebook',
    description: 'Public catalogue read of one rulebook’s product metadata.',
    tag: 'rulebooks',
    security: false,
    parameters: pathParameters(['rulebookId']),
    responses: [
      { status: 200, description: 'The rulebook.', schema: 'RulebookResponse' },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'listRulebookAttestations',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/attestations',
    summary: 'List a rulebook’s attestation types',
    description:
      'Public read of the attestation types and their schema references as currently authored in the rulebook’s working copy.',
    tag: 'rulebooks',
    security: false,
    parameters: pathParameters(['rulebookId']),
    responses: [
      {
        status: 200,
        description: 'The rulebook’s attestation types with their schema references.',
        schema: 'AttestationListResponse',
      },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'listRulebookSchemaReferences',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/schema-references',
    summary: 'List a rulebook’s schema references',
    description:
      'Public read of every schema reference of the rulebook’s working copy, including rulebook-level references that belong to no attestation type.',
    tag: 'rulebooks',
    security: false,
    parameters: pathParameters(['rulebookId']),
    responses: [
      {
        status: 200,
        description: 'The rulebook’s schema references.',
        schema: 'SchemaReferenceListResponse',
      },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'listRulebookVersions',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/versions',
    summary: 'List a rulebook’s versions',
    description:
      'Public read of draft, published and historical versions in creation order, with their content digests.',
    tag: 'versions',
    security: false,
    parameters: pathParameters(['rulebookId']),
    responses: [
      {
        status: 200,
        description: 'The rulebook’s versions.',
        schema: 'RulebookVersionListResponse',
      },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'getRulebookVersion',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/versions/:version',
    summary: 'Get one rulebook version',
    description: 'Public read of one immutable or draft version record and its content digest.',
    tag: 'versions',
    security: false,
    parameters: pathParameters(['rulebookId', 'version']),
    responses: [
      { status: 200, description: 'The version.', schema: 'RulebookVersionResponse' },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'getRulebookVersionContent',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/versions/:version/content',
    summary: 'Download one rulebook version’s exact snapshot bytes',
    description:
      'Returns the exact bytes whose SHA-256 is the version digest. The media type is the recorded artifact media type, and `Content-Digest` carries the RFC 9530 structured digest so a consumer can verify the bytes.',
    tag: 'versions',
    security: false,
    parameters: pathParameters(['rulebookId', 'version']),
    responses: [
      {
        status: 200,
        description: 'The exact stored snapshot document.',
        schema: 'RulebookVersionDocument',
        mediaType: 'application/vnd.attestbook.rulebook-version+json',
        headers: [
          {
            name: 'Content-Digest',
            description: 'RFC 9530 `sha-256=:<base64>:` of the returned bytes.',
          },
          { name: 'ETag', description: 'Quoted lowercase hex SHA-256 of the returned bytes.' },
        ],
      },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'createRulebook',
    method: 'post',
    path: '/api/v1/rulebooks',
    summary: 'Create a draft rulebook',
    description:
      'Authenticated create of a draft rulebook with optional attestation types and schema references in the same transaction. Internal metadata, provenance and the import identity cannot be set through the API.',
    tag: 'rulebooks',
    security: true,
    request: {
      schema: 'CreateRulebookRequest',
      mediaType: 'application/json',
      required: true,
      description: 'Rulebook content to create.',
    },
    responses: [
      {
        status: 201,
        description: 'The created draft rulebook.',
        schema: 'RulebookResponse',
        headers: [{ name: 'Location', description: 'Canonical path of the created rulebook.' }],
      },
      ...errors(400, 401, 413, 500, 503),
    ],
  },
  {
    operationId: 'createRulebookVersion',
    method: 'post',
    path: '/api/v1/rulebooks/:rulebookId/versions',
    summary: 'Freeze the working copy as a draft version',
    description:
      'Authenticated snapshot of the current rulebook content under a new version label. A duplicate label is a conflict; published and historical versions are immutable.',
    tag: 'versions',
    security: true,
    parameters: pathParameters(['rulebookId']),
    request: {
      schema: 'CreateRulebookVersionRequest',
      mediaType: 'application/json',
      required: true,
      description: 'The new version label.',
    },
    responses: [
      { status: 201, description: 'The created draft version.', schema: 'RulebookVersionResponse' },
      ...errors(400, 401, 403, 404, 409, 413, 500, 503),
    ],
  },
  {
    operationId: 'publishRulebookVersion',
    method: 'post',
    path: '/api/v1/rulebooks/:rulebookId/versions/:version/publish',
    summary: 'Publish a draft version',
    description:
      'Authenticated publication of the owning provider’s draft version after proving its snapshot still matches the current content. Publishing the same already-published version again is an idempotent replay; historical versions cannot be republished.',
    tag: 'versions',
    security: true,
    parameters: pathParameters(['rulebookId', 'version']),
    responses: [
      { status: 200, description: 'The published version.', schema: 'RulebookVersionResponse' },
      ...errors(400, 401, 403, 404, 409, 500, 503),
    ],
  },
  {
    operationId: 'previewImport',
    method: 'post',
    path: '/api/v1/imports/preview',
    summary: 'Preview a URL or JSON rulebook import',
    description:
      'Authenticated, read-only preview of a supported TS11/OWF document or catalog envelope under the bounded SSRF, size, depth and fan-out controls. A preview performs no registry write, but a URL source still causes a bounded outbound fetch, so it requires a provider bearer token.',
    tag: 'imports',
    security: true,
    request: {
      schema: 'ImportRequest',
      mediaType: 'application/json',
      required: true,
      description: 'URL import or inline JSON source to preview.',
    },
    responses: [
      {
        status: 200,
        description: 'The compatibility and provenance preview.',
        schema: 'ImportPreviewResponse',
      },
      ...errors(400, 401, 413, 422, 500, 502, 503),
    ],
  },
  {
    operationId: 'importRulebooks',
    method: 'post',
    path: '/api/v1/imports',
    summary: 'Import compatible rulebooks as drafts',
    description:
      'Authenticated import of a source preview. New entries are created in one transaction, unchanged entries are an idempotent no-op and changed content is reported as a conflict without a write.',
    tag: 'imports',
    security: true,
    request: {
      schema: 'ImportRequest',
      mediaType: 'application/json',
      required: true,
      description: 'URL import or inline JSON source to import.',
    },
    responses: [
      {
        status: 200,
        description: 'Per-entry import dispositions, reported conflicts and created rulebooks.',
        schema: 'ImportResultResponse',
      },
      ...errors(400, 401, 413, 422, 500, 502, 503),
    ],
  },
  {
    operationId: 'validateCredential',
    method: 'post',
    path: CREDENTIAL_VALIDATION_PATH,
    summary: 'Validate one credential against a pinned rulebook version',
    description:
      'Structural SD-JWT VC validation with per-dimension evidence. Cryptographic signature verification, issuer trust, protocol conformance and interoperability are reported explicitly as not tested or not applicable, never as PASS.',
    tag: 'credentials',
    security: false,
    request: {
      schema: 'ValidateCredentialRequest',
      mediaType: 'application/json',
      required: true,
      description: 'Credential, pinned rulebook version and optional schema documents.',
    },
    responses: [
      {
        status: 200,
        description: 'The dimension-aware validation result.',
        schema: 'CredentialValidationResponse',
      },
      ...errors(400, 404, 413, 500, 503),
    ],
  },
]

/** Narrow import seam so tests can double the pipeline without a network. */
export interface ImportService {
  preview(source: ImportSource): Promise<ImportPreview>
  import(accessToken: string, source: ImportSource): Promise<ImportResult>
}

export interface ApiDependencies {
  readonly registry?: Registry
  readonly validation?: CredentialValidationService
  readonly importer?: ImportService
}

export type ApiHandler = (context: Context) => Response | Promise<Response>

function requireRegistry(dependencies: ApiDependencies): Registry {
  if (dependencies.registry === undefined) {
    throw apiError(
      503,
      'registry_unavailable',
      'The rulebook registry is not configured on this server.',
    )
  }
  return dependencies.registry
}

function requireValidation(dependencies: ApiDependencies): CredentialValidationService {
  if (dependencies.validation === undefined) {
    throw apiError(
      503,
      'validation_unavailable',
      'Credential validation is not configured on this server.',
    )
  }
  return dependencies.validation
}

function requireImporter(importer: ImportService | undefined): ImportService {
  if (importer === undefined) {
    throw apiError(
      503,
      'registry_unavailable',
      'The rulebook import pipeline is not configured on this server.',
    )
  }
  return importer
}

function bearerToken(context: Context): string {
  const header = context.req.header('authorization')
  if (header === undefined) {
    throw unauthorized()
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = match?.[1]
  if (token === undefined) {
    throw unauthorized()
  }
  return token
}

/**
 * Reads a JSON request body. A parse failure is a typed 400; the body itself is
 * not included in the message or in logs.
 */
async function readJsonBody(context: Context): Promise<unknown> {
  try {
    return await context.req.json()
  } catch {
    throw invalidInput('The request body must be a JSON object.')
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidInput(`${field} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw invalidInput(`${field} must be a string`)
  }
  return value
}

/**
 * Copies only the public create fields. `metadata`, `provenance` and
 * `importKey` are registry-internal and cannot be injected by a caller.
 */
function parseCreateRulebookInput(body: unknown): CreateRulebookInput {
  const record = requireRecord(body, 'request body')
  const input: Record<string, unknown> = {}
  for (const field of ['name', 'description', 'sourceUrl', 'applicableSpec'] as const) {
    if (record[field] !== undefined) {
      input[field] = record[field]
    }
  }

  const attestations = record.attestations
  if (attestations !== undefined) {
    if (!Array.isArray(attestations)) {
      throw invalidInput('attestations must be an array')
    }
    input.attestations = attestations.map((value, index) => {
      const attestation = requireRecord(value, `attestations[${index}]`)
      const projected: Record<string, unknown> = {}
      for (const field of ['name', 'attestationLoS', 'bindingType', 'supportedFormats'] as const) {
        if (attestation[field] !== undefined) {
          projected[field] = attestation[field]
        }
      }
      const references = attestation.schemaReferences
      if (references !== undefined) {
        if (!Array.isArray(references)) {
          throw invalidInput(`attestations[${index}].schemaReferences must be an array`)
        }
        projected.schemaReferences = references.map((reference, referenceIndex) => {
          const recordReference = requireRecord(
            reference,
            `attestations[${index}].schemaReferences[${referenceIndex}]`,
          )
          const result: Record<string, unknown> = {}
          for (const field of ['formatIdentifier', 'uri', 'integrity'] as const) {
            if (recordReference[field] !== undefined) {
              result[field] = recordReference[field]
            }
          }
          return result
        })
      }
      return projected
    })
  }

  return input as unknown as CreateRulebookInput
}

function parseCreateRulebookVersionInput(body: unknown): CreateRulebookVersionInput {
  const record = requireRecord(body, 'request body')
  return { version: record.version } as CreateRulebookVersionInput
}

/** Validates the request envelope; the import service validates the source. */
function parseImportSource(body: unknown): ImportSource {
  const record = requireRecord(body, 'request body')
  const source = requireRecord(record.source, 'source')

  if (source.kind === 'url') {
    if (typeof source.url !== 'string') {
      throw invalidInput('source.url must be a string')
    }
    return { kind: 'url', url: source.url }
  }

  if (source.kind === 'json') {
    if (typeof source.content !== 'string') {
      throw invalidInput('source.content must be a string')
    }
    const name = optionalString(source.name, 'source.name')
    const sourceUrl = optionalString(source.sourceUrl, 'source.sourceUrl')
    return {
      kind: 'json',
      content: source.content,
      ...(name === undefined ? {} : { name }),
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
    }
  }

  throw invalidInput('source.kind must be "url" or "json"')
}

function parsePositiveInteger(
  raw: string | undefined,
  field: string,
  fallback: number,
  minimum: number,
  maximum?: number,
): number {
  if (raw === undefined) {
    return fallback
  }
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw invalidInput(`${field} must be an integer`)
  }
  const value = Number(raw)
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw invalidInput(
      maximum === undefined
        ? `${field} must be an integer of at least ${minimum}`
        : `${field} must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return value
}

const PUBLICATION_STATUS_VALUES: ReadonlySet<string> = new Set(['draft', 'published', 'historical'])

function parseStatusFilter(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!PUBLICATION_STATUS_VALUES.has(raw)) {
    throw invalidInput('status must be one of "draft", "published" or "historical"')
  }
  return raw
}

function sha256StructuredDigest(hexDigest: string): string {
  return `sha-256=:${Buffer.from(hexDigest, 'hex').toString('base64')}:`
}

function healthHandler(): ApiHandler {
  return (context) =>
    context.json(
      {
        status: 'ok' as const,
        service: 'attestbook' as const,
        version: packageJson.version,
      },
      200,
    )
}

function listRulebooksHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const providerId = context.req.query('providerId')
    const status = parseStatusFilter(context.req.query('status'))
    const limit = parsePositiveInteger(
      context.req.query('limit'),
      'limit',
      DEFAULT_PAGE_LIMIT,
      1,
      MAX_PAGE_LIMIT,
    )
    const offset = parsePositiveInteger(context.req.query('offset'), 'offset', 0, 0)

    const filtered = registry
      .listRulebooks(providerId === undefined ? {} : { providerId })
      .filter((rulebook) => status === undefined || rulebook.publicationStatus === status)
    const data = filtered.slice(offset, offset + limit).map(toRulebookResource)
    return context.json({ data, pagination: { limit, offset, total: filtered.length } }, 200)
  }
}

function getRulebookHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const rulebook = registry.getRulebook(context.req.param('rulebookId') ?? '')
    if (rulebook === null) {
      throw apiError(404, 'not_found', 'The requested rulebook does not exist.')
    }
    return context.json({ data: toRulebookResource(rulebook) }, 200)
  }
}

function listRulebookAttestationsHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const rulebookId = context.req.param('rulebookId') ?? ''
    if (registry.getRulebook(rulebookId) === null) {
      throw apiError(404, 'not_found', 'The requested rulebook does not exist.')
    }
    const references = registry.listSchemaReferences(rulebookId)
    const data = registry.listAttestations(rulebookId).map((attestation) =>
      toAttestationResource(
        attestation,
        references.filter((reference) => reference.attestationId === attestation.id),
      ),
    )
    return context.json({ data }, 200)
  }
}

function listRulebookSchemaReferencesHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const rulebookId = context.req.param('rulebookId') ?? ''
    if (registry.getRulebook(rulebookId) === null) {
      throw apiError(404, 'not_found', 'The requested rulebook does not exist.')
    }
    return context.json(
      { data: registry.listSchemaReferences(rulebookId).map(toSchemaReferenceResource) },
      200,
    )
  }
}

function listRulebookVersionsHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    return context.json(
      {
        data: registry
          .listRulebookVersions(context.req.param('rulebookId') ?? '')
          .map(toRulebookVersionResource),
      },
      200,
    )
  }
}

function getRulebookVersionHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const version = registry.getRulebookVersion(
      context.req.param('rulebookId') ?? '',
      context.req.param('version') ?? '',
    )
    if (version === null) {
      throw apiError(404, 'not_found', 'The requested rulebook version does not exist.')
    }
    return context.json({ data: toRulebookVersionResource(version) }, 200)
  }
}

function getRulebookVersionContentHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const content = registry.getRulebookVersionContent(
      context.req.param('rulebookId') ?? '',
      context.req.param('version') ?? '',
    )
    if (content === null) {
      throw apiError(404, 'not_found', 'The requested rulebook version does not exist.')
    }
    // The stored bytes are returned unchanged; validating the document shape
    // must not re-serialize them, or the content digest would stop matching.
    assertVersionDocument(content.bytes)
    // Copy into a plain ArrayBuffer-backed view: Hono's body type does not
    // accept a `Uint8Array<ArrayBufferLike>` bound (for example a Buffer view).
    const bytes = new Uint8Array(content.bytes)
    return context.body(bytes, 200, {
      'content-type': content.mediaType,
      'content-digest': sha256StructuredDigest(content.version.contentDigest),
      etag: `"${content.version.contentDigest}"`,
    })
  }
}

function createRulebookHandler(dependencies: ApiDependencies): ApiHandler {
  return async (context) => {
    const registry = requireRegistry(dependencies)
    const token = bearerToken(context)
    const rulebook = registry.createRulebook(
      token,
      parseCreateRulebookInput(await readJsonBody(context)),
    )
    return context.json({ data: toRulebookResource(rulebook) }, 201, {
      Location: `/api/v1/rulebooks/${rulebook.id}`,
    })
  }
}

function createRulebookVersionHandler(dependencies: ApiDependencies): ApiHandler {
  return async (context) => {
    const registry = requireRegistry(dependencies)
    const token = bearerToken(context)
    const version = registry.createRulebookVersion(
      token,
      context.req.param('rulebookId') ?? '',
      parseCreateRulebookVersionInput(await readJsonBody(context)),
    )
    return context.json({ data: toRulebookVersionResource(version) }, 201, {
      Location: `/api/v1/rulebooks/${version.rulebookId}/versions/${version.version}`,
    })
  }
}

function publishRulebookVersionHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const token = bearerToken(context)
    const rulebookId = context.req.param('rulebookId') ?? ''
    const label = context.req.param('version') ?? ''

    // Authenticate and authorize explicitly so an idempotent replay answers
    // consistently instead of throwing an immutability conflict.
    const actor = registry.authenticate(token)
    const rulebook = registry.getRulebook(rulebookId)
    if (rulebook === null) {
      throw apiError(404, 'not_found', 'The requested rulebook does not exist.')
    }
    if (rulebook.providerId !== actor.providerId) {
      throw apiError(403, 'forbidden', 'The authenticated provider does not own this resource.')
    }
    const existing = registry.getRulebookVersion(rulebookId, label)
    if (existing === null) {
      throw apiError(404, 'not_found', 'The requested rulebook version does not exist.')
    }
    if (existing.status === 'published') {
      return context.json({ data: toRulebookVersionResource(existing) }, 200)
    }
    if (existing.status === 'historical') {
      throw apiError(
        409,
        'immutable',
        'The version is historical; a superseded version cannot be republished.',
      )
    }

    const published = registry.publishRulebookVersion(token, rulebookId, label)
    return context.json({ data: toRulebookVersionResource(published) }, 200)
  }
}

function previewImportHandler(importer: ImportService | undefined): ApiHandler {
  return async (context) => {
    const service = requireImporter(importer)
    const source = parseImportSource(await readJsonBody(context))
    const preview = await service.preview(source)
    return context.json({ data: toImportPreviewResource(preview) }, 200)
  }
}

function importRulebooksHandler(importer: ImportService | undefined): ApiHandler {
  return async (context) => {
    const service = requireImporter(importer)
    const token = bearerToken(context)
    const source = parseImportSource(await readJsonBody(context))
    const result = await service.import(token, source)
    return context.json({ data: toImportResultResource(result) }, 200)
  }
}

function validateCredentialHandler(dependencies: ApiDependencies): ApiHandler {
  return async (context) => {
    const validation = requireValidation(dependencies)
    const body = await readJsonBody(context)
    const result = await validation.validate(body)
    return context.json({ data: toCredentialValidationResource(result) }, 200)
  }
}

/**
 * Builds the handler for every operation. The `Record<ApiOperationId, ...>`
 * type makes a route without a handler a compile-time error.
 */
export function createApiHandlers(
  dependencies: ApiDependencies,
): Record<ApiOperationId, ApiHandler> {
  const importer =
    dependencies.importer ??
    (dependencies.registry === undefined
      ? undefined
      : new RulebookImporter({ registry: dependencies.registry }))

  return {
    getHealth: healthHandler(),
    listRulebooks: listRulebooksHandler(dependencies),
    getRulebook: getRulebookHandler(dependencies),
    listRulebookAttestations: listRulebookAttestationsHandler(dependencies),
    listRulebookSchemaReferences: listRulebookSchemaReferencesHandler(dependencies),
    listRulebookVersions: listRulebookVersionsHandler(dependencies),
    getRulebookVersion: getRulebookVersionHandler(dependencies),
    getRulebookVersionContent: getRulebookVersionContentHandler(dependencies),
    createRulebook: createRulebookHandler(dependencies),
    createRulebookVersion: createRulebookVersionHandler(dependencies),
    publishRulebookVersion: publishRulebookVersionHandler(dependencies),
    previewImport: previewImportHandler(importer),
    importRulebooks: importRulebooksHandler(importer),
    validateCredential: validateCredentialHandler(dependencies),
  }
}

/**
 * Runs the route-declared bearer check before the handler, and therefore before
 * any request body is read. The contract's `security` flag is the only place
 * that decides which operations are protected, so a protected route cannot
 * forget the check.
 */
function authenticated(dependencies: ApiDependencies, handler: ApiHandler): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    registry.authenticate(bearerToken(context))
    return handler(context)
  }
}

/** Registers every contract-defined route on the Hono application. */
export function registerApiRoutes(app: Hono, dependencies: ApiDependencies): void {
  const handlers = createApiHandlers(dependencies)
  for (const route of API_ROUTES) {
    const handler = handlers[route.operationId]
    app.on(
      route.method,
      route.path,
      route.security ? authenticated(dependencies, handler) : handler,
    )
  }
}
