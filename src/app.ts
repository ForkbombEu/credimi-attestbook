// HTTP application assembly for AttestBook (issue #34).
//
// The versioned product routes live in src/api/; this module wires the shared
// body limit, the consistent error mapping and the not-found handler around
// them. Tests build the same application without a listener, so the routes they
// exercise are the routes the server exposes.

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { BEARER_CHALLENGE, errorEnvelope, toApiError } from './api/errors'
import { MAX_API_BODY_BYTES, registerApiRoutes, type ApiDependencies } from './api/routes'

export type { ErrorEnvelope } from './api/errors'

export interface HealthResponse {
  readonly status: 'ok'
  readonly service: 'attestbook'
  readonly version: string
}

export type AppOptions = ApiDependencies

/** Body limit for the validation and write endpoints. */
export const MAX_VALIDATION_BODY_BYTES = MAX_API_BODY_BYTES

/**
 * Builds the HTTP application without starting a listener. Services that are
 * not wired answer 503 rather than pretending the endpoint works.
 */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono()

  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_API_BODY_BYTES,
      onError: (c) =>
        c.json(
          errorEnvelope(
            'payload_too_large',
            `The request body must be at most ${MAX_API_BODY_BYTES} bytes.`,
          ),
          413,
        ),
    }),
  )

  registerApiRoutes(app, options)

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not_found',
          message: 'No route matches the request path.',
        },
      },
      404,
    ),
  )

  app.onError((error, c) => {
    const mapped = toApiError(error)
    if (mapped !== null) {
      return c.json(
        mapped.body,
        mapped.status,
        mapped.status === 401 ? { 'WWW-Authenticate': BEARER_CHALLENGE } : undefined,
      )
    }

    // Never echo exception details to clients or log request payloads.
    console.error('unhandled request error', {
      method: c.req.method,
      path: c.req.path,
      error: error.name,
    })

    return c.json(
      {
        error: {
          code: 'internal_error',
          message: 'The request could not be completed.',
        },
      },
      500,
    )
  })

  return app
}
