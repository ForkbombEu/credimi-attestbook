// HTTP application assembly for AttestBook (issue #34).
//
// The versioned product routes live in src/api/; this module wires the shared
// body limit, the consistent error mapping and the not-found handler around
// them. Tests build the same application without a listener, so the routes they
// exercise are the routes the server exposes.

import { resolve, sep } from 'node:path'

import { Hono } from 'hono'
import type { Context } from 'hono'
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
 * Serves one built UI file. The handler is explicit rather than a static
 * middleware because the production server is bundled: depending only on
 * `Bun.file` keeps the bundled request path identical to the tested one.
 */
function staticFileHandler(filePath: string, cacheControl: string) {
  return async (context: Context): Promise<Response> => {
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      return context.notFound()
    }
    return new Response(file, {
      status: 200,
      headers: {
        'content-type': file.type === '' ? 'application/octet-stream' : file.type,
        'cache-control': cacheControl,
        'x-content-type-options': 'nosniff',
      },
    })
  }
}

/**
 * Serves one UI directory tree under a URL prefix. The resolved path must stay
 * inside that directory; dot segments and backslashes are rejected before the
 * filesystem is touched.
 */
function uiDirectoryHandler(root: string, prefix: string, cacheControl: string) {
  const directoryRoot = resolve(root)
  return async (context: Context): Promise<Response> => {
    let relative: string
    try {
      relative = decodeURIComponent(context.req.path.slice(prefix.length))
    } catch {
      return context.notFound()
    }
    if (
      relative === '' ||
      relative.includes('\0') ||
      relative.includes('\\') ||
      relative.split('/').includes('..')
    ) {
      return context.notFound()
    }
    const filePath = resolve(directoryRoot, relative)
    if (filePath !== directoryRoot && !filePath.startsWith(`${directoryRoot}${sep}`)) {
      return context.notFound()
    }

    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      return context.notFound()
    }
    return new Response(file, {
      status: 200,
      headers: {
        'content-type': file.type === '' ? 'application/octet-stream' : file.type,
        'cache-control': cacheControl,
        'x-content-type-options': 'nosniff',
      },
    })
  }
}

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
    // The entry document is served from explicit paths; Vite's content-addressed
    // assets and the installed Credimi brand directory go through directory
    // handlers that refuse to walk outside the build output.
    app.get('/', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    // The client router owns `/rulebooks/<id>`, `/playground`, `/captures/*`
    // and `/login`. Serving the entry document for those paths makes a deep
    // link and a browser reload address the same view instead of a JSON 404;
    // the API stays under `/api/*` and unknown non-UI paths keep the JSON
    // not-found envelope.
    app.get('/rulebooks/*', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    app.get('/playground', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    app.get('/playground/', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    app.get('/captures', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    app.get('/captures/', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    app.get('/captures/*', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    app.get('/login', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    app.get('/login/', staticFileHandler(resolve(uiRoot, 'index.html'), 'no-cache'))
    app.use(
      '/assets/*',
      uiDirectoryHandler(
        resolve(uiRoot, 'assets'),
        '/assets/',
        'public, max-age=31536000, immutable',
      ),
    )
    app.use(
      '/brand/*',
      uiDirectoryHandler(resolve(uiRoot, 'brand'), '/brand/', 'public, max-age=3600'),
    )
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
      const headers: Record<string, string> = { ...mapped.headers }
      // The RFC 6750 challenge belongs only to bearer-authenticated routes;
      // browser-session failures answer 401 without advertising a bearer token.
      if (mapped.status === 401 && (mapped.challenge ?? true)) {
        headers['WWW-Authenticate'] = BEARER_CHALLENGE
      }
      return c.json(
        mapped.body,
        mapped.status,
        Object.keys(headers).length === 0 ? undefined : headers,
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
