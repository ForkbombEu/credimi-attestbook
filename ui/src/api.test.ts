import { describe, expect, test, vi } from 'vitest'

import { CatalogApiError, createHttpCatalogApi, isAbortError, type FetchLike } from './api'
import { PROVIDERS } from './test/fixtures'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createHttpCatalogApi', () => {
  test('reads the public providers and catalogue endpoints', async () => {
    const fetchImpl = vi.fn<FetchLike>((input) => {
      if (input === '/api/v1/providers') {
        return Promise.resolve(jsonResponse({ data: PROVIDERS }))
      }
      if (input.startsWith('/api/v1/rulebooks?')) {
        return Promise.resolve(
          jsonResponse({
            data: [],
            pagination: { limit: 100, offset: 0, total: 0 },
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404),
      )
    })
    const api = createHttpCatalogApi(fetchImpl)

    expect(await api.listProviders()).toEqual(PROVIDERS)
    expect(await api.listRulebooks()).toEqual({
      data: [],
      pagination: { limit: 100, offset: 0, total: 0 },
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/rulebooks?limit=100&offset=0',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
  })

  test('encodes rulebook ids in detail paths', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: [] })))
    const api = createHttpCatalogApi(fetchImpl)

    await api.listAttestations('rulebook/with space')
    await api.listVersions('rulebook/with space')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/v1/rulebooks/rulebook%2Fwith%20space/attestations',
    )
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/rulebooks/rulebook%2Fwith%20space/versions')
  })

  test('surfaces the safe API error message and status', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'registry_unavailable',
              message: 'The rulebook registry is unavailable.',
            },
          },
          503,
        ),
      ),
    )
    const api = createHttpCatalogApi(fetchImpl)

    const error = await api.listProviders().catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(CatalogApiError)
    expect(error).toMatchObject({
      message: 'The rulebook registry is unavailable.',
      status: 503,
    })
  })

  test('falls back to the HTTP status when the error body is not JSON', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(new Response('upstream failure', { status: 502 })),
    )
    const api = createHttpCatalogApi(fetchImpl)

    await expect(api.listRulebooks()).rejects.toThrow('The catalog request failed with HTTP 502.')
  })

  test('rejects an unexpected success envelope', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ items: [] })))
    const api = createHttpCatalogApi(fetchImpl)

    await expect(api.listProviders()).rejects.toThrow(
      'The catalog returned an unexpected response.',
    )
  })
})

describe('isAbortError', () => {
  test('recognises DOM and Error abort signals only', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(new Error('other'))).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })
})
