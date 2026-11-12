import { describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'

import { createApp } from '../app'

import { loadOpenApi31Schema } from './oas-schema'
import { buildOpenApiDocument } from './openapi'
import { API_ROUTES } from './routes'
import { OPENAPI_COMPONENTS } from './schemas'

const document = buildOpenApiDocument()
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const componentSchemas = document.components['schemas'] as Record<string, Record<string, unknown>>

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function operationFor(route: (typeof API_ROUTES)[number]): Record<string, unknown> {
  const pathItem = document.paths[toOpenApiPath(route.path)]
  if (pathItem === undefined) {
    throw new Error(`missing documented path ${route.path}`)
  }
  const operation = pathItem[route.method]
  if (operation === undefined) {
    throw new Error(`missing documented operation ${route.method} ${route.path}`)
  }
  return operation
}

describe('generated OpenAPI document', () => {
  test('validates against the official OpenAPI 3.1 JSON Schema', () => {
    const validate = ajv.compile(loadOpenApi31Schema())
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true)
  })

  test('every component is a valid JSON Schema 2020-12 document', () => {
    for (const name of Object.keys(OPENAPI_COMPONENTS)) {
      const schema = componentSchemas[name]
      expect(schema, `missing component ${name}`).toBeDefined()
      expect(() => ajv.compile(schema as Record<string, unknown>)).not.toThrow()
    }
  })

  test('documented operations exactly match the routes Hono registered', () => {
    const app = createApp()
    const registered = app.routes
      .filter(
        (route) => route.method === 'GET' || route.method === 'POST' || route.method === 'PUT',
      )
      .map((route) => `${route.method} ${route.path}`)
      .sort()
    const documented = API_ROUTES.map(
      (route) => `${route.method.toUpperCase()} ${route.path}`,
    ).sort()

    expect(registered).toEqual(documented)
  })

  test('the same routes produce the documented path items and operation ids', () => {
    for (const route of API_ROUTES) {
      const operation = operationFor(route)
      expect(operation['operationId']).toBe(route.operationId)
      expect(operation['tags']).toEqual([route.tag])
    }
    expect(document.paths['/api/v1/rulebooks']).toBeDefined()
    expect(document.paths['/api/v1/rulebooks/{rulebookId}']).toBeDefined()
  })

  test('every path template parameter is declared as a required path parameter', () => {
    for (const route of API_ROUTES) {
      const names = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)]
        .map((match) => match[1])
        .filter((name): name is string => name !== undefined)
      const operation = operationFor(route)
      const parameters = (operation['parameters'] ?? []) as readonly Record<string, unknown>[]
      for (const name of names) {
        const parameter = parameters.find((candidate) => candidate['name'] === name)
        expect(parameter, `${route.operationId} is missing path parameter ${name}`).toBeDefined()
        expect(parameter?.['in']).toBe('path')
        expect(parameter?.['required']).toBe(true)
      }
    }
  })

  test('every referenced component exists and operation ids are unique', () => {
    const operationIds = new Set<string>()
    for (const route of API_ROUTES) {
      const operation = operationFor(route)
      const operationId = String(operation['operationId'])
      expect(operationIds.has(operationId)).toBe(false)
      operationIds.add(operationId)

      if (route.request !== undefined) {
        expect(componentSchemas[route.request.schema]).toBeDefined()
      }
      for (const response of route.responses) {
        if (response.schema !== undefined) {
          expect(componentSchemas[response.schema]).toBeDefined()
        }
      }
    }
  })

  test('the import preview accepts either protected-transport scheme', () => {
    const preview = document.paths['/api/v1/imports/preview']?.['post']
    expect(preview?.['security']).toEqual([{ bearerAuth: [] }, { sessionAuth: [] }])
  })

  test('operations declare their bearer and/or session security scheme', () => {
    const securitySchemes = document.components['securitySchemes'] as Record<string, unknown>
    expect(securitySchemes['bearerAuth']).toMatchObject({ type: 'http', scheme: 'bearer' })
    expect(securitySchemes['sessionAuth']).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'attestbook_admin_session',
    })

    for (const route of API_ROUTES) {
      const operation = operationFor(route)
      if (route.security) {
        // Alternative requirements: a bearer token or the session cookie
        // authenticates the same provider actor.
        expect(operation['security']).toEqual([{ bearerAuth: [] }, { sessionAuth: [] }])
      } else if (route.sessionAuth) {
        expect(operation['security']).toEqual([{ sessionAuth: [] }])
      } else {
        expect(operation['security']).toBeUndefined()
      }
    }
  })

  test('session operations do not advertise a bearer challenge on 401', () => {
    for (const route of API_ROUTES.filter((candidate) => candidate.sessionAuth)) {
      const operation = operationFor(route)
      const responses = operation['responses'] as Record<string, Record<string, unknown>>
      const headers = responses['401']?.['headers'] as Record<string, unknown> | undefined
      expect(headers?.['WWW-Authenticate'], route.operationId).toBeUndefined()
    }
  })

  test('success and error bodies are documented for every operation', () => {
    for (const route of API_ROUTES) {
      const operation = operationFor(route)
      const responses = operation['responses'] as Record<string, Record<string, unknown>>
      const statuses = Object.keys(responses).map(Number)
      expect(statuses.some((status) => status >= 200 && status < 300)).toBe(true)
      expect(statuses).toContain(500)
      expect(responses['500']?.['content']).toEqual({
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        },
      })
    }
  })

  test('protected state-changing operations document the CSRF header', () => {
    for (const route of API_ROUTES.filter(
      (candidate) => candidate.security && candidate.method !== 'get',
    )) {
      const operation = operationFor(route)
      const parameters = (operation['parameters'] ?? []) as { name?: string; in?: string }[]
      expect(
        parameters.some(
          (parameter) => parameter.name === 'X-CSRF-Token' && parameter.in === 'header',
        ),
        route.operationId,
      ).toBe(true)
    }
  })

  test('protected operations document the bearer challenge on 401', () => {
    for (const route of API_ROUTES.filter((candidate) => candidate.security)) {
      const operation = operationFor(route)
      const responses = operation['responses'] as Record<string, Record<string, unknown>>
      const headers = responses['401']?.['headers'] as Record<string, unknown> | undefined
      expect(headers?.['WWW-Authenticate'], route.operationId).toBeDefined()
    }
  })
})
