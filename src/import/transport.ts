// Production HTTPS transport for untrusted imports.
//
// The fetcher resolves and validates a public address, then hands it to this
// transport. The transport opens TLS to the pinned address while presenting
// the original hostname as SNI, so a second DNS answer cannot redirect the
// connection. It speaks HTTP/1.1 manually over the TLS socket: Bun's
// `node:https` does not forward `servername`/`ca` the way Node does, and the
// import controls must behave identically under both runtimes.
//
// The transport enforces the per-request timeout and byte cap and returns
// redirects; it never follows them.

import type { TLSSocket } from 'node:tls'
import { connect as tlsConnect } from 'node:tls'
import { isIP } from 'node:net'

import { importError, isImportError, type ImportError } from './errors'

/** One already-validated HTTP request handed to a transport. */
export interface ImportHttpRequest {
  readonly url: URL
  readonly hostname: string
  readonly address: string
  readonly family: 4 | 6
  readonly port: number
  readonly timeoutMs: number
  readonly maxBytes: number
}

/** A bounded HTTP response; redirects are returned, never followed here. */
export interface ImportHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly url: URL
}

/** Injectable HTTP transport used by the fetcher. */
export type ImportHttpTransport = (request: ImportHttpRequest) => Promise<ImportHttpResponse>

/** Options for the production transport. `ca` is for local TLS tests only. */
export interface CreateHttpsTransportOptions {
  /** Extra CA bundle used by the local self-signed test server. */
  readonly ca?: string | Buffer | Array<string | Buffer>
}

const MAX_RESPONSE_HEAD_BYTES = 64 * 1024
const ACCEPT_HEADER = 'application/json, application/*+json;q=0.9, text/plain;q=0.8, */*;q=0.1'
const USER_AGENT = 'AttestBook/0.1 (+https://github.com/ForkbombEu/credimi-attestbook)'

interface ResponseHead {
  readonly status: number
  readonly headers: Record<string, string>
}

function parseResponseHead(text: string): ResponseHead {
  const lines = text.split('\r\n')
  const statusLine = lines[0] ?? ''
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine)
  if (statusMatch === null) {
    throw importError('fetch_failed', 'the remote document returned an invalid HTTP response')
  }
  const status = Number(statusMatch[1])
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    if (line === '') {
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) {
      throw importError('fetch_failed', 'the remote document returned invalid HTTP headers')
    }
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
  }
  return { status, headers }
}

function mapTlsError(error: unknown): ImportError {
  if (isImportError(error)) {
    return error
  }
  return importError('fetch_failed', 'the remote document could not be retrieved')
}

function requestHead(request: ImportHttpRequest): string {
  const hostname = isIP(request.hostname) === 6 ? `[${request.hostname}]` : request.hostname
  const host = request.port === 443 ? hostname : `${hostname}:${request.port}`
  return [
    `GET ${request.url.pathname}${request.url.search} HTTP/1.1`,
    `Host: ${host}`,
    `Accept: ${ACCEPT_HEADER}`,
    `User-Agent: ${USER_AGENT}`,
    'Accept-Encoding: identity',
    'Connection: close',
    '',
    '',
  ].join('\r\n')
}

/**
 * Production transport. It connects TLS to the validated address, presents the
 * original hostname for SNI (and therefore certificate identity validation),
 * enforces the per-request deadline, and streams the response under a byte
 * cap. Chunked responses are decoded incrementally; redirects are returned.
 */
export function createHttpsTransport(
  options: CreateHttpsTransportOptions = {},
): ImportHttpTransport {
  return (request) =>
    new Promise<ImportHttpResponse>((resolve, reject) => {
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
      let socket: TLSSocket | undefined

      const clearTimer = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
      }
      const fail = (error: ImportError): void => {
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
          throw importError(
            'response_too_large',
            `the remote document exceeds the ${request.maxBytes}-byte limit`,
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
                throw importError(
                  'fetch_failed',
                  'the remote document sent an invalid chunked body',
                )
              }
              return false
            }
            const line = buffer.subarray(0, lineEnd).toString('latin1')
            buffer = buffer.subarray(lineEnd + 2)
            const sizeText = line.split(';')[0]?.trim() ?? ''
            if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
              throw importError('fetch_failed', 'the remote document sent an invalid chunked body')
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
              throw importError('fetch_failed', 'the remote document sent an invalid chunked body')
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
              throw importError('fetch_failed', 'the remote document sent oversized trailers')
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
              fail(importError('fetch_failed', 'the remote document response head is too large'))
            }
            return
          }
          try {
            head = parseResponseHead(buffer.subarray(0, headEnd).toString('latin1'))
          } catch (error) {
            fail(mapTlsError(error))
            return
          }
          buffer = buffer.subarray(headEnd + 4)
          chunked = head.headers['transfer-encoding']?.toLowerCase().includes('chunked') === true
          const declared = head.headers['content-length']
          if (!chunked && declared !== undefined) {
            const value = Number(declared)
            if (!Number.isSafeInteger(value) || value < 0) {
              fail(
                importError('fetch_failed', 'the remote document sent an invalid content-length'),
              )
              return
            }
            if (value > request.maxBytes) {
              fail(
                importError(
                  'response_too_large',
                  `the remote document exceeds the ${request.maxBytes}-byte limit`,
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
          fail(mapTlsError(error))
        }
      }

      try {
        socket = tlsConnect(
          {
            host: request.address,
            port: request.port,
            ...(isIP(request.hostname) === 0 ? { servername: request.hostname } : {}),
            ...(options.ca !== undefined ? { ca: options.ca } : {}),
          },
          () => {
            socket?.write(requestHead(request))
          },
        )
      } catch (error) {
        fail(mapTlsError(error))
        return
      }

      timer = setTimeout(() => {
        fail(importError('timeout', 'the remote document request timed out'))
      }, request.timeoutMs)

      socket.setTimeout(request.timeoutMs, () => {
        fail(importError('timeout', 'the remote document request timed out'))
      })
      socket.on('data', (chunk: Buffer) => {
        if (settled) {
          return
        }
        buffer = Buffer.concat([buffer, chunk])
        processBuffer()
      })
      socket.on('error', (error: Error) => fail(mapTlsError(error)))
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
          fail(importError('fetch_failed', 'the remote document connection closed early'))
        }
      })
    })
}
