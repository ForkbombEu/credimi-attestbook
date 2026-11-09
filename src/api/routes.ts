// Versioned product API routes and handlers (issue #34).
//
// One declarative route table is the source of truth for both the Hono
// registration and the generated OpenAPI document (./openapi.ts). Every handler
// calls a real service; there are no placeholder success responses. Missing
// wiring (for example a test application without a registry) answers 503
// instead of pretending the endpoint works.

import type { Context, Hono } from 'hono'

import packageJson from '../../package.json'
import {
  createMockCaptureExplorer,
  DEFAULT_CAPTURE_PAGE_LIMIT,
  MAX_CAPTURE_PAGE_LIMIT,
  type CaptureExplorer,
} from '../capture'
import { IssuerDiscovery, type IssuerDiscoveryService } from '../discovery'
import { validateDraftContent } from '../editor'
import {
  ISSUER_FIXTURE_PATH,
  IssuerFixtureGenerator,
  IssuerFixtureUnavailableError,
  type IssuerFixtureService,
} from '../fixtures'
import { RulebookImporter } from '../import'
import type { ImportPreview, ImportResult, ImportSource } from '../import'
import { assessPublicationReadiness, compareVersionDocuments } from '../lifecycle'
import { buildPublicationExportManifest, publicationExportFilename } from '../publication'
import type { PublicationExportManifest } from '../publication'
import type { Registry } from '../registry/registry'
import { invalidInput, unauthorized } from '../registry/errors'
import type {
  CreateRulebookInput,
  CreateRulebookVersionInput,
  ReplaceDraftContentInput,
  RulebookVersionContent,
} from '../registry/types'
import { parseRulebookVersionDocument, type RulebookVersionDocument } from '../registry/versioning'
import { CREDENTIAL_VALIDATION_PATH, type CredentialValidationService } from '../validation'
import {
  VERIFIER_CONSTRAINTS_PATH,
  VerifierPolicyResolver,
  type VerifierPolicyService,
} from '../verifier'

import { apiError } from './errors'
import type { OpenApiComponentName } from './schemas'
import {
  assertVersionDocument,
  toAttestationResource,
  toCaptureCorrelationResource,
  toCaptureExplorerDetailResource,
  toCaptureExplorerPageResource,
  toDraftRulebookResource,
  toProviderResource,
  toCredentialValidationResource,
  toImportPreviewResource,
  toImportResultResource,
  toIssuerDiscoveryResource,
  toIssuerFixtureResource,
  toPublicationExportManifestResource,
  toPublicationReadinessResource,
  toRulebookResource,
  toRulebookVersionResource,
  toSchemaReferenceResource,
  toVerifierConstraintsResource,
  toVersionDiffResource,
} from './resources'

/** Maximum product-API request body. Import sources are separately bounded. */
export const MAX_API_BODY_BYTES = 4 * 1024 * 1024

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100

/** Every operation is identified by a stable id in the OpenAPI document. */
export type ApiOperationId =
  | 'getHealth'
  | 'listProviders'
  | 'listRulebooks'
  | 'getRulebook'
  | 'getRulebookDraft'
  | 'replaceRulebookDraft'
  | 'validateRulebookDraft'
  | 'listRulebookAttestations'
  | 'listRulebookSchemaReferences'
  | 'listRulebookVersions'
  | 'getRulebookVersion'
  | 'getRulebookVersionContent'
  | 'createRulebook'
  | 'createRulebookVersion'
  | 'refreshRulebookVersion'
  | 'publishRulebookVersion'
  | 'compareRulebookVersions'
  | 'getRulebookPublicationReadiness'
  | 'exportRulebookVersion'
  | 'getRulebookVersionExportManifest'
  | 'previewImport'
  | 'importRulebooks'
  | 'discoverIssuer'
  | 'generateIssuerFixture'
  | 'validateCredential'
  | 'listCaptures'
  | 'getCapture'
  | 'validateCapture'
  | 'resolveVerifierConstraints'

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
  readonly method: 'get' | 'post' | 'put'
  readonly path: string
  readonly summary: string
  readonly description: string
  readonly tag:
    | 'service'
    | 'providers'
    | 'rulebooks'
    | 'versions'
    | 'imports'
    | 'issuers'
    | 'credentials'
    | 'captures'
    | 'verifiers'
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
    ...(status === 401
      ? {
          headers: [
            {
              name: 'WWW-Authenticate',
              description: 'RFC 6750 bearer challenge; sent on every 401 response.',
            },
          ],
        }
      : {}),
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

const PATH_CAPTURE_ID: ApiParameterSpec = {
  name: 'captureId',
  in: 'path',
  required: true,
  description: 'Stable capture identifier carried by the normalized envelope.',
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
    operationId: 'listProviders',
    method: 'get',
    path: '/api/v1/providers',
    summary: 'List public providers',
    description:
      'Public catalogue read of the provider identities that own rulebooks. Only the public projection (id, name, createdAt) is returned; publication authority, internal metadata and tokens never leave the registry.',
    tag: 'providers',
    security: false,
    responses: [
      { status: 200, description: 'The known providers.', schema: 'ProviderListResponse' },
      ...errors(500, 503),
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
    operationId: 'getRulebookDraft',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/draft',
    summary: 'Get one rulebook’s draft working copy',
    description:
      'Public read of the working copy as one editable document: metadata, attestation types with their schema references, and rulebook-level schema references. It is the same data as the per-resource reads and carries no registry-internal metadata.',
    tag: 'rulebooks',
    security: false,
    parameters: pathParameters(['rulebookId']),
    responses: [
      { status: 200, description: 'The draft working copy.', schema: 'DraftRulebookResponse' },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'replaceRulebookDraft',
    method: 'put',
    path: '/api/v1/rulebooks/:rulebookId/draft',
    summary: 'Replace one rulebook’s draft working copy',
    description:
      'Authenticated full replacement of the owning provider’s draft working copy. Only a draft rulebook can be changed; published and historical rulebooks answer 409 and frozen version snapshots and their artifacts are never modified. The previous working copy survives a validation failure.',
    tag: 'rulebooks',
    security: true,
    parameters: pathParameters(['rulebookId']),
    request: {
      schema: 'SaveDraftRequest',
      mediaType: 'application/json',
      required: true,
      description: 'The replacement draft document.',
    },
    responses: [
      {
        status: 200,
        description: 'The persisted draft working copy.',
        schema: 'DraftRulebookResponse',
      },
      ...errors(400, 401, 403, 404, 409, 413, 500, 503),
    ],
  },
  {
    operationId: 'validateRulebookDraft',
    method: 'post',
    path: '/api/v1/rulebooks/validate-draft',
    summary: 'Validate an unsaved draft document',
    description:
      'Read-only live validation of a draft document. Structural findings mirror the registry’s save-time bounds; attestation types are then checked against the pinned TS11 v1.0.1 baseline through the standards adapter. It writes nothing and makes no conformance claim.',
    tag: 'rulebooks',
    security: false,
    request: {
      schema: 'ValidateDraftRequest',
      mediaType: 'application/json',
      required: true,
      description: 'The draft document to validate.',
    },
    responses: [
      {
        status: 200,
        description: 'Validation findings and their explicit limitations.',
        schema: 'DraftValidationResponse',
      },
      ...errors(400, 413, 500),
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
    operationId: 'refreshRulebookVersion',
    method: 'post',
    path: '/api/v1/rulebooks/:rulebookId/versions/:version/refresh',
    summary: 'Refresh a draft version snapshot',
    description:
      'Authenticated re-snapshot of the owning provider’s draft version from the current working copy. An unchanged snapshot is an idempotent no-op. Published and historical versions are immutable and answer `409 immutable`.',
    tag: 'versions',
    security: true,
    parameters: pathParameters(['rulebookId', 'version']),
    responses: [
      {
        status: 200,
        description: 'The refreshed draft version.',
        schema: 'RulebookVersionResponse',
      },
      ...errors(400, 401, 403, 404, 409, 500, 503),
    ],
  },
  {
    operationId: 'compareRulebookVersions',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/versions/:version/compare',
    summary: 'Compare two version snapshots',
    description:
      'Public, deterministic structural comparison of the authored content of two snapshots. Identity fields (`format`, `rulebookId` and the version label) are excluded, so two labels with the same content compare as identical. Changes carry JSON Pointer paths and are sorted by path.',
    tag: 'versions',
    security: false,
    parameters: [
      ...pathParameters(['rulebookId', 'version']),
      {
        name: 'to',
        in: 'query',
        required: true,
        description: 'Version label to compare against; the path version is the baseline.',
        schema: { type: 'string' },
      },
    ],
    responses: [
      { status: 200, description: 'The deterministic comparison.', schema: 'VersionDiffResponse' },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'getRulebookPublicationReadiness',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/versions/:version/publication-readiness',
    summary: 'Check whether a version can be published',
    description:
      'Public pre-publication assessment of one stored version: draft state, snapshot digest integrity, freshness against the working copy, content validation, standards profile and attestation types. Readiness is not a publication and not a conformance claim.',
    tag: 'versions',
    security: false,
    parameters: pathParameters(['rulebookId', 'version']),
    responses: [
      {
        status: 200,
        description: 'The publication-readiness checks and limitations.',
        schema: 'PublicationReadinessResponse',
      },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'exportRulebookVersion',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/versions/:version/export',
    summary: 'Export a published rulebook artifact',
    description:
      'Public download of the exact, immutable bytes of a published or historical version. The `content-digest` and `ETag` headers carry the SHA-256 of the bytes, which are never re-serialized. Draft versions are not publication artifacts and answer `409 conflict`.',
    tag: 'versions',
    security: false,
    parameters: pathParameters(['rulebookId', 'version']),
    responses: [
      {
        status: 200,
        description: 'The exact published artifact bytes.',
        schema: 'RulebookVersionDocument',
        mediaType: 'application/vnd.attestbook.rulebook-version+json',
        headers: [
          {
            name: 'Content-Digest',
            description: 'RFC 9530 structured SHA-256 digest of the exact bytes.',
          },
          { name: 'ETag', description: 'Quoted SHA-256 hex digest of the exact bytes.' },
          {
            name: 'Content-Disposition',
            description: 'Attachment filename derived from the frozen rulebook name and version.',
          },
        ],
      },
      {
        status: 409,
        description:
          'The version is a draft; only a published or historical artifact can be exported.',
        schema: 'ErrorEnvelope',
      },
      ...errors(404, 500, 503),
    ],
  },
  {
    operationId: 'getRulebookVersionExportManifest',
    method: 'get',
    path: '/api/v1/rulebooks/:rulebookId/versions/:version/export/manifest',
    summary: 'Read a publication export manifest',
    description:
      'Public manifest of a published or historical artifact: stable identity, frozen rulebook fields, SHA-256 content digest, publication time, provenance, the integrity result and the explicit signature boundary. The manifest depends only on frozen version data, so repeated exports are identical. Draft versions answer `409 conflict`.',
    tag: 'versions',
    security: false,
    parameters: pathParameters(['rulebookId', 'version']),
    responses: [
      {
        status: 200,
        description: 'The publication export manifest.',
        schema: 'PublicationExportManifestResponse',
      },
      {
        status: 409,
        description:
          'The version is a draft; only a published or historical artifact has a publication manifest.',
        schema: 'ErrorEnvelope',
      },
      ...errors(404, 500, 503),
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
    operationId: 'discoverIssuer',
    method: 'post',
    path: '/api/v1/issuers/discover',
    summary: 'Discover issuer credential configurations',
    description:
      'Authenticated, read-only OpenID4VCI credential issuer metadata discovery. Retrieval uses the bounded SSRF, timeout, redirect and size controls of the untrusted-import pipeline; the response reports formats, type identifiers, exposed schema references and candidate associations with exact published or historical rulebook versions. Ambiguous and unmatched configurations are reported explicitly. Issuer metadata is never treated as rulebook content.',
    tag: 'issuers',
    security: true,
    request: {
      schema: 'DiscoverIssuerRequest',
      mediaType: 'application/json',
      required: true,
      description: 'Credential issuer identifier whose well-known metadata is discovered.',
    },
    responses: [
      {
        status: 200,
        description:
          'The discovered configurations, their candidate rulebook mappings, diagnostics and limitations.',
        schema: 'IssuerDiscoveryResponse',
      },
      ...errors(400, 401, 413, 422, 500, 502, 503),
    ],
  },
  {
    operationId: 'generateIssuerFixture',
    method: 'post',
    path: ISSUER_FIXTURE_PATH,
    summary: 'Generate unsigned issuer fixtures from a pinned rulebook version',
    description:
      'Synthesizes an unsigned credential claim payload from the JSON Schema 2020-12 attribute constraints that the selected attestation type references in one pinned rulebook version. The caller supplies the exact schema document bytes; they are matched to the version references and verified against their sha256 SRI value before grounding the payload. Attribute definitions, deterministic overrides and labelled negative cases are returned. The payload is never signed or issued and is validated only against the supplied schema documents.',
    tag: 'issuers',
    security: false,
    request: {
      schema: 'GenerateIssuerFixtureRequest',
      mediaType: 'application/json',
      required: true,
      description:
        'Pinned rulebook version, attestation type, the exact schema documents and optional attribute overrides.',
    },
    responses: [
      {
        status: 200,
        description:
          'The unsigned payload, its attribute definitions, applied overrides, verified negative cases, diagnostics and limitations.',
        schema: 'IssuerFixtureResponse',
      },
      ...errors(400, 404, 413, 500, 503),
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
  {
    operationId: 'listCaptures',
    method: 'get',
    path: '/api/v1/captures',
    summary: 'List normalized capture evidence',
    description:
      'Mock-backed capture explorer read. Every entry is labelled transport "mock": the deterministic local mock source serves the evidence and no live capture-issuer or capture-verifier endpoint is contacted. A summary carries the source, correlation identifiers, the opaque test-execution reference, the declared redaction, the linked rulebook binding and validation summary, and the explicit evidence gaps. The raw artifact is never returned.',
    tag: 'captures',
    security: false,
    parameters: [
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'Page size (default 50, maximum 100).',
        schema: { type: 'integer', minimum: 1, maximum: MAX_CAPTURE_PAGE_LIMIT },
      },
      {
        name: 'offset',
        in: 'query',
        required: false,
        description: 'Number of capture entries to skip (default 0).',
        schema: { type: 'integer', minimum: 0 },
      },
    ],
    responses: [
      {
        status: 200,
        description: 'A page of normalized capture evidence.',
        schema: 'CaptureExplorerListResponse',
      },
      ...errors(400, 500, 502, 503),
    ],
  },
  {
    operationId: 'getCapture',
    method: 'get',
    path: '/api/v1/captures/:captureId',
    summary: 'Get one capture with its redacted evidence and correlation',
    description:
      'One mock-backed capture as a redacted default-policy projection, with its evidence timeline, the opaque test-execution reference, the declared redaction and explicit gaps for evidence that is absent. When a validation has been recorded, the detail carries the exact pinned rulebook version and digest and the structural findings. External references are not fetched and the segregated raw artifact is never returned.',
    tag: 'captures',
    security: false,
    parameters: [PATH_CAPTURE_ID],
    responses: [
      {
        status: 200,
        description: 'The capture detail and its redacted evidence projection.',
        schema: 'CaptureExplorerDetailResponse',
      },
      ...errors(400, 404, 500, 502, 503),
    ],
  },
  {
    operationId: 'validateCapture',
    method: 'post',
    path: '/api/v1/captures/:captureId/validate',
    summary: 'Bind a captured credential to a pinned rulebook version',
    description:
      "Runs the structural credential engine on the capture's segregated inline artifact and records the correlation between the capture identifier, the opaque correlation and test-execution references, and the exact pinned rulebook version and digest. An external reference is not fetched, and non-credential evidence answers 409 instead of being validated. A structural status never implies cryptographic, issuer-trust, protocol or interoperability success. Requires a provider bearer token: the correlation is recorded server-side and shown to every reader.",
    tag: 'captures',
    security: true,
    parameters: [PATH_CAPTURE_ID],
    request: {
      schema: 'CorrelateCaptureRequest',
      mediaType: 'application/json',
      required: true,
      description: 'The rulebook identifier, version and attestation type to pin the capture to.',
    },
    responses: [
      {
        status: 200,
        description: 'The recorded correlation and the structural validation result.',
        schema: 'CaptureCorrelationResponse',
      },
      ...errors(400, 401, 404, 409, 413, 500, 502, 503),
    ],
  },
  {
    operationId: 'resolveVerifierConstraints',
    method: 'post',
    path: VERIFIER_CONSTRAINTS_PATH,
    summary: 'Expose rulebook constraints and partial OpenID4VP-aware mappings',
    description:
      'Returns the typed attribute and format constraints of one pinned rulebook version, plus the verifier-policy interfaces AttestBook can map them to. The caller supplies the exact JSON Schema document bytes; each document must match its reference URI and sha256 SRI value before its constraints are inspected. The OpenID4VP DCQL mapping is an explicitly partial query fragment: the result is not a presentation request, carries no proof and reports every unsupported mapping instead of fabricating one.',
    tag: 'verifiers',
    security: false,
    request: {
      schema: 'ResolveVerifierConstraintsRequest',
      mediaType: 'application/json',
      required: true,
      description:
        'Pinned rulebook version, attestation type, optional format and the exact schema documents.',
    },
    responses: [
      {
        status: 200,
        description:
          'Typed verifier constraints, partial OpenID4VP DCQL mappings, unsupported mappings, diagnostics and limitations.',
        schema: 'VerifierConstraintsResponse',
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
  /** Mock-backed capture explorer; seeded from the validation service when absent. */
  readonly captures?: CaptureExplorer
  readonly importer?: ImportService
  readonly issuerDiscovery?: IssuerDiscoveryService
  readonly issuerFixtures?: IssuerFixtureService
  readonly verifierPolicy?: VerifierPolicyService
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

function requireCaptures(explorer: CaptureExplorer | undefined): CaptureExplorer {
  if (explorer === undefined) {
    throw apiError(
      503,
      'capture_unavailable',
      'The capture explorer is not configured on this server.',
    )
  }
  return explorer
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

function requireIssuerFixtures(service: IssuerFixtureService | undefined): IssuerFixtureService {
  if (service === undefined) {
    throw apiError(
      503,
      'registry_unavailable',
      'The issuer fixture generator is not configured on this server.',
    )
  }
  return service
}

function requireIssuerDiscovery(
  service: IssuerDiscoveryService | undefined,
): IssuerDiscoveryService {
  if (service === undefined) {
    throw apiError(
      503,
      'registry_unavailable',
      'The issuer discovery pipeline is not configured on this server.',
    )
  }
  return service
}

function requireVerifierPolicy(service: VerifierPolicyService | undefined): VerifierPolicyService {
  if (service === undefined) {
    throw apiError(
      503,
      'registry_unavailable',
      'The verifier policy resolver is not configured on this server.',
    )
  }
  return service
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
            if (recordReference[field] !== undefined && recordReference[field] !== null) {
              result[field] = recordReference[field]
            }
          }
          return result
        })
      }
      return projected
    })
  }

  const schemaReferences = record.schemaReferences
  if (schemaReferences !== undefined) {
    if (!Array.isArray(schemaReferences)) {
      throw invalidInput('schemaReferences must be an array')
    }
    input.schemaReferences = schemaReferences.map((reference, index) => {
      const recordReference = requireRecord(reference, `schemaReferences[${index}]`)
      const result: Record<string, unknown> = {}
      for (const field of ['formatIdentifier', 'uri', 'integrity'] as const) {
        if (recordReference[field] !== undefined && recordReference[field] !== null) {
          result[field] = recordReference[field]
        }
      }
      return result
    })
  }

  return input as unknown as CreateRulebookInput
}

/**
 * Copies only the public draft fields. Publication state, provenance, provider
 * ownership and registry-internal metadata cannot be injected by a caller.
 */
function parseDraftContentInput(body: unknown): ReplaceDraftContentInput {
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
            if (recordReference[field] !== undefined && recordReference[field] !== null) {
              result[field] = recordReference[field]
            }
          }
          return result
        })
      }
      return projected
    })
  }

  const schemaReferences = record.schemaReferences
  if (schemaReferences !== undefined) {
    if (!Array.isArray(schemaReferences)) {
      throw invalidInput('schemaReferences must be an array')
    }
    input.schemaReferences = schemaReferences.map((reference, index) => {
      const recordReference = requireRecord(reference, `schemaReferences[${index}]`)
      const result: Record<string, unknown> = {}
      for (const field of ['formatIdentifier', 'uri', 'integrity'] as const) {
        if (recordReference[field] !== undefined && recordReference[field] !== null) {
          result[field] = recordReference[field]
        }
      }
      return result
    })
  }

  return input as unknown as ReplaceDraftContentInput
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

function listProvidersHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    return context.json({ data: registry.listProviders().map(toProviderResource) }, 200)
  }
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

function getRulebookDraftHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const content = registry.getDraftContent(context.req.param('rulebookId') ?? '')
    return context.json({ data: toDraftRulebookResource(content) }, 200)
  }
}

function replaceRulebookDraftHandler(dependencies: ApiDependencies): ApiHandler {
  return async (context) => {
    const registry = requireRegistry(dependencies)
    const token = bearerToken(context)
    const content = registry.replaceDraftContent(
      token,
      context.req.param('rulebookId') ?? '',
      parseDraftContentInput(await readJsonBody(context)),
    )
    return context.json({ data: toDraftRulebookResource(content) }, 200)
  }
}

function validateRulebookDraftHandler(): ApiHandler {
  return async (context) => {
    const report = validateDraftContent(await readJsonBody(context))
    return context.json({ data: report }, 200)
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

function refreshRulebookVersionHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const token = bearerToken(context)
    const refreshed = registry.refreshDraftRulebookVersion(
      token,
      context.req.param('rulebookId') ?? '',
      context.req.param('version') ?? '',
    )
    return context.json({ data: toRulebookVersionResource(refreshed) }, 200)
  }
}

function compareRulebookVersionsHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const rulebookId = context.req.param('rulebookId') ?? ''
    const fromLabel = context.req.param('version') ?? ''
    const toLabel = context.req.query('to')
    if (toLabel === undefined || toLabel.trim() === '') {
      throw invalidInput('to must name the version to compare against')
    }

    const from = registry.getRulebookVersionContent(rulebookId, fromLabel)
    if (from === null) {
      throw apiError(404, 'not_found', 'The requested rulebook version does not exist.')
    }
    const to = registry.getRulebookVersionContent(rulebookId, toLabel.trim())
    if (to === null) {
      throw apiError(404, 'not_found', 'The requested rulebook version does not exist.')
    }
    const diff = compareVersionDocuments(
      parseRulebookVersionDocument(from.bytes),
      parseRulebookVersionDocument(to.bytes),
    )
    return context.json({ data: toVersionDiffResource(from.version, to.version, diff) }, 200)
  }
}

function getRulebookPublicationReadinessHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const rulebookId = context.req.param('rulebookId') ?? ''
    const label = context.req.param('version') ?? ''
    // The registry builds the stored artifact and the current working-copy
    // bytes exactly as publish does, so readiness cannot drift from publication.
    const candidate = registry.getPublicationCandidate(rulebookId, label)
    if (candidate === null) {
      throw apiError(404, 'not_found', 'The requested rulebook version does not exist.')
    }
    const { rulebook, content, currentBytes } = candidate
    const readiness = assessPublicationReadiness({
      version: content.version,
      rulebookStatus: rulebook.publicationStatus,
      bytes: content.bytes,
      currentBytes,
      document: parseRulebookVersionDocument(content.bytes),
    })
    return context.json({ data: toPublicationReadinessResource(content.version, readiness) }, 200)
  }
}

interface PublicationArtifactView {
  readonly content: RulebookVersionContent
  readonly document: RulebookVersionDocument
  readonly manifest: PublicationExportManifest
}

/**
 * Loads one exportable artifact and its manifest. Draft versions are rejected
 * before any manifest is built: a working copy is not a publication artifact.
 * The stored digest is recomputed by the manifest builder, so a corrupt
 * artifact fails the request instead of being exported as verified.
 */
function requirePublicationArtifact(
  dependencies: ApiDependencies,
  context: Context,
): PublicationArtifactView {
  const registry = requireRegistry(dependencies)
  const content = registry.getRulebookVersionContent(
    context.req.param('rulebookId') ?? '',
    context.req.param('version') ?? '',
  )
  if (content === null) {
    throw apiError(404, 'not_found', 'The requested rulebook version does not exist.')
  }
  if (content.version.status === 'draft') {
    throw apiError(
      409,
      'conflict',
      'The version is a draft; only published or historical versions are publication artifacts and can be exported.',
    )
  }
  const rulebook = registry.getRulebook(content.version.rulebookId)
  if (rulebook === null) {
    throw new Error('rulebook version references a missing rulebook')
  }
  // The snapshot shape is validated as on the content route; a malformed stored
  // artifact is a server fault, never a successful export.
  assertVersionDocument(content.bytes)
  const document = parseRulebookVersionDocument(content.bytes)
  const manifest = buildPublicationExportManifest({
    version: content.version,
    providerId: rulebook.providerId,
    mediaType: content.mediaType,
    bytes: content.bytes,
    document,
  })
  return { content, document, manifest }
}

function exportRulebookVersionHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const { content, document } = requirePublicationArtifact(dependencies, context)
    // Copy into a plain ArrayBuffer-backed view for Hono, as the content route does.
    const bytes = new Uint8Array(content.bytes)
    return context.body(bytes, 200, {
      'content-type': content.mediaType,
      'content-digest': sha256StructuredDigest(content.version.contentDigest),
      etag: `"${content.version.contentDigest}"`,
      'content-disposition': `attachment; filename="${publicationExportFilename(document.name, content.version.version)}"`,
    })
  }
}

function getRulebookVersionExportManifestHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const { manifest } = requirePublicationArtifact(dependencies, context)
    return context.json({ data: toPublicationExportManifestResource(manifest) }, 200)
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

function generateIssuerFixtureHandler(service: IssuerFixtureService | undefined): ApiHandler {
  return async (context) => {
    const fixtures = requireIssuerFixtures(service)
    const body = await readJsonBody(context)
    try {
      const result = await fixtures.generate(body)
      return context.json({ data: toIssuerFixtureResource(result) }, 200)
    } catch (error) {
      if (error instanceof IssuerFixtureUnavailableError) {
        throw apiError(503, 'fixture_unavailable', error.message)
      }
      throw error
    }
  }
}

function resolveVerifierConstraintsHandler(service: VerifierPolicyService | undefined): ApiHandler {
  return async (context) => {
    const verifierPolicy = requireVerifierPolicy(service)
    const body = await readJsonBody(context)
    const result = verifierPolicy.resolve(body)
    return context.json({ data: toVerifierConstraintsResource(result) }, 200)
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

function listCapturesHandler(explorer: CaptureExplorer | undefined): ApiHandler {
  return async (context) => {
    const captures = requireCaptures(explorer)
    const limit = parsePositiveInteger(
      context.req.query('limit'),
      'limit',
      DEFAULT_CAPTURE_PAGE_LIMIT,
      1,
      MAX_CAPTURE_PAGE_LIMIT,
    )
    const offset = parsePositiveInteger(context.req.query('offset'), 'offset', 0, 0)
    const page = await captures.list({ limit, offset })
    return context.json(toCaptureExplorerPageResource(page), 200)
  }
}

function getCaptureHandler(explorer: CaptureExplorer | undefined): ApiHandler {
  return async (context) => {
    const captures = requireCaptures(explorer)
    const detail = await captures.get(context.req.param('captureId') ?? '')
    if (detail === null) {
      throw apiError(404, 'not_found', 'The requested capture does not exist.')
    }
    return context.json({ data: toCaptureExplorerDetailResource(detail) }, 200)
  }
}

function validateCaptureHandler(explorer: CaptureExplorer | undefined): ApiHandler {
  return async (context) => {
    const captures = requireCaptures(explorer)
    const body = await readJsonBody(context)
    const result = await captures.correlate(context.req.param('captureId') ?? '', body)
    return context.json({ data: toCaptureCorrelationResource(result) }, 200)
  }
}

/** Reads only the public issuer identifier; every other member is ignored. */
function parseDiscoverIssuerInput(body: unknown): { readonly credentialIssuer: string } {
  const record = requireRecord(body, 'request body')
  const credentialIssuer = record['credentialIssuer']
  if (typeof credentialIssuer !== 'string' || credentialIssuer.trim() === '') {
    throw invalidInput('credentialIssuer must be a non-empty string')
  }
  return { credentialIssuer }
}

function discoverIssuerHandler(service: IssuerDiscoveryService | undefined): ApiHandler {
  return async (context) => {
    const discovery = requireIssuerDiscovery(service)
    const input = parseDiscoverIssuerInput(await readJsonBody(context))
    const result = await discovery.discover(input.credentialIssuer)
    return context.json({ data: toIssuerDiscoveryResource(result) }, 200)
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
  const issuerDiscovery =
    dependencies.issuerDiscovery ??
    (dependencies.registry === undefined
      ? undefined
      : new IssuerDiscovery({ rulebooks: dependencies.registry }))
  const issuerFixtures =
    dependencies.issuerFixtures ??
    (dependencies.registry === undefined
      ? undefined
      : new IssuerFixtureGenerator({ source: dependencies.registry }))
  const verifierPolicy =
    dependencies.verifierPolicy ??
    (dependencies.registry === undefined
      ? undefined
      : new VerifierPolicyResolver({ source: dependencies.registry }))
  // The capture explorer is mock-backed by construction: it is seeded from the
  // deterministic local mock source and every entry carries `transport: "mock"`.
  const captures =
    dependencies.captures ??
    (dependencies.validation === undefined
      ? undefined
      : createMockCaptureExplorer({ validation: dependencies.validation }))

  return {
    getHealth: healthHandler(),
    listProviders: listProvidersHandler(dependencies),
    listRulebooks: listRulebooksHandler(dependencies),
    getRulebook: getRulebookHandler(dependencies),
    getRulebookDraft: getRulebookDraftHandler(dependencies),
    replaceRulebookDraft: replaceRulebookDraftHandler(dependencies),
    validateRulebookDraft: validateRulebookDraftHandler(),
    listRulebookAttestations: listRulebookAttestationsHandler(dependencies),
    listRulebookSchemaReferences: listRulebookSchemaReferencesHandler(dependencies),
    listRulebookVersions: listRulebookVersionsHandler(dependencies),
    getRulebookVersion: getRulebookVersionHandler(dependencies),
    getRulebookVersionContent: getRulebookVersionContentHandler(dependencies),
    createRulebook: createRulebookHandler(dependencies),
    createRulebookVersion: createRulebookVersionHandler(dependencies),
    refreshRulebookVersion: refreshRulebookVersionHandler(dependencies),
    publishRulebookVersion: publishRulebookVersionHandler(dependencies),
    compareRulebookVersions: compareRulebookVersionsHandler(dependencies),
    getRulebookPublicationReadiness: getRulebookPublicationReadinessHandler(dependencies),
    exportRulebookVersion: exportRulebookVersionHandler(dependencies),
    getRulebookVersionExportManifest: getRulebookVersionExportManifestHandler(dependencies),
    previewImport: previewImportHandler(importer),
    importRulebooks: importRulebooksHandler(importer),
    discoverIssuer: discoverIssuerHandler(issuerDiscovery),
    generateIssuerFixture: generateIssuerFixtureHandler(issuerFixtures),
    validateCredential: validateCredentialHandler(dependencies),
    listCaptures: listCapturesHandler(captures),
    getCapture: getCaptureHandler(captures),
    validateCapture: validateCaptureHandler(captures),
    resolveVerifierConstraints: resolveVerifierConstraintsHandler(verifierPolicy),
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
