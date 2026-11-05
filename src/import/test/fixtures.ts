// Offline fixtures for the import tests (issue #30).
//
// No test performs a real network request: the fetcher takes an injected
// transport and DNS resolver, so valid and invalid catalog fixtures are served
// deterministically. The SchemaMeta documents come from the real standards
// adapter fixtures, so the preview tests exercise the shipped codecs.

import { buildOwfWire, buildTs11Document } from '../../standards/test/fixtures'
import type { HostResolver } from '../url'
import type { ImportHttpRequest, ImportHttpResponse, ImportHttpTransport } from '../http'
import { ImportError } from '../errors'

/** A public, non-routable test address; never contacted because of the fake transport. */
export const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 } as const

export const publicResolver: HostResolver = () => Promise.resolve([PUBLIC_ADDRESS])

export const IMPORT_URL = 'https://catalog.example.test/schemas.json'
export const REFERENCE_URL = 'https://catalog.example.test/entries/1.json'

/** Builds a JSON document with a fixed top-level shape from the TS11 fixture. */
export function ts11Document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...buildTs11Document(), ...overrides }
}

export function ts11WithSchemaReferences(
  references: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return ts11Document({
    schemaURIs: references,
    supportedFormats: [
      ...new Set(references.map((reference) => String(reference.formatIdentifier))),
    ],
  })
}

export function jsonBytes(value: unknown): string {
  return JSON.stringify(value)
}

/** Serves routes keyed by exact request URL, recording every transport call. */
export interface FakeRoute {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
}

export interface FakeTransport {
  readonly transport: ImportHttpTransport
  readonly requests: ImportHttpRequest[]
}

export function createFakeTransport(routes: Readonly<Record<string, FakeRoute>>): FakeTransport {
  const requests: ImportHttpRequest[] = []
  const transport: ImportHttpTransport = (request) => {
    requests.push(request)
    const route = routes[request.url.href]
    if (route === undefined) {
      return Promise.reject(
        new ImportError('unsupported_status', `no fake route for ${request.url.href}`),
      )
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(route.headers ?? {}),
    }
    const body =
      typeof route.body === 'string'
        ? new TextEncoder().encode(route.body)
        : (route.body ?? new Uint8Array())
    const response: ImportHttpResponse = {
      status: route.status ?? 200,
      headers,
      body,
      url: request.url,
    }
    return Promise.resolve(response)
  }
  return { transport, requests }
}

/** A fake transport that always fails with the given error. */
export function failingTransport(error: ImportError): FakeTransport {
  const requests: ImportHttpRequest[] = []
  return {
    requests,
    transport: (request) => {
      requests.push(request)
      return Promise.reject(error)
    },
  }
}

export const owfDocument = buildOwfWire()

export const validTs11Document = ts11Document()

export const invalidTs11Document: Record<string, unknown> = (() => {
  const document = ts11Document()
  delete document.bindingType
  return document
})()
