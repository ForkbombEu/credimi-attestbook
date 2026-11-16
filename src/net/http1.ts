// Bounded HTTP/1.1 client for untrusted remote endpoints.
//
// Callers resolve and validate an address first, then hand the pinned address
// to this transport. For HTTPS the transport opens TLS to that address while
// presenting the original hostname as SNI, so a second DNS answer cannot
// redirect the connection (DNS rebinding). Plain HTTP exists only for the
// separately configured test-loopback path used by local fixtures; callers
// must never pass a non-loopback HTTP target.
//
// The transport speaks HTTP/1.1 manually over the socket: Bun's `node:https`
// does not forward `servername`/`ca` the way Node does, and the transfer
// controls must behave identically under both runtimes. It enforces the
// per-request timeout and byte cap, supports an optional bounded request body,
// and returns redirects instead of following them.

import type { Socket } from 'node:net'
import { connect as tcpConnect, isIP } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { connect as tlsConnect } from 'node:tls'

/** Stable failure codes of the shared bounded transport. */
export type Http1TransportErrorCode = 'fetch_failed' | 'timeout' | 'response_too_large'

/** A safe transport failure; messages never include response bytes. */
export class Http1TransportError extends Error {
  readonly code: Http1TransportErrorCode

  constructor(code: Http1TransportErrorCode, message: string) {
    super(message)
    this.name = 'Http1TransportError'
    this.code = code
  }
}

export function isHttp1TransportError(value: unknown): value is Http1TransportError {
  return value instanceof Http1TransportError
}

/** One already-validated HTTP request handed to the transport. */
export interface Http1Request {
  readonly url: URL
  readonly hostname: string
  readonly address: string
  readonly family: 4 | 6
  readonly port: number
  readonly timeoutMs: number
  readonly maxBytes: number
  /** Only a body-less GET or a bounded POST are supported. */
  readonly method?: 'GET' | 'POST'
  readonly body?: Uint8Array
  readonly contentType?: string
  readonly accept?: string
  readonly userAgent?: string
  /**
   * Additional request headers, for example a webhook signature. Names and
   * values are validated before the head is written, so a caller cannot inject
   * a second request line; framing headers belong to the transport itself.
   */
  readonly headers?: Readonly<Record<string, string>>
}

/** A bounded HTTP response; redirects are returned, never followed here. */
export interface Http1Response {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly url: URL
}

/** Injectable HTTP transport used by the callers that need the real network. */
export type Http1Transport = (request: Http1Request) => Promise<Http1Response>

/** Options for the production transport. `ca` is for local TLS tests only. */
export interface CreateHttp1TransportOptions {
  /** Extra CA bundle used by local self-signed test servers. */
  readonly ca?: string | Buffer | Array<string | Buffer>
}

const MAX_RESPONSE_HEAD_BYTES = 64 * 1024
const DEFAULT_ACCEPT = 'application/json, application/*+json;q=0.9, text/plain;q=0.8, */*;q=0.1'
const DEFAULT_USER_AGENT = 'AttestBook/0.1 (+https://github.com/ForkbombEu/credimi-attestbook)'

interface ResponseHead {
  readonly status: number
  readonly headers: Record<string, string>
}

function parseResponseHead(text: string): ResponseHead {
  const lines = text.split('\r\n')
  const statusLine = lines[0] ?? ''
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine)
  if (statusMatch === null) {
    throw new Http1TransportError(
      'fetch_failed',
      'the remote endpoint returned an invalid HTTP response',
    )
  }
  const status = Number(statusMatch[1])
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    if (line === '') {
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) {
      throw new Http1TransportError(
        'fetch_failed',
        'the remote endpoint returned invalid HTTP headers',
      )
    }
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
  }
  return { status, headers }
}

function mapSocketError(error: unknown): Http1TransportError {
  if (isHttp1TransportError(error)) {
    return error
  }
  return new Http1TransportError('fetch_failed', 'the remote endpoint could not be reached')
}

/** RFC 9110 token: what a header name may contain. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** No CR, LF or other control characters: a value cannot end the head early. */
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]*$/

/** Framing headers the transport writes itself; a caller must not duplicate them. */
const RESERVED_HEADERS = new Set([
  'host',
  'accept',
  'user-agent',
  'accept-encoding',
  'connection',
  'content-type',
  'content-length',
  'transfer-encoding',
])

/**
 * Writes caller-supplied headers. A redefined framing header or a value that
 * could terminate a line is a programming error, not a remote failure, so this
 * throws a plain `Error` before any socket is opened.
 */
function appendExtraHeaders(lines: string[], headers: Readonly<Record<string, string>>): void {
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim()
    const value = rawValue.trim()
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`request header name ${JSON.stringify(rawName)} is not a valid token`)
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new Error(`request header ${JSON.stringify(name)} is written by the transport`)
    }
    if (!HEADER_VALUE_PATTERN.test(value)) {
      throw new Error(`request header ${JSON.stringify(name)} has an invalid value`)
    }
    lines.push(`${name}: ${value}`)
  }
}

function requestHead(request: Http1Request): string {
  const method = request.method ?? 'GET'
  const hostname = isIP(request.hostname) === 6 ? `[${request.hostname}]` : request.hostname
  const defaultPort = request.url.protocol === 'https:' ? 443 : 80
  const host = request.port === defaultPort ? hostname : `${hostname}:${request.port}`
  const lines = [
    `${method} ${request.url.pathname}${request.url.search} HTTP/1.1`,
    `Host: ${host}`,
    `Accept: ${request.accept ?? DEFAULT_ACCEPT}`,
    `User-Agent: ${request.userAgent ?? DEFAULT_USER_AGENT}`,
    'Accept-Encoding: identity',
    'Connection: close',
  ]
  if (request.body !== undefined) {
    lines.push(`Content-Type: ${request.contentType ?? 'application/octet-stream'}`)
    lines.push(`Content-Length: ${String(request.body.byteLength)}`)
  }
  if (request.headers !== undefined) {
    appendExtraHeaders(lines, request.headers)
  }
  lines.push('', '')
  return lines.join('\r\n')
}

/**
 * Production transport. It connects to the validated address, presents the
 * original hostname for SNI (and therefore certificate identity validation) on
 * HTTPS, enforces the per-request deadline, and streams the response under a
 * byte cap. Chunked responses are decoded incrementally; redirects are
 * returned to the caller, never followed.
 */
export function createHttp1Transport(options: CreateHttp1TransportOptions = {}): Http1Transport {
  return (request) =>
    new Promise<Http1Response>((resolve, reject) => {
      const protocol = request.url.protocol
      if (protocol !== 'https:' && protocol !== 'http:') {
        reject(new Http1TransportError('fetch_failed', 'the remote endpoint URL is not HTTP'))
        return
      }

      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let buffer = Buffer.alloc(0)
      let head: ResponseHead | undefined
      const bodyChunks: Buffer[] = []
      let bodyLength = 0
      let expectedLength: number | null = null
      let chunked = false
      let chunkState: 'size' | 'data' | 'data-crlf' | 'trailers' = 'size'
      let chunkRemaining = 0
      let socket: TLSSocket | Socket | undefined

      const clearTimer = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
      }
      const fail = (error: Http1TransportError): void => {
        if (!settled) {
          settled = true
          clearTimer()
          socket?.destroy()
          reject(error)
        }
      }
      const succeed = (status: number, headers: Record<string, string>): void => {
        if (!settled) {
          settled = true
          clearTimer()
          socket?.destroy()
          resolve({ status, headers, body: Buffer.concat(bodyChunks), url: request.url })
        }
      }
      const appendBody = (bytes: Buffer): void => {
        if (bytes.length === 0) {
          return
        }
        bodyLength += bytes.length
        if (bodyLength > request.maxBytes) {
          throw new Http1TransportError(
            'response_too_large',
            `the remote endpoint response exceeds the ${String(request.maxBytes)}-byte limit`,
          )
        }
        bodyChunks.push(bytes)
      }

      /** Feeds raw bytes to the chunked decoder; returns true when complete. */
      const feedChunked = (): boolean => {
        for (;;) {
          if (chunkState === 'size') {
            const lineEnd = buffer.indexOf('\r\n')
            if (lineEnd === -1) {
              if (buffer.length > 256) {
                throw new Http1TransportError(
                  'fetch_failed',
                  'the remote endpoint sent an invalid chunked body',
                )
              }
              return false
            }
            const line = buffer.subarray(0, lineEnd).toString('latin1')
            buffer = buffer.subarray(lineEnd + 2)
            const sizeText = line.split(';')[0]?.trim() ?? ''
            if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
              throw new Http1TransportError(
                'fetch_failed',
                'the remote endpoint sent an invalid chunked body',
              )
            }
            chunkRemaining = Number.parseInt(sizeText, 16)
            if (chunkRemaining === 0) {
              chunkState = 'trailers'
            } else {
              chunkState = 'data'
            }
            continue
          }
          if (chunkState === 'data') {
            if (buffer.length === 0) {
              return false
            }
            const take = Math.min(buffer.length, chunkRemaining)
            appendBody(buffer.subarray(0, take))
            buffer = buffer.subarray(take)
            chunkRemaining -= take
            if (chunkRemaining === 0) {
              chunkState = 'data-crlf'
            }
            continue
          }
          if (chunkState === 'data-crlf') {
            if (buffer.length < 2) {
              return false
            }
            if (buffer[0] !== 0x0d || buffer[1] !== 0x0a) {
              throw new Http1TransportError(
                'fetch_failed',
                'the remote endpoint sent an invalid chunked body',
              )
            }
            buffer = buffer.subarray(2)
            chunkState = 'size'
            continue
          }
          // Trailers end with a blank line; the common case is an immediate CRLF.
          if (buffer.length >= 2 && buffer[0] === 0x0d && buffer[1] === 0x0a) {
            buffer = buffer.subarray(2)
            return true
          }
          const trailerEnd = buffer.indexOf('\r\n\r\n')
          if (trailerEnd === -1) {
            if (buffer.length > MAX_RESPONSE_HEAD_BYTES) {
              throw new Http1TransportError(
                'fetch_failed',
                'the remote endpoint sent oversized trailers',
              )
            }
            return false
          }
          buffer = buffer.subarray(trailerEnd + 4)
          return true
        }
      }

      const processBuffer = (): void => {
        if (settled) {
          return
        }
        if (head === undefined) {
          const headEnd = buffer.indexOf('\r\n\r\n')
          if (headEnd === -1) {
            if (buffer.length > MAX_RESPONSE_HEAD_BYTES) {
              fail(
                new Http1TransportError(
                  'fetch_failed',
                  'the remote endpoint response head is too large',
                ),
              )
            }
            return
          }
          try {
            head = parseResponseHead(buffer.subarray(0, headEnd).toString('latin1'))
          } catch (error) {
            fail(mapSocketError(error))
            return
          }
          buffer = buffer.subarray(headEnd + 4)
          chunked = head.headers['transfer-encoding']?.toLowerCase().includes('chunked') === true
          const declared = head.headers['content-length']
          if (!chunked && declared !== undefined) {
            const value = Number(declared)
            if (!Number.isSafeInteger(value) || value < 0) {
              fail(
                new Http1TransportError(
                  'fetch_failed',
                  'the remote endpoint sent an invalid content-length',
                ),
              )
              return
            }
            if (value > request.maxBytes) {
              fail(
                new Http1TransportError(
                  'response_too_large',
                  `the remote endpoint response exceeds the ${String(request.maxBytes)}-byte limit`,
                ),
              )
              return
            }
            expectedLength = value
          }
        }

        try {
          if (chunked) {
            if (feedChunked()) {
              succeed(head.status, head.headers)
            }
            return
          }
          if (buffer.length > 0) {
            appendBody(buffer)
            buffer = Buffer.alloc(0)
          }
          if (expectedLength !== null && bodyLength >= expectedLength) {
            succeed(head.status, head.headers)
          }
        } catch (error) {
          fail(mapSocketError(error))
        }
      }

      // The head is built before the socket is opened so an invalid caller
      // header rejects the request instead of escaping from a socket event.
      let requestHeadText: string
      try {
        requestHeadText = requestHead(request)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('the request head could not be built'))
        return
      }

      const onConnect = (): void => {
        if (request.body === undefined) {
          socket?.write(requestHeadText)
          return
        }
        socket?.write(Buffer.from(requestHeadText, 'latin1'))
        socket?.write(Buffer.from(request.body))
      }

      try {
        if (protocol === 'https:') {
          socket = tlsConnect(
            {
              host: request.address,
              port: request.port,
              ...(isIP(request.hostname) === 0 ? { servername: request.hostname } : {}),
              ...(options.ca !== undefined ? { ca: options.ca } : {}),
            },
            onConnect,
          )
        } else {
          socket = tcpConnect({ host: request.address, port: request.port }, onConnect)
        }
      } catch (error) {
        fail(mapSocketError(error))
        return
      }

      timer = setTimeout(() => {
        fail(new Http1TransportError('timeout', 'the remote endpoint request timed out'))
      }, request.timeoutMs)

      socket.setTimeout(request.timeoutMs, () => {
        fail(new Http1TransportError('timeout', 'the remote endpoint request timed out'))
      })
      socket.on('data', (chunk: Buffer) => {
        if (settled) {
          return
        }
        buffer = Buffer.concat([buffer, chunk])
        processBuffer()
      })
      socket.on('error', (error: Error) => fail(mapSocketError(error)))
      socket.on('close', () => {
        if (settled) {
          return
        }
        processBuffer()
        if (settled) {
          return
        }
        // No content-length and no chunk terminator: the close ends the body.
        if (head !== undefined && !chunked && expectedLength === null) {
          succeed(head.status, head.headers)
        } else {
          fail(
            new Http1TransportError('fetch_failed', 'the remote endpoint connection closed early'),
          )
        }
      })
    })
}
