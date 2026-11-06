import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import applicationPackage from '../package.json'
import type { ErrorEnvelope, HealthResponse } from './app'
import { createApp } from './app'

const app = createApp()

const uiDirectory = mkdtempSync(join(tmpdir(), 'attestbook-ui-'))
writeFileSync(join(uiDirectory, 'index.html'), '<!doctype html><title>AttestBook</title>')
writeFileSync(join(uiDirectory, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

afterAll(() => {
  rmSync(uiDirectory, { recursive: true, force: true })
})

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

describe('built web UI', () => {
  const uiApp = createApp({ uiRoot: uiDirectory })

  test('serves the UI entry document at the site root', async () => {
    const response = await uiApp.request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<title>AttestBook</title>')
  })

  test('serves content-addressed assets from the UI build directory', async () => {
    const response = await uiApp.request('/favicon.svg')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('image/svg+xml')
  })

  test('keeps the JSON not-found envelope for unknown routes', async () => {
    const response = await uiApp.request('/missing')

    expect(response.status).toBe(404)
    expect((await response.json()) as ErrorEnvelope).toEqual({
      error: {
        code: 'not_found',
        message: 'No route matches the request path.',
      },
    })
  })

  test('does not serve the UI when no build directory is configured', async () => {
    const response = await createApp().request('/')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})
