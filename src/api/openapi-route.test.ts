// HTTP-level tests for the public machine-readable contract endpoint.
//
// `GET /openapi.json` is deliberately unversioned and anonymous: clients and
// documentation tools fetch exactly the same generated document `openapi.ts`
// produces, and the endpoint adds no business route.

import { describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'

import { createApp, type ErrorEnvelope } from '../app'

import { loadOpenApi31Schema } from './oas-schema'
import {
  OPENAPI_DOCUMENT_PATH,
  OPENAPI_VERSION,
  buildOpenApiDocument,
  type OpenApiDocument,
} from './openapi'

describe(`GET ${OPENAPI_DOCUMENT_PATH}`, () => {
  test('serves the generated OpenAPI 3.1 document anonymously as JSON', async () => {
    const response = await createApp().request(OPENAPI_DOCUMENT_PATH)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')

    const body = (await response.json()) as OpenApiDocument
    expect(body).toEqual(buildOpenApiDocument())
    expect(body.openapi).toBe(OPENAPI_VERSION)
    expect(body.info['title']).toBe('AttestBook product API')
    expect(body.paths['/api/v1/rulebooks']?.['get']).toBeDefined()

    const securitySchemes = body.components['securitySchemes'] as Record<string, unknown>
    expect(securitySchemes['bearerAuth']).toBeDefined()
    expect(securitySchemes['sessionAuth']).toBeDefined()
    expect(securitySchemes['subscriptionTokenAuth']).toBeDefined()

    // Same-origin deployment; no request-derived origin or deployment credential.
    expect(body.servers).toEqual([{ url: '/', description: 'Same-origin deployment.' }])
  })

  test('the served document validates against the official OpenAPI 3.1 JSON Schema', async () => {
    const response = await createApp().request(OPENAPI_DOCUMENT_PATH)
    const body: unknown = await response.json()

    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
    const validate = ajv.compile(loadOpenApi31Schema())
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true)
  })

  test('does not change the typed 404 envelope of an unknown versioned API route', async () => {
    const response = await createApp().request('/api/v1/not-a-route')

    expect(response.status).toBe(404)
    expect((await response.json()) as ErrorEnvelope).toEqual({
      error: {
        code: 'not_found',
        message: 'No route matches the request path.',
      },
    })
  })
})
