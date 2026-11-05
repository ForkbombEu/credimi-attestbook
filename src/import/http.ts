// Bounded HTTPS retrieval for untrusted rulebook imports.
//
// Fetching has its own transport seam so tests can exercise redirect, size,
// timeout and content-type policy offline. The production transport lives in
// `transport.ts`: it connects to the address resolved and validated by
// `url.ts` and passes the original hostname only as TLS SNI, which prevents a
// second DNS lookup from reaching an internal address (DNS rebinding).

import type { ImportLimits } from './limits'
import {
  createHttpsTransport,
  type ImportHttpResponse,
  type ImportHttpTransport,
} from './transport'
import { resolveImportTarget, validateImportUrl, type HostResolver } from './url'
import { importError, isImportError } from './errors'

export type {
  CreateHttpsTransportOptions,
  ImportHttpRequest,
  ImportHttpResponse,
  ImportHttpTransport,
} from './transport'
export { createHttpsTransport }

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
        if (isImportError(error)) {
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
