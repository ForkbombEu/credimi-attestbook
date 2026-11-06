// HTTP application assembly for AttestBook (issue #34).
//
// The versioned product routes live in src/api/; this module wires the shared
// body limit, the consistent error mapping and the not-found handler around
// them. Tests build the same application without a listener, so the routes they
// exercise are the routes the server exposes.

import { resolve } from 'node:path'

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { bodyLimit } from 'hono/body-limit'

import { BEARER_CHALLENGE, errorEnvelope, toApiError } from './api/errors'
import { MAX_API_BODY_BYTES, registerApiRoutes, type ApiDependencies } from './api/routes'

export type { ErrorEnvelope } from './api/errors'

export interface HealthResponse {
  readonly status: 'ok'
  readonly service: 'attestbook'
  readonly version: string
}

export interface AppOptions extends ApiDependencies {
  /**
   * Directory of the built web UI (`index.html` plus Vite's `assets/`). When
   * absent the UI routes are not registered and `/` keeps the JSON 404, so a
   * source checkout without a UI build does not serve a broken page.
   */
  readonly uiRoot?: string
}

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

  if (options.uiRoot !== undefined) {
    const uiRoot = resolve(options.uiRoot)
    // The entry document and the icon are served from explicit paths; only
    // Vite's content-addressed assets are served through the directory root,
    // so a request cannot walk outside the build output.
    app.get('/', serveStatic({ root: uiRoot, path: 'index.html' }))
    app.get('/favicon.svg', serveStatic({ root: uiRoot, path: 'favicon.svg' }))
    app.use('/assets/*', serveStatic({ root: uiRoot }))
  }

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
