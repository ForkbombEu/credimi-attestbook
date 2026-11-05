// Bounded HTTPS retrieval for untrusted rulebook imports.
//
// Fetching has its own transport seam so tests can exercise redirect, size,
// timeout and content-type policy offline. The production transport connects to
// the address resolved and validated by `url.ts` and passes the original
// hostname only as TLS SNI/Host, which prevents a second DNS lookup from
// reaching an internal address (DNS rebinding).

import type { IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import { ImportError, importError, isImportError } from './errors'
import type { ImportLimits } from './limits'
import { resolveImportTarget, validateImportUrl, type HostResolver } from './url'

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

/** A successfully retrieved import document. */
export interface FetchedImportDocument {
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string | null
  readonly bytes: Uint8Array
  readonly fetchedAt: string
  readonly redirects: readonly string[]
}

export interface FetchImportDocumentOptions {
  readonly limits: ImportLimits
  readonly transport?: ImportHttpTransport
  readonly resolveHostname?: HostResolver
  /** Wall-clock timestamp for provenance; injectable for deterministic tests. */
  readonly now?: () => string
  /** Monotonic clock used for the total fetch deadline. */
  readonly monotonicNow?: () => number
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const ACCEPTED_CONTENT_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'text/json',
  'text/plain',
])

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue
    }
    normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return normalized
}

function mapTransportError(error: unknown): ImportError {
  if (isImportError(error)) {
    return error
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ABORT_ERR') {
    return importError('timeout', 'the remote document request timed out')
  }
  return importError('fetch_failed', 'the remote document could not be retrieved')
}

/**
 * Production transport. It connects to the pinned `address`, presents the
 * original hostname for certificate validation and SNI, and enforces the
 * per-request timeout and byte cap while streaming the body.
 */
export function createHttpsTransport(): ImportHttpTransport {
  return (request) =>
    new Promise<ImportHttpResponse>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
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
          reject(error)
        }
      }
      const succeed = (response: ImportHttpResponse): void => {
        if (!settled) {
          settled = true
          clearTimer()
          resolve(response)
        }
      }

      const hostnameForHeader =
        isIP(request.hostname) === 6 ? `[${request.hostname}]` : request.hostname
      const hostHeader =
        request.port === 443 ? hostnameForHeader : `${hostnameForHeader}:${request.port}`
      const client = httpsRequest(
        {
          method: 'GET',
          hostname: request.address,
          family: request.family,
          port: request.port,
          path: `${request.url.pathname}${request.url.search}`,
          ...(isIP(request.hostname) === 0 ? { servername: request.hostname } : {}),
          headers: {
            Host: hostHeader,
            Accept: 'application/json, application/*+json;q=0.9, text/plain;q=0.8, */*;q=0.1',
            'User-Agent': 'AttestBook/0.1 (+https://github.com/ForkbombEu/credimi-attestbook)',
            'Accept-Encoding': 'identity',
            Connection: 'close',
          },
          timeout: request.timeoutMs,
        },
        (response) => {
          const status = response.statusCode ?? 0
          const headers = normalizeHeaders(response.headers)
          const declaredLength = headers['content-length']
          if (declaredLength !== undefined && Number(declaredLength) > request.maxBytes) {
            response.destroy()
            fail(
              importError(
                'response_too_large',
                `the remote document exceeds the ${request.maxBytes}-byte limit`,
              ),
            )
            return
          }

          const chunks: Buffer[] = []
          let total = 0
          response.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > request.maxBytes) {
              response.destroy()
              fail(
                importError(
                  'response_too_large',
                  `the remote document exceeds the ${request.maxBytes}-byte limit`,
                ),
              )
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            succeed({
              status,
              headers,
              body: Buffer.concat(chunks),
              url: request.url,
            })
          })
          response.on('error', (error: Error) => fail(mapTransportError(error)))
        },
      )

      // The socket timeout below covers a stalled transfer; this timer also
      // covers a connect/TLS handshake that never assigns a socket deadline.
      timer = setTimeout(() => {
        client.destroy()
        fail(importError('timeout', 'the remote document request timed out'))
      }, request.timeoutMs)

      client.on('timeout', () => {
        client.destroy()
        fail(importError('timeout', 'the remote document request timed out'))
      })
      client.on('error', (error: Error) => fail(mapTransportError(error)))
      client.end()
    })
}

function isAcceptedContentType(raw: string | null): boolean {
  if (raw === null || raw.trim() === '') {
    return true
  }
  const mediaType = raw.split(';')[0]?.trim().toLowerCase() ?? ''
  return ACCEPTED_CONTENT_TYPES.has(mediaType) || mediaType.endsWith('+json')
}

function responseBytes(response: ImportHttpResponse, limits: ImportLimits): Uint8Array {
  if (response.body.byteLength > limits.maxSourceBytes) {
    throw importError(
      'response_too_large',
      `the remote document exceeds the ${limits.maxSourceBytes}-byte limit`,
    )
  }
  return response.body
}

/**
 * Retrieves one document over HTTPS under every §15 transfer control:
 * https-only URL validation, public-address resolution, redirect
 * re-validation, a total deadline, a per-request timeout, a byte cap and a
 * restrictive content-type policy. Redirects are followed manually so each
 * target goes through the same checks as the original URL.
 */
export async function fetchImportDocument(
  rawUrl: unknown,
  options: FetchImportDocumentOptions,
): Promise<FetchedImportDocument> {
  const { limits } = options
  const transport = options.transport ?? createHttpsTransport()
  const resolver = options.resolveHostname
  const now = options.now ?? (() => new Date().toISOString())
  const monotonicNow = options.monotonicNow ?? (() => Date.now())

  const requested = validateImportUrl(rawUrl, limits)
  let current = requested
  const redirects: string[] = []
  const deadline = monotonicNow() + limits.totalTimeoutMs

  for (;;) {
    const beforeResolve = deadline - monotonicNow()
    if (beforeResolve <= 0) {
      throw importError('timeout', 'the remote document request exceeded its total time budget')
    }
    const target = await resolveImportTarget(current, resolver, { timeoutMs: beforeResolve })
    const remaining = deadline - monotonicNow()
    if (remaining <= 0) {
      throw importError('timeout', 'the remote document request exceeded its total time budget')
    }

    const response = await transport({
      url: current,
      hostname: target.hostname,
      address: target.address,
      family: target.family,
      port: target.port,
      timeoutMs: Math.min(limits.requestTimeoutMs, remaining),
      maxBytes: limits.maxSourceBytes,
    })

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers['location']
      if (location === undefined || location.trim() === '') {
        throw importError('unsupported_status', 'a redirect response did not include a location')
      }
      if (redirects.length >= limits.maxRedirects) {
        throw importError(
          'redirect_limit',
          `the import followed more than ${limits.maxRedirects} redirects`,
        )
      }
      let next: URL
      try {
        next = validateImportUrl(new URL(location, current).href, limits)
      } catch (error) {
        if (error instanceof ImportError) {
          throw error
        }
        throw importError('invalid_url', 'a redirect target is not a valid https URL')
      }
      redirects.push(next.href)
      current = next
      continue
    }

    if (response.status < 200 || response.status > 299) {
      throw importError(
        'unsupported_status',
        `the remote document request returned HTTP status ${response.status}`,
      )
    }

    const declaredLength = response.headers['content-length']
    if (declaredLength !== undefined && Number(declaredLength) > limits.maxSourceBytes) {
      throw importError(
        'response_too_large',
        `the remote document exceeds the ${limits.maxSourceBytes}-byte limit`,
      )
    }

    const contentType = response.headers['content-type'] ?? null
    if (!isAcceptedContentType(contentType)) {
      throw importError(
        'unsupported_content_type',
        'the remote document is not served as JSON; the response content type is not accepted',
      )
    }

    return {
      requestedUrl: requested.href,
      finalUrl: current.href,
      status: response.status,
      contentType,
      bytes: responseBytes(response, limits),
      fetchedAt: now(),
      redirects,
    }
  }
}
