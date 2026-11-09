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
export const API_CONTRACT_VERSION = '1.7.0'

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
  return [...(route.parameters ?? []).map(parameterObject), ...implicitPathParameters]
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
    ...(route.security ? { security: [{ bearerAuth: [] }] } : {}),
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
        'failures use `{ "error": { "code", "message", "details"? } }`. Reads are public; writes require an',
        'AttestBook provider bearer token. See docs/api.md for the versioning, idempotency and error policy.',
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
