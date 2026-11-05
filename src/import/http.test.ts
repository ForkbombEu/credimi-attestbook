import { describe, expect, test } from 'bun:test'

import { ImportError, type ImportErrorCode } from './errors'
import { createFakeTransport, failingTransport, publicResolver } from './test/fixtures'
import { fetchImportDocument } from './http'
import { DEFAULT_IMPORT_LIMITS } from './limits'

const limits = { ...DEFAULT_IMPORT_LIMITS, maxSourceBytes: 64, maxRedirects: 2 }
const baseOptions = { limits, resolveHostname: publicResolver }

async function expectFetchError(
  promise: Promise<unknown>,
  code: ImportErrorCode,
): Promise<ImportError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ImportError)
  expect((caught as ImportError).code).toBe(code)
  return caught as ImportError
}

describe('bounded import fetch', () => {
  test('retrieves a JSON document with provenance', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': {
        body: '{"data":[]}',
        headers: { 'content-type': 'application/json; charset=utf-8', etag: '"abc"' },
      },
    })

    const document = await fetchImportDocument('https://catalog.example.test/schemas.json#x', {
      ...baseOptions,
      transport: fake.transport,
      now: () => '2026-11-05T10:00:00.000Z',
    })

    expect(document.requestedUrl).toBe('https://catalog.example.test/schemas.json')
    expect(document.finalUrl).toBe('https://catalog.example.test/schemas.json')
    expect(document.status).toBe(200)
    expect(document.contentType).toContain('application/json')
    expect(new TextDecoder().decode(document.bytes)).toBe('{"data":[]}')
    expect(document.fetchedAt).toBe('2026-11-05T10:00:00.000Z')
    expect(fake.requests[0]?.address).toBe('93.184.216.34')
  })

  test('rejects a non-JSON content type', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': {
        body: '<html></html>',
        headers: { 'content-type': 'text/html' },
      },
    })

    await expectFetchError(
      fetchImportDocument('https://catalog.example.test/schemas.json', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'unsupported_content_type',
    )
  })

  test('rejects an oversized response, including a missing content-length', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': { body: 'a'.repeat(65) },
    })

    await expectFetchError(
      fetchImportDocument('https://catalog.example.test/schemas.json', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'response_too_large',
    )
  })

  test('rejects a response whose declared content-length exceeds the limit', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': {
        body: '{}',
        headers: { 'content-length': '1000' },
      },
    })

    await expectFetchError(
      fetchImportDocument('https://catalog.example.test/schemas.json', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'response_too_large',
    )
  })

  test('stops when the total time budget is exhausted across redirects', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': {
        status: 302,
        headers: { location: 'https://catalog.example.test/next.json' },
      },
      'https://catalog.example.test/next.json': { body: '{}' },
    })
    let tick = 0
    const monotonicNow = () => {
      tick += 1
      return tick === 1 ? 0 : 10_000
    }

    await expectFetchError(
      fetchImportDocument('https://catalog.example.test/schemas.json', {
        limits: { ...limits, totalTimeoutMs: 1_000 },
        transport: fake.transport,
        resolveHostname: publicResolver,
        monotonicNow,
      }),
      'timeout',
    )
  })

  test('follows public redirects and records them', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': {
        status: 302,
        headers: { location: 'https://catalog.example.test/v2/schemas.json' },
      },
      'https://catalog.example.test/v2/schemas.json': { body: '{"data":[]}' },
    })

    const document = await fetchImportDocument('https://catalog.example.test/schemas.json', {
      ...baseOptions,
      transport: fake.transport,
    })

    expect(document.finalUrl).toBe('https://catalog.example.test/v2/schemas.json')
    expect(document.redirects).toEqual(['https://catalog.example.test/v2/schemas.json'])
    expect(fake.requests).toHaveLength(2)
  })

  test('re-validates a redirect and refuses a private target before fetching it', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': {
        status: 302,
        headers: { location: 'https://127.0.0.1/latest/meta-data' },
      },
    })

    await expectFetchError(
      fetchImportDocument('https://catalog.example.test/schemas.json', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'blocked_address',
    )
    expect(fake.requests).toHaveLength(1)
  })

  test('refuses a redirect to a non-https target', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': {
        status: 302,
        headers: { location: 'http://catalog.example.test/schemas.json' },
      },
    })

    await expectFetchError(
      fetchImportDocument('https://catalog.example.test/schemas.json', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'invalid_url',
    )
    expect(fake.requests).toHaveLength(1)
  })

  test('stops after the configured redirect count', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/1': {
        status: 302,
        headers: { location: 'https://catalog.example.test/2' },
      },
      'https://catalog.example.test/2': {
        status: 302,
        headers: { location: 'https://catalog.example.test/3' },
      },
      'https://catalog.example.test/3': {
        status: 302,
        headers: { location: 'https://catalog.example.test/4' },
      },
    })

    await expectFetchError(
      fetchImportDocument('https://catalog.example.test/1', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'redirect_limit',
    )
  })

  test('reports an unsupported HTTP status', async () => {
    const fake = createFakeTransport({
      'https://catalog.example.test/schemas.json': { status: 404, body: '{}' },
    })

    await expectFetchError(
      fetchImportDocument('https://catalog.example.test/schemas.json', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'unsupported_status',
    )
  })

  test('propagates a transport timeout without leaking details', async () => {
    const fake = failingTransport(new ImportError('timeout', 'timed out'))
    const error = await expectFetchError(
      fetchImportDocument('https://catalog.example.test/schemas.json', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'timeout',
    )

    expect(error.message).not.toContain('catalog.example.test')
  })

  test('never calls the transport for a blocked initial URL', async () => {
    const fake = createFakeTransport({})
    await expectFetchError(
      fetchImportDocument('https://192.168.0.1/schemas.json', {
        ...baseOptions,
        transport: fake.transport,
      }),
      'blocked_address',
    )
    expect(fake.requests).toHaveLength(0)
  })
})
