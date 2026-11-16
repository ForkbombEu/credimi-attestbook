// Production HTTPS transport for untrusted imports.
//
// The fetcher resolves and validates a public address, then hands it to the
// shared bounded HTTP/1.1 transport. That transport opens TLS to the pinned
// address while presenting the original hostname as SNI, so a second DNS
// answer cannot redirect the connection. Imports use GET without a body, and
// the transport returns redirects instead of following them.
//
// The transport enforces the per-request timeout and byte cap. This module
// maps its typed failures onto `ImportError`, which the import pipeline and
// the API error contract already understand.

import {
  createHttp1Transport,
  isHttp1TransportError,
  type Http1Request,
  type Http1Response,
} from '../net/http1'

import { importError } from './errors'

/** One already-validated import request handed to the transport. */
export type ImportHttpRequest = Http1Request

/** A bounded HTTP response; redirects are returned, never followed here. */
export type ImportHttpResponse = Http1Response

/** Injectable HTTP transport used by the fetcher. */
export type ImportHttpTransport = (request: ImportHttpRequest) => Promise<ImportHttpResponse>

/** Options for the production transport. `ca` is for local TLS tests only. */
export interface CreateHttpsTransportOptions {
  /** Extra CA bundle used by the local self-signed test server. */
  readonly ca?: string | Buffer | Array<string | Buffer>
}

/**
 * Production transport. Imports only ever request validated `https` URLs; the
 * shared transport additionally supports plain HTTP for the subscription
 * verification test-loopback path, which this wrapper never uses.
 */
export function createHttpsTransport(
  options: CreateHttpsTransportOptions = {},
): ImportHttpTransport {
  const transport = createHttp1Transport(options)
  return async (request) => {
    try {
      return await transport(request)
    } catch (error) {
      if (isHttp1TransportError(error)) {
        throw importError(error.code, error.message)
      }
      throw error
    }
  }
}
