import { Hono } from 'hono'

import packageJson from '../package.json'

export interface HealthResponse {
  readonly status: 'ok'
  readonly service: 'attestbook'
  readonly version: string
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

/**
 * Builds the HTTP application without starting a listener, so tests and
 * future handlers can exercise the same routes the server exposes.
 */
export function createApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) =>
    c.json<HealthResponse>({
      status: 'ok',
      service: 'attestbook',
      version: packageJson.version,
    }),
  )

  app.notFound((c) =>
    c.json<ErrorEnvelope>(
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
    // Never echo exception details to clients or log request payloads.
    console.error('unhandled request error', {
      method: c.req.method,
      path: c.req.path,
      error: error.name,
    })

    return c.json<ErrorEnvelope>(
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
