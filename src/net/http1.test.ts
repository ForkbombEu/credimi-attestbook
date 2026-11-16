// Tests for the bounded HTTP/1.1 transport's caller-supplied headers (#119).
//
// Webhook delivery needs signed request headers. These prove the headers reach
// the server unchanged and that a caller cannot inject a second request line,
// redefine a framing header or open a socket with an invalid header.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'

import { createHttp1Transport, type Http1Request } from './http1'

const servers: Server<unknown>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    void server.stop(true)
  }
})

function startServer(headers: readonly string[] = []): { readonly port: number } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      // Echo the requested headers in the body so the assertion does not depend
      // on an in-process side effect racing the client.
      const seen = Object.fromEntries(headers.map((name) => [name, request.headers.get(name)]))
      return new Response(JSON.stringify(seen), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  servers.push(server)
  if (server.port === undefined) {
    throw new Error('the test server has no port')
  }
  return { port: server.port }
}

function requestFor(port: number, overrides: Partial<Http1Request> = {}): Http1Request {
  return {
    url: new URL(`http://127.0.0.1:${String(port)}/hook`),
    hostname: '127.0.0.1',
    address: '127.0.0.1',
    family: 4,
    port,
    timeoutMs: 2_000,
    maxBytes: 1_024,
    method: 'POST',
    body: Buffer.from('{}'),
    contentType: 'application/json',
    ...overrides,
  }
}

describe('HTTP/1.1 transport caller headers', () => {
  test('sends caller headers unchanged', async () => {
    const { port } = startServer(['x-attestbook-event-id', 'x-custom-signature'])
    const transport = createHttp1Transport()
    const response = await transport(
      requestFor(port, {
        headers: {
          'X-AttestBook-Event-Id': 'event-1',
          'X-Custom-Signature': 'v1=abc',
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(Buffer.from(response.body).toString('utf8'))).toEqual({
      'x-attestbook-event-id': 'event-1',
      'x-custom-signature': 'v1=abc',
    })
  })

  async function rejectionOf(headers: Readonly<Record<string, string>>): Promise<Error> {
    const { port } = startServer()
    const transport = createHttp1Transport()
    try {
      await transport(requestFor(port, { headers }))
    } catch (error) {
      if (error instanceof Error) {
        return error
      }
      throw error
    }
    throw new Error('expected the transport to reject the request')
  }

  test('rejects a CRLF injection before opening a socket', async () => {
    const error = await rejectionOf({ 'X-Evil': 'a\r\nX-Injected: b' })
    expect(error.message).toContain('invalid value')
  })

  test('rejects redefining a framing header', async () => {
    const error = await rejectionOf({ 'Content-Length': '0' })
    expect(error.message).toContain('written by the transport')
  })

  test('rejects an invalid header name', async () => {
    const error = await rejectionOf({ 'Bad Header': 'x' })
    expect(error.message).toContain('not a valid token')
  })
})
