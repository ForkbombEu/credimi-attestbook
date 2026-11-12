// Generated OpenAPI 3.1 document for the versioned product API (issue #34).
//
// The document is derived from the same `API_ROUTES` table that registers the
// Hono handlers (./routes.ts) and from the shared Zod schemas (./schemas.ts),
// so a route and its documented operation cannot drift. `bun run openapi:check`
// validates the generated document against the official OpenAPI 3.1 schema and
// the contract tests compare it with the routes Hono actually registered.

import { API_ROUTES, type ApiOperationId, type ApiRouteSpec } from './routes'
import { OPENAPI_COMPONENTS, componentJsonSchema } from './schemas'

/** OpenAPI specification version produced by this module. */
export const OPENAPI_VERSION = '3.1.0'

/** Version of the API contract document itself. */
export const API_CONTRACT_VERSION = '1.11.0'

/** URL prefix that carries the product API's major version. */
export const API_VERSION_PREFIX = '/api/v1'

type JsonObject = Record<string, unknown>

export interface OpenApiDocument {
  readonly openapi: string
  readonly info: JsonObject
  readonly servers: readonly JsonObject[]
  readonly tags: readonly JsonObject[]
  readonly paths: Record<string, Record<string, JsonObject>>
  readonly components: JsonObject
}

const TAG_DESCRIPTIONS: readonly { readonly name: string; readonly description: string }[] = [
  {
    name: 'service',
    description: 'Unversioned operational endpoints. Not part of the versioned resource API.',
  },
  {
    name: 'providers',
    description: 'Public provider identities referenced by catalogue rulebooks.',
  },
  {
    name: 'auth',
    description:
      'Environment-configured administrator browser login and opaque server-side sessions. A live session resolves to the same provider actor as a provider bearer token; both authorize the protected write routes.',
  },
  { name: 'rulebooks', description: 'Stable rulebook identity, content and schema references.' },
  { name: 'versions', description: 'Immutable rulebook snapshots, digests and publication.' },
  {
    name: 'imports',
    description: 'Bounded import previews and idempotent draft import from URL or JSON sources.',
  },
  {
    name: 'issuers',
    description:
      'Bounded OpenID4VCI credential issuer metadata discovery, candidate rulebook association and rulebook-driven unsigned issuer fixtures.',
  },
  {
    name: 'credentials',
    description: 'Structural credential validation with explicit per-dimension evidence.',
  },
  {
    name: 'conformance',
    description:
      'Reproducible continuous-conformance evidence: a stable result reference and machine-readable structural evidence for external orchestration. No execution is scheduled or observed.',
  },
  {
    name: 'captures',
    description:
      'Mock-backed normalized capture evidence, redacted artifact projection and pinned-rulebook correlation. No live capture component is integrated.',
  },
  {
    name: 'verifiers',
    description:
      'Typed verifier constraints and explicitly partial OpenID4VP-aware policy mappings of pinned rulebook versions.',
  },
]

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function pathParameterNames(path: string): readonly string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
}

function parameterObject(parameter: {
  readonly name: string
  readonly in: 'query' | 'path'
  readonly required: boolean
  readonly description: string
  readonly schema: Readonly<Record<string, unknown>>
}): JsonObject {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required,
    description: parameter.description,
    schema: parameter.schema,
  }
}

/**
 * The CSRF header a cookie-authenticated state change must present. It is
 * optional for the bearer path, so it is documented on every protected
 * non-GET operation exactly as the route table derives the check.
 */
function csrfHeaderParameter(route: ApiRouteSpec): JsonObject | null {
  if (!route.security || route.method === 'get') {
    return null
  }
  return {
    name: 'X-CSRF-Token',
    in: 'header',
    required: false,
    description:
      'Required when the request authenticates with the administrator browser-session cookie instead of a bearer token. Value: the `csrfToken` returned by POST /api/v1/auth/login or GET /api/v1/auth/me. A missing or wrong token answers 403 csrf_failed.',
    schema: { type: 'string' },
  }
}

function operationParameters(route: ApiRouteSpec): readonly JsonObject[] {
  const declared = new Set((route.parameters ?? []).map((parameter) => parameter.name))
  const implicitPathParameters = pathParameterNames(route.path)
    .filter((name) => !declared.has(name))
    .map((name) =>
      parameterObject({
        name,
        in: 'path',
        required: true,
        description: 'Path parameter.',
        schema: { type: 'string' },
      }),
    )
  const csrf = csrfHeaderParameter(route)
  return [
    ...(route.parameters ?? []).map(parameterObject),
    ...implicitPathParameters,
    ...(csrf === null ? [] : [csrf]),
  ]
}

function responseObject(response: ApiRouteSpec['responses'][number]): JsonObject {
  return {
    description: response.description,
    ...(response.schema === undefined
      ? {}
      : {
          content: {
            [response.mediaType ?? 'application/json']: {
              schema: { $ref: `#/components/schemas/${response.schema}` },
            },
          },
        }),
    ...(response.headers === undefined
      ? {}
      : {
          headers: Object.fromEntries(
            response.headers.map((header) => [
              header.name,
              { description: header.description, schema: { type: 'string' } },
            ]),
          ),
        }),
  }
}

function operationObject(route: ApiRouteSpec): JsonObject {
  const parameters = operationParameters(route)
  const responses: JsonObject = {}
  for (const response of route.responses) {
    responses[String(response.status)] = responseObject(response)
  }

  return {
    operationId: route.operationId,
    summary: route.summary,
    description: route.description,
    tags: [route.tag],
    ...(route.security
      ? // Alternative requirements: either credential authenticates the actor.
        { security: [{ bearerAuth: [] }, { sessionAuth: [] }] }
      : route.sessionAuth
        ? { security: [{ sessionAuth: [] }] }
        : {}),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(route.request === undefined
      ? {}
      : {
          requestBody: {
            required: route.request.required,
            description: route.request.description,
            content: {
              [route.request.mediaType]: {
                schema: { $ref: `#/components/schemas/${route.request.schema}` },
              },
            },
          },
        }),
    responses,
  }
}

/** Builds the OpenAPI 3.1 document from the shared route and schema definitions. */
export function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, Record<string, JsonObject>> = {}
  for (const route of API_ROUTES) {
    const path = toOpenApiPath(route.path)
    const pathItem = (paths[path] ??= {})
    pathItem[route.method] = operationObject(route)
  }

  const schemas: JsonObject = {}
  for (const name of Object.keys(OPENAPI_COMPONENTS) as (keyof typeof OPENAPI_COMPONENTS)[]) {
    schemas[name] = componentJsonSchema(name)
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'AttestBook product API',
      version: API_CONTRACT_VERSION,
      summary: 'Versioned REST contract for the implemented AttestBook capabilities.',
      description: [
        'This is the product REST API described by docs/specification.md §13; it is not the TS11 catalogue API.',
        'The major version is carried in the URL under `/api/v1`. Within v1 only additive, backwards-compatible',
        'changes are made. Successful responses use a `{ "data": ... }` envelope (lists add `pagination`);',
        'failures use `{ "error": { "code", "message", "details"? } }`. Reads are public; writes accept either an',
        'AttestBook provider bearer token or the administrator browser-session cookie, both resolving to the same',
        'provider actor. A state-changing cookie request must also echo the session-bound `X-CSRF-Token`; a present',
        'but invalid bearer never falls back to a cookie session. See docs/api.md for the versioning, idempotency',
        'and error policy.',
      ].join(' '),
      license: { name: 'Apache-2.0' },
    },
    servers: [{ url: '/', description: 'Same-origin deployment.' }],
    tags: TAG_DESCRIPTIONS.map((tag) => ({ ...tag })),
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'AttestBook provider write token. Tokens are issued by operator provisioning, are never returned by the API and are sent only in the Authorization header.',
        },
        sessionAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'attestbook_admin_session',
          description:
            'Opaque administrator browser-session identifier bound to an existing provider. Set HttpOnly and SameSite=Lax by POST /api/v1/auth/login, revoked by POST /api/v1/auth/logout, never accepted from a URL or request body. Every state-changing request that uses it must also send the session `csrfToken` in X-CSRF-Token; GET /api/v1/auth/me returns the current token.',
        },
      },
    },
  }
}

/** Operation ids in the OpenAPI document, for contract checks. */
export function documentedOperationIds(): readonly ApiOperationId[] {
  return Object.values(buildOpenApiDocument().paths).flatMap((pathItem) =>
    Object.values(pathItem)
      .map((operation) => operation['operationId'])
      .filter((id): id is ApiOperationId => typeof id === 'string'),
  )
}
