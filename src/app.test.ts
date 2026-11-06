import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import applicationPackage from '../package.json'
import type { ErrorEnvelope, HealthResponse } from './app'
import { createApp } from './app'

const app = createApp()

const uiDirectory = mkdtempSync(join(tmpdir(), 'attestbook-ui-'))
mkdirSync(join(uiDirectory, 'assets'))
writeFileSync(join(uiDirectory, 'index.html'), '<!doctype html><title>AttestBook</title>')
writeFileSync(join(uiDirectory, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
writeFileSync(join(uiDirectory, 'assets', 'app.js'), 'export const ready = true')

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

  test('serves the icon and content-addressed assets with a nosniff header', async () => {
    const icon = await uiApp.request('/favicon.svg')
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toContain('image/svg+xml')
    expect(icon.headers.get('x-content-type-options')).toBe('nosniff')

    const asset = await uiApp.request('/assets/app.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('serves the UI entry document for a client-routed rulebook detail link', async () => {
    const response = await uiApp.request('/rulebooks/00000000-0000-4000-8000-000000000000')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<title>AttestBook</title>')
  })

  test('rejects asset path traversal and missing assets with the JSON 404', async () => {
    for (const path of [
      '/assets/%2e%2e/index.html',
      '/assets/%2e%2e%2findex.html',
      '/assets/..%5cindex.html',
      '/assets/missing.js',
      '/assets/',
    ]) {
      const response = await uiApp.request(path)
      expect(response.status, path).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect((await response.json()) as ErrorEnvelope).toEqual({
        error: {
          code: 'not_found',
          message: 'No route matches the request path.',
        },
      })
    }
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

    const deepLink = await createApp().request('/rulebooks/00000000-0000-4000-8000-000000000000')
    expect(deepLink.status).toBe(404)
    expect(deepLink.headers.get('content-type')).toContain('application/json')
  })
})
