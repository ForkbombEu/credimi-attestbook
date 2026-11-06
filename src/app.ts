import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import packageJson from '../package.json'
import { isRegistryError } from './registry/errors'
import { CREDENTIAL_VALIDATION_PATH, type CredentialValidationService } from './validation'

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

export interface AppOptions {
  /**
   * Credential validation service. The production server wires the real
   * registry-backed validator; a missing service answers 503 rather than
   * pretending the endpoint works.
   */
  readonly validation?: CredentialValidationService
}

/** Body limit for the validation endpoint (credential plus schema documents). */
export const MAX_VALIDATION_BODY_BYTES = 4 * 1024 * 1024

function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } }
}

/**
 * Builds the HTTP application without starting a listener, so tests and
 * future handlers can exercise the same routes the server exposes.
 */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono()
  const validation = options.validation

  app.get('/health', (c) =>
    c.json<HealthResponse>({
      status: 'ok',
      service: 'attestbook',
      version: packageJson.version,
    }),
  )

  app.post(
    CREDENTIAL_VALIDATION_PATH,
    bodyLimit({
      maxSize: MAX_VALIDATION_BODY_BYTES,
      onError: (c) =>
        c.json<ErrorEnvelope>(
          errorEnvelope(
            'payload_too_large',
            `The request body must be at most ${MAX_VALIDATION_BODY_BYTES} bytes.`,
          ),
          413,
        ),
    }),
    async (c) => {
      if (validation === undefined) {
        return c.json<ErrorEnvelope>(
          errorEnvelope(
            'validation_unavailable',
            'Credential validation is not configured on this server.',
          ),
          503,
        )
      }

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json<ErrorEnvelope>(
          errorEnvelope('invalid_request', 'The request body must be a JSON object.'),
          400,
        )
      }

      try {
        const result = await validation.validate(body)
        return c.json(result, 200)
      } catch (error) {
        if (isRegistryError(error)) {
          if (error.code === 'invalid_input') {
            return c.json<ErrorEnvelope>(errorEnvelope('invalid_request', error.message), 400)
          }
          if (error.code === 'not_found') {
            return c.json<ErrorEnvelope>(errorEnvelope('not_found', error.message), 404)
          }
        }
        throw error
      }
    },
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
