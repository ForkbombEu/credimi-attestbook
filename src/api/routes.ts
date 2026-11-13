// Versioned product API routes and handlers (issue #34).
//
// One declarative route table is the source of truth for both the Hono
// registration and the generated OpenAPI document (./openapi.ts). Every handler
// calls a real service; there are no placeholder success responses. Missing
// wiring (for example a test application without a registry) answers 503
// instead of pretending the endpoint works.

import { getConnInfo } from 'hono/bun'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Context, Hono } from 'hono'

import packageJson from '../../package.json'
import {
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  MAX_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_USERNAME_LENGTH,
  isSameOriginRequest,
  requestUsesHttps,
  type AdminAuth,
} from '../auth'
import {
  createMockCaptureExplorer,
  DEFAULT_CAPTURE_PAGE_LIMIT,
  MAX_CAPTURE_PAGE_LIMIT,
  type CaptureExplorer,
  type CaptureExplorerDetail,
} from '../capture'
import {
  buildHeadlessWalletComparison,
  parseCompareCaptureInput,
  type ComparisonEvidenceSource,
} from '../comparison'
import { buildConformanceResult } from '../conformance'
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
import { credentialSchemaDocumentUrl, parsePublicBaseUrl } from '../public-urls'
import type { Registry } from '../registry/registry'
import { invalidInput, unauthorized } from '../registry/errors'
import {
  MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES,
  requireCredentialSchemaKind,
} from '../registry/schema-documents'
import type {
  AuthenticatedActor,
  CreateRulebookInput,
  CreateRulebookVersionInput,
  ReplaceDraftContentInput,
  RulebookVersionContent,
} from '../registry/types'
import { CREDENTIAL_SCHEMA_KINDS } from '../registry/types'
import { parseRulebookVersionDocument, type RulebookVersionDocument } from '../registry/versioning'
import {
  CREDENTIAL_VALIDATION_PATH,
  parseValidateCredentialInput,
  type CredentialValidationService,
} from '../validation'
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
  toConformanceResultResource,
  toCredentialSchemaDocumentResource,
  toDraftRulebookResource,
  toHeadlessWalletComparisonResource,
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

/**
 * The exact bytes of a stored schema document never change, so a permanent URL
 * is safe to cache for a year. `immutable` stops a client from revalidating.
 */
const IMMUTABLE_SCHEMA_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Every operation is identified by a stable id in the OpenAPI document. */
export type ApiOperationId =
  | 'getHealth'
  | 'loginAdmin'
  | 'getAdminSession'
  | 'logoutAdmin'
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
  | 'listSchemaDocuments'
  | 'getSchemaDocument'
  | 'getSchemaDocumentContent'
  | 'registerSchemaDocument'
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
  | 'runConformanceCheck'
  | 'listCaptures'
  | 'getCapture'
  | 'validateCapture'
  | 'compareCapture'
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
    | 'auth'
    | 'providers'
    | 'rulebooks'
    | 'versions'
    | 'schemas'
    | 'imports'
    | 'issuers'
    | 'credentials'
    | 'conformance'
    | 'captures'
    | 'verifiers'
  /**
   * `true` marks a protected operation: it accepts either an `Authorization:
   * Bearer` provider token or the administrator browser-session cookie. A
   * cookie-authenticated state change must also echo the session CSRF token.
   */
  readonly security: boolean
  /**
   * `true` marks an operation authenticated by the administrator browser
   * session cookie. It is independent of the bearer-token `security` flag.
   */
  readonly sessionAuth?: boolean
  readonly request?: ApiRequestBodySpec
  readonly parameters?: readonly ApiParameterSpec[]
  readonly responses: readonly ApiResponseSpec[]
}

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Malformed or invalid request; the body is an ErrorEnvelope with a stable code.',
  401: 'Missing, unknown, expired or revoked credential.',
  403: 'The authenticated actor is not allowed to perform this operation.',
  404: 'The requested resource does not exist.',
  409: 'The request conflicts with the current resource state (duplicate label, stale draft snapshot, published immutability).',
  413: 'The request body exceeds the endpoint limit.',
  422: 'The import source is unsafe, malformed, unsupported or not importable.',
  429: 'Too many failed login attempts; the response carries Retry-After.',
  500: 'Unexpected server failure; no internal details are exposed.',
  502: 'The remote import source could not be fetched.',
  503: 'The required service is not configured on this server.',
}

function errorSpecs(
  statuses: readonly number[],
  bearerChallenge: boolean,
): readonly ApiResponseSpec[] {
  return statuses.map((status) => ({
    status,
    description: ERROR_DESCRIPTIONS[status] ?? 'Error response.',
    schema: 'ErrorEnvelope',
    ...(status === 401 && bearerChallenge
      ? {
          headers: [
            {
              name: 'WWW-Authenticate',
              description: 'RFC 6750 bearer challenge; sent on every bearer-path 401 response.',
            },
          ],
        }
      : {}),
  }))
}

/** Error responses of a bearer-authenticated operation. */
function errors(...statuses: readonly number[]): readonly ApiResponseSpec[] {
  return errorSpecs(statuses, true)
}

/** Error responses of a browser-session operation: no bearer challenge. */
function sessionErrors(...statuses: readonly number[]): readonly ApiResponseSpec[] {
  return errorSpecs(statuses, false)
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

const PATH_SCHEMA_DOCUMENT_ID: ApiParameterSpec = {
  name: 'documentId',
  in: 'path',
  required: true,
  description: 'Stable AttestBook credential schema document identifier.',
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
    if (id === 'documentId') {
      return PATH_SCHEMA_DOCUMENT_ID
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
    operationId: 'loginAdmin',
    method: 'post',
    path: '/api/v1/auth/login',
    summary: 'Start an administrator browser session',
    description:
      'Verifies the environment-configured administrator credentials and issues an opaque, HttpOnly browser-session cookie plus the session-bound CSRF token. The administrator is bound to an existing provider; login never creates a provider, never mints or returns a provider bearer token and never stores one in the session. Unknown users and wrong passwords get the same generic 401; repeated failures are rate limited with 429 and Retry-After. Login answers 503 when the administrator configuration is absent, invalid or names a missing provider, while the public API and bearer authentication keep working.',
    tag: 'auth',
    security: false,
    request: {
      schema: 'AdminLoginRequest',
      mediaType: 'application/json',
      required: true,
      description: 'The configured administrator username and password.',
    },
    responses: [
      {
        status: 200,
        description:
          'The administrator session; the provider public projection, the absolute expiry and the session CSRF token are returned without any bearer token.',
        schema: 'AdminSessionResponse',
        headers: [
          {
            name: 'Set-Cookie',
            description:
              'Opaque session identifier in an HttpOnly, SameSite=Lax, Path=/ cookie; Secure when served over HTTPS.',
          },
        ],
      },
      ...sessionErrors(400, 401, 403, 429, 500, 503),
    ],
  },
  {
    operationId: 'getAdminSession',
    method: 'get',
    path: '/api/v1/auth/me',
    summary: 'Read the current administrator session',
    description:
      'Resolves the opaque session cookie to the configured existing provider and returns the live session CSRF token so a reloaded page can keep writing. A missing, unknown, expired or revoked session answers 401 without advertising a bearer challenge. The response never carries a provider bearer token.',
    tag: 'auth',
    security: false,
    sessionAuth: true,
    responses: [
      {
        status: 200,
        description: 'The authenticated provider, the session absolute expiry and the CSRF token.',
        schema: 'AdminSessionResponse',
      },
      ...sessionErrors(401, 500),
    ],
  },
  {
    operationId: 'logoutAdmin',
    method: 'post',
    path: '/api/v1/auth/logout',
    summary: 'Revoke the administrator browser session',
    description:
      'Revokes the server-side session named by the cookie and expires the cookie. The call is same-origin checked and idempotent: an absent, unknown or already-revoked session still succeeds, and the old identifier can no longer authenticate. When a live session cookie is presented, the call also requires the session CSRF token in X-CSRF-Token and answers 403 csrf_failed without revoking otherwise.',
    tag: 'auth',
    security: false,
    sessionAuth: true,
    responses: [
      {
        status: 204,
        description: 'The session is revoked and the cookie is expired; there is no response body.',
        headers: [
          {
            name: 'Set-Cookie',
            description: 'Expires the administrator session cookie.',
          },
        ],
      },
      ...sessionErrors(403, 500),
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
    operationId: 'listSchemaDocuments',
    method: 'get',
    path: '/api/v1/schema-documents',
    summary: 'List stored credential schema documents',
    description:
      'Public, paginated metadata of provider-owned immutable credential schema documents. Each entry carries the exact-bytes digest, its W3C SRI pin, the canonical media type and the permanent hosted content URL. The URL is composed from the configured public base URL, never from request `Host` or `Forwarded` headers; provider ownership and provenance are not exposed.',
    tag: 'schemas',
    security: false,
    parameters: [
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
        description: 'Number of stored schema documents to skip (default 0).',
        schema: { type: 'integer', minimum: 0 },
      },
    ],
    responses: [
      {
        status: 200,
        description: 'A page of public stored-schema metadata.',
        schema: 'CredentialSchemaDocumentPageResponse',
      },
      ...errors(400, 500, 503),
    ],
  },
  {
    operationId: 'getSchemaDocument',
    method: 'get',
    path: '/api/v1/schema-documents/:documentId',
    summary: 'Get stored credential schema metadata and hosted URL',
    description:
      'Public metadata of one immutable stored schema document: kind, canonical media type, SHA-256 digest, W3C SRI pin, creation time and the permanent hosted URL. The URL is composed from the configured public base URL; `Host`, `Forwarded` and `X-Forwarded-*` request headers have no effect. Provider ownership and provenance stay private. Answers `503 public_base_url_unavailable` when the deployment has not configured a public origin, because a canonical URL cannot be issued.',
    tag: 'schemas',
    security: false,
    parameters: pathParameters(['documentId']),
    responses: [
      {
        status: 200,
        description: 'The public stored-schema metadata and hosted URL.',
        schema: 'CredentialSchemaDocumentResponse',
      },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'getSchemaDocumentContent',
    method: 'get',
    path: '/api/v1/schema-documents/:documentId/content',
    summary: 'Download a stored credential schema document’s exact bytes',
    description:
      'Public, unauthenticated permanent URL of the exact immutable bytes registered by a provider. The body is returned byte-for-byte under the recorded media type and is never re-serialized. `Content-Digest` and `ETag` carry the SHA-256 integrity evidence and `Cache-Control` marks the content immutable; a matching `If-None-Match` answers `304`. Unknown identifiers answer `404` without revealing internal storage data, and the route has no mutation method.',
    tag: 'schemas',
    security: false,
    parameters: pathParameters(['documentId']),
    responses: [
      {
        status: 200,
        description:
          'The exact immutable document bytes; `Content-Type` is the recorded canonical media type.',
        headers: [
          {
            name: 'Content-Digest',
            description: 'RFC 9530 `sha-256=:<base64>:` of the returned bytes.',
          },
          { name: 'ETag', description: 'Quoted lowercase hex SHA-256 of the returned bytes.' },
          {
            name: 'Cache-Control',
            description: '`public, max-age=31536000, immutable`: the bytes never change.',
          },
          {
            name: 'X-Content-Type-Options',
            description: '`nosniff`, so a browser cannot reinterpret the JSON bytes.',
          },
        ],
      },
      {
        status: 304,
        description: 'The request’s `If-None-Match` matches the current ETag; no body is sent.',
        headers: [{ name: 'ETag', description: 'Quoted lowercase hex SHA-256 of the bytes.' }],
      },
      ...errors(400, 404, 500, 503),
    ],
  },
  {
    operationId: 'registerSchemaDocument',
    method: 'post',
    path: '/api/v1/schema-documents',
    summary: 'Register an immutable credential schema document',
    description:
      'Authenticated, idempotent registration of a supported, bounded JSON document under the authenticated provider. The raw request body is the exact JSON document; the required `kind` query parameter selects the supported profile and therefore fixes the canonical media type. Registration computes the SHA-256 over the exact bytes, stores the bytes once in the content-addressed store and returns the public document metadata: the canonical AttestBook-hosted HTTPS URL, the W3C SRI pin (`sha256-<base64>`), the hex digest and the media type. Registering identical content again for the same provider returns the existing document unchanged with `200`; a new association answers `201`. The bytes are never updated, replaced or deleted. The returned `url` and `integrity` are ordinary `schemaReferences[].uri`/`integrity` values; no proprietary TS11 field is added. Requires a provider bearer token or the administrator browser session plus its CSRF token; public clients cannot register.',
    tag: 'schemas',
    security: true,
    parameters: [
      {
        name: 'kind',
        in: 'query',
        required: true,
        description:
          'Supported credential schema profile: `json_schema_2020_12` (`application/schema+json`) or `sd_jwt_vc_type_metadata` (`application/json`).',
        schema: { type: 'string', enum: [...CREDENTIAL_SCHEMA_KINDS] },
      },
    ],
    request: {
      schema: 'RegisterSchemaDocumentRequest',
      mediaType: 'application/json',
      required: true,
      description:
        'The exact JSON document bytes. A JSON Schema 2020-12 document is an object or a boolean; an SD-JWT VC Type Metadata document is an object. `kind`, not the `Content-Type` header, selects the profile, so `application/schema+json` is also accepted for JSON Schema. The body must be at most 256 KiB and must not repeat a member name.',
    },
    responses: [
      {
        status: 201,
        description:
          'The document was registered; the body is its public metadata and `Location` is the permanent hosted URL.',
        schema: 'CredentialSchemaDocumentResponse',
        headers: [
          {
            name: 'Location',
            description:
              'Canonical AttestBook-hosted URL of the exact immutable bytes, built from the configured public origin.',
          },
        ],
      },
      {
        status: 200,
        description:
          'Identical content is already registered for this provider; the existing document is returned unchanged and `Location` is its permanent hosted URL.',
        schema: 'CredentialSchemaDocumentResponse',
        headers: [
          {
            name: 'Location',
            description: 'Canonical AttestBook-hosted URL of the exact immutable bytes.',
          },
        ],
      },
      ...errors(400, 401, 403, 404, 409, 413, 500, 503),
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
      ...errors(400, 401, 403, 413, 500, 503),
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
      ...errors(400, 401, 403, 413, 422, 500, 502, 503),
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
      ...errors(400, 401, 403, 413, 422, 500, 502, 503),
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
      ...errors(400, 401, 403, 413, 422, 500, 502, 503),
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
    operationId: 'runConformanceCheck',
    method: 'post',
    path: '/api/v1/conformance/runs',
    summary: 'Run one reproducible structural conformance check',
    description:
      'Runs the same pinned structural validation as POST /api/v1/credentials/validate and returns a deterministic attestbook.conformance-result@1: an input digest, a content-addressed result reference, stable failure classes and the exact pinned version/digest the evidence was produced against. Repeating the same pinned inputs produces the same reference; validation identifiers, timestamps and mutable lifecycle metadata are excluded. AttestBook does not schedule, start or observe recurring executions, and a structural outcome is never a standards, cryptographic, trust, protocol or interoperability verdict.',
    tag: 'conformance',
    security: false,
    request: {
      schema: 'ConformanceRunRequest',
      mediaType: 'application/json',
      required: true,
      description:
        'Credential, exact pinned rulebook version, attestation type and optional schema documents.',
    },
    responses: [
      {
        status: 200,
        description: 'The reproducible conformance result and its stable reference.',
        schema: 'ConformanceRunResponse',
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
      description:
        'The rulebook identifier, version, attestation type and optional pinned snapshot digest. A supplied digest that no longer matches the version snapshot is refused with 409 before anything is recorded.',
    },
    responses: [
      {
        status: 200,
        description: 'The recorded correlation and the structural validation result.',
        schema: 'CaptureCorrelationResponse',
      },
      ...errors(400, 401, 403, 404, 409, 413, 500, 502, 503),
    ],
  },
  {
    operationId: 'compareCapture',
    method: 'post',
    path: '/api/v1/captures/:captureId/compare',
    summary: 'Build headless-wallet comparison evidence for a correlated capture',
    description:
      'Returns the AttestBook structural/schema evidence of a correlated capture and, optionally, the caller-supplied external wallet observation, separated into schema, protocol, interoperability and trust groups. Every dimension AttestBook cannot execute is listed as unsupported; an external observation is recorded verbatim, labelled as external and never folded into an AttestBook validation status. The capture must already be bound to a pinned rulebook version with POST /api/v1/captures/{captureId}/validate. The operation is read-only: it persists nothing, starts no wallet and contacts no Credimi or capture endpoint.',
    tag: 'captures',
    security: false,
    parameters: [PATH_CAPTURE_ID],
    request: {
      schema: 'CompareCaptureRequest',
      mediaType: 'application/json',
      required: true,
      description:
        'An optional caller-supplied external wallet observation. The AttestBook side comes from the recorded capture correlation, never from the request.',
    },
    responses: [
      {
        status: 200,
        description:
          'The pinned rulebook link, the AttestBook structural evidence, the external observation and the explicit unsupported comparison dimensions.',
        schema: 'HeadlessWalletComparisonResponse',
      },
      ...errors(400, 404, 409, 413, 500, 502, 503),
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
  import(actor: AuthenticatedActor, source: ImportSource): Promise<ImportResult>
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
  /** Environment-configured administrator browser login; absent means unavailable. */
  readonly adminAuth?: AdminAuth
  /**
   * Trusted public origin used to build permanent hosted-schema URLs (#98).
   * Absent or `null` means this server cannot issue those URLs and the metadata
   * routes answer `503`; request headers are never used as a fallback.
   */
  readonly publicBaseUrl?: string | null
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

/**
 * Hono context key of the trusted actor a protected route resolved before its
 * handler ran. Handlers read it; they never parse a credential themselves.
 */
const AUTHENTICATED_ACTOR_KEY = 'attestbook.authenticatedActor'

/**
 * Bearer credential of the request. `null` means no `Authorization` header was
 * sent; a present but malformed header is unauthorized, exactly like an
 * unknown or revoked token.
 */
function bearerCredential(context: Context): string | null {
  const header = context.req.header('authorization')
  if (header === undefined) {
    return null
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = match?.[1]
  if (token === undefined) {
    throw unauthorized()
  }
  return token
}

/**
 * Resolves the one trusted provider actor of a protected request. A present
 * `Authorization` header is authoritative: an invalid bearer never falls back
 * to the cookie session, so a client that explicitly supplies a token cannot
 * accidentally act as the browser's session user. The cookie session is the
 * fallback and, for a state-changing request, must echo the session-bound CSRF
 * token (issue #89).
 */
function resolveRequestActor(
  context: Context,
  dependencies: ApiDependencies,
  stateChanging: boolean,
): AuthenticatedActor {
  const token = bearerCredential(context)
  if (token !== null) {
    return requireRegistry(dependencies).authenticateBearer(token)
  }

  const sessionId = getCookie(context, ADMIN_SESSION_COOKIE_NAME)
  if (sessionId === undefined || dependencies.adminAuth === undefined) {
    throw unauthorized()
  }
  if (stateChanging && !isSameOriginRequest(requestOriginContext(context))) {
    throw apiError(403, 'csrf_failed', 'The request origin is not allowed.')
  }
  return dependencies.adminAuth.authenticateSession(sessionId, {
    csrfToken: context.req.header(ADMIN_CSRF_HEADER_NAME) ?? null,
    requireCsrf: stateChanging,
  })
}

/** The actor of the current protected request; never read from request input. */
function requireActor(context: Context): AuthenticatedActor {
  const actor = context.get(AUTHENTICATED_ACTOR_KEY) as AuthenticatedActor | undefined
  if (actor === undefined) {
    // A protected handler must never run without a resolved actor; a missing
    // one is a wiring bug, not a client failure.
    throw new Error('protected handler reached without an authenticated actor')
  }
  return actor
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

/** Origin headers of one request, used by the cookie-auth CSRF checks. */
function requestOriginContext(context: Context) {
  return {
    url: context.req.url,
    origin: context.req.header('origin'),
    secFetchSite: context.req.header('sec-fetch-site'),
    forwardedProto: context.req.header('x-forwarded-proto'),
    forwardedHost: context.req.header('x-forwarded-host'),
  }
}

function requireAdminAuth(dependencies: ApiDependencies): AdminAuth {
  if (dependencies.adminAuth === undefined) {
    throw apiError(503, 'auth_unavailable', 'Administrator login is not configured on this server.')
  }
  return dependencies.adminAuth
}

/** Rejects a state-changing cookie request that another site could originate. */
function assertSameOrigin(context: Context): void {
  if (!isSameOriginRequest(requestOriginContext(context))) {
    throw apiError(403, 'forbidden', 'The request origin is not allowed.')
  }
}

/**
 * Login accepts only a JSON body. A cross-site HTML form cannot send that
 * content type without a CORS preflight, so this is an additional CSRF control
 * next to the origin and SameSite checks.
 */
function assertJsonRequest(context: Context): void {
  const contentType = context.req.header('content-type') ?? ''
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw apiError(
      400,
      'invalid_request',
      'The request body must use content-type application/json.',
    )
  }
}

/** Remote address for the coarse client bound; `unknown` for in-process tests. */
function adminClientKey(context: Context): string {
  try {
    return getConnInfo(context).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function parseAdminLoginInput(body: unknown): {
  readonly username: string
  readonly password: string
} {
  const record = requireRecord(body, 'request body')
  if (
    typeof record.username !== 'string' ||
    record.username.trim() === '' ||
    record.username.length > MAX_ADMIN_USERNAME_LENGTH
  ) {
    throw invalidInput(
      `username must be a non-empty string of at most ${String(MAX_ADMIN_USERNAME_LENGTH)} characters`,
    )
  }
  if (
    typeof record.password !== 'string' ||
    record.password === '' ||
    record.password.length > MAX_ADMIN_PASSWORD_LENGTH
  ) {
    throw invalidInput(
      `password must be a non-empty string of at most ${String(MAX_ADMIN_PASSWORD_LENGTH)} characters`,
    )
  }
  return { username: record.username, password: record.password }
}

function setAdminSessionCookie(context: Context, sessionId: string, maxAgeSeconds: number): void {
  setCookie(context, ADMIN_SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
    secure: requestUsesHttps(requestOriginContext(context)),
  })
}

function expireAdminSessionCookie(context: Context): void {
  deleteCookie(context, ADMIN_SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: requestUsesHttps(requestOriginContext(context)),
  })
}

function adminLoginHandler(dependencies: ApiDependencies): ApiHandler {
  return async (context) => {
    const adminAuth = requireAdminAuth(dependencies)
    assertSameOrigin(context)
    assertJsonRequest(context)
    const credentials = parseAdminLoginInput(await readJsonBody(context))
    context.header('cache-control', 'no-store')

    const currentSessionId = getCookie(context, ADMIN_SESSION_COOKIE_NAME)
    const outcome = await adminAuth.login({
      ...credentials,
      clientKey: adminClientKey(context),
      ...(currentSessionId === undefined ? {} : { currentSessionId }),
    })

    if (outcome.kind === 'unavailable') {
      throw apiError(
        503,
        'auth_unavailable',
        'Administrator login is not configured on this server.',
      )
    }
    if (outcome.kind === 'rate_limited') {
      throw apiError(
        429,
        'rate_limited',
        'Too many failed login attempts. Try again later.',
        undefined,
        {
          headers: { 'Retry-After': String(outcome.retryAfterSeconds) },
        },
      )
    }
    if (outcome.kind === 'invalid_credentials') {
      // The same body and status for an unknown username and a wrong password.
      throw apiError(401, 'unauthorized', 'Invalid username or password.')
    }

    setAdminSessionCookie(context, outcome.sessionId, outcome.maxAgeSeconds)
    return context.json(
      {
        data: {
          provider: toProviderResource(outcome.provider),
          expiresAt: outcome.expiresAt,
          csrfToken: outcome.csrfToken,
        },
      },
      200,
    )
  }
}

function getAdminSessionHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    context.header('cache-control', 'no-store')
    const sessionId = getCookie(context, ADMIN_SESSION_COOKIE_NAME)
    const session =
      dependencies.adminAuth === undefined || sessionId === undefined
        ? null
        : dependencies.adminAuth.resolveSession(sessionId)
    if (session === null) {
      throw apiError(401, 'unauthorized', 'Authentication is required.')
    }
    return context.json(
      {
        data: {
          provider: toProviderResource(session.provider),
          expiresAt: session.expiresAt,
          csrfToken: session.csrfToken,
        },
      },
      200,
    )
  }
}

function logoutAdminHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    assertSameOrigin(context)
    context.header('cache-control', 'no-store')
    const sessionId = getCookie(context, ADMIN_SESSION_COOKIE_NAME)
    if (sessionId !== undefined && dependencies.adminAuth !== undefined) {
      // Revoking a live session is a state change, so it needs the CSRF token
      // bound to that session. No live session means nothing to revoke, and
      // logout stays idempotent.
      if (
        dependencies.adminAuth.verifySessionCsrf(
          sessionId,
          context.req.header(ADMIN_CSRF_HEADER_NAME) ?? null,
        ) === 'mismatch'
      ) {
        throw apiError(
          403,
          'csrf_failed',
          'The request is missing or carries an invalid CSRF token; sign in again.',
        )
      }
    }
    dependencies.adminAuth?.logout(sessionId ?? null)
    expireAdminSessionCookie(context)
    return context.body(null, 204)
  }
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
    const actor = requireActor(context)
    const content = registry.replaceDraftContent(
      actor,
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

function requirePublicBaseUrl(dependencies: ApiDependencies): string {
  const baseUrl = dependencies.publicBaseUrl
  if (baseUrl === undefined || baseUrl === null || baseUrl === '') {
    throw apiError(
      503,
      'public_base_url_unavailable',
      'The server has no configured public base URL, so it cannot issue hosted schema URLs.',
    )
  }
  // Configuration already validated it; re-checking here keeps a directly
  // constructed application from emitting a malformed permanent URL.
  try {
    const parsed = parsePublicBaseUrl(baseUrl)
    if (parsed === null) {
      throw new Error('missing public base URL')
    }
    return parsed
  } catch {
    throw apiError(
      503,
      'public_base_url_unavailable',
      'The server public base URL is invalid, so it cannot issue hosted schema URLs.',
    )
  }
}

function listSchemaDocumentsHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const publicBaseUrl = requirePublicBaseUrl(dependencies)
    const limit = parsePositiveInteger(
      context.req.query('limit'),
      'limit',
      DEFAULT_PAGE_LIMIT,
      1,
      MAX_PAGE_LIMIT,
    )
    const offset = parsePositiveInteger(context.req.query('offset'), 'offset', 0, 0)
    const documents = registry.listCredentialSchemaDocuments()
    const data = documents
      .slice(offset, offset + limit)
      .map((document) => toCredentialSchemaDocumentResource(document, publicBaseUrl))
    return context.json({ data, pagination: { limit, offset, total: documents.length } }, 200)
  }
}

function getSchemaDocumentHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const publicBaseUrl = requirePublicBaseUrl(dependencies)
    const document = registry.getCredentialSchemaDocument(context.req.param('documentId') ?? '')
    if (document === null) {
      throw apiError(404, 'not_found', 'The requested credential schema document does not exist.')
    }
    return context.json({ data: toCredentialSchemaDocumentResource(document, publicBaseUrl) }, 200)
  }
}

/** Weak comparison of one `If-None-Match` field value against a strong ETag. */
function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false
  }
  const normalized = header.trim()
  if (normalized === '*') {
    return true
  }
  const target = etag.startsWith('W/') ? etag.slice(2) : etag
  return normalized
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => (candidate.startsWith('W/') ? candidate.slice(2) : candidate) === target)
}

function getSchemaDocumentContentHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const content = registry.getCredentialSchemaDocumentContent(
      context.req.param('documentId') ?? '',
    )
    if (content === null) {
      throw apiError(404, 'not_found', 'The requested credential schema document does not exist.')
    }
    // The stored bytes are returned unchanged; validating or re-serializing
    // them would break the recorded digest.
    const bytes = new Uint8Array(content.bytes)
    const digest = content.document.contentDigest
    const etag = `"${digest}"`
    const cacheHeaders = {
      'cache-control': IMMUTABLE_SCHEMA_CACHE_CONTROL,
      'content-digest': sha256StructuredDigest(digest),
      etag,
      'x-content-type-options': 'nosniff',
    }
    if (matchesIfNoneMatch(context.req.header('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders })
    }
    return context.body(bytes, 200, {
      'content-type': content.document.mediaType,
      ...cacheHeaders,
    })
  }
}

/**
 * Reads the raw registration body exactly once and enforces the profile's byte
 * bound before the registry sees it. The platform-wide body limit already
 * bounds the read at `MAX_API_BODY_BYTES`; this answers the narrower document
 * limit with the API's typed `413 payload_too_large` instead of a generic 400.
 */
async function readSchemaDocumentBody(context: Context): Promise<Uint8Array> {
  const bytes = new Uint8Array(await context.req.arrayBuffer())
  if (bytes.byteLength > MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES) {
    throw apiError(
      413,
      'payload_too_large',
      `The schema document must be at most ${MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES} bytes.`,
    )
  }
  return bytes
}

function registerSchemaDocumentHandler(dependencies: ApiDependencies): ApiHandler {
  return async (context) => {
    const registry = requireRegistry(dependencies)
    const actor = requireActor(context)
    // A canonical permanent URL is part of the result, so refuse before any
    // write when the deployment cannot issue one.
    const publicBaseUrl = requirePublicBaseUrl(dependencies)
    const kind = requireCredentialSchemaKind(context.req.query('kind'))
    const bytes = await readSchemaDocumentBody(context)
    // Only the HTTP status distinguishes an idempotent replay; the write path
    // still validates, authorizes and re-checks everything itself.
    const existing = registry.findCredentialSchemaDocumentByContent(actor, bytes)
    const document = await registry.registerCredentialSchemaDocument(actor, { kind, bytes })
    return context.json(
      { data: toCredentialSchemaDocumentResource(document, publicBaseUrl) },
      existing === null ? 201 : 200,
      { Location: credentialSchemaDocumentUrl(publicBaseUrl, document.id) },
    )
  }
}

function createRulebookHandler(dependencies: ApiDependencies): ApiHandler {
  return async (context) => {
    const registry = requireRegistry(dependencies)
    const actor = requireActor(context)
    const rulebook = registry.createRulebook(
      actor,
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
    const actor = requireActor(context)
    const version = registry.createRulebookVersion(
      actor,
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
    const actor = requireActor(context)
    const rulebookId = context.req.param('rulebookId') ?? ''
    const label = context.req.param('version') ?? ''

    // Authenticate and authorize explicitly so an idempotent replay answers
    // consistently instead of throwing an immutability conflict.
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

    const published = registry.publishRulebookVersion(actor, rulebookId, label)
    return context.json({ data: toRulebookVersionResource(published) }, 200)
  }
}

function refreshRulebookVersionHandler(dependencies: ApiDependencies): ApiHandler {
  return (context) => {
    const registry = requireRegistry(dependencies)
    const actor = requireActor(context)
    const refreshed = registry.refreshDraftRulebookVersion(
      actor,
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
    const actor = requireActor(context)
    const source = parseImportSource(await readJsonBody(context))
    const result = await service.import(actor, source)
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

/**
 * Runs one structural validation and turns its evidence into a reproducible
 * conformance result. The operation is read-only: it persists nothing, starts
 * no execution and schedules no recurrence.
 */
function runConformanceCheckHandler(dependencies: ApiDependencies): ApiHandler {
  return async (context) => {
    const validation = requireValidation(dependencies)
    const body = await readJsonBody(context)
    const request = parseValidateCredentialInput(body)
    const result = await validation.validate(request)
    const conformance = buildConformanceResult({ validation: result, request })
    return context.json({ data: toConformanceResultResource(conformance) }, 200)
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

/**
 * Builds the AttestBook-side evidence source from a capture detail. The route
 * refuses an uncorrelated capture, so `rulebook` and `validationResult` are
 * always present here.
 */
function comparisonSourceFromCapture(detail: CaptureExplorerDetail): ComparisonEvidenceSource {
  const { rulebook, validationResult } = detail
  if (rulebook === null || validationResult === null) {
    throw apiError(
      409,
      'conflict',
      'The capture is not bound to a validated rulebook version. Correlate it with a pinned rulebook version before comparing it.',
    )
  }
  return {
    captureId: detail.captureId,
    correlationId: detail.correlationId,
    testExecutionRef: detail.testExecutionRef,
    sourceComponent: detail.source.component,
    protocol: detail.protocol,
    credentialFormat: detail.credentialFormat,
    rulebook,
    validation: validationResult,
  }
}

function compareCaptureHandler(explorer: CaptureExplorer | undefined): ApiHandler {
  return async (context) => {
    const captures = requireCaptures(explorer)
    const detail = await captures.get(context.req.param('captureId') ?? '')
    if (detail === null) {
      throw apiError(404, 'not_found', 'The requested capture does not exist.')
    }
    const source = comparisonSourceFromCapture(detail)
    const body = parseCompareCaptureInput(await readJsonBody(context))
    const report = buildHeadlessWalletComparison({
      source,
      externalWallet: body.externalWallet,
    })
    return context.json({ data: toHeadlessWalletComparisonResource(report) }, 200)
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
    loginAdmin: adminLoginHandler(dependencies),
    getAdminSession: getAdminSessionHandler(dependencies),
    logoutAdmin: logoutAdminHandler(dependencies),
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
    listSchemaDocuments: listSchemaDocumentsHandler(dependencies),
    getSchemaDocument: getSchemaDocumentHandler(dependencies),
    getSchemaDocumentContent: getSchemaDocumentContentHandler(dependencies),
    registerSchemaDocument: registerSchemaDocumentHandler(dependencies),
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
    runConformanceCheck: runConformanceCheckHandler(dependencies),
    listCaptures: listCapturesHandler(captures),
    getCapture: getCaptureHandler(captures),
    validateCapture: validateCaptureHandler(captures),
    compareCapture: compareCaptureHandler(captures),
    resolveVerifierConstraints: resolveVerifierConstraintsHandler(verifierPolicy),
  }
}

/**
 * Resolves and stores the trusted actor before the handler runs, and therefore
 * before any request body is read or outbound fetch starts. The contract's
 * `security` flag is the only place that decides which operations are
 * protected, and the declared HTTP method decides whether a cookie-authenticated
 * call also needs its CSRF token. There is no second, manually maintained list
 * of secured endpoints.
 */
function protectedRoute(
  dependencies: ApiDependencies,
  route: ApiRouteSpec,
  handler: ApiHandler,
): ApiHandler {
  const stateChanging = route.method !== 'get'
  return (context) => {
    context.set(AUTHENTICATED_ACTOR_KEY, resolveRequestActor(context, dependencies, stateChanging))
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
      route.security ? protectedRoute(dependencies, route, handler) : handler,
    )
  }
}
