// Tests for the production HTTPS transport, not the injected fake transport.
//
// These exercise the §15 transport controls that only the real path provides:
// connecting to the pinned address while presenting the original hostname as
// SNI and Host, certificate validation, the streaming byte cap, the request
// timeout and the fact that redirects are returned rather than followed.

import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:https'

import { ImportError, type ImportErrorCode } from './errors'
import { createHttpsTransport, type ImportHttpRequest } from './http'
import { TEST_TLS_CERTIFICATE, TEST_TLS_KEY } from './test/tls-fixtures'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

async function startServer(
  handler: Parameters<typeof createServer>[1],
): Promise<{ readonly port: number; readonly server: Server }> {
  const server = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERTIFICATE }, handler)
  servers.push(server)
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the test server has no port'))
        return
      }
      resolve(address.port)
    })
  })
  return { port, server }
}

function requestFor(port: number, overrides: Partial<ImportHttpRequest> = {}): ImportHttpRequest {
  return {
    url: new URL(`https://localhost:${port}/schemas.json`),
    hostname: 'localhost',
    address: '127.0.0.1',
    family: 4,
    port,
    timeoutMs: 2_000,
    maxBytes: 1_024,
    ...overrides,
  }
}

async function expectTransportError(
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

describe('production HTTPS transport', () => {
  test('connects to the pinned address while presenting the original Host', async () => {
    let seenHost: string | undefined
    const { port } = await startServer((request, response) => {
      seenHost = request.headers.host
      response.setHeader('content-type', 'application/json')
      response.end('{"ok":true}')
    })

    const transport = createHttpsTransport({ ca: TEST_TLS_CERTIFICATE })
    const response = await transport(requestFor(port))

    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}')
    // Bun's HTTPS server does not expose the received SNI on the socket, so the
    // certificate-mismatch test below is the observable proof that the original
    // hostname, rather than the pinned address, drives identity validation.
    expect(seenHost).toBe(`localhost:${port}`)
  })

  test('rejects a certificate that does not match the presented hostname', async () => {
    const { port } = await startServer((_request, response) => {
      response.end('{}')
    })
    const transport = createHttpsTransport({ ca: TEST_TLS_CERTIFICATE })

    await expectTransportError(
      transport(
        requestFor(port, {
          hostname: 'other.example',
          url: new URL(`https://other.example:${port}/`),
        }),
      ),
      'fetch_failed',
    )
  })

  test('rejects a chunked body that exceeds the byte cap while streaming', async () => {
    const { port } = await startServer((_request, response) => {
      response.on('error', () => {})
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('12345')
      setTimeout(() => response.end('67890'), 5)
    })
    const transport = createHttpsTransport({ ca: TEST_TLS_CERTIFICATE })

    await expectTransportError(transport(requestFor(port, { maxBytes: 8 })), 'response_too_large')
  })

  test('times out a server that accepts the request but never responds', async () => {
    const { port } = await startServer((_request, _response) => {
      // Intentionally never respond; the client timeout must close the socket.
    })
    const transport = createHttpsTransport({ ca: TEST_TLS_CERTIFICATE })

    await expectTransportError(transport(requestFor(port, { timeoutMs: 50 })), 'timeout')
  })

  test('returns redirects without following them', async () => {
    let requests = 0
    const { port } = await startServer((_request, response) => {
      requests += 1
      response.writeHead(302, { location: 'https://example.invalid/next.json' })
      response.end()
    })
    const transport = createHttpsTransport({ ca: TEST_TLS_CERTIFICATE })

    const response = await transport(requestFor(port))

    expect(response.status).toBe(302)
    expect(response.headers['location']).toBe('https://example.invalid/next.json')
    expect(requests).toBe(1)
  })
})
