// HTTP-level tests for the public interactive API reference (issue #126).
//
// `/docs` is a static documentation page, not an API resource: it is served
// anonymously from the built UI entry document, reads the canonical
// same-origin contract from `/openapi.json`, and must not gain a session or
// embed a deployment credential. The tests serve the repository's real
// `ui/docs.html` so the assertions cover the page that ships.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp, type ErrorEnvelope } from '../app'

import { OPENAPI_DOCUMENT_PATH, buildOpenApiDocument } from './openapi'

const docsPage = readFileSync(fileURLToPath(new URL('../../ui/docs.html', import.meta.url)), 'utf8')

const uiDirectory = mkdtempSync(join(tmpdir(), 'attestbook-docs-ui-'))
mkdirSync(join(uiDirectory, 'assets'))
writeFileSync(join(uiDirectory, 'docs.html'), docsPage)
writeFileSync(join(uiDirectory, 'index.html'), '<!doctype html><title>AttestBook catalog</title>')
writeFileSync(join(uiDirectory, 'assets', 'docs.js'), 'export const reference = true')

const app = createApp({ uiRoot: uiDirectory })

afterAll(() => {
  rmSync(uiDirectory, { recursive: true, force: true })
})

describe('GET /docs', () => {
  test('serves the reference anonymously for direct navigation and its trailing slash', async () => {
    for (const path of ['/docs', '/docs/']) {
      const response = await app.request(path)

      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      // No session, CSRF token or other cookie is needed to read the reference.
      expect(response.headers.get('set-cookie')).toBeNull()

      const body = await response.text()
      expect(body).toContain('id="docs-root"')
      expect(body).toContain('data-openapi-url="/openapi.json"')
      expect(body).toContain('<script type="module" src="/src/docs/main.ts"></script>')
      expect(body).toContain('<title>API reference · AttestBook</title>')
    }
  })

  test('references only local assets and the same-origin contract', async () => {
    const body = await (await app.request('/docs')).text()

    // The page itself must not embed a third-party origin or an absolute host:
    // the browser resolves the contract path against whatever public host the
    // reverse proxy serves.
    expect(body).not.toMatch(/https?:\/\//)
    expect(body).not.toMatch(/(?:src|href)="\/\//)
    expect(body).not.toContain('localhost')
  })

  test('keeps the versioned contract and the assets the page needs available', async () => {
    const asset = await app.request('/assets/docs.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')

    const contract = await app.request(OPENAPI_DOCUMENT_PATH)
    expect(contract.status).toBe(200)
    expect(contract.headers.get('content-type')).toBe('application/json')
    expect(await contract.json()).toEqual(buildOpenApiDocument())
  })

  test('keeps the JSON not-found envelope when no UI build is served', async () => {
    const response = await createApp().request('/docs')

    expect(response.status).toBe(404)
    expect((await response.json()) as ErrorEnvelope).toEqual({
      error: {
        code: 'not_found',
        message: 'No route matches the request path.',
      },
    })
  })
})
