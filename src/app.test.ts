import { describe, expect, spyOn, test } from 'bun:test'

import applicationPackage from '../package.json'
import type { ErrorEnvelope, HealthResponse } from './app'
import { createApp } from './app'

const app = createApp()

describe('HTTP application', () => {
  test('GET /health returns the service health envelope', async () => {
    const response = await app.request('/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect((await response.json()) as HealthResponse).toEqual({
      status: 'ok',
      service: 'attestbook',
      version: applicationPackage.version,
    })
  })

  test('unknown routes return a JSON not-found envelope', async () => {
    const response = await app.request('/missing')

    expect(response.status).toBe(404)
    expect((await response.json()) as ErrorEnvelope).toEqual({
      error: {
        code: 'not_found',
        message: 'No route matches the request path.',
      },
    })
  })

  test('unexpected errors return a generic envelope without leaking details', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})

    try {
      const failingApp = createApp()
      failingApp.get('/unexpected-error', () => {
        throw new Error('secret-token-that-must-not-leak')
      })

      const response = await failingApp.request('/unexpected-error')
      const body = await response.text()

      expect(response.status).toBe(500)
      expect(body).not.toContain('secret-token-that-must-not-leak')
      expect(JSON.parse(body) as ErrorEnvelope).toEqual({
        error: {
          code: 'internal_error',
          message: 'The request could not be completed.',
        },
      })
    } finally {
      consoleError.mockRestore()
    }
  })
})
