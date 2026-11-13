import { describe, expect, test, vi } from 'vitest'

import {
  CatalogApiError,
  createHttpCaptureApi,
  createHttpCatalogApi,
  createHttpEditorApi,
  createHttpValidationApi,
  isAbortError,
  isSessionAuthError,
  versionContentPath,
  type FetchLike,
} from './api'
import { makeBoundCaptureDetail, makeCaptureCorrelation, makeCaptureDetail } from './test/captures'
import { makeValidationResult, PROVIDERS } from './test/fixtures'

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
    await api.listSchemaReferences('rulebook/with space')
    await api.listVersions('rulebook/with space')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/v1/rulebooks/rulebook%2Fwith%20space/attestations',
    )
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      '/api/v1/rulebooks/rulebook%2Fwith%20space/schema-references',
    )
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/v1/rulebooks/rulebook%2Fwith%20space/versions')
  })

  test('reads one rulebook and builds an encoded version-content export path', async () => {
    const rulebook = {
      id: 'rulebook/with space',
      providerId: 'provider-issuer',
      name: 'PID Rulebook',
      description: '',
      sourceUrl: null,
      applicableSpec: 'ts11@1.0.1',
      publicationStatus: 'draft',
      createdAt: '2026-02-01T10:00:00.000Z',
      updatedAt: '2026-02-01T10:00:00.000Z',
    }
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: rulebook })))
    const api = createHttpCatalogApi(fetchImpl)

    expect(await api.getRulebook('rulebook/with space')).toEqual(rulebook)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/rulebooks/rulebook%2Fwith%20space',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
    expect(versionContentPath('rulebook/with space', '1.0')).toBe(
      '/api/v1/rulebooks/rulebook%2Fwith%20space/versions/1.0/content',
    )
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

describe('createHttpValidationApi', () => {
  const request = {
    rulebookId: 'rulebook-pid',
    rulebookVersion: '1.0',
    attestationType: 'Person Identification Data',
    credential: 'secret-credential-artifact-value',
  } as const

  test('posts the typed request and returns the validation result', async () => {
    const result = makeValidationResult()
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: result })))
    const api = createHttpValidationApi(fetchImpl)

    expect(await api.validateCredential(request)).toEqual(result)

    const [path, init] = fetchImpl.mock.calls[0] ?? []
    expect(path).toBe('/api/v1/credentials/validate')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    })
    expect(init?.body).toBe(JSON.stringify(request))
    expect(path).not.toContain(request.credential)
  })

  test('surfaces the safe API error message and status', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'invalid_input', message: 'credential must be a string' } },
          400,
        ),
      ),
    )

    const error = await createHttpValidationApi(fetchImpl)
      .validateCredential(request)
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(CatalogApiError)
    expect(error).toMatchObject({ message: 'credential must be a string', status: 400 })
  })

  test('falls back to the HTTP status when the error body is not JSON', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(new Response('upstream failure', { status: 500 })),
    )

    await expect(createHttpValidationApi(fetchImpl).validateCredential(request)).rejects.toThrow(
      'The validation request failed with HTTP 500.',
    )
  })

  test('rejects a non-JSON success body and an unexpected envelope', async () => {
    const nonJson = vi.fn<FetchLike>(() => Promise.resolve(new Response('ok', { status: 200 })))
    await expect(createHttpValidationApi(nonJson).validateCredential(request)).rejects.toThrow(
      'The validation returned an unexpected response.',
    )

    const missingData = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({})))
    await expect(createHttpValidationApi(missingData).validateCredential(request)).rejects.toThrow(
      'The validation returned an unexpected response.',
    )
  })
})

describe('createHttpEditorApi', () => {
  const draft = {
    id: 'rulebook-1',
    providerId: 'provider-1',
    name: 'PID Rulebook',
    description: '',
    sourceUrl: null,
    applicableSpec: 'ts11@1.0.1',
    publicationStatus: 'draft' as const,
    attestations: [],
    schemaReferences: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const request = {
    name: 'PID Rulebook',
    applicableSpec: 'ts11@1.0.1',
    attestations: [],
    schemaReferences: [],
  }

  test('reads a draft working copy from its public path', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: draft })))
    const api = createHttpEditorApi(fetchImpl)

    expect(await api.getDraft('rulebook-1')).toEqual(draft)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/rulebooks/rulebook-1/draft',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
  })

  test('replaces a draft with the session cookie and CSRF token', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: draft })))
    const api = createHttpEditorApi(fetchImpl)

    expect(await api.replaceDraft('rulebook-1', request, 'csrf-token-value')).toEqual(draft)
    const [path, init] = fetchImpl.mock.calls[0] ?? []
    expect(path).toBe('/api/v1/rulebooks/rulebook-1/draft')
    expect(init).toMatchObject({
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': 'csrf-token-value',
      },
    })
    expect(JSON.parse(init?.body as string)).toEqual(request)
  })

  test('registers a hosted schema with the exact bytes and CSRF token', async () => {
    const registered = {
      id: 'document-1',
      kind: 'json_schema_2020_12',
      mediaType: 'application/schema+json',
      contentDigest: 'a'.repeat(64),
      integrity: 'sha256-AAAA',
      url: 'https://schemas.example/api/v1/schema-documents/document-1/content',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(jsonResponse({ data: registered }, 201)),
    )
    const api = createHttpEditorApi(fetchImpl)
    const documentText = '{"$schema":"https://json-schema.org/draft/2020-12/schema"}'

    expect(
      await api.registerSchemaDocument('json_schema_2020_12', documentText, 'csrf-token-value'),
    ).toEqual(registered)

    const [path, init] = fetchImpl.mock.calls[0] ?? []
    expect(path).toBe('/api/v1/schema-documents?kind=json_schema_2020_12')
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: documentText,
      headers: {
        accept: 'application/json',
        'content-type': 'application/schema+json',
        'x-csrf-token': 'csrf-token-value',
      },
    })
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined()
  })

  test('creates a draft with the CSRF token and validates one anonymously', async () => {
    const fetchImpl = vi.fn<FetchLike>((path) => {
      if (path === '/api/v1/rulebooks') {
        return Promise.resolve(jsonResponse({ data: draft }, 201))
      }
      return Promise.resolve(
        jsonResponse({
          data: {
            valid: true,
            saveable: true,
            profile: 'ts11@1.0.1',
            diagnostics: [],
            limitations: [],
          },
        }),
      )
    })
    const api = createHttpEditorApi(fetchImpl)

    expect(await api.createDraft(request, 'csrf-token-value')).toEqual(draft)
    const [createPath, createInit] = fetchImpl.mock.calls[0] ?? []
    expect(createPath).toBe('/api/v1/rulebooks')
    expect(createInit?.method).toBe('POST')
    expect(createInit?.credentials).toBe('same-origin')
    expect((createInit?.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-value')
    expect((createInit?.headers as Record<string, string>).authorization).toBeUndefined()

    expect(await api.validateDraft(request)).toEqual({
      valid: true,
      saveable: true,
      profile: 'ts11@1.0.1',
      diagnostics: [],
      limitations: [],
    })
    const [validatePath, validateInit] = fetchImpl.mock.calls[1] ?? []
    expect(validatePath).toBe('/api/v1/rulebooks/validate-draft')
    expect(validateInit?.method).toBe('POST')
    expect((validateInit?.headers as Record<string, string>).authorization).toBeUndefined()
    expect((validateInit?.headers as Record<string, string>)['x-csrf-token']).toBeUndefined()
  })

  test('uses the safe error envelope for a rejected write', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'immutable', message: 'Only draft rulebooks can be changed.' } },
          409,
        ),
      ),
    )
    const api = createHttpEditorApi(fetchImpl)

    await expect(api.replaceDraft('rulebook-1', request, 'csrf-token-value')).rejects.toThrow(
      'Only draft rulebooks can be changed.',
    )
    await expect(api.replaceDraft('rulebook-1', request, 'csrf-token-value')).rejects.toMatchObject(
      {
        status: 409,
      },
    )
  })
})

describe('CatalogApiError session classification', () => {
  test('carries the error code and treats 401 as a session failure', () => {
    const error = new CatalogApiError('Authentication is required.', 401, 'unauthorized')
    expect(error.code).toBe('unauthorized')
    expect(isSessionAuthError(error)).toBe(true)
  })

  test('treats a 403 csrf_failed as a session failure', () => {
    const error = new CatalogApiError(
      'The request is missing or carries an invalid CSRF token; sign in again.',
      403,
      'csrf_failed',
    )
    expect(error.code).toBe('csrf_failed')
    expect(isSessionAuthError(error)).toBe(true)
  })

  test('does not treat an ownership 403 forbidden as a session failure', () => {
    const error = new CatalogApiError(
      'The authenticated provider does not own this resource.',
      403,
      'forbidden',
    )
    expect(error.code).toBe('forbidden')
    expect(isSessionAuthError(error)).toBe(false)
  })

  test('reads the envelope code from a rejected write', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'csrf_failed',
              message: 'The request is missing or carries an invalid CSRF token; sign in again.',
            },
          },
          403,
        ),
      ),
    )
    const api = createHttpEditorApi(fetchImpl)

    await expect(
      api.replaceDraft(
        'rulebook-1',
        { name: 'PID', applicableSpec: 'ts11@1.0.1', attestations: [], schemaReferences: [] },
        'stale-token',
      ),
    ).rejects.toMatchObject({
      name: 'CatalogApiError',
      status: 403,
      code: 'csrf_failed',
    })
  })
})

describe('createHttpCaptureApi', () => {
  test('lists the mock-backed captures with the capped page', async () => {
    const detail = makeCaptureDetail()
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        jsonResponse({
          data: [detail],
          pagination: { limit: 100, offset: 0, total: 1 },
        }),
      ),
    )
    const api = createHttpCaptureApi(fetchImpl)

    const page = await api.listCaptures()
    expect(page.pagination.total).toBe(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/captures?limit=100&offset=0',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
  })

  test('reads one capture and encodes its identifier', async () => {
    const detail = makeCaptureDetail()
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: detail })))
    const api = createHttpCaptureApi(fetchImpl)

    expect(await api.getCapture('capture/with space')).toEqual(detail)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/captures/capture%2Fwith%20space')
  })

  test('posts the correlation request and returns the linked result', async () => {
    const detail = makeBoundCaptureDetail()
    const correlation = makeCaptureCorrelation(detail)
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ data: correlation })))
    const api = createHttpCaptureApi(fetchImpl)

    const result = await api.correlateCapture(
      'capture-1',
      {
        rulebookId: 'rulebook-pid',
        rulebookVersion: '1.0',
        attestationType: 'Person Identification Data',
      },
      'csrf-token-value',
    )
    expect(result).toEqual(correlation)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/captures/capture-1/validate',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-csrf-token': 'csrf-token-value',
        },
        body: JSON.stringify({
          rulebookId: 'rulebook-pid',
          rulebookVersion: '1.0',
          attestationType: 'Person Identification Data',
        }),
      }),
    )
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(String(url)).not.toContain('csrf-token-value')
    expect(init?.body).not.toContain('csrf-token-value')
  })

  test('surfaces the safe API error message and status', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'conflict', message: 'The capture artifact is external.' } },
          409,
        ),
      ),
    )
    const api = createHttpCaptureApi(fetchImpl)

    await expect(
      api.correlateCapture(
        'capture-1',
        {
          rulebookId: 'rulebook-pid',
          rulebookVersion: '1.0',
          attestationType: 'PID',
        },
        'csrf-token-value',
      ),
    ).rejects.toMatchObject({
      name: 'CatalogApiError',
      status: 409,
      message: 'The capture artifact is external.',
    })
  })
})
